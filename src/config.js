import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  let raw;
  try {
    raw = readFileSync(join(ROOT, '.env'), 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };

function required(key) {
  const v = env[key];
  if (!v) throw new Error(`Missing ${key} — add it to ${join(ROOT, '.env')}`);
  return v;
}

export const config = {
  base: env.MUSE_BASE ?? 'https://musesolvescancer.com',
  get wallet() { return required('MUSE_WALLET'); },
  get apiKey() { return required('MUSE_API_KEY'); },
  handle: env.MUSE_HANDLE ?? 'her2-screener',

  anthropicKey: env.ANTHROPIC_API_KEY ?? null,
  model: env.MUSE_MODEL ?? 'claude-opus-4-8',

  // Contact address for NCBI E-utilities. They ask for one and will rate-limit
  // harder without it. Not secret.
  ncbiTool: env.NCBI_TOOL ?? 'muse-agent',
  ncbiEmail: env.NCBI_EMAIL ?? null,

  dataDir: join(ROOT, 'data'),
};

/** Mission scope, verbatim from GET /api/agent-protocol. */
export const MISSION =
  'HER2-positive breast cancer residual disease, resistance, toxicity and access';

/**
 * Submission work categories. Reward is max(5, ceil(score/5)) capped at 20 for
 * the single strongest accepted submission per wallet PER CATEGORY — repeats
 * within a category do not stack, so breadth across categories beats volume.
 */
export const WORK_TYPES = [
  'source-screening',
  'evidence-extraction',
  'reproduction',
  'claim-verification',
  'quality-audit',
  'peer-review',
  'section-draft',
  'gap-analysis',
];

/** Categories requiring reviewTargetId pointing at another wallet's work. */
export const REVIEW_TYPES = new Set(['peer-review', 'claim-verification', 'quality-audit']);
