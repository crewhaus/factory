/**
 * A hand-written TOML reader and writer. As with the YAML module, there is
 * no dependency behind it, so the supported subset below is the contract.
 *
 * ## Read: supported
 *
 * - `key = value` pairs, bare, quoted and dotted keys (`a.b.c = 1`).
 * - Tables `[a.b]` and arrays of tables `[[a.b]]`, at any depth.
 * - Basic strings `"..."` with the standard escapes including `\uXXXX` and
 *   `\UXXXXXXXX`, literal strings `'...'`, and the multi-line `"""..."""`
 *   and `'''...'''` forms, with the leading-newline trim and the backslash
 *   line continuation.
 * - Integers, including `_` separators and `0x` / `0o` / `0b` literals.
 * - Floats, including exponents, `inf` and `nan`.
 * - Booleans, arrays (nested, multi-line, with trailing commas) and inline
 *   tables `{ a = 1, b = "x" }`.
 * - `#` comments.
 *
 * ## Read: deliberate departures, each documented rather than silent
 *
 * - **Dates and times stay strings.** TOML has first-class offset date-time,
 *   local date-time, date and time types. JSON has none of them, so
 *   converting to a `Date` would make a round trip lossy. `2026-01-01` reads
 *   back as the string `"2026-01-01"`.
 * - Redefining a table or key is an error, as the spec requires — including
 *   both halves of the rule: a `[header]` may not reopen a table a dotted
 *   key created, and a dotted key may not reach into a table a `[header]`
 *   already defined.
 * - `inf` and `nan` read as the JavaScript infinities and NaN and write back
 *   out as `inf` / `nan`, but JSON cannot spell them, so converting to JSON
 *   renders them `null`.
 * - Integers outside the JavaScript safe range are kept as strings rather
 *   than silently rounded.
 *
 * ## Write
 *
 * Scalars and scalar arrays first, then sub-tables, then arrays of tables —
 * which is the order that reads back identically. A value TOML cannot hold
 * (`null`) is skipped, and the writer reports which keys it dropped rather
 * than pretending the output is complete.
 */

import { isPlainObject } from "./json";

export class TomlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

type Cursor = { text: string; i: number; line: number };

/** Parse a TOML document into JSON values. Throws `TomlError` with a line number. */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const cur: Cursor = { text: text.replace(/\r\n?/g, "\n"), i: 0, line: 1 };
  // Tables created by a `[header]`, and tables brought into being implicitly
  // by a dotted key (`a.b = 1` creates `a`). The spec forbids each from
  // redefining the other, so both have to be remembered.
  const defined = new Set<string>();
  const dotted = new Set<string>();
  let table: Record<string, unknown> = root;
  let tablePath: string[] = [];

  for (;;) {
    skipWhitespaceAndComments(cur);
    if (cur.i >= cur.text.length) break;
    if (cur.text[cur.i] === "[") {
      const isArray = cur.text[cur.i + 1] === "[";
      cur.i += isArray ? 2 : 1;
      const path = readKeyPath(cur, isArray ? "]]" : "]");
      const key = path.join(".");
      if (isArray) {
        table = pushArrayTable(root, path, cur);
        tablePath = path;
      } else {
        if (defined.has(key)) {
          throw new TomlError(`table [${key}] is defined twice`, cur.line);
        }
        if (dotted.has(key)) {
          throw new TomlError(
            `table [${key}] was already created by a dotted key, so it cannot be defined again`,
            cur.line,
          );
        }
        defined.add(key);
        table = descend(root, path, cur);
        tablePath = path;
      }
      expectLineEnd(cur);
      continue;
    }
    const path = readKeyPath(cur, "=");
    const value = readValue(cur);
    assign(table, path, value, cur, tablePath, { defined, dotted });
    expectLineEnd(cur);
  }
  return root;
}

function skipWhitespaceAndComments(c: Cursor): void {
  for (;;) {
    const ch = c.text[c.i];
    if (ch === " " || ch === "\t") {
      c.i += 1;
      continue;
    }
    if (ch === "\n") {
      c.i += 1;
      c.line += 1;
      continue;
    }
    if (ch === "#") {
      while (c.i < c.text.length && c.text[c.i] !== "\n") c.i += 1;
      continue;
    }
    return;
  }
}

function skipInlineSpace(c: Cursor): void {
  while (c.text[c.i] === " " || c.text[c.i] === "\t") c.i += 1;
}

function expectLineEnd(c: Cursor): void {
  skipInlineSpace(c);
  if (c.text[c.i] === "#") {
    while (c.i < c.text.length && c.text[c.i] !== "\n") c.i += 1;
  }
  const ch = c.text[c.i];
  if (ch === undefined) return;
  if (ch !== "\n") {
    throw new TomlError(`unexpected ${JSON.stringify(ch)} after a value`, c.line);
  }
  c.i += 1;
  c.line += 1;
}

const BARE_KEY = /[A-Za-z0-9_-]/;

function readKeyPath(c: Cursor, terminator: string): string[] {
  const path: string[] = [];
  for (;;) {
    skipInlineSpace(c);
    const ch = c.text[c.i];
    if (ch === '"' || ch === "'") {
      path.push(readString(c));
    } else {
      const start = c.i;
      while (c.i < c.text.length && BARE_KEY.test(c.text[c.i] as string)) c.i += 1;
      if (c.i === start) throw new TomlError("expected a key", c.line);
      path.push(c.text.slice(start, c.i));
    }
    skipInlineSpace(c);
    if (c.text[c.i] === ".") {
      c.i += 1;
      continue;
    }
    if (c.text.startsWith(terminator, c.i)) {
      c.i += terminator.length;
      return path;
    }
    throw new TomlError(
      `expected ${JSON.stringify(terminator)} after the key, got ${JSON.stringify(
        c.text[c.i] ?? "end of file",
      )}`,
      c.line,
    );
  }
}

function descend(
  root: Record<string, unknown>,
  path: ReadonlyArray<string>,
  c: Cursor,
): Record<string, unknown> {
  let node: Record<string, unknown> = root;
  path.forEach((seg, idx) => {
    const existing = node[seg];
    if (existing === undefined) {
      const fresh: Record<string, unknown> = {};
      node[seg] = fresh;
      node = fresh;
      return;
    }
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (!isPlainObject(last)) {
        throw new TomlError(`cannot descend into "${path.slice(0, idx + 1).join(".")}"`, c.line);
      }
      node = last as Record<string, unknown>;
      return;
    }
    if (!isPlainObject(existing)) {
      throw new TomlError(
        `"${path.slice(0, idx + 1).join(".")}" is already a value, not a table`,
        c.line,
      );
    }
    node = existing as Record<string, unknown>;
  });
  return node;
}

function pushArrayTable(
  root: Record<string, unknown>,
  path: ReadonlyArray<string>,
  c: Cursor,
): Record<string, unknown> {
  const parent = descend(root, path.slice(0, -1), c);
  const key = path[path.length - 1] as string;
  const existing = parent[key];
  const fresh: Record<string, unknown> = {};
  if (existing === undefined) {
    parent[key] = [fresh];
    return fresh;
  }
  if (!Array.isArray(existing)) {
    throw new TomlError(`"${path.join(".")}" is already a table, not an array of tables`, c.line);
  }
  existing.push(fresh);
  return fresh;
}

/**
 * Assign a (possibly dotted) key inside the current table.
 *
 * `tables` is passed for a document-level assignment and omitted inside an
 * inline table, whose keys are scoped to that table and cannot redefine
 * anything outside it. When it is passed, every table the dotted key brings
 * into being is recorded, and a dotted key that reaches into a table already
 * written as a `[header]` is refused — the two halves of the spec's "a table
 * may not be defined twice".
 */
function assign(
  table: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
  c: Cursor,
  tablePath: ReadonlyArray<string>,
  tables?: { defined: Set<string>; dotted: Set<string> },
): void {
  let node = table;
  path.slice(0, -1).forEach((seg, idx) => {
    const absolute = [...tablePath, ...path.slice(0, idx + 1)].join(".");
    if (tables !== undefined) {
      if (tables.defined.has(absolute)) {
        throw new TomlError(
          `"${absolute}" is already a table defined by [${absolute}], so a dotted key cannot extend it`,
          c.line,
        );
      }
      tables.dotted.add(absolute);
    }
    const existing = node[seg];
    if (existing === undefined) {
      const fresh: Record<string, unknown> = {};
      node[seg] = fresh;
      node = fresh;
      return;
    }
    if (!isPlainObject(existing)) {
      throw new TomlError(`"${[...tablePath, ...path].join(".")}" collides with a value`, c.line);
    }
    node = existing as Record<string, unknown>;
  });
  const key = path[path.length - 1] as string;
  if (Object.hasOwn(node, key)) {
    throw new TomlError(`key "${[...tablePath, ...path].join(".")}" is defined twice`, c.line);
  }
  node[key] = value;
}

function readString(c: Cursor): string {
  const q = c.text[c.i];
  if (q === '"' && c.text.startsWith('"""', c.i)) return readMultiline(c, '"""', true);
  if (q === "'" && c.text.startsWith("'''", c.i)) return readMultiline(c, "'''", false);
  if (q === "'") {
    c.i += 1;
    const start = c.i;
    while (c.i < c.text.length && c.text[c.i] !== "'") {
      if (c.text[c.i] === "\n") throw new TomlError("unterminated literal string", c.line);
      c.i += 1;
    }
    if (c.i >= c.text.length) throw new TomlError("unterminated literal string", c.line);
    const out = c.text.slice(start, c.i);
    c.i += 1;
    return out;
  }
  if (q !== '"') throw new TomlError("expected a string", c.line);
  c.i += 1;
  let out = "";
  for (;;) {
    const ch = c.text[c.i];
    if (ch === undefined || ch === "\n") throw new TomlError("unterminated string", c.line);
    if (ch === '"') {
      c.i += 1;
      return out;
    }
    if (ch === "\\") {
      out += readEscape(c);
      continue;
    }
    out += ch;
    c.i += 1;
  }
}

function readMultiline(c: Cursor, delim: string, basic: boolean): string {
  c.i += 3;
  if (c.text[c.i] === "\n") {
    c.i += 1;
    c.line += 1;
  }
  let out = "";
  for (;;) {
    if (c.i >= c.text.length) throw new TomlError("unterminated multi-line string", c.line);
    if (c.text.startsWith(delim, c.i)) {
      c.i += 3;
      return out;
    }
    const ch = c.text[c.i] as string;
    if (basic && ch === "\\") {
      if (/^\\[ \t]*\n/.test(c.text.slice(c.i))) {
        // Line continuation: swallow the newline and the following whitespace.
        c.i += 1;
        while (c.i < c.text.length && /[ \t\n]/.test(c.text[c.i] as string)) {
          if (c.text[c.i] === "\n") c.line += 1;
          c.i += 1;
        }
        continue;
      }
      out += readEscape(c);
      continue;
    }
    if (ch === "\n") c.line += 1;
    out += ch;
    c.i += 1;
  }
}

function readEscape(c: Cursor): string {
  c.i += 1;
  const ch = c.text[c.i];
  c.i += 1;
  switch (ch) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "u":
    case "U": {
      const width = ch === "u" ? 4 : 8;
      const hex = c.text.slice(c.i, c.i + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
        throw new TomlError(`bad escape ${JSON.stringify(hex)}`, c.line);
      }
      c.i += width;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    default:
      throw new TomlError(`unknown escape for ${JSON.stringify(ch ?? "")}`, c.line);
  }
}

const DATE_LIKE =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}:\d{2}(\.\d+)?$/;

function readValue(c: Cursor): unknown {
  skipInlineSpace(c);
  const ch = c.text[c.i];
  if (ch === undefined) throw new TomlError("expected a value", c.line);
  if (ch === '"' || ch === "'") return readString(c);
  if (ch === "[") return readArray(c);
  if (ch === "{") return readInlineTable(c);
  const start = c.i;
  while (c.i < c.text.length && !"\n,]}#".includes(c.text[c.i] as string)) c.i += 1;
  const raw = c.text.slice(start, c.i).trim();
  if (raw === "") throw new TomlError("expected a value", c.line);
  return scalarFromToken(raw, c.line);
}

/** Type a bare TOML token. Exported so the tests can pin the exact rules. */
export function scalarFromToken(raw: string, line: number): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (DATE_LIKE.test(raw)) return raw; // dates stay strings — see the module note
  if (/^[+-]?inf$/.test(raw)) {
    return raw.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (/^[+-]?nan$/.test(raw)) return Number.NaN;
  const cleaned = raw.replace(/_/g, "");
  if (/^[+-]?(0|[1-9][0-9]*)$/.test(cleaned)) {
    const n = Number(cleaned);
    return Number.isSafeInteger(n) ? n : raw;
  }
  if (/^0x[0-9a-fA-F]+$/.test(cleaned)) return Number.parseInt(cleaned.slice(2), 16);
  if (/^0o[0-7]+$/.test(cleaned)) return Number.parseInt(cleaned.slice(2), 8);
  if (/^0b[01]+$/.test(cleaned)) return Number.parseInt(cleaned.slice(2), 2);
  if (/^[+-]?([0-9]+(\.[0-9]+)?)([eE][+-]?[0-9]+)?$/.test(cleaned) && /[.eE]/.test(cleaned)) {
    return Number(cleaned);
  }
  throw new TomlError(`cannot read ${JSON.stringify(raw)} as a value`, line);
}

function readArray(c: Cursor): unknown[] {
  c.i += 1;
  const out: unknown[] = [];
  for (;;) {
    skipWhitespaceAndComments(c);
    if (c.text[c.i] === "]") {
      c.i += 1;
      return out;
    }
    if (c.i >= c.text.length) throw new TomlError("unterminated array", c.line);
    out.push(readValue(c));
    skipWhitespaceAndComments(c);
    if (c.text[c.i] === ",") {
      c.i += 1;
      continue;
    }
    if (c.text[c.i] === "]") {
      c.i += 1;
      return out;
    }
    throw new TomlError("expected ',' or ']' in an array", c.line);
  }
}

function readInlineTable(c: Cursor): Record<string, unknown> {
  c.i += 1;
  const out: Record<string, unknown> = {};
  skipInlineSpace(c);
  if (c.text[c.i] === "}") {
    c.i += 1;
    return out;
  }
  for (;;) {
    const path = readKeyPath(c, "=");
    const value = readValue(c);
    assign(out, path, value, c, []);
    skipInlineSpace(c);
    if (c.text[c.i] === ",") {
      c.i += 1;
      continue;
    }
    if (c.text[c.i] === "}") {
      c.i += 1;
      return out;
    }
    throw new TomlError("expected ',' or '}' in an inline table", c.line);
  }
}

// ---------------------------------------------------------------------------
// Writing

const BARE_KEY_FULL = /^[A-Za-z0-9_-]+$/;

function writeKey(key: string): string {
  return BARE_KEY_FULL.test(key) ? key : JSON.stringify(key);
}

function writeTomlScalar(value: unknown): string {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(writeTomlScalar).join(", ")}]`;
  if (isPlainObject(value)) {
    const inner = Object.keys(value)
      .filter((k) => value[k] !== null && value[k] !== undefined)
      .map((k) => `${writeKey(k)} = ${writeTomlScalar(value[k])}`);
    return `{ ${inner.join(", ")} }`;
  }
  return JSON.stringify(String(value));
}

function isTableArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}

export type TomlWriteResult = { text: string; skipped: string[] };

/**
 * Serialize an object as TOML. Returns the text plus the dotted paths of any
 * keys that were dropped because TOML has no representation for them
 * (`null` and `undefined`).
 */
export function stringifyToml(value: unknown): TomlWriteResult {
  if (!isPlainObject(value)) {
    throw new TomlError("TOML documents must be objects at the top level", 0);
  }
  const skipped: string[] = [];
  const lines: string[] = [];
  emitTable(value, [], lines, skipped);
  return { text: lines.join("\n"), skipped };
}

function emitTable(
  table: Record<string, unknown>,
  path: ReadonlyArray<string>,
  lines: string[],
  skipped: string[],
  headerAlreadyWritten = false,
): void {
  const scalars: string[] = [];
  const subTables: [string, Record<string, unknown>][] = [];
  const tableArrays: [string, Record<string, unknown>[]][] = [];

  for (const key of Object.keys(table)) {
    const v = table[key];
    if (v === null || v === undefined) {
      skipped.push([...path, key].join("."));
      continue;
    }
    if (isTableArray(v)) {
      tableArrays.push([key, v]);
      continue;
    }
    if (isPlainObject(v)) {
      subTables.push([key, v as Record<string, unknown>]);
      continue;
    }
    scalars.push(`${writeKey(key)} = ${writeTomlScalar(v)}`);
  }

  const needsHeader =
    !headerAlreadyWritten &&
    path.length > 0 &&
    (scalars.length > 0 || (subTables.length === 0 && tableArrays.length === 0));
  if (needsHeader) {
    if (lines.length > 0) lines.push("");
    lines.push(`[${path.map(writeKey).join(".")}]`);
  }
  lines.push(...scalars);

  for (const [key, sub] of subTables) {
    emitTable(sub, [...path, key], lines, skipped);
  }
  for (const [key, arr] of tableArrays) {
    const childPath = [...path, key];
    for (const element of arr) {
      if (lines.length > 0) lines.push("");
      lines.push(`[[${childPath.map(writeKey).join(".")}]]`);
      emitTable(element, childPath, lines, skipped, true);
    }
  }
}
