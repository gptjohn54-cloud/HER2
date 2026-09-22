import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, WORK_TYPES, REVIEW_TYPES } from './config.js';
import { muse, asList } from './muse.js';
import { loadCatalogue, selectSources } from './catalogue.js';
import { fetchAbstract, readable } from './pubmed.js';
import { claimedPmids, history } from './ledger.js';
import { currentRound } from './round.js';

const PMID_RE = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/;

/**
 * Counts how many times each PMID appears across the public feed. A source
 * used even once by anyone else is poisoned: reuse is scored as duplicate
 * work and earns nothing regardless of how well the note is written.
 */
function networkUsage(submissions) {
  const counts = new Map();
  for (const s of asList(submissions)) {
    const m = PMID_RE.exec(JSON.stringify(s));
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

/**
 * Review categories must target another wallet's submission. The target's own
 * source matters too — reviewing a submission built on a heavily duplicated
 * PMID drags the review into the same duplicate bucket, which is how the
 * peer-review on PMID 35941372 (four copies in the graph) was ruled
 * ineligible despite scoring 62.
 */
function pickReviewTargets(submissions, usage, count) {
  return asList(submissions)
    .filter((s) => s.wallet !== config.wallet && s.id)
    .map((s) => {
      const m = PMID_RE.exec(JSON.stringify(s));
      return { ...s, pmid: m?.[1] ?? null, uses: m ? (usage.get(m[1]) ?? 0) : 0 };
    })
    .filter((s) => s.uses <= 1)
    .sort((a, b) => a.uses - b.uses)
    .slice(0, count);
}

/**
 * Builds a round plan: one DISTINCT source per work category.
 *
 * This is the guard for the failure that cost ~89 points — five submissions
 * sharing a single evidenceUrl were all ruled ineligible as duplicates while
 * scoring 62-82. Distinctness is asserted before anything is written, not
 * checked afterwards.
 */
export async function planRound({ categories = WORK_TYPES } = {}) {
  const [round, submissions, catalogue] = await Promise.all([
    currentRound(), muse.submissions(), loadCatalogue(),
  ]);

  const usage = networkUsage(submissions);
  const claimed = claimedPmids(submissions);
  for (const h of history()) if (h.pmid) claimed.add(String(h.pmid));

  const pool = selectSources(catalogue, claimed, { limit: categories.length * 4 });
  if (pool.length < categories.length) {
    throw new Error(`only ${pool.length} unclaimed sources for ${categories.length} categories`);
  }

  const reviewCats = categories.filter((c) => REVIEW_TYPES.has(c));
  const targets = pickReviewTargets(submissions, usage, reviewCats.length);

  const assignments = [];
  const used = new Set();
  let ti = 0;

  for (const workType of categories) {
    const source = pool.find((r) => !used.has(String(r.pmid)));
    if (!source) throw new Error(`ran out of distinct sources at ${workType}`);
    used.add(String(source.pmid));

    const record = await fetchAbstract(source.pmid);
    assignments.push({
      workType,
      reviewTargetId: REVIEW_TYPES.has(workType) ? (targets[ti++]?.id ?? null) : null,
      catalogue: {
        pmid: source.pmid, title: source.title, journal: source.journal,
        publicationDate: source.publicationDate, evidenceLevel: source.evidenceLevel,
        doi: source.doi, priorityRank: source.priorityRank,
      },
      source: {
        url: record.url, sha256: record.sha256, bytes: record.bytes,
        retrievedAt: record.retrievedAt, fetchSpec: record.fetchSpec,
      },
      text: readable(record),
    });
  }

  // Assert the invariant rather than trusting the loop above.
  const pmids = assignments.map((a) => a.catalogue.pmid);
  if (new Set(pmids).size !== pmids.length) throw new Error('duplicate source in plan');
  for (const p of pmids) {
    if (usage.get(String(p))) throw new Error(`source ${p} already used on the network`);
  }

  const plan = { roundId: round.id, phase: round.phase, builtAt: new Date().toISOString(), assignments };
  writeFileSync(join(config.dataDir, 'plan.json'), JSON.stringify(plan, null, 2));
  return plan;
}
