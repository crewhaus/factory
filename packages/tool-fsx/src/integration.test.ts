/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against
 * the declared schema and checks the permission patterns before `execute`
 * ever runs.
 *
 * A tool that works when called directly but fails here is a tool the
 * runtime cannot actually use, which is why this file exists separately.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { buildTar } from "./archive-fixtures";
import { FSX_TOOLS } from "./index";

const originalCwd = process.cwd();
let tmp: string;
let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-fsx-int-"));
  process.chdir(tmp);
  catalog = new ToolCatalog();
  for (const tool of FSX_TOOLS) catalog.register(tool);

  mkdirSync(path.join(tmp, "src"), { recursive: true });
  writeFileSync(path.join(tmp, "src/a.txt"), "alpha\nbeta\ngamma\n");
  writeFileSync(path.join(tmp, "src/b.txt"), "second file\n");
  writeFileSync(path.join(tmp, "doc.md"), "---\ntitle: Doc\n---\nbody\n");
  writeFileSync(
    path.join(tmp, "nb.ipynb"),
    `${JSON.stringify({ cells: [{ cell_type: "code", source: ["x = 1\n"], metadata: {} }], nbformat: 4 }, null, 1)}\n`,
  );
  writeFileSync(path.join(tmp, "bundle.tar"), buildTar([{ name: "pkg/a.txt", data: "packed" }]));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(FSX_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of FSX_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(lookup("Stat"), { path: "src/a.txt" }, { toolUseId: "t1" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"size":17');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("Stat"), { path: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Stat");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("CopyPath"), { source: "src" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("a refinement failure is rejected before anything is written", async () => {
    const result = await executeTool(
      lookup("SplitFile"),
      { path: "src/a.txt", maxBytes: 4, maxLines: 4 },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("Stat"),
      { path: "src/a.txt" },
      { toolUseId: "t5", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");

    const allowed = await executeTool(
      lookup("Stat"),
      { path: "src/a.txt" },
      { toolUseId: "t6", allowedPatterns: ["Stat"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("a path escaping the workspace surfaces as a tool error, not a crash", async () => {
    const result = await executeTool(
      lookup("ReadLines"),
      { path: "../../etc/passwd" },
      { toolUseId: "t7" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the workspace root");
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const calls: Record<string, unknown> = {
      ArchiveCreate: { source: "src", output: "out.tar" },
      ArchiveExtract: { archive: "bundle.tar", destination: "unpacked", dryRun: true },
      ArchiveList: { path: "bundle.tar" },
      ConcatFiles: { paths: ["src/a.txt", "src/b.txt"], destination: "joined.txt" },
      CopyPath: { source: "src/a.txt", destination: "copy.txt" },
      DiskUsage: { path: "." },
      FileHash: { path: "src/a.txt" },
      FindFiles: { name: "*.txt" },
      FrontmatterRead: { path: "doc.md" },
      FrontmatterWrite: { path: "doc.md", data: { status: "done" } },
      MakeDirectory: { path: "made" },
      MovePath: { source: "src/b.txt", destination: "moved.txt" },
      NotebookEdit: { path: "nb.ipynb", mode: "replace", index: 0, source: "x = 2\n" },
      NotebookRead: { path: "nb.ipynb" },
      ReadLines: { path: "src/a.txt", start: 1, end: 2 },
      RemovePath: { path: "src/a.txt", dryRun: true },
      SplitFile: { path: "src/a.txt", maxLines: 2, dryRun: true },
      Stat: { path: "src/a.txt" },
      TailFile: { path: "src/a.txt", lines: 2 },
      TempDir: { name: "scratch" },
      TouchFile: { path: "marker" },
      Tree: { path: "." },
    };
    // Every registered tool must appear above; a new one without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(FSX_TOOLS.map((t) => t.name).sort());
    for (const tool of FSX_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    const args = { path: ".", maxDepth: 2 };
    const a = await executeTool(lookup("Tree"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("Tree"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });

  test("a read tool and a write tool are distinguishable by their flags alone", () => {
    expect(lookup("Tree").readOnly).toBe(true);
    expect(lookup("Tree").concurrencySafe).toBe(true);
    expect(lookup("RemovePath").destructive).toBe(true);
    expect(lookup("RemovePath").concurrencySafe).toBe(false);
  });
});
