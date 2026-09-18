/**
 * The value layer: what a JSON value *is*, how to address a part of it, and
 * how to compare two of them.
 *
 * Everything above this file — the schema validator, the assertion runner,
 * the golden comparison — addresses values through these helpers, so there is
 * exactly one answer in this package to "what type is this", "what does this
 * path point at" and "are these two equal".
 */

/** The seven JSON Schema type names. `integer` is a number with no fraction. */
export type JsonType = "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";

/**
 * The type name a JSON Schema `type` keyword would use. Note that a whole
 * number reports `integer`, not `number` — callers that want the Draft-07
 * rule (an integer also satisfies `number`) must widen it themselves, which
 * `matchesType` below does.
 */
export function typeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    default:
      return "object";
  }
}

/** True when `actual` satisfies the schema type name `expected`. */
export function matchesType(actual: JsonType, expected: string): boolean {
  if (actual === expected) return true;
  // Draft-07: every integer is also a number. The reverse does not hold.
  return actual === "integer" && expected === "number";
}

/** True for a value that is an object and neither null nor an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True for a value JSON can represent losslessly. `undefined`, functions,
 * symbols, NaN and the infinities are not JSON; neither is any object
 * reachable from the value that contains one. Cycles report false rather
 * than hanging.
 */
export function isJsonValue(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }
  const obj = value as object;
  if (seen.has(obj)) return false;
  seen.add(obj);
  const ok = Array.isArray(value)
    ? value.every((v) => isJsonValue(v, seen))
    : Object.values(obj).every((v) => isJsonValue(v, seen));
  seen.delete(obj);
  return ok;
}

// --- JSON Pointer (RFC 6901) ------------------------------------------------

/** Escape one reference token: a tilde becomes `~0`, a slash becomes `~1`. */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Reverse of {@link escapePointerToken}; `~1` is undone before `~0`. */
export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Append one token to a pointer, escaping it. `joinPointer("", "a/b")` is `/a~1b`. */
export function joinPointer(base: string, token: string | number): string {
  return `${base}/${escapePointerToken(String(token))}`;
}

/**
 * Split a JSON Pointer into its reference tokens. The empty pointer is the
 * whole document and yields `[]`. A pointer that does not start with `/` is
 * rejected, because silently accepting it would make `a/b` and `/a/b` mean
 * the same thing and hide a caller's mistake.
 */
export function parsePointer(pointer: string): string[] {
  if (pointer === "" || pointer === "#") return [];
  const body = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (body === "") return [];
  if (!body.startsWith("/")) throw new Error(`JSON Pointer must start with "/": ${pointer}`);
  return body.slice(1).split("/").map(unescapePointerToken);
}

const PATH_SEGMENT =
  /\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'((?:[^'\\]|\\.)*)'\s*\]|\[(\d+)\]|([^.[\]]+)/g;

/**
 * A dotted path, the form people actually type: `user.address.city`,
 * `items[0].id`, `items.0.id`, and `["odd.key"]` for a key containing a dot.
 * Returns the segments as strings; array indices arrive as their decimal
 * text and are matched against array positions by {@link resolveSegments}.
 */
export function parseDottedPath(path: string): string[] {
  if (path === "" || path === "$") return [];
  const out: string[] = [];
  let consumed = 0;
  for (const match of path.matchAll(PATH_SEGMENT)) {
    const at = match.index ?? 0;
    if (at > consumed) {
      // Anything between two segments that is not a separator is malformed.
      const gap = path.slice(consumed, at);
      if (gap.replace(/\./g, "") !== "") throw new Error(`malformed path near "${gap}" in ${path}`);
    }
    const quoted = match[1] ?? match[2];
    out.push(quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : (match[3] ?? match[4] ?? ""));
    consumed = at + match[0].length;
  }
  if (out.length === 0) throw new Error(`malformed path: ${path}`);
  if (consumed !== path.length && path.slice(consumed).replace(/\./g, "") !== "") {
    throw new Error(`malformed path: ${path}`);
  }
  return out;
}

/** The outcome of walking a path: whether it resolved, and to what. */
export type Resolution = { found: boolean; value: unknown; missingAt: string | null };

/**
 * Walk already-split segments through a value. Stops at the first segment
 * that does not resolve and reports it, so a caller can say *where* a path
 * ran out rather than only that it did.
 */
export function resolveSegments(root: unknown, segments: string[]): Resolution {
  let current: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string;
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(seg) ? Number(seg) : Number.NaN;
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined, missingAt: segments.slice(0, i + 1).join(".") };
      }
      current = current[index];
      continue;
    }
    if (isPlainObject(current) && Object.hasOwn(current, seg)) {
      current = current[seg];
      continue;
    }
    return { found: false, value: undefined, missingAt: segments.slice(0, i + 1).join(".") };
  }
  return { found: true, value: current, missingAt: null };
}

/** Resolve a dotted path (`items[0].id`) against a value. */
export function getPath(root: unknown, path: string): Resolution {
  return resolveSegments(root, parseDottedPath(path));
}

/** Resolve a JSON Pointer (`/items/0/id`) against a value. */
export function getPointer(root: unknown, pointer: string): Resolution {
  return resolveSegments(root, parsePointer(pointer));
}

// --- comparison -------------------------------------------------------------

const NON_JSON_PREFIX = String.fromCharCode(0);

/**
 * A stable string for a value: object keys sorted, so two values that differ
 * only in key order produce the same bytes. Used for `uniqueItems`, for
 * duplicate detection and for unordered array matching.
 *
 * Non-JSON values (undefined, NaN, functions) are encoded with a distinct
 * marker rather than being dropped the way `JSON.stringify` drops them,
 * because a dropped key silently changes the meaning of the comparison.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return `${NON_JSON_PREFIX}undefined`;
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : `${NON_JSON_PREFIX}${String(value)}`;
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  // Not JSON, but distinguishable: falling through to the `typeof` marker
  // below would give every bigint the same key, and a uniqueness check would
  // then call 1n and 2n duplicates.
  if (typeof value === "bigint") return `${NON_JSON_PREFIX}bigint:${value.toString()}`;
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return `${NON_JSON_PREFIX}${typeof value}`;
}

/**
 * Structural equality with JSON semantics: same type, same members, key
 * order irrelevant. `NaN` is not equal to itself, following `===`, and a
 * key present with value `undefined` is not equal to a missing key, because
 * the two differ once the value is serialized.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** A single-line, length-capped rendering of a value, for error messages. */
export function preview(value: unknown, maxChars = 120): string {
  let text: string;
  if (value === undefined) {
    text = "undefined";
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ");
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
