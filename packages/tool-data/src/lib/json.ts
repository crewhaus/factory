/**
 * The JSON primitives everything else in this package is built on: a value
 * model, structural equality, a stable (key-sorted) serializer, and a
 * content hash.
 *
 * Stability is the point. Two harness runs that produce the same data must
 * produce the same bytes, or every downstream diff is noise.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** A plain object, as distinct from an array or a primitive. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `key` only when it is the object's OWN property. A key taken from the
 * data (a dotted path segment, a TOML table name, an XML element name) must
 * never reach an inherited member: `constructor` would read
 * `Object.prototype.constructor`, and `__proto__` would hand back
 * `Object.prototype` itself as something to write into — which is how one
 * hostile document polluted every object in the process.
 */
export function getOwn(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * Write `key` as an own data property. For every key but `__proto__` plain
 * assignment already does that; `__proto__` alone is an accessor inherited
 * from `Object.prototype`, whose setter would replace the object's prototype
 * (dropping the key) instead of storing it. `defineProperty` stores it as the
 * data it is, so `{"__proto__": …}` round-trips like any other key — the
 * way `JSON.parse` itself reads it.
 */
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

/** Structural equality over JSON values. Key order is irrelevant; NaN never appears in JSON. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.hasOwn(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/** A structured clone that only has to handle JSON shapes, so no cycles exist. */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) setOwn(out, k, deepClone(value[k]));
    return out as T;
  }
  return value;
}

/**
 * Serialize with object keys in sorted order at every depth, so that two
 * equal values always produce identical bytes. Array order is data and is
 * never touched.
 *
 * One caveat worth knowing rather than discovering: `JSON.stringify` emits
 * an object's integer-like keys first, in ascending numeric order, whatever
 * order they sit in. So `{"10":a,"2":b,"x":c}` serializes as `2, 10, x`, not
 * the code-unit order `10, 2, x` that `sortKeysDeep` puts them in. The
 * result is still canonical — two equal values still produce identical bytes
 * — but it is not literally sorted for those keys.
 *
 * `indent` of 0 gives the compact form.
 */
export function canonicalStringify(value: unknown, indent = 0): string {
  return JSON.stringify(sortKeysDeep(value), null, indent);
}

/** Recursively rebuild objects with their keys in code-unit sorted order. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) setOwn(out, k, sortKeysDeep(value[k]));
    return out;
  }
  return value;
}

const UTF8 = new TextEncoder();

/**
 * FNV-1a, 64 bits, over the UTF-8 bytes of `text` — the algorithm exactly as
 * Fowler/Noll/Vo define it, so the reference vectors hold: `""` hashes to
 * `cbf29ce484222325`, `"a"` to `af63dc4c8601ec8c` and `"foobar"` to
 * `85944171f73967e8`. `lib.test.ts` pins all three.
 *
 * It is a content fingerprint, not a cryptographic digest — never use it
 * where collision resistance against an adversary matters.
 */
export function fnv1a64(text: string): string {
  const prime = 1099511628211n;
  const mask = 0xffffffffffffffffn;
  let hash = 14695981039346656037n;
  // UTF-8 bytes, so the hash is over the encoding the vectors are defined on
  // rather than over JavaScript's UTF-16 code units.
  for (const byte of UTF8.encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * A 64-bit FNV-1a hash of the canonical serialization, rendered as 16 hex
 * characters. Two values that are `deepEqual` always hash the same, because
 * the serialization sorts keys first.
 *
 * Use it as a fingerprint a caller can compare or record. Do not use it as
 * an identity key inside this package: 64 bits collide, and the canonical
 * string it is computed from is right there and is exact, which is what
 * `totalCompare`, `aggregate`, `joinRecords` and `dedupeRecords` key on.
 */
export function stableHash(value: unknown): string {
  return fnv1a64(canonicalStringify(value));
}

/** Parse JSON, converting the engine's error into a caller-readable message. */
export function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** A short, human-readable type name used in diffs and error messages. */
export function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ---------------------------------------------------------------------------
// Bounds on nesting and on output.
//
// A document's cost here is not its length. Every tool that walks a value
// does work per level as well as per node — a merge that cloned the rest of
// the tree at each level, a query that copied the path at each level, a
// pretty-printer that writes depth x indent spaces on every line — so a
// 48 KB document nested 8,000 deep cost gigabytes. Depth is capped at the
// door, and every result is measured before it is built.

/**
 * The deepest nesting a document may have: each `[` or `{` is one level, a
 * scalar document is depth 0. XmlParse's own ceiling, and far past any real
 * configuration, API response or AST dump.
 */
export const MAX_NESTING_DEPTH = 256;

/**
 * Whether JSON text nests deeper than `limit`, from one linear pass over the
 * characters: brackets inside string literals (escapes honoured) do not
 * count, and nothing is parsed, so a hostile document is refused before a
 * deep tree exists. Malformed text may be over-counted; it would fail to
 * parse anyway.
 */
export function jsonTextNestsDeeper(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      // A backslash escapes the character after it.
      if (c === 0x5c) i += 1;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      depth += 1;
      if (depth > limit) return true;
    } else if (c === 0x5d || c === 0x7d) {
      if (depth > 0) depth -= 1;
    }
  }
  return false;
}

/** Whether a parsed value nests deeper than `limit`. Iterative: no recursion to overflow. */
export function nestingDepthExceeds(value: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    const children = Array.isArray(node) ? node : isPlainObject(node) ? Object.values(node) : null;
    if (children === null) continue;
    if (depth + 1 > limit) return true;
    for (const child of children) {
      if (typeof child === "object" && child !== null) stack.push([child, depth + 1]);
    }
  }
  return false;
}

/** A result, or a part of one, that would be larger than its tool may return. */
export class OutputLimitError extends Error {
  readonly limit: number;
  constructor(limit: number, what = "the result") {
    super(`${what} would be more than ${limit} characters`);
    this.limit = limit;
  }
}

/** Nothing a value's JSON form renders as: skipped in an object, `null` in an array. */
const renders = (v: unknown): boolean =>
  v !== undefined && typeof v !== "function" && typeof v !== "symbol";

/**
 * The length of `JSON.stringify(value, null, indent)`, computed without
 * building it, and abandoned as soon as it passes `cap` (the answer is then
 * some number above `cap`). Iterative and exact for JSON values; a
 * non-plain object (none of this package's readers make one) is measured by
 * serializing it.
 *
 * Measured first so that a result too large to return is refused before it
 * exists: pretty-printing multiplies every line by depth x indent, and a
 * record set can repeat a long key once per row.
 */
export function jsonTextLength(value: unknown, indent: number, cap: number): number {
  if (!renders(value)) return 0;
  const k = Math.min(10, Math.max(0, Math.floor(indent)));
  let total = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (node === null || !renders(node)) {
      total += 4; // null, or a non-rendering array element, which becomes null
    } else if (typeof node === "string") {
      total += (JSON.stringify(node) as string).length;
    } else if (typeof node === "number") {
      total += Number.isFinite(node) ? String(node).length : 4;
    } else if (typeof node === "boolean") {
      total += node ? 4 : 5;
    } else if (Array.isArray(node)) {
      const n = node.length;
      if (n === 0) total += 2;
      else {
        total += 2 + (n - 1) + (k === 0 ? 0 : n * (1 + (depth + 1) * k) + 1 + depth * k);
        for (let i = n - 1; i >= 0; i--) stack.push([node[i], depth + 1]);
      }
    } else if (isPlainObject(node)) {
      let m = 0;
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (!renders(v)) continue;
        m += 1;
        total += (JSON.stringify(key) as string).length + (k === 0 ? 1 : 2);
        stack.push([v, depth + 1]);
      }
      if (m === 0) total += 2;
      else total += 2 + (m - 1) + (k === 0 ? 0 : m * (1 + (depth + 1) * k) + 1 + depth * k);
    } else {
      total += (JSON.stringify(node) ?? "null").length;
    }
    if (total > cap) return total;
  }
  return total;
}
