/**
 * A TOML *locator*, not a TOML parser.
 *
 * `ManifestDependencySet` has to change one version inside a Cargo.toml or a
 * pyproject.toml and leave every other byte alone — comments, key order,
 * alignment, the blank line somebody put there on purpose. There is no
 * comment-preserving TOML CST in this repository's dependency set, and adding
 * a plain TOML parser would be worse than useless: parse-then-serialise is
 * exactly the operation that loses the comments.
 *
 * So nothing here builds a value tree. This walks the document once and
 * records WHERE each table header and each key/value pair is, as offsets into
 * the original text. A write is then a splice of one span, and everything
 * outside that span is untouched by construction — the strongest guarantee
 * available, and much stronger than "the serialiser usually round-trips".
 *
 * The scan fails closed. Anything it cannot tokenise — an unterminated
 * string, a header that does not close, a key it cannot read — stops the scan
 * with a reason, and the caller refuses the edit. A locator that guesses is a
 * corrupt manifest with extra steps.
 */

export type Span = { readonly start: number; readonly end: number };

export type TomlValueKind =
  | "basicString"
  | "literalString"
  | "multilineString"
  | "array"
  | "inlineTable"
  | "scalar";

export type TomlEntry = {
  /** Unquoted key parts: `a."b c".d` is ["a", "b c", "d"]. */
  readonly keyParts: readonly string[];
  readonly keySpan: Span;
  /** The value exactly as written, quotes included. */
  readonly valueSpan: Span;
  readonly kind: TomlValueKind;
};

export type TomlTable = {
  /** Unquoted header parts; `[]` for the implicit root table. */
  readonly path: readonly string[];
  readonly arrayOfTables: boolean;
  readonly headerSpan?: Span;
  readonly entries: readonly TomlEntry[];
};

export type TomlScan =
  | { readonly ok: true; readonly tables: readonly TomlTable[] }
  | { readonly ok: false; readonly reason: string };

// The byte-order mark a Windows editor leaves at the head of the file is not
// TOML whitespace, but treating it as such is the difference between reading
// the file and refusing it.
const WHITESPACE = new Set([" ", "\t", "\r", "\n", "\ufeff"]);
const BARE_KEY_CHARS = /^[A-Za-z0-9_-]$/;

/** Where offset `at` is, in 1-based line/column, for a message a human reads. */
export function lineAt(text: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < text.length; i++) if (text[i] === "\n") line += 1;
  return line;
}

function skipTrivia(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c !== undefined && WHITESPACE.has(c)) {
      i += 1;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    break;
  }
  return i;
}

function skipSpaces(text: string, from: number): number {
  let i = from;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  return i;
}

type KeyRead = { parts: string[]; end: number } | null;

/** A bare, basic-quoted or literal-quoted key, possibly dotted. */
function readKey(text: string, from: number): KeyRead {
  const parts: string[] = [];
  let i = from;
  while (true) {
    i = skipSpaces(text, i);
    const c = text[i];
    if (c === '"' || c === "'") {
      const closed = readQuoted(text, i, c);
      if (closed === null) return null;
      parts.push(closed.value);
      i = closed.end;
    } else {
      const start = i;
      while (i < text.length) {
        const ch = text[i];
        if (ch === undefined || !BARE_KEY_CHARS.test(ch)) break;
        i += 1;
      }
      if (i === start) return null;
      parts.push(text.slice(start, i));
    }
    const after = skipSpaces(text, i);
    if (text[after] === ".") {
      i = after + 1;
      continue;
    }
    return { parts, end: after };
  }
}

type QuotedRead = { value: string; end: number } | null;

/** A single-line quoted string starting at `from`; `end` is past the close. */
function readQuoted(text: string, from: number, quote: string): QuotedRead {
  let i = from + 1;
  let value = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") return null;
    if (quote === '"' && c === "\\") {
      // The value is only used for key comparison, so an escape is kept
      // verbatim rather than decoded — a key with an escape in it will simply
      // not match a plain package name, which is the safe outcome.
      value += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === quote) return { value, end: i + 1 };
    value += c ?? "";
    i += 1;
  }
  return null;
}

type ValueRead = { kind: TomlValueKind; end: number } | null;

function readValue(text: string, from: number): ValueRead {
  const c = text[from];
  if (c === undefined) return null;
  if (text.startsWith('"""', from) || text.startsWith("'''", from)) {
    const marker = text.slice(from, from + 3);
    const close = text.indexOf(marker, from + 3);
    if (close === -1) return null;
    return { kind: "multilineString", end: close + 3 };
  }
  if (c === '"' || c === "'") {
    const quoted = readQuoted(text, from, c);
    if (quoted === null) return null;
    return { kind: c === '"' ? "basicString" : "literalString", end: quoted.end };
  }
  if (c === "[" || c === "{") {
    const end = readBalanced(text, from);
    if (end === null) return null;
    return { kind: c === "[" ? "array" : "inlineTable", end };
  }
  // A bare scalar runs to the end of the line or to a comment. TOML forbids
  // `#` inside an unquoted value, so the first one ends the value.
  let i = from;
  while (i < text.length && text[i] !== "\n" && text[i] !== "#") i += 1;
  let end = i;
  while (
    end > from &&
    (text[end - 1] === " " || text[end - 1] === "\t" || text[end - 1] === "\r")
  ) {
    end -= 1;
  }
  if (end === from) return null;
  return { kind: "scalar", end };
}

/**
 * The offset past the bracket or brace that closes the one at `from`, with
 * strings and comments skipped so a `]` inside a string or a `#` inside an
 * array does not end it early.
 */
function readBalanced(text: string, from: number): number | null {
  const open = text[from];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
        const marker = text.slice(i, i + 3);
        const closeAt = text.indexOf(marker, i + 3);
        if (closeAt === -1) return null;
        i = closeAt + 3;
        continue;
      }
      const quoted = readQuoted(text, i, c);
      if (quoted === null) return null;
      i = quoted.end;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") {
      if (c !== close && depth === 1) return null;
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return null;
}

/** Walk a document and record every table header and key/value span. */
export function scanToml(text: string): TomlScan {
  const tables: TomlTable[] = [];
  let entries: TomlEntry[] = [];
  let path: readonly string[] = [];
  let arrayOfTables = false;
  let headerSpan: Span | undefined;

  const flush = (): void => {
    if (path.length === 0 && entries.length === 0 && headerSpan === undefined) return;
    tables.push({
      path,
      arrayOfTables,
      ...(headerSpan === undefined ? {} : { headerSpan }),
      entries,
    });
  };

  let i = skipTrivia(text, 0);
  while (i < text.length) {
    if (text[i] === "[") {
      flush();
      entries = [];
      const isArray = text[i + 1] === "[";
      const headerStart = i;
      const key = readKey(text, i + (isArray ? 2 : 1));
      if (key === null) {
        return { ok: false, reason: `unreadable table header at line ${lineAt(text, i)}` };
      }
      let after = skipSpaces(text, key.end);
      if (text[after] !== "]") {
        return { ok: false, reason: `unterminated table header at line ${lineAt(text, i)}` };
      }
      after += 1;
      if (isArray) {
        if (text[after] !== "]") {
          return {
            ok: false,
            reason: `unterminated array-of-tables header at line ${lineAt(text, i)}`,
          };
        }
        after += 1;
      }
      path = key.parts;
      arrayOfTables = isArray;
      headerSpan = { start: headerStart, end: after };
      i = skipTrivia(text, after);
      continue;
    }

    const key = readKey(text, i);
    if (key === null) {
      return { ok: false, reason: `unreadable key at line ${lineAt(text, i)}` };
    }
    const keySpan: Span = { start: i, end: key.end };
    const eq = skipSpaces(text, key.end);
    if (text[eq] !== "=") {
      return { ok: false, reason: `expected "=" after a key at line ${lineAt(text, i)}` };
    }
    const valueStart = skipSpaces(text, eq + 1);
    const value = readValue(text, valueStart);
    if (value === null) {
      return { ok: false, reason: `unreadable value at line ${lineAt(text, valueStart)}` };
    }
    entries.push({
      keyParts: key.parts,
      keySpan,
      valueSpan: { start: valueStart, end: value.end },
      kind: value.kind,
    });
    i = skipTrivia(text, value.end);
  }
  flush();
  return { ok: true, tables };
}

/**
 * Every place a full dotted path is declared, wherever TOML allows it to be
 * written: as an entry of the table that owns it, as a dotted key inside a
 * shallower table, or as a table of its own. `[dependencies] serde = "1"`,
 * `serde.version = "1"` and `[dependencies.serde] version = "1"` are the same
 * path spelled three ways, and a locator that knew only one of them would
 * silently fail to find two thirds of real Cargo manifests.
 */
export function lookupPath(
  scan: { readonly tables: readonly TomlTable[] },
  fullPath: readonly string[],
): Array<{ table: TomlTable; entry: TomlEntry }> {
  const found: Array<{ table: TomlTable; entry: TomlEntry }> = [];
  for (const table of scan.tables) {
    if (table.path.length > fullPath.length) continue;
    if (!table.path.every((part, index) => part === fullPath[index])) continue;
    const rest = fullPath.slice(table.path.length);
    for (const entry of table.entries) {
      if (entry.keyParts.length !== rest.length) continue;
      if (entry.keyParts.every((part, index) => part === rest[index])) found.push({ table, entry });
    }
  }
  return found;
}

/** The span of a single-line string's CONTENT, and the quote around it. */
export function stringInner(
  text: string,
  entryKind: TomlValueKind,
  span: Span,
): { inner: Span; quote: '"' | "'" } | null {
  if (entryKind !== "basicString" && entryKind !== "literalString") return null;
  const quote = text[span.start];
  if (quote !== '"' && quote !== "'") return null;
  return { inner: { start: span.start + 1, end: span.end - 1 }, quote };
}

/**
 * The key/value pairs of an inline table, with spans in the ORIGINAL text so
 * a caller can splice one of them without touching the rest of the line.
 */
export function inlineTableEntries(text: string, span: Span): TomlEntry[] | null {
  const entries: TomlEntry[] = [];
  let i = span.start + 1;
  const end = span.end - 1;
  while (true) {
    i = skipTrivia(text, i);
    if (i >= end) break;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    const key = readKey(text, i);
    if (key === null) return null;
    const keySpan: Span = { start: i, end: key.end };
    const eq = skipSpaces(text, key.end);
    if (text[eq] !== "=") return null;
    const valueStart = skipSpaces(text, eq + 1);
    const value = readInlineValue(text, valueStart, end);
    if (value === null) return null;
    entries.push({
      keyParts: key.parts,
      keySpan,
      valueSpan: { start: valueStart, end: value.end },
      kind: value.kind,
    });
    i = value.end;
  }
  return entries;
}

/** Like `readValue`, but a bare scalar stops at a comma or the closing brace. */
function readInlineValue(text: string, from: number, limit: number): ValueRead {
  const c = text[from];
  if (c === undefined) return null;
  if (c === '"' || c === "'" || c === "[" || c === "{") return readValue(text, from);
  let i = from;
  while (i < limit && text[i] !== "," && text[i] !== "}" && text[i] !== "\n") i += 1;
  let end = i;
  while (end > from && (text[end - 1] === " " || text[end - 1] === "\t")) end -= 1;
  if (end === from) return null;
  return { kind: "scalar", end };
}

/**
 * Every element of an array of single-line strings, with its content span.
 * `null` when the array holds anything else — a nested array, an inline
 * table, a multi-line string — because a caller that cannot see every element
 * must not edit any of them.
 */
export function stringArrayElements(
  text: string,
  span: Span,
): Array<{ value: string; inner: Span; quote: '"' | "'" }> | null {
  const out: Array<{ value: string; inner: Span; quote: '"' | "'" }> = [];
  let i = span.start + 1;
  const end = span.end - 1;
  while (true) {
    i = skipTrivia(text, i);
    if (i >= end) break;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    const quote = text[i];
    if (quote !== '"' && quote !== "'") return null;
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) return null;
    const quoted = readQuoted(text, i, quote);
    if (quoted === null) return null;
    out.push({ value: quoted.value, inner: { start: i + 1, end: quoted.end - 1 }, quote });
    i = quoted.end;
  }
  return out;
}
