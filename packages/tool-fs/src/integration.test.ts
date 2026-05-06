/**
 * Integration test: wire ToolCatalog + buildTool + validateToolInput +
 * matchesPattern + executeTool around the real fs tools. Verifies the
 * path-traversal defense surfaces through executeTool's catch path with
 * isError:true and a permission-flavored message.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { allFsTools } from "./index";

let tmp: string;
let originalCwd: string;
let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(path.join(tmpdir(), "tool-fs-int-"));
  process.chdir(tmp);
  catalog = new ToolCatalog();
  for (const t of allFsTools) catalog.register(t);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("integration: tool-fs through executeTool", () => {
  test("Write → Read round-trips through the executor", async () => {
    const w = await executeTool(
      lookup("Write"),
      { path: "x.txt", content: "hi" },
      { toolUseId: "w1" },
    );
    expect(w.isError).toBe(false);

    const r = await executeTool(lookup("Read"), { path: "x.txt" }, { toolUseId: "r1" });
    expect(r.isError).toBe(false);
    expect(r.content).toBe("hi");
  });

  test("path traversal is caught and returned as isError", async () => {
    const result = await executeTool(
      lookup("Read"),
      { path: "../../../etc/passwd" },
      { toolUseId: "p1" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes the workspace root|rejected path/);
  });

  test("invalid input (missing path) is caught by validate before execute", async () => {
    const result = await executeTool(lookup("Read"), {}, { toolUseId: "v1" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Read");
  });

  test("permission pattern allowedPatterns:['Read'] rejects Write", async () => {
    const result = await executeTool(
      lookup("Write"),
      { path: "x.txt", content: "y" },
      { toolUseId: "perm1", allowedPatterns: ["Read"] },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not permitted");
  });

  test("permission pattern allowedPatterns:['Read'] permits Read", async () => {
    await writeFile(path.join(tmp, "ok.txt"), "ok");
    const result = await executeTool(
      lookup("Read"),
      { path: "ok.txt" },
      { toolUseId: "perm2", allowedPatterns: ["Read"] },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("Edit non-unique error surfaces through executeTool as isError", async () => {
    await writeFile(path.join(tmp, "f.txt"), "ab ab");
    const result = await executeTool(
      lookup("Edit"),
      { path: "f.txt", oldString: "ab", newString: "cd" },
      { toolUseId: "e1" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("2 times");
  });

  test("Glob output flows through executeTool", async () => {
    await writeFile(path.join(tmp, "a.md"), "");
    await writeFile(path.join(tmp, "b.md"), "");
    const result = await executeTool(lookup("Glob"), { pattern: "*.md" }, { toolUseId: "g1" });
    expect(result.isError).toBe(false);
    expect(result.content.split("\n").sort()).toEqual(["a.md", "b.md"]);
  });
});
