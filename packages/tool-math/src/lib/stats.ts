/**
 * Descriptive statistics, correlation, regression, histograms and outlier
 * detection.
 *
 * Two families of decisions in here change the answer, so both are named in
 * every result rather than left implicit:
 *
 *   1. SAMPLE vs POPULATION. Variance and standard deviation are reported
 *      BOTH ways and labelled. The sample form divides by n-1 (Bessel's
 *      correction; what a spreadsheet's STDEV/VAR and most statistics courses
 *      mean) and the population form divides by n (STDEVP/VARP). Picking one
 *      silently is how a tool ends up off by a few percent forever.
 *
 *   2. The PERCENTILE CONVENTION. There are at least nine in common use and
 *      they disagree on the same data. Three are implemented here:
 *
 *      - "r7" (default): linear interpolation between order statistics,
 *        h = (n-1)p, 0-indexed. R's type 7, NumPy's default, Excel's
 *        PERCENTILE.INC / QUARTILE.INC, Google Sheets PERCENTILE.
 *      - "r6": h = (n+1)p. Excel's PERCENTILE.EXC / QUARTILE.EXC, Minitab,
 *        SPSS. Undefined for p outside [1/(n+1), n/(n+1)] — refused there
 *        rather than clamped.
 *      - "nearestRank": the smallest value at or below which at least p of
 *        the data lies — ceil(p*n) on the 1-indexed sorted data. No
 *        interpolation, so the answer is always an observed value. This is
 *        the ISO 2602 / "textbook" definition.
 *
 * Sums use Neumaier compensated summation, so the total does not drift with
 * the input order the way a naive running sum does. Variance is two-pass
 * (mean first, then squared deviations) for the same reason: the textbook
 * "E[x^2] - mean^2" shortcut loses most of its digits on values far from zero.
 */

/** A refusal: the caller's data cannot answer the question asked. */
export class StatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsError";
  }
}

export const PERCENTILE_METHODS = ["r7", "r6", "nearestRank"] as const;
export type PercentileMethod = (typeof PERCENTILE_METHODS)[number];

/** Human-readable provenance for each convention, echoed in every result. */
export const PERCENTILE_METHOD_NOTES: Readonly<Record<PercentileMethod, string>> = Object.freeze({
  r7: "linear interpolation, h=(n-1)p (R type 7, NumPy default, Excel PERCENTILE.INC)",
  r6: "linear interpolation, h=(n+1)p (Excel PERCENTILE.EXC, Minitab, SPSS)",
  nearestRank: "nearest rank, ceil(p*n) on sorted data, no interpolation (ISO 2602)",
});

/** Neumaier compensated summation — order-robust and still exactly reproducible. */
export function compensatedSum(values: ReadonlyArray<number>): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const t = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - t + value : value - t + sum;
    sum = t;
  }
  return sum + compensation;
}

function assertFinite(values: ReadonlyArray<number>, label = "values"): void {
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (!Number.isFinite(v)) {
      throw new StatsError(`${label}[${i}] is ${v}; every value must be a finite number`);
    }
  }
}

function assertNonEmpty(values: ReadonlyArray<number>, label = "values"): void {
  if (values.length === 0) throw new StatsError(`${label} is empty; nothing to summarize`);
}

/** Ascending numeric sort on a copy. Never `localeCompare`, never in place. */
export function sortedCopy(values: ReadonlyArray<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

export function mean(values: ReadonlyArray<number>): number {
  assertNonEmpty(values);
  return compensatedSum(values) / values.length;
}

/** Median of the sorted data: the middle value, or the mean of the middle two. */
export function median(values: ReadonlyArray<number>): number {
  assertNonEmpty(values);
  const sorted = sortedCopy(values);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Every most-frequent value, ascending. Plural on purpose: data can be
 * bimodal, and a tool that picks one of two equally frequent values by
 * iteration order is a tool that gives two different answers to one question.
 * `count` is the shared frequency; when it is 1 the data has no mode and
 * `values` is empty.
 */
export function modes(values: ReadonlyArray<number>): { values: number[]; count: number } {
  assertNonEmpty(values);
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0;
  for (const c of counts.values()) if (c > best) best = c;
  if (best <= 1) return { values: [], count: 1 };
  const winners: number[] = [];
  for (const [value, count] of counts) if (count === best) winners.push(value);
  winners.sort((a, b) => a - b);
  return { values: winners, count: best };
}

export type Dispersion = {
  /** Divides by n-1 (Bessel-corrected). Spreadsheet VAR/STDEV. */
  sample: number | null;
  /** Divides by n. Spreadsheet VARP/STDEVP. */
  population: number;
};

/** Variance both ways. `sample` is null for n=1, where it is undefined, not 0. */
export function variance(values: ReadonlyArray<number>): Dispersion {
  assertNonEmpty(values);
  const n = values.length;
  const m = mean(values);
  const squares = values.map((v) => (v - m) * (v - m));
  const total = compensatedSum(squares);
  return {
    population: total / n,
    sample: n > 1 ? total / (n - 1) : null,
  };
}

export function stdev(values: ReadonlyArray<number>): Dispersion {
  const v = variance(values);
  return {
    population: Math.sqrt(v.population),
    sample: v.sample === null ? null : Math.sqrt(v.sample),
  };
}

/**
 * A percentile of ALREADY SORTED ascending data, by the named convention.
 * `p` is a fraction in [0,1], not a percentage.
 */
export function percentileSorted(
  sorted: ReadonlyArray<number>,
  p: number,
  method: PercentileMethod,
): number {
  const n = sorted.length;
  assertNonEmpty(sorted, "values");
  if (!(p >= 0 && p <= 1)) {
    throw new StatsError(`percentile fraction must be between 0 and 1, got ${p}`);
  }
  if (method === "nearestRank") {
    const rank = Math.max(1, Math.ceil(p * n));
    return sorted[rank - 1] as number;
  }
  // The r6 domain check comes BEFORE the single-value shortcut: r6 is defined
  // for n=1 only at p=0.5, and answering every p with the one observation would
  // be a confident number under a convention that does not define it.
  const h = method === "r7" ? (n - 1) * p : (n + 1) * p - 1;
  if (method === "r6" && (h < 0 || h > n - 1)) {
    const lo = 1 / (n + 1);
    const hi = n / (n + 1);
    throw new StatsError(
      `the r6 convention leaves p=${p} undefined for n=${n}: it is only defined for p between ${lo.toFixed(6)} and ${hi.toFixed(6)}. Use r7 or nearestRank, or supply more data`,
    );
  }
  if (n === 1) return sorted[0] as number;
  const lowIndex = Math.floor(h);
  const highIndex = Math.min(lowIndex + 1, n - 1);
  const low = sorted[lowIndex] as number;
  const high = sorted[highIndex] as number;
  return low + (h - lowIndex) * (high - low);
}

export function percentile(
  values: ReadonlyArray<number>,
  p: number,
  method: PercentileMethod,
): number {
  assertFinite(values);
  return percentileSorted(sortedCopy(values), p, method);
}

export type Quartiles = { q1: number; q2: number; q3: number; iqr: number };

export function quartiles(sorted: ReadonlyArray<number>, method: PercentileMethod): Quartiles {
  const q1 = percentileSorted(sorted, 0.25, method);
  const q2 = percentileSorted(sorted, 0.5, method);
  const q3 = percentileSorted(sorted, 0.75, method);
  return { q1, q2, q3, iqr: q3 - q1 };
}

export type Summary = {
  count: number;
  sum: number;
  mean: number;
  median: number;
  mode: { values: number[]; count: number };
  variance: Dispersion;
  stdev: Dispersion;
  min: number;
  max: number;
  range: number;
  quartiles: Quartiles;
  percentileMethod: PercentileMethod;
  percentileMethodNote: string;
};

export function summarize(values: ReadonlyArray<number>, method: PercentileMethod = "r7"): Summary {
  assertNonEmpty(values);
  assertFinite(values);
  const sorted = sortedCopy(values);
  return {
    count: values.length,
    sum: compensatedSum(values),
    mean: mean(values),
    median: median(sorted),
    mode: modes(values),
    variance: variance(values),
    stdev: stdev(values),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    range: (sorted[sorted.length - 1] as number) - (sorted[0] as number),
    quartiles: quartiles(sorted, method),
    percentileMethod: method,
    percentileMethodNote: PERCENTILE_METHOD_NOTES[method],
  };
}

// --- correlation -----------------------------------------------------------

function assertPaired(x: ReadonlyArray<number>, y: ReadonlyArray<number>): void {
  if (x.length !== y.length) {
    throw new StatsError(`x has ${x.length} values and y has ${y.length}; they must be paired`);
  }
  if (x.length < 2) throw new StatsError("at least 2 paired observations are required");
  assertFinite(x, "x");
  assertFinite(y, "y");
}

/**
 * Pearson's r: the linear correlation of the raw values. Null when either
 * series is constant — the correlation is undefined there, not zero.
 */
export function pearson(x: ReadonlyArray<number>, y: ReadonlyArray<number>): number | null {
  assertPaired(x, y);
  const mx = mean(x);
  const my = mean(y);
  const dx = x.map((v) => v - mx);
  const dy = y.map((v) => v - my);
  const cov = compensatedSum(dx.map((v, i) => v * (dy[i] as number)));
  const sx = Math.sqrt(compensatedSum(dx.map((v) => v * v)));
  const sy = Math.sqrt(compensatedSum(dy.map((v) => v * v)));
  if (sx === 0 || sy === 0) return null;
  const r = cov / (sx * sy);
  // Floating point can push a perfect correlation a hair past 1.
  return Math.min(1, Math.max(-1, r));
}

/**
 * Fractional ranks, ties averaged (the "midrank" convention Spearman
 * requires). Ranks are 1-based.
 */
export function rank(values: ReadonlyArray<number>): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => (a.value === b.value ? a.index - b.index : a.value - b.value));
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (
      j + 1 < indexed.length &&
      (indexed[j + 1] as { value: number }).value === (indexed[i] as { value: number }).value
    ) {
      j++;
    }
    const average = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[(indexed[k] as { index: number }).index] = average;
    i = j + 1;
  }
  return ranks;
}

/** Spearman's rho: Pearson's r computed on midranks, so it measures monotonicity. */
export function spearman(x: ReadonlyArray<number>, y: ReadonlyArray<number>): number | null {
  assertPaired(x, y);
  return pearson(rank(x), rank(y));
}

// --- regression ------------------------------------------------------------

export type Regression = {
  slope: number;
  intercept: number;
  /** Coefficient of determination, equal to Pearson's r squared for OLS. */
  r2: number;
  r: number;
  n: number;
  /** Residual standard error, sqrt(SSE/(n-2)); null when n=2 (no residual df). */
  residualStandardError: number | null;
};

/**
 * Ordinary least squares of y on x — the line that minimizes vertical
 * squared error. Not symmetric: regressing x on y gives a different line.
 */
export function linearRegression(x: ReadonlyArray<number>, y: ReadonlyArray<number>): Regression {
  assertPaired(x, y);
  const n = x.length;
  const mx = mean(x);
  const my = mean(y);
  const dx = x.map((v) => v - mx);
  const dy = y.map((v) => v - my);
  const sxx = compensatedSum(dx.map((v) => v * v));
  if (sxx === 0) {
    throw new StatsError("every x is the same value, so no line of best fit exists");
  }
  const sxy = compensatedSum(dx.map((v, i) => v * (dy[i] as number)));
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const syy = compensatedSum(dy.map((v) => v * v));
  const sse = compensatedSum(
    x.map((v, i) => {
      const residual = (y[i] as number) - (intercept + slope * v);
      return residual * residual;
    }),
  );
  const r2 = syy === 0 ? 1 : Math.min(1, Math.max(0, 1 - sse / syy));
  const r = syy === 0 ? 0 : Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
  return {
    slope,
    intercept,
    r2,
    r,
    n,
    residualStandardError: n > 2 ? Math.sqrt(sse / (n - 2)) : null,
  };
}

// --- histogram -------------------------------------------------------------

export type Bucket = { index: number; lo: number; hi: number; count: number; label: string };

export type Histogram = {
  buckets: Bucket[];
  bucketCount: number;
  bucketWidth: number;
  min: number;
  max: number;
  count: number;
  /** How bucket edges behave, stated because half-open vs closed changes counts. */
  intervals: string;
};

/**
 * Equal-width buckets over [min, max]. Every bucket is half-open [lo, hi)
 * EXCEPT the last, which is closed [lo, hi] so the maximum value lands
 * somewhere. That is the same rule NumPy's histogram uses.
 */
export function histogram(
  values: ReadonlyArray<number>,
  options: { bucketCount?: number; bucketWidth?: number; origin?: number },
): Histogram {
  assertNonEmpty(values);
  assertFinite(values);
  if (options.bucketCount !== undefined && options.bucketWidth !== undefined) {
    throw new StatsError("give either bucketCount or bucketWidth, not both");
  }
  // Infinity passes a `z.number()` schema, and an infinite origin or width makes
  // every bucket edge NaN — which used to index past the end of the bucket array
  // and throw a TypeError out of the tool instead of refusing.
  if (options.origin !== undefined && !Number.isFinite(options.origin)) {
    throw new StatsError(`origin is ${options.origin}; it must be a finite number`);
  }
  if (options.bucketWidth !== undefined && !Number.isFinite(options.bucketWidth)) {
    throw new StatsError(`bucketWidth is ${options.bucketWidth}; it must be a finite number`);
  }
  const sorted = sortedCopy(values);
  const min = sorted[0] as number;
  const max = sorted[sorted.length - 1] as number;
  let lo = options.origin ?? min;
  if (lo > min) {
    throw new StatsError(`origin ${lo} is above the smallest value ${min}`);
  }
  let count: number;
  let width: number;
  if (options.bucketWidth !== undefined) {
    if (!(options.bucketWidth > 0)) throw new StatsError("bucketWidth must be greater than 0");
    width = options.bucketWidth;
    count = Math.max(1, Math.ceil((max - lo) / width));
    if (max === lo) count = 1;
    if (count > 10_000) {
      throw new StatsError(
        `a width of ${width} over the range ${lo}..${max} needs ${count} buckets, over the 10000 limit`,
      );
    }
  } else {
    count = options.bucketCount ?? 10;
    if (!Number.isInteger(count) || count < 1 || count > 10_000) {
      throw new StatsError("bucketCount must be an integer between 1 and 10000");
    }
    if (max === lo) {
      // A constant series has no range to divide; one bucket holds everything.
      width = 1;
      count = 1;
    } else {
      width = (max - lo) / count;
    }
  }
  if (max === lo) lo = min;
  const buckets: Bucket[] = [];
  for (let i = 0; i < count; i++) {
    const bLo = lo + i * width;
    const bHi = i === count - 1 ? Math.max(lo + count * width, max) : lo + (i + 1) * width;
    buckets.push({
      index: i,
      lo: bLo,
      hi: bHi,
      count: 0,
      label: `[${bLo}, ${bHi}${i === count - 1 ? "]" : ")"}`,
    });
  }
  for (const v of sorted) {
    let index = width === 0 ? 0 : Math.floor((v - lo) / width);
    if (!Number.isFinite(index) || index >= count) index = count - 1;
    if (index < 0) index = 0;
    const bucket = buckets[index] as Bucket;
    bucket.count++;
  }
  return {
    buckets,
    bucketCount: count,
    bucketWidth: width,
    min,
    max,
    count: values.length,
    intervals: "every bucket is [lo, hi) except the last, which is [lo, hi]",
  };
}

// --- outliers --------------------------------------------------------------

export const OUTLIER_METHODS = ["zscore", "iqr"] as const;
export type OutlierMethod = (typeof OUTLIER_METHODS)[number];

export type Outlier = { index: number; value: number; score: number; side: "low" | "high" };

export type OutlierReport = {
  method: OutlierMethod;
  methodNote: string;
  threshold: number;
  outliers: Outlier[];
  bounds: { lower: number; upper: number };
  count: number;
  cleanCount: number;
  /**
   * What an empty `outliers` list does and does not mean. A rule that flags
   * nothing has found nothing BY THAT RULE at THAT THRESHOLD; it has not
   * established that the data is clean, and a caller reading `count: 0` as a
   * clean bill of health is the false confidence this field exists to deny.
   */
  finding: string;
};

/**
 * Flag outliers by one of two named rules:
 *
 *   - "zscore": |x - mean| / SAMPLE stdev > threshold (default 3). Assumes
 *     roughly normal data, and is itself distorted by the outliers it is
 *     looking for — with n small, no point can exceed (n-1)/sqrt(n).
 *   - "iqr": outside Q1 - k*IQR or Q3 + k*IQR (Tukey's fence, default
 *     k = 1.5, quartiles by the r7 convention). Robust, and what a box plot
 *     draws.
 *
 * The score reported is the z-score or the number of IQRs past the fence.
 */
export function findOutliers(
  values: ReadonlyArray<number>,
  method: OutlierMethod,
  threshold: number,
): OutlierReport {
  assertNonEmpty(values);
  assertFinite(values);
  if (!(threshold > 0)) throw new StatsError("threshold must be greater than 0");
  const outliers: Outlier[] = [];
  let bounds: { lower: number; upper: number };
  let note: string;
  if (method === "zscore") {
    if (values.length < 3) {
      throw new StatsError("the z-score rule needs at least 3 values to estimate a spread");
    }
    const m = mean(values);
    const s = stdev(values).sample;
    if (s === null || s === 0) {
      throw new StatsError("every value is identical, so no z-score is defined");
    }
    bounds = { lower: m - threshold * s, upper: m + threshold * s };
    note = `|x - mean| / sample stdev > ${threshold} (sample stdev divides by n-1)`;
    values.forEach((value, index) => {
      const score = (value - m) / s;
      if (Math.abs(score) > threshold) {
        outliers.push({ index, value, score, side: score < 0 ? "low" : "high" });
      }
    });
  } else {
    if (values.length < 4) {
      throw new StatsError("the IQR rule needs at least 4 values for meaningful quartiles");
    }
    const q = quartiles(sortedCopy(values), "r7");
    if (q.iqr === 0) {
      throw new StatsError(
        "the interquartile range is 0 (at least half the values are identical), so the IQR rule cannot separate outliers — use the zscore method instead",
      );
    }
    bounds = { lower: q.q1 - threshold * q.iqr, upper: q.q3 + threshold * q.iqr };
    note = `outside Q1 - ${threshold}*IQR or Q3 + ${threshold}*IQR (Tukey fence, quartiles by r7)`;
    values.forEach((value, index) => {
      if (value < bounds.lower) {
        outliers.push({
          index,
          value,
          score: (bounds.lower - value) / q.iqr,
          side: "low",
        });
      } else if (value > bounds.upper) {
        outliers.push({
          index,
          value,
          score: (value - bounds.upper) / q.iqr,
          side: "high",
        });
      }
    });
  }
  return {
    method,
    methodNote: note,
    threshold,
    outliers,
    bounds,
    count: outliers.length,
    cleanCount: values.length - outliers.length,
    finding:
      outliers.length === 0
        ? `no value fell outside the ${method} bounds at threshold ${threshold}. That is the absence of a flag under ONE rule, not evidence that the data is clean: this rule sees only single points far from the centre, and it cannot see a shifted distribution, a duplicated record, a wrong unit or a cluster of errors that moved the bounds along with the data.`
        : `${outliers.length} of ${values.length} values fell outside the ${method} bounds at threshold ${threshold}. A flag is a candidate for review, not a verdict: an extreme value can be perfectly correct.`,
  };
}
