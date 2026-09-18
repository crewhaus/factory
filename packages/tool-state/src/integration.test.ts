/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before `execute` ever
 * runs.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { STATE_TOOLS } from "./index";

const originalCwd = process.cwd();
let tmp: string;
let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-state-int-"));
  process.chdir(tmp);
  catalog = new ToolCatalog();
  for (const tool of STATE_TOOLS) catalog.register(tool);
  mkdirSync(path.join(tmp, "docs"), { recursive: true });
  writeFileSync(path.join(tmp, "docs/a.md"), "The parser reads tokens and builds a tree.");
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(STATE_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of STATE_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("KvSet"),
      { namespace: "n", key: "k", value: { a: 1 } },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"stored":true');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("KvSet"),
      { namespace: 42, key: "k", value: 1 },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("KvSet");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("JournalAppend"), { stream: "s" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("CounterGet"),
      {},
      { toolUseId: "t4", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("CounterGet"),
      {},
      { toolUseId: "t5", allowedPatterns: ["CounterGet"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const calls: Record<string, unknown> = {
      BlackboardPost: { topic: "t", author: "a", text: "hello" },
      BlackboardRead: { topic: "t" },
      CheckpointList: {},
      CheckpointLoad: { name: "cp" },
      CheckpointSave: { name: "cp", data: { at: 1 } },
      CounterGet: { name: "c" },
      CounterIncrement: { name: "c" },
      DedupeMark: { scope: "s", id: "x" },
      IndexBuild: { name: "docs", paths: ["docs/a.md"] },
      IndexSearch: { name: "docs", query: "parser" },
      JournalAppend: { stream: "s", entry: { a: 1 } },
      JournalRead: { stream: "s" },
      KvDelete: { namespace: "n", key: "k" },
      KvGet: { namespace: "n", key: "k" },
      KvList: { namespace: "n" },
      KvSet: { namespace: "n", key: "k", value: 1 },
      NoteSearch: { query: "alpha" },
      NoteWrite: { id: "n1", text: "alpha" },
      StateExport: {},
      StateImport: { document: { version: 1, files: [] }, dryRun: true },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(STATE_TOOLS.map((tool) => tool.name).sort());
    for (const tool of STATE_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("a caller mistake comes back as a readable result, not as a thrown error", async () => {
    const escaped = await executeTool(
      lookup("KvGet"),
      { namespace: "n", key: "k", stateDir: "../outside" },
      { toolUseId: "e1" },
    );
    expect(escaped.isError).toBe(false);
    expect(escaped.content).toContain("escapes the workspace root");

    const badNamespace = await executeTool(
      lookup("KvSet"),
      { namespace: "a/b", key: "k", value: 1 },
      { toolUseId: "e2" },
    );
    expect(badNamespace.isError).toBe(false);
    expect(badNamespace.content).toContain("namespace");
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    await executeTool(
      lookup("NoteWrite"),
      { id: "n1", text: "alpha beta", title: "Alpha" },
      { toolUseId: "d0" },
    );
    const args = { query: "alpha" };
    const a = await executeTool(lookup("NoteSearch"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("NoteSearch"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });

  test("a full round trip: write, journal, checkpoint, resume, export", async () => {
    await executeTool(
      lookup("KvSet"),
      { namespace: "job", key: "cursor", value: 100 },
      { toolUseId: "r1" },
    );
    await executeTool(
      lookup("JournalAppend"),
      { stream: "job", entry: { cursor: 100 }, kind: "progress" },
      { toolUseId: "r2" },
    );
    await executeTool(
      lookup("CheckpointSave"),
      { name: "job", data: { cursor: 100 } },
      { toolUseId: "r3" },
    );
    const resumed = await executeTool(
      lookup("CheckpointLoad"),
      { name: "job" },
      { toolUseId: "r4" },
    );
    expect(resumed.content).toContain('"cursor":100');

    const exported = await executeTool(lookup("StateExport"), {}, { toolUseId: "r5" });
    const document = JSON.parse(String(exported.content));
    const restored = await executeTool(
      lookup("StateImport"),
      { document, stateDir: "restored" },
      { toolUseId: "r6" },
    );
    expect(restored.isError).toBe(false);
    const readBack = await executeTool(
      lookup("KvGet"),
      { namespace: "job", key: "cursor", stateDir: "restored" },
      { toolUseId: "r7" },
    );
    expect(readBack.content).toContain('"value":100');
  });
});
