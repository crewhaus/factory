import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * The tools driven the way the runtime drives them, and the workflow they
 * exist for: understand an unfamiliar export, then reconcile it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { TABLE_TOOLS } from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let workspace: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

const write = (name: string, body: string): void => writeFileSync(join(workspace, name), body);

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of TABLE_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-table-int-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(TABLE_TOOLS.length);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    write("a.csv", "id\n1\n");
    const result = await executeTool(
      lookup("TableProfile"),
      { file: "a.csv" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"rows":1');
  });

  test("a containment escape is an error result", async () => {
    const result = await executeTool(
      lookup("TableProfile"),
      { file: "../../etc/passwd" },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the workspace");
  });

  test("every tool can be dispatched with a minimal valid input", async () => {
    write("a.csv", "id,v\n1,x\n2,y\n");
    write("b.csv", "id,v\n1,x\n");
    write("f.txt", "AB12\n");
    const inputs: Record<string, unknown> = {
      TableProfile: { file: "a.csv" },
      TableDiff: { before: "a.csv", after: "b.csv", key: ["id"] },
      RecordLinkage: {
        left: "a.csv",
        right: "b.csv",
        rules: [{ field: "v", compare: "exact", weight: 1 }],
      },
      ContactNormalize: { contacts: [{ email: "a@b.test" }] },
      TableReshape: { file: "a.csv", direction: "long", idColumns: ["id"] },
      TableShard: { file: "a.csv", maxRows: 1, planOnly: true },
      FixedWidthParse: { file: "f.txt", fields: [{ name: "a", start: 1, length: 2 }] },
    };
    for (const tool of TABLE_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });
});

describe("the intake these exist for", () => {
  test("profile an unfamiliar export, then reconcile it against yesterday's", async () => {
    // Yesterday and today, with a real change, an arrival, a departure — and
    // a duplicated id that makes the whole reconciliation untrustworthy.
    write(
      "yesterday.csv",
      "customer_id,email,amount,status\n1,A.B@Gmail.com,100,open\n2,bob@other.com,200,open\n3,carol@other.com,300,closed\n",
    );
    write(
      "today.csv",
      "customer_id,email,amount,status\n1,A.B@Gmail.com,150,open\n2,bob@other.com,200,closed\n4,dave@other.com,400,open\n4,dave@other.com,400,open\n",
    );

    // 1. What is in today's file, before writing any query against it.
    const profiled = await executeTool(
      lookup("TableProfile"),
      { file: "today.csv" },
      { toolUseId: "i1" },
    );
    const profile = JSON.parse(profiled.content);
    expect(profile.rows).toBe(4);
    expect(profile.duplicateRows).toBe(1);
    // customer_id repeats, so it is NOT offered as a key — which is exactly
    // what the reconciliation below is about to complain about.
    expect(profile.candidateKeys).not.toContain("customer_id");

    // 2. Reconcile, and be told the key is not trustworthy rather than
    //    getting a diff that looks authoritative.
    const diffed = await executeTool(
      lookup("TableDiff"),
      { before: "yesterday.csv", after: "today.csv", key: ["customer_id"] },
      { toolUseId: "i2" },
    );
    const diff = JSON.parse(diffed.content);
    expect(diff.counts).toMatchObject({ added: 1, removed: 1, changed: 2 });
    expect(diff.duplicateKeys[0]).toMatchObject({ side: "after", count: 2 });

    // 3. And the changed cells are named, not just counted.
    const amounts = diff.changed.flatMap((c: { changes: Array<{ column: string }> }) =>
      c.changes.filter((x) => x.column === "amount"),
    );
    expect(amounts[0]).toMatchObject({ from: "100", to: "150" });
  });
});
