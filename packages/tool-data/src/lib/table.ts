/**
 * Operations over an array of records — the shape almost every API response,
 * CSV file and query result arrives in.
 *
 * Field references are dotted paths (`user.name`), so nested records work
 * without flattening them first. Ordering is always total and stable: where
 * two rows compare equal the original order is kept, so the same input gives
 * the same output every time.
 */

import { canonicalStringify, deepEqual, isPlainObject } from "./json";

export type Record_ = Record<string, unknown>;

/** Read a dotted path out of a record. Returns undefined for any miss. */
export function getPath(record: unknown, path: string): unknown {
  if (path === "") return record;
  let cur: unknown = record;
  for (const seg of path.split(".")) {
    if (isPlainObject(cur)) {
      cur = cur[seg];
      continue;
    }
    if (Array.isArray(cur) && /^\d+$/.test(seg)) {
      cur = cur[Number(seg)];
      continue;
    }
    return undefined;
  }
  return cur;
}

/** Write a dotted path into a record, creating intermediate objects. */
export function setPath(target: Record_, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur: Record_ = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] as string;
    const next = cur[seg];
    if (!isPlainObject(next)) {
      const fresh: Record_ = {};
      cur[seg] = fresh;
      cur = fresh;
    } else {
      cur = next as Record_;
    }
  }
  cur[segs[segs.length - 1] as string] = value;
}

// ---------------------------------------------------------------------------
// Predicates

export type Comparison =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "matches"
  | "exists"
  | "empty";

export type Condition = { field: string; op: Comparison; value?: unknown };

/** All conditions must hold ("and"), or any one ("or"). */
export type Predicate = { all?: Condition[]; any?: Condition[]; none?: Condition[] };

export class PredicateError extends Error {}

/** Evaluate one condition against a record. */
export function testCondition(record: unknown, cond: Condition): boolean {
  const actual = getPath(record, cond.field);
  const expected = cond.value;
  switch (cond.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "empty":
      return (
        actual === undefined ||
        actual === null ||
        actual === "" ||
        (Array.isArray(actual) && actual.length === 0) ||
        (isPlainObject(actual) && Object.keys(actual).length === 0)
      );
    case "eq":
      return deepEqual(actual, expected);
    case "ne":
      return !deepEqual(actual, expected);
    case "in":
      return Array.isArray(expected) && expected.some((e) => deepEqual(actual, e));
    case "contains": {
      if (Array.isArray(actual)) return actual.some((e) => deepEqual(e, expected));
      return String(actual ?? "").includes(String(expected ?? ""));
    }
    case "startsWith":
      return String(actual ?? "").startsWith(String(expected ?? ""));
    case "endsWith":
      return String(actual ?? "").endsWith(String(expected ?? ""));
    case "matches": {
      if (typeof expected !== "string") {
        throw new PredicateError(`"matches" needs a regular-expression string for ${cond.field}`);
      }
      let re: RegExp;
      try {
        re = new RegExp(expected);
      } catch (err) {
        throw new PredicateError(`invalid regex for ${cond.field}: ${(err as Error).message}`);
      }
      return actual !== undefined && actual !== null && re.test(String(actual));
    }
    default:
      return compareOrdered(actual, expected, cond.op);
  }
}

function compareOrdered(actual: unknown, expected: unknown, op: Comparison): boolean {
  const cmp = compareValues(actual, expected);
  if (cmp === null) return false;
  if (op === "lt") return cmp < 0;
  if (op === "lte") return cmp <= 0;
  if (op === "gt") return cmp > 0;
  if (op === "gte") return cmp >= 0;
  return false;
}

/**
 * Order two scalars, or null when they are not comparable. Numbers compare
 * numerically, strings by code unit, booleans false-before-true; a
 * number/string pair is not comparable, which is what stops `"10" < 9`
 * quietly being true.
 */
export function compareValues(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return null;
}

/** Evaluate a whole predicate. An empty predicate matches everything. */
export function testPredicate(record: unknown, predicate: Predicate): boolean {
  const all = predicate.all ?? [];
  const any = predicate.any ?? [];
  const none = predicate.none ?? [];
  for (const c of all) if (!testCondition(record, c)) return false;
  for (const c of none) if (testCondition(record, c)) return false;
  if (any.length > 0 && !any.some((c) => testCondition(record, c))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Sorting

export type SortKey = {
  field: string;
  direction?: "asc" | "desc";
  /** Compare strings case-insensitively. Has no effect on other types. */
  caseInsensitive?: boolean;
  /** Where undefined and null go. Default "last", whatever the direction. */
  nulls?: "first" | "last";
};

/**
 * Sort records by one or more keys. The sort is stable and total: values of
 * different types are ordered by a fixed type rank (null < boolean < number
 * < string < array < object) so the result never depends on the input order
 * of incomparable rows.
 */
export function sortRecords<T>(records: ReadonlyArray<T>, keys: ReadonlyArray<SortKey>): T[] {
  const decorated = records.map((value, index) => ({ value, index }));
  decorated.sort((left, right) => {
    for (const key of keys) {
      const dir = key.direction === "desc" ? -1 : 1;
      let a = getPath(left.value, key.field);
      let b = getPath(right.value, key.field);
      const aNull = a === undefined || a === null;
      const bNull = b === undefined || b === null;
      if (aNull || bNull) {
        if (aNull && bNull) continue;
        const nullsLast = (key.nulls ?? "last") === "last";
        return aNull === nullsLast ? 1 : -1;
      }
      if (key.caseInsensitive === true) {
        if (typeof a === "string") a = a.toLowerCase();
        if (typeof b === "string") b = b.toLowerCase();
      }
      const cmp = totalCompare(a, b);
      if (cmp !== 0) return cmp * dir;
    }
    return left.index - right.index;
  });
  return decorated.map((d) => d.value);
}

/**
 * The type-rank order. `TYPE_ORDER[rankOf(v)]` is the name of `v`'s rank, so
 * the documented order and the code that implements it cannot drift.
 * `undefined` ranks with `null`, since neither is a JSON value a comparison
 * can say anything else about.
 */
export const TYPE_ORDER: ReadonlyArray<string> = Object.freeze([
  "null",
  "boolean",
  "number",
  "string",
  "array",
  "object",
]);

function rankOf(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return 1;
  if (typeof v === "number") return 2;
  if (typeof v === "string") return 3;
  if (Array.isArray(v)) return 4;
  return 5;
}

/**
 * A total order over JSON values, used so a sort is never arbitrary.
 *
 * Within a rank, scalars compare naturally. Arrays and objects compare by
 * their canonical text, which is lexicographic and therefore *not*
 * element-wise numeric: `[1, 10]` sorts before `[1, 2]`, because `"1"`
 * precedes `"2"` at the fourth character. That is the price of an order that
 * is total and never has to invent a comparison between a number and an
 * object; sort by a scalar field when the order has to mean something.
 */
export function totalCompare(a: unknown, b: unknown): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  const direct = compareValues(a, b);
  if (direct !== null) return direct;
  // null/undefined against each other, and arrays and objects: order by
  // canonical text, which is exact and stable. A hash would be neither —
  // two different values that collided would compare equal.
  const sa = canonicalStringify(a);
  const sb = canonicalStringify(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Projection, grouping, joining

/** Keep only the named fields (dotted paths), preserving the requested order. */
export function selectFields(record: unknown, fields: ReadonlyArray<string>): Record_ {
  const out: Record_ = {};
  for (const field of fields) {
    const value = getPath(record, field);
    if (value !== undefined) setPath(out, field, value);
  }
  return out;
}

/** Drop the named fields (dotted paths) from a shallow copy. */
export function omitFields(record: Record_, fields: ReadonlyArray<string>): Record_ {
  const out: Record_ = structuredCloneish(record);
  for (const field of fields) {
    const segs = field.split(".");
    let cur: unknown = out;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!isPlainObject(cur)) break;
      cur = cur[segs[i] as string];
    }
    if (isPlainObject(cur)) delete cur[segs[segs.length - 1] as string];
  }
  return out;
}

function structuredCloneish(value: Record_): Record_ {
  const out: Record_ = {};
  for (const k of Object.keys(value)) {
    const v = value[k];
    out[k] = isPlainObject(v) ? structuredCloneish(v as Record_) : v;
  }
  return out;
}

export type AggregateFn = "count" | "sum" | "min" | "max" | "avg" | "first" | "last" | "distinct";

export type Aggregation = { as: string; fn: AggregateFn; field?: string };

export type GroupResult = { key: Record_; count: number } & Record_;

/**
 * Group records by one or more fields and reduce each group.
 *
 * `sum` and `avg` ignore non-numeric values and report how many were skipped
 * via the `_skipped` count, rather than producing NaN. `min`/`max` use the
 * same total order as `sortRecords`. `distinct` counts distinct values by
 * their canonical form, so `{a:1,b:2}` and `{b:2,a:1}` are one value.
 */
export function aggregate(
  records: ReadonlyArray<Record_>,
  groupBy: ReadonlyArray<string>,
  aggregations: ReadonlyArray<Aggregation>,
): { groups: Record_[]; skipped: number } {
  const buckets = new Map<string, { key: Record_; rows: Record_[] }>();
  for (const rec of records) {
    const key: Record_ = {};
    for (const field of groupBy) key[field] = getPath(rec, field) ?? null;
    const id = canonicalStringify(key);
    const existing = buckets.get(id);
    if (existing === undefined) buckets.set(id, { key, rows: [rec] });
    else existing.rows.push(rec);
  }
  let skipped = 0;
  const groups: Record_[] = [];
  for (const bucket of buckets.values()) {
    const out: Record_ = { ...bucket.key, count: bucket.rows.length };
    for (const agg of aggregations) {
      const field = agg.field ?? "";
      const values = bucket.rows.map((r) => getPath(r, field));
      switch (agg.fn) {
        case "count":
          out[agg.as] = field === "" ? bucket.rows.length : values.filter(isPresent).length;
          break;
        case "sum":
        case "avg": {
          const nums = values.filter((v): v is number => typeof v === "number");
          skipped += values.filter(isPresent).length - nums.length;
          const total = nums.reduce((a, b) => a + b, 0);
          out[agg.as] = agg.fn === "sum" ? total : nums.length === 0 ? null : total / nums.length;
          break;
        }
        case "min":
        case "max": {
          const present = values.filter(isPresent);
          if (present.length === 0) {
            out[agg.as] = null;
            break;
          }
          out[agg.as] = present.reduce((best, v) => {
            const cmp = totalCompare(v, best);
            return (agg.fn === "min" ? cmp < 0 : cmp > 0) ? v : best;
          });
          break;
        }
        case "first":
          out[agg.as] = values[0] ?? null;
          break;
        case "last":
          out[agg.as] = values[values.length - 1] ?? null;
          break;
        case "distinct":
          out[agg.as] = new Set(values.filter(isPresent).map((v) => canonicalStringify(v))).size;
          break;
        default:
          break;
      }
    }
    groups.push(out);
  }
  return { groups, skipped };
}

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null;
}

export type JoinKind = "inner" | "left" | "right" | "full";

export type JoinOptions = {
  kind: JoinKind;
  leftKey: string;
  rightKey: string;
  /** Prefix applied to right-hand fields whose name collides with a left one. */
  rightPrefix: string;
  maxRows: number;
};

/**
 * Join two record arrays on a key. Matching is by the canonical form of the
 * key value, so `1` and `"1"` are different keys — a silent coercion here is
 * how a join quietly loses rows.
 *
 * Every right-hand match is emitted, so a one-to-many join multiplies rows,
 * as SQL does. `maxRows` bounds that.
 */
export function joinRecords(
  left: ReadonlyArray<Record_>,
  right: ReadonlyArray<Record_>,
  options: JoinOptions,
): { rows: Record_[]; truncated: boolean; unmatchedLeft: number; unmatchedRight: number } {
  const index = new Map<string, Record_[]>();
  for (const r of right) {
    const key = getPath(r, options.rightKey);
    if (!isPresent(key)) continue;
    const id = canonicalStringify(key);
    const bucket = index.get(id);
    if (bucket === undefined) index.set(id, [r]);
    else bucket.push(r);
  }
  const rows: Record_[] = [];
  const matchedRight = new Set<string>();
  let unmatchedLeft = 0;
  let truncated = false;

  const push = (row: Record_): void => {
    if (rows.length >= options.maxRows) {
      truncated = true;
      return;
    }
    rows.push(row);
  };

  for (const l of left) {
    const key = getPath(l, options.leftKey);
    const id = isPresent(key) ? canonicalStringify(key) : null;
    const matches = id === null ? undefined : index.get(id);
    if (matches === undefined || matches.length === 0) {
      unmatchedLeft += 1;
      if (options.kind === "left" || options.kind === "full") push({ ...l });
      continue;
    }
    if (id !== null) matchedRight.add(id);
    for (const r of matches) push(mergeRow(l, r, options.rightPrefix));
  }

  let unmatchedRight = 0;
  for (const r of right) {
    const key = getPath(r, options.rightKey);
    const id = isPresent(key) ? canonicalStringify(key) : null;
    if (id === null || !matchedRight.has(id)) {
      unmatchedRight += 1;
      if (options.kind === "right" || options.kind === "full") push({ ...r });
    }
  }
  return { rows, truncated, unmatchedLeft, unmatchedRight };
}

function mergeRow(left: Record_, right: Record_, prefix: string): Record_ {
  const out: Record_ = { ...left };
  for (const k of Object.keys(right)) {
    out[Object.hasOwn(left, k) ? `${prefix}${k}` : k] = right[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reshaping

/** Records to a column-oriented object: `[{a:1},{a:2}]` becomes `{a:[1,2]}`. */
export function recordsToColumns(records: ReadonlyArray<Record_>): Record<string, unknown[]> {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    for (const k of Object.keys(rec)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const out: Record<string, unknown[]> = {};
  for (const k of keys) out[k] = records.map((r) => (Object.hasOwn(r, k) ? r[k] : null));
  return out;
}

/**
 * Columns back to records. Columns of differing length are padded with null
 * up to the longest, and the caller is told how many were short.
 */
export function columnsToRecords(columns: Record<string, ReadonlyArray<unknown>>): {
  records: Record_[];
  ragged: string[];
} {
  const keys = Object.keys(columns);
  const lengths = keys.map((k) => (columns[k] ?? []).length);
  const max = lengths.length === 0 ? 0 : Math.max(...lengths);
  const ragged = keys.filter((k) => (columns[k] ?? []).length !== max);
  const records: Record_[] = [];
  for (let i = 0; i < max; i++) {
    const rec: Record_ = {};
    for (const k of keys) {
      const col = columns[k] ?? [];
      rec[k] = i < col.length ? col[i] : null;
    }
    records.push(rec);
  }
  return { records, ragged };
}

/** Flatten nested objects into dotted keys. Arrays become `a.0`, `a.1` when expanded. */
export function flattenObject(
  value: unknown,
  separator: string,
  expandArrays: boolean,
  maxDepth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth >= maxDepth) {
      out[prefix] = node;
      return;
    }
    if (isPlainObject(node)) {
      const keys = Object.keys(node);
      if (keys.length === 0) {
        if (prefix !== "") out[prefix] = {};
        return;
      }
      for (const k of keys)
        walk(node[k], prefix === "" ? k : `${prefix}${separator}${k}`, depth + 1);
      return;
    }
    if (Array.isArray(node) && expandArrays) {
      if (node.length === 0) {
        if (prefix !== "") out[prefix] = [];
        return;
      }
      node.forEach((el, i) =>
        walk(el, prefix === "" ? String(i) : `${prefix}${separator}${i}`, depth + 1),
      );
      return;
    }
    out[prefix] = node;
  };
  walk(value, "", 0);
  return out;
}

/**
 * Rebuild nested objects from dotted keys. A numeric segment becomes an
 * array index when `arraysFromNumericKeys` is on and the keys under that
 * prefix are a contiguous run from 0; otherwise it stays an object key, so
 * `{"a.2": 1}` does not silently produce two nulls.
 */
export function unflattenObject(
  flat: Record<string, unknown>,
  separator: string,
  arraysFromNumericKeys: boolean,
): unknown {
  const root: Record_ = {};
  for (const key of Object.keys(flat)) {
    const segs = key.split(separator);
    let cur: Record_ = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i] as string;
      const next = cur[seg];
      if (!isPlainObject(next)) {
        const fresh: Record_ = {};
        cur[seg] = fresh;
        cur = fresh;
      } else {
        cur = next as Record_;
      }
    }
    cur[segs[segs.length - 1] as string] = flat[key];
  }
  return arraysFromNumericKeys ? arrayify(root) : root;
}

function arrayify(node: unknown): unknown {
  if (!isPlainObject(node)) return node;
  const keys = Object.keys(node);
  const converted: Record_ = {};
  for (const k of keys) converted[k] = arrayify(node[k]);
  if (keys.length === 0) return converted;
  const allNumeric = keys.every((k) => /^(0|[1-9][0-9]*)$/.test(k));
  if (!allNumeric) return converted;
  const indices = keys.map(Number).sort((a, b) => a - b);
  const contiguous = indices.every((n, i) => n === i);
  if (!contiguous) return converted;
  return indices.map((n) => converted[String(n)]);
}

/**
 * De-duplicate records by a key path, or by the whole value when no key is
 * given. Identity is the canonical (key-sorted) serialization, so two
 * records that differ only in key order are one record.
 */
export function dedupeRecords<T>(
  records: ReadonlyArray<T>,
  keyFields: ReadonlyArray<string>,
  keep: "first" | "last",
): { records: T[]; removed: number } {
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const rec of records) {
    const id =
      keyFields.length === 0
        ? canonicalStringify(rec)
        : canonicalStringify(keyFields.map((f) => getPath(rec, f) ?? null));
    const at = seen.get(id);
    if (at === undefined) {
      seen.set(id, out.length);
      out.push(rec);
      continue;
    }
    if (keep === "last") out[at] = rec;
  }
  return { records: out, removed: records.length - out.length };
}

export type SampleMode = "head" | "tail" | "everyNth" | "evenly";

/**
 * Take a deterministic sample. There is no random mode on purpose: a tool
 * that returned a different subset on each call could not be cached, retried
 * or compared between runs. `evenly` spreads picks across the whole array.
 */
export function sampleRecords<T>(
  records: ReadonlyArray<T>,
  mode: SampleMode,
  count: number,
  step: number,
): T[] {
  if (records.length === 0) return [];
  switch (mode) {
    case "head":
      return records.slice(0, count);
    case "tail":
      return records.slice(Math.max(0, records.length - count));
    case "everyNth": {
      const out: T[] = [];
      for (let i = 0; i < records.length && out.length < count; i += Math.max(1, step)) {
        out.push(records[i] as T);
      }
      return out;
    }
    default: {
      const n = Math.min(count, records.length);
      if (n <= 1) return n === 1 ? [records[0] as T] : [];
      const out: T[] = [];
      for (let i = 0; i < n; i++) {
        out.push(records[Math.round((i * (records.length - 1)) / (n - 1))] as T);
      }
      return out;
    }
  }
}
