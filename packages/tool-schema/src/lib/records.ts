/**
 * Row-shaped validation: the same checks as the single-value path, but
 * reported the way a data-quality gate needs them — per row, with a summary
 * that a pipeline can branch on without reading the detail.
 *
 * The three questions this file answers are the three that stop a bad batch:
 * does every row match the schema, is the key actually unique, and does every
 * foreign key point at something that exists.
 */
import { type Schema, type ValidationError, validateValue } from "./jsonschema";
import { canonicalize, getPath, isPlainObject, preview, typeOf } from "./value";

/** Joins a path and a keyword into one map key; a character no path contains. */
const ISSUE_SEPARATOR = String.fromCharCode(0);

export type RowFailure = {
  /** 0-based index of the row in the input array. */
  row: number;
  /** The row's value at `idField`, when one was given — for a human reading the report. */
  id: string | null;
  errors: ValidationError[];
};

export type RecordsReport = {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  /** Failures, capped at `maxFailedRows`. */
  failures: RowFailure[];
  /** True when the failure list was cut short; `failed` is still the true count. */
  truncated: boolean;
  /** How many rows failed on each keyword+path pair, worst first. */
  topIssues: Array<{ path: string; keyword: string; rows: number; example: string }>;
  unsupportedKeywords: string[];
};

export type ValidateRecordsOptions = {
  assertFormat: boolean;
  /** Errors kept per row. */
  maxErrorsPerRow: number;
  /** Failing rows detailed in the report. */
  maxFailedRows: number;
  /** A field whose value identifies the row in the report. */
  idField: string | null;
};

export const DEFAULT_RECORDS_OPTIONS: ValidateRecordsOptions = {
  assertFormat: false,
  maxErrorsPerRow: 10,
  maxFailedRows: 50,
  idField: null,
};

function rowId(row: unknown, idField: string | null): string | null {
  if (idField === null) return null;
  try {
    const found = getPath(row, idField);
    return found.found ? preview(found.value, 60) : null;
  } catch {
    return null;
  }
}

/**
 * Validate every row against one schema. The summary is the point: a caller
 * gates on `ok` or on `failed`, and only reads `failures` when it has to.
 * `topIssues` groups failures by what went wrong rather than by which row,
 * which is how a broken feed is usually diagnosed — one field, every row.
 */
export function validateRecords(
  rows: unknown[],
  schema: Schema,
  options: Partial<ValidateRecordsOptions> = {},
): RecordsReport {
  const opts: ValidateRecordsOptions = { ...DEFAULT_RECORDS_OPTIONS, ...options };
  const failures: RowFailure[] = [];
  const issues = new Map<
    string,
    { path: string; keyword: string; rows: number; example: string }
  >();
  const unsupported = new Set<string>();
  let failed = 0;

  rows.forEach((row, index) => {
    const result = validateValue(row, schema, {
      assertFormat: opts.assertFormat,
      maxErrors: opts.maxErrorsPerRow,
    });
    for (const keyword of result.unsupportedKeywords) unsupported.add(keyword);
    if (result.valid) return;
    failed += 1;
    if (failures.length < opts.maxFailedRows) {
      failures.push({ row: index, id: rowId(row, opts.idField), errors: result.errors });
    }
    // Count each (path, keyword) pair once per row, not once per error.
    const seen = new Set<string>();
    for (const error of result.errors) {
      const key = `${error.path}${ISSUE_SEPARATOR}${error.keyword}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = issues.get(key);
      if (existing === undefined) {
        issues.set(key, {
          path: error.path,
          keyword: error.keyword,
          rows: 1,
          example: error.message,
        });
      } else {
        existing.rows += 1;
      }
    }
  });

  // Ordered by code unit rather than with `localeCompare`, which reads the
  // runtime's default locale — an environment read, and the one thing that
  // could make this package answer differently on two machines.
  const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const topIssues = [...issues.values()].sort(
    (a, b) => b.rows - a.rows || byCodeUnit(a.path, b.path) || byCodeUnit(a.keyword, b.keyword),
  );

  return {
    ok: failed === 0,
    total: rows.length,
    passed: rows.length - failed,
    failed,
    failures,
    truncated: failed > failures.length,
    topIssues,
    unsupportedKeywords: [...unsupported].sort(),
  };
}

export type DuplicateGroup = { key: string; rows: number[] };

export type DuplicateReport = {
  ok: boolean;
  total: number;
  /** Rows skipped because they are not objects or lack one of the key fields. */
  unkeyed: Array<{ row: number; reason: string }>;
  distinctKeys: number;
  duplicates: DuplicateGroup[];
  truncated: boolean;
};

/**
 * Find rows that share a key. The key may be several fields, in which case
 * their values are combined — the composite-key case a real uniqueness
 * constraint usually is.
 *
 * Values are compared canonically, so `{a: 1, b: 2}` and `{b: 2, a: 1}` are
 * the same key. With `caseInsensitive`, string values are lowercased first,
 * which is what an email or username constraint normally means.
 */
export function findDuplicates(
  rows: unknown[],
  keyFields: string[],
  options: { caseInsensitive?: boolean; maxGroups?: number } = {},
): DuplicateReport {
  const caseInsensitive = options.caseInsensitive ?? false;
  const maxGroups = options.maxGroups ?? 50;
  const buckets = new Map<string, number[]>();
  const unkeyed: Array<{ row: number; reason: string }> = [];

  rows.forEach((row, index) => {
    if (!isPlainObject(row)) {
      unkeyed.push({ row: index, reason: `row is a ${typeOf(row)}, not an object` });
      return;
    }
    const parts: unknown[] = [];
    for (const field of keyFields) {
      let resolution: ReturnType<typeof getPath>;
      try {
        resolution = getPath(row, field);
      } catch (err) {
        unkeyed.push({ row: index, reason: `bad path "${field}": ${(err as Error).message}` });
        return;
      }
      if (!resolution.found) {
        unkeyed.push({ row: index, reason: `no value at "${field}"` });
        return;
      }
      const value = resolution.value;
      parts.push(caseInsensitive && typeof value === "string" ? value.toLowerCase() : value);
    }
    const key = canonicalize(parts);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [index]);
    else bucket.push(index);
  });

  const all: DuplicateGroup[] = [];
  for (const [key, indices] of buckets) {
    if (indices.length > 1) all.push({ key, rows: indices });
  }
  all.sort((a, b) => b.rows.length - a.rows.length || (a.rows[0] ?? 0) - (b.rows[0] ?? 0));

  return {
    ok: all.length === 0 && unkeyed.length === 0,
    total: rows.length,
    unkeyed,
    distinctKeys: buckets.size,
    duplicates: all.slice(0, maxGroups),
    truncated: all.length > maxGroups,
  };
}

export type ReferenceReport = {
  ok: boolean;
  total: number;
  checked: number;
  /** Rows whose reference resolves to nothing in the allowed set. */
  dangling: Array<{ row: number; value: string; reason: string }>;
  /** Allowed values no row referred to — usually fine, sometimes the real finding. */
  unreferenced: string[];
  truncated: boolean;
};

/**
 * Check that every row's reference field points at a value that exists.
 *
 * The allowed set is given either directly as values or as the values of a
 * field in a parent array, which is the shape a join actually has. A row
 * whose reference field is missing is reported unless `allowMissing` is set,
 * because an absent foreign key and a broken one are different findings and
 * the caller should say which one is acceptable.
 */
export function checkReferences(
  rows: unknown[],
  field: string,
  allowed: unknown[],
  options: { allowMissing?: boolean; reportUnreferenced?: boolean; maxDangling?: number } = {},
): ReferenceReport {
  const allowMissing = options.allowMissing ?? false;
  const maxDangling = options.maxDangling ?? 50;
  // Keyed canonically, but the original value is kept so the report can show
  // `"eu-west-1"` rather than its canonical encoding.
  const allowedByKey = new Map<string, unknown>();
  for (const value of allowed) allowedByKey.set(canonicalize(value), value);
  const used = new Set<string>();
  const dangling: Array<{ row: number; value: string; reason: string }> = [];
  let checked = 0;

  rows.forEach((row, index) => {
    let resolution: ReturnType<typeof getPath>;
    try {
      resolution = getPath(row, field);
    } catch (err) {
      dangling.push({ row: index, value: "", reason: `bad path: ${(err as Error).message}` });
      return;
    }
    if (!resolution.found || resolution.value === null) {
      if (!allowMissing) {
        dangling.push({ row: index, value: "", reason: `no value at "${field}"` });
      }
      return;
    }
    checked += 1;
    const key = canonicalize(resolution.value);
    if (allowedByKey.has(key)) {
      used.add(key);
      return;
    }
    dangling.push({
      row: index,
      value: preview(resolution.value, 60),
      reason: "not present in the allowed set",
    });
  });

  const unreferenced =
    options.reportUnreferenced === true
      ? [...allowedByKey.entries()].filter(([k]) => !used.has(k)).map(([, v]) => preview(v, 60))
      : [];

  return {
    ok: dangling.length === 0,
    total: rows.length,
    checked,
    dangling: dangling.slice(0, maxDangling),
    unreferenced,
    truncated: dangling.length > maxDangling,
  };
}

/**
 * Collect the distinct values of a field across rows, canonically. Used to
 * build the allowed set for {@link checkReferences} from a parent table.
 */
export function collectFieldValues(rows: unknown[], field: string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const row of rows) {
    let resolution: ReturnType<typeof getPath>;
    try {
      resolution = getPath(row, field);
    } catch {
      continue;
    }
    if (!resolution.found) continue;
    const key = canonicalize(resolution.value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolution.value);
  }
  return out;
}
