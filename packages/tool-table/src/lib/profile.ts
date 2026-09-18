/**
 * What is actually in this file.
 *
 * The first question about any export is always the same — how many rows,
 * which columns, what types, how many nulls, is the key unique — and the
 * usual way to answer it is to read the first fifty rows into a context
 * window and guess from those. Fifty rows do not tell you that column 9 is
 * empty in the last thousand, or that the id repeats.
 */

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

export type ProfileOptions = {
  /** Values treated as null in addition to the empty string. */
  readonly nullTokens?: ReadonlyArray<string>;
  readonly topValues?: number;
  readonly samples?: number;
};

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

  const columns = headers.map((name, index) => {
    const counts = new Map<string, number>();
    const typeCounts: Record<string, number> = {};
    let nulls = 0;
    let minLength = Number.POSITIVE_INFINITY;
    let maxLength = 0;
    let min: number | null = null;
    let max: number | null = null;
    const samples: string[] = [];

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

    const top = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
      .slice(0, topLimit);

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
  };
}
