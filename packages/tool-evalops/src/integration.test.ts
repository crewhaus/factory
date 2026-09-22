/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately. The safety
 * flags live here too: they are the contract the permission engine and the
 * egress classifier read, so they are tested rather than merely written.
 *
 * The determinism check is the one to keep: these five results feed gates and
 * dashboards, so two identical calls must produce identical bytes. Nothing here
 * may reach for a clock, and no listing may depend on the order the filesystem
 * happened to hand back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { auditToolScopes } from "@crewhaus/tool-builder";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  CONTAINS_YAML,
  EVALS_DIR,
  SESSIONS_DIR,
  goldens,
  makeWorkspace,
  row,
  sample,
  writeDataset,
  writeIndex,
  writeRun,
  writeSession,
} from "./fixtures";
import { EVALOPS_TOOLS } from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let tmp: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

const GOLDEN = goldens([
  { id: "g1", output: "ok", expected: true },
  { id: "g2", output: "no", expected: false },
]);

/** One schema-valid call per tool, exercised end to end below. */
const CALLS: Record<string, unknown> = {
  EvalAggregate: { run: path.join(EVALS_DIR, "r1") },
  EvalBaselinePin: { action: "show", spec: "shop", dataset: "smoke" },
  EvalCoverage: { dataset: "eval/dataset.jsonl" },
  EvalHistory: {},
  GraderMetaTest: { gradersYaml: CONTAINS_YAML, goldenJsonl: GOLDEN },
};

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of EVALOPS_TOOLS) catalog.register(tool);

  tmp = makeWorkspace();
  process.chdir(tmp);
  mkdirSync(path.join(tmp, SESSIONS_DIR), { recursive: true });
  writeRun(tmp, "r1", {
    samples: [sample({ sampleId: "a", passed: true }), sample({ sampleId: "b", passed: false })],
    events: { a: ["Read"] },
  });
  writeIndex(tmp, [
    row({ runId: "r1", ts: "2026-01-01T00:00:00Z" }),
    row({ runId: "r2", ts: "2026-01-02T00:00:00Z", gradersHash: "graders-2" }),
  ]);
  // Two sessions with explicit mtimes: the recency ordering under test is the
  // tool's, not the filesystem's opinion of how fast this test wrote files.
  writeSession(tmp, "s1", { tools: [["Read", "Bash"]], mtimeSeconds: 1_700_000_000 });
  writeSession(tmp, "s2", { tools: [["Read"]], mtimeSeconds: 1_700_000_100 });
  writeDataset(tmp, "eval/dataset.jsonl", [{ id: "d1", input: "x", expected_tools: ["Read"] }]);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(EVALOPS_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of EVALOPS_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });

  test("the export is frozen, so a caller cannot mutate the package's tool set", () => {
    expect(Object.isFrozen(EVALOPS_TOOLS)).toBe(true);
  });
});

describe("safety flags", () => {
  test("the one tool that writes is the one that declares itself destructive", () => {
    expect(
      EVALOPS_TOOLS.map((t) => ({
        name: t.name,
        readOnly: t.readOnly,
        destructive: t.destructive,
      })),
    ).toEqual([
      { name: "EvalAggregate", readOnly: true, destructive: false },
      { name: "EvalBaselinePin", readOnly: false, destructive: true },
      { name: "EvalCoverage", readOnly: true, destructive: false },
      { name: "EvalHistory", readOnly: true, destructive: false },
      { name: "GraderMetaTest", readOnly: true, destructive: false },
    ]);
  });

  test("the writer is the one that is NOT concurrency-safe", () => {
    // `baselines.json` is rewritten whole, so two pins in flight lose one.
    expect(EVALOPS_TOOLS.filter((t) => !t.concurrencySafe).map((t) => t.name)).toEqual([
      "EvalBaselinePin",
    ]);
  });

  test("the declared io-capabilities and scopes agree — the compiler's own audit passes", () => {
    expect(auditToolScopes(EVALOPS_TOOLS)).toEqual([]);
  });

  test("nothing here crosses a network or process boundary", () => {
    expect(EVALOPS_TOOLS.filter((t) => t.ioCapability !== undefined)).toEqual([]);
    expect(EVALOPS_TOOLS.every((t) => t.scope === "internal")).toBe(true);
  });

  test("every description names the tool's use in its second sentence", () => {
    for (const tool of EVALOPS_TOOLS) {
      const sentences = tool.description.split(". ");
      expect({ name: tool.name, second: sentences[1]?.startsWith("Use ") }).toEqual({
        name: tool.name,
        second: true,
      });
    }
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(lookup("EvalHistory"), {}, { toolUseId: "t1" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"ok":true');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("EvalHistory"), { spec: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("EvalHistory");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("EvalBaselinePin"), {}, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("an out-of-range agreement floor is rejected by the schema, not by the fold", async () => {
    const result = await executeTool(
      lookup("GraderMetaTest"),
      { gradersYaml: CONTAINS_YAML, goldenJsonl: GOLDEN, minAgreement: 1.5 },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("EvalHistory"),
      {},
      {
        toolUseId: "t5",
        allowedPatterns: ["Read"],
      },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("EvalHistory"),
      {},
      {
        toolUseId: "t6",
        allowedPatterns: ["EvalHistory"],
      },
    );
    expect(allowed.isError).toBe(false);
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(CALLS).sort()).toEqual(EVALOPS_TOOLS.map((t) => t.name).sort());
    for (const tool of EVALOPS_TOOLS) {
      const result = await executeTool(tool, CALLS[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  }, 20_000);

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    for (const tool of EVALOPS_TOOLS) {
      const a = await executeTool(tool, CALLS[tool.name], { toolUseId: `d1-${tool.name}` });
      const b = await executeTool(tool, CALLS[tool.name], { toolUseId: `d2-${tool.name}` });
      // No clock, no readdir order, no locale collation: two identical calls
      // over identical files are the same bytes, or a gate reading this output
      // flaps for reasons nobody caused.
      expect({ name: tool.name, same: a.content === b.content }).toEqual({
        name: tool.name,
        same: true,
      });
    }
  }, 20_000);

  test("a caller mistake comes back as a readable result, not an error result", async () => {
    const result = await executeTool(
      lookup("EvalAggregate"),
      { run: "../outside/results.json" },
      { toolUseId: "t7" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("escapes the workspace root");
  });
});
