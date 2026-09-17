/**
 * Comparing a value against an expected value — the primitive under
 * `DeepEqual`, `CompareGolden` and `MatchSubset`.
 *
 * A snapshot comparison is only useful if it can be told to overlook the
 * parts that legitimately move: a generated id, a timestamp, the order of a
 * result set, the last bit of a float. Those three knobs (`ignorePaths`,
 * `ignoreArrayOrder`, `epsilon`) are what separate a golden test that holds
 * for a year from one that is deleted in a week.
 *
 * Every difference is reported with a JSON Pointer, and the walk is
 * deterministic: object keys in sorted order, array items in index order.
 */
import { canonicalize, isPlainObject, joinPointer, preview, typeOf } from "./value";

export type DifferenceKind = "missing" | "unexpected" | "type" | "value" | "length";

/** One place where actual and expected part ways. */
export type Difference = {
  /** JSON Pointer into the compared values. */
  path: string;
  kind: DifferenceKind;
  message: string;
  expected: unknown;
  actual: unknown;
};

export type CompareOptions = {
  /**
   * JSON Pointer patterns to skip. A star segment matches any one segment,
   * so "/items" + star + "/id" skips the id of every item; a trailing
   * double-star segment matches everything below that point.
   */
  ignorePaths: string[];
  /** Compare arrays as multisets rather than by position. */
  ignoreArrayOrder: boolean;
  /** Numbers within this absolute distance count as equal. */
  epsilon: number;
  /** Allow object keys in actual that expected does not mention. */
  subset: boolean;
  /** Stop after this many differences. */
  maxDifferences: number;
};

export const DEFAULT_COMPARE_OPTIONS: CompareOptions = {
  ignorePaths: [],
  ignoreArrayOrder: false,
  epsilon: 0,
  subset: false,
  maxDifferences: 50,
};

/**
 * Unordered array matching is O(n*m) comparisons. Past this length the cost
 * stops being worth it and the comparison falls back to positional, saying
 * so in the result rather than silently changing meaning.
 */
export const UNORDERED_ARRAY_LIMIT = 200;

export type CompareResult = {
  equal: boolean;
  differences: Difference[];
  truncated: boolean;
  /** Paths that `ignorePaths` actually matched — a pattern that matches nothing is usually a typo. */
  ignored: string[];
  /** Arrays too long to match unordered, compared positionally instead. */
  orderedFallbacks: string[];
};

type Pattern = string[];

function compilePattern(pointer: string): Pattern {
  const body = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  return body === "" ? [] : body.split("/");
}

function pathSegments(pointer: string): string[] {
  return pointer === "" ? [] : pointer.slice(1).split("/");
}

/** True when `pointer` is matched by one of the compiled ignore patterns. */
export function matchesAnyPattern(pointer: string, patterns: Pattern[]): boolean {
  const segments = pathSegments(pointer);
  return patterns.some((pattern) => matchPattern(segments, pattern));
}

function matchPattern(segments: string[], pattern: Pattern): boolean {
  let s = 0;
  for (let p = 0; p < pattern.length; p++) {
    const token = pattern[p] as string;
    if (token === "**") return true;
    if (s >= segments.length) return false;
    if (token !== "*" && token !== segments[s]) return false;
    s += 1;
  }
  return s === segments.length;
}

type Ctx = {
  opts: CompareOptions;
  patterns: Pattern[];
  differences: Difference[];
  truncated: boolean;
  ignored: string[];
  orderedFallbacks: string[];
};

function record(ctx: Ctx, diff: Difference): void {
  if (ctx.differences.length >= ctx.opts.maxDifferences) {
    ctx.truncated = true;
    return;
  }
  ctx.differences.push(diff);
}

function numbersEqual(a: number, b: number, epsilon: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return epsilon > 0 && Math.abs(a - b) <= epsilon;
}

/** Compare without recording anything — used to pair up unordered items. */
function equalUnder(actual: unknown, expected: unknown, ctx: Ctx, path: string): boolean {
  const probe: Ctx = {
    opts: { ...ctx.opts, maxDifferences: 1 },
    patterns: ctx.patterns,
    differences: [],
    truncated: false,
    ignored: [],
    orderedFallbacks: [],
  };
  walk(actual, expected, path, probe);
  return probe.differences.length === 0;
}

function walk(actual: unknown, expected: unknown, path: string, ctx: Ctx): void {
  if (matchesAnyPattern(path, ctx.patterns)) {
    if (!ctx.ignored.includes(path)) ctx.ignored.push(path);
    return;
  }

  const expectedType = typeOf(expected);
  const actualType = typeOf(actual);

  if (typeof expected === "number" && typeof actual === "number") {
    if (!numbersEqual(actual, expected, ctx.opts.epsilon)) {
      record(ctx, {
        path,
        kind: "value",
        message:
          ctx.opts.epsilon > 0
            ? `${actual} differs from ${expected} by more than ${ctx.opts.epsilon}`
            : `expected ${expected}, found ${actual}`,
        expected,
        actual,
      });
    }
    return;
  }

  // `integer` and `number` are the same JSON type for comparison purposes.
  const normalize = (t: string): string => (t === "integer" ? "number" : t);
  if (normalize(expectedType) !== normalize(actualType)) {
    record(ctx, {
      path,
      kind: "type",
      message: `expected ${normalize(expectedType)}, found ${normalize(actualType)} (${preview(actual, 60)})`,
      expected,
      actual,
    });
    return;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    compareArrays(actual, expected, path, ctx);
    return;
  }

  if (isPlainObject(expected) && isPlainObject(actual)) {
    compareObjects(actual, expected, path, ctx);
    return;
  }

  if (expected !== actual) {
    record(ctx, {
      path,
      kind: "value",
      message: `expected ${preview(expected, 60)}, found ${preview(actual, 60)}`,
      expected,
      actual,
    });
  }
}

function compareArrays(actual: unknown[], expected: unknown[], path: string, ctx: Ctx): void {
  const tooLong = actual.length > UNORDERED_ARRAY_LIMIT || expected.length > UNORDERED_ARRAY_LIMIT;
  if (ctx.opts.ignoreArrayOrder && tooLong && !ctx.orderedFallbacks.includes(path)) {
    ctx.orderedFallbacks.push(path);
  }
  if (ctx.opts.ignoreArrayOrder && !tooLong) {
    compareArraysUnordered(actual, expected, path, ctx);
    return;
  }
  if (actual.length !== expected.length) {
    record(ctx, {
      path,
      kind: "length",
      message: `expected ${expected.length} items, found ${actual.length}`,
      expected: expected.length,
      actual: actual.length,
    });
  }
  const shared = Math.min(actual.length, expected.length);
  for (let i = 0; i < shared; i++) {
    walk(actual[i], expected[i], joinPointer(path, i), ctx);
  }
}

/**
 * Pair the two arrays up greedily: each expected item takes the first
 * unclaimed actual item it equals.
 *
 * With `epsilon` at 0, equality is an equivalence relation, so greedy pairing
 * finds a complete matching whenever one exists. With a non-zero `epsilon` it
 * is not — `1.0` and `1.2` are each within 0.15 of `1.1` but not of each
 * other — and greedy can claim an item a later one needed, reporting a
 * difference where a perfect pairing existed. That is the deliberate trade
 * for keeping this O(n*m) rather than running a full bipartite matching; the
 * report errs towards naming a difference, never towards hiding one.
 */
function compareArraysUnordered(
  actual: unknown[],
  expected: unknown[],
  path: string,
  ctx: Ctx,
): void {
  const taken = new Set<number>();
  const unmatchedExpected: number[] = [];
  for (let e = 0; e < expected.length; e++) {
    let matched = false;
    for (let a = 0; a < actual.length; a++) {
      if (taken.has(a)) continue;
      if (!equalUnder(actual[a], expected[e], ctx, path)) continue;
      taken.add(a);
      matched = true;
      break;
    }
    if (!matched) unmatchedExpected.push(e);
  }
  for (const e of unmatchedExpected) {
    record(ctx, {
      path: joinPointer(path, e),
      kind: "missing",
      message: `no item in the actual array matches expected[${e}] (${preview(expected[e], 60)})`,
      expected: expected[e],
      actual: undefined,
    });
  }
  for (let a = 0; a < actual.length; a++) {
    if (taken.has(a)) continue;
    record(ctx, {
      path: joinPointer(path, a),
      kind: "unexpected",
      message: `actual[${a}] (${preview(actual[a], 60)}) has no counterpart in expected`,
      expected: undefined,
      actual: actual[a],
    });
  }
}

function compareObjects(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  path: string,
  ctx: Ctx,
): void {
  for (const key of Object.keys(expected).sort()) {
    const childPath = joinPointer(path, key);
    if (!Object.hasOwn(actual, key)) {
      if (matchesAnyPattern(childPath, ctx.patterns)) {
        if (!ctx.ignored.includes(childPath)) ctx.ignored.push(childPath);
        continue;
      }
      record(ctx, {
        path: childPath,
        kind: "missing",
        message: `expected property "${key}" is absent`,
        expected: expected[key],
        actual: undefined,
      });
      continue;
    }
    walk(actual[key], expected[key], childPath, ctx);
  }
  if (ctx.opts.subset) return;
  for (const key of Object.keys(actual).sort()) {
    if (Object.hasOwn(expected, key)) continue;
    const childPath = joinPointer(path, key);
    if (matchesAnyPattern(childPath, ctx.patterns)) {
      if (!ctx.ignored.includes(childPath)) ctx.ignored.push(childPath);
      continue;
    }
    record(ctx, {
      path: childPath,
      kind: "unexpected",
      message: `unexpected property "${key}" (${preview(actual[key], 60)})`,
      expected: undefined,
      actual: actual[key],
    });
  }
}

/**
 * Compare `actual` against `expected` under the given options and return
 * every difference found, each addressed by JSON Pointer.
 *
 * With `ignoreArrayOrder`, item paths refer to positions in the array they
 * came from — an unmatched expected item is reported at its index in
 * *expected*, an unmatched actual item at its index in *actual* — because
 * with order ignored there is no single index that means both.
 */
export function compareValues(
  actual: unknown,
  expected: unknown,
  options: Partial<CompareOptions> = {},
): CompareResult {
  const opts: CompareOptions = { ...DEFAULT_COMPARE_OPTIONS, ...options };
  const ctx: Ctx = {
    opts,
    patterns: opts.ignorePaths.map(compilePattern),
    differences: [],
    truncated: false,
    ignored: [],
    orderedFallbacks: [],
  };
  walk(actual, expected, "", ctx);
  return {
    equal: ctx.differences.length === 0,
    differences: ctx.differences,
    truncated: ctx.truncated,
    ignored: ctx.ignored,
    orderedFallbacks: ctx.orderedFallbacks,
  };
}

/**
 * The first place two values differ, walking objects in sorted key order and
 * arrays by index, or `null` when they are structurally equal. This is the
 * one line a failing equality check should print.
 */
export function firstDifference(actual: unknown, expected: unknown): Difference | null {
  const result = compareValues(actual, expected, { maxDifferences: 1 });
  return result.differences[0] ?? null;
}

/**
 * Group values that canonicalize identically. Used for duplicate detection,
 * where "identical" must ignore key order.
 */
export function groupByCanonical<T>(items: T[], key: (item: T) => unknown): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  items.forEach((item, index) => {
    const id = canonicalize(key(item));
    const bucket = groups.get(id);
    if (bucket === undefined) groups.set(id, [index]);
    else bucket.push(index);
  });
  return groups;
}
