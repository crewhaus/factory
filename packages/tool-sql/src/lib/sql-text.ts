/**
 * SQL text handling — the pure half of this package.
 *
 * Nothing here decides whether a statement is ALLOWED to run: that is
 * SQLite's job, and `../db.ts` gives it to SQLite by opening the connection
 * read-only. What lives here is the lexical work that has to happen before a
 * statement reaches SQLite at all:
 *
 *   - blanking strings and comments, so every other check below looks at
 *     code rather than at data that happens to spell a keyword;
 *   - counting statements, because `bun:sqlite`'s `prepare` compiles only the
 *     FIRST statement in a string and silently discards the rest — a caller
 *     who writes `SELECT 1; INSERT …` would otherwise be told the call
 *     succeeded while the second half never ran;
 *   - finding the named parameters a statement actually declares, because
 *     binding an object whose keys do not match binds NULL silently;
 *   - refusing the handful of statements that reach the filesystem behind
 *     the path gate (`ATTACH`, `DETACH`, `VACUUM INTO`, `load_extension`).
 *
 * All of it is pure: same string in, same answer out, no clock, no I/O.
 */

/** A lexical pass over a statement or script. */
export type SqlScan = {
  /**
   * The input with every string literal, quoted identifier and comment
   * replaced position-for-position by spaces (newlines are kept, so line
   * numbers survive). Every keyword test in this file reads this, never the
   * raw SQL, so `SELECT '; DROP TABLE t;'` counts as one statement.
   */
  readonly stripped: string;
  /** True when a quote or block comment was still open at end of input. */
  readonly unterminated: boolean;
};

/** Blank out of `sql` everything that is data rather than code. */
export function scanSql(sql: string): SqlScan {
  const out: string[] = [];
  let unterminated = false;
  let i = 0;
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out.push(sql[k] === "\n" ? "\n" : " ");
  };
  while (i < n) {
    const ch = sql[i] as string;
    const next = i + 1 < n ? (sql[i + 1] as string) : "";
    if (ch === "-" && next === "-") {
      let end = sql.indexOf("\n", i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      if (close === -1) unterminated = true;
      blank(i, end);
      i = end;
      continue;
    }
    // Every quoting form SQLite accepts. `[…]` and backticks are the
    // MS-Access / MySQL identifier spellings SQLite still honours, and a
    // migration written against another engine will contain them.
    const closer =
      ch === "'" ? "'" : ch === '"' ? '"' : ch === "`" ? "`" : ch === "[" ? "]" : undefined;
    if (closer !== undefined) {
      let k = i + 1;
      let closed = false;
      while (k < n) {
        if (sql[k] === closer) {
          // A doubled closer is an escaped one — except for `]`, which
          // SQLite does not allow to be escaped at all.
          if (closer !== "]" && sql[k + 1] === closer) {
            k += 2;
            continue;
          }
          closed = true;
          k += 1;
          break;
        }
        k += 1;
      }
      if (!closed) unterminated = true;
      blank(i, k);
      i = k;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return { stripped: out.join(""), unterminated };
}

/** Uppercase word tokens of `stripped`, with the offset each one started at. */
function words(stripped: string): Array<{ word: string; at: number }> {
  const found: Array<{ word: string; at: number }> = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null = re.exec(stripped);
  while (m !== null) {
    found.push({ word: m[0].toUpperCase(), at: m.index });
    m = re.exec(stripped);
  }
  return found;
}

/**
 * Split a script into its statements.
 *
 * A `;` only ends a statement at block depth zero. `CREATE TRIGGER … BEGIN
 * … ; … END` and `CASE … END` both nest, and both are common in real
 * migrations, so a trigger body's `BEGIN` and a `CASE` open a block and
 * `END` closes one. `BEGIN` counts only inside a `CREATE … TRIGGER`,
 * because SQLite also accepts `begin` as a bare table name and a statement
 * reading from one is not a block. That is a heuristic, not a parser, and
 * it is used only for COUNTING and for the refusals below — never as a
 * security boundary. SQLite itself parses the script that actually
 * executes.
 */
export function splitStatements(sql: string): string[] {
  const { stripped } = scanSql(sql);
  const tokens = words(stripped);
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let tokenIndex = 0;
  let sawTokenInStatement = false;
  let firstWord: string | undefined;
  let inTrigger = false;
  for (let i = 0; i < stripped.length; i++) {
    while (tokenIndex < tokens.length && (tokens[tokenIndex] as { at: number }).at < i) {
      tokenIndex += 1;
    }
    const token = tokens[tokenIndex];
    if (token !== undefined && token.at === i) {
      if (token.word === "CASE") depth += 1;
      else if (token.word === "BEGIN") {
        // Only a trigger body's BEGIN opens a block. `BEGIN` is also one of
        // the keywords SQLite lets you use as a bare identifier, so
        // `SELECT * FROM begin; DROP TABLE t` is two statements and has to
        // be counted as two — treating every BEGIN as a block opener hid
        // the second one, which is the exact silent discard this count
        // exists to prevent.
        if (sawTokenInStatement && inTrigger) depth += 1;
      } else if (token.word === "END") depth = Math.max(0, depth - 1);
      else if (token.word === "TRIGGER" && firstWord === "CREATE") inTrigger = true;
      if (firstWord === undefined) firstWord = token.word;
      sawTokenInStatement = true;
    }
    if (stripped[i] === ";" && depth === 0) {
      const text = sql.slice(start, i).trim();
      if (text !== "") statements.push(text);
      start = i + 1;
      sawTokenInStatement = false;
      firstWord = undefined;
      inTrigger = false;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail !== "") statements.push(tail);
  return statements;
}

/** The first keyword of a statement, uppercased, or "" for an empty one. */
export function leadingKeyword(sql: string): string {
  const first = words(scanSql(sql).stripped)[0];
  return first === undefined ? "" : first.word;
}

/**
 * True for a character SQLite counts as part of a parameter's name.
 * `sqlite3IdChar`: letters, digits, `_`, `$`, and every byte past ASCII.
 */
function isIdChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/**
 * The named parameters a statement declares, in first-appearance order,
 * each with the sigil it was written with (`$id`, `:id`, `@id`).
 *
 * The grammar here is SQLite's tokenizer, not a simplification of it: after
 * `$`, `:` or `@` come one or more identifier characters — DIGITS INCLUDED,
 * so `:1` and `$1` are named parameters and not positional ones — and, for
 * the `$` spelling a compiler emits, `::suffix` and `(...)` continuations,
 * which are part of the name. A sigil with nothing usable after it is an
 * illegal token to SQLite rather than a parameter, and is skipped here too.
 *
 * Getting this wrong is not cosmetic. `bun:sqlite` binds a name only when
 * the key carries the sigil, and a parameter nobody binds is NULL with no
 * error at all: before this followed SQLite's rule, `SELECT $1` was read as
 * declaring nothing, the call was allowed to run with no values, and the
 * answer came back wrong and confident. `../db.ts` uses this list to map the
 * caller's keys onto the real names and to refuse a key that matches none,
 * and cross-checks the total against SQLite's own count once the statement
 * is compiled.
 */
export function namedParameters(sql: string): string[] {
  const { stripped } = scanSql(sql);
  const found: string[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const sigil = stripped[i] as string;
    if (sigil !== "$" && sigil !== ":" && sigil !== "@") continue;
    let cursor = i + 1;
    let nameChars = 0;
    let illegal = false;
    while (cursor < stripped.length) {
      const ch = stripped[cursor] as string;
      if (isIdChar(ch)) {
        nameChars += 1;
        cursor += 1;
        continue;
      }
      if (ch === "(" && nameChars > 0) {
        // `$name(...)` — SQLite swallows the whole suffix as part of the
        // name, and calls the token illegal when the `)` never arrives.
        cursor += 1;
        while (cursor < stripped.length && stripped[cursor] !== ")") cursor += 1;
        if (cursor >= stripped.length) illegal = true;
        else cursor += 1;
        break;
      }
      if (ch === ":" && stripped[cursor + 1] === ":") {
        cursor += 2;
        continue;
      }
      break;
    }
    if (nameChars === 0 || illegal) continue;
    const name = stripped.slice(i, cursor);
    if (!found.includes(name)) found.push(name);
    i = cursor - 1;
  }
  return found;
}

/**
 * How many positional values a statement expects, following SQLite's own
 * numbering rule rather than counting `?` characters.
 *
 * A bare `?` takes one more than the highest index assigned so far, and
 * `?NNN` takes exactly NNN. So `SELECT ?1, ?2, ?1` expects two values, not
 * three, and `SELECT ?3, ?` expects four. Counting characters instead would
 * make `bindParams` refuse a correct call — the kind of bug that sends a
 * caller looking for a problem in their data.
 */
export function positionalParameterCount(sql: string): number {
  const { stripped } = scanSql(sql);
  let highest = 0;
  let index = 0;
  while (index < stripped.length) {
    if (stripped[index] !== "?") {
      index += 1;
      continue;
    }
    let digits = "";
    let cursor = index + 1;
    while (/[0-9]/.test(stripped[cursor] ?? "")) {
      digits += stripped[cursor];
      cursor += 1;
    }
    highest = digits === "" ? highest + 1 : Math.max(highest, Number(digits));
    index = cursor;
  }
  return highest;
}

/**
 * Statements and functions no caller-supplied SQL may contain, with the
 * reason each one is refused.
 *
 * Every one of them reaches the filesystem by a route that does NOT pass
 * through `resolveSafe`, so allowing them would make the path gate
 * decorative. They are matched as whole words against the stripped text, so
 * the word inside a string literal or a column name is not a match. SQLite
 * cannot evaluate a string as SQL at run time, so a keyword absent from the
 * text cannot come into existence while the statement runs — which is what
 * makes a literal scan sound here.
 */
const FORBIDDEN: ReadonlyArray<{ word: string; why: string }> = [
  { word: "ATTACH", why: "it opens a second database file by a path this tool never validated" },
  { word: "DETACH", why: "it belongs with ATTACH, which is refused" },
  {
    word: "VACUUM",
    why: "`VACUUM INTO` writes a copy of the database to any path on the disk; use DatabaseBackup, which contains the destination",
  },
  {
    word: "LOAD_EXTENSION",
    why: "it loads and runs a shared library chosen by the caller",
  },
];

/**
 * The refusal reason for a forbidden construct in `sql`, or undefined.
 * Callers turn this into the sentence they return.
 */
export function forbiddenConstruct(sql: string): { word: string; why: string } | undefined {
  const { stripped } = scanSql(sql);
  const seen = new Set(words(stripped).map((w) => w.word));
  for (const entry of FORBIDDEN) if (seen.has(entry.word)) return entry;
  return undefined;
}

/**
 * True when `name` is safe to use as an identifier once quoted.
 *
 * Quoting with `"` and doubling any embedded `"` is by itself sufficient for
 * SQLite — the grammar allows every character but NUL inside a quoted name.
 * The extra validation is defence in depth against the one place quoting
 * does not save you: SQLite's double-quoted-string-literal misfeature, where
 * a quoted name that resolves to nothing is silently reinterpreted as a
 * string. Refusing control characters and empty names keeps identifiers to
 * shapes a human would recognise in an error message.
 */
export function isSafeIdentifier(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[ -]/.test(name)) return false;
  return name.trim() === name;
}

/** Quote an identifier for interpolation. Throws on a name that is not safe. */
export function quoteIdentifier(name: string): string {
  if (!isSafeIdentifier(name)) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the message must not carry them through.
    const shown = name.replace(/[ -]/g, "?");
    throw new Error(`"${shown}" is not a usable SQLite identifier`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Collapse whitespace so two spellings of the same DDL compare equal. */
export function normalizeDdl(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
