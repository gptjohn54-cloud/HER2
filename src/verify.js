import { createHash } from 'node:crypto';

/**
 * Internal-consistency checks on statistics as published. None of this needs
 * the underlying patient data — a reported effect size, its confidence
 * interval and its p-value over-determine each other, so any two can be used
 * to test the third. A paper that fails these has a reporting error.
 */

const Z_975 = 1.959963984540054; // two-sided 95%

const erfc = (x) => {
  // Numerical Recipes 6.2.2 — |error| < 1.2e-7, ample for p-value sanity checks
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const y = t - 0.5;
  const ans =
    t *
    Math.exp(
      -z * z - 1.26551223 + y * (1.00002368 + y * (0.37409196 + y * (0.09678418 +
        y * (-0.18628806 + y * (0.27886807 + y * (-1.13520398 + y * (1.48851587 +
          y * (-0.82215223 + y * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
};

const pFromZ = (z) => erfc(Math.abs(z) / Math.SQRT2);

/**
 * A ratio measure (HR, OR, RR) is symmetric in log space. The CI midpoint
 * must equal log(point estimate), and the half-width yields the standard
 * error, which in turn yields z and the p-value.
 */
export function checkRatioEstimate({ label, estimate, ciLow, ciHigh, reportedP = null, decimals = 2, z = Z_975 }) {
  const logE = Math.log(estimate);
  const logLo = Math.log(ciLow);
  const logHi = Math.log(ciHigh);

  const se = (logHi - logLo) / (2 * z);
  const midpoint = (logLo + logHi) / 2;
  const discrepancy = Math.abs(logE - midpoint);
  const zStat = logE / se;
  const pImplied = pFromZ(zStat);

  // Rounding in a published CI shifts the midpoint slightly; 0.01 in log space
  // is roughly a 1% shift in the ratio, well inside two-decimal reporting.
  // A fixed log-space tolerance produces false accusations: published values
  // are rounded, so the "true" estimate and CI bounds each range over a
  // rounding interval. Test whether ANY assignment inside those intervals is
  // log-symmetric before calling a paper inconsistent.
  const half = 0.5 * 10 ** -decimals;
  const midMin = Math.sqrt((ciLow - half) * (ciHigh - half));
  const midMax = Math.sqrt((ciLow + half) * (ciHigh + half));
  const midpointConsistent = !(midMax < estimate - half || midMin > estimate + half);
  const pConsistent =
    reportedP == null ? null : pImplied <= reportedP * 10 && pImplied >= reportedP / 1000;

  return {
    label,
    inputs: { estimate, ciLow, ciHigh, reportedP },
    derived: {
      midpointRange: [midMin, midMax],
      logEstimate: logE,
      ciMidpointLog: midpoint,
      midpointDiscrepancy: discrepancy,
      impliedSE: se,
      impliedZ: zStat,
      impliedP: pImplied,
    },
    checks: { midpointConsistent, pConsistent },
    verdict: midpointConsistent && pConsistent !== false ? 'supports' : 'refutes',
    formulas: [
      'SE = (ln(CI_high) - ln(CI_low)) / (2 * 1.95996)',
      'midpoint = (ln(CI_low) + ln(CI_high)) / 2  ; must equal ln(estimate)',
      'z = ln(estimate) / SE',
      'p = erfc(|z| / sqrt(2))',
    ],
  };
}

/** A subset rate cannot exceed the rate it is a subset of. */
export function checkRateOrdering({ label, whole, part, n = null }) {
  const ok = part <= whole;
  return {
    label,
    inputs: { wholePct: whole, partPct: part, n },
    derived: n ? { wholeCount: (whole / 100) * n, partCount: (part / 100) * n } : {},
    checks: { orderingConsistent: ok },
    verdict: ok ? 'supports' : 'refutes',
    formulas: ['part% <= whole%', 'count = pct/100 * n'],
  };
}

const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x,
  );

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Bundles checks into a publishable artifact. inputHash covers exactly what
 * was checked and outputHash covers exactly what was concluded, so a third
 * party can recompute both from the artifact alone — which is the whole point
 * of putting it at a stable public URL.
 */
export function buildArtifact({ source, checks, toolName = 'muse-agent/verify.js' }) {
  const inputs = { source, inputs: checks.map((c) => c.inputs) };
  const inputHash = sha256(canonical(inputs));
  const body = {
    protocol: 'internal-consistency-v1',
    toolName,
    source,
    checks,
    inputHash,
    generatedAt: new Date().toISOString(),
  };
  const outputHash = sha256(canonical({ ...body, generatedAt: undefined }));
  const refuted = checks.filter((c) => c.verdict === 'refutes');
  return {
    ...body,
    outputHash,
    result: refuted.length ? 'refutes' : 'supports',
    // Confidence reflects arithmetic certainty, not clinical judgement.
    confidenceBps: refuted.length ? 9500 : 9000,
  };
}
