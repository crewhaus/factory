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
    for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
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
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
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
