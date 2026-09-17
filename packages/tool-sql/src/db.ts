/**
 * The half of this package that touches a database file: opening one safely,
 * binding a caller's parameters to a caller's statement, stepping a result
 * set under a deadline and a memory cap, and turning a SQLite failure into a
 * sentence rather than a stack trace.
 *
 * Four invariants live here, and every tool in `./index` goes through them.
 *
 * 1. CONTAINMENT. Every database, migration directory and export destination
 *    is resolved by `resolveSafe` and refused if it lands outside the
 *    workspace root, symlinks included. The SQL itself is checked too: a
 *    statement may not contain ATTACH, DETACH, VACUUM or load_extension,
 *    each of which reaches a file by a route the path gate never sees.
 *
 * 2. READ-ONLY MEANS READ-ONLY. `SqlQuery` and the schema tools open the
 *    connection with SQLITE_OPEN_READONLY and let SQLite refuse the write.
 *    This is deliberate and it is the only sound option available here.
 *    Sniffing the leading keyword does not work — a CTE starts with WITH,
 *    and `WITH x AS (...) DELETE FROM t` is a write — and `bun:sqlite`'s
 *    `Statement` does not expose the `readonly` flag that better-sqlite3
 *    surfaces from `sqlite3_stmt_readonly` (checked against Bun 1.3: no such
 *    property exists on the prototype). What is left is the connection flag,
 *    which SQLite enforces for every statement, CTE-led or otherwise, and
 *    which also refuses `PRAGMA journal_mode=WAL` and every other write
 *    wearing a different hat. The read connections additionally set
 *    `PRAGMA query_only`, because SQLITE_OPEN_READONLY leaves the TEMP
 *    database writable and `CREATE TEMP TABLE … AS SELECT …` would
 *    otherwise run — and spill outside the workspace — from a connection
 *    the caller was told is read-only.
 *
 * 3. BOUNDEDNESS, honestly described. Result sets are stepped row by row, so
 *    both the row count and the bytes held in memory are capped, and the
 *    deadline is checked between rows. What that does NOT bound is a single
 *    step: a scan that reads a million pages before yielding its first row
 *    runs to completion, because `bun:sqlite` exposes neither
 *    `sqlite3_interrupt` nor a progress handler, and SQLite is synchronous —
 *    there is no thread on which to cancel it. `busy_timeout` is set from
 *    the same budget, which does bound the common hang (waiting on another
 *    writer's lock). A caller who needs a hard ceiling needs one around the
 *    harness process, not around this call.
 *
 * 4. DETERMINISM. Listings are sorted by plain codepoint comparison, never
 *    `localeCompare`. Nothing samples a random source. No wall-clock value
 *    reaches a result unless the caller asked for the column that holds it.
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { toBase64 } from "./lib/csv";
import {
  forbiddenConstruct,
  namedParameters,
  positionalParameterCount,
  scanSql,
  splitStatements,
} from "./lib/sql-text";
import { type SafePath, ToolPermissionError, describePath, resolveSafe } from "./paths";

/** Default wall-clock budget for one tool call. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Ceiling the schemas enforce, so no caller can ask for an unbounded wait. */
export const MAX_TIMEOUT_MS = 600_000;
/** Rows a single query returns unless the caller asks for fewer. */
export const DEFAULT_MAX_ROWS = 500;
/** Hard ceiling on rows, whatever the caller asks for. */
export const ROW_LIMIT = 100_000;
/**
 * Characters of serialized rows held in memory at once. This is the cap that
 * matters: a thousand rows of one megabyte each is not a small result just
 * because the row count is small.
 */
export const MAX_RESULT_CHARS = 400_000;
/** Bytes of a single BLOB returned inline; past this only the length is. */
export const MAX_BLOB_BYTES = 4_096;

/** A refusal carrying the exact sentence to return to the caller. */
export type Refusal = { readonly ok: false; readonly message: string };
export type Resolved<T> = { readonly ok: true; readonly value: T } | Refusal;

export const refuse = (message: string): Refusal => ({ ok: false, message });

/** Compact JSON — the reader is a model, not a person, so no indentation. */
export const json = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------
// opening

export type OpenMode = "read" | "write";

export type OpenOptions = {
  readonly mode: OpenMode;
  /** Create the file when it does not exist. Only meaningful in write mode. */
  readonly create?: boolean;
  /** Milliseconds a statement will wait for another writer's lock. */
  readonly timeoutMs?: number;
  /** Turn on `PRAGMA foreign_keys`. SQLite's own default is off. */
  readonly foreignKeys?: boolean;
  /**
   * Turn on `PRAGMA query_only`. Defaults to on in read mode, and the one
   * caller that needs it off is `DatabaseBackup`, whose `VACUUM INTO` is a
   * write by SQLite's reckoning even though it only writes the copy.
   */
  readonly queryOnly?: boolean;
};

export type OpenDatabase = {
  readonly db: Database;
  readonly path: SafePath;
};

/**
 * Resolve `file` inside the workspace and open it.
 *
 * In read mode the connection is SQLITE_OPEN_READONLY — see invariant 2 at
 * the top of this file. In write mode the file must already exist unless the
 * caller passes `create`, so a mistyped path reports "no such database"
 * instead of quietly producing an empty one and reporting success.
 */
export function openDatabase(
  toolName: string,
  file: string,
  options: OpenOptions,
): Resolved<OpenDatabase> {
  let safe: SafePath;
  try {
    safe = resolveSafe(toolName, file);
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return refuse(
        `${toolName} refused the path "${describePath(file)}": it resolves outside the workspace root. Pass a path inside the working directory.`,
      );
    }
    return refuse(`${toolName} could not resolve "${describePath(file)}": ${errorText(err)}`);
  }
  const exists = existsSync(safe.real);
  if (!exists && (options.mode === "read" || options.create !== true)) {
    return refuse(
      options.mode === "read"
        ? `${toolName} found no database at "${describePath(safe.rel)}". Check the path, or create one with SqlExec and create: true.`
        : `${toolName} found no database at "${describePath(safe.rel)}". Pass create: true to make a new one.`,
    );
  }
  if (exists) {
    try {
      if (statSync(safe.real).isDirectory()) {
        return refuse(`${toolName} refused "${safe.rel}": it is a directory, not a database file.`);
      }
    } catch (err) {
      return refuse(`${toolName} could not stat "${safe.rel}": ${errorText(err)}`);
    }
  }
  let db: Database;
  try {
    db =
      options.mode === "read"
        ? new Database(safe.real, { readonly: true })
        : new Database(safe.real, { create: options.create === true, readwrite: true });
  } catch (err) {
    return refuse(`${toolName} could not open "${safe.rel}": ${errorText(err)}`);
  }
  try {
    configure(db, options);
  } catch (err) {
    closeQuietly(db);
    return refuse(`${toolName} could not configure "${safe.rel}": ${errorText(err)}`);
  }
  // A file that is not a database only gives itself away on the first read.
  try {
    db.prepare("SELECT count(*) FROM sqlite_schema").get();
  } catch (err) {
    closeQuietly(db);
    return refuse(
      `${toolName} could not read "${safe.rel}" as a SQLite database: ${errorText(err)}. This package speaks SQLite only — not Postgres, not MySQL.`,
    );
  }
  return { ok: true, value: { db, path: safe } };
}

/**
 * Apply the connection settings.
 *
 * `PRAGMA busy_timeout` takes no bound parameter (SQLite's grammar has no
 * expression there), so the value is concatenated — from a number that has
 * been clamped and floored one line above, so the text is digits and nothing
 * else. It is the only place in this package where a value is written into
 * SQL rather than bound, and it is a value this package computes, never one
 * a caller supplies verbatim.
 */
function configure(db: Database, options: OpenOptions): void {
  const budget = Math.floor(
    Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)),
  );
  db.run(`PRAGMA busy_timeout = ${String(budget)}`);
  if (options.foreignKeys === true) db.run("PRAGMA foreign_keys = ON");
  // SQLITE_OPEN_READONLY refuses writes to the database FILE, and that is
  // the boundary that matters — but it leaves the TEMP database writable,
  // so `CREATE TEMP TABLE big AS SELECT * FROM huge` runs from a connection
  // a tool has told the caller is read-only, and spills to the temp
  // directory, which is outside the workspace. `query_only` closes that: it
  // is SQLite's own switch and it refuses every write, main or temp.
  const queryOnly = options.queryOnly ?? options.mode === "read";
  if (queryOnly) db.run("PRAGMA query_only = ON");
}

/** Close without letting a close failure mask the result being returned. */
export function closeQuietly(db: Database): void {
  try {
    db.close(false);
  } catch {
    // Already closed, or a statement is still in flight; neither changes
    // what the caller is about to be told.
  }
}

// ---------------------------------------------------------------------------
// statement checks

export type SqlGuardOptions = {
  /** Allow a script of several statements (migrations, SqlTransaction items). */
  readonly allowMultiple?: boolean;
};

/**
 * The checks every caller-supplied statement passes before SQLite sees it.
 *
 * Neither of these is the read-only boundary — that is the connection flag.
 * They catch the two things SQLite would NOT complain about: a forbidden
 * construct that escapes path containment, and a second statement that
 * `prepare` would compile away without telling anyone.
 */
export function guardSql(
  toolName: string,
  sql: string,
  options: SqlGuardOptions = {},
): Refusal | undefined {
  if (sql.trim() === "") return refuse(`${toolName} was given an empty statement.`);
  // An unterminated quote or block comment means the rest of the statement
  // was read as data, so every check below looked at less than the caller
  // wrote. Refusing here is clearer than the syntax error SQLite would give.
  if (scanSql(sql).unterminated) {
    return refuse(
      `${toolName} refused this statement: a quote or a /* comment is never closed, so the rest of it is being read as text.`,
    );
  }
  const forbidden = forbiddenConstruct(sql);
  if (forbidden !== undefined) {
    return refuse(
      `${toolName} refused this statement because it contains ${forbidden.word}: ${forbidden.why}.`,
    );
  }
  if (options.allowMultiple !== true) {
    const statements = splitStatements(sql);
    if (statements.length > 1) {
      return refuse(
        `${toolName} takes one statement, and this is ${statements.length}. bun:sqlite compiles only the first and discards the rest silently, so running this would report success for work that never happened. Send them one per call, or use SqlTransaction to apply them together.`,
      );
    }
  }
  return undefined;
}

/** What a caller may bind. SQLite stores no other JavaScript type natively. */
export type ParamValue = string | number | boolean | null;
export type ParamInput = ReadonlyArray<ParamValue> | Readonly<Record<string, ParamValue>>;

/** Bound arguments in the shape `bun:sqlite` wants them. */
export type BoundArgs = ReadonlyArray<ParamValue> | Record<string, ParamValue>;

/**
 * Match a caller's parameters to the statement's placeholders, or refuse.
 *
 * Two silent-wrong-answer bugs are closed here. An array whose length does
 * not match the `?` count binds the missing tail to NULL without error. And
 * `bun:sqlite` binds a named parameter only when the key carries its sigil,
 * so `{ id: 1 }` against `$id` binds NULL and reports nothing at all — the
 * query then returns the wrong rows and looks like it worked. Keys are
 * accepted with or without the sigil and mapped onto the real names, and a
 * key matching no placeholder is refused rather than ignored.
 *
 * Parameters are the ONLY way a caller value reaches a statement in this
 * package. No tool interpolates a caller string into SQL; the identifiers
 * the import tools must interpolate are validated and quoted separately.
 */
export function bindParams(
  toolName: string,
  sql: string,
  params: ParamInput | undefined,
): Resolved<BoundArgs> {
  const named = namedParameters(sql);
  const positional = positionalParameterCount(sql);
  if (params === undefined) {
    if (positional > 0 || named.length > 0) {
      const want = positional > 0 ? `${positional} positional parameter(s)` : named.join(", ");
      return refuse(`${toolName} needs params: this statement declares ${want}.`);
    }
    return { ok: true, value: [] };
  }
  if (Array.isArray(params)) {
    if (named.length > 0) {
      return refuse(
        `${toolName} was given a list of params, but this statement uses named parameters (${named.join(", ")}). Pass an object keyed by those names.`,
      );
    }
    if (params.length !== positional) {
      return refuse(
        `${toolName} was given ${params.length} param(s) for a statement with ${positional} placeholder(s). SQLite binds the difference to NULL without an error, so the counts must match.`,
      );
    }
    return { ok: true, value: params as ReadonlyArray<ParamValue> };
  }
  if (positional > 0) {
    return refuse(
      `${toolName} was given named params, but this statement uses ${positional} positional "?" placeholder(s). Pass a list, or rewrite the statement with $named parameters.`,
    );
  }
  const record = params as Readonly<Record<string, ParamValue>>;
  const bySuffix = new Map<string, string>();
  for (const name of named) bySuffix.set(name.slice(1), name);
  const bound: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(record)) {
    const target = named.includes(key) ? key : bySuffix.get(key);
    if (target === undefined) {
      return refuse(
        `${toolName} was given a param "${key}" that this statement never uses. Its parameters are: ${named.length === 0 ? "(none)" : named.join(", ")}.`,
      );
    }
    bound[target] = value;
  }
  const missing = named.filter((name) => !(name in bound));
  if (missing.length > 0) {
    return refuse(`${toolName} is missing a value for ${missing.join(", ")}.`);
  }
  return { ok: true, value: bound };
}

/**
 * SQLite's own count of the parameters in a compiled statement, or undefined
 * on a build that does not expose it (the same guarded-read arrangement as
 * `useSafeIntegers`, and for the same reason).
 */
export function declaredParameterCount(statement: unknown): number | undefined {
  const candidate = statement as { paramsCount?: unknown };
  return typeof candidate.paramsCount === "number" ? candidate.paramsCount : undefined;
}

/**
 * Cross-check what is about to be bound against what SQLite says the
 * statement declares, once the statement is compiled.
 *
 * `bindParams` works from a lexical scan, and a scan can be wrong about a
 * spelling SQLite accepts. SQLite's count cannot be. This is the backstop
 * that turns any such disagreement into a sentence instead of into NULLs
 * bound in silence and a wrong answer returned with confidence.
 */
export function parameterMismatch(
  sql: string,
  statement: unknown,
  args: BoundArgs,
): Refusal | undefined {
  const expected = declaredParameterCount(statement);
  if (expected === undefined) return undefined;
  const provided = Array.isArray(args) ? args.length : Object.keys(args).length;
  if (provided === expected) return undefined;
  return refuse(
    `SQLite compiled this statement with ${expected} parameter(s), and ${provided} value(s) were supplied. The difference would be bound to NULL without an error, so the call is refused instead. Statement: ${clip(sql)}`,
  );
}

/** Apply bound args to a `bun:sqlite` call, which spreads a list. */
// biome-ignore lint/suspicious/noExplicitAny: bun:sqlite's binding types are looser than ParamValue.
export function spreadArgs(args: BoundArgs): any[] {
  return Array.isArray(args) ? [...args] : [args];
}

// ---------------------------------------------------------------------------
// result shaping

/**
 * One SQLite value as JSON.
 *
 * Integers are read with `safeIntegers`, so a value past 2^53 arrives as a
 * BigInt and keeps its digits; it is returned as a decimal STRING rather
 * than as a JavaScript number that would silently be a different number.
 * BLOBs become base64 with their byte length, and past `MAX_BLOB_BYTES` only
 * the length, because a tool result is not a file transfer.
 */
export function shapeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) {
    return value.byteLength > MAX_BLOB_BYTES
      ? { blob: { bytes: value.byteLength, truncated: true } }
      : { blob: { bytes: value.byteLength, base64: toBase64(value) } };
  }
  return value;
}

/** Shape a whole row. */
export function shapeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = shapeValue(value);
  return out;
}

export type QueryResult = {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly columns: readonly string[];
  /** Set when the caller should know the answer is not the whole answer. */
  readonly note?: string;
};

export type StepOptions = {
  readonly maxRows: number;
  readonly maxChars?: number;
  readonly deadline: Deadline;
};

/**
 * Run a statement and collect its rows under both caps and the deadline.
 *
 * Stepping with `iterate` rather than `all` is what makes the memory cap
 * real: `all` materialises the entire result set before anything can be
 * trimmed, so `SELECT * FROM events` is the whole table in memory no matter
 * what limit the caller passed.
 */
export function stepRows(
  db: Database,
  sql: string,
  args: BoundArgs,
  options: StepOptions,
): Resolved<QueryResult> {
  const cap = options.maxChars ?? MAX_RESULT_CHARS;
  let statement: ReturnType<Database["prepare"]> | undefined;
  try {
    statement = db.prepare(sql);
    const mismatch = parameterMismatch(sql, statement, args);
    if (mismatch !== undefined) return mismatch;
    // Large integers keep their digits; see `shapeValue`.
    useSafeIntegers(statement);
    const columns = [...statement.columnNames];
    const rows: Array<Record<string, unknown>> = [];
    let chars = 0;
    let note: string | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: the row type is the query's, not ours.
    const iterator = statement.iterate(...spreadArgs(args)) as IterableIterator<any>;
    try {
      for (const raw of iterator) {
        if (options.deadline.expired()) {
          note = `stopped after ${rows.length} row(s): the ${options.deadline.budgetMs} ms budget ran out. Narrow the query or raise timeout — the budget is checked between rows, so a single long step runs to completion.`;
          break;
        }
        const shaped = shapeRow(raw as Record<string, unknown>);
        const size = json(shaped).length;
        if (chars + size > cap) {
          note = `truncated at ${rows.length} row(s): the result reached the ${cap}-character cap. Select fewer columns, or page with LIMIT and OFFSET.`;
          break;
        }
        chars += size;
        rows.push(shaped);
        if (rows.length >= options.maxRows) {
          note = `truncated at the ${options.maxRows}-row limit; there may be more rows. Raise maxRows, or add ORDER BY with LIMIT/OFFSET to page.`;
          break;
        }
      }
    } finally {
      // Abandoning a half-consumed iterator leaves a step in progress on the
      // connection, which then blocks VACUUM and the next statement.
      if (typeof iterator.return === "function") iterator.return(undefined);
    }
    return { ok: true, value: note === undefined ? { rows, columns } : { rows, columns, note } };
  } catch (err) {
    return refuse(sqliteFailure(sql, err));
  } finally {
    finalizeQuietly(statement);
  }
}

/**
 * Turn on `safeIntegers` so an INTEGER past 2^53 arrives as a BigInt with its
 * digits intact rather than as a JavaScript number that is quietly a
 * different value. The method exists on `bun:sqlite`'s `Statement` but is
 * missing from the bundled type declarations at this version, so the cast is
 * confined to this one place and is checked before it is called: on a build
 * where the method is absent, large integers simply arrive as numbers and
 * `shapeValue` handles both.
 */
export function useSafeIntegers(statement: unknown): void {
  const candidate = statement as { safeIntegers?: (value: boolean) => void };
  if (typeof candidate.safeIntegers === "function") candidate.safeIntegers(true);
}

/** Release a statement without letting the release mask the real result. */
export function finalizeQuietly(statement: { finalize(): void } | undefined): void {
  if (statement === undefined) return;
  try {
    statement.finalize();
  } catch {
    // Already finalized.
  }
}

// ---------------------------------------------------------------------------
// deadlines

export type Deadline = {
  readonly budgetMs: number;
  expired(): boolean;
  remainingMs(): number;
};

/** A budget for control flow only. No part of it reaches a result. */
export function startDeadline(timeoutMs: number | undefined): Deadline {
  const budgetMs = Math.max(1, Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const started = Date.now();
  return {
    budgetMs,
    expired: () => Date.now() - started >= budgetMs,
    remainingMs: () => Math.max(0, budgetMs - (Date.now() - started)),
  };
}

// ---------------------------------------------------------------------------
// errors

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A SQLite failure as one sentence a model can act on. The statement is
 * echoed back, because "no such column: usr_id" is only actionable next to
 * the statement that said `usr_id`.
 */
export function sqliteFailure(sql: string, err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
  const detail = errorText(err);
  const suffix = code === "" || detail.includes(code) ? "" : ` (${code})`;
  return `SQLite refused the statement: ${detail}${suffix}. Statement: ${clip(sql)}`;
}

/** Keep an echoed statement to a size worth putting in a context window. */
export function clip(text: string, limit = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
