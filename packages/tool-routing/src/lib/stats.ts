/**
 * Every number these tools report about "how good is this arm" passes through
 * here, and nothing in this file computes a statistic.
 *
 * THE TRAP. An arm with three observations is not a better arm than one with
 * three hundred, and a point estimate says it is. `route status` prints a
 * mean reward per arm; an experiment ledger prints a success rate per
 * version; a watchme roll-up prints a tool-error rate. All three are one
 * division, all three look authoritative, and all three are worthless without
 * the width of the interval around them. So: a proportion here is always a
 * Wilson score interval, a comparison is always a rank test, and a number
 * that cannot carry one says so instead of appearing bare.
 *
 * THE IMPLEMENTATIONS ARE `@crewhaus/tool-math`'s. `wilsonScoreInterval` and
 * `mannWhitneyU` live in its statistics kernel, are pinned there against
 * published values and against the three other Wilson implementations in this
 * repository, and are already what `tool-buildperf`, `tool-table` and
 * `tool-evalops` use. This module is adapters: it shapes the kernel's results
 * for a tool result and decides what "decided" means, which is a policy
 * question, not an arithmetic one. There is no fourth Wilson here.
 */
import { statsKernel } from "@crewhaus/tool-math";

/** The default confidence level, echoed on every interval so it is reproducible. */
export const CONFIDENCE = "95%";

/**
 * A proportion with its interval, or an explicit statement that no interval
 * exists.
 *
 * `interval: null` is never the same as `[0, 0]`. `wilsonScoreInterval`
 * returns `null` at zero trials on purpose — "an interval on no observations
 * is fabrication, not caution" — and that null is carried here rather than
 * flattened, so a caller that renders the field cannot show a bound that was
 * never computed.
 */
export type RateView = {
  readonly successes: number;
  readonly trials: number;
  /** successes / trials — the number people quote, and the one that misleads. */
  readonly point: number | null;
  readonly interval: {
    readonly lower: number;
    readonly upper: number;
    readonly width: number;
  } | null;
  readonly confidence: string;
  /** Why there is no interval, when there is none. */
  readonly note: string;
};

/**
 * Wilson score interval for `successes` out of `trials`.
 *
 * Refuses nothing: a caller that hands it a non-integer or an impossible
 * count gets a `RateView` with no interval and the kernel's own complaint,
 * because a tool reporting on a store it did not write must not throw on data
 * that store produced.
 */
export function rate(successes: number, trials: number): RateView {
  const base = { successes, trials, confidence: CONFIDENCE };
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) {
    return {
      ...base,
      point: null,
      interval: null,
      note: `successes (${successes}) and trials (${trials}) are not whole counts, so no proportion is defined`,
    };
  }
  if (trials === 0) {
    return {
      ...base,
      point: null,
      interval: null,
      note: "no observations — a rate on zero trials is fabrication, not caution, so neither a point estimate nor an interval is reported",
    };
  }
  let wilson: ReturnType<typeof statsKernel.wilsonScoreInterval>;
  try {
    wilson = statsKernel.wilsonScoreInterval(successes, trials);
  } catch (err) {
    return {
      ...base,
      point: null,
      interval: null,
      note: `@crewhaus/tool-math refused these counts: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (wilson === null) {
    return { ...base, point: null, interval: null, note: "no observations" };
  }
  return {
    ...base,
    point: wilson.pointEstimate,
    interval: { lower: wilson.lower, upper: wilson.upper, width: wilson.width },
    confidence: CONFIDENCE,
    note: wilson.note,
  };
}

/**
 * A CONTINUOUS mean with an interval, for the one thing on a routing arm that
 * is not a proportion.
 *
 * `ArmStats.meanReward` is the average of a scalar in [0, 1], not a count of
 * successes over trials — Wilson does not apply to it, and using Wilson
 * anyway (round the mean to a success count, say) would be inventing data.
 * What the scoreboard does carry is the Welford sample variance, so the
 * honest interval is the textbook normal-approximation one,
 * `mean ± z · sd / sqrt(n)`, with `z` taken from the kernel's own table
 * rather than typed as 1.96 here.
 *
 * `null` below two observations: the sample variance is defined as 0 there
 * (`toStats` says so), and an interval of width 0 around a single reading is
 * the exact lie this module exists to prevent.
 */
export type MeanView = {
  readonly n: number;
  readonly mean: number | null;
  readonly sd: number | null;
  readonly interval: { readonly lower: number; readonly upper: number } | null;
  readonly confidence: string;
  readonly basis: string;
  readonly note: string;
};

export function meanWithInterval(mean: number, variance: number, n: number): MeanView {
  const basis =
    "normal approximation, mean ± z·sd/√n — NOT a Wilson interval: the scoreboard's mean reward is a continuous scalar, not a success count";
  if (n < 1) {
    return {
      n,
      mean: null,
      sd: null,
      interval: null,
      confidence: CONFIDENCE,
      basis,
      note: "no observations folded into this arm",
    };
  }
  const sd = variance > 0 ? Math.sqrt(variance) : 0;
  if (n < 2) {
    return {
      n,
      mean,
      sd: null,
      interval: null,
      confidence: CONFIDENCE,
      basis,
      note: "one observation: the scoreboard reports variance 0 by convention at n<2, so there is no spread to build an interval from",
    };
  }
  const half = statsKernel.Z_95 * (sd / Math.sqrt(n));
  return {
    n,
    mean,
    sd,
    interval: { lower: mean - half, upper: mean + half },
    confidence: CONFIDENCE,
    basis,
    note: `${n} observation(s); the interval is ${(2 * half).toFixed(4)} wide, which is what those observations actually bought`,
  };
}

/**
 * Whether two proportions are distinguishable at this evidence level.
 *
 * The rule is deliberately the weak one — non-overlapping intervals — and the
 * verdict is deliberately three-valued. Overlapping Wilson intervals do NOT
 * prove equality, and a reader who takes "undecided" as "the same" has made
 * the same mistake in the other direction, so the note says which one it is.
 */
export type RateComparison = {
  readonly verdict: "separated" | "undecided" | "not-comparable";
  readonly reason: string;
};

export function compareRates(a: RateView, b: RateView): RateComparison {
  if (a.interval === null || b.interval === null) {
    return {
      verdict: "not-comparable",
      reason: `one side has no interval (${a.trials} and ${b.trials} trial(s)) — nothing can be concluded`,
    };
  }
  const disjoint = a.interval.upper < b.interval.lower || b.interval.upper < a.interval.lower;
  return disjoint
    ? {
        verdict: "separated",
        reason: `the ${CONFIDENCE} intervals do not overlap ([${a.interval.lower.toFixed(3)}, ${a.interval.upper.toFixed(3)}] vs [${b.interval.lower.toFixed(3)}, ${b.interval.upper.toFixed(3)}])`,
      }
    : {
        verdict: "undecided",
        reason: `the ${CONFIDENCE} intervals overlap ([${a.interval.lower.toFixed(3)}, ${a.interval.upper.toFixed(3)}] vs [${b.interval.lower.toFixed(3)}, ${b.interval.upper.toFixed(3)}]) — this does not say the two are equal, it says ${a.trials} and ${b.trials} observation(s) cannot tell them apart`,
      };
}

/** Below this per-sample count the normal approximation to U is not a rate. */
const MIN_PER_SAMPLE = 8;

/** The conventional two-sided threshold. Echoed so a reader can re-derive the verdict. */
export const ALPHA = 0.05;

/**
 * A rank comparison between two sets of per-observation scores.
 *
 * Mann-Whitney rather than a difference of means, for the reason the kernel's
 * own header gives: a mean is moved by one outlier, and the question being
 * asked ("does this version tend to score higher") is ordinal. The verdict is
 * `undecided` — never "no difference" — whenever the test cannot answer, and
 * the kernel's `normalApproximationValid` is honoured rather than ignored:
 * under eight observations per side the p-value is a rank ordering, not a
 * rate, so a threshold applied to it would be making up a decision.
 */
export type SampleComparison = {
  readonly n1: number;
  readonly n2: number;
  readonly u: number | null;
  readonly z: number | null;
  readonly p: number | null;
  readonly alpha: number;
  readonly verdict: "separated" | "undecided";
  /** Which side tends higher, when the test separated them. */
  readonly higher: "first" | "second" | null;
  readonly test: string;
  readonly reason: string;
};

export function compareSamples(
  first: ReadonlyArray<number>,
  second: ReadonlyArray<number>,
  alpha: number = ALPHA,
): SampleComparison {
  const result = statsKernel.mannWhitneyU(first, second);
  const base = {
    n1: result.n1,
    n2: result.n2,
    u: result.u,
    z: result.z,
    p: result.p,
    alpha,
    test: "Mann-Whitney U (two-sided, normal approximation, tie-corrected, continuity-corrected) from @crewhaus/tool-math",
  };
  if (result.p === null || result.z === null) {
    return {
      ...base,
      verdict: "undecided",
      higher: null,
      reason: result.note,
    };
  }
  if (!result.normalApproximationValid) {
    return {
      ...base,
      verdict: "undecided",
      higher: null,
      reason: `fewer than ${MIN_PER_SAMPLE} observations on a side (${result.n1} vs ${result.n2}): the normal approximation to U is not a p-value at this size, so p=${result.p.toFixed(4)} is a rank ordering and no threshold is applied to it`,
    };
  }
  if (result.p >= alpha) {
    return {
      ...base,
      verdict: "undecided",
      higher: null,
      reason: `p=${result.p.toFixed(4)} at alpha=${alpha} over ${result.n1} and ${result.n2} observation(s) — not a finding of equality, a finding that this much data cannot separate them`,
    };
  }
  // `z` is signed from `u1`, so z < 0 means the FIRST sample tends lower.
  // Reading the sign is what makes this a direction rather than just a
  // difference; comparing the two means here instead would reintroduce
  // exactly the statistic this test replaced.
  return {
    ...base,
    verdict: "separated",
    higher: result.z > 0 ? "first" : "second",
    reason: `p=${result.p.toFixed(4)} < alpha=${alpha} over ${result.n1} and ${result.n2} observation(s); z=${result.z.toFixed(3)}${result.tieGroups > 0 ? ` (${result.tieGroups} tie group(s), variance tie-corrected)` : ""}`,
  };
}
