/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately. It runs
 * against a real temporary project, for the same reason `index.test.ts` does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { CODE_TOOLS } from "./index";

let catalog: ToolCatalog;
let workspace: string;
let originalCwd: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

function write(relative: string, contents: string): void {
  const slash = relative.lastIndexOf("/");
  if (slash !== -1) mkdirSync(join(workspace, relative.slice(0, slash)), { recursive: true });
  writeFileSync(join(workspace, relative), contents);
}

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-code-int-")));
  process.chdir(workspace);
  write("package.json", JSON.stringify({ name: "demo", scripts: { test: "bun test" } }));
  write("noop.ts", "");
  write("src/util.ts", "// TODO: tidy\nexport function helper(): number {\n  return 1;\n}\n");
  write("src/index.ts", "import { helper } from './util';\nexport const value = helper();\n");
  write("coverage/lcov.info", "SF:src/util.ts\nLF:2\nLH:1\nend_of_record\n");
  catalog = new ToolCatalog();
  for (const tool of CODE_TOOLS) catalog.register(tool);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(CODE_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of CODE_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("SymbolOutline"),
      { file: "src/util.ts" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("helper");
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("AstQuery"), { cwd: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("AstQuery");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("FindReferences"), { cwd: "src" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("an out-of-range value is rejected by the schema, not by the tool", async () => {
    const result = await executeTool(
      lookup("RunTests"),
      { timeout: 99_999_999 },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("TodoScan"),
      { cwd: "src" },
      { toolUseId: "t5", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("TodoScan"),
      { cwd: "src" },
      { toolUseId: "t6", allowedPatterns: ["TodoScan"] },
    );
    expect(allowed.isError).toBe(false);
    expect(allowed.content).toContain("TODO");
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const calls: Record<string, unknown> = {
      AstQuery: { cwd: "src" },
      CoverageSummary: {},
      DeadFileScan: { cwd: "src" },
      DependencyList: {},
      DependencyOutdated: {},
      Diagnostics: {},
      FindReferences: { name: "helper", cwd: "src" },
      Format: { command: ["bun", "noop.ts"] },
      FormatCheck: {},
      ImportGraph: { cwd: "src" },
      Lint: {},
      PackageScripts: {},
      RunBuild: { command: ["bun", "noop.ts"] },
      RunTests: { command: ["bun", "noop.ts"] },
      StackTraceParse: { trace: "    at run (/repo/src/a.ts:1:1)" },
      SymbolOutline: { file: "src/util.ts" },
      TestFailureSummary: { output: " 1 pass\n 0 fail\n" },
      TodoScan: { cwd: "src" },
      Typecheck: {},
      WorkspacePackages: {},
    };
    // Typecheck, Lint and FormatCheck take no `command` — see the safety
    // note on READ_SPAWN — so they are called as a caller would call them,
    // and answer with a refusal sentence rather than a JSON body. That is
    // still a non-error result, which is what this test is about.
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(CODE_TOOLS.map((t) => t.name).sort());
    for (const tool of CODE_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  }, 60_000);

  test("a refusal comes back as a readable result, not as an error", async () => {
    const result = await executeTool(lookup("AstQuery"), { cwd: "../" }, { toolUseId: "r1" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("outside the workspace root");
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    const args = { cwd: "src" };
    const a = await executeTool(lookup("ImportGraph"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("ImportGraph"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });
});
