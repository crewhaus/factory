/**
 * What is actually in this file.
 *
 * The first question about any export is always the same — how many rows,
 * which columns, what types, how many nulls, is the key unique — and the
 * usual way to answer it is to read the first fifty rows into a context
 * window and guess from those. Fifty rows do not tell you that column 9 is
 * empty in the last thousand, or that the id repeats.
 *
 * A profile can also be asked to carry a DRIFT CAPTURE: the bin edges, bin
 * counts, category counts and a value sample that a later comparison needs.
 * Those are opt-in because they are machine fodder, not an answer a person
 * reads — but they have to be captured HERE, when the data is in hand.
 * Re-deriving bin edges from tomorrow's data is the specific mistake that
 * makes a Population Stability Index look fine and mean nothing: each side
 * then gets binned against its own quantiles, and the index reads near zero
 * no matter how far the distribution moved.
 */
import { statsKernel } from "@crewhaus/tool-math";

export const COLUMN_TYPES = [
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "string",
  "empty",
  "mixed",
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/**
 * The drift capture for a column compared as a distribution of numbers.
 *
 * `edges` is the whole reason this type exists. They are the REFERENCE's
 * quantile edges, and a comparison must re-use them for the current data —
 * see the module note. `counts` is over the full column; `sample` is a
 * bounded, seeded reservoir, because a rank test needs values and a profile
 * cannot carry two million of them.
 */
export type NumericDrift = {
  readonly kind: "numeric";
  /** Non-null cells that parsed as a finite number. */
  readonly n: number;
  /** Non-null cells that did NOT — the fraction this capture cannot speak for. */
  readonly unparsed: number;
  /** Strictly increasing, spanning [min, max]. Empty when `unbinnable`. */
  readonly edges: ReadonlyArray<number>;
  /** One count per interval between consecutive edges. Sums to `n`. */
  readonly counts: ReadonlyArray<number>;
  /**
   * Zero by construction here, since the edges come from this very column.
   * Carried anyway so the shape matches what the current side produces, and
   * so a hand-edited profile whose edges no longer fit its counts is visible.
   */
  readonly below: number;
  readonly above: number;
  /** A seeded reservoir of the column's numeric values, ascending. */
  readonly sample: ReadonlyArray<number>;
  /** True when the reservoir had to drop values, i.e. `sample.length < n`. */
  readonly sampled: boolean;
  /** Why no edges exist — a constant or empty column — or `null`. */
  readonly unbinnable: string | null;
};

/**
 * The drift capture for a column compared as a set of labels.
 *
 * `truncated` is load-bearing: with a capped list there is no way to tell a
 * genuinely new category from one that was always there and merely rare, so a
 * comparison must refuse to name new categories rather than name the wrong
 * ones.
 */
export type CategoricalDrift = {
  readonly kind: "categorical";
  /** Non-null cells. */
  readonly counted: number;
  readonly distinct: number;
  /** The commonest values and their counts. Capped. */
  readonly valueCounts: Readonly<Record<string, number>>;
  readonly truncated: boolean;
  /** Cells whose value did not make the cap. */
  readonly otherCount: number;
};

export type ColumnDrift = NumericDrift | CategoricalDrift;

/** The settings a drift capture was taken under, echoed so it is checkable. */
export type DriftCaptureHeader = {
  readonly version: 1;
  readonly binsRequested: number;
  readonly maxCategories: number;
  readonly sampleSize: number;
  readonly seed: number;
  /**
   * The null tokens in force. A comparison MUST profile the current data with
   * this same list: otherwise a null-rate jump measures the difference between
   * two token lists rather than a difference in the data.
   */
  readonly nullTokens: ReadonlyArray<string>;
};

export type ColumnProfile = {
  readonly name: string;
  readonly type: ColumnType;
  /** Every type seen, with counts, so `mixed` is explicable. */
  readonly types: Readonly<Record<string, number>>;
  readonly nulls: number;
  readonly nullFraction: number;
  readonly distinct: number;
  /** True when every non-null value is distinct — a candidate key. */
  readonly unique: boolean;
  readonly minLength: number;
  readonly maxLength: number;
  /** For numeric columns only. */
  readonly min: number | null;
  readonly max: number | null;
  /** The commonest values, heaviest first. Capped. */
  readonly top: ReadonlyArray<{ readonly value: string; readonly count: number }>;
  /** A few real values, for a reader who wants to see the shape. */
  readonly samples: ReadonlyArray<string>;
  /** Present only when a drift capture was asked for; see `ProfileOptions`. */
  readonly drift?: ColumnDrift;
};

export type TableProfile = {
  readonly rows: number;
  readonly columns: ReadonlyArray<ColumnProfile>;
  /** Columns whose values are unique across every row — candidate keys. */
  readonly candidateKeys: ReadonlyArray<string>;
  /** Rows identical to an earlier row, across every column. */
  readonly duplicateRows: number;
  readonly emptyColumns: ReadonlyArray<string>;
  readonly constantColumns: ReadonlyArray<string>;
  /** Present only when a drift capture was asked for. */
  readonly driftCapture?: DriftCaptureHeader;
};

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d*\.\d+(?:[eE][+-]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?/;
const BOOLEAN = /^(?:true|false|yes|no|y|n|t|f|0|1)$/i;

/**
 * Classify one cell.
 *
 * `0` and `1` are reported as integers rather than booleans: a column of
 * counts would otherwise be called boolean, and calling a quantity a flag is
 * a worse error than the reverse. A column whose values are all `0`/`1` is
 * visible in `top` either way.
 */
export function classifyCell(raw: string): ColumnType {
  const text = raw.trim();
  if (text === "") return "empty";
  if (INTEGER.test(text)) return "integer";
  if (DECIMAL.test(text)) return "decimal";
  if (DATETIME.test(text)) return "datetime";
  if (DATE.test(text)) return "date";
  if (BOOLEAN.test(text)) return "boolean";
  return "string";
}

export type DriftCaptureOptions = {
  /** Quantile bins to cut the reference into. Default 10. */
  readonly bins?: number;
  /** Cap on the category list. Default 128. */
  readonly maxCategories?: number;
  /** Cap on the reservoir of numeric values. Default 500. */
  readonly sampleSize?: number;
  /** Seeds the reservoir, so the same file always yields the same sample. */
  readonly seed?: number;
  /**
   * Bin these columns against these edges instead of deriving fresh ones.
   *
   * This is how the current side of a drift check gets binned: with the
   * REFERENCE's stored edges, which is the only binning under which a
   * Population Stability Index means anything. A column named here whose
   * edges are not strictly increasing is a caller error and throws.
   */
  readonly edges?: Readonly<Record<string, ReadonlyArray<number>>>;
};

export const DRIFT_CAPTURE_DEFAULTS = Object.freeze({
  bins: 10,
  maxCategories: 128,
  sampleSize: 500,
  /** Arbitrary, fixed, and stated: a seed nobody can see is not reproducible. */
  seed: 1_337,
});

export type ProfileOptions = {
  /** Values treated as null in addition to the empty string. */
  readonly nullTokens?: ReadonlyArray<string>;
  readonly topValues?: number;
  readonly samples?: number;
  /**
   * Capture what a later drift comparison needs. Off by default: the edges,
   * counts and value sample are for a machine, and putting a 500-value
   * reservoir in every profile makes the answer a person asked for worse.
   */
  readonly drift?: DriftCaptureOptions;
};

/**
 * A small, fast, seeded PRNG (Tommy Ettinger's mulberry32). It is here so the
 * reservoir below is reproducible: `Math.random` would make two profiles of
 * the same unchanged file disagree, and a drift check against a moving
 * baseline reports drift that is its own sampling noise.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Vitter's Algorithm R: every value has the same chance of ending up in the
 * reservoir, whatever the length of the column.
 *
 * Taking the FIRST k values instead would be simpler and deterministic too,
 * and would also be wrong on every export that arrives sorted by date or id —
 * which is most of them. The first 500 rows of a sorted file are a sample of
 * January, not of the year.
 */
export function reservoirSample(
  values: ReadonlyArray<number>,
  size: number,
  seed: number,
): number[] {
  if (size <= 0) return [];
  // Always ascending, whether or not anything was dropped: a stored sample is
  // an artifact somebody diffs against last week's, and row order is not a
  // fact about the data.
  if (values.length <= size) return [...values].sort((a, b) => a - b);
  const random = mulberry32(seed);
  const reservoir = values.slice(0, size);
  for (let i = size; i < values.length; i++) {
    const j = Math.floor(random() * (i + 1));
    if (j < size) reservoir[j] = values[i] as number;
  }
  return reservoir.sort((a, b) => a - b);
}

/**
 * Quantile bin edges over `values`, strictly increasing.
 *
 * Quantile edges rather than equal-width ones: equal-width bins on a skewed
 * column put 99% of the reference in one bin and near-nothing in the rest, and
 * PSI over near-empty reference bins is mostly noise. Equal-frequency bins
 * give every reference bin the same weight, which is the shape the standard
 * 0.1/0.25 bands were calibrated against.
 *
 * Ties collapse edges — a column that is 60% zeros has several identical
 * quantiles — so duplicates are dropped and the SURVIVING count is reported.
 * Silently keeping a zero-width bin would be worse: nothing can ever land in
 * one under the half-open rule, so it would contribute an epsilon-against-
 * epsilon term to every comparison forever.
 */
export function quantileEdges(values: ReadonlyArray<number>, bins: number): number[] {
  if (values.length === 0 || bins < 1) return [];
  const edges: number[] = [];
  for (let i = 0; i <= bins; i++) {
    const q = statsKernel.quantile(values, i / bins);
    if (q === null) return [];
    if (edges.length === 0 || q > (edges[edges.length - 1] as number)) edges.push(q);
  }
  return edges.length >= 2 ? edges : [];
}

export function profileTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  options: ProfileOptions = {},
): TableProfile {
  const nullTokens = new Set(
    (options.nullTokens ?? ["NULL", "null", "NA", "N/A", "-"]).map((t) => t.trim()),
  );
  const topLimit = options.topValues ?? 5;
  const sampleLimit = options.samples ?? 3;
  const capture = options.drift;
  const bins = capture?.bins ?? DRIFT_CAPTURE_DEFAULTS.bins;
  const maxCategories = capture?.maxCategories ?? DRIFT_CAPTURE_DEFAULTS.maxCategories;
  const sampleSize = capture?.sampleSize ?? DRIFT_CAPTURE_DEFAULTS.sampleSize;
  const seed = capture?.seed ?? DRIFT_CAPTURE_DEFAULTS.seed;

  const columns = headers.map((name, index) => {
    const counts = new Map<string, number>();
    const typeCounts: Record<string, number> = {};
    let nulls = 0;
    let minLength = Number.POSITIVE_INFINITY;
    let maxLength = 0;
    let min: number | null = null;
    let max: number | null = null;
    const samples: string[] = [];
    // Filled only when a capture was asked for, and held for the duration of
    // this ONE column — which is why the capture is built inside the map
    // rather than after it. Twenty numeric columns of two million rows would
    // otherwise all be resident at once.
    const numericValues: number[] = [];

    for (const row of rows) {
      const raw = (row[index] ?? "").trim();
      const isNull = raw === "" || nullTokens.has(raw);
      if (isNull) {
        nulls++;
        typeCounts["empty"] = (typeCounts["empty"] ?? 0) + 1;
        continue;
      }
      const type = classifyCell(raw);
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
      minLength = Math.min(minLength, raw.length);
      maxLength = Math.max(maxLength, raw.length);
      if (type === "integer" || type === "decimal") {
        const value = Number(raw);
        if (Number.isFinite(value)) {
          min = min === null ? value : Math.min(min, value);
          max = max === null ? value : Math.max(max, value);
          if (capture !== undefined) numericValues.push(value);
        }
      }
      if (samples.length < sampleLimit) samples.push(raw);
    }

    const present = Object.entries(typeCounts).filter(([t]) => t !== "empty");
    const type: ColumnType =
      present.length === 0
        ? "empty"
        : present.length === 1
          ? (present[0]?.[0] as ColumnType)
          : "mixed";

    const ordered = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
    const top = ordered.slice(0, topLimit);

    const drift =
      capture === undefined
        ? undefined
        : captureColumn(numericValues, ordered, rows.length - nulls, {
            bins,
            maxCategories,
            sampleSize,
            seed,
            // Own properties only: a column named "__proto__" otherwise reads
            // back `Object.prototype`, which is not undefined, so the column is
            // forced down the numeric path with a non-array "edges" whose
            // `length` is undefined — `binCounts` then builds `new Array(NaN)`
            // and dies with a RangeError naming nothing.
            suppliedEdges:
              capture.edges !== undefined && Object.hasOwn(capture.edges, name)
                ? capture.edges[name]
                : undefined,
          });

    return {
      name,
      type,
      types: typeCounts,
      nulls,
      nullFraction: rows.length === 0 ? 0 : nulls / rows.length,
      distinct: counts.size,
      // A column with one non-null value is technically unique; requiring
      // more than one stops a nearly-empty column being offered as a key.
      unique: counts.size > 1 && counts.size === rows.length - nulls,
      minLength: minLength === Number.POSITIVE_INFINITY ? 0 : minLength,
      maxLength,
      min,
      max,
      top,
      samples,
      ...(drift === undefined ? {} : { drift }),
    };
  });

  const seen = new Set<string>();
  let duplicateRows = 0;
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) duplicateRows++;
    else seen.add(key);
  }

  return {
    rows: rows.length,
    columns,
    candidateKeys: columns.filter((c) => c.unique && c.nulls === 0).map((c) => c.name),
    duplicateRows,
    emptyColumns: columns.filter((c) => c.type === "empty").map((c) => c.name),
    constantColumns: columns.filter((c) => c.distinct === 1 && c.nulls === 0).map((c) => c.name),
    ...(capture === undefined
      ? {}
      : {
          driftCapture: {
            version: 1 as const,
            binsRequested: bins,
            maxCategories,
            sampleSize,
            seed,
            nullTokens: [...nullTokens],
          },
        }),
  };
}

/**
 * Decide how a column should be compared, and capture what that comparison
 * needs.
 *
 * A column is compared as NUMBERS when at least half its non-null cells parse
 * as one. The alternative — treating a numeric column with a few stray
 * "n/a"-style strings as categorical — turns every distinct number into its
 * own category, so a column of prices reads as tens of thousands of
 * categories and invents cardinality drift out of arithmetic. A tie goes to
 * numeric, and `unparsed` names exactly how much of the column the numeric
 * capture does not speak for.
 */
function captureColumn(
  numericValues: ReadonlyArray<number>,
  ordered: ReadonlyArray<{ value: string; count: number }>,
  nonNull: number,
  settings: {
    bins: number;
    maxCategories: number;
    sampleSize: number;
    seed: number;
    suppliedEdges?: ReadonlyArray<number> | undefined;
  },
): ColumnDrift {
  // Supplied edges force the numeric path even for a column that today is
  // mostly unparseable text. The reference said this column is numbers; a bad
  // day for the data should surface as `unparsed` and an out-of-range count,
  // not as the column quietly switching axes and losing its comparison.
  const numericByShare = nonNull > 0 && numericValues.length * 2 >= nonNull;
  if (numericByShare || settings.suppliedEdges !== undefined) {
    const edges = settings.suppliedEdges ?? quantileEdges(numericValues, settings.bins);
    const sample = reservoirSample(numericValues, settings.sampleSize, settings.seed);
    if (edges.length < 2) {
      return {
        kind: "numeric",
        n: numericValues.length,
        unparsed: nonNull - numericValues.length,
        edges: [],
        counts: [],
        below: 0,
        above: 0,
        sample,
        sampled: sample.length < numericValues.length,
        unbinnable:
          numericValues.length === 0
            ? "holds no values that parse as numbers, so there is nothing to bin"
            : `is constant at ${numericValues[0]}, so every quantile lands on the same edge and there is nothing to cut into bins`,
      };
    }
    const binned = statsKernel.binCounts(numericValues, edges);
    return {
      kind: "numeric",
      n: numericValues.length,
      unparsed: nonNull - numericValues.length,
      edges,
      counts: binned.counts,
      below: binned.belowFirstEdge,
      above: binned.aboveLastEdge,
      sample,
      sampled: sample.length < numericValues.length,
      unbinnable: null,
    };
  }
  const kept = ordered.slice(0, settings.maxCategories);
  // A null prototype, not `{}`. These keys are CELL VALUES, and a cell holding
  // the string "__proto__" assigns to Object.prototype's accessor on a plain
  // object: the entry is silently dropped, `truncated` still says false and
  // `otherCount` still says zero, so the capture claims a complete category
  // list that is missing a category — and a value arriving for the first time
  // today is never named as new. A null prototype makes it an ordinary key,
  // and `JSON.stringify`/`JSON.parse` round-trip it intact.
  const valueCounts: Record<string, number> = Object.create(null);
  for (const { value, count } of kept) valueCounts[value] = count;
  let keptTotal = 0;
  for (const { count } of kept) keptTotal += count;
  return {
    kind: "categorical",
    counted: nonNull,
    distinct: ordered.length,
    valueCounts,
    truncated: ordered.length > kept.length,
    otherCount: nonNull - keptTotal,
  };
}
