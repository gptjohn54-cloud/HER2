import { createHash } from 'node:crypto';
import { config } from './config.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/** NCBI allows 3 req/s unauthenticated. Keep a floor between calls. */
let lastCall = 0;
async function throttle(ms = 350) {
  const wait = lastCall + ms - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

function common(params) {
  params.set('tool', config.ncbiTool);
  if (config.ncbiEmail) params.set('email', config.ncbiEmail);
  return params;
}

/**
 * The exact efetch parameters used to produce hashed content. Recorded
 * alongside every hash so a third party can reproduce the digest byte for byte
 * — a hash nobody can recompute is decoration, not evidence.
 */
export const FETCH_SPEC = { db: 'pubmed', rettype: 'abstract', retmode: 'text' };

export async function search(term, { retmax = 40, sort = 'date' } = {}) {
  await throttle();
  const params = common(new URLSearchParams({
    db: 'pubmed', term, retmax: String(retmax), sort, retmode: 'json',
  }));
  const res = await fetch(`${EUTILS}/esearch.fcgi?${params}`, {
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`esearch HTTP ${res.status}`);
  const json = await res.json();
  return json?.esearchresult?.idlist ?? [];
}

/** Returns the raw abstract text exactly as served, plus its SHA-256. */
export async function fetchAbstract(pmid, { retries = 4 } = {}) {
  const params = common(new URLSearchParams({ ...FETCH_SPEC, id: String(pmid) }));
  let res;
  for (let attempt = 0; ; attempt++) {
    // NCBI throttles hard on bursts; back off rather than dropping the source.
    await throttle(attempt === 0 ? 400 : 1200 * 2 ** (attempt - 1));
    res = await fetch(`${EUTILS}/efetch.fcgi?${params}`, {
      signal: AbortSignal.timeout(25_000),
    });
    if (res.ok) break;
    if (res.status !== 429 || attempt >= retries) {
      throw new Error(`efetch ${pmid} HTTP ${res.status}`);
    }
  }
  const text = await res.text();
  if (!text.includes(`PMID: ${pmid}`)) {
    throw new Error(`efetch ${pmid} returned no matching record`);
  }
  return {
    pmid: String(pmid),
    text,
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    retrievedAt: new Date().toISOString(),
    fetchSpec: FETCH_SPEC,
  };
}

/** Strips the MEDLINE header/affiliation block down to title + abstract body. */
export function readable(record) {
  const lines = record.text.split('\n');
  const start = lines.findIndex((l) => /^Author information:/.test(l));
  const body = start === -1 ? lines : lines.slice(start);
  return body
    .join('\n')
    .replace(/^\(\d+\).*$/gm, '')
    .replace(/^Author information:.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Mission-scoped queries, ordered most-specific first. Distinct enough that a
 * run cycling through them surfaces different corners of the scope rather than
 * re-screening the same recency slice every round.
 */
export const QUERIES = {
  'residual-disease':
    '("breast cancer"[Title/Abstract]) AND (HER2[Title/Abstract] OR ERBB2[Title/Abstract]) AND ("residual disease"[Title/Abstract] OR "pathologic complete response"[Title/Abstract] OR neoadjuvant[Title/Abstract])',
  resistance:
    '("breast cancer"[Title/Abstract]) AND (HER2[Title/Abstract] OR ERBB2[Title/Abstract]) AND (resistance[Title/Abstract] OR refractory[Title/Abstract] OR "treatment failure"[Title/Abstract])',
  toxicity:
    '("breast cancer"[Title/Abstract]) AND (HER2[Title/Abstract] OR ERBB2[Title/Abstract]) AND (toxicity[Title/Abstract] OR "adverse event*"[Title/Abstract] OR cardiotox*[Title/Abstract] OR "interstitial lung disease"[Title/Abstract])',
  access:
    '("breast cancer"[Title/Abstract]) AND (HER2[Title/Abstract] OR ERBB2[Title/Abstract]) AND (access[Title/Abstract] OR disparit*[Title/Abstract] OR "low-income"[Title/Abstract] OR cost[Title/Abstract])',
  adc:
    '("breast cancer"[Title/Abstract]) AND ("antibody-drug conjugate"[Title/Abstract] OR "trastuzumab deruxtecan"[Title/Abstract] OR "trastuzumab emtansine"[Title/Abstract] OR tucatinib[Title/Abstract])',
};
