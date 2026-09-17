/**
 * @crewhaus/tool-sql — SQL tools over SQLite, and only over SQLite.
 *
 * That narrowness is the design. `bun:sqlite` ships with the runtime, so
 * these tools need no driver, no server and no connection string; what they
 * cannot do is talk to Postgres or MySQL, and nothing here pretends
 * otherwise. A harness pointed at a `.db` file gets querying, schema
 * introspection, import and export, migrations and integrity checking. A
 * harness pointed at a database server needs a different package.
 *
 * Four properties hold across every tool:
 *
 *   1. CONTAINMENT. Every path — the database, a CSV to import, a file to
 *      export to, a migration directory — goes through `resolveSafe` and is
 *      refused if it resolves outside the workspace, symlinks included. The
 *      SQL is contained too: ATTACH, DETACH, VACUUM and load_extension are
 *      refused because each reaches a file by a route the path gate cannot
 *      see.
 *
 *   2. BOUND PARAMETERS, ALWAYS. No caller value is ever written into a
 *      statement, and the parameters a statement declares are read with
 *      SQLite's own grammar and then re-checked against the count SQLite
 *      reports for the compiled statement. `SqlQuery`, `SqlExec`, `SqlTransaction`, `SqlExplain` and
 *      the export tools take `sql` and `params` separately; schema
 *      introspection uses SQLite's pragma table-valued functions, which
 *      accept bound parameters where `PRAGMA name(x)` would have needed the
 *      name spliced in. The only identifiers written into SQL are the table
 *      and column names the import tools create, which are validated and
 *      then double-quoted, and a row count over a name that came out of
 *      `sqlite_schema` a line earlier.
 *
 *   3. READS ARE READ-ONLY AT THE ENGINE. `SqlQuery` and every schema tool
 *      open the file with SQLITE_OPEN_READONLY and set `PRAGMA query_only`,
 *      and let SQLite refuse a write — the temp database included. See the
 *      note in `./db.ts` for why a keyword check is not a substitute.
 *
 *   4. DETERMINISM. Same call, same database, same bytes back. Every listing
 *      is sorted by codepoint, never `localeCompare`; nothing samples a
 *      random source; and no clock value appears in a result unless the
 *      caller selected the column holding it.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  type BoundArgs,
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  MAX_RESULT_CHARS,
  MAX_TIMEOUT_MS,
  type OpenOptions,
  type ParamInput,
  ROW_LIMIT,
  type Refusal,
  bindParams,
  clip,
  closeQuietly,
  errorText,
  finalizeQuietly,
  guardSql,
  json,
  openDatabase,
  parameterMismatch,
  refuse,
  shapeValue,
  spreadArgs,
  sqliteFailure,
  startDeadline,
  stepRows,
  useSafeIntegers,
} from "./db";
import {
  findObjectName,
  objectExists,
  readColumns,
  readForeignKeys,
  readIndexes,
  readObjects,
  readSnapshot,
  readTableSizes,
} from "./introspect";
import { csvCell, formatCsvRow, parseCsv } from "./lib/csv";
import {
  type InferredType,
  affinityOf,
  checkTypeFor,
  coerceCsvCell,
  coerceJsonValue,
  inferTypeFromJson,
  inferTypeFromStrings,
  unionKeys,
} from "./lib/infer";
import {
  type AppliedMigration,
  type MigrationFile,
  hasAmbiguousOrdering,
  planMigrations,
  selectMigrationFiles,
} from "./lib/migrations";
import { type PlanNode, readPlan } from "./lib/plan";
import { diffSchemas } from "./lib/schema-diff";
import { isSafeIdentifier, leadingKeyword, quoteIdentifier, splitStatements } from "./lib/sql-text";
import { type SafePath, ToolPermissionError, describePath, resolveSafe } from "./paths";

// ---------------------------------------------------------------------------
// shared schema pieces and plumbing

const databaseField = z
  .string()
  .min(1)
  .describe("path to a SQLite database file, relative to the workspace root");

const timeoutField = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(
    `wall-clock budget in milliseconds (default ${DEFAULT_TIMEOUT_MS}); checked between rows, not inside a single step`,
  );

/** The JavaScript types SQLite stores natively. Booleans arrive as 1 and 0. */
const paramValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const paramsField = z
  .union([z.array(paramValue), z.record(paramValue)])
  .optional()
  .describe(
    "values for the statement's placeholders: a list for ?, an object for $named. The only way a value reaches the statement — never interpolate into sql",
  );

/** Files a tool will read whole. A CSV past this should be split first. */
const MAX_IMPORT_BYTES = 33_554_432;
/** Bytes a single export writes before it stops and says so. */
const MAX_EXPORT_BYTES = 67_108_864;
/** Rejections echoed back per import; the counts are always complete. */
const MAX_REPORTED_REJECTIONS = 50;
/** Statements one SqlTransaction applies. */
const MAX_TRANSACTION_STATEMENTS = 1_000;
/**
 * Migration files one directory may hold, and the bytes they may come to in
 * total. Every file is read and held at once — the whole set is checked
 * before any of it runs — so without a ceiling the per-file limit alone
 * bounds nothing: a thousand files just under it is thirty gigabytes.
 */
const MAX_MIGRATION_FILES = 1_000;
/** Records one ImportJson call may carry inline; a file is the way past it. */
const MAX_INLINE_RECORDS = 100_000;
const MAX_MIGRATION_BYTES = 33_554_432;

/**
 * Open, run, close. The body returns the caller's result string; a refusal
 * from opening, and any exception the body did not expect, become a sentence
 * rather than a thrown error, because a caller mistake is normal traffic for
 * these tools and a model recovers from a sentence.
 */
function useDatabase(
  toolName: string,
  file: string,
  options: OpenOptions,
  body: (db: Database, at: SafePath) => string,
): string {
  const opened = openDatabase(toolName, file, options);
  if (!opened.ok) return opened.message;
  const { db, path: at } = opened.value;
  try {
    return body(db, at);
  } catch (err) {
    return `${toolName} failed: ${errorText(err)}`;
  } finally {
    closeQuietly(db);
  }
}

/** Resolve a caller path, turning containment failure into a sentence. */
function safePath(toolName: string, given: string): SafePath | Refusal {
  try {
    return resolveSafe(toolName, given);
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return refuse(
        `${toolName} refused the path "${describePath(given)}": it resolves outside the workspace root. Pass a path inside the working directory.`,
      );
    }
    return refuse(`${toolName} could not resolve "${describePath(given)}": ${errorText(err)}`);
  }
}

const isRefusal = (value: unknown): value is Refusal =>
  typeof value === "object" && value !== null && "ok" in value && value.ok === false;

/** Read a caller-supplied text file, under the size cap. */
function readTextFile(toolName: string, at: SafePath): string | Refusal {
  if (!existsSync(at.real)) return refuse(`${toolName} found no file at "${at.rel}".`);
  let size: number;
  try {
    const info = statSync(at.real);
    if (info.isDirectory()) {
      return refuse(`${toolName} refused "${at.rel}": it is a directory, not a file.`);
    }
    size = info.size;
  } catch (err) {
    return refuse(`${toolName} could not stat "${at.rel}": ${errorText(err)}`);
  }
  if (size > MAX_IMPORT_BYTES) {
    return refuse(
      `${toolName} refused "${at.rel}": it is ${size} bytes, over the ${MAX_IMPORT_BYTES}-byte limit. Split the file and import the parts.`,
    );
  }
  try {
    return readFileSync(at.real, "utf8");
  } catch (err) {
    return refuse(`${toolName} could not read "${at.rel}": ${errorText(err)}`);
  }
}

/**
 * A sink that writes through a temporary file in the destination's own
 * directory and renames it into place on success.
 *
 * A half-written export is worse than no export: the next tool to read it
 * finds a plausible file with missing rows. Renaming within one directory is
 * atomic, so the destination either does not exist or is complete.
 */
type FileSink = {
  write(text: string): boolean;
  bytes(): number;
  commit(): void;
  discard(): void;
};

function openSink(toolName: string, at: SafePath, overwrite: boolean): FileSink | Refusal {
  if (existsSync(at.real) && !overwrite) {
    return refuse(
      `${toolName} refused to overwrite "${at.rel}". Pass overwrite: true if replacing it is intended.`,
    );
  }
  const directory = path.dirname(at.real);
  if (!existsSync(directory)) {
    return refuse(`${toolName} found no directory "${path.dirname(at.rel)}" to write into.`);
  }
  let scratch: string;
  let fd: number;
  try {
    scratch = mkdtempSync(path.join(directory, ".crewhaus-sql-"));
    fd = openSync(path.join(scratch, "out"), "wx");
  } catch (err) {
    return refuse(`${toolName} could not open "${at.rel}" for writing: ${errorText(err)}`);
  }
  let written = 0;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      closeSync(fd);
    } catch {
      // Nothing left to do about a failed close; the rename below is what
      // decides whether the caller sees a file at all.
    }
  };
  return {
    write(text: string): boolean {
      const buffer = Buffer.from(text, "utf8");
      if (written + buffer.byteLength > MAX_EXPORT_BYTES) return false;
      // `writeSync` is allowed to write fewer bytes than it was given; on a
      // full disk or a slow filesystem the difference is a silently
      // truncated export, so the remainder is written rather than assumed.
      // A write that stops making progress throws — `false` is reserved for
      // the byte cap, and reporting a failed disk as "hit the limit" would
      // be the wrong sentence.
      let offset = 0;
      while (offset < buffer.byteLength) {
        const wrote = writeSync(fd, buffer, offset, buffer.byteLength - offset);
        written += wrote;
        offset += wrote;
        if (wrote <= 0) {
          throw new Error(
            `the filesystem accepted ${offset} of ${buffer.byteLength} byte(s) and then stopped`,
          );
        }
      }
      return true;
    },
    bytes: () => written,
    commit(): void {
      close();
      renameSync(path.join(scratch, "out"), at.real);
      rmSync(scratch, { recursive: true, force: true });
    },
    discard(): void {
      close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/**
 * Refuse a delimiter that would make the file unreadable: a quote is CSV's
 * escape character and a line ending is its record separator, so neither can
 * also separate fields. The schema already limits this to one character.
 */
function badDelimiter(toolName: string, delimiter: string): string | undefined {
  if (delimiter !== '"' && delimiter !== "\r" && delimiter !== "\n") return undefined;
  return `${toolName} refused the delimiter ${json(delimiter)}: a quote and a line ending already mean something else in CSV.`;
}

/** sha256 of a migration file, so a later edit to it is visible. */
function checksumOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// querying

export const sqlQuery: RegisteredTool = buildTool({
  name: "SqlQuery",
  description:
    "Run a read-only SQL statement against a SQLite database file, with values supplied as bound parameters. Use to answer a question about data without loading a table into context: the connection is opened read-only so SQLite itself refuses any write, including one hidden behind a CTE, and rows are capped with a note when the answer was cut short. SQLite only — not Postgres or MySQL — and one statement per call.",
  inputSchema: z.object({
    database: databaseField,
    sql: z.string().min(1).describe("one SELECT (or other read) statement"),
    params: paramsField,
    maxRows: z
      .number()
      .int()
      .positive()
      .max(ROW_LIMIT)
      .optional()
      .describe(`rows to return before truncating (default ${DEFAULT_MAX_ROWS})`),
    timeout: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const guard = guardSql("SqlQuery", input.sql);
    if (guard !== undefined) return guard.message;
    const bound = bindParams("SqlQuery", input.sql, input.params as ParamInput | undefined);
    if (!bound.ok) return bound.message;
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "SqlQuery",
      input.database,
      { mode: "read", timeoutMs: deadline.budgetMs },
      (db) => {
        const result = stepRows(db, input.sql, bound.value, {
          maxRows: input.maxRows ?? DEFAULT_MAX_ROWS,
          maxChars: MAX_RESULT_CHARS,
          deadline,
        });
        if (!result.ok) return result.message;
        const { rows, columns, note } = result.value;
        return json({
          columns,
          rowCount: rows.length,
          rows,
          ...(note === undefined ? {} : { note }),
        });
      },
    );
  },
});

export const sqlExec: RegisteredTool = buildTool({
  name: "SqlExec",
  description:
    "Run one writing statement — INSERT, UPDATE, DELETE or DDL — against a SQLite database, with values supplied as bound parameters. Use when the point of the call is to change the database rather than to read it; it reports rows changed and the last inserted rowid. It applies exactly one statement and will not create the database file unless create is set.",
  inputSchema: z.object({
    database: databaseField,
    sql: z.string().min(1).describe("one INSERT, UPDATE, DELETE or DDL statement"),
    params: paramsField,
    create: z
      .boolean()
      .optional()
      .describe("create the database file when it does not exist (default false)"),
    foreignKeys: z
      .boolean()
      .optional()
      .describe("enable PRAGMA foreign_keys for this connection (SQLite's own default is off)"),
    timeout: timeoutField,
  }),
  destructive: true,
  execute: async (input) => {
    const guard = guardSql("SqlExec", input.sql);
    if (guard !== undefined) return guard.message;
    const bound = bindParams("SqlExec", input.sql, input.params as ParamInput | undefined);
    if (!bound.ok) return bound.message;
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "SqlExec",
      input.database,
      {
        mode: "write",
        timeoutMs: deadline.budgetMs,
        ...(input.create === undefined ? {} : { create: input.create }),
        ...(input.foreignKeys === undefined ? {} : { foreignKeys: input.foreignKeys }),
      },
      (db) => {
        let statement: ReturnType<Database["prepare"]> | undefined;
        try {
          statement = db.prepare(input.sql);
          const mismatch = parameterMismatch(input.sql, statement, bound.value);
          if (mismatch !== undefined) return mismatch.message;
          // A SELECT sent here runs and its rows are thrown away. Saying so
          // beats reporting "0 rows changed" for a query that worked.
          const returnsRows = statement.columnNames.length > 0;
          const result = statement.run(...spreadArgs(bound.value)) as {
            changes: number | bigint;
            lastInsertRowid: number | bigint;
          };
          return json({
            changes: shapeValue(result.changes),
            lastInsertRowid: shapeValue(result.lastInsertRowid),
            statement: leadingKeyword(input.sql),
            ...(returnsRows
              ? {
                  note: "this statement returns rows, and SqlExec discards them — use SqlQuery to read them",
                }
              : {}),
          });
        } catch (err) {
          return sqliteFailure(input.sql, err);
        } finally {
          finalizeQuietly(statement);
        }
      },
    );
  },
});

export const sqlTransaction: RegisteredTool = buildTool({
  name: "SqlTransaction",
  description:
    "Apply several writing statements to a SQLite database as one unit, rolling every one of them back if any fails. Use when a change spans more than one statement and a half-applied version would be worse than no change at all; each statement carries its own bound parameters and the failing index is named on rollback. Statements run in the order given, on one connection, and may not contain their own BEGIN or COMMIT.",
  inputSchema: z.object({
    database: databaseField,
    statements: z
      .array(
        z.object({
          sql: z.string().min(1),
          params: paramsField,
        }),
      )
      .min(1)
      .max(MAX_TRANSACTION_STATEMENTS),
    create: z.boolean().optional().describe("create the database file when it does not exist"),
    foreignKeys: z
      .boolean()
      .optional()
      .describe("enable PRAGMA foreign_keys for this connection (SQLite's own default is off)"),
    timeout: timeoutField,
  }),
  destructive: true,
  execute: async (input) => {
    // Everything that can be refused is refused before the transaction
    // opens, so a rejected statement never rolls back work already done.
    const prepared: Array<{ sql: string; bound: BoundArgs }> = [];
    for (const [index, item] of input.statements.entries()) {
      const guard = guardSql(`SqlTransaction statement ${index}`, item.sql);
      if (guard !== undefined) return guard.message;
      const keyword = leadingKeyword(item.sql);
      if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"].includes(keyword)) {
        return `SqlTransaction refused statement ${index}: it is ${keyword}, and this tool already wraps every statement in one transaction. Remove the transaction control.`;
      }
      const bound = bindParams(
        `SqlTransaction statement ${index}`,
        item.sql,
        item.params as ParamInput | undefined,
      );
      if (!bound.ok) return bound.message;
      prepared.push({ sql: item.sql, bound: bound.value });
    }
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "SqlTransaction",
      input.database,
      {
        mode: "write",
        timeoutMs: deadline.budgetMs,
        ...(input.create === undefined ? {} : { create: input.create }),
        ...(input.foreignKeys === undefined ? {} : { foreignKeys: input.foreignKeys }),
      },
      (db) => {
        const results: Array<{ index: number; changes: unknown; lastInsertRowid: unknown }> = [];
        let failedAt: { index: number; message: string } | undefined;
        const apply = db.transaction(() => {
          for (const [index, item] of prepared.entries()) {
            let statement: ReturnType<Database["prepare"]> | undefined;
            try {
              statement = db.prepare(item.sql);
              const mismatch = parameterMismatch(item.sql, statement, item.bound);
              if (mismatch !== undefined) {
                failedAt = { index, message: mismatch.message };
                throw new Error(mismatch.message);
              }
              const outcome = statement.run(...spreadArgs(item.bound)) as {
                changes: number | bigint;
                lastInsertRowid: number | bigint;
              };
              results.push({
                index,
                changes: shapeValue(outcome.changes),
                lastInsertRowid: shapeValue(outcome.lastInsertRowid),
              });
            } catch (err) {
              failedAt = { index, message: sqliteFailure(item.sql, err) };
              // Throwing is what makes bun:sqlite roll the transaction back;
              // the details are carried out in `failedAt`.
              throw err;
            } finally {
              finalizeQuietly(statement);
            }
          }
        });
        try {
          apply();
        } catch (err) {
          const detail = failedAt ?? { index: -1, message: errorText(err) };
          return `SqlTransaction rolled back: statement ${detail.index} failed and nothing was applied. ${detail.message}`;
        }
        return json({ applied: results.length, results });
      },
    );
  },
});

export const sqlExplain: RegisteredTool = buildTool({
  name: "SqlExplain",
  description:
    "Show SQLite's query plan for a statement, with the tables it scans end to end and the indexes it uses. Use to find a missing index without guessing: a table in fullScans is being read row by row for this query. Names are the plan's own, so an aliased table appears under its alias, and an index SQLite built for this one statement is not listed as an index the query uses. The statement is planned, never run.",
  inputSchema: z.object({
    database: databaseField,
    sql: z.string().min(1).describe("the statement to plan; it is not executed"),
    params: paramsField,
    timeout: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const guard = guardSql("SqlExplain", input.sql);
    if (guard !== undefined) return guard.message;
    const bound = bindParams("SqlExplain", input.sql, input.params as ParamInput | undefined);
    if (!bound.ok) return bound.message;
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "SqlExplain",
      input.database,
      { mode: "read", timeoutMs: deadline.budgetMs },
      (db) => {
        // Prefixing is not interpolation: the caller's statement is the
        // whole tail, and `guardSql` has already refused a second statement
        // that could hide behind it.
        const planSql = `EXPLAIN QUERY PLAN ${input.sql}`;
        const result = stepRows(db, planSql, bound.value, { maxRows: 5_000, deadline });
        if (!result.ok) return result.message;
        const nodes: PlanNode[] = result.value.rows.map((row) => ({
          id: Number(row["id"] ?? 0),
          parent: Number(row["parent"] ?? 0),
          detail: String(row["detail"] ?? ""),
        }));
        const reading = readPlan(nodes);
        return json({
          statement: leadingKeyword(input.sql),
          nodes: nodes.length,
          tree: reading.tree,
          fullScans: reading.fullScans,
          indexes: reading.indexes,
          usesTempBTree: reading.usesTempBTree,
        });
      },
    );
  },
});

// ---------------------------------------------------------------------------
// schema

const objectTypeField = z.enum(["table", "view", "index", "trigger"]);

export const schemaList: RegisteredTool = buildTool({
  name: "SchemaList",
  description:
    "List a SQLite database's tables, views, indexes and triggers. Use as the first call against an unfamiliar database, before writing a query against a table whose name you are guessing. Names only — SchemaDescribe gives one object's columns and keys.",
  inputSchema: z.object({
    database: databaseField,
    types: z
      .array(objectTypeField)
      .min(1)
      .optional()
      .describe("restrict the listing to these kinds (default: all four)"),
    includeInternal: z
      .boolean()
      .optional()
      .describe("include SQLite's own sqlite_* objects (default false)"),
    timeout: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "SchemaList",
      input.database,
      { mode: "read", timeoutMs: deadline.budgetMs },
      (db) => {
        const wanted = new Set(input.types ?? ["table", "view", "index", "trigger"]);
        const objects = readObjects(db, input.includeInternal === true).filter((o) =>
          wanted.has(o.type),
        );
        return json({
          counts: {
            table: objects.filter((o) => o.type === "table").length,
            view: objects.filter((o) => o.type === "view").length,
            index: objects.filter((o) => o.type === "index").length,
            trigger: objects.filter((o) => o.type === "trigger").length,
          },
          objects: objects.map((o) =>
            o.type === "table" || o.type === "view"
              ? { type: o.type, name: o.name }
              : { type: o.type, name: o.name, on: o.tableName },
          ),
        });
      },
    );
  },
});

export const schemaDescribe: RegisteredTool = buildTool({
  name: "SchemaDescribe",
  description:
    "Describe one table or view: its columns with types, nullability and defaults, its primary key, its foreign keys and its indexes. Use before writing a query or an INSERT against it, so the column names and the NOT NULL columns come from the database rather than from memory. A view reports its columns but has no keys or indexes of its own.",
  inputSchema: z.object({
    database: databaseField,
    table: z.string().min(1).describe("the table or view name"),
    includeSql: z.boolean().optional().describe("include the stored CREATE statement"),
    timeout: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "SchemaDescribe",
      input.database,
      { mode: "read", timeoutMs: deadline.budgetMs },
      (db) => {
        // SQLite resolves identifiers case-insensitively, so the lookup does
        // too, and everything below uses the spelling the database stores.
        const name = findObjectName(db, input.table, ["table", "view"]);
        if (name === undefined) {
          const near = readObjects(db)
            .filter((o) => o.type === "table" || o.type === "view")
            .map((o) => o.name);
          return `SchemaDescribe found no table or view named "${input.table}". This database has: ${near.length === 0 ? "(none)" : near.join(", ")}.`;
        }
        const object = readObjects(db, true).find((o) => o.name === name);
        const columns = readColumns(db, name);
        const primaryKey = columns
          .filter((c) => c.primaryKey > 0)
          .sort((a, b) => a.primaryKey - b.primaryKey)
          .map((c) => c.name);
        const isView = object?.type === "view";
        return json({
          name,
          type: object?.type ?? "table",
          columns: columns.map((c) => ({
            name: c.name,
            type: c.type === "" ? null : c.type,
            notNull: c.notNull,
            default: c.defaultValue,
            primaryKey: c.primaryKey > 0,
          })),
          primaryKey,
          foreignKeys: isView ? [] : readForeignKeys(db, name),
          indexes: isView ? [] : readIndexes(db, name),
          ...(input.includeSql === true ? { sql: object?.sql ?? null } : {}),
        });
      },
    );
  },
});

export const dbSchemaDiff: RegisteredTool = buildTool({
  name: "DbSchemaDiff",
  description:
    "Compare two SQLite databases' schemas and report what one has that the other does not. Use to check that a migration landed the same way in two places, or to see what a branch changed. Tables and views are compared column by column; indexes, triggers and view bodies are compared as stored DDL text with whitespace collapsed, so a purely cosmetic rewrite shows as a change.",
  inputSchema: z.object({
    left: databaseField.describe("path to the first database"),
    right: databaseField.describe("path to the second database"),
    includeInternal: z.boolean().optional().describe("include SQLite's own sqlite_* objects"),
    timeout: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const deadline = startDeadline(input.timeout);
    const internal = input.includeInternal === true;
    return useDatabase(
      "DbSchemaDiff",
      input.left,
      { mode: "read", timeoutMs: deadline.budgetMs },
      (leftDb, leftAt) => {
        const leftSnapshot = readSnapshot(leftDb, internal);
        return useDatabase(
          "DbSchemaDiff",
          input.right,
          { mode: "read", timeoutMs: deadline.budgetMs },
          (rightDb, rightAt) => {
            const difference = diffSchemas(leftSnapshot, readSnapshot(rightDb, internal));
            return json({
              left: leftAt.rel,
              right: rightAt.rel,
              identical: difference.identical,
              onlyInLeft: difference.onlyInLeft.map((o) => ({ type: o.type, name: o.name })),
              onlyInRight: difference.onlyInRight.map((o) => ({ type: o.type, name: o.name })),
              changed: difference.changed,
            });
          },
        );
      },
    );
  },
});

export const tableStats: RegisteredTool = buildTool({
  name: "TableStats",
  description:
    "Report each table's exact row count and, where SQLite's dbstat module is available, its size on disk. Use to find the table worth indexing or archiving before deciding what to do about a slow database. The counts are exact, which means a full scan of every table — on a large database this is the expensive call, and it stops at the timeout and says how far it got.",
  inputSchema: z.object({
    database: databaseField,
    tables: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("only these tables (default: every table in the database)"),
    timeout: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "TableStats",
      input.database,
      { mode: "read", timeoutMs: deadline.budgetMs },
      (db) => {
        const present = readObjects(db)
          .filter((o) => o.type === "table")
          .map((o) => o.name);
        let wanted = present;
        if (input.tables !== undefined) {
          // Resolved case-insensitively, like SQLite's own name lookup, and
          // counted under the database's spelling.
          const byLowerName = new Map(present.map((name) => [name.toLowerCase(), name]));
          const missing = input.tables.filter((name) => !byLowerName.has(name.toLowerCase()));
          if (missing.length > 0) {
            return `TableStats found no table named ${missing.map((m) => `"${m}"`).join(", ")}. This database has: ${present.length === 0 ? "(none)" : present.join(", ")}.`;
          }
          wanted = [
            ...new Set(input.tables.map((name) => byLowerName.get(name.toLowerCase()) as string)),
          ].sort();
        }
        const { sizes, stoppedAfter, dbstat } = readTableSizes(db, wanted, () =>
          deadline.expired(),
        );
        const totalRows = sizes.reduce(
          (sum, size) => sum + (typeof size.rows === "number" ? size.rows : 0),
          0,
        );
        return json({
          tables: sizes,
          totalRows,
          ...(dbstat ? {} : { note: "sizes are absent: this SQLite build has no dbstat module" }),
          ...(stoppedAfter === undefined
            ? {}
            : {
                stopped: `counted ${stoppedAfter} of ${wanted.length} table(s) before the ${deadline.budgetMs} ms budget ran out; raise timeout or pass a shorter tables list`,
              }),
        });
      },
    );
  },
});

export const integrityCheck: RegisteredTool = buildTool({
  name: "IntegrityCheck",
  description:
    "Run SQLite's own integrity_check and foreign_key_check against a database and report the findings structurally. Use before trusting a file that was copied while in use, restored from a backup, or written by something that crashed. foreign_key_check reports violations even when the foreign_keys pragma is off, which is how rows that predate a constraint come to light.",
  inputSchema: z.object({
    database: databaseField,
    quick: z
      .boolean()
      .optional()
      .describe("use quick_check, which skips the slow index-content pass (default false)"),
    table: z.string().min(1).optional().describe("limit the foreign-key check to one table"),
    maxErrors: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .optional()
      .describe("stop the integrity check after this many problems (default 100)"),
    timeout: timeoutField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "IntegrityCheck",
      input.database,
      { mode: "read", timeoutMs: deadline.budgetMs },
      (db) => {
        const only =
          input.table === undefined ? undefined : findObjectName(db, input.table, ["table"]);
        if (input.table !== undefined && only === undefined) {
          return `IntegrityCheck found no table named "${input.table}".`;
        }
        const column = input.quick === true ? "quick_check" : "integrity_check";
        // The pragma table-valued form reads its argument as a SCHEMA name,
        // not as an error limit, so this is the one pragma here that has to
        // use the classic `PRAGMA name(n)` spelling. `n` is clamped and
        // floored by the schema and by `Math`, so the text is digits; no
        // caller value is written into SQL.
        const limit = String(Math.floor(Math.max(1, Math.min(input.maxErrors ?? 100, 10_000))));
        const checkRows = stepRows(db, `PRAGMA ${column}(${limit})`, [], {
          maxRows: 10_000,
          deadline,
        });
        if (!checkRows.ok) return checkRows.message;
        const problems = checkRows.value.rows
          .map((row) => String(row[column] ?? ""))
          .filter((text) => text !== "" && text !== "ok");
        const fkSql =
          only === undefined
            ? "SELECT * FROM pragma_foreign_key_check"
            : "SELECT * FROM pragma_foreign_key_check(?)";
        const fkRows = stepRows(db, fkSql, only === undefined ? [] : [only], {
          maxRows: 10_000,
          deadline,
        });
        if (!fkRows.ok) return fkRows.message;
        const violations = fkRows.value.rows.map((row) => ({
          table: String(row["table"] ?? ""),
          rowid: row["rowid"] ?? null,
          parent: String(row["parent"] ?? ""),
          foreignKeyIndex: Number(row["fkid"] ?? 0),
        }));
        return json({
          ok: problems.length === 0 && violations.length === 0,
          check: input.quick === true ? "quick_check" : "integrity_check",
          problems,
          foreignKeyViolations: violations,
          ...(checkRows.value.note === undefined ? {} : { note: checkRows.value.note }),
        });
      },
    );
  },
});

// ---------------------------------------------------------------------------
// import

/** One row that could not be stored, and why. */
type Rejection = { readonly row: number; readonly reason: string };

type TargetTable = {
  /** The table in the database's own spelling — what the INSERT must name. */
  readonly name: string;
  /** Column names in the database's own spelling, in insert order. */
  readonly columns: readonly string[];
  /** What each column's value has to parse as. */
  readonly types: readonly InferredType[];
  readonly created: boolean;
};

/**
 * Line up the caller's columns with the table's, creating the table when
 * asked to.
 *
 * SQLite matches identifiers case-insensitively for ASCII, so a CSV header
 * of `ID` finds a column declared `id` — and the database's spelling is the
 * one used from then on, because that is the one the INSERT has to name.
 */
function prepareTarget(
  toolName: string,
  db: Database,
  table: string,
  columns: readonly string[],
  inferred: readonly InferredType[],
  createTable: boolean,
  dryRun: boolean,
): TargetTable | Refusal {
  if (!isSafeIdentifier(table)) {
    return refuse(`${toolName} refused the table name "${clip(table, 60)}".`);
  }
  for (const column of columns) {
    if (!isSafeIdentifier(column)) {
      return refuse(`${toolName} refused the column name "${clip(column, 60)}".`);
    }
  }
  const lowered = columns.map((c) => c.toLowerCase());
  const duplicate = lowered.find((name, index) => lowered.indexOf(name) !== index);
  if (duplicate !== undefined) {
    return refuse(`${toolName} refused a duplicate column name "${duplicate}".`);
  }
  const existing = findObjectName(db, table, ["table"]);
  if (existing === undefined) {
    if (!createTable) {
      return refuse(
        `${toolName} found no table named "${table}". Pass createTable: true to create it from the inferred column types, or create it yourself with SqlExec.`,
      );
    }
    if (objectExists(db, table, ["view", "index", "trigger"])) {
      return refuse(`${toolName} refused "${table}": it already exists, but not as a table.`);
    }
    // A dry run answers "what would this do" and must not do it, so the
    // table is described rather than created.
    if (dryRun) return { name: table, columns: [...columns], types: [...inferred], created: true };
    // Identifiers cannot be bound, so they are validated above and quoted
    // here. Everything that follows binds its values.
    const definitions = columns
      .map((name, index) => `${quoteIdentifier(name)} ${inferred[index] ?? "TEXT"}`)
      .join(", ");
    try {
      db.run(`CREATE TABLE ${quoteIdentifier(table)} (${definitions})`);
    } catch (err) {
      return refuse(`${toolName} could not create "${table}": ${errorText(err)}`);
    }
    return { name: table, columns: [...columns], types: [...inferred], created: true };
  }
  const existingColumns = readColumns(db, existing);
  const byLowerName = new Map(existingColumns.map((c) => [c.name.toLowerCase(), c]));
  const resolvedNames: string[] = [];
  const types: InferredType[] = [];
  for (const column of columns) {
    const match = byLowerName.get(column.toLowerCase());
    if (match === undefined) {
      return refuse(
        `${toolName} found no column "${column}" in "${existing}". Its columns are: ${existingColumns.map((c) => c.name).join(", ")}.`,
      );
    }
    resolvedNames.push(match.name);
    types.push(checkTypeFor(affinityOf(match.type)));
  }
  return { name: existing, columns: resolvedNames, types, created: false };
}

type ImportOutcome = {
  readonly inserted: number;
  readonly rejected: number;
  readonly rejections: readonly Rejection[];
};

/**
 * Insert every accepted row in one transaction.
 *
 * A row SQLite refuses — a NOT NULL violation, a duplicate key — is recorded
 * and skipped by default, so an import of ten thousand rows reports the four
 * that were wrong instead of failing whole. `abort` is there for the caller
 * who would rather have nothing than a partial load; on abort the
 * transaction rolls back and no row survives.
 */
function insertRows(
  db: Database,
  table: TargetTable,
  rows: ReadonlyArray<{ row: number; values: ReadonlyArray<string | number | null> }>,
  earlier: readonly Rejection[],
  abortOnError: boolean,
): ImportOutcome | Refusal {
  const placeholders = table.columns.map(() => "?").join(", ");
  const columnList = table.columns.map(quoteIdentifier).join(", ");
  const sql = `INSERT INTO ${quoteIdentifier(table.name)} (${columnList}) VALUES (${placeholders})`;
  const rejections: Rejection[] = [...earlier];
  let inserted = 0;
  let aborted: Rejection | undefined;
  let statement: ReturnType<Database["prepare"]> | undefined;
  const apply = db.transaction(() => {
    statement = db.prepare(sql);
    for (const item of rows) {
      try {
        statement.run(...(item.values as Array<string | number | null>));
        inserted += 1;
      } catch (err) {
        const rejection = { row: item.row, reason: errorText(err) };
        if (abortOnError) {
          aborted = rejection;
          throw err;
        }
        rejections.push(rejection);
      }
    }
    if (abortOnError && rejections.length > 0) {
      aborted = rejections[0] as Rejection;
      throw new Error("rejected rows with onRowError: abort");
    }
  });
  try {
    apply();
  } catch (err) {
    const detail = aborted;
    return refuse(
      detail === undefined
        ? `the import was rolled back: ${errorText(err)}`
        : `the import was rolled back at row ${detail.row}: ${detail.reason}. Nothing was inserted.`,
    );
  } finally {
    finalizeQuietly(statement);
  }
  rejections.sort((a, b) => a.row - b.row);
  return {
    inserted,
    rejected: rejections.length,
    rejections: rejections.slice(0, MAX_REPORTED_REJECTIONS),
  };
}

function importResult(
  outcome: ImportOutcome,
  table: TargetTable,
  extra: Record<string, unknown> = {},
): string {
  return json({
    table: table.name,
    createdTable: table.created,
    columns: table.columns,
    inserted: outcome.inserted,
    rejected: outcome.rejected,
    rejections: outcome.rejections,
    ...(outcome.rejected > outcome.rejections.length
      ? {
          note: `only the first ${MAX_REPORTED_REJECTIONS} rejections are listed; the counts are complete`,
        }
      : {}),
    ...extra,
  });
}

export const importCsv: RegisteredTool = buildTool({
  name: "ImportCsv",
  description:
    "Load a CSV file into a SQLite table in one transaction, creating the table from inferred column types if asked. Use to get a delimited export into a database without hand-writing thousands of INSERTs; it reports rows inserted and every rejected row with the reason it was rejected. A cell whose text does not fit its column's declared type is a rejection rather than a value silently stored as text, which is what SQLite would otherwise do.",
  inputSchema: z.object({
    database: databaseField,
    file: z.string().min(1).describe("path to the CSV file, inside the workspace"),
    table: z.string().min(1).describe("the table to load into"),
    createTable: z
      .boolean()
      .optional()
      .describe("create the table from inferred types when it does not exist (default false)"),
    header: z
      .boolean()
      .optional()
      .describe("treat the first record as column names (default true)"),
    columns: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("column names, required when header is false"),
    delimiter: z.string().length(1).optional().describe("field separator (default ,)"),
    emptyIsNull: z
      .boolean()
      .optional()
      .describe("store an empty cell as NULL rather than as an empty string (default true)"),
    typeCheck: z
      .boolean()
      .optional()
      .describe("reject a cell that does not parse as its column's type (default true)"),
    onRowError: z
      .enum(["skip", "abort"])
      .optional()
      .describe("skip a bad row and report it, or roll the whole import back (default skip)"),
    dryRun: z
      .boolean()
      .optional()
      .describe("parse and validate without writing anything (default false)"),
    create: z.boolean().optional().describe("create the database file when it does not exist"),
    timeout: timeoutField,
  }),
  destructive: true,
  execute: async (input) => {
    const delimiterProblem = badDelimiter("ImportCsv", input.delimiter ?? ",");
    if (delimiterProblem !== undefined) return delimiterProblem;
    const at = safePath("ImportCsv", input.file);
    if (isRefusal(at)) return at.message;
    const text = readTextFile("ImportCsv", at);
    if (isRefusal(text)) return text.message;
    const useHeader = input.header ?? true;
    const emptyIsNull = input.emptyIsNull ?? true;
    const parsed = parseCsv(text, input.delimiter ?? ",");
    if (parsed.unterminatedQuote) {
      return `ImportCsv refused "${at.rel}": a quoted field is never closed, so the rest of the file cannot be split into records.`;
    }
    // A line holding nothing is not a row with one empty field, and
    // reporting it as a malformed row would bury the real rejections.
    const records = parsed.records.filter((record) => !record.blank);
    let columns: string[];
    if (useHeader) {
      const headerRecord = records.shift();
      if (headerRecord === undefined) return `ImportCsv found no rows in "${at.rel}".`;
      columns = [...headerRecord.values];
    } else {
      if (input.columns === undefined) {
        return "ImportCsv needs columns when header is false: with no header row there is nothing to name the fields.";
      }
      columns = [...input.columns];
    }
    if (columns.length === 0) return `ImportCsv found no columns in "${at.rel}".`;

    const inferred = columns.map((_, index) =>
      inferTypeFromStrings(
        records.map((record) => record.values[index] ?? ""),
        emptyIsNull,
      ),
    );
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "ImportCsv",
      input.database,
      {
        mode: "write",
        timeoutMs: deadline.budgetMs,
        ...(input.create === undefined ? {} : { create: input.create }),
      },
      (db) => {
        const target = prepareTarget(
          "ImportCsv",
          db,
          input.table,
          columns,
          inferred,
          input.createTable === true,
          input.dryRun === true,
        );
        if (isRefusal(target)) return target.message;
        const accepted: Array<{ row: number; values: Array<string | number | null> }> = [];
        const rejections: Rejection[] = [];
        for (const record of records) {
          if (record.values.length !== columns.length) {
            rejections.push({
              row: record.line,
              reason: `has ${record.values.length} field(s), expected ${columns.length}`,
            });
            continue;
          }
          const values: Array<string | number | null> = [];
          let bad: string | undefined;
          for (let index = 0; index < columns.length; index++) {
            const raw = record.values[index] ?? "";
            const type = input.typeCheck === false ? "TEXT" : (target.types[index] ?? "TEXT");
            const coerced = coerceCsvCell(raw, type, emptyIsNull);
            if (!coerced.ok) {
              bad = `column "${columns[index]}": ${coerced.reason}`;
              break;
            }
            values.push(coerced.value);
          }
          if (bad !== undefined) rejections.push({ row: record.line, reason: bad });
          else accepted.push({ row: record.line, values });
        }
        if (input.dryRun === true) {
          rejections.sort((a, b) => a.row - b.row);
          return json({
            dryRun: true,
            table: target.name,
            wouldCreateTable: target.created,
            columns: target.columns,
            inferredTypes: target.created ? inferred : target.types,
            wouldInsert: accepted.length,
            rejected: rejections.length,
            rejections: rejections.slice(0, MAX_REPORTED_REJECTIONS),
          });
        }
        const outcome = insertRows(db, target, accepted, rejections, input.onRowError === "abort");
        if (isRefusal(outcome)) return `ImportCsv: ${outcome.message}`;
        return importResult(outcome, target, { file: at.rel });
      },
    );
  },
});

export const importJson: RegisteredTool = buildTool({
  name: "ImportJson",
  description:
    "Load JSON records into a SQLite table in one transaction, from a file or from records passed inline. Use for an API dump or a computed result set that needs to become queryable; it accepts a JSON array or newline-delimited JSON, creates the table from inferred types if asked, and reports every rejected record with its reason. Booleans become 1 and 0 and nested objects become JSON text, because SQLite has neither type.",
  inputSchema: z.object({
    database: databaseField,
    file: z
      .string()
      .min(1)
      .optional()
      .describe("path to a .json or .ndjson file; pass this or records, not both"),
    records: z
      .array(z.record(z.unknown()))
      .min(1)
      .max(MAX_INLINE_RECORDS)
      .optional()
      .describe("records passed inline; pass this or file, not both"),
    table: z.string().min(1).describe("the table to load into"),
    format: z
      .enum(["auto", "array", "ndjson"])
      .optional()
      .describe("how to read the file (default auto: a JSON array, else one record per line)"),
    createTable: z
      .boolean()
      .optional()
      .describe("create the table from inferred types when it does not exist (default false)"),
    columns: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("the keys to load, in order (default: every key seen, in first-appearance order)"),
    onRowError: z
      .enum(["skip", "abort"])
      .optional()
      .describe("skip a bad record and report it, or roll the whole import back (default skip)"),
    dryRun: z
      .boolean()
      .optional()
      .describe("parse and validate without writing anything (default false)"),
    create: z.boolean().optional().describe("create the database file when it does not exist"),
    timeout: timeoutField,
  }),
  destructive: true,
  execute: async (input) => {
    if ((input.file === undefined) === (input.records === undefined)) {
      return "ImportJson needs exactly one of file or records.";
    }
    let records: Array<Record<string, unknown>>;
    let source = "records";
    if (input.records !== undefined) {
      records = input.records as Array<Record<string, unknown>>;
    } else {
      const at = safePath("ImportJson", input.file as string);
      if (isRefusal(at)) return at.message;
      const text = readTextFile("ImportJson", at);
      if (isRefusal(text)) return text.message;
      source = at.rel;
      const parsed = parseJsonRecords(text, input.format ?? "auto");
      if (isRefusal(parsed)) return parsed.message;
      records = parsed;
    }
    if (records.length === 0) return `ImportJson found no records in ${source}.`;
    const columns = input.columns === undefined ? unionKeys(records) : [...input.columns];
    if (columns.length === 0) return `ImportJson found no fields in the records from ${source}.`;
    const inferred = columns.map((column) =>
      inferTypeFromJson(records.map((record) => record[column])),
    );
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "ImportJson",
      input.database,
      {
        mode: "write",
        timeoutMs: deadline.budgetMs,
        ...(input.create === undefined ? {} : { create: input.create }),
      },
      (db) => {
        const target = prepareTarget(
          "ImportJson",
          db,
          input.table,
          columns,
          inferred,
          input.createTable === true,
          input.dryRun === true,
        );
        if (isRefusal(target)) return target.message;
        const accepted: Array<{ row: number; values: Array<string | number | null> }> = [];
        const rejections: Rejection[] = [];
        for (const [index, record] of records.entries()) {
          const values: Array<string | number | null> = [];
          let bad: string | undefined;
          for (let column = 0; column < columns.length; column++) {
            const key = columns[column] as string;
            const type = target.types[column] ?? "TEXT";
            const coerced = coerceJsonValue(record[key], type);
            if (!coerced.ok) {
              bad = `field "${key}": ${coerced.reason}`;
              break;
            }
            values.push(coerced.value);
          }
          // Records are numbered from 1 in source order, which is the only
          // identifier an inline array has.
          if (bad !== undefined) rejections.push({ row: index + 1, reason: bad });
          else accepted.push({ row: index + 1, values });
        }
        if (input.dryRun === true) {
          rejections.sort((a, b) => a.row - b.row);
          return json({
            dryRun: true,
            table: target.name,
            wouldCreateTable: target.created,
            columns: target.columns,
            inferredTypes: target.created ? inferred : target.types,
            wouldInsert: accepted.length,
            rejected: rejections.length,
            rejections: rejections.slice(0, MAX_REPORTED_REJECTIONS),
          });
        }
        const outcome = insertRows(db, target, accepted, rejections, input.onRowError === "abort");
        if (isRefusal(outcome)) return `ImportJson: ${outcome.message}`;
        return importResult(outcome, target, { source });
      },
    );
  },
});

/** Read a JSON array or NDJSON into records, or say why it could not. */
function parseJsonRecords(
  text: string,
  format: "auto" | "array" | "ndjson",
): Array<Record<string, unknown>> | Refusal {
  const trimmed = text.trim();
  if (trimmed === "") return refuse("ImportJson found an empty file.");
  const asArray = (): Array<Record<string, unknown>> | Refusal => {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      return refuse(`ImportJson could not parse the file as JSON: ${errorText(err)}`);
    }
    if (!Array.isArray(value)) {
      return refuse("ImportJson expected a JSON array of objects at the top level.");
    }
    const records: Array<Record<string, unknown>> = [];
    for (const [index, item] of value.entries()) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return refuse(
          `ImportJson expected every element to be an object; element ${index} is not.`,
        );
      }
      records.push(item as Record<string, unknown>);
    }
    return records;
  };
  const asNdjson = (): Array<Record<string, unknown>> | Refusal => {
    const records: Array<Record<string, unknown>> = [];
    const lines = trimmed.split("\n");
    for (const [index, line] of lines.entries()) {
      const source = line.trim();
      if (source === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(source);
      } catch (err) {
        return refuse(`ImportJson could not parse line ${index + 1} as JSON: ${errorText(err)}`);
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return refuse(`ImportJson expected an object on line ${index + 1}.`);
      }
      records.push(value as Record<string, unknown>);
    }
    return records;
  };
  if (format === "array") return asArray();
  if (format === "ndjson") return asNdjson();
  return trimmed.startsWith("[") ? asArray() : asNdjson();
}

// ---------------------------------------------------------------------------
// export

type ExportSummary = { rows: number; columns: string[]; note?: string };

/**
 * Step a query's rows straight into a sink.
 *
 * Nothing accumulates: the row is shaped, handed to `emit`, and dropped, so
 * an export of a million rows costs one row of memory rather than a million.
 * `emit` returning false means the sink hit its byte cap, which is a
 * truncation the caller is told about rather than a failure.
 */
function exportRows(
  db: Database,
  sql: string,
  bound: BoundArgs,
  deadline: ReturnType<typeof startDeadline>,
  maxRows: number,
  emit: (row: Record<string, unknown>, index: number, columns: readonly string[]) => boolean,
  /**
   * Called once with the column names before any row is read, so a header
   * is written even when the query matches nothing. Returning false means
   * the sink is full, exactly as `emit` does.
   */
  onColumns?: (columns: readonly string[]) => boolean,
): ExportSummary | Refusal {
  let statement: ReturnType<Database["prepare"]> | undefined;
  try {
    statement = db.prepare(sql);
    const mismatch = parameterMismatch(sql, statement, bound);
    if (mismatch !== undefined) return mismatch;
    useSafeIntegers(statement);
    const columns = [...statement.columnNames];
    let rows = 0;
    let note: string | undefined;
    if (onColumns !== undefined && !onColumns(columns)) {
      return {
        rows: 0,
        columns,
        note: `stopped before any row: the export reached the ${MAX_EXPORT_BYTES}-byte limit`,
      };
    }
    // biome-ignore lint/suspicious/noExplicitAny: the row type is the query's, not ours.
    const iterator = statement.iterate(...spreadArgs(bound)) as IterableIterator<any>;
    try {
      for (const raw of iterator) {
        if (deadline.expired()) {
          note = `stopped after ${rows} row(s): the ${deadline.budgetMs} ms budget ran out`;
          break;
        }
        if (!emit(raw as Record<string, unknown>, rows, columns)) {
          note = `stopped after ${rows} row(s): the export reached the ${MAX_EXPORT_BYTES}-byte limit`;
          break;
        }
        rows += 1;
        if (rows >= maxRows) {
          note = `stopped at the ${maxRows}-row limit; there may be more rows`;
          break;
        }
      }
    } finally {
      if (typeof iterator.return === "function") iterator.return(undefined);
    }
    return note === undefined ? { rows, columns } : { rows, columns, note };
  } catch (err) {
    return refuse(sqliteFailure(sql, err));
  } finally {
    finalizeQuietly(statement);
  }
}

const exportFields = {
  database: databaseField,
  sql: z.string().min(1).describe("the read statement whose rows are exported"),
  params: paramsField,
  out: z.string().min(1).describe("destination path, inside the workspace"),
  overwrite: z.boolean().optional().describe("replace the destination if it exists"),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .optional()
    .describe("stop after this many rows (default: no limit beyond the byte cap)"),
  timeout: timeoutField,
};

export const exportCsv: RegisteredTool = buildTool({
  name: "ExportCsv",
  description:
    "Write a query's rows to a CSV file inside the workspace, streaming them rather than holding them in memory. Use to hand a result set to a spreadsheet or another tool without paying for the rows in context. NULL is written as an empty field, which CSV cannot tell from an empty string on the way back, and a BLOB is written as base64 with a marker; the query runs on a read-only connection.",
  inputSchema: z.object({
    ...exportFields,
    delimiter: z.string().length(1).optional().describe("field separator (default ,)"),
    header: z.boolean().optional().describe("write a header row of column names (default true)"),
  }),
  destructive: true,
  execute: async (input) => {
    const delimiterProblem = badDelimiter("ExportCsv", input.delimiter ?? ",");
    if (delimiterProblem !== undefined) return delimiterProblem;
    const guard = guardSql("ExportCsv", input.sql);
    if (guard !== undefined) return guard.message;
    const bound = bindParams("ExportCsv", input.sql, input.params as ParamInput | undefined);
    if (!bound.ok) return bound.message;
    const at = safePath("ExportCsv", input.out);
    if (isRefusal(at)) return at.message;
    const deadline = startDeadline(input.timeout);
    const delimiter = input.delimiter ?? ",";
    return useDatabase(
      "ExportCsv",
      input.database,
      { mode: "read", timeoutMs: deadline.budgetMs },
      (db) => {
        const sink = openSink("ExportCsv", at, input.overwrite === true);
        if (isRefusal(sink)) return sink.message;
        let committed = false;
        try {
          const summary = exportRows(
            db,
            input.sql,
            bound.value,
            deadline,
            input.maxRows ?? Number.MAX_SAFE_INTEGER,
            (row, _index, columns) => {
              const cells = columns.map((column) => csvCell(row[column]));
              return sink.write(`${formatCsvRow(cells, delimiter)}\n`);
            },
            // The header belongs to the file, not to the first row: a query
            // that matches nothing still exports a CSV with its columns,
            // which is what a reader needs to know the shape of what it got.
            (columns) =>
              input.header === false ? true : sink.write(`${formatCsvRow(columns, delimiter)}\n`),
          );
          if (isRefusal(summary)) return summary.message;
          sink.commit();
          committed = true;
          return json({
            file: at.rel,
            rows: summary.rows,
            columns: summary.columns,
            bytes: sink.bytes(),
            ...(summary.note === undefined ? {} : { note: summary.note }),
          });
        } finally {
          if (!committed) sink.discard();
        }
      },
    );
  },
});

export const exportJson: RegisteredTool = buildTool({
  name: "ExportJson",
  description:
    "Write a query's rows to a JSON or newline-delimited JSON file inside the workspace, streaming them rather than holding them in memory. Use when the consumer wants typed values rather than CSV's strings: NULL stays null, and a BLOB becomes an object carrying its base64 and byte length. An integer past 2^53 is written as a decimal string so its digits survive; the query runs on a read-only connection.",
  inputSchema: z.object({
    ...exportFields,
    format: z
      .enum(["array", "ndjson"])
      .optional()
      .describe("one JSON array, or one object per line (default array)"),
  }),
  destructive: true,
  execute: async (input) => {
    const guard = guardSql("ExportJson", input.sql);
    if (guard !== undefined) return guard.message;
    const bound = bindParams("ExportJson", input.sql, input.params as ParamInput | undefined);
    if (!bound.ok) return bound.message;
    const at = safePath("ExportJson", input.out);
    if (isRefusal(at)) return at.message;
    const deadline = startDeadline(input.timeout);
    const ndjson = input.format === "ndjson";
    return useDatabase(
      "ExportJson",
      input.database,
      { mode: "read", timeoutMs: deadline.budgetMs },
      (db) => {
        const sink = openSink("ExportJson", at, input.overwrite === true);
        if (isRefusal(sink)) return sink.message;
        let committed = false;
        try {
          if (!ndjson && !sink.write("[")) return "ExportJson could not write to the destination.";
          const summary = exportRows(
            db,
            input.sql,
            bound.value,
            deadline,
            input.maxRows ?? Number.MAX_SAFE_INTEGER,
            (row, index) => {
              const shaped: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(row)) shaped[key] = shapeValue(value);
              const text = json(shaped);
              return sink.write(ndjson ? `${text}\n` : index === 0 ? text : `,${text}`);
            },
          );
          if (isRefusal(summary)) return summary.message;
          // The closing bracket is written even on a truncated export, so the
          // file is still parseable JSON and the note says it is short.
          if (!ndjson) sink.write("]\n");
          sink.commit();
          committed = true;
          return json({
            file: at.rel,
            format: ndjson ? "ndjson" : "array",
            rows: summary.rows,
            columns: summary.columns,
            bytes: sink.bytes(),
            ...(summary.note === undefined ? {} : { note: summary.note }),
          });
        } finally {
          if (!committed) sink.discard();
        }
      },
    );
  },
});

export const databaseBackup: RegisteredTool = buildTool({
  name: "DatabaseBackup",
  description:
    "Copy a SQLite database to another path inside the workspace using SQLite's own VACUUM INTO, which takes a consistent snapshot while other connections are writing. Use instead of copying the file: a byte copy taken under a live writer can capture a half-written page or miss a write-ahead log entirely, and the result is a file that opens and is wrong. The copy is compacted, so it is usually smaller than the original and is not a byte-for-byte image.",
  inputSchema: z.object({
    database: databaseField,
    out: z.string().min(1).describe("destination path, inside the workspace"),
    overwrite: z.boolean().optional().describe("replace the destination if it exists"),
    timeout: timeoutField,
  }),
  destructive: true,
  execute: async (input) => {
    const at = safePath("DatabaseBackup", input.out);
    if (isRefusal(at)) return at.message;
    const from = safePath("DatabaseBackup", input.database);
    if (isRefusal(from)) return from.message;
    // Checked before the overwrite check, so backing a database up over
    // itself is named for what it is rather than reported as a clash.
    if (from.real === at.real) {
      return "DatabaseBackup refused: the destination is the database itself.";
    }
    if (existsSync(at.real) && input.overwrite !== true) {
      return `DatabaseBackup refused to overwrite "${at.rel}". Pass overwrite: true if replacing it is intended.`;
    }
    if (!existsSync(path.dirname(at.real))) {
      return `DatabaseBackup found no directory "${path.dirname(at.rel)}" to write into.`;
    }
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "DatabaseBackup",
      input.database,
      // Read-only: a backup has no business being able to modify its source.
      // VACUUM INTO works from a read-only connection, which is why this can
      // be both contained and safe — but it IS a write as far as
      // `query_only` is concerned, so this is the one read connection that
      // turns that pragma off. SQLITE_OPEN_READONLY still protects the
      // source, and the destination is `resolveSafe`d and bound, not
      // interpolated.
      { mode: "read", timeoutMs: deadline.budgetMs, queryOnly: false },
      (db, source) => {
        if (existsSync(at.real)) {
          try {
            unlinkSync(at.real);
          } catch (err) {
            return `DatabaseBackup could not replace "${at.rel}": ${errorText(err)}`;
          }
        }
        try {
          // The destination is BOUND, not interpolated: VACUUM INTO takes an
          // expression, so the path never becomes part of the statement text.
          db.run("VACUUM INTO ?", [at.real]);
        } catch (err) {
          return `DatabaseBackup failed: ${errorText(err)}`;
        }
        let bytes = 0;
        let sourceBytes = 0;
        try {
          bytes = statSync(at.real).size;
          sourceBytes = statSync(source.real).size;
        } catch {
          // The copy exists — VACUUM INTO said so — but its size is not
          // worth failing the call over.
        }
        return json({ file: at.rel, bytes, source: source.rel, sourceBytes });
      },
    );
  },
});

// ---------------------------------------------------------------------------
// migrations

/** Where the applied set is recorded unless the caller names another table. */
const DEFAULT_MIGRATIONS_TABLE = "_crewhaus_migrations";

const migrationFields = {
  database: databaseField,
  directory: z.string().min(1).describe("directory of .sql migration files, inside the workspace"),
  table: z
    .string()
    .min(1)
    .optional()
    .describe(`table recording which migrations have run (default ${DEFAULT_MIGRATIONS_TABLE})`),
  timeout: timeoutField,
};

type LoadedMigrations = {
  readonly files: MigrationFile[];
  readonly bodies: Map<string, string>;
  readonly ignored: string[];
  readonly ambiguousOrdering: boolean;
  readonly directory: SafePath;
};

/** Read the directory: which files, in what order, and their checksums. */
function loadMigrations(toolName: string, directory: string): LoadedMigrations | Refusal {
  const at = safePath(toolName, directory);
  if (isRefusal(at)) return at;
  if (!existsSync(at.real)) return refuse(`${toolName} found no directory at "${at.rel}".`);
  try {
    if (!statSync(at.real).isDirectory()) {
      return refuse(`${toolName} refused "${at.rel}": it is a file, not a directory.`);
    }
  } catch (err) {
    return refuse(`${toolName} could not stat "${at.rel}": ${errorText(err)}`);
  }
  let entries: string[];
  try {
    entries = readdirSync(at.real);
  } catch (err) {
    return refuse(`${toolName} could not read "${at.rel}": ${errorText(err)}`);
  }
  const { ordered, ignored } = selectMigrationFiles(entries);
  if (ordered.length > MAX_MIGRATION_FILES) {
    return refuse(
      `${toolName} refused "${at.rel}": it holds ${ordered.length} .sql files, over the ${MAX_MIGRATION_FILES}-file limit. Split the directory, or point the tool at the part that is still pending.`,
    );
  }
  const files: MigrationFile[] = [];
  const bodies = new Map<string, string>();
  let total = 0;
  for (const name of ordered) {
    const file = safePath(toolName, path.join(at.rel === "" ? "." : at.rel, name));
    if (isRefusal(file)) return file;
    const text = readTextFile(toolName, file);
    if (isRefusal(text)) return text;
    total += Buffer.byteLength(text, "utf8");
    if (total > MAX_MIGRATION_BYTES) {
      return refuse(
        `${toolName} refused "${at.rel}": its .sql files come to more than the ${MAX_MIGRATION_BYTES}-byte limit by "${name}". Every file is read before any of them runs, so the whole directory has to fit.`,
      );
    }
    bodies.set(name, text);
    files.push({ name, checksum: checksumOf(text) });
  }
  return {
    files,
    bodies,
    ignored,
    ambiguousOrdering: hasAmbiguousOrdering(ordered),
    directory: at,
  };
}

/** Read the applied set, or report that the table is not there yet. */
function readApplied(
  toolName: string,
  db: Database,
  table: string,
): { rows: AppliedMigration[]; tableExists: boolean } | Refusal {
  if (!isSafeIdentifier(table)) return refuse(`${toolName} refused the table name "${table}".`);
  if (!objectExists(db, table, ["table"])) return { rows: [], tableExists: false };
  try {
    const rows = db
      .prepare(`SELECT name, checksum, applied_at FROM ${quoteIdentifier(table)} ORDER BY name`)
      .all() as Array<{ name: string; checksum: string | null; applied_at: string | null }>;
    return {
      rows: rows.map((row) => ({
        name: row.name,
        checksum: row.checksum ?? "",
        appliedAt: row.applied_at ?? "",
      })),
      tableExists: true,
    };
  } catch (err) {
    return refuse(
      `${toolName} could not read the migrations table "${table}": ${errorText(err)}. This tool expects columns (name, checksum, applied_at); point it at another table if that one is not ours.`,
    );
  }
}

export const migrationStatus: RegisteredTool = buildTool({
  name: "MigrationStatus",
  description:
    "Report which .sql migrations in a directory have been applied to a database and which are still pending. Use before applying anything, and to compare two environments: besides pending and applied it flags a migration whose file changed after it ran, a recorded migration whose file is gone, and a pending file that sorts before one already applied. Files are ordered by plain filename comparison, so mixed-width numeric prefixes are called out as ambiguous.",
  inputSchema: z.object(migrationFields),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const loaded = loadMigrations("MigrationStatus", input.directory);
    if (isRefusal(loaded)) return loaded.message;
    const table = input.table ?? DEFAULT_MIGRATIONS_TABLE;
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "MigrationStatus",
      input.database,
      { mode: "read", timeoutMs: deadline.budgetMs },
      (db) => {
        const applied = readApplied("MigrationStatus", db, table);
        if (isRefusal(applied)) return applied.message;
        const plan = planMigrations(loaded.files, applied.rows);
        const byName = new Map(applied.rows.map((row) => [row.name, row]));
        return json({
          directory: loaded.directory.rel,
          table,
          tableExists: applied.tableExists,
          applied: plan.applied.map((file) => ({
            name: file.name,
            // The stored timestamp is state the caller asked for by asking
            // about migration status; nothing else here reads a clock.
            appliedAt: byName.get(file.name)?.appliedAt ?? "",
          })),
          pending: plan.pending.map((file) => file.name),
          modified: plan.modified,
          missingFiles: plan.missingFiles,
          outOfOrder: plan.outOfOrder,
          ignoredFiles: loaded.ignored,
          ...(loaded.ambiguousOrdering
            ? {
                note: "this directory mixes numeric prefix widths, so filename order and intended order may differ; zero-pad the prefixes",
              }
            : {}),
        });
      },
    );
  },
});

export const migrationApply: RegisteredTool = buildTool({
  name: "MigrationApply",
  description:
    "Apply the pending .sql migrations from a directory in filename order, recording each one and stopping at the first failure. Use to bring a database up to date: a migration already recorded is skipped, each one runs inside its own transaction so a failure leaves that file unapplied, and migrations applied before the failure stay applied. It refuses to start when an applied file has since been edited or when a pending file sorts before an applied one, and a file containing its own BEGIN or COMMIT is refused because it would fight the wrapping transaction.",
  inputSchema: z.object({
    ...migrationFields,
    create: z.boolean().optional().describe("create the database file when it does not exist"),
    foreignKeys: z
      .boolean()
      .optional()
      .describe("enable PRAGMA foreign_keys while migrating (SQLite's own default is off)"),
    dryRun: z.boolean().optional().describe("report what would run without running it"),
  }),
  destructive: true,
  execute: async (input) => {
    const loaded = loadMigrations("MigrationApply", input.directory);
    if (isRefusal(loaded)) return loaded.message;
    const table = input.table ?? DEFAULT_MIGRATIONS_TABLE;
    if (!isSafeIdentifier(table)) return `MigrationApply refused the table name "${table}".`;
    // Every file is checked before any of them runs, so a malformed
    // migration halfway down the list does not leave the database part-way
    // through the sequence.
    for (const file of loaded.files) {
      const body = loaded.bodies.get(file.name) ?? "";
      const guard = guardSql(`MigrationApply "${file.name}"`, body, { allowMultiple: true });
      if (guard !== undefined) return guard.message;
      for (const statement of splitStatements(body)) {
        const keyword = leadingKeyword(statement);
        if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"].includes(keyword)) {
          return `MigrationApply refused "${file.name}": it contains ${keyword}, and each migration already runs inside a transaction this tool opens. Remove the transaction control.`;
        }
      }
    }
    const deadline = startDeadline(input.timeout);
    return useDatabase(
      "MigrationApply",
      input.database,
      {
        mode: "write",
        timeoutMs: deadline.budgetMs,
        ...(input.create === undefined ? {} : { create: input.create }),
        ...(input.foreignKeys === undefined ? {} : { foreignKeys: input.foreignKeys }),
      },
      (db) => {
        if (input.dryRun !== true) {
          try {
            db.run(
              `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`,
            );
          } catch (err) {
            return `MigrationApply could not create the migrations table "${table}": ${errorText(err)}`;
          }
        }
        const applied = readApplied("MigrationApply", db, table);
        if (isRefusal(applied)) return applied.message;
        const plan = planMigrations(loaded.files, applied.rows);
        if (plan.modified.length > 0) {
          return `MigrationApply refused to run: ${plan.modified.join(", ")} already ran but the file has changed since. An applied migration is history — add a new migration instead of editing an old one.`;
        }
        if (plan.outOfOrder.length > 0) {
          return `MigrationApply refused to run: ${plan.outOfOrder.join(", ")} sorts before a migration that has already been applied. Renaming it so it sorts last keeps every environment on the same sequence.`;
        }
        if (input.dryRun === true) {
          return json({
            dryRun: true,
            directory: loaded.directory.rel,
            table,
            pending: plan.pending.map((file) => file.name),
            alreadyApplied: plan.applied.length,
            missingFiles: plan.missingFiles,
          });
        }
        const appliedNow: string[] = [];
        let failure: { name: string; message: string } | undefined;
        for (const file of plan.pending) {
          if (deadline.expired()) {
            failure = {
              name: file.name,
              message: `the ${deadline.budgetMs} ms budget ran out before this file started`,
            };
            break;
          }
          const body = loaded.bodies.get(file.name) ?? "";
          const record = db.prepare(
            `INSERT INTO ${quoteIdentifier(table)} (name, checksum, applied_at) VALUES (?, ?, ?)`,
          );
          const run = db.transaction(() => {
            // `exec` runs the whole file: SQLite parses the statements, so a
            // trigger body or any other construct the splitter only
            // approximates is executed exactly as written.
            db.exec(body);
            // The timestamp is recorded for the operator reading the table
            // later. It is deliberately not part of this tool's output.
            record.run(file.name, file.checksum, new Date().toISOString());
          });
          try {
            run();
            appliedNow.push(file.name);
          } catch (err) {
            failure = { name: file.name, message: errorText(err) };
            break;
          } finally {
            finalizeQuietly(record);
          }
        }
        const remaining = plan.pending
          .map((file) => file.name)
          .filter((name) => !appliedNow.includes(name));
        return json({
          directory: loaded.directory.rel,
          table,
          applied: appliedNow,
          skipped: plan.applied.map((file) => file.name),
          pending: remaining,
          ...(plan.missingFiles.length === 0 ? {} : { missingFiles: plan.missingFiles }),
          ...(failure === undefined
            ? {}
            : {
                failed: failure.name,
                error: `${failure.message}. "${failure.name}" was rolled back; the ${appliedNow.length} migration(s) before it stay applied.`,
              }),
        });
      },
    );
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const SQL_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  databaseBackup,
  exportCsv,
  exportJson,
  importCsv,
  importJson,
  integrityCheck,
  migrationApply,
  migrationStatus,
  schemaDescribe,
  dbSchemaDiff,
  schemaList,
  sqlExec,
  sqlExplain,
  sqlQuery,
  sqlTransaction,
  tableStats,
]);

export { ToolPermissionError } from "./paths";
