/**
 * `deepEqual` answered by lookup, for the values inside two documents.
 *
 * SchemaDiff compared subtrees with `deepEqual` at every level it descended
 * into — the whole remaining tree once per level, so a schema nested n deep
 * cost n² — and diffed two enums by testing every value of one against every
 * value of the other. Here every array and plain object inside the indexed
 * values gets a number, shared by exactly the subtrees `deepEqual` calls
 * equal, worked out once from the leaves up. Two subtrees are then equal
 * when their numbers are, and a value can be looked up in a set.
 *
 * The numbers are defined only where `deepEqual` compares JSON shape: null,
 * booleans, strings, numbers other than NaN, bigints, undefined, dense
 * arrays, and objects whose prototype is `Object.prototype` or null and
 * whose own properties are all data properties. Anything else — NaN, which
 * equals nothing, a function, a Date, a sparse array, a cycle — leaves the
 * values unindexed, and every comparison goes back to `deepEqual` itself.
 * So each answer is the one `deepEqual` gives. A value parsed from JSON is
 * always indexed.
 */
import { deepEqual } from "./value";

export type ShapeIndex = {
  /** `deepEqual(a, b)`. */
  readonly equal: (a: unknown, b: unknown) => boolean;
  /**
   * A string two indexed values share exactly when `deepEqual` calls them
   * equal, or undefined for a value the index does not cover.
   */
  readonly key: (value: unknown) => string | undefined;
  /**
   * The work of numbering: members visited plus signature characters
   * written. A test reads it, since a map lookup is invisible to a meter
   * that wraps the array and string methods.
   */
  readonly steps: number;
};

/** No index: `deepEqual` for every comparison, and no keys. */
export const UNINDEXED: ShapeIndex = { equal: deepEqual, key: () => undefined, steps: 0 };

/** Thrown while indexing a value `deepEqual` does not compare by shape. */
const NOT_A_SHAPE = Symbol("not a JSON shape");

/** The key of a value that is not an object, or NOT_A_SHAPE. */
function leafKey(value: unknown): string | typeof NOT_A_SHAPE {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return "u";
    case "boolean":
      return value ? "t" : "f";
    case "number":
      // `deepEqual` is `===` here: NaN equals nothing, and 0 equals -0.
      if (Number.isNaN(value)) return NOT_A_SHAPE;
      return `n${value === 0 ? 0 : value}`;
    case "string":
      return `s${JSON.stringify(value)}`;
    case "bigint":
      return `b${value}`;
    default:
      return NOT_A_SHAPE;
  }
}

/** An object being numbered: its members in key order, and how many are done. */
type Frame = {
  readonly node: object;
  /** null for an array; the sorted keys of an object. */
  readonly keys: ReadonlyArray<string> | null;
  readonly members: ReadonlyArray<unknown>;
  next: number;
};

/**
 * Number every array and object inside `roots`, or return UNINDEXED when
 * one of them holds a value the numbers cannot describe.
 */
export function indexShapes(roots: ReadonlyArray<unknown>): ShapeIndex {
  const ids = new Map<object, number>();
  const bySignature = new Map<string, number>();
  const work = { steps: 0 };
  const keyOf = (value: unknown): string | typeof NOT_A_SHAPE => {
    if (typeof value !== "object" || value === null) return leafKey(value);
    const id = ids.get(value);
    return id === undefined ? NOT_A_SHAPE : `o${id}`;
  };
  try {
    for (const root of roots) number(root, ids, bySignature, keyOf, work);
  } catch (err) {
    if (err === NOT_A_SHAPE) return UNINDEXED;
    throw err;
  }
  return {
    equal: (a, b) => {
      if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
        const left = ids.get(a);
        const right = ids.get(b);
        if (left !== undefined && right !== undefined) return left === right;
      }
      return deepEqual(a, b);
    },
    key: (value) => {
      const key = keyOf(value);
      return key === NOT_A_SHAPE ? undefined : key;
    },
    steps: work.steps,
  };
}

/**
 * Give `root` and everything inside it a number, children before parents,
 * with an explicit stack: a schema nested tens of thousands deep must not
 * overflow the call stack here when the comparisons it replaces did not.
 */
function number(
  root: unknown,
  ids: Map<object, number>,
  bySignature: Map<string, number>,
  keyOf: (value: unknown) => string | typeof NOT_A_SHAPE,
  work: { steps: number },
): void {
  const frames: Frame[] = [];
  const open = new Set<object>();
  const enter = (value: unknown): void => {
    if (typeof value !== "object" || value === null) {
      if (leafKey(value) === NOT_A_SHAPE) throw NOT_A_SHAPE;
      return;
    }
    if (ids.has(value)) return;
    // A cycle: `deepEqual` would recurse until the stack ran out.
    if (open.has(value)) throw NOT_A_SHAPE;
    if (Array.isArray(value)) {
      // `deepEqual` skips a hole with `every`, which no number can say.
      for (let i = 0; i < value.length; i++) if (!(i in value)) throw NOT_A_SHAPE;
      frames.push({ node: value, keys: null, members: value, next: 0 });
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw NOT_A_SHAPE;
      const keys = Object.keys(value).sort();
      const members: unknown[] = [];
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (property === undefined || !("value" in property)) throw NOT_A_SHAPE;
        members.push(property.value);
      }
      frames.push({ node: value, keys, members, next: 0 });
    }
    open.add(value);
  };
  enter(root);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1] as Frame;
    if (frame.next < frame.members.length) {
      enter(frame.members[frame.next]);
      frame.next += 1;
      continue;
    }
    frames.pop();
    open.delete(frame.node);
    const parts: string[] = [];
    for (let i = 0; i < frame.members.length; i++) {
      const key = keyOf(frame.members[i]);
      if (key === NOT_A_SHAPE) throw NOT_A_SHAPE;
      const name = frame.keys === null ? undefined : frame.keys[i];
      parts.push(name === undefined ? key : `${JSON.stringify(name)}:${key}`);
    }
    const signature = frame.keys === null ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
    work.steps += frame.members.length + signature.length;
    let id = bySignature.get(signature);
    if (id === undefined) {
      id = bySignature.size;
      bySignature.set(signature, id);
    }
    ids.set(frame.node, id);
  }
}
