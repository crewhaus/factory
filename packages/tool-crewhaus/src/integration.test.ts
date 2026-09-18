/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the
 * runtime cannot actually use, which is why this file exists separately.
 * The safety-flag assertions live here too: the flags are the contract the
 * permission engine and the egress classifier read, so they are tested, not
 * just written.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { openAuditLog } from "@crewhaus/audit-log";
import { auditToolScopes } from "@crewhaus/tool-builder";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { CREWHAUS_TOOLS } from "./index";

const SPEC = [
  "name: demo",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: Be useful.",
  "tools: [read, write]",
].join("\n");

const EVAL_DOC = {
  runId: "run_000000000000000b",
  samples: [{ sampleId: "a", grades: { overall: { passed: true, score: 1, rationale: "" } } }],
  aggregates: { passRate: 1 },
  config: { datasetName: "golden" },
};

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let tmp: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

function write(rel: string, content: string): void {
  const abs = path.join(tmp, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(async () => {
  catalog = new ToolCatalog();
  for (const tool of CREWHAUS_TOOLS) catalog.register(tool);

  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-crewhaus-int-"));
  process.chdir(tmp);
  write("crewhaus.yaml", SPEC);
  write("dist/agent.ts", "// compiled");
  write(
    ".crewhaus/sessions/sess_0000000000000001.jsonl",
    `${JSON.stringify({ ts: 1, version: 1, kind: "user_message", payload: { content: "hi" } })}\n`,
  );
  const log = await openAuditLog({ rootDir: path.join(tmp, ".crewhaus", "audit") });
  await log.append({ kind: "tool_call", payload: { tool: "Read" } });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

/** One schema-valid call per tool, exercised end to end below. */
const CALLS: Record<string, unknown> = {
  AuditVerify: {},
  BundleFreshness: { dirs: ["."] },
  CostSummarize: {},
  EvalBaselineCompare: { baseline: EVAL_DOC, candidate: EVAL_DOC },
  HarnessInventory: {},
  PermissionAudit: { spec: SPEC },
  PreflightRun: { env: {} },
  SessionSummarize: {},
  SpecCompileCheck: { spec: SPEC, today: "2026-01-01" },
  SpecDiff: { before: { spec: SPEC }, after: { spec: SPEC } },
  SpecSummarize: { spec: SPEC },
  SpecValidate: { spec: SPEC },
  ToolInventory: { spec: SPEC },
  TraceQuery: {},
};

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(CREWHAUS_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of CREWHAUS_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });

  test("the export is frozen, so a caller cannot mutate the package's tool set", () => {
    expect(Object.isFrozen(CREWHAUS_TOOLS)).toBe(true);
  });
});

describe("safety flags", () => {
  test("every tool here is read-only and none is destructive", () => {
    for (const tool of CREWHAUS_TOOLS) {
      expect({ name: tool.name, readOnly: tool.readOnly, destructive: tool.destructive }).toEqual({
        name: tool.name,
        readOnly: true,
        destructive: false,
      });
    }
  });

  test("the declared io-capabilities and scopes agree — the compiler's own audit passes", () => {
    expect(auditToolScopes(CREWHAUS_TOOLS)).toEqual([]);
  });

  test("the tool that binds a socket is the one that is NOT concurrency-safe", () => {
    // The runtime runs siblings in parallel when
    // `concurrencySafe && readOnly && !destructive` holds. PreflightRun's
    // port probe is an exclusive bind, so two in flight over one spec make
    // the loser report a free port as taken — a false blocking item.
    expect(CREWHAUS_TOOLS.filter((t) => !t.concurrencySafe).map((t) => t.name)).toEqual([
      "PreflightRun",
    ]);
  });

  test("only the tool that touches a socket declares a capability", () => {
    const withCapability = CREWHAUS_TOOLS.filter((t) => t.ioCapability !== undefined);
    expect(withCapability.map((t) => [t.name, t.ioCapability, t.scope])).toEqual([
      ["PreflightRun", "network", "external"],
    ]);
  });

  test("nothing here requires a justification, because nothing has an outward effect", () => {
    expect(CREWHAUS_TOOLS.filter((t) => t.requireJustification).map((t) => t.name)).toEqual([]);
  });

  test("every description names the tool's use in its second sentence", () => {
    for (const tool of CREWHAUS_TOOLS) {
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
    const result = await executeTool(lookup("SpecValidate"), { spec: SPEC }, { toolUseId: "t1" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"valid":true');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("SpecValidate"), { spec: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SpecValidate");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("PreflightRun"), {}, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("SpecValidate"),
      { spec: SPEC },
      { toolUseId: "t4", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("SpecValidate"),
      { spec: SPEC },
      { toolUseId: "t5", allowedPatterns: ["SpecValidate"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(CALLS).sort()).toEqual(CREWHAUS_TOOLS.map((t) => t.name).sort());
    for (const tool of CREWHAUS_TOOLS) {
      const result = await executeTool(tool, CALLS[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    for (const name of ["SpecSummarize", "HarnessInventory", "SessionSummarize"]) {
      const a = await executeTool(lookup(name), CALLS[name], { toolUseId: `d1-${name}` });
      const b = await executeTool(lookup(name), CALLS[name], { toolUseId: `d2-${name}` });
      expect({ name, same: a.content === b.content }).toEqual({ name, same: true });
    }
  });

  test("a caller mistake comes back as a readable result, not an error result", async () => {
    const result = await executeTool(
      lookup("SpecValidate"),
      { path: "../outside.yaml" },
      { toolUseId: "t6" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("escapes the workspace root");
  });
});
