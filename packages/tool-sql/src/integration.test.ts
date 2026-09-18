/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against
 * the declared schema and checks the permission patterns before execute is
 * ever called.
 *
 * A tool that works when called directly but fails here is a tool the
 * runtime cannot actually use, which is why this file exists separately —
 * and it is where the whole-package claims are checked end to end: a
 * migration, an import, a query and an export in sequence, against one real
 * database in a throwaway workspace.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { SQL_TOOLS } from "./index";

let catalog: ToolCatalog;
let workspace = "";
let originalCwd = "";

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

/** Dispatch through the executor and hand back the parsed content. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function call(name: string, input: unknown, id = "t"): Promise<any> {
  const result = await executeTool(lookup(name), input, { toolUseId: id });
  expect({ tool: name, isError: result.isError }).toEqual({ tool: name, isError: false });
  const content = result.content;
  if (typeof content !== "string") throw new Error("expected string content");
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** Build a small database without going through the tools. */
function seed(file: string, script: string): void {
  const db = new Database(join(workspace, file), { create: true });
  db.exec(script);
  db.close();
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of SQL_TOOLS) catalog.register(tool);
  originalCwd = process.cwd();
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-sql-int-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(SQL_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of SQL_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  beforeEach(() => {
    seed("app.db", "CREATE TABLE t(a INTEGER, b TEXT); INSERT INTO t VALUES(1, 'x'), (2, 'y');");
  });

  test("a valid call returns a non-error result", async () => {
    const out = await call("SqlQuery", { database: "app.db", sql: "SELECT * FROM t ORDER BY a" });
    expect(out.rowCount).toBe(2);
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("SqlQuery"),
      { database: 42, sql: "SELECT 1" },
      { toolUseId: "bad-type" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SqlQuery");
  });

  test("a missing required field is rejected before any file is opened", async () => {
    const result = await executeTool(lookup("SqlExec"), { database: "app.db" }, { toolUseId: "m" });
    expect(result.isError).toBe(true);
  });

  test("an out-of-range timeout is rejected by the schema", async () => {
    const result = await executeTool(
      lookup("SqlQuery"),
      { database: "app.db", sql: "SELECT 1", timeout: 999_999_999 },
      { toolUseId: "slow" },
    );
    expect(result.isError).toBe(true);
  });

  test("a param of an unsupported type is rejected by the schema", async () => {
    const result = await executeTool(
      lookup("SqlQuery"),
      { database: "app.db", sql: "SELECT ?", params: [{ nested: true }] },
      { toolUseId: "p" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("SqlQuery"),
      { database: "app.db", sql: "SELECT 1" },
      { toolUseId: "d", allowedPatterns: ["SchemaList"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("SqlQuery"),
      { database: "app.db", sql: "SELECT 1 AS n" },
      { toolUseId: "a", allowedPatterns: ["SqlQuery"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("a refusal is a normal result, not an executor error", async () => {
    const result = await executeTool(
      lookup("SqlQuery"),
      { database: "../escape.db", sql: "SELECT 1" },
      { toolUseId: "r" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("outside the workspace root");
  });
});

describe("a whole session against one database", () => {
  test("migrate, import, query, explain, export, back up and verify", async () => {
    mkdirSync(join(workspace, "migrations"));
    writeFileSync(
      join(workspace, "migrations", "001_schema.sql"),
      "CREATE TABLE readings(id INTEGER PRIMARY KEY, sensor TEXT NOT NULL, value REAL);\n" +
        "CREATE INDEX readings_sensor ON readings(sensor);\n",
    );

    const applied = await call("MigrationApply", {
      database: "sensors.db",
      directory: "migrations",
      create: true,
    });
    expect(applied.applied).toEqual(["001_schema.sql"]);

    writeFileSync(
      join(workspace, "readings.csv"),
      "sensor,value\nnorth,1.5\nsouth,2.5\nbroken,not-a-number\n",
    );
    const imported = await call("ImportCsv", {
      database: "sensors.db",
      file: "readings.csv",
      table: "readings",
    });
    expect(imported.inserted).toBe(2);
    expect(imported.rejected).toBe(1);

    const described = await call("SchemaDescribe", { database: "sensors.db", table: "readings" });
    expect(described.columns.map((c: { name: string }) => c.name)).toEqual([
      "id",
      "sensor",
      "value",
    ]);

    const plan = await call("SqlExplain", {
      database: "sensors.db",
      sql: "SELECT value FROM readings WHERE sensor = $name",
      params: { name: "north" },
    });
    expect(plan.indexes).toContain("readings_sensor");

    const rows = await call("SqlQuery", {
      database: "sensors.db",
      sql: "SELECT sensor, value FROM readings ORDER BY sensor",
    });
    expect(rows.rows).toEqual([
      { sensor: "north", value: 1.5 },
      { sensor: "south", value: 2.5 },
    ]);

    const stats = await call("TableStats", { database: "sensors.db" });
    expect(stats.tables.find((t: { name: string }) => t.name === "readings").rows).toBe(2);

    await call("ExportCsv", {
      database: "sensors.db",
      sql: "SELECT sensor, value FROM readings ORDER BY sensor",
      out: "out.csv",
    });
    expect(readFileSync(join(workspace, "out.csv"), "utf8")).toBe(
      "sensor,value\nnorth,1.5\nsouth,2.5\n",
    );

    await call("DatabaseBackup", { database: "sensors.db", out: "sensors-copy.db" });
    const diff = await call("DbSchemaDiff", { left: "sensors.db", right: "sensors-copy.db" });
    expect(diff.identical).toBe(true);

    const health = await call("IntegrityCheck", { database: "sensors-copy.db" });
    expect(health.ok).toBe(true);

    const status = await call("MigrationStatus", {
      database: "sensors-copy.db",
      directory: "migrations",
    });
    expect(status.pending).toEqual([]);
  });

  test("the read tools leave the database byte-for-byte unchanged", async () => {
    seed("app.db", "CREATE TABLE t(a INTEGER); INSERT INTO t VALUES(1),(2);");
    const before = readFileSync(join(workspace, "app.db"));

    await call("SqlQuery", { database: "app.db", sql: "SELECT * FROM t" });
    await call("SchemaList", { database: "app.db" });
    await call("SchemaDescribe", { database: "app.db", table: "t" });
    await call("TableStats", { database: "app.db" });
    await call("IntegrityCheck", { database: "app.db" });
    await call("SqlExplain", { database: "app.db", sql: "SELECT * FROM t" });

    expect(readFileSync(join(workspace, "app.db")).equals(before)).toBe(true);
  });
});
