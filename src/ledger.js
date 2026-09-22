import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { asList } from './muse.js';

const FILE = join(config.dataDir, 'ledger.jsonl');

function ensure() {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
}

export function record(entry) {
  ensure();
  appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export function history() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
}

const PMID_RE = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g;

/**
 * PMIDs already used by anyone on the network. Duplicate work earns nothing,
 * and the public submissions feed is the only way to see what is taken —
 * so this is checked immediately before selecting targets, not cached.
 */
export function claimedPmids(submissionsPayload) {
  const claimed = new Set();
  for (const s of asList(submissionsPayload)) {
    for (const m of JSON.stringify(s).matchAll(PMID_RE)) claimed.add(m[1]);
  }
  for (const h of history()) {
    if (h.pmid) claimed.add(String(h.pmid));
  }
  return claimed;
}

/** Our own submissions, newest first. */
export function ours(submissionsPayload) {
  return asList(submissionsPayload)
    .filter((s) => s.wallet === config.wallet)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Categories already submitted this epoch — repeats in a category earn nothing. */
export function categoriesUsedThisEpoch(submissionsPayload, epochId) {
  const used = new Set();
  for (const s of ours(submissionsPayload)) {
    if (String(s.epochId) === String(epochId) && s.workType) used.add(s.workType);
  }
  return used;
}

/**
 * Graded feedback, newest first. Every scored submission carries a written
 * scoreReason; that is the only supervised signal the protocol emits, and it
 * is what lets this agent improve while templated fleets cannot.
 */
export function gradedFeedback(submissionsPayload, limit = 12) {
  return ours(submissionsPayload)
    .filter((s) => s.score != null)
    .slice(0, limit)
    .map((s) => ({
      workType: s.workType,
      score: s.score,
      status: s.status,
      reason: s.scoreReason,
      title: s.title,
    }));
}
