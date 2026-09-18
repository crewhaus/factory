/**
 * Locating one member of a JSON document, as offsets into the original text.
 *
 * `JSON.parse` followed by `JSON.stringify` is the obvious way to bump a
 * version in a package.json and it is the wrong one: it reprints the whole
 * file. Two-space indentation becomes four or none, a trailing newline
 * appears or vanishes, key order survives only by accident of insertion
 * order, and every line of the file shows up in the diff of a one-character
 * change. So the value is found HERE, as a span, and the write is a splice.
 *
 * The scan is deliberately small and strict. It is not a JSON parser for
 * general use — `JSON.parse` is right there for reading — it exists to answer
 * "where exactly are the bytes of `dependencies.left-pad`", and to refuse
 * when that question has no single answer.
 */

export type JsonSpan = { readonly start: number; readonly end: number };

export type JsonLocateFailure = "missing" | "malformed" | "duplicate" | "notAnObject";

export type JsonLocate =
  | {
      readonly ok: true;
      /** The value as written, quotes included when it is a string. */
      readonly valueSpan: JsonSpan;
      readonly isString: boolean;
      /** The string's contents, without the quotes. Absent for non-strings. */
      readonly inner?: JsonSpan;
    }
  | { readonly ok: false; readonly kind: JsonLocateFailure; readonly reason: string };

function skipWs(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    // A byte-order mark is not whitespace to the language, but it is exactly
    // as meaningless here — and a manifest written on Windows can start with
    // one, which would otherwise read as "this is not an object".
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\ufeff") i += 1;
    else break;
  }
  return i;
}

type Read = { end: number } | null;

/** The offset past a JSON string starting at `from` (which must be a quote). */
function readString(text: string, from: number): Read {
  if (text[from] !== '"') return null;
  let i = from + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return { end: i + 1 };
    if (c === undefined) return null;
    i += 1;
  }
  return null;
}

/** Decode the escapes in a string span so a key compares as the text it means. */
function decodeString(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** The offset past any JSON value starting at `from`. */
function readValue(text: string, from: number): Read {
  const c = text[from];
  if (c === undefined) return null;
  if (c === '"') return readString(text, from);
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    let depth = 0;
    let i = from;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        const str = readString(text, i);
        if (str === null) return null;
        i = str.end;
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return ch === close ? { end: i + 1 } : null;
      }
      i += 1;
    }
    return null;
  }
  // number, true, false, null — everything up to the next structural byte.
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "," || ch === "}" || ch === "]" || ch === undefined) break;
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") break;
    i += 1;
  }
  return i === from ? null : { end: i };
}

type MemberHit = { valueStart: number; valueEnd: number };

/**
 * The value span of `key` in the object that starts at `from`.
 *
 * A key present twice is refused rather than resolved. `JSON.parse` keeps the
 * last one, a reader skimming the file sees the first, and a splice would
 * change whichever this scan reached — three answers to one question is how a
 * manifest ends up saying something nobody wrote.
 */
function memberOf(text: string, from: number, key: string): JsonLocate | MemberHit {
  if (text[from] !== "{") {
    return { ok: false, kind: "notAnObject", reason: `expected an object at offset ${from}` };
  }
  let i = skipWs(text, from + 1);
  let hit: MemberHit | undefined;
  if (text[i] === "}") {
    return { ok: false, kind: "missing", reason: `"${key}" is not declared` };
  }
  while (i < text.length) {
    const keyRead = readString(text, i);
    if (keyRead === null) {
      return { ok: false, kind: "malformed", reason: `unreadable key at offset ${i}` };
    }
    const name = decodeString(text.slice(i, keyRead.end));
    if (name === null) {
      return { ok: false, kind: "malformed", reason: `unreadable key at offset ${i}` };
    }
    const colon = skipWs(text, keyRead.end);
    if (text[colon] !== ":") {
      return { ok: false, kind: "malformed", reason: `expected ":" at offset ${colon}` };
    }
    const valueStart = skipWs(text, colon + 1);
    const value = readValue(text, valueStart);
    if (value === null) {
      return { ok: false, kind: "malformed", reason: `unreadable value at offset ${valueStart}` };
    }
    if (name === key) {
      if (hit !== undefined) {
        return {
          ok: false,
          kind: "duplicate",
          reason: `"${key}" is declared more than once in the same object`,
        };
      }
      hit = { valueStart, valueEnd: value.end };
    }
    const next = skipWs(text, value.end);
    if (text[next] === ",") {
      i = skipWs(text, next + 1);
      continue;
    }
    if (text[next] === "}") break;
    return { ok: false, kind: "malformed", reason: `expected "," or "}" at offset ${next}` };
  }
  if (hit === undefined) return { ok: false, kind: "missing", reason: `"${key}" is not declared` };
  return hit;
}

/** Find `path` (e.g. `["dependencies", "left-pad"]`) and return where it is. */
export function locateJsonMember(text: string, path: readonly string[]): JsonLocate {
  if (path.length === 0) {
    return { ok: false, kind: "malformed", reason: "no member path was given" };
  }
  let at = skipWs(text, 0);
  for (let depth = 0; depth < path.length; depth++) {
    const result = memberOf(text, at, path[depth] as string);
    if ("ok" in result) {
      if (result.ok) return result;
      // Name the segment that was missing, not just the leaf: "dependencies"
      // being absent and "left-pad" being absent are different fixes.
      return depth === path.length - 1
        ? result
        : { ok: false, kind: result.kind, reason: `${result.reason} (at "${path[depth]}")` };
    }
    at = result.valueStart;
    if (depth === path.length - 1) {
      const isString = text[result.valueStart] === '"';
      return {
        ok: true,
        valueSpan: { start: result.valueStart, end: result.valueEnd },
        isString,
        ...(isString ? { inner: { start: result.valueStart + 1, end: result.valueEnd - 1 } } : {}),
      };
    }
  }
  return { ok: false, kind: "missing", reason: "not found" };
}
