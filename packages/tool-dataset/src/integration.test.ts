import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately.
 */
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { DATASET_TOOLS } from "./index";

const originalCwd = process.cwd();
const originalDatasetsDir = process.env["CREWHAUS_DATASETS_DIR"];
let catalog: ToolCatalog;
let tmp: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-dataset-int-"));
  process.chdir(tmp);
  Reflect.deleteProperty(process.env, "CREWHAUS_DATASETS_DIR");
  catalog = new ToolCatalog();
  for (const tool of DATASET_TOOLS) catalog.register(tool);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  // An unset var must be REMOVED, not set to the string "undefined".
  if (originalDatasetsDir === undefined)
    Reflect.deleteProperty(process.env, "CREWHAUS_DATASETS_DIR");
  else process.env["CREWHAUS_DATASETS_DIR"] = originalDatasetsDir;
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(DATASET_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of DATASET_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("DatasetLint"),
      { samples: [{ id: "a", input: "x" }] },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("clean");
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("DatasetPut"),
      { name: 42, samples: [] },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("DatasetPut");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("DatasetPut"), { samples: [] }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("DatasetInspect"),
      {},
      { toolUseId: "t4", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("DatasetInspect"),
      {},
      { toolUseId: "t5", allowedPatterns: ["DatasetInspect"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    mkdirSync(path.join(tmp, ".crewhaus", "sessions"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".crewhaus", "sessions", "sess-1.jsonl"),
      `${JSON.stringify({ kind: "user_message", payload: { content: "q" } })}\n${JSON.stringify({ kind: "error", payload: { name: "E", message: "boom" } })}\n`,
    );
    const calls: Record<string, unknown> = {
      DatasetInspect: {},
      DatasetLint: { samples: [{ id: "a", input: "x" }] },
      DatasetMine: {},
      DatasetPut: { name: "qa", samples: [{ id: "a", input: "x" }] },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(DATASET_TOOLS.map((t) => t.name).sort());
    for (const tool of DATASET_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("a put and an inspect agree about the version through the runtime path", async () => {
    const put = await executeTool(
      lookup("DatasetPut"),
      {
        name: "qa",
        samples: [
          { id: "a", input: "x" },
          { id: "b", input: "y" },
        ],
      },
      { toolUseId: "t6" },
    );
    expect(put.isError).toBe(false);
    const inspected = await executeTool(
      lookup("DatasetInspect"),
      { dataset: "qa" },
      { toolUseId: "t7" },
    );
    const parsed = JSON.parse(String(inspected.content));
    expect(parsed.version).toBe("v1");
    expect(parsed.hashes.status).toBe("verified");
  });
});
