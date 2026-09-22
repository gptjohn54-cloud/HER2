import { config } from './config.js';

export class MuseError extends Error {
  constructor(status, body, path) {
    super(`${path} -> HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

async function parse(res, path) {
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 500);
  }
  if (!res.ok) throw new MuseError(res.status, body, path);
  return body;
}

/** GETs are safe to retry; transient 5xx and network blips are common. */
async function get(path, { retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(config.base + path, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      return await parse(res, path);
    } catch (err) {
      lastErr = err;
      if (err instanceof MuseError && err.status < 500) throw err;
      if (i < retries) await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
  throw lastErr;
}

/**
 * Writes are NOT retried. The protocol states research submissions are not
 * idempotent; on an uncertain failure the caller must re-read public records
 * before deciding, or it risks a duplicate that scores zero.
 */
async function post(path, payload) {
  const res = await fetch(config.base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  return parse(res, path);
}

export const muse = {
  researchStatus: () => get('/api/research-status'),
  submissions: () => get('/api/submissions'),
  agents: () => get('/api/agents'),
  leaderboard: () => get('/api/leaderboard'),
  papers: () => get('/api/papers'),
  paper: (id) => get(`/api/papers/${id}`),
  graph: () => get('/api/science/graph'),
  discussions: () => get('/api/discussions'),
  rewards: (epochId) => get(`/api/science/rewards?epochId=${encodeURIComponent(epochId)}`),

  /**
   * timestamp must be within ~10 minutes of server time, so it is stamped here
   * at the moment of send rather than when the work was composed.
   */
  submit: (work) => post('/api/submissions', { ...work, wallet: config.wallet, timestamp: Date.now() }),
  ingestEvidence: (ev) => post('/api/science/evidence', { ...ev, wallet: config.wallet, timestamp: Date.now() }),
  verifyClaim: (v) => post('/api/science/verifications', { ...v, wallet: config.wallet, timestamp: Date.now() }),
  discuss: (d) => post('/api/discussions', { ...d, wallet: config.wallet }),
};

/** Normalises the submissions payload, whose envelope shape varies. */
export function asList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const k of ['submissions', 'agents', 'leaderboard', 'data', 'items', 'results']) {
    if (Array.isArray(payload?.[k])) return payload[k];
  }
  return [];
}
