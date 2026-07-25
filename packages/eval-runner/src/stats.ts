/**
 * C27 — closed-form 95% confidence intervals for the run aggregates.
 * Dependency-free and deterministic (no resampling, no RNG):
 *
 *   - `wilsonCI95` — Wilson score interval on a binomial proportion (the
 *     pass rate). Chosen over the naive Wald interval because it behaves at
 *     the small n eval datasets actually have (n=8 with p̂=1.0 gives
 *     [0.68, 1.0], not the Wald's degenerate [1.0, 1.0]).
 *   - `meanCI95` — Student t interval on a sample mean (the mean score):
 *     mean ± t₀.₉₇₅,ₙ₋₁ · s/√n. The t critical value uses the exact
 *     tabulated values for df ≤ 30 and Fisher's asymptotic expansion above
 *     (max error < 0.001 there — far below display precision).
 *
 * Both return `undefined` instead of fabricating an interval when the data
 * cannot support one (n = 0 for Wilson; n < 2 for the t interval, where the
 * sample variance is undefined). Callers presence-gate on that, matching
 * the additive-optional pattern of every other aggregate field.
 */

/** z such that Φ(z) = 0.975 — the two-sided 95% normal critical value. */
const Z_975 = 1.959964;

/** Exact two-sided 95% t critical values for df 1..30 (index df-1). */
const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];

/**
 * Two-sided 95% Student t critical value for `df` degrees of freedom.
 * Tabulated for df ≤ 30; Fisher's expansion beyond (t ≈ z + (z³+z)/4ν +
 * (5z⁵+16z³+3z)/96ν²), which reproduces the printed tables to 3 decimals.
 */
export function tCritical975(df: number): number {
  if (!Number.isInteger(df) || df < 1) {
    throw new RangeError(`t critical value needs integer df >= 1, got ${df}`);
  }
  const tabulated = T_975[df - 1];
  if (tabulated !== undefined) return tabulated;
  const z = Z_975;
  const z3 = z * z * z;
  const z5 = z3 * z * z;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df);
}

/**
 * Wilson 95% score interval for `successes` out of `n` Bernoulli trials,
 * as `[lo, hi]` clamped to [0, 1]. `undefined` when n = 0 (an interval on
 * zero observations would be pure fabrication).
 */
export function wilsonCI95(successes: number, n: number): readonly [number, number] | undefined {
  if (n <= 0) return undefined;
  const p = successes / n;
  const z2 = Z_975 * Z_975;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z_975 / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * Student t 95% interval on the mean of `values`, as `[lo, hi]`.
 * `undefined` when fewer than 2 values (sample variance undefined).
 * Degenerate identical samples legitimately yield a zero-width interval.
 */
export function meanCI95(values: ReadonlyArray<number>): readonly [number, number] | undefined {
  const n = values.length;
  if (n < 2) return undefined;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) * (v - mean), 0) / (n - 1);
  const half = tCritical975(n - 1) * Math.sqrt(variance / n);
  return [mean - half, mean + half];
}
