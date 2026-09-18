/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { PROC_TOOLS, __resetRegistryForTest, processStart } from "./index";

let catalog: ToolCatalog;
let originalCwd: string;
let tmp: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-proc-int-")));
  process.chdir(tmp);
  __resetRegistryForTest();
  catalog = new ToolCatalog();
  for (const tool of PROC_TOOLS) catalog.register(tool);
});

afterEach(() => {
  __resetRegistryForTest();
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(PROC_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of PROC_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("RunCommand"),
      { argv: ["echo", "dispatched"] },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("dispatched");
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("RunCommand"),
      { argv: "echo hello" },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("RunCommand");
  });

  test("a waiting tool without its deadline is rejected by the schema", async () => {
    const result = await executeTool(lookup("WaitForFile"), { path: "x" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("CommandExists"),
      { name: "sh" },
      { toolUseId: "t4", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("CommandExists"),
      { name: "sh" },
      { toolUseId: "t5", allowedPatterns: ["CommandExists"] },
    );
    expect(allowed.isError).toBe(false);
  });

  /**
   * A containment refusal comes back as ordinary content rather than an
   * exception: the model reads the reason and corrects the path, instead of
   * seeing a stack trace it will try to talk its way past.
   */
  test("a path escaping the workspace is refused as readable content", async () => {
    const result = await executeTool(
      lookup("RunCommand"),
      { argv: ["pwd"], cwd: "/etc" },
      { toolUseId: "t6" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("refused path");
  });

  test("an aborted turn stops a running command instead of holding the turn open", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    const at = Date.now();
    const result = await executeTool(
      lookup("RunCommand"),
      { argv: ["sleep", "30"], timeoutMs: 30_000 },
      { toolUseId: "t7", signal: controller.signal },
    );
    clearTimeout(timer);
    expect(Date.now() - at).toBeLessThan(10_000);
    expect(result.content).toContain('"ok":false');
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const started = await processStart.execute({ argv: ["sleep", "30"] });
    expect(String(started)).toContain("proc_1");

    const calls: Record<string, unknown> = {
      CommandExists: { name: "sh" },
      EnvInspect: { names: ["PATH"] },
      ProcessList: {},
      ProcessOutput: { id: "proc_1" },
      ProcessStart: { argv: ["true"] },
      ProcessStatus: { id: "proc_1" },
      ProcessStop: { id: "proc_1", killAfterMs: 500 },
      Retry: { argv: ["true"], maxAttempts: 2, backoff: { kind: "fixed", delayMs: 0 } },
      RunCommand: { argv: ["true"] },
      RunPipeline: { steps: [{ argv: ["true"] }] },
      WaitForFile: { path: "nothing-here", timeoutMs: 50 },
      WaitForOutput: { id: "proc_1", pattern: "never", timeoutMs: 50 },
      WaitForPort: { port: 1, timeoutMs: 50 },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(PROC_TOOLS.map((t) => t.name).sort());
    for (const tool of PROC_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("a read-only tool is deterministic — the same call twice gives the same bytes", async () => {
    const args = { names: ["PATH", "HOME"] };
    const a = await executeTool(lookup("EnvInspect"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("EnvInspect"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });

  test("nothing is left running once a session's processes are stopped", async () => {
    await executeTool(lookup("ProcessStart"), { argv: ["sleep", "30"] }, { toolUseId: "p1" });
    await executeTool(
      lookup("ProcessStop"),
      { id: "proc_1", killAfterMs: 1_000 },
      { toolUseId: "p2" },
    );
    const listed = await executeTool(lookup("ProcessList"), {}, { toolUseId: "p3" });
    expect(listed.content).toContain('"running":0');
  });
});
