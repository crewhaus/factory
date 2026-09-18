/**
 * Every tool in this package, driven against a real SQLite database.
 *
 * Each test builds a throwaway workspace under the OS temp directory and
 * chdir's into it, because the containment boundary is `process.cwd()` — the
 * same arrangement `@crewhaus/tool-fsx` and `@crewhaus/tool-git` use. Nothing
 * is ever written inside the repository, and the workspace is removed
 * afterwards.
 *
 * Three groups of tests matter most and are kept explicit: the safety flags
 * the runtime reads, the refusals (a path that escapes, a deadline that
 * fires, an injection attempt), and the determinism claims.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parameterMismatch } from "./db";
import {
  SQL_TOOLS,
  databaseBackup,
  dbSchemaDiff,
  exportCsv,
  exportJson,
  importCsv,
  importJson,
  integrityCheck,
  migrationApply,
  migrationStatus,
  schemaDescribe,
  schemaList,
  sqlExec,
  sqlExplain,
  sqlQuery,
  sqlTransaction,
  tableStats,
} from "./index";
import { namedParameters, positionalParameterCount } from "./lib/sql-text";

let workspace = "";
let originalCwd = "";
const outsideDirs: string[] = [];

/** A workspace with a populated database in it. */
function seedDatabase(file = "app.db"): void {
  const db = new Database(join(workspace, file), { create: true });
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER);" +
      "CREATE TABLE posts(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), title TEXT);" +
      "CREATE INDEX users_name ON users(name);" +
      "CREATE VIEW adults AS SELECT name FROM users WHERE age >= 18;",
  );
  db.exec("INSERT INTO users(name, age) VALUES('ada', 36), ('bob', 41), ('cy', 12)");
  db.exec("INSERT INTO posts(user_id, title) VALUES(1, 'first')");
  db.close();
}

/** Run a tool and parse its JSON, or hand back the refusal sentence. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: (typeof SQL_TOOLS)[number], input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-sql-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

afterAll(() => {
  for (const dir of outsideDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("package-wide contract", () => {
  test("every tool is exported in SQL_TOOLS, and the list is frozen", () => {
    expect(SQL_TOOLS.length).toBe(16);
    expect(Object.isFrozen(SQL_TOOLS)).toBe(true);
  });

  test("names are unique and PascalCase", () => {
    const names = SQL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every description says what the tool is for", () => {
    for (const tool of SQL_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.description).toContain("Use ");
    }
  });

  test("this package touches files only, so nothing is external and nothing declares io", () => {
    for (const tool of SQL_TOOLS) {
      expect({ name: tool.name, scope: tool.scope }).toEqual({
        name: tool.name,
        scope: "internal",
      });
      expect(tool.ioCapability).toBeUndefined();
      // No tool here has an outward side effect — nothing is posted or sent.
      expect(tool.requireJustification).toBe(false);
    }
  });

  test("the reads are read-only and concurrency-safe; the writers are neither", () => {
    const reads = [
      "SqlQuery",
      "SqlExplain",
      "SchemaList",
      "SchemaDescribe",
      "DbSchemaDiff",
      "TableStats",
      "MigrationStatus",
      "IntegrityCheck",
    ];
    for (const tool of SQL_TOOLS) {
      const expected = reads.includes(tool.name);
      expect({ name: tool.name, readOnly: tool.readOnly }).toEqual({
        name: tool.name,
        readOnly: expected,
      });
      expect({ name: tool.name, destructive: tool.destructive }).toEqual({
        name: tool.name,
        destructive: !expected,
      });
      expect({ name: tool.name, concurrencySafe: tool.concurrencySafe }).toEqual({
        name: tool.name,
        concurrencySafe: expected,
      });
    }
  });

  test("every schema refuses an empty input", () => {
    for (const tool of SQL_TOOLS) {
      expect({ name: tool.name, ok: tool.inputSchema.safeParse({}).success }).toEqual({
        name: tool.name,
        ok: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe("containment", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test("a database path that climbs out of the workspace is refused", async () => {
    const out = await run(sqlQuery, { database: "../escape.db", sql: "SELECT 1" });
    expect(out).toContain("outside the workspace root");
  });

  test("an absolute path outside the workspace is refused", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-sql-outside-")));
    outsideDirs.push(outside);
    const out = await run(sqlQuery, { database: join(outside, "x.db"), sql: "SELECT 1" });
    expect(out).toContain("outside the workspace root");
  });

  test("a symlink inside the workspace pointing outside is refused", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-sql-link-")));
    outsideDirs.push(outside);
    const target = new Database(join(outside, "secret.db"), { create: true });
    target.exec("CREATE TABLE s(a)");
    target.close();
    symlinkSync(join(outside, "secret.db"), join(workspace, "link.db"));
    const out = await run(sqlQuery, { database: "link.db", sql: "SELECT 1" });
    expect(out).toContain("outside the workspace root");
  });

  test("an export destination outside the workspace is refused", async () => {
    const out = await run(exportCsv, {
      database: "app.db",
      sql: "SELECT 1 AS n",
      out: "../leak.csv",
    });
    expect(out).toContain("outside the workspace root");
  });

  test("a backup destination outside the workspace is refused", async () => {
    const out = await run(databaseBackup, { database: "app.db", out: "../leak.db" });
    expect(out).toContain("outside the workspace root");
  });

  test("a migration directory outside the workspace is refused", async () => {
    const out = await run(migrationStatus, { database: "app.db", directory: "../elsewhere" });
    expect(out).toContain("outside the workspace root");
  });

  test.each([
    ["ATTACH DATABASE '/etc/passwd' AS leak", "ATTACH"],
    ["DETACH DATABASE main", "DETACH"],
    ["VACUUM INTO '/tmp/leak.db'", "VACUUM"],
    ["SELECT load_extension('/tmp/evil.so')", "LOAD_EXTENSION"],
  ])("%s is refused before SQLite sees it", async (sql, word) => {
    const out = await run(sqlQuery, { database: "app.db", sql });
    expect(out).toContain(word);
    expect(out).toContain("refused");
  });

  test("a missing database is a sentence, not a new empty file", async () => {
    const out = await run(sqlQuery, { database: "nope.db", sql: "SELECT 1" });
    expect(out).toContain("found no database");
    expect(await Bun.file(join(workspace, "nope.db")).exists()).toBe(false);
  });

  test("a write to a missing database needs create, and then makes one", async () => {
    const refused = await run(sqlExec, { database: "fresh.db", sql: "CREATE TABLE t(a)" });
    expect(refused).toContain("create: true");
    const made = await run(sqlExec, {
      database: "fresh.db",
      sql: "CREATE TABLE t(a)",
      create: true,
    });
    expect(made.statement).toBe("CREATE");
  });

  test("a file that is not a SQLite database is named as such", async () => {
    writeFileSync(join(workspace, "notes.txt"), "plain text, quite a lot of it, ".repeat(50));
    const out = await run(sqlQuery, { database: "notes.txt", sql: "SELECT 1" });
    expect(out).toContain("SQLite");
  });
});

// ---------------------------------------------------------------------------

describe("SqlQuery", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test("returns columns and rows for a bound query", async () => {
    const out = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT name, age FROM users WHERE age > ? ORDER BY name",
      params: [20],
    });
    expect(out.columns).toEqual(["name", "age"]);
    expect(out.rows).toEqual([
      { name: "ada", age: 36 },
      { name: "bob", age: 41 },
    ]);
  });

  test("the same call twice returns the same bytes", async () => {
    const first = await sqlQuery.execute({
      database: "app.db",
      sql: "SELECT * FROM users ORDER BY id",
    });
    const second = await sqlQuery.execute({
      database: "app.db",
      sql: "SELECT * FROM users ORDER BY id",
    });
    expect(first).toBe(second);
  });

  test("named parameters bind with or without their sigil", async () => {
    const withSigil = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT name FROM users WHERE name = $who",
      params: { $who: "ada" },
    });
    const without = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT name FROM users WHERE name = $who",
      params: { who: "ada" },
    });
    expect(withSigil.rows).toEqual([{ name: "ada" }]);
    expect(without.rows).toEqual([{ name: "ada" }]);
  });

  test("a parameter the statement never uses is refused, not ignored", async () => {
    const out = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT name FROM users WHERE name = $who",
      params: { whoo: "ada" },
    });
    expect(out).toContain("never uses");
  });

  test("a mismatched positional count is refused rather than bound to NULL", async () => {
    const out = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT * FROM users WHERE name = ? AND age = ?",
      params: ["ada"],
    });
    expect(out).toContain("SQLite binds the difference to NULL");
  });

  test("a list of params against a named statement is refused", async () => {
    const out = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT * FROM users WHERE name = $who",
      params: ["ada"],
    });
    expect(out).toContain("named parameters");
  });

  test("a value that looks like SQL is stored as a value, never as SQL", async () => {
    await run(sqlExec, {
      database: "app.db",
      sql: "INSERT INTO users(name, age) VALUES(?, ?)",
      params: ["'); DROP TABLE users; --", 1],
    });
    const out = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT count(*) AS n FROM users WHERE name = ?",
      params: ["'); DROP TABLE users; --"],
    });
    expect(out.rows).toEqual([{ n: 1 }]);
    const still = await run(schemaList, { database: "app.db", types: ["table"] });
    expect(still.objects.map((o: { name: string }) => o.name)).toContain("users");
  });

  test("a write is refused by SQLite even when a CTE hides it", async () => {
    const out = await run(sqlQuery, {
      database: "app.db",
      sql: "WITH doomed AS (SELECT 1) DELETE FROM users",
    });
    expect(out).toContain("readonly");
    const rows = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT count(*) AS n FROM users",
    });
    expect(rows.rows).toEqual([{ n: 3 }]);
  });

  test("a write disguised as a pragma is refused too", async () => {
    const out = await run(sqlQuery, { database: "app.db", sql: "PRAGMA journal_mode = WAL" });
    expect(out).toContain("readonly");
  });

  test("a second statement is refused rather than silently discarded", async () => {
    const out = await run(sqlQuery, { database: "app.db", sql: "SELECT 1; DROP TABLE users" });
    expect(out).toContain("discards the rest silently");
  });

  test("the row cap truncates with a note that says so", async () => {
    const out = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT * FROM users ORDER BY id",
      maxRows: 2,
    });
    expect(out.rowCount).toBe(2);
    expect(out.note).toContain("2-row limit");
  });

  test("a deadline stops the scan and says the budget ran out", async () => {
    const db = new Database(join(workspace, "big.db"), { create: true });
    db.exec("CREATE TABLE n(i INTEGER, pad TEXT)");
    const insert = db.prepare("INSERT INTO n VALUES(?, ?)");
    db.transaction(() => {
      for (let i = 0; i < 60_000; i++) insert.run(i, "x".repeat(40));
    })();
    db.close();
    const out = await run(sqlQuery, {
      database: "big.db",
      sql: "SELECT * FROM n",
      maxRows: 60_000,
      timeout: 1,
    });
    expect(out.note).toContain("budget ran out");
    expect(out.rowCount).toBeLessThan(60_000);
  });

  test("a BLOB comes back as base64 with its byte length", async () => {
    await run(sqlExec, { database: "app.db", sql: "CREATE TABLE b(v BLOB)" });
    const db = new Database(join(workspace, "app.db"));
    db.prepare("INSERT INTO b VALUES(?)").run(new Uint8Array([1, 2, 3]));
    db.close();
    const out = await run(sqlQuery, { database: "app.db", sql: "SELECT v FROM b" });
    expect(out.rows[0].v).toEqual({ blob: { bytes: 3, base64: "AQID" } });
  });

  test("an integer past 2^53 keeps its digits", async () => {
    const out = await run(sqlQuery, { database: "app.db", sql: "SELECT 9007199254740993 AS big" });
    expect(out.rows[0].big).toBe("9007199254740993");
  });

  test("a bad statement is a sentence carrying the statement", async () => {
    const out = await run(sqlQuery, { database: "app.db", sql: "SELECT missing FROM users" });
    expect(out).toContain("no such column");
    expect(out).toContain("SELECT missing FROM users");
  });
});

// ---------------------------------------------------------------------------

describe("SqlExec and SqlTransaction", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test("an update reports the rows it changed", async () => {
    const out = await run(sqlExec, {
      database: "app.db",
      sql: "UPDATE users SET age = ? WHERE name = ?",
      params: [37, "ada"],
    });
    expect(out.changes).toBe(1);
    expect(out.statement).toBe("UPDATE");
  });

  test("an insert reports the new rowid", async () => {
    const out = await run(sqlExec, {
      database: "app.db",
      sql: "INSERT INTO users(name, age) VALUES(?, ?)",
      params: ["dee", 22],
    });
    expect(out.lastInsertRowid).toBe(4);
  });

  test("a SELECT sent to SqlExec is called out rather than reported as a no-op", async () => {
    const out = await run(sqlExec, { database: "app.db", sql: "SELECT * FROM users" });
    expect(out.note).toContain("SqlQuery");
  });

  test("a constraint violation comes back as a sentence", async () => {
    const out = await run(sqlExec, {
      database: "app.db",
      sql: "INSERT INTO users(name, age) VALUES(NULL, 1)",
    });
    expect(out).toContain("NOT NULL");
  });

  test("a transaction applies every statement or none of them", async () => {
    const ok = await run(sqlTransaction, {
      database: "app.db",
      statements: [
        { sql: "INSERT INTO users(name, age) VALUES(?, ?)", params: ["dee", 22] },
        { sql: "INSERT INTO posts(user_id, title) VALUES(?, ?)", params: [4, "hello"] },
      ],
    });
    expect(ok.applied).toBe(2);

    const rolled = await run(sqlTransaction, {
      database: "app.db",
      statements: [
        { sql: "INSERT INTO users(name, age) VALUES(?, ?)", params: ["eve", 30] },
        { sql: "INSERT INTO nowhere VALUES(1)" },
      ],
    });
    expect(rolled).toContain("rolled back");
    expect(rolled).toContain("statement 1");
    const after = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT count(*) AS n FROM users WHERE name = 'eve'",
    });
    expect(after.rows).toEqual([{ n: 0 }]);
  });

  test("a statement is refused before the transaction opens, not during it", async () => {
    const out = await run(sqlTransaction, {
      database: "app.db",
      statements: [
        { sql: "INSERT INTO users(name, age) VALUES(?, ?)", params: ["eve", 30] },
        { sql: "ATTACH DATABASE '/etc/passwd' AS leak" },
      ],
    });
    expect(out).toContain("ATTACH");
    const after = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT count(*) AS n FROM users WHERE name = 'eve'",
    });
    expect(after.rows).toEqual([{ n: 0 }]);
  });

  test("a statement carrying its own transaction control is refused", async () => {
    const out = await run(sqlTransaction, { database: "app.db", statements: [{ sql: "BEGIN" }] });
    expect(out).toContain("already wraps");
  });

  test("foreign keys are off unless asked for, and enforced when asked", async () => {
    const off = await run(sqlExec, {
      database: "app.db",
      sql: "INSERT INTO posts(user_id, title) VALUES(999, 'orphan')",
    });
    expect(off.changes).toBe(1);
    const on = await run(sqlExec, {
      database: "app.db",
      sql: "INSERT INTO posts(user_id, title) VALUES(998, 'orphan')",
      foreignKeys: true,
    });
    expect(on).toContain("FOREIGN KEY");
  });
});

// ---------------------------------------------------------------------------

describe("SqlExplain", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test("an unindexed filter shows the table in fullScans", async () => {
    const out = await run(sqlExplain, {
      database: "app.db",
      sql: "SELECT * FROM users WHERE age = ?",
      params: [36],
    });
    expect(out.fullScans).toEqual(["users"]);
    expect(out.tree).toContain("SCAN");
  });

  test("an indexed filter shows the index instead", async () => {
    const out = await run(sqlExplain, {
      database: "app.db",
      sql: "SELECT * FROM users WHERE name = ?",
      params: ["ada"],
    });
    expect(out.fullScans).toEqual([]);
    expect(out.indexes).toContain("users_name");
  });

  test("planning does not run the statement", async () => {
    const out = await run(sqlExplain, { database: "app.db", sql: "DELETE FROM users" });
    expect(out.statement).toBe("DELETE");
    const after = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT count(*) AS n FROM users",
    });
    expect(after.rows).toEqual([{ n: 3 }]);
  });
});

// ---------------------------------------------------------------------------

describe("schema tools", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test("SchemaList reports every kind, sorted, without SQLite's own objects", async () => {
    const out = await run(schemaList, { database: "app.db" });
    expect(out.counts).toEqual({ table: 2, view: 1, index: 1, trigger: 0 });
    // Ordered by kind, then by name, so two runs list them identically.
    expect(out.objects).toEqual([
      { type: "index", name: "users_name", on: "users" },
      { type: "table", name: "posts" },
      { type: "table", name: "users" },
      { type: "view", name: "adults" },
    ]);
  });

  test("SchemaList can be narrowed to one kind", async () => {
    const out = await run(schemaList, { database: "app.db", types: ["view"] });
    expect(out.objects).toEqual([{ type: "view", name: "adults" }]);
  });

  test("SchemaDescribe reports columns, keys and indexes", async () => {
    const out = await run(schemaDescribe, { database: "app.db", table: "users" });
    expect(out.primaryKey).toEqual(["id"]);
    expect(out.columns.find((c: { name: string }) => c.name === "name").notNull).toBe(true);
    expect(out.indexes.map((i: { name: string }) => i.name)).toEqual(["users_name"]);
  });

  test("SchemaDescribe reports a table's outgoing foreign keys", async () => {
    const out = await run(schemaDescribe, { database: "app.db", table: "posts" });
    expect(out.foreignKeys).toEqual([
      {
        column: "user_id",
        referencesTable: "users",
        referencesColumn: "id",
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
      },
    ]);
  });

  test("SchemaDescribe on an unknown table lists what is there", async () => {
    const out = await run(schemaDescribe, { database: "app.db", table: "nope" });
    expect(out).toContain("users");
  });

  test("DbSchemaDiff finds an added table and a changed column", async () => {
    seedDatabase("other.db");
    const db = new Database(join(workspace, "other.db"));
    db.exec("CREATE TABLE extra(a); ALTER TABLE users ADD COLUMN email TEXT");
    db.close();
    const out = await run(dbSchemaDiff, { left: "app.db", right: "other.db" });
    expect(out.identical).toBe(false);
    expect(out.onlyInRight.map((o: { name: string }) => o.name)).toEqual(["extra"]);
    const changed = out.changed.find((c: { name: string }) => c.name === "users");
    expect(changed.columnsOnlyInRight).toEqual(["email"]);
  });

  test("DbSchemaDiff of a database with itself is identical", async () => {
    const out = await run(dbSchemaDiff, { left: "app.db", right: "app.db" });
    expect(out.identical).toBe(true);
  });

  test("TableStats counts rows per table and sorts them", async () => {
    const out = await run(tableStats, { database: "app.db" });
    expect(out.tables.map((t: { name: string }) => t.name)).toEqual(["posts", "users"]);
    expect(out.tables.find((t: { name: string }) => t.name === "users").rows).toBe(3);
    expect(out.totalRows).toBe(4);
  });

  test("TableStats names a table that is not there", async () => {
    const out = await run(tableStats, { database: "app.db", tables: ["ghost"] });
    expect(out).toContain("ghost");
  });

  test("IntegrityCheck passes on a healthy database", async () => {
    const out = await run(integrityCheck, { database: "app.db" });
    expect(out).toEqual({
      ok: true,
      check: "integrity_check",
      problems: [],
      foreignKeyViolations: [],
    });
  });

  test("IntegrityCheck reports an orphan row even with foreign keys off", async () => {
    await run(sqlExec, {
      database: "app.db",
      sql: "INSERT INTO posts(user_id, title) VALUES(404, 'orphan')",
    });
    const out = await run(integrityCheck, { database: "app.db" });
    expect(out.ok).toBe(false);
    expect(out.foreignKeyViolations[0]).toMatchObject({ table: "posts", parent: "users" });
  });
});

// ---------------------------------------------------------------------------

describe("import", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test("a CSV loads into an existing table and reports rejections with reasons", async () => {
    writeFileSync(join(workspace, "people.csv"), "name,age\nzed,50\nbad,notanumber\nquin,\n");
    const out = await run(importCsv, { database: "app.db", file: "people.csv", table: "users" });
    expect(out.inserted).toBe(2);
    expect(out.rejected).toBe(1);
    expect(out.rejections[0]).toEqual({
      row: 3,
      reason: 'column "age": "notanumber" is not an integer',
    });
  });

  test("a row with the wrong number of fields is rejected by line number", async () => {
    writeFileSync(join(workspace, "ragged.csv"), "name,age\nzed,50,extra\n");
    const out = await run(importCsv, { database: "app.db", file: "ragged.csv", table: "users" });
    expect(out.rejections[0]).toEqual({ row: 2, reason: "has 3 field(s), expected 2" });
  });

  test("createTable infers column types from the data", async () => {
    writeFileSync(join(workspace, "m.csv"), "id,score,label\n1,1.5,alpha\n2,2.5,beta\n");
    const out = await run(importCsv, {
      database: "app.db",
      file: "m.csv",
      table: "metrics",
      createTable: true,
    });
    expect(out.createdTable).toBe(true);
    const described = await run(schemaDescribe, { database: "app.db", table: "metrics" });
    expect(described.columns.map((c: { type: string }) => c.type)).toEqual([
      "INTEGER",
      "REAL",
      "TEXT",
    ]);
  });

  test("without createTable a missing table is refused, and nothing is created", async () => {
    writeFileSync(join(workspace, "m.csv"), "a\n1\n");
    const out = await run(importCsv, { database: "app.db", file: "m.csv", table: "ghost" });
    expect(out).toContain("createTable: true");
    const list = await run(schemaList, { database: "app.db", types: ["table"] });
    expect(list.objects.map((o: { name: string }) => o.name)).not.toContain("ghost");
  });

  test("a column the table does not have is named, with the ones it does", async () => {
    writeFileSync(join(workspace, "m.csv"), "name,nickname\nzed,z\n");
    const out = await run(importCsv, { database: "app.db", file: "m.csv", table: "users" });
    expect(out).toContain("nickname");
    expect(out).toContain("age");
  });

  test("a header that closes with SQL does not become SQL", async () => {
    writeFileSync(join(workspace, "evil.csv"), 'a"); DROP TABLE users; --\nvalue\n');
    await run(importCsv, {
      database: "app.db",
      file: "evil.csv",
      table: "sneaky",
      createTable: true,
    });
    const list = await run(schemaList, { database: "app.db", types: ["table"] });
    expect(list.objects.map((o: { name: string }) => o.name)).toContain("users");
  });

  test("a table name that closes with SQL does not become SQL", async () => {
    writeFileSync(join(workspace, "m.csv"), "a\n1\n");
    await run(importCsv, {
      database: "app.db",
      file: "m.csv",
      table: 'x"); DROP TABLE users; --',
      createTable: true,
    });
    const list = await run(schemaList, { database: "app.db", types: ["table"] });
    expect(list.objects.map((o: { name: string }) => o.name)).toContain("users");
  });

  test("onRowError abort rolls the whole import back", async () => {
    writeFileSync(join(workspace, "people.csv"), "name,age\nzed,50\nbad,notanumber\n");
    const out = await run(importCsv, {
      database: "app.db",
      file: "people.csv",
      table: "users",
      onRowError: "abort",
    });
    expect(out).toContain("rolled back");
    const count = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT count(*) AS n FROM users",
    });
    expect(count.rows).toEqual([{ n: 3 }]);
  });

  test("dryRun validates and writes nothing", async () => {
    writeFileSync(join(workspace, "m.csv"), "a,b\n1,x\n");
    const out = await run(importCsv, {
      database: "app.db",
      file: "m.csv",
      table: "dry",
      createTable: true,
      dryRun: true,
    });
    expect(out.dryRun).toBe(true);
    expect(out.wouldInsert).toBe(1);
    const list = await run(schemaList, { database: "app.db", types: ["table"] });
    expect(list.objects.map((o: { name: string }) => o.name)).not.toContain("dry");
  });

  test("an unterminated quote in the CSV is refused rather than half-read", async () => {
    writeFileSync(join(workspace, "broken.csv"), 'name,age\n"zed,50\n');
    const out = await run(importCsv, { database: "app.db", file: "broken.csv", table: "users" });
    expect(out).toContain("never closed");
  });

  test("a CSV path outside the workspace is refused", async () => {
    const out = await run(importCsv, { database: "app.db", file: "../x.csv", table: "users" });
    expect(out).toContain("outside the workspace root");
  });

  test("JSON records load, creating the table from inferred types", async () => {
    const out = await run(importJson, {
      database: "app.db",
      table: "events",
      createTable: true,
      records: [
        { kind: "click", count: 2, ok: true },
        { kind: "view", count: 5, ok: false },
      ],
    });
    expect(out.inserted).toBe(2);
    const rows = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT * FROM events ORDER BY kind",
    });
    expect(rows.rows).toEqual([
      { kind: "click", count: 2, ok: 1 },
      { kind: "view", count: 5, ok: 0 },
    ]);
  });

  test("NDJSON in a file is read one record per line", async () => {
    writeFileSync(join(workspace, "log.ndjson"), '{"a":1}\n{"a":2}\n');
    const out = await run(importJson, {
      database: "app.db",
      file: "log.ndjson",
      table: "log",
      createTable: true,
    });
    expect(out.inserted).toBe(2);
  });

  test("a nested value becomes JSON text in a TEXT column", async () => {
    const out = await run(importJson, {
      database: "app.db",
      table: "docs",
      createTable: true,
      records: [{ body: { a: [1, 2] } }],
    });
    expect(out.inserted).toBe(1);
    const rows = await run(sqlQuery, { database: "app.db", sql: "SELECT body FROM docs" });
    expect(rows.rows[0].body).toBe('{"a":[1,2]}');
  });

  test("passing both a file and records is refused", async () => {
    const out = await run(importJson, {
      database: "app.db",
      table: "x",
      file: "a.json",
      records: [{ a: 1 }],
    });
    expect(out).toContain("exactly one");
  });
});

// ---------------------------------------------------------------------------

describe("export and backup", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test("ExportCsv writes a header and every row", async () => {
    const out = await run(exportCsv, {
      database: "app.db",
      sql: "SELECT name, age FROM users ORDER BY name",
      out: "users.csv",
    });
    expect(out.rows).toBe(3);
    expect(readFileSync(join(workspace, "users.csv"), "utf8")).toBe(
      "name,age\nada,36\nbob,41\ncy,12\n",
    );
  });

  test("ExportCsv refuses to overwrite unless told to", async () => {
    writeFileSync(join(workspace, "users.csv"), "existing");
    const refused = await run(exportCsv, {
      database: "app.db",
      sql: "SELECT 1 AS n",
      out: "users.csv",
    });
    expect(refused).toContain("overwrite: true");
    expect(readFileSync(join(workspace, "users.csv"), "utf8")).toBe("existing");
    const ok = await run(exportCsv, {
      database: "app.db",
      sql: "SELECT 1 AS n",
      out: "users.csv",
      overwrite: true,
    });
    expect(ok.rows).toBe(1);
  });

  test("a failed export leaves no partial file behind", async () => {
    const out = await run(exportCsv, {
      database: "app.db",
      sql: "SELECT * FROM nowhere",
      out: "broken.csv",
    });
    expect(out).toContain("no such table");
    expect(await Bun.file(join(workspace, "broken.csv")).exists()).toBe(false);
  });

  test("ExportJson writes a parseable array", async () => {
    await run(exportJson, {
      database: "app.db",
      sql: "SELECT name FROM users ORDER BY name",
      out: "users.json",
    });
    expect(JSON.parse(readFileSync(join(workspace, "users.json"), "utf8"))).toEqual([
      { name: "ada" },
      { name: "bob" },
      { name: "cy" },
    ]);
  });

  test("ExportJson can write newline-delimited records", async () => {
    await run(exportJson, {
      database: "app.db",
      sql: "SELECT name FROM users ORDER BY name",
      out: "users.ndjson",
      format: "ndjson",
    });
    const lines = readFileSync(join(workspace, "users.ndjson"), "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).name)).toEqual(["ada", "bob", "cy"]);
  });

  test("an export cannot write through a statement that changes the database", async () => {
    const out = await run(exportCsv, {
      database: "app.db",
      sql: "DELETE FROM users RETURNING name",
      out: "gone.csv",
    });
    expect(out).toContain("readonly");
  });

  test("DatabaseBackup produces a database with the same rows", async () => {
    const out = await run(databaseBackup, { database: "app.db", out: "copy.db" });
    expect(out.bytes).toBeGreaterThan(0);
    const rows = await run(sqlQuery, {
      database: "copy.db",
      sql: "SELECT count(*) AS n FROM users",
    });
    expect(rows.rows).toEqual([{ n: 3 }]);
  });

  test("DatabaseBackup refuses to overwrite, and refuses to target itself", async () => {
    await run(databaseBackup, { database: "app.db", out: "copy.db" });
    const refused = await run(databaseBackup, { database: "app.db", out: "copy.db" });
    expect(refused).toContain("overwrite: true");
    const itself = await run(databaseBackup, { database: "app.db", out: "app.db" });
    expect(itself).toContain("the database itself");
  });
});

// ---------------------------------------------------------------------------

describe("migrations", () => {
  function writeMigrations(files: Record<string, string>): void {
    mkdirSync(join(workspace, "migrations"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(workspace, "migrations", name), body);
    }
  }

  beforeEach(() => {
    seedDatabase();
  });

  test("status reports pending before anything has run", async () => {
    writeMigrations({ "001_a.sql": "CREATE TABLE a(x);", "002_b.sql": "CREATE TABLE b(x);" });
    const out = await run(migrationStatus, { database: "app.db", directory: "migrations" });
    expect(out.tableExists).toBe(false);
    expect(out.pending).toEqual(["001_a.sql", "002_b.sql"]);
  });

  test("apply runs them in order and a second apply is a no-op", async () => {
    writeMigrations({ "001_a.sql": "CREATE TABLE a(x);", "002_b.sql": "CREATE TABLE b(x);" });
    const first = await run(migrationApply, { database: "app.db", directory: "migrations" });
    expect(first.applied).toEqual(["001_a.sql", "002_b.sql"]);
    const second = await run(migrationApply, { database: "app.db", directory: "migrations" });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["001_a.sql", "002_b.sql"]);
  });

  test("a multi-statement migration is applied whole", async () => {
    writeMigrations({ "001_a.sql": "CREATE TABLE a(x);\nCREATE TABLE b(y);\n" });
    await run(migrationApply, { database: "app.db", directory: "migrations" });
    const list = await run(schemaList, { database: "app.db", types: ["table"] });
    const names = list.objects.map((o: { name: string }) => o.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  test("a failing migration is rolled back and the ones before it stay", async () => {
    writeMigrations({
      "001_a.sql": "CREATE TABLE a(x);",
      "002_b.sql": "CREATE TABLE b(x);\nINSERT INTO nowhere VALUES(1);\n",
      "003_c.sql": "CREATE TABLE c(x);",
    });
    const out = await run(migrationApply, { database: "app.db", directory: "migrations" });
    expect(out.applied).toEqual(["001_a.sql"]);
    expect(out.failed).toBe("002_b.sql");
    expect(out.pending).toEqual(["002_b.sql", "003_c.sql"]);
    const list = await run(schemaList, { database: "app.db", types: ["table"] });
    const names = list.objects.map((o: { name: string }) => o.name);
    expect(names).toContain("a");
    expect(names).not.toContain("b");
    expect(names).not.toContain("c");
  });

  test("editing an applied migration stops the next apply", async () => {
    writeMigrations({ "001_a.sql": "CREATE TABLE a(x);" });
    await run(migrationApply, { database: "app.db", directory: "migrations" });
    writeMigrations({ "001_a.sql": "CREATE TABLE a(x, y);" });
    const status = await run(migrationStatus, { database: "app.db", directory: "migrations" });
    expect(status.modified).toEqual(["001_a.sql"]);
    const out = await run(migrationApply, { database: "app.db", directory: "migrations" });
    expect(out).toContain("already ran but the file has changed");
  });

  test("a new migration that sorts before an applied one is refused", async () => {
    writeMigrations({ "002_b.sql": "CREATE TABLE b(x);" });
    await run(migrationApply, { database: "app.db", directory: "migrations" });
    writeMigrations({ "001_a.sql": "CREATE TABLE a(x);" });
    const out = await run(migrationApply, { database: "app.db", directory: "migrations" });
    expect(out).toContain("sorts before");
  });

  test("a migration carrying its own COMMIT is refused before anything runs", async () => {
    writeMigrations({ "001_a.sql": "BEGIN;\nCREATE TABLE a(x);\nCOMMIT;\n" });
    const out = await run(migrationApply, { database: "app.db", directory: "migrations" });
    expect(out).toContain("already runs inside a transaction");
    const list = await run(schemaList, { database: "app.db", types: ["table"] });
    expect(list.objects.map((o: { name: string }) => o.name)).not.toContain("a");
  });

  test("a migration containing ATTACH is refused", async () => {
    writeMigrations({ "001_a.sql": "ATTACH DATABASE '/etc/passwd' AS leak;" });
    const out = await run(migrationApply, { database: "app.db", directory: "migrations" });
    expect(out).toContain("ATTACH");
  });

  test("non-.sql files are ignored and mixed prefix widths are flagged", async () => {
    writeMigrations({
      "2_a.sql": "CREATE TABLE a(x);",
      "10_b.sql": "CREATE TABLE b(x);",
      "README.md": "not a migration",
    });
    const out = await run(migrationStatus, { database: "app.db", directory: "migrations" });
    expect(out.ignoredFiles).toEqual(["README.md"]);
    expect(out.pending).toEqual(["10_b.sql", "2_a.sql"]);
    expect(out.note).toContain("zero-pad");
  });

  test("dryRun reports the plan without applying it", async () => {
    writeMigrations({ "001_a.sql": "CREATE TABLE a(x);" });
    const out = await run(migrationApply, {
      database: "app.db",
      directory: "migrations",
      dryRun: true,
    });
    expect(out.pending).toEqual(["001_a.sql"]);
    const list = await run(schemaList, { database: "app.db", types: ["table"] });
    expect(list.objects.map((o: { name: string }) => o.name)).not.toContain("a");
  });

  test("a directory that is not there is a sentence", async () => {
    const out = await run(migrationStatus, { database: "app.db", directory: "nope" });
    expect(out).toContain("found no directory");
  });
});

// ---------------------------------------------------------------------------

describe("parameters, checked against SQLite itself", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test.each([
    "SELECT 1",
    "SELECT ?",
    "SELECT ?3, ?",
    "SELECT $1",
    "SELECT :1",
    "SELECT @1",
    "SELECT $a::b",
    "SELECT $q(sel)",
    "SELECT $x, $x",
    "SELECT :a, @b, $c",
    "SELECT * FROM users WHERE name = :name AND age > :age",
  ])("the lexical count for %s is the one SQLite compiles", (sql) => {
    // The scan in lib/sql-text is only worth anything if it agrees with the
    // engine. This asserts that against a real compiled statement rather
    // than against a number copied out of a previous run.
    const db = new Database(join(workspace, "app.db"), { readonly: true });
    try {
      const statement = db.prepare(sql) as unknown as { paramsCount: number };
      expect(namedParameters(sql).length + positionalParameterCount(sql)).toBe(
        statement.paramsCount,
      );
    } finally {
      db.close();
    }
  });

  test("a $1 parameter is required rather than bound to NULL in silence", async () => {
    const refused = await run(sqlQuery, { database: "app.db", sql: "SELECT $1 AS v" });
    expect(refused).toContain("needs params");
    const bound = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT $1 AS v",
      params: { $1: 7 },
    });
    expect(bound.rows).toEqual([{ v: 7 }]);
  });

  test("the engine cross-check refuses a count the lexical scan got wrong", () => {
    // The backstop itself, driven with a real compiled statement: whatever
    // the scan concluded, a value list that does not match what SQLite
    // compiled is refused instead of being padded with NULLs.
    const db = new Database(join(workspace, "app.db"), { readonly: true });
    try {
      const statement = db.prepare("SELECT ? AS a, ? AS b");
      expect(parameterMismatch("SELECT ? AS a, ? AS b", statement, [1])).toMatchObject({
        ok: false,
      });
      expect(parameterMismatch("SELECT ? AS a, ? AS b", statement, [1, 2])).toBeUndefined();
      statement.finalize();
    } finally {
      db.close();
    }
  });

  test("a second statement hidden behind a table called begin is still counted", async () => {
    await run(sqlExec, { database: "app.db", sql: "CREATE TABLE begin(x)", create: false });
    const out = await run(sqlExec, {
      database: "app.db",
      sql: "INSERT INTO begin VALUES(1); DELETE FROM users",
    });
    expect(out).toContain("discards the rest silently");
    const rows = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT count(*) AS n FROM users",
    });
    expect(rows.rows).toEqual([{ n: 3 }]);
  });
});

// ---------------------------------------------------------------------------

describe("read-only means read-only, temp database included", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test.each([
    ["CREATE TEMP TABLE leak AS SELECT * FROM users"],
    ["CREATE TEMPORARY TABLE leak(a)"],
  ])("%s is refused by SQLite on a read connection", async (sql) => {
    // SQLITE_OPEN_READONLY leaves the TEMP database writable, so this used
    // to run — from a tool whose description says it cannot write — and
    // spill to the temp directory, outside the workspace. `query_only`
    // closes it, and SQLite is still the one refusing.
    const out = await run(sqlQuery, { database: "app.db", sql });
    expect(out).toContain("readonly");
  });

  test("no temp object survives a read tool that was asked to make one", async () => {
    await run(sqlQuery, { database: "app.db", sql: "CREATE TEMP TABLE leak AS SELECT 1" });
    const after = await run(sqlQuery, {
      database: "app.db",
      sql: "SELECT count(*) AS n FROM sqlite_temp_schema",
    });
    expect(after.rows).toEqual([{ n: 0 }]);
  });

  test("a control character in a path never reaches the sentence it is named in", async () => {
    const out = await run(sqlQuery, {
      database: `app${String.fromCharCode(0)}.db`,
      sql: "SELECT 1",
    });
    expect(typeof out).toBe("string");
    expect(out).not.toContain(String.fromCharCode(0));
  });

  test("DatabaseBackup still works, because VACUUM INTO is its whole job", async () => {
    const out = await run(databaseBackup, { database: "app.db", out: "copy.db" });
    expect(out.bytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("names resolve the way SQLite resolves them", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test("SchemaDescribe finds a table named in another case and reports the stored spelling", async () => {
    const out = await run(schemaDescribe, { database: "app.db", table: "USERS" });
    expect(out.name).toBe("users");
    expect(out.columns.map((c: { name: string }) => c.name)).toEqual(["id", "name", "age"]);
  });

  test("ImportCsv loads into a table named in another case", async () => {
    writeFileSync(join(workspace, "p.csv"), "name,age\nzed,50\n");
    const out = await run(importCsv, { database: "app.db", file: "p.csv", table: "Users" });
    expect(out).toMatchObject({ table: "users", inserted: 1, createdTable: false });
  });

  test("TableStats counts a table named in another case", async () => {
    const out = await run(tableStats, { database: "app.db", tables: ["USERS"] });
    // Sizes come from the dbstat virtual table, which is a compile-time
    // option: present in the SQLite that ships with Bun on macOS, absent in
    // the one CI runs on. Asserting them pinned this test to one build. What
    // the test is actually about is that "USERS" resolves to `users`.
    expect(out.tables).toMatchObject([{ name: "users", rows: 3 }]);
    const stats = out.tables[0] as { bytes?: number; pages?: number };
    if (stats.bytes === undefined) {
      expect(out.note).toContain("dbstat");
    } else {
      expect(stats.bytes).toBeGreaterThan(0);
      expect(stats.pages).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------

describe("export edges", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test("a query that matches nothing still exports its header", async () => {
    const out = await run(exportCsv, {
      database: "app.db",
      sql: "SELECT name, age FROM users WHERE age > 200",
      out: "none.csv",
    });
    expect(out.rows).toBe(0);
    expect(readFileSync(join(workspace, "none.csv"), "utf8")).toBe("name,age\n");
  });

  test("header: false leaves an empty export empty", async () => {
    await run(exportCsv, {
      database: "app.db",
      sql: "SELECT name FROM users WHERE 0",
      out: "bare.csv",
      header: false,
    });
    expect(readFileSync(join(workspace, "bare.csv"), "utf8")).toBe("");
  });

  test("a delimiter CSV already uses for something else is refused", async () => {
    const out = await run(exportCsv, {
      database: "app.db",
      sql: "SELECT 1 AS n",
      out: "q.csv",
      delimiter: '"',
    });
    expect(out).toContain("refused the delimiter");
    expect(await Bun.file(join(workspace, "q.csv")).exists()).toBe(false);
  });

  test("ImportCsv ignores a trailing blank line instead of rejecting a phantom row", async () => {
    writeFileSync(join(workspace, "trailing.csv"), "name,age\nzed,50\n\n");
    const out = await run(importCsv, { database: "app.db", file: "trailing.csv", table: "users" });
    expect(out).toMatchObject({ inserted: 1, rejected: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("bounded work", () => {
  beforeEach(() => {
    seedDatabase();
  });

  test("a migration directory bigger than the cap is refused before anything is read into memory", async () => {
    mkdirSync(join(workspace, "many"), { recursive: true });
    for (let i = 0; i < 1_001; i++) {
      writeFileSync(join(workspace, "many", `${String(i).padStart(5, "0")}.sql`), "SELECT 1;");
    }
    const out = await run(migrationStatus, { database: "app.db", directory: "many" });
    expect(out).toContain("file limit");
  });
});

// ---------------------------------------------------------------------------

/**
 * Regression — a RELATIVE symlink target resolves against the directory that
 * actually CONTAINS the link, not against the link's lexical parent. The two
 * part company exactly when that parent is itself reached through a symlink,
 * and the `readlink` hop inside `resolveLocation` is where it first bites:
 * the leaf stays in the RESOLVED part of the path, so reading its target from
 * the wrong directory names a location the caller's path does not lead to.
 *
 * Nothing gets OUT of the workspace this way — the misreading swaps a real
 * destination outside the root for an invented one inside it, so containment
 * still passes and the I/O still happens in-root. What breaks is which
 * in-root path: a backup asked for at "pdir/l" lands at
 * `<workspace>/escape.db` while the result still reports "pdir/l". The
 * mirror of that is the honest case being over-refused. Both come from the
 * same wrong base, which is why the fix is to realpath the parent first.
 */
describe("containment: a relative dangling link under an outward directory link", () => {
  test("a backup destination reached through an outward directory link is refused", async () => {
    seedDatabase();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-sql-relbase-")));
    outsideDirs.push(outside);
    mkdirSync(join(outside, "realdir"));
    // `pdir` leaves the workspace, so `l` really lives in <outside>/realdir
    // and its "../escape.db" truly names <outside>/escape.db. Measured from
    // the LEXICAL parent <workspace>/pdir the very same target reads as
    // <workspace>/escape.db — an in-root path, and so waved through.
    symlinkSync(join(outside, "realdir"), join(workspace, "pdir"));
    symlinkSync("../escape.db", join(outside, "realdir", "l"));

    // A plain workspace-relative path: no `..`, not absolute. The cheap
    // lexical pre-check has nothing to object to, so the refusal can only
    // come from the symlink walk.
    const out = await run(databaseBackup, { database: "app.db", out: "pdir/l" });
    expect(out).toContain("outside the workspace root");
    expect(await Bun.file(join(outside, "escape.db")).exists()).toBe(false);
    // Nor quietly redirected to the in-root path the lexical reading names.
    expect(await Bun.file(join(workspace, "escape.db")).exists()).toBe(false);
  });
});
