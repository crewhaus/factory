/**
 * C29 — paired significance testing on a run diff. The strict gate stays
 * exactly as it is (any drop fails; any flip fails) — this layer is decision
 * SUPPORT on top of it, answering "could this delta be sampling noise?"
 * without ever deciding pass/fail itself.
 *
 * Method (locked): a sign-flip permutation test on the paired per-sample
 * pass-rate deltas. Under the null (no real change), each sample's delta is
 * equally likely to carry either sign, so the observed |Σ deltas| is ranked
 * against the sign-flipped distribution:
 *
 *   - paired-n ≤ 20 → EXACT enumeration. Zero deltas are sign-invariant
 *     (both signs contribute the same sum), so enumeration covers only the
 *     nonzero deltas — the p-value is identical and the loop stays ≤ 2²⁰.
 *   - paired-n > 20 → seeded Monte Carlo (default seed fixed, so two diffs
 *     of the same runs agree byte-for-byte; `--seed` overrides). The
 *     add-one correction (count+1)/(N+1) keeps p strictly positive — a
 *     Monte Carlo p of exactly 0 would overstate certainty.
 *
 * The 95% CI on the mean paired delta is a seeded bootstrap percentile
 * interval over the deltas (resampling, not closed-form, because deltas mix
 * {-1, 0, 1} flips with fractional trial-rate moves under `--repeats`).
 *
 * All randomness flows through mulberry32 — never Math.random — so every
 * figure here is reproducible from (deltas, seed) alone.
 */

/** Fixed default seed (a nod to gap C29) — deterministic across runs. */
export const DEFAULT_SIGNIFICANCE_SEED = 29;

/** Exact enumeration bound (locked): paired-n above this → Monte Carlo. */
const EXACT_MAX_PAIRED_N = 20;

/** Monte Carlo sign-flip iterations (resolution ~1e-4 with add-one). */
const MC_PERMUTATIONS = 10_000;

/** Bootstrap resamples behind the delta CI. */
const BOOTSTRAP_RESAMPLES = 2_000;

/** Two-sided significance level for the plain-language verdict (locked). */
const ALPHA = 0.05;

/** Float tolerance when ranking permuted sums against the observed sum. */
const EPS = 1e-12;

/**
 * The additive `significance` block of diff.json. Absent when the runs
 * share no comparable pairs (or on diff.json written by older CLIs) —
 * readers must tolerate absence.
 */
export type DiffSignificance = {
  /** Comparable sample pairs: shared ids minus abstained-on-either-side. */
  readonly pairedN: number;
  /** Mean per-sample pass-rate delta (next − prev) over the pairs. */
  readonly passRateDelta: number;
  /** Seeded bootstrap percentile 95% CI on the mean paired delta. */
  readonly passRateDeltaCI95: readonly [number, number];
  /** Two-sided sign-flip permutation p-value on the paired deltas. */
  readonly pValue: number;
  readonly method: "exact" | "monte-carlo";
  /**
   * Sign assignments ranked: 2^(nonzero deltas) for `exact` (zero deltas
   * are sign-invariant, so skipping them changes nothing), the iteration
   * count for `monte-carlo`.
   */
  readonly permutations: number;
  /** The seed behind the Monte Carlo draw and the bootstrap CI. */
  readonly seed: number;
  /** `pValue` < 0.05 — the plain-language verdict, precomputed. */
  readonly significant: boolean;
};

/**
 * mulberry32 — the house PRNG for eval statistics. 32-bit state, uniform
 * floats in [0, 1). Deterministic for a given seed on every platform, which
 * is the whole point: Math.random would make diff.json unreproducible.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run the paired significance test over per-sample pass-rate deltas
 * (next − prev; ±1 flips for single-trial runs, fractional under
 * `--repeats`). Returns `undefined` when there are no pairs — an interval
 * on zero observations would be pure fabrication (the C27 posture).
 */
export function computeDiffSignificance(
  deltas: ReadonlyArray<number>,
  opts: { readonly seed?: number } = {},
): DiffSignificance | undefined {
  const pairedN = deltas.length;
  if (pairedN === 0) return undefined;
  const seed = opts.seed ?? DEFAULT_SIGNIFICANCE_SEED;

  const passRateDelta = deltas.reduce((a, d) => a + d, 0) / pairedN;
  const observed = Math.abs(deltas.reduce((a, d) => a + d, 0));
  const nonzero = deltas.filter((d) => d !== 0);

  let pValue: number;
  let method: DiffSignificance["method"];
  let permutations: number;
  if (pairedN <= EXACT_MAX_PAIRED_N) {
    method = "exact";
    // Full enumeration over the nonzero deltas: ≤ 2²⁰ masks × ≤ 20 adds
    // (~2·10⁷ float ops worst case — well under a second, no cleverness
    // needed). The identity assignment always ties the observed sum, so
    // the exact p is never 0 by construction.
    const m = nonzero.length;
    permutations = 2 ** m;
    let atLeast = 0;
    for (let mask = 0; mask < permutations; mask++) {
      let sum = 0;
      for (let i = 0; i < m; i++) {
        const d = nonzero[i] as number;
        sum += ((mask >>> i) & 1) === 1 ? -d : d;
      }
      if (Math.abs(sum) >= observed - EPS) atLeast += 1;
    }
    pValue = atLeast / permutations;
  } else {
    method = "monte-carlo";
    permutations = MC_PERMUTATIONS;
    const rng = mulberry32(seed);
    let atLeast = 0;
    for (let iter = 0; iter < MC_PERMUTATIONS; iter++) {
      let sum = 0;
      for (const d of nonzero) sum += rng() < 0.5 ? -d : d;
      if (Math.abs(sum) >= observed - EPS) atLeast += 1;
    }
    pValue = (atLeast + 1) / (MC_PERMUTATIONS + 1);
  }

  // Bootstrap percentile CI on the mean delta, on its own seed-derived
  // stream so the interval is identical whichever p-value branch ran.
  const boot = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const means: number[] = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    let sum = 0;
    for (let i = 0; i < pairedN; i++) {
      sum += deltas[Math.floor(boot() * pairedN)] as number;
    }
    means.push(sum / pairedN);
  }
  means.sort((a, b) => a - b);
  const lower = means[Math.floor(0.025 * (BOOTSTRAP_RESAMPLES - 1))] as number;
  const upper = means[Math.ceil(0.975 * (BOOTSTRAP_RESAMPLES - 1))] as number;

  return {
    pairedN,
    passRateDelta,
    passRateDeltaCI95: [lower, upper],
    pValue,
    method,
    permutations,
    seed,
    significant: pValue < ALPHA,
  };
}

const signedPct = (v: number): string => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

/** p to display precision; tiny exact p-values render as `p<0.001`. */
const formatP = (p: number): string => (p < 0.001 ? "p<0.001" : `p=${p.toFixed(3)}`);

/**
 * The one-line plain-language summary, shared by the stdout tail and the
 * HTML diff header (the CLI prepends its `[eval-report] ` prefix).
 */
export function formatSignificanceLine(sig: DiffSignificance): string {
  return (
    `pass-rate delta ${signedPct(sig.passRateDelta)} ` +
    `(95% CI [${signedPct(sig.passRateDeltaCI95[0])}, ${signedPct(sig.passRateDeltaCI95[1])}]) ` +
    `${formatP(sig.pValue)} (${sig.method}, n=${sig.pairedN} pairs) — ` +
    `${sig.significant ? "significant" : "not significant"} at ${ALPHA}`
  );
}
