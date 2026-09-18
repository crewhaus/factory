/**
 * Comparing two benchmark runs without lying about what five samples can say.
 *
 * Benchmark timings are not normal. They are bounded below by the work the
 * machine actually has to do and unbounded above by everything that can
 * interrupt it, so the distribution is right-skewed and a single GC pause or
 * a scheduler preemption lands in the tail. Averaging pulls the mean toward
 * that tail; a t-test on five samples then reports the tail as the effect.
 * So: the location estimate is the median, the spread is the MAD, and the
 * test is Mann-Whitney, all of them from `@crewhaus/tool-math`'s statistics
 * kernel rather than re-derived here.
 *
 * Two refusals are the point of the module:
 *
 *   - Below the caller's DECLARED noise floor, a difference is reported as no
 *     detectable change no matter how small p is. The floor is a statement
 *     about bias the samples cannot average away — thermal throttling, a
 *     different worktree layout, a noisy neighbour — and significance says
 *     nothing about bias.
 *   - Below 8 samples per side the normal approximation to U is materially
 *     wrong (the kernel documents the size of the gap), so no significance is
 *     called at all. At the common default of 5 runs, "cannot tell" is the
 *     honest answer and this module returns it.
 */
import { statsKernel } from "@crewhaus/tool-math";

/**
 * The kernel's own rule of thumb, restated here because this module refuses
 * on it. Below this per side, `mannWhitneyU` sets `normalApproximationValid`
 * false and its p is a rank ordering rather than a rate.
 */
export const MIN_SAMPLES_FOR_SIGNIFICANCE = 8;

export class BenchError extends Error {
  override readonly name = "BenchError";
}

/** One benchmark's measurements. Exactly one of the two forms is populated. */
export type BenchmarkInput = {
  readonly name: string;
  /** Per-iteration samples. */
  readonly base?: ReadonlyArray<number>;
  readonly head?: ReadonlyArray<number>;
  /** Or a single pre-aggregated number, when the framework reports only a mean. */
  readonly baseAggregate?: number;
  readonly headAggregate?: number;
};

export type CompareOptions = {
  /**
   * Required, never defaulted. The smallest relative difference this machine
   * and this harness can actually resolve, as a percentage. A tool that
   * guessed it for the caller would be inventing the one number that decides
   * whether a 3% move is a regression or a warm laptop.
   */
  readonly noiseFloorPercent: number;
  readonly alpha?: number;
  /** True for durations, false for throughput (ops/sec). */
  readonly lowerIsBetter?: boolean;
  readonly continuityCorrection?: boolean;
};

export type BenchmarkVerdict =
  | "regression"
  | "improvement"
  | "no-detectable-change"
  | "no-significant-difference"
  | "cannot-tell"
  | "not-tested";

export type SideSummary = {
  readonly n: number;
  readonly median: number | null;
  readonly mad: number | null;
  readonly madScaled: number | null;
  readonly trimmedMean: number | null;
  readonly min: number | null;
  readonly max: number | null;
  /** The plain mean, reported ONLY so a reader can see how far the skew pulls it. */
  readonly mean: number | null;
};

export type TestSummary = {
  readonly u: number | null;
  readonly z: number | null;
  readonly p: number | null;
  readonly tieGroups: number;
  readonly normalApproximationValid: boolean;
  readonly note: string;
};

export type BenchmarkComparison = {
  readonly name: string;
  readonly method: "mann-whitney" | "threshold";
  readonly base: SideSummary;
  readonly head: SideSummary;
  /** Relative change of the head median against the base median. */
  readonly changePercent: number | null;
  readonly direction: "slower" | "faster" | "unchanged" | "unknown";
  readonly withinNoiseFloor: boolean | null;
  readonly test: TestSummary | null;
  readonly verdict: BenchmarkVerdict;
  readonly why: string;
};

export type CompareReport = {
  readonly noiseFloorPercent: number;
  readonly alpha: number;
  readonly lowerIsBetter: boolean;
  readonly minSamplesForSignificance: number;
  readonly benchmarks: ReadonlyArray<BenchmarkComparison>;
  readonly summary: Readonly<Record<BenchmarkVerdict, number>>;
  readonly verdict: "regression" | "inconclusive" | "clean";
  readonly note: string;
};

const EMPTY_SIDE: SideSummary = {
  n: 0,
  median: null,
  mad: null,
  madScaled: null,
  trimmedMean: null,
  min: null,
  max: null,
  mean: null,
};

function summarize(samples: ReadonlyArray<number>): SideSummary {
  if (samples.length === 0) return EMPTY_SIDE;
  const mad = statsKernel.medianAbsoluteDeviation(samples);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (const value of samples) {
    if (value < min) min = value;
    if (value > max) max = value;
    total += value;
  }
  return {
    n: samples.length,
    median: statsKernel.median(samples),
    mad: mad === null ? null : mad.mad,
    madScaled: mad === null ? null : mad.scaled,
    // 10% off each tail: R's convention, and enough to drop one bad sample in
    // a run of ten without pretending the rest are clean.
    trimmedMean: statsKernel.trimmedMean(samples, 0.1),
    min,
    max,
    mean: total / samples.length,
  };
}

function aggregateSide(value: number): SideSummary {
  // A framework that reports only a mean gives one number per side. It is
  // recorded as the median position so the delta arithmetic is shared, but
  // `n: 1` and `method: "threshold"` keep it out of any significance claim.
  return { ...EMPTY_SIDE, n: 1, median: value, mean: value };
}

function assertFiniteSamples(name: string, side: string, samples: ReadonlyArray<number>): void {
  for (const value of samples) {
    if (!Number.isFinite(value)) {
      throw new BenchError(
        `benchmark "${name}" has a non-finite ${side} sample (${value}); a timing that is NaN or Infinity is a broken measurement, not a slow one`,
      );
    }
  }
}

/**
 * Which way `changePercent` points, given what "better" means for this unit.
 * Throughput benchmarks (ops/sec) invert the sign, and getting that wrong
 * turns every improvement into a regression.
 */
function directionOf(
  changePercent: number | null,
  lowerIsBetter: boolean,
): BenchmarkComparison["direction"] {
  if (changePercent === null) return "unknown";
  if (changePercent === 0) return "unchanged";
  const higher = changePercent > 0;
  return higher === lowerIsBetter ? "slower" : "faster";
}

export function compareBenchmark(
  input: BenchmarkInput,
  options: CompareOptions,
): BenchmarkComparison {
  const lowerIsBetter = options.lowerIsBetter ?? true;
  const alpha = options.alpha ?? 0.05;
  const floor = options.noiseFloorPercent;
  const hasSamples = input.base !== undefined || input.head !== undefined;
  const hasAggregate = input.baseAggregate !== undefined || input.headAggregate !== undefined;
  if (hasSamples && hasAggregate) {
    throw new BenchError(
      `benchmark "${input.name}" carries both samples and an aggregate; give one or the other, because an aggregate cannot be tested against samples`,
    );
  }
  if (!hasSamples && !hasAggregate) {
    throw new BenchError(`benchmark "${input.name}" carries no measurements on either side`);
  }

  let base: SideSummary;
  let head: SideSummary;
  let method: BenchmarkComparison["method"];
  if (hasAggregate) {
    if (input.baseAggregate === undefined || input.headAggregate === undefined) {
      throw new BenchError(
        `benchmark "${input.name}" has an aggregate on one side only; there is nothing to compare it against`,
      );
    }
    assertFiniteSamples(input.name, "base", [input.baseAggregate]);
    assertFiniteSamples(input.name, "head", [input.headAggregate]);
    base = aggregateSide(input.baseAggregate);
    head = aggregateSide(input.headAggregate);
    method = "threshold";
  } else {
    const baseSamples = input.base ?? [];
    const headSamples = input.head ?? [];
    assertFiniteSamples(input.name, "base", baseSamples);
    assertFiniteSamples(input.name, "head", headSamples);
    base = summarize(baseSamples);
    head = summarize(headSamples);
    method = "mann-whitney";
  }

  const baseMedian = base.median;
  const headMedian = head.median;
  const changePercent =
    baseMedian === null || headMedian === null || baseMedian === 0
      ? null
      : ((headMedian - baseMedian) / baseMedian) * 100;
  const direction = directionOf(changePercent, lowerIsBetter);
  const withinNoiseFloor = changePercent === null ? null : Math.abs(changePercent) <= floor;

  const shell = {
    name: input.name,
    method,
    base,
    head,
    changePercent,
    direction,
    withinNoiseFloor,
  };

  if (base.n === 0 || head.n === 0) {
    return {
      ...shell,
      test: null,
      verdict: "cannot-tell",
      why: `one side has no measurements (base n=${base.n}, head n=${head.n})`,
    };
  }
  if (changePercent === null) {
    return {
      ...shell,
      test: null,
      verdict: "cannot-tell",
      why:
        baseMedian === 0
          ? "the base median is 0, so a relative change is undefined — compare absolute values, or measure something with a non-zero baseline"
          : "there is no median on one side to compare against",
    };
  }
  if (withinNoiseFloor === true) {
    return {
      ...shell,
      test: null,
      verdict: "no-detectable-change",
      why: `${changePercent.toFixed(2)}% is inside the declared noise floor of ${floor}%, which no number of samples can see past`,
    };
  }
  if (method === "threshold") {
    return {
      ...shell,
      test: null,
      verdict: "not-tested",
      why: `${changePercent.toFixed(2)}% clears the ${floor}% noise floor, but this framework reported one aggregate per side and a single number cannot support a significance test — re-run it with per-iteration samples to get a verdict`,
    };
  }

  const test = statsKernel.mannWhitneyU(input.base ?? [], input.head ?? [], {
    continuityCorrection: options.continuityCorrection ?? true,
  });
  const summary: TestSummary = {
    u: test.u,
    z: test.z,
    p: test.p,
    tieGroups: test.tieGroups,
    normalApproximationValid: test.normalApproximationValid,
    note: test.note,
  };
  if (base.n < MIN_SAMPLES_FOR_SIGNIFICANCE || head.n < MIN_SAMPLES_FOR_SIGNIFICANCE) {
    return {
      ...shell,
      test: summary,
      verdict: "cannot-tell",
      why: `${changePercent.toFixed(2)}% clears the ${floor}% noise floor, but with base n=${base.n} and head n=${head.n} the normal approximation to U is not usable (it needs ${MIN_SAMPLES_FOR_SIGNIFICANCE} per side); p is reported for ranking candidates only. Re-run with more samples before calling this a regression`,
    };
  }
  if (test.p === null) {
    return {
      ...shell,
      test: summary,
      verdict: "cannot-tell",
      why: `no p exists for this pair: ${test.note}`,
    };
  }
  if (test.p >= alpha) {
    return {
      ...shell,
      test: summary,
      verdict: "no-significant-difference",
      why: `${changePercent.toFixed(2)}% clears the ${floor}% noise floor but p=${test.p.toFixed(4)} is not below alpha=${alpha} over ${base.n} vs ${head.n} samples`,
    };
  }
  return {
    ...shell,
    test: summary,
    verdict: direction === "slower" ? "regression" : "improvement",
    why: `${changePercent.toFixed(2)}% (${direction}) clears the ${floor}% noise floor with p=${test.p.toFixed(4)} over ${base.n} vs ${head.n} samples`,
  };
}

const VERDICTS: ReadonlyArray<BenchmarkVerdict> = [
  "regression",
  "improvement",
  "no-detectable-change",
  "no-significant-difference",
  "cannot-tell",
  "not-tested",
];

export function compareBenchmarks(
  inputs: ReadonlyArray<BenchmarkInput>,
  options: CompareOptions,
): CompareReport {
  if (!Number.isFinite(options.noiseFloorPercent) || options.noiseFloorPercent < 0) {
    throw new BenchError(
      `noiseFloorPercent must be a non-negative percentage, got ${options.noiseFloorPercent}`,
    );
  }
  const alpha = options.alpha ?? 0.05;
  if (!(alpha > 0 && alpha < 1)) {
    throw new BenchError(`alpha must be strictly between 0 and 1, got ${alpha}`);
  }
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.name)) {
      throw new BenchError(
        `benchmark "${input.name}" appears twice; two rows under one name cannot both be the result for it`,
      );
    }
    seen.add(input.name);
  }
  const benchmarks = inputs.map((input) => compareBenchmark(input, options));
  const summary = Object.fromEntries(
    VERDICTS.map((v) => [v, benchmarks.filter((b) => b.verdict === v).length]),
  ) as Record<BenchmarkVerdict, number>;
  // A gate goes green only when nothing was left unjudged. "cannot tell" on
  // half the suite with no regressions is not a clean run, and reporting it as
  // one is how an unmeasurable suite stays unmeasured for a year.
  const verdict =
    summary.regression > 0
      ? "regression"
      : summary["cannot-tell"] + summary["not-tested"] > 0
        ? "inconclusive"
        : "clean";
  return {
    noiseFloorPercent: options.noiseFloorPercent,
    alpha,
    lowerIsBetter: options.lowerIsBetter ?? true,
    minSamplesForSignificance: MIN_SAMPLES_FOR_SIGNIFICANCE,
    benchmarks,
    summary,
    verdict,
    note: `${benchmarks.length} benchmark(s) compared by median with Mann-Whitney at alpha=${alpha}, under a declared noise floor of ${options.noiseFloorPercent}%`,
  };
}
