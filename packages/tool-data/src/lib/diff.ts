/**
 * Deep structural diff of two JSON values.
 *
 * Objects are compared key by key; arrays are compared index by index, which
 * means an insertion at the front reports every later index as changed. That
 * is the honest answer for positional data (a config array, a tuple) and the
 * wrong one for a list of records — for records, key the arrays first with
 * `keyArraysBy`, which matches elements by a field instead of by position.
 */

import { deepEqual, isPlainObject, typeOf } from "./json";
import { formatPointer } from "./patch";

export type DiffKind = "added" | "removed" | "changed";

export type DiffEntry = {
  path: string;
  kind: DiffKind;
  /** The type on each side, so a `1` -> `"1"` change is visible. */
  from?: unknown;
  to?: unknown;
  fromType?: string;
  toType?: string;
};

export type DiffOptions = {
  /**
   * Match array elements by the value of this field instead of by index.
   * The keying is all-or-nothing per array: if *either* side has an element
   * without the field, with a non-scalar value for it, or with a value that
   * repeats, that whole array is compared positionally instead. Nested
   * arrays are considered independently.
   */
  keyArraysBy?: string;
  /** Stop descending past this depth; deeper differences report as one `changed`. */
  maxDepth: number;
  /** Stop after this many entries, so a total rewrite cannot fill a context window. */
  maxEntries: number;
};

export type DiffResult = {
  entries: DiffEntry[];
  truncated: boolean;
  counts: { added: number; removed: number; changed: number };
};

/** Compare two values, returning a flat list of differences by JSON Pointer path. */
export function deepDiff(a: unknown, b: unknown, options: DiffOptions): DiffResult {
  const entries: DiffEntry[] = [];
  let truncated = false;

  const push = (entry: DiffEntry): void => {
    if (entries.length >= options.maxEntries) {
      truncated = true;
      return;
    }
    entries.push(entry);
  };

  const recurse = (left: unknown, right: unknown, path: string[], depth: number): void => {
    if (truncated) return;
    // Equality first, then the budget: returning early on a full budget
    // *before* knowing there is a difference would leave `truncated` false
    // while differences went unreported, which is exactly the silence this
    // tool exists to avoid.
    if (deepEqual(left, right)) return;
    if (entries.length >= options.maxEntries) {
      truncated = true;
      return;
    }
    const pointer = formatPointer(path) || "/";

    if (depth >= options.maxDepth) {
      push({
        path: pointer,
        kind: "changed",
        from: left,
        to: right,
        fromType: typeOf(left),
        toType: typeOf(right),
      });
      return;
    }

    if (isPlainObject(left) && isPlainObject(right)) {
      for (const key of Object.keys(left)) {
        if (!Object.hasOwn(right, key)) {
          push({
            path: formatPointer([...path, key]),
            kind: "removed",
            from: left[key],
            fromType: typeOf(left[key]),
          });
          continue;
        }
        recurse(left[key], right[key], [...path, key], depth + 1);
      }
      for (const key of Object.keys(right)) {
        if (!Object.hasOwn(left, key)) {
          push({
            path: formatPointer([...path, key]),
            kind: "added",
            to: right[key],
            toType: typeOf(right[key]),
          });
        }
      }
      return;
    }

    if (Array.isArray(left) && Array.isArray(right)) {
      const key = options.keyArraysBy;
      if (key !== undefined && canKey(left, key) && canKey(right, key)) {
        diffKeyedArrays(left, right, key, path, depth, recurse, push);
        return;
      }
      const shared = Math.min(left.length, right.length);
      for (let i = 0; i < shared; i++) {
        recurse(left[i], right[i], [...path, String(i)], depth + 1);
      }
      for (let i = shared; i < left.length; i++) {
        push({
          path: formatPointer([...path, String(i)]),
          kind: "removed",
          from: left[i],
          fromType: typeOf(left[i]),
        });
      }
      for (let i = shared; i < right.length; i++) {
        push({
          path: formatPointer([...path, String(i)]),
          kind: "added",
          to: right[i],
          toType: typeOf(right[i]),
        });
      }
      return;
    }

    push({
      path: pointer,
      kind: "changed",
      from: left,
      to: right,
      fromType: typeOf(left),
      toType: typeOf(right),
    });
  };

  recurse(a, b, [], 0);
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const e of entries) counts[e.kind] += 1;
  return { entries, truncated, counts };
}

/** True when every element is an object carrying a distinct, scalar value for `key`. */
function canKey(arr: ReadonlyArray<unknown>, key: string): boolean {
  const seen = new Set<string>();
  for (const el of arr) {
    if (!isPlainObject(el)) return false;
    const v = el[key];
    if (v === undefined || v === null || typeof v === "object") return false;
    const s = String(v);
    if (seen.has(s)) return false;
    seen.add(s);
  }
  return true;
}

function diffKeyedArrays(
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
  key: string,
  path: string[],
  depth: number,
  recurse: (l: unknown, r: unknown, p: string[], d: number) => void,
  push: (e: DiffEntry) => void,
): void {
  const index = (arr: ReadonlyArray<unknown>): Map<string, { i: number; value: unknown }> => {
    const m = new Map<string, { i: number; value: unknown }>();
    arr.forEach((el, i) => {
      const v = (el as Record<string, unknown>)[key];
      m.set(String(v), { i, value: el });
    });
    return m;
  };
  const l = index(left);
  const r = index(right);
  for (const [k, entry] of l) {
    const other = r.get(k);
    if (other === undefined) {
      push({
        path: formatPointer([...path, String(entry.i)]),
        kind: "removed",
        from: entry.value,
        fromType: typeOf(entry.value),
      });
      continue;
    }
    recurse(entry.value, other.value, [...path, String(other.i)], depth + 1);
  }
  for (const [k, entry] of r) {
    if (!l.has(k)) {
      push({
        path: formatPointer([...path, String(entry.i)]),
        kind: "added",
        to: entry.value,
        toType: typeOf(entry.value),
      });
    }
  }
}
