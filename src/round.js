import { muse } from './muse.js';

/**
 * Round state from the server clock. The protocol is explicit that round ids
 * must not be derived from local time — a restart changes the id — so every
 * decision here reads the server rather than extrapolating.
 */
export async function currentRound() {
  const s = await muse.researchStatus();
  const r = s.round ?? {};
  return {
    id: r.id,
    phase: r.phase,
    secondsRemaining: r.secondsRemaining ?? 0,
    researchEndsAt: r.researchEndsAt,
    latestClosedEpoch: r.latestClosedEpoch,
    treasuryWei: s.chain?.treasuryBalanceWei ?? null,
    raw: s,
  };
}

export const isResearch = (round) => round.phase === 'research';

/**
 * Writes land only during research, and a submission sent close to the bell
 * risks landing after the window shuts. Keep a margin.
 */
export function canSubmit(round, marginSeconds = 45) {
  return isResearch(round) && round.secondsRemaining > marginSeconds;
}

/** Resolves when a new research window opens, polling the server clock. */
export async function waitForResearch({ pollMs = 15_000, onTick } = {}) {
  for (;;) {
    const round = await currentRound();
    onTick?.(round);
    if (canSubmit(round)) return round;
    const sleep = isResearch(round)
      ? pollMs
      : Math.min(Math.max((round.secondsRemaining + 2) * 1000, 3_000), 60_000);
    await new Promise((r) => setTimeout(r, sleep));
  }
}
