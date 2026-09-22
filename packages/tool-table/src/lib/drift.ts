/**
 * Has the data moved since the baseline?
 *
 * Four things go wrong between yesterday's export and today's, and only one
 * of them is visible in a row count: the schema changes, a column's
 * distribution shifts, a column starts arriving empty, or a categorical
 * column grows a value nothing downstream has ever seen. This compares a
 * stored profile against today's and answers all four.
 *
 * THE RULE THAT MAKES ANY OF IT MEAN ANYTHING. A Population Stability Index
 * is a comparison of two histograms over the SAME bins, and the bins have to
 * be the reference's. Bin each side against its own quantiles and every
 * column comes back with ten bins of ten percent on both sides — PSI near
 * zero, however far the distribution actually moved. So the reference profile
 * carries its edges, the current data is binned against those stored edges,
 * and `compareDrift` REFUSES a column whose two sides were not binned
 * identically rather than returning the plausible number.
 *
 * The statistics come from `@crewhaus/tool-math`'s kernel, which is where
 * Mann-Whitney, PSI and the normal tail live for the whole repository. The
 * chi-square below is the one piece that was not already there.
 */
import { statsKernel } from "@crewhaus/tool-math";
import type {
  CategoricalDrift,
  ColumnProfile,
  ColumnType,
  NumericDrift,
  TableProfile,
} from "./profile";

/** A refusal: the data cannot answer the question asked of it. */
export class DriftError extends Error {
  override readonly name = "DriftError";
}

// --- chi-square -------------------------------------------------------------

/** Lanczos g=7, n=9. Good to ~15 significant figures for the x >= 0.5 we use. */
const LANCZOS = [
  0.999_999_999_999_809_93, 676.520_368_121_885_1, -1259.139_216_722_402_8, 771.323_428_777_653_13,
  -176.615_029_162_140_59, 12.507_343_278_686_905, -0.138_571_095_265_720_12,
  9.984_369_578_019_571_6e-6, 1.505_632_735_149_311_6e-7,
];

/**
 * ln Gamma(x) for x >= 0.5.
 *
 * The reflection formula for x < 0.5 is deliberately absent: the only caller
 * is `chiSquareUpperTail` with a = df/2 and df >= 1, so x is never below 0.5.
 * A branch with no caller is a branch with no test.
 */
function lnGamma(x: number): number {
  const z = x - 1;
  const t = z + 7.5;
  let a = LANCZOS[0] as number;
  for (let i = 1; i < LANCZOS.length; i++) a += (LANCZOS[i] as number) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Lentz's guard: whenever a denominator collapses to zero it is replaced by
 * this instead, so the recurrence carries on rather than producing Infinity.
 * Well above the denormal floor, so the reciprocal below stays exact.
 */
const FPMIN = 1e-300;
const ITERATIONS = 300;

/** Regularized lower incomplete gamma P(a, x) by its series. Converges fast for x < a+1. */
function gammaPSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let term = sum;
  for (let i = 0; i < ITERATIONS; i++) {
    ap += 1;
    term *= x / ap;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

/** Regularized upper incomplete gamma Q(a, x) by the modified Lentz continued fraction. */
function gammaQContinued(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITERATIONS; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/**
 * P(X > x) for a chi-square variate with `df` degrees of freedom — the upper
 * tail, which is the p-value of every chi-square test.
 *
 * This is Q(df/2, x/2) of the regularized incomplete gamma function, split at
 * `x < a + 1` between the series and the continued fraction because each one
 * loses its digits in the other's region (Press et al., *Numerical Recipes*,
 * §6.2). The kernel in `@crewhaus/tool-math` has the normal tail but not this
 * one; `lib.test.ts` cross-checks the df=1 case against that normal tail,
 * since Q(1/2, x/2) is exactly erfc(sqrt(x/2)) = 2 * P(Z > sqrt(x)).
 */
export function chiSquareUpperTail(x: number, df: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(df) || df < 1) {
    throw new DriftError(
      `chi-square tail needs a finite statistic and df >= 1, got x=${x} df=${df}`,
    );
  }
  if (x <= 0) return 1;
  const a = df / 2;
  const y = x / 2;
  return y < a + 1 ? 1 - gammaPSeries(a, y) : gammaQContinued(a, y);
}

export type ChiSquareResult = {
  readonly chiSquare: number;
  readonly df: number;
  /** `null` when the table has nothing to test — see `note`. */
  readonly p: number | null;
  readonly categories: number;
  /** Cells whose EXPECTED count is under 5, and under 1. Where it frays. */
  readonly cellsBelowFive: number;
  readonly cellsBelowOne: number;
  readonly cells: number;
  /** Cochran's condition: no expected cell under 1, at most a fifth under 5. */
  readonly approximationValid: boolean;
  readonly note: string;
};

/**
 * Chi-square test of homogeneity on the 2 x k table of (reference, current)
 * against category — "are these two samples drawn from the same distribution
 * over these labels?".
 *
 * A category present on only one side stays in the table. It is the single
 * most informative cell there is, and dropping it to avoid a zero is how a
 * column that gained a whole new value tests as unchanged.
 *
 * `approximationValid` is Cochran's rule, and it is NOT advisory: the
 * chi-square statistic's null distribution is only approximately chi-square,
 * and with a handful of rare categories the approximation is off by enough to
 * move a verdict. A caller gating on `p` should gate on this first.
 */
export function chiSquareHomogeneity(
  reference: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): ChiSquareResult {
  // A key recorded as zero on BOTH sides is dropped rather than counted: it
  // would make its column total zero, so both its expected counts would be
  // 0/0, and it would inflate df with a cell that holds no observation.
  const categories = [...new Set([...Object.keys(reference), ...Object.keys(current)])]
    .filter((key) => (reference[key] ?? 0) + (current[key] ?? 0) > 0)
    .sort();
  let referenceTotal = 0;
  let currentTotal = 0;
  for (const key of categories) {
    referenceTotal += reference[key] ?? 0;
    currentTotal += current[key] ?? 0;
  }
  const total = referenceTotal + currentTotal;
  const base = {
    categories: categories.length,
    cells: categories.length * 2,
    cellsBelowFive: 0,
    cellsBelowOne: 0,
    approximationValid: false,
  };
  if (referenceTotal === 0 || currentTotal === 0) {
    return {
      ...base,
      chiSquare: 0,
      df: Math.max(0, categories.length - 1),
      p: null,
      note: `one side has no observations (reference ${referenceTotal}, current ${currentTotal}); a test of homogeneity needs both`,
    };
  }
  if (categories.length < 2) {
    return {
      ...base,
      chiSquare: 0,
      df: 0,
      p: null,
      note:
        categories.length === 1
          ? `both sides hold only the value "${categories[0]}", so there is no distribution over labels to compare`
          : "neither side has any values",
    };
  }
  let chiSquare = 0;
  let cellsBelowFive = 0;
  let cellsBelowOne = 0;
  for (const key of categories) {
    const observedReference = reference[key] ?? 0;
    const observedCurrent = current[key] ?? 0;
    const columnTotal = observedReference + observedCurrent;
    // A column total of zero cannot occur: the key is in the union because at
    // least one side counted it. So neither expectation below is 0/0.
    const expectedReference = (referenceTotal * columnTotal) / total;
    const expectedCurrent = (currentTotal * columnTotal) / total;
    for (const [observed, expected] of [
      [observedReference, expectedReference],
      [observedCurrent, expectedCurrent],
    ] as const) {
      if (expected < 5) cellsBelowFive++;
      if (expected < 1) cellsBelowOne++;
      chiSquare += ((observed - expected) * (observed - expected)) / expected;
    }
  }
  const df = categories.length - 1;
  const cells = categories.length * 2;
  const approximationValid = cellsBelowOne === 0 && cellsBelowFive <= 0.2 * cells;
  return {
    chiSquare,
    df,
    p: chiSquareUpperTail(chiSquare, df),
    categories: categories.length,
    cells,
    cellsBelowFive,
    cellsBelowOne,
    approximationValid,
    note: approximationValid
      ? `chi-square ${chiSquare.toFixed(4)} on ${df} df over ${categories.length} categories; Cochran's condition holds`
      : `chi-square ${chiSquare.toFixed(4)} on ${df} df, but ${cellsBelowFive} of ${cells} expected cell counts are under 5 (${cellsBelowOne} under 1). The chi-square approximation is unreliable here — read p as a direction, not a rate, and pool the rare categories if you need a rate`,
  };
}

// --- the comparison ---------------------------------------------------------

export type DriftThresholds = {
  /** Fail when a column's PSI is at or above this. 0.25 is the usual line. */
  readonly psi?: number;
  /** Fail when a VALID distribution p is at or below this. */
  readonly pValue?: number;
  /** Fail when a column's null fraction rose by at least this much, absolute. */
  readonly nullRateIncrease?: number;
  /** Fail when distinct-count ratio leaves [1/r, r]. Must be >= 1. */
  readonly cardinalityRatio?: number;
  /** Fail when row-count ratio leaves [1/r, r]. Must be >= 1. */
  readonly rowCountRatio?: number;
  /** Fail when a column gains more than this many categories. */
  readonly newCategories?: number;
  /** Fail on any added, removed or retyped column. */
  readonly schemaDrift?: boolean;
};

export type DriftCompareOptions = {
  /**
   * The share substituted for a bin empty on one side. No default, here or
   * anywhere below: it decides the verdict. A reference bin that empties out
   * reads as PSI 0.466 at 1e-3, 0.218 at 1e-2 and 0.045 at 0.05 — significant,
   * moderate and stable, from one dataset. It belongs in the same config as
   * the threshold it is compared against.
   */
  readonly epsilon: number;
  readonly thresholds?: DriftThresholds;
  /** Return every PSI bin rather than the three heaviest contributors. */
  readonly includeBins?: boolean;
};

export type PsiReport = {
  readonly value: number | null;
  readonly band: "stable" | "moderate" | "significant" | null;
  readonly epsilon: number;
  /** True when a one-sided empty bin took the floor, i.e. PSI depends on it. */
  readonly epsilonApplied: boolean;
  /** Bins actually compared, INCLUDING the two out-of-range bins. */
  readonly binCount: number;
  /** Current values that fell outside the reference's range, by side. */
  readonly outOfRange: { readonly below: number; readonly above: number };
  readonly bins: ReadonlyArray<statsKernel.PsiBin>;
  readonly note: string;
};

export type ColumnDriftResult = {
  readonly column: string;
  readonly kind: "numeric" | "categorical" | "incomparable";
  readonly nulls: {
    readonly reference: number;
    readonly current: number;
    readonly increase: number;
  };
  readonly distinct: {
    readonly reference: number;
    readonly current: number;
    readonly ratio: number | null;
  };
  readonly psi: PsiReport | null;
  readonly mannWhitney: statsKernel.MannWhitneyResult | null;
  readonly chiSquare: ChiSquareResult | null;
  /** Categories in today's data and not the reference's. `null` = cannot say. */
  readonly newCategories: ReadonlyArray<string> | null;
  readonly droppedCategories: ReadonlyArray<string> | null;
  readonly notes: ReadonlyArray<string>;
};

export type SchemaDriftReport = {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly retyped: ReadonlyArray<{
    readonly column: string;
    readonly reference: ColumnType;
    readonly current: ColumnType;
  }>;
  /**
   * A column that flipped between being compared as numbers and as labels.
   * Worth separating from `retyped`: `integer` to `decimal` is a retype that
   * still compares fine, and numeric to categorical is one that cannot.
   */
  readonly kindChanged: ReadonlyArray<{
    readonly column: string;
    readonly reference: string;
    readonly current: string;
  }>;
};

export type DriftReport = {
  readonly rows: {
    readonly reference: number;
    readonly current: number;
    readonly ratio: number | null;
  };
  readonly schema: SchemaDriftReport;
  readonly columns: ReadonlyArray<ColumnDriftResult>;
  readonly gate: {
    readonly configured: boolean;
    readonly ok: boolean;
    readonly failures: ReadonlyArray<string>;
    /**
     * Configured thresholds that could not be evaluated at all — the column
     * produced no such measurement. `ok` is false while this is non-empty:
     * a gate that did not get to look is not a gate that passed.
     */
    readonly unchecked: ReadonlyArray<string>;
    readonly note: string;
  };
  readonly notes: ReadonlyArray<string>;
};

const isNumeric = (d: NumericDrift | CategoricalDrift | undefined): d is NumericDrift =>
  d?.kind === "numeric";
const isCategorical = (d: NumericDrift | CategoricalDrift | undefined): d is CategoricalDrift =>
  d?.kind === "categorical";

const ratio = (reference: number, current: number): number | null =>
  reference === 0 ? null : current / reference;

/**
 * What is wrong with a numeric capture's counts, or `null`.
 *
 * A stored profile is a file somebody may have edited, and the kernel's own
 * guards fire from inside the sum — "reference has 5 bins and current has 12"
 * with no column name attached. Catching it here buys the column name and the
 * word "hand-edited", which is what tells a reader where to look.
 */
function countsProblem(capture: NumericDrift, side: string): string | null {
  if (capture.counts.length !== Math.max(0, capture.edges.length - 1)) {
    return `the ${side} capture has ${capture.edges.length} bin edges but ${capture.counts.length} counts, so its bins no longer describe its data — it has been hand-edited`;
  }
  for (const count of [...capture.counts, capture.below, capture.above]) {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      return `the ${side} capture has a bin count of ${String(count)}, which is not a count — it has been hand-edited`;
    }
  }
  return null;
}

/** Edges match only if every one of them does. A near-match is not a match. */
function sameEdges(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  return a.length === b.length && a.every((edge, i) => edge === b[i]);
}

/**
 * PSI over the reference's stored bins and the current data's counts IN THOSE
 * SAME BINS, with out-of-range values kept as their own two bins.
 *
 * Out-of-range handling is fixed at the kernel's "separate-bins" rather than
 * exposed: a value beyond the reference's range is the loudest drift signal
 * there is, and clamping it into the end bin is precisely how a distribution
 * that walked off the edge of the chart reads as stable. Refusing outright
 * would turn the most informative case into an error.
 */
function psiFromCaptures(
  reference: NumericDrift,
  current: NumericDrift,
  epsilon: number,
): statsKernel.PsiResult {
  const referenceCounts = [reference.below, ...reference.counts, reference.above];
  const currentCounts = [current.below, ...current.counts, current.above];
  const edges = reference.edges;
  const last = edges.length - 1;
  const bounds: statsKernel.PsiBinBounds[] = [
    { lo: Number.NEGATIVE_INFINITY, hi: edges[0] as number },
  ];
  for (let i = 0; i < last; i++) {
    // The final edge-interval is closed, matching the kernel's `binCounts`.
    bounds.push({ lo: edges[i] as number, hi: edges[i + 1] as number, closed: i === last - 1 });
  }
  bounds.push({ lo: edges[last] as number, hi: Number.POSITIVE_INFINITY });
  return statsKernel.populationStabilityIndex(referenceCounts, currentCounts, { epsilon }, bounds);
}

/** The three bins that moved the index most, heaviest first. */
function topContributors(
  bins: ReadonlyArray<statsKernel.PsiBin>,
): ReadonlyArray<statsKernel.PsiBin> {
  return [...bins].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 3);
}

function compareNumeric(
  column: string,
  reference: NumericDrift,
  current: NumericDrift,
  options: DriftCompareOptions,
  notes: string[],
): { psi: PsiReport | null; mannWhitney: statsKernel.MannWhitneyResult | null } {
  let psi: PsiReport | null = null;
  const malformed = countsProblem(reference, "reference") ?? countsProblem(current, "today's");
  if (reference.unbinnable !== null) {
    notes.push(`no PSI for "${column}": the reference column ${reference.unbinnable}`);
  } else if (malformed !== null) {
    // Checked BEFORE the index is computed, not after: the kernel would throw
    // a length-mismatch from three frames down, naming bin counts and no
    // column, which is the error a reader cannot act on.
    notes.push(`no PSI for "${column}": ${malformed}`);
  } else if (!sameEdges(reference.edges, current.edges)) {
    // The whole point of storing edges. A PSI over two independently-derived
    // edge sets compares each side against its own quantiles and returns
    // roughly zero however far the data moved.
    notes.push(
      `no PSI for "${column}": today's data was binned against different edges than the reference (reference [${reference.edges.join(", ")}], current [${current.edges.join(", ")}]). PSI over mismatched bins is a number with no meaning`,
    );
  } else if (current.n === 0) {
    notes.push(`no PSI for "${column}": today's column has no values that parse as numbers`);
  } else {
    const result = psiFromCaptures(reference, current, options.epsilon);
    psi = {
      value: result.psi,
      band: result.band,
      epsilon: result.epsilon,
      epsilonApplied: result.epsilonApplied,
      binCount: result.bins.length,
      outOfRange: { below: current.below, above: current.above },
      bins: options.includeBins === true ? result.bins : topContributors(result.bins),
      note: result.note,
    };
  }
  if (current.unparsed > 0 || reference.unparsed > 0) {
    notes.push(
      `"${column}" holds values that do not parse as numbers (${reference.unparsed} in the reference, ${current.unparsed} today); every number above speaks only for the ones that do`,
    );
  }
  // Samples are checked here rather than left to the kernel for the same
  // reason as the counts above: its message says `sample1[3]`, which names
  // neither the column nor which of the two files it came from.
  const usable =
    reference.sample.every((v) => Number.isFinite(v)) &&
    current.sample.every((v) => Number.isFinite(v));
  const mannWhitney =
    !usable || reference.sample.length === 0 || current.sample.length === 0
      ? null
      : statsKernel.mannWhitneyU(reference.sample, current.sample);
  if (mannWhitney === null) {
    notes.push(
      usable
        ? `no rank test for "${column}": one side's value sample is empty`
        : `no rank test for "${column}": a stored value sample holds something that is not a finite number`,
    );
  } else {
    if (reference.sampled || current.sampled) {
      notes.push(
        `the rank test for "${column}" ran on samples (${reference.sample.length} of ${reference.n} reference values, ${current.sample.length} of ${current.n} today), so its p reflects the sample size, not the column's`,
      );
    }
    if (!mannWhitney.normalApproximationValid) {
      notes.push(`rank test for "${column}": ${mannWhitney.note}`);
    }
  }
  return { psi, mannWhitney };
}

function compareCategorical(
  column: string,
  reference: CategoricalDrift,
  current: CategoricalDrift,
  notes: string[],
): {
  chiSquare: ChiSquareResult | null;
  newCategories: ReadonlyArray<string> | null;
  droppedCategories: ReadonlyArray<string> | null;
} {
  // With a capped category list there is no way to tell a genuinely new value
  // from one that was always there and merely rare. Naming the wrong ones is
  // worse than naming none: "three new payment methods appeared" is acted on.
  if (reference.truncated || current.truncated) {
    const which = reference.truncated
      ? current.truncated
        ? "both sides"
        : "the reference"
      : "today's data";
    notes.push(
      `no category comparison for "${column}": ${which} had more distinct values than the capture's cap, so a value missing from the stored list may simply be one that did not make the cap. Re-profile with a higher maxCategories, or compare this column some other way`,
    );
    return { chiSquare: null, newCategories: null, droppedCategories: null };
  }
  const referenceKeys = new Set(Object.keys(reference.valueCounts));
  const currentKeys = new Set(Object.keys(current.valueCounts));
  const newCategories = [...currentKeys].filter((k) => !referenceKeys.has(k)).sort();
  const droppedCategories = [...referenceKeys].filter((k) => !currentKeys.has(k)).sort();
  const chiSquare = chiSquareHomogeneity(reference.valueCounts, current.valueCounts);
  if (chiSquare.p !== null && !chiSquare.approximationValid) notes.push(chiSquare.note);
  return { chiSquare, newCategories, droppedCategories };
}

/**
 * Compare a stored reference profile against today's.
 *
 * Both must carry a drift capture, and today's must have been captured
 * against the reference's edges — `profileTable`'s `drift.edges` option is
 * what does that. A column captured any other way is reported without a PSI
 * and with the reason, which is the only honest thing to return.
 */
export function compareDrift(
  reference: TableProfile,
  current: TableProfile,
  options: DriftCompareOptions,
): DriftReport {
  if (reference.driftCapture === undefined) {
    throw new DriftError(
      "the reference profile carries no drift capture: re-run TableProfile on the baseline with driftProfile true, which is what stores the bin edges this comparison needs",
    );
  }
  if (current.driftCapture === undefined) {
    throw new DriftError("today's profile carries no drift capture");
  }
  const notes: string[] = [];
  const referenceColumns = new Map(reference.columns.map((c) => [c.name, c]));
  const currentColumns = new Map(current.columns.map((c) => [c.name, c]));

  // A header that repeats. Those maps keep the LAST column of each name, so
  // both reference columns called "v" would be compared against today's
  // second "v" — and nothing downstream can tell: the edges match (today's
  // side was binned with them), so `sameEdges` passes, and two identical
  // files come back reporting that "s" gained two categories and lost two.
  // TableDiff reports a duplicate key rather than picking a row for exactly
  // this reason: there is no fact about which one became which.
  const duplicated = [
    ...new Set([...repeatedNames(reference.columns), ...repeatedNames(current.columns)]),
  ].sort();
  if (duplicated.length > 0) {
    notes.push(
      `no comparison for ${duplicated.map((n) => `"${n}"`).join(", ")}: that name is on more than one column, and a repeated header carries no fact about which column today corresponds to which column in the reference. Rename them upstream`,
    );
  }
  const repeated = new Set(duplicated);

  const added = current.columns.map((c) => c.name).filter((n) => !referenceColumns.has(n));
  const removed = reference.columns.map((c) => c.name).filter((n) => !currentColumns.has(n));
  const retyped: Array<{ column: string; reference: ColumnType; current: ColumnType }> = [];
  const kindChanged: Array<{ column: string; reference: string; current: string }> = [];

  const results: ColumnDriftResult[] = [];
  for (const referenceColumn of reference.columns) {
    if (repeated.has(referenceColumn.name)) continue;
    const currentColumn = currentColumns.get(referenceColumn.name);
    if (currentColumn === undefined) continue;
    if (referenceColumn.type !== currentColumn.type) {
      retyped.push({
        column: referenceColumn.name,
        reference: referenceColumn.type,
        current: currentColumn.type,
      });
    }
    results.push(compareColumn(referenceColumn, currentColumn, options, kindChanged));
  }

  const gate = evaluate(
    { reference: reference.rows, current: current.rows },
    { added, removed, retyped, duplicated },
    results,
    options.thresholds,
  );

  if (
    reference.driftCapture.nullTokens.join("\u0000") !==
    current.driftCapture.nullTokens.join("\u0000")
  ) {
    notes.push(
      "the two profiles were taken under different null-token lists, so every null-rate figure below is partly a difference between those lists rather than a difference in the data",
    );
  }
  if (reference.rows === 0 || current.rows === 0) {
    notes.push(
      `one side has no rows (reference ${reference.rows}, today ${current.rows}); nothing below is a measurement`,
    );
  }

  return {
    rows: {
      reference: reference.rows,
      current: current.rows,
      ratio: ratio(reference.rows, current.rows),
    },
    schema: { added, removed, retyped, kindChanged },
    columns: results,
    gate,
    notes,
  };
}

/** Names carried by more than one column, which is what makes them ambiguous. */
function repeatedNames(columns: ReadonlyArray<ColumnProfile>): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.name)) twice.add(column.name);
    seen.add(column.name);
  }
  return [...twice];
}

function compareColumn(
  referenceColumn: ColumnProfile,
  currentColumn: ColumnProfile,
  options: DriftCompareOptions,
  kindChanged: Array<{ column: string; reference: string; current: string }>,
): ColumnDriftResult {
  const column = referenceColumn.name;
  const notes: string[] = [];
  const shared = {
    column,
    nulls: {
      reference: referenceColumn.nullFraction,
      current: currentColumn.nullFraction,
      increase: currentColumn.nullFraction - referenceColumn.nullFraction,
    },
    distinct: {
      reference: referenceColumn.distinct,
      current: currentColumn.distinct,
      ratio: ratio(referenceColumn.distinct, currentColumn.distinct),
    },
  };
  const referenceDrift = referenceColumn.drift;
  const currentDrift = currentColumn.drift;

  if (isNumeric(referenceDrift) && isNumeric(currentDrift)) {
    const { psi, mannWhitney } = compareNumeric(
      column,
      referenceDrift,
      currentDrift,
      options,
      notes,
    );
    return {
      kind: "numeric",
      ...shared,
      psi,
      mannWhitney,
      chiSquare: null,
      newCategories: null,
      droppedCategories: null,
      notes,
    };
  }
  if (isCategorical(referenceDrift) && isCategorical(currentDrift)) {
    const { chiSquare, newCategories, droppedCategories } = compareCategorical(
      column,
      referenceDrift,
      currentDrift,
      notes,
    );
    return {
      kind: "categorical",
      ...shared,
      psi: null,
      mannWhitney: null,
      chiSquare,
      newCategories,
      droppedCategories,
      notes,
    };
  }
  // One side is numbers and the other labels, or a capture is missing. There
  // is no comparison to make: a distribution over numbers and a distribution
  // over strings do not live on the same axis, and forcing one produces a
  // statistic with no null hypothesis behind it.
  const referenceKind = referenceDrift?.kind ?? "absent";
  const currentKind = currentDrift?.kind ?? "absent";
  if (referenceKind !== currentKind) {
    kindChanged.push({ column, reference: referenceKind, current: currentKind });
    notes.push(
      `"${column}" is compared as ${referenceKind} in the reference and ${currentKind} today, so no distribution test applies. The null rate and cardinality below still do`,
    );
  } else {
    notes.push(
      `"${column}" has no drift capture on either side, so only its null rate and cardinality are compared`,
    );
  }
  return {
    kind: "incomparable",
    ...shared,
    psi: null,
    mannWhitney: null,
    chiSquare: null,
    newCategories: null,
    droppedCategories: null,
    notes,
  };
}

/** The note that says why a measurement is missing, so the gate can quote it. */
function why(notes: ReadonlyArray<string>, marker: string): string {
  return (
    notes.find((note) => note.includes(marker)) ?? "the comparison produced no such measurement"
  );
}

/**
 * Turn the measurements into a pass or a fail.
 *
 * Every gate is opt-in, and with none configured `ok` is true — which is why
 * it comes with a note saying so. "ok: true" reported for an unconfigured
 * gate reads as "nothing drifted" to anyone skimming, and it means "nothing
 * was checked".
 *
 * THE SAME MISTAKE ONE LEVEL DOWN, WHICH IS THE ONE THAT SHIPS. A configured
 * threshold whose measurement was REFUSED used to compare nothing, add
 * nothing to `failures`, and leave `ok` true under the note "every configured
 * threshold held". So the upstream feed that starts sending `amount` as
 * `"1,234.00"` — every value unparseable, the loudest possible break — takes
 * `failOn.psi` straight through green, because PSI was refused rather than
 * large. `rowCountRatio` already declined to pass a ratio it could not
 * compute; `unchecked` is that same stance for every other threshold, and
 * `ok` is false while it is non-empty. Fail closed: the gate did not look.
 */
function evaluate(
  rows: { reference: number; current: number },
  schema: {
    added: ReadonlyArray<string>;
    removed: ReadonlyArray<string>;
    retyped: ReadonlyArray<{ column: string }>;
    duplicated: ReadonlyArray<string>;
  },
  columns: ReadonlyArray<ColumnDriftResult>,
  thresholds: DriftThresholds | undefined,
): DriftReport["gate"] {
  const configured = thresholds !== undefined && Object.keys(thresholds).length > 0;
  if (!configured || thresholds === undefined) {
    return {
      configured: false,
      ok: true,
      failures: [],
      unchecked: [],
      note: "no failOn thresholds were given, so ok is true because nothing was checked — not because nothing drifted. Read the columns",
    };
  }
  const failures: string[] = [];
  const unchecked: string[] = [];
  const perColumn =
    thresholds.psi !== undefined ||
    thresholds.pValue !== undefined ||
    thresholds.nullRateIncrease !== undefined ||
    thresholds.cardinalityRatio !== undefined ||
    thresholds.newCategories !== undefined;
  if (perColumn) {
    // Neither ever reaches the per-column loop below: a column that is gone
    // gets no result, and an ambiguous one is excluded upstream. Without this
    // they are per-column thresholds that quietly measured no column at all.
    for (const name of schema.removed) {
      unchecked.push(
        `"${name}": no per-column threshold was checked — the column is in the reference and not in today's data`,
      );
    }
    for (const name of schema.duplicated) {
      unchecked.push(
        `"${name}": no per-column threshold was checked — more than one column carries that name`,
      );
    }
  }
  if (thresholds.schemaDrift === true) {
    for (const name of schema.added) failures.push(`column "${name}" is new`);
    for (const name of schema.removed) failures.push(`column "${name}" is gone`);
    for (const { column } of schema.retyped) failures.push(`column "${column}" changed type`);
  }
  if (thresholds.rowCountRatio !== undefined) {
    const r = ratio(rows.reference, rows.current);
    if (r === null) {
      unchecked.push(
        "the row-count threshold was not checked — the reference has no rows to take a ratio against",
      );
    } else if (r > thresholds.rowCountRatio || r < 1 / thresholds.rowCountRatio) {
      failures.push(
        `row count went ${rows.reference} to ${rows.current} (ratio ${r.toFixed(3)}), outside [${(1 / thresholds.rowCountRatio).toFixed(3)}, ${thresholds.rowCountRatio}]`,
      );
    }
  }
  for (const column of columns) {
    if (
      thresholds.psi !== undefined &&
      column.psi?.value != null &&
      column.psi.value >= thresholds.psi
    ) {
      failures.push(
        `"${column.column}" PSI ${column.psi.value.toFixed(4)} (${column.psi.band}) at or above ${thresholds.psi}${column.psi.epsilonApplied ? `, with the epsilon floor ${column.psi.epsilon} in the sum` : ""}`,
      );
    }
    if (thresholds.pValue !== undefined) {
      // A p from an approximation the kernel itself calls invalid is a rank
      // ordering, not a rate. Gating on it is a coin flip wearing a decimal
      // point, so an invalid p does not trip the gate — it is reported in the
      // column's notes instead.
      const mw = column.mannWhitney;
      if (mw?.p != null && mw.normalApproximationValid && mw.p <= thresholds.pValue) {
        failures.push(
          `"${column.column}" rank test p ${mw.p.toExponential(3)} at or below ${thresholds.pValue}`,
        );
      }
      const cs = column.chiSquare;
      if (cs?.p != null && cs.approximationValid && cs.p <= thresholds.pValue) {
        failures.push(
          `"${column.column}" chi-square p ${cs.p.toExponential(3)} at or below ${thresholds.pValue}`,
        );
      }
    }
    if (
      thresholds.nullRateIncrease !== undefined &&
      column.nulls.increase >= thresholds.nullRateIncrease
    ) {
      failures.push(
        `"${column.column}" null rate rose from ${(column.nulls.reference * 100).toFixed(1)}% to ${(column.nulls.current * 100).toFixed(1)}%`,
      );
    }
    if (thresholds.cardinalityRatio !== undefined) {
      const r = column.distinct.ratio;
      if (r !== null && (r > thresholds.cardinalityRatio || r < 1 / thresholds.cardinalityRatio)) {
        failures.push(
          `"${column.column}" distinct count went ${column.distinct.reference} to ${column.distinct.current} (ratio ${r.toFixed(3)})`,
        );
      }
    }
    if (
      thresholds.newCategories !== undefined &&
      column.newCategories !== null &&
      column.newCategories.length > thresholds.newCategories
    ) {
      failures.push(
        `"${column.column}" gained ${column.newCategories.length} categories: ${column.newCategories.slice(0, 10).join(", ")}`,
      );
    }
    // A threshold is "unchecked" only where the column's KIND says the
    // measurement should have existed. A PSI for a column of labels was never
    // going to exist and is not a gap; a PSI for a numeric column that came
    // back refused is exactly the gap this list is for.
    if (
      thresholds.psi !== undefined &&
      column.kind !== "categorical" &&
      column.psi?.value == null
    ) {
      unchecked.push(
        `"${column.column}": the PSI threshold ${thresholds.psi} was not checked — ${why(column.notes, "no PSI for")}`,
      );
    }
    if (thresholds.pValue !== undefined) {
      const mw = column.mannWhitney;
      const cs = column.chiSquare;
      if (column.kind === "numeric" && (mw?.p == null || !mw.normalApproximationValid)) {
        unchecked.push(
          `"${column.column}": the p-value threshold ${thresholds.pValue} was not checked against the rank test — ${mw?.p == null ? why(column.notes, "no rank test for") : mw.note}`,
        );
      } else if (column.kind === "categorical" && (cs?.p == null || !cs.approximationValid)) {
        unchecked.push(
          `"${column.column}": the p-value threshold ${thresholds.pValue} was not checked against the chi-square — ${cs?.note ?? why(column.notes, "no category comparison for")}`,
        );
      } else if (column.kind === "incomparable") {
        unchecked.push(
          `"${column.column}": the p-value threshold ${thresholds.pValue} was not checked — ${why(column.notes, column.column)}`,
        );
      }
    }
    if (
      thresholds.newCategories !== undefined &&
      column.kind === "categorical" &&
      column.newCategories === null
    ) {
      unchecked.push(
        `"${column.column}": the new-category threshold ${thresholds.newCategories} was not checked — ${why(column.notes, "no category comparison for")}`,
      );
    }
    if (thresholds.cardinalityRatio !== undefined && column.distinct.ratio === null) {
      unchecked.push(
        `"${column.column}": the cardinality threshold ${thresholds.cardinalityRatio} was not checked — the reference column had no distinct values to take a ratio against`,
      );
    }
  }
  const held = failures.length === 0 && unchecked.length === 0;
  return {
    configured: true,
    ok: held,
    failures,
    unchecked,
    note: held
      ? "every configured threshold held"
      : [
          failures.length > 0 ? `${failures.length} configured threshold(s) tripped` : "",
          unchecked.length > 0
            ? `${unchecked.length} configured threshold(s) could not be checked at all, which is not the same as holding — ok is false because the gate never got to look`
            : "",
        ]
          .filter((part) => part !== "")
          .join("; "),
  };
}
