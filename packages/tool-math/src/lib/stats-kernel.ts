/**
 * Nonparametric statistics kernel: the small set of numbers that four
 * different CI questions all turn out to need.
 *
 *   - benchmark comparison    — did this branch actually get slower, or did
 *                               the runner have a bad afternoon? (Mann-Whitney)
 *   - bundle-size gating      — same question, same test, different units.
 *   - flaky-test detection    — 3 failures in 5 runs is not "60% flaky", it is
 *                               "somewhere between 23% and 88%". (Wilson)
 *   - data-drift checks       — has the input distribution moved? (PSI)
 *
 * It lives in ONE file because the alternative is four copies that disagree.
 * See the note under "prior art" below: this repository already has three
 * Wilson implementations and one Cohen's kappa, in packages a tool package
 * cannot depend on, and every one of them is pinned to a single confidence
 * level. Anything here that overlaps them is pinned in `lib.test.ts` to the
 * SAME published numbers those packages pin, so a drift shows up as a failing
 * test instead of as two answers to one question.
 *
 * Prior art in this monorepo, deliberately not duplicated in behaviour:
 *   - `@crewhaus/eval-runner` `src/stats.ts` `wilsonCI95` — 95% only.
 *   - `@crewhaus/hangar-server` `src/evals-ops.ts` `wilson95` — 95% only.
 *   - `@crewhaus/model-plan` `src/floor.ts` `wilsonLowerBound` — lower bound
 *     only, and `normalQuantile`, the INVERSE normal CDF. This kernel needs
 *     the FORWARD CDF (which existed nowhere) and so does not ship a fourth
 *     inverse; a caller who wants an unusual confidence level should get `z`
 *     from `normalQuantile` there rather than grow a copy here.
 *   - `@crewhaus/feedback-distill` `src/feedback.ts` `cohenKappa` — pairs of
 *     strings, `undefined` on empty, degenerate case reported as 1. This
 *     kernel matches that degenerate convention on purpose.
 *
 * Location and spread reuse `./stats` rather than re-deriving: `median` and
 * the R-7 quantile are already implemented and already tested there. What is
 * added here is the SENTINEL contract, because these four consumers run on
 * whatever data CI happened to produce:
 *
 *   **`null` means "this data cannot answer this question".** Never `NaN`,
 *   never a fabricated number, never a throw for a legitimate-but-degenerate
 *   shape (n=0, n=1, every value identical, every observation tied). A throw
 *   is reserved for a CALLER mistake — mismatched array lengths, a negative
 *   count, non-increasing bin edges — where there is a bug to fix rather than
 *   a dataset to interpret.
 *
 * A gate that reads `null` as 0 is a gate that ships on no evidence, so every
 * result that can be `null` says so in its type.
 */

import { StatsError, compensatedSum, median as medianOf, percentileSorted, rank } from "./stats";

// --- the normal distribution ------------------------------------------------

/**
 * P(Z > z) for a standard normal, computed DIRECTLY rather than as
 * `1 - cdf(z)`. The upper tail is where every p-value lives, and
 * `1 - 0.9999997` keeps about seven digits where this keeps fifteen.
 *
 * Hart's (1968) rational approximation in the double-precision arrangement
 * published by Graeme West, "Better approximations to cumulative normal
 * functions", Wilmott Magazine (2005). Accurate to roughly 1e-15 ABSOLUTE
 * across the whole range, which is why the p-values below can be pinned to
 * more decimals than a printed table would give; relatively it holds ~1e-11 in
 * the rational branch and ~1e-8 in the continued fraction past 7.07 sigma,
 * which no ship/no-ship threshold can tell apart. Verified against the
 * standard values: Phi(0)=0.5 exactly (the constant terms are in 2:1 ratio by
 * construction), Phi(1.96)=0.9750021048517795, Phi(2)=0.9772498680518208.
 */
export function normalUpperTail(z: number): number {
  if (!Number.isFinite(z)) {
    throw new StatsError(`normalUpperTail needs a finite z, got ${z}`);
  }
  const a = Math.abs(z);
  // Beyond 37 sigma the tail underflows a double anyway; returning 0 here
  // avoids exp(-684) denormals rather than changing an answer.
  let tail: number;
  if (a > 37) {
    tail = 0;
  } else {
    const e = Math.exp((-a * a) / 2);
    if (a < 7.07106781186547) {
      let b = 3.52624965998911e-2 * a + 0.700383064443688;
      b = b * a + 6.37396220353165;
      b = b * a + 33.912866078383;
      b = b * a + 112.079291497871;
      b = b * a + 221.213596169931;
      b = b * a + 220.206867912376;
      let d = 8.83883476483184e-2 * a + 1.75566716318264;
      d = d * a + 16.064177579207;
      d = d * a + 86.7807322029461;
      d = d * a + 296.564248779674;
      d = d * a + 637.333633378831;
      d = d * a + 793.826512519948;
      d = d * a + 440.413735824752;
      tail = (e * b) / d;
    } else {
      // Continued fraction past 7.07, where the rational form loses digits.
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      tail = e / (b * 2.506628274631);
    }
  }
  return z > 0 ? tail : 1 - tail;
}

/**
 * P(Z <= x) for a standard normal. Routed through whichever side of
 * `normalUpperTail` is the direct one, so the left tail keeps its digits
 * instead of arriving as `1 - (1 - tail)`.
 */
export function normalCdf(x: number): number {
  return x <= 0 ? normalUpperTail(-x) : 1 - normalUpperTail(x);
}

/**
 * Two-sided normal critical values for the confidence levels anyone actually
 * asks for. Exported so no caller writes `1.96` inline: the rounded 1.96 puts
 * Phi at 0.97500210, not 0.975, which is enough to move a lower bound in the
 * fourth decimal — visible when two services compare intervals.
 *
 * `eval-runner` uses the 1.959964 rounding and `hangar-server` the full value;
 * they agree to 1.5e-8, far below any threshold, but the full value is the one
 * to copy forward.
 */
export const TWO_SIDED_Z: Readonly<Record<"0.80" | "0.90" | "0.95" | "0.99", number>> =
  Object.freeze({
    "0.80": 1.2815515655446004,
    "0.90": 1.6448536269514722,
    "0.95": 1.959963984540054,
    "0.99": 2.5758293035489004,
  });

/** The 95% two-sided critical value, by far the most-asked-for of the above. */
export const Z_95 = TWO_SIDED_Z["0.95"];

// --- robust location and spread --------------------------------------------

/**
 * The median, or `null` for an empty sample.
 *
 * Delegates to `./stats`'s `median` (middle value, or the mean of the middle
 * two) instead of re-deriving it — a second median in the same package is a
 * second answer waiting to diverge. The only thing added is the sentinel:
 * `./stats` throws on empty because its callers supply a series a human
 * typed, and this kernel's callers supply whatever CI produced.
 */
export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  return medianOf(values);
}

/**
 * The p-th quantile by the **R-7** definition, or `null` for an empty sample.
 * `p` is a fraction in [0,1], not a percentage.
 *
 * R-7 is `h = (n-1)p` on the 0-indexed sorted data, linearly interpolated: R's
 * `quantile(type=7)` default, NumPy's `percentile` default, Excel's
 * `PERCENTILE.INC`. It is pinned here rather than left to the caller because
 * the four consumers compare numbers WITH EACH OTHER — on `1..10` at p25 the
 * conventions in `./stats` give 3.25 (r7), 2.75 (r6) and 3 (nearest rank), and
 * a gate that compares a baseline taken under one against a candidate taken
 * under another is measuring the convention, not the change.
 *
 * `./stats`'s `percentile` still offers all three for a human who asks.
 */
export function quantile(values: ReadonlyArray<number>, p: number): number | null {
  if (values.length === 0) return null;
  return percentileSorted(sortedFinite(values), p, "r7");
}

/** Spread around the median, both raw and scaled to a normal-comparable sigma. */
export type MedianAbsoluteDeviation = {
  /** median(|x - median(x)|). Zero whenever more than half the values tie. */
  mad: number;
  /** `mad * scale` — comparable to a standard deviation on normal data. */
  scaled: number;
  /** The consistency constant used for `scaled`, stated so it is checkable. */
  scale: number;
  /** The median `mad` is taken around, so a caller need not recompute it. */
  centre: number;
};

/**
 * 1 / Phi^-1(3/4) = 1 / 0.6744897501960817. Multiplying the MAD by this makes
 * it an unbiased estimator of sigma FOR NORMAL DATA — and only for normal
 * data, which is the whole reason `mad` is reported alongside `scaled` rather
 * than folded into it.
 */
export const MAD_NORMAL_SCALE = 1.482602218505602;

/**
 * Median absolute deviation: median(|x - median(x)|). `null` for an empty
 * sample.
 *
 * Worked example (the one in every textbook treatment): for
 * [1, 1, 2, 2, 4, 6, 9] the median is 2, the absolute deviations are
 * [1, 1, 0, 0, 2, 4, 7], and their median is 1. Pinned in `lib.test.ts`.
 *
 * `mad === 0` is a real answer, not a failure: it says more than half the
 * values are identical. It is also a landmine, because the usual next step is
 * `(x - centre) / mad`. Callers divide at their own risk; this returns the
 * zero rather than a sentinel so the fact is visible.
 */
export function medianAbsoluteDeviation(
  values: ReadonlyArray<number>,
): MedianAbsoluteDeviation | null {
  if (values.length === 0) return null;
  assertFinite(values);
  const centre = medianOf(values);
  const deviations = values.map((v) => Math.abs(v - centre));
  const mad = medianOf(deviations);
  return { mad, scaled: mad * MAD_NORMAL_SCALE, scale: MAD_NORMAL_SCALE, centre };
}

/**
 * Mean after dropping `floor(n * trim)` observations from EACH tail. `null`
 * for an empty sample.
 *
 * This is R's `mean(x, trim=)` convention exactly, including its two edges:
 * `trim` is the fraction cut from each end (so `trim = 0.1` drops a fifth of
 * the data in total, not a tenth), and `trim >= 0.5` returns the median rather
 * than dividing by zero. `floor` is what R uses, so a trim that does not land
 * on a whole observation cuts the smaller amount.
 *
 * Worked example: `mean(c(1,2,3,4,5,6,7,8,9,100), trim = 0.1)` is 5.5 in R,
 * against an untrimmed 14.5 — one bad timing sample moving the answer by 9.
 */
export function trimmedMean(values: ReadonlyArray<number>, trim: number): number | null {
  if (!Number.isFinite(trim) || trim < 0 || trim > 0.5) {
    throw new StatsError(`trim must be a fraction between 0 and 0.5, got ${trim}`);
  }
  if (values.length === 0) return null;
  const sorted = sortedFinite(values);
  if (trim >= 0.5) return medianOf(sorted);
  const cut = Math.floor(sorted.length * trim);
  const kept = sorted.slice(cut, sorted.length - cut);
  return compensatedSum(kept) / kept.length;
}

// --- Mann-Whitney U ---------------------------------------------------------

export type MannWhitneyResult = {
  n1: number;
  n2: number;
  /** Sum of the midranks held by each sample in the pooled ranking. */
  rankSum1: number;
  rankSum2: number;
  /** U for sample 1 (R's `wilcox.test` statistic W), for sample 2, and min. */
  u1: number | null;
  u2: number | null;
  u: number | null;
  /** Mean and standard deviation of U under the null. `sigma` is tie-corrected. */
  mu: number | null;
  sigma: number | null;
  /** Standard normal deviate for `u1`; `null` when sigma is 0 (every value tied). */
  z: number | null;
  /** Two-sided p from the normal approximation; `null` whenever `z` is. */
  p: number | null;
  /** How many tie groups of size > 1 the pooled sample had. */
  tieGroups: number;
  /** Whether a continuity correction of 0.5 was subtracted from |U - mu|. */
  continuityCorrection: boolean;
  /** False when either sample is under 8; see the note on `p`. */
  normalApproximationValid: boolean;
  /** What the numbers above do and do not license. Always populated. */
  note: string;
};

export type MannWhitneyOptions = {
  /**
   * Subtract 0.5 from |U - mu| before dividing by sigma. Defaults to `true`,
   * matching R's `wilcox.test(correct = TRUE)`; it moves p toward 1, i.e.
   * toward NOT calling a regression, which is the direction a gate should err.
   */
  continuityCorrection?: boolean;
};

/**
 * Mann-Whitney U (equivalently the Wilcoxon rank-sum test) with the normal
 * approximation and the standard tie correction.
 *
 * Mann & Whitney, "On a test of whether one of two random variables is
 * stochastically larger than the other", Ann. Math. Statist. 18(1):50-60
 * (1947). The tie-corrected variance is the Kruskal-Wallis form as printed in
 * Siegel & Castellan, *Nonparametric Statistics for the Behavioral Sciences*
 * (2nd ed., 1988) §6.4:
 *
 *     sigma^2 = (n1 n2 / 12) * [ (N + 1) - SUM(t^3 - t) / (N (N - 1)) ]
 *
 * over tie groups of size t, N = n1 + n2. With no ties the sum is 0 and it
 * collapses to the familiar n1 n2 (N+1) / 12.
 *
 * WHERE THE APPROXIMATION STOPS BEING VALID. U is discrete and its exact null
 * distribution is only roughly normal; below about 8 observations per sample
 * the normal p-value is wrong by tens of percent. Concretely, with
 * [1,2,3,4,5] against [6,7,8,9,10] — complete separation, the strongest signal
 * five-versus-five can produce — the exact two-sided p is 2/252 = 0.00794 and
 * this function's continuity-corrected normal p is 0.01219: 54% too large.
 * Both are under 0.05 here, but at a different threshold they part company,
 * and there is no repair that keeps it a closed form. `normalApproximationValid`
 * is false below 8 per sample; treat `p` as a rank ordering there, not a rate.
 * `lib.test.ts` pins both numbers against a brute-force enumeration of all 252
 * splits so the size of that gap cannot drift unnoticed.
 *
 * Direction: `z` is signed from `u1`, so z < 0 means sample 1 tends LOWER.
 * The two-sided p is identical either way — u2 - mu is exactly -(u1 - mu).
 */
export function mannWhitneyU(
  sample1: ReadonlyArray<number>,
  sample2: ReadonlyArray<number>,
  options: MannWhitneyOptions = {},
): MannWhitneyResult {
  assertFinite(sample1, "sample1");
  assertFinite(sample2, "sample2");
  const continuityCorrection = options.continuityCorrection ?? true;
  const n1 = sample1.length;
  const n2 = sample2.length;
  const n = n1 + n2;
  const base = {
    n1,
    n2,
    continuityCorrection,
    normalApproximationValid: n1 >= 8 && n2 >= 8,
  };
  if (n1 === 0 || n2 === 0) {
    return {
      ...base,
      rankSum1: 0,
      rankSum2: 0,
      u1: null,
      u2: null,
      u: null,
      mu: null,
      sigma: null,
      z: null,
      p: null,
      tieGroups: 0,
      normalApproximationValid: false,
      note: `one sample is empty (n1=${n1}, n2=${n2}); there is nothing to compare, so no U, z or p exists`,
    };
  }
  const pooled = [...sample1, ...sample2];
  const ranks = rank(pooled);
  const rankSum1 = compensatedSum(ranks.slice(0, n1));
  const rankSum2 = compensatedSum(ranks.slice(n1));
  const u1 = rankSum1 - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const mu = (n1 * n2) / 2;
  const { groups, correction } = tieRuns(pooled);
  // n === 1 cannot reach here (both samples are non-empty), so N(N-1) > 0.
  const varianceU = ((n1 * n2) / 12) * (n + 1 - correction / (n * (n - 1)));
  const sigma = Math.sqrt(Math.max(0, varianceU));
  const common = {
    ...base,
    rankSum1,
    rankSum2,
    u1,
    u2,
    u: Math.min(u1, u2),
    mu,
    sigma,
    tieGroups: groups,
  };
  if (sigma === 0) {
    // Every observation in both samples is the same value: one tie group of
    // size N makes the correction cancel the whole variance. U lands exactly
    // on mu, so z would be 0/0. Reporting z=0, p=1 would be a confident claim
    // of "no difference" drawn from data that cannot express one.
    return {
      ...common,
      z: null,
      p: null,
      note: "every observation is tied at the same value, so the ranks carry no information and no z or p exists; U is at its null mean by construction",
    };
  }
  const deviation = u1 - mu;
  const corrected = continuityCorrection
    ? Math.sign(deviation) * Math.max(0, Math.abs(deviation) - 0.5)
    : deviation;
  const z = corrected / sigma;
  const p = Math.min(1, 2 * normalUpperTail(Math.abs(z)));
  return {
    ...common,
    z,
    p,
    note: common.normalApproximationValid
      ? `normal approximation over n1=${n1}, n2=${n2}${groups > 0 ? ` with ${groups} tie group(s) corrected` : ""}; p is two-sided`
      : `n1=${n1}, n2=${n2} is below the 8-per-sample rule of thumb: the normal approximation to U is materially off this small (for 5 vs 5 fully separated it reads 0.0122 where the exact test reads 0.0079). Use p to order candidates, not as a rate`,
  };
}

// --- Wilson score interval --------------------------------------------------

export type WilsonInterval = {
  successes: number;
  trials: number;
  /** successes / trials — the number people quote, and the one that misleads. */
  pointEstimate: number;
  lower: number;
  upper: number;
  /** Width of the interval; the honest measure of how little n trials bought. */
  width: number;
  /** The critical value used, echoed so the interval is reproducible. */
  z: number;
  note: string;
};

/**
 * Wilson score interval for a binomial proportion, clamped to [0, 1], or
 * `null` when `trials` is 0 (an interval on no observations is fabrication,
 * not caution).
 *
 * Wilson, "Probable inference, the law of succession, and statistical
 * inference", JASA 22(158):209-212 (1927). Solves
 * |p_hat - p| = z * sqrt(p(1-p)/n) for p rather than assuming the Wald
 * interval's normal error around p_hat, which is why it stays inside [0,1] and
 * stays sane at p_hat = 0 or 1 where Wald degenerates to a point.
 *
 * This is what flaky-test detection needs. Three failures in five runs is not
 * a 60% failure rate: at 95% it is [0.231, 0.882], which spans "annoying" and
 * "the test is broken" without distinguishing them. Quarantining on the point
 * estimate is quarantining on noise.
 *
 * Pinned in `lib.test.ts` to published values, including two this repository
 * already relies on elsewhere so the copies cannot drift apart:
 *   - 24/30 at z=1.959964 -> lower 0.6269, the number
 *     `@crewhaus/model-plan`'s `floor.test.ts` pins for `wilsonLowerBound`.
 *   - 8/8 at 95% -> [0.6756, 1.0], the interval `@crewhaus/eval-runner`'s
 *     `stats.ts` cites in its own header as [0.68, 1.0].
 *
 * NOT continuity-corrected. The corrected form is wider and is a different
 * published interval; if a caller wants it, it belongs here as an option with
 * its own pins, not as a silent change to this one.
 */
export function wilsonScoreInterval(
  successes: number,
  trials: number,
  z: number = Z_95,
): WilsonInterval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) {
    throw new StatsError(
      `successes and trials must be whole counts, got ${successes} and ${trials}`,
    );
  }
  if (trials < 0 || successes < 0 || successes > trials) {
    throw new StatsError(
      `need 0 <= successes <= trials, got ${successes} successes in ${trials} trials`,
    );
  }
  if (!Number.isFinite(z) || z <= 0) {
    throw new StatsError(`z must be a positive finite critical value, got ${z}`);
  }
  if (trials === 0) return null;
  const pHat = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (pHat + z2 / (2 * trials)) / denominator;
  const half =
    (z / denominator) * Math.sqrt((pHat * (1 - pHat)) / trials + z2 / (4 * trials * trials));
  // At p_hat = 1 the algebra collapses exactly: centre + half becomes
  // (1 + z^2/n)/(1 + z^2/n). In floats it comes out 0.9999999999999999, and a
  // gate asking "can this still fail?" by comparing the upper bound against 1
  // would answer yes forever. Same at the bottom for 0 successes.
  const lower = successes === 0 ? 0 : Math.max(0, centre - half);
  const upper = successes === trials ? 1 : Math.min(1, centre + half);
  return {
    successes,
    trials,
    pointEstimate: pHat,
    lower,
    upper,
    width: upper - lower,
    z,
    note: `Wilson score interval at z=${z} over ${trials} trial(s); the point estimate ${pHat.toFixed(3)} is one number from a range ${(upper - lower).toFixed(3)} wide`,
  };
}

// --- Cohen's kappa ----------------------------------------------------------

export type CohensKappaResult = {
  n: number;
  /** (po - pe) / (1 - pe), or `null` when there is nothing to rate. */
  kappa: number | null;
  /** Fraction of items the two raters labelled the same. */
  observedAgreement: number | null;
  /** Agreement expected from the two raters' marginals alone. */
  expectedAgreement: number | null;
  /** Every distinct label either rater used, sorted. */
  categories: string[];
  /** True when pe = 1 and kappa is a convention rather than a computation. */
  degenerate: boolean;
  note: string;
};

/**
 * Cohen's kappa for two raters over the same items: (po - pe) / (1 - pe),
 * where po is observed agreement and pe is the agreement their marginal
 * distributions would produce by chance alone.
 *
 * Cohen, "A coefficient of agreement for nominal scales", Educational and
 * Psychological Measurement 20(1):37-46 (1960).
 *
 * Worked examples, both standard and both pinned in `lib.test.ts`: over 50
 * items with 20 yes/yes, 5 yes/no, 10 no/yes and 15 no/no, po = 0.70,
 * pe = 0.50 and kappa = 0.40. Over 100 items with 45/15/25/15, po = 0.60,
 * pe = 0.54 and kappa = 0.1304 — the pair that shows why raw agreement
 * misleads: 60% agreement, almost none of it beyond chance.
 *
 * Degenerate case: if both raters used one single identical label throughout,
 * pe = 1 and kappa is 0/0. This returns 1 with `degenerate: true`, matching
 * `@crewhaus/feedback-distill`'s `cohenKappa` so the two cannot disagree — but
 * the flag is there because "perfect agreement on a constant" is not evidence
 * the raters agree about anything.
 */
export function cohensKappa(
  rater1: ReadonlyArray<string>,
  rater2: ReadonlyArray<string>,
): CohensKappaResult {
  if (rater1.length !== rater2.length) {
    throw new StatsError(
      `rater1 rated ${rater1.length} items and rater2 rated ${rater2.length}; kappa needs the same items from both`,
    );
  }
  const n = rater1.length;
  if (n === 0) {
    return {
      n: 0,
      kappa: null,
      observedAgreement: null,
      expectedAgreement: null,
      categories: [],
      degenerate: false,
      note: "no items were rated, so there is no agreement to measure",
    };
  }
  let agreed = 0;
  const counts1 = new Map<string, number>();
  const counts2 = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const a = rater1[i] as string;
    const b = rater2[i] as string;
    if (a === b) agreed++;
    counts1.set(a, (counts1.get(a) ?? 0) + 1);
    counts2.set(b, (counts2.get(b) ?? 0) + 1);
  }
  const categories = [...new Set([...counts1.keys(), ...counts2.keys()])].sort();
  const observedAgreement = agreed / n;
  let expectedAgreement = 0;
  for (const category of categories) {
    expectedAgreement += ((counts1.get(category) ?? 0) / n) * ((counts2.get(category) ?? 0) / n);
  }
  if (expectedAgreement >= 1) {
    return {
      n,
      kappa: 1,
      observedAgreement,
      expectedAgreement: 1,
      categories,
      degenerate: true,
      note: `both raters used the single label "${categories[0] ?? ""}" for all ${n} item(s); chance agreement is already 100%, so kappa is 0/0. Reported as 1 by convention, but this measures nothing`,
    };
  }
  const kappa = (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
  return {
    n,
    kappa,
    observedAgreement,
    expectedAgreement,
    categories,
    degenerate: false,
    note: `${(observedAgreement * 100).toFixed(1)}% raw agreement over ${n} item(s), of which ${(expectedAgreement * 100).toFixed(1)}% was expected by chance`,
  };
}

// --- Population Stability Index --------------------------------------------

export type PsiBin = {
  index: number;
  /**
   * Bin bounds, or `null` when the caller supplied bare counts and never told
   * us what the bins meant. The out-of-range bins carry -Infinity/+Infinity.
   */
  lo: number | null;
  hi: number | null;
  label: string;
  referenceCount: number;
  currentCount: number;
  /** Shares AFTER the epsilon floor, i.e. exactly what the sum below used. */
  referenceShare: number;
  currentShare: number;
  /** (current - reference) * ln(current / reference) for this bin. */
  contribution: number;
  /** True when the epsilon floor stood in for an empty bin on either side. */
  epsilonApplied: boolean;
};

export const PSI_BANDS = Object.freeze({ moderate: 0.1, significant: 0.25 });

export type PsiBand = "stable" | "moderate" | "significant";

export type PsiResult = {
  /** The index, or `null` when either sample is empty. */
  psi: number | null;
  band: PsiBand | null;
  bins: PsiBin[];
  epsilon: number;
  /** True if any bin needed the floor — i.e. if `psi` depends on `epsilon`. */
  epsilonApplied: boolean;
  referenceCount: number;
  currentCount: number;
  note: string;
};

export type PsiOptions = {
  /**
   * The share substituted for a bin that is EMPTY on one side. Required, with
   * no default anywhere in this file, because it decides the verdict: for a
   * ten-bin reference where one bin empties out, epsilon 1e-3 gives PSI 0.466
   * ("significant"), 1e-2 gives 0.218 ("moderate") and 0.05 gives 0.045
   * ("stable") — three different ship decisions from the same data. Pinned in
   * `lib.test.ts`. Whatever a caller picks, it belongs in the same config as
   * the threshold it is compared against.
   */
  epsilon: number;
};

/**
 * Where values outside `[edges[0], last edge]` go.
 *   - `"separate-bins"` (default): two extra bins, (-inf, edges[0]) and
 *     (last, +inf), that participate in the sum. New values beyond the
 *     reference's range are the loudest drift signal there is, and folding
 *     them into the end bins is how a distribution that moved off the edge of
 *     the chart reads as stable.
 *   - `"clamp"`: counted in the first/last bin. Matches the common scorecard
 *     practice of defining the outer edges as open-ended.
 *   - `"refuse"`: a StatsError naming how many values fell outside.
 */
export type PsiOutOfRange = "separate-bins" | "clamp" | "refuse";

/** What a bin covers, when the caller knows. `closed` marks `[lo, hi]`. */
export type PsiBinBounds = { lo: number; hi: number; closed?: boolean };

export type BinnedCounts = {
  /** One count per interval between consecutive edges. */
  counts: number[];
  belowFirstEdge: number;
  aboveLastEdge: number;
};

/**
 * Count values into the intervals between `edges`. Every bin is half-open
 * [lo, hi) except the last, which is closed [lo, hi] so the maximum lands
 * somewhere — the same rule this package's `histogram` uses, and NumPy's.
 *
 * Out-of-range values are counted separately rather than dropped: silently
 * discarding them is what makes a drift check blind to exactly the drift it
 * was installed to catch.
 */
export function binCounts(
  values: ReadonlyArray<number>,
  edges: ReadonlyArray<number>,
): BinnedCounts {
  assertEdges(edges);
  assertFinite(values);
  const k = edges.length - 1;
  const counts = new Array<number>(k).fill(0);
  const first = edges[0] as number;
  const last = edges[k] as number;
  let belowFirstEdge = 0;
  let aboveLastEdge = 0;
  for (const value of values) {
    if (value < first) {
      belowFirstEdge++;
      continue;
    }
    if (value > last) {
      aboveLastEdge++;
      continue;
    }
    if (value === last) {
      counts[k - 1] = (counts[k - 1] as number) + 1;
      continue;
    }
    // Linear scan: bin counts are typically under 20, and a binary search here
    // would only add an off-by-one to get wrong.
    for (let i = 0; i < k; i++) {
      if (value < (edges[i + 1] as number)) {
        counts[i] = (counts[i] as number) + 1;
        break;
      }
    }
  }
  return { counts, belowFirstEdge, aboveLastEdge };
}

/**
 * Population Stability Index over matched bins:
 *
 *     PSI = SUM_i (current_i - reference_i) * ln(current_i / reference_i)
 *
 * with both sides as SHARES of their own sample. Symmetric in its two
 * arguments and zero only when the two share vectors are identical.
 *
 * The bins are supplied, never derived here. PSI answers "has the current data
 * moved relative to the reference", and that is only meaningful if the
 * REFERENCE's bin edges are reused for the current data. A function that
 * re-binned its inputs would be comparing each sample against its own
 * quantiles, which is a comparison that returns roughly zero no matter how far
 * the distribution moved. Use `binCounts` with the edges you stored alongside
 * the baseline, or `psiOverEdges` below.
 *
 * Bands follow the credit-scorecard convention (Siddiqi, *Credit Risk
 * Scorecards*, 2006): under 0.1 stable, 0.1 to 0.25 moderate, over 0.25
 * significant. They assume roughly ten bins — PSI grows with bin count for the
 * same underlying shift, so a 20-bin and a 10-bin PSI are not comparable to
 * each other or to the same threshold.
 */
export function populationStabilityIndex(
  referenceCounts: ReadonlyArray<number>,
  currentCounts: ReadonlyArray<number>,
  options: PsiOptions,
  bounds?: ReadonlyArray<PsiBinBounds>,
): PsiResult {
  const epsilon = options.epsilon;
  if (!Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 1) {
    throw new StatsError(`epsilon must be a share strictly between 0 and 1, got ${epsilon}`);
  }
  if (referenceCounts.length !== currentCounts.length) {
    throw new StatsError(
      `reference has ${referenceCounts.length} bins and current has ${currentCounts.length}; PSI compares matched bins`,
    );
  }
  if (referenceCounts.length === 0) {
    throw new StatsError("PSI needs at least one bin");
  }
  assertCounts(referenceCounts, "referenceCounts");
  assertCounts(currentCounts, "currentCounts");
  const referenceTotal = compensatedSum(referenceCounts);
  const currentTotal = compensatedSum(currentCounts);
  const bins: PsiBin[] = [];
  if (referenceTotal === 0 || currentTotal === 0) {
    return {
      psi: null,
      band: null,
      bins,
      epsilon,
      epsilonApplied: false,
      referenceCount: referenceTotal,
      currentCount: currentTotal,
      note: `one side has no observations (reference ${referenceTotal}, current ${currentTotal}); a stability index needs both distributions`,
    };
  }
  let psi = 0;
  let anyEpsilon = false;
  for (let i = 0; i < referenceCounts.length; i++) {
    const referenceRaw = (referenceCounts[i] as number) / referenceTotal;
    const currentRaw = (currentCounts[i] as number) / currentTotal;
    // The floor replaces a zero share; the non-zero shares are NOT
    // renormalized afterwards. Renormalizing would let one empty bin nudge
    // every other bin's contribution by O(epsilon), which spreads an
    // arbitrary constant across terms that were measured.
    const referenceShare = referenceRaw === 0 ? epsilon : referenceRaw;
    const currentShare = currentRaw === 0 ? epsilon : currentRaw;
    // A bin empty on BOTH sides takes the floor on both sides, so its term is
    // (e - e) * ln(e/e) = 0 for every epsilon. It is not "epsilon-dependent",
    // and flagging it as such would make `psiOverEdges` warn about its own
    // out-of-range bins on every clean comparison — the warning that cries
    // wolf is the warning nobody reads when a bin really does empty out.
    const floored = (referenceRaw === 0) !== (currentRaw === 0);
    if (floored) anyEpsilon = true;
    const contribution = (currentShare - referenceShare) * Math.log(currentShare / referenceShare);
    psi += contribution;
    const bound = bounds?.[i];
    bins.push({
      index: i,
      lo: bound?.lo ?? null,
      hi: bound?.hi ?? null,
      label: bound === undefined ? `bin ${i}` : describeInterval(bound),
      referenceCount: referenceCounts[i] as number,
      currentCount: currentCounts[i] as number,
      referenceShare,
      currentShare,
      contribution,
      epsilonApplied: floored,
    });
  }
  const band: PsiBand =
    psi >= PSI_BANDS.significant
      ? "significant"
      : psi >= PSI_BANDS.moderate
        ? "moderate"
        : "stable";
  return {
    psi,
    band,
    bins,
    epsilon,
    epsilonApplied: anyEpsilon,
    referenceCount: referenceTotal,
    currentCount: currentTotal,
    note: anyEpsilon
      ? `PSI ${psi.toFixed(4)} (${band}) over ${bins.length} bins, but at least one bin was empty on one side and took the epsilon floor ${epsilon}. This number is a function of that epsilon, not only of the data — re-run with the value your threshold was set against before treating it as a verdict`
      : `PSI ${psi.toFixed(4)} (${band}) over ${bins.length} bins, no empty bins so epsilon did not enter. Bands assume ~10 bins; PSI grows with bin count for the same shift`,
  };
}

/**
 * `binCounts` on both samples with the SAME edges, then
 * `populationStabilityIndex`. The edges are the reference's, supplied by the
 * caller and stored with the baseline — see the note on the function above for
 * why they are not derived here.
 */
export function psiOverEdges(
  reference: ReadonlyArray<number>,
  current: ReadonlyArray<number>,
  edges: ReadonlyArray<number>,
  options: PsiOptions & { outOfRange?: PsiOutOfRange },
): PsiResult {
  const policy = options.outOfRange ?? "separate-bins";
  const referenceBins = binCounts(reference, edges);
  const currentBins = binCounts(current, edges);
  const outside =
    referenceBins.belowFirstEdge +
    referenceBins.aboveLastEdge +
    currentBins.belowFirstEdge +
    currentBins.aboveLastEdge;
  if (policy === "refuse" && outside > 0) {
    throw new StatsError(
      `${outside} value(s) fell outside the bin edges [${edges[0]}, ${edges[edges.length - 1]}]; pass outOfRange "clamp" or "separate-bins" to decide where they count`,
    );
  }
  const k = edges.length - 1;
  const bounds: PsiBinBounds[] = [];
  for (let i = 0; i < k; i++) {
    // The last edge-interval is closed, matching `binCounts`. Carried as a
    // flag rather than inferred from the position, because "separate-bins"
    // appends an overflow bin after it and the position stops being a clue.
    bounds.push({ lo: edges[i] as number, hi: edges[i + 1] as number, closed: i === k - 1 });
  }
  let referenceCounts = [...referenceBins.counts];
  let currentCounts = [...currentBins.counts];
  if (policy === "clamp") {
    referenceCounts[0] = (referenceCounts[0] as number) + referenceBins.belowFirstEdge;
    referenceCounts[k - 1] = (referenceCounts[k - 1] as number) + referenceBins.aboveLastEdge;
    currentCounts[0] = (currentCounts[0] as number) + currentBins.belowFirstEdge;
    currentCounts[k - 1] = (currentCounts[k - 1] as number) + currentBins.aboveLastEdge;
    // The end bins now hold everything past the edge, so their labels have to
    // say so. A bin reported as [20, 30] while holding a 900 is how someone
    // reads a clamped PSI as if nothing had left the range.
    bounds[0] = { lo: Number.NEGATIVE_INFINITY, hi: (bounds[0] as PsiBinBounds).hi };
    bounds[k - 1] = { lo: (bounds[k - 1] as PsiBinBounds).lo, hi: Number.POSITIVE_INFINITY };
  } else if (policy === "separate-bins") {
    referenceCounts = [
      referenceBins.belowFirstEdge,
      ...referenceCounts,
      referenceBins.aboveLastEdge,
    ];
    currentCounts = [currentBins.belowFirstEdge, ...currentCounts, currentBins.aboveLastEdge];
    bounds.unshift({ lo: Number.NEGATIVE_INFINITY, hi: edges[0] as number });
    bounds.push({ lo: edges[k] as number, hi: Number.POSITIVE_INFINITY });
  }
  return populationStabilityIndex(referenceCounts, currentCounts, options, bounds);
}

// --- shared helpers ---------------------------------------------------------

function assertFinite(values: ReadonlyArray<number>, label = "values"): void {
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (!Number.isFinite(v)) {
      throw new StatsError(`${label}[${i}] is ${v}; every value must be a finite number`);
    }
  }
}

function assertCounts(counts: ReadonlyArray<number>, label: string): void {
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] as number;
    if (!Number.isFinite(c) || c < 0) {
      throw new StatsError(`${label}[${i}] is ${c}; bin counts must be non-negative and finite`);
    }
  }
}

function assertEdges(edges: ReadonlyArray<number>): void {
  if (edges.length < 2) {
    throw new StatsError(`bin edges need at least 2 values to make one bin, got ${edges.length}`);
  }
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i] as number;
    if (!Number.isFinite(e)) {
      throw new StatsError(`bin edge [${i}] is ${e}; edges must be finite`);
    }
    // Strictly increasing, not merely non-decreasing: a zero-width bin can
    // never receive a value under the half-open rule, so it would contribute
    // an epsilon-vs-epsilon term to every PSI forever.
    if (i > 0 && e <= (edges[i - 1] as number)) {
      throw new StatsError(
        `bin edges must be strictly increasing; edge [${i}] is ${e} but [${i - 1}] is ${edges[i - 1]}`,
      );
    }
  }
}

function sortedFinite(values: ReadonlyArray<number>): number[] {
  assertFinite(values);
  return [...values].sort((a, b) => a - b);
}

function describeInterval(bound: PsiBinBounds): string {
  const open = bound.lo === Number.NEGATIVE_INFINITY ? "(-inf" : `[${bound.lo}`;
  const close =
    bound.hi === Number.POSITIVE_INFINITY ? "+inf)" : `${bound.hi}${bound.closed ? "]" : ")"}`;
  return `${open}, ${close}`;
}

/**
 * Tie-group bookkeeping for the rank-sum variance: how many groups of equal
 * values there are, and SUM(t^3 - t) over them. Both come from one pass over a
 * sorted copy, so the correction cannot disagree with the ranking it corrects.
 */
function tieRuns(values: ReadonlyArray<number>): { groups: number; correction: number } {
  const sorted = [...values].sort((a, b) => a - b);
  let groups = 0;
  let correction = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[i]) j++;
    const t = j - i + 1;
    if (t > 1) {
      groups++;
      correction += t * t * t - t;
    }
    i = j + 1;
  }
  return { groups, correction };
}
