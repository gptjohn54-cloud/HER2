import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const CACHE = join(config.dataDir, 'catalogue.json');
const PAPER_PAGES = 40;
const TRIAL_PAGES = 16;

const pad = (n) => String(n).padStart(3, '0');

function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  for (const k of ['papers', 'trials', 'items', 'records', 'data']) {
    if (Array.isArray(payload?.[k])) return payload[k];
  }
  return [];
}

async function page(kind, n) {
  const url = `${config.base}/data/research/${kind}/${pad(n)}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return unwrap(await res.json());
}

async function fetchAll(kind, pages, concurrency = 6) {
  const out = [];
  const queue = Array.from({ length: pages }, (_, i) => i + 1);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        out.push(...(await page(kind, n)));
      }
    }),
  );
  return out;
}

/**
 * The official source library. The manifest is explicit that catalogue
 * metadata is NOT accepted evidence — records here are pointers, and the
 * actual source still has to be fetched and read before anything is claimed
 * about it. This only decides *what to read*.
 */
export async function loadCatalogue({ refresh = false } = {}) {
  if (!refresh && existsSync(CACHE)) {
    return JSON.parse(readFileSync(CACHE, 'utf8'));
  }
  const [papers, trials] = await Promise.all([
    fetchAll('papers', PAPER_PAGES),
    fetchAll('trials', TRIAL_PAGES),
  ]);
  const cat = { papers, trials, builtAt: new Date().toISOString() };
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cat));
  return cat;
}

/**
 * Evidence tiers worth screening first. "Agent screening required" is the
 * unclassified bulk (6825 of 9998); the graded tiers are both rarer and
 * carry harder numbers to work with, which is what actually scores.
 */
const TIER = {
  'Randomized trial': 0,
  'Clinical study': 1,
  'Evidence synthesis': 2,
  Review: 3,
  'Agent screening required': 4,
};

/**
 * Ranks unclaimed catalogue papers. Duplicate sources decay hard — observed
 * 5 -> 1 -> 1 on a thrice-used PMID — so anything already referenced by the
 * network is dropped outright rather than down-weighted.
 */
export function selectSources(catalogue, claimedPmids, { limit = 20, minYear = 2015 } = {}) {
  return catalogue.papers
    .filter((r) => r.pmid && !claimedPmids.has(String(r.pmid)))
    .filter((r) => {
      const y = Number(String(r.publicationDate ?? '').slice(0, 4));
      return !Number.isFinite(y) || y >= minYear;
    })
    .sort((a, b) => {
      const t = (TIER[a.evidenceLevel] ?? 9) - (TIER[b.evidenceLevel] ?? 9);
      if (t !== 0) return t;
      return (a.priorityRank ?? 1e9) - (b.priorityRank ?? 1e9);
    })
    .slice(0, limit);
}

export function catalogueStats(catalogue) {
  const byLevel = {};
  for (const r of catalogue.papers) {
    byLevel[r.evidenceLevel] = (byLevel[r.evidenceLevel] ?? 0) + 1;
  }
  return { papers: catalogue.papers.length, trials: catalogue.trials.length, byLevel };
}
