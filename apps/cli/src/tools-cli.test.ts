/**
 * Item 18 — unit tests for the `crewhaus tools` namespace: list projection,
 * deterministic keyword implication, usage audit over seeded tool_stats
 * fixtures, and — critically — the loadToolMap ↔ BUILTIN_TOOL_MAP sync guard.
 */
import { describe, expect, it } from "bun:test";
import { BUILTIN_TOOL_MAP } from "@crewhaus/target-cli";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type SessionEvents, parseJsonlObjects } from "./advise-rules";
import {
  CLI_RUNTIME_TOOL_KEYS,
  auditTools,
  buildToolList,
  buildToolUsage,
  diffToolMapKeys,
  formatAuditLines,
  formatSuggestLines,
  formatToolListLines,
  suggestTools,
} from "./tools-cli";

// A minimal RegisteredTool stub — only the fields the tools module reads.
function tool(name: string, over: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    name,
    description: `${name} does a thing`,
    inputSchema: z.unknown(),
    execute: async () => ({ content: "" }) as never,
    concurrencySafe: false,
    readOnly: false,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: true,
    scope: "internal",
    requireJustification: false,
    ...over,
  };
}

const TOOL_MAP: Record<string, RegisteredTool> = {
  read: tool("Read", { readOnly: true }),
  write: tool("Write", { destructive: true }),
  bash: tool("Bash", { destructive: true, scope: "external", ioCapability: "process" }),
  webFetch: tool("WebFetch", { readOnly: true, scope: "external", ioCapability: "network" }),
  python: tool("Python", { destructive: true, requiresSandbox: true }),
};
const TOOL_KEYS = Object.keys(TOOL_MAP);

function jsonl(lines: unknown[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}
function statLine(toolName: string, isError: boolean): unknown {
  return { ts: 1, version: 1, kind: "tool_stats", payload: { toolName, durationMs: 12, isError } };
}
function session(sessionId: string, lines: unknown[]): SessionEvents {
  return { sessionId, objects: parseJsonlObjects(jsonl(lines)) };
}
function statsFor(toolName: string, calls: number, errors: number): unknown[] {
  return Array.from({ length: calls }, (_, i) => statLine(toolName, i < errors));
}

// -------- map-sync guard (the item's CI-style invariant) --------

describe("loadToolMap ↔ BUILTIN_TOOL_MAP sync", () => {
  it("CLI_RUNTIME_TOOL_KEYS equals BUILTIN_TOOL_MAP keys exactly", () => {
    const runtime = [...CLI_RUNTIME_TOOL_KEYS].sort();
    const compile = Object.keys(BUILTIN_TOOL_MAP).sort();
    const { onlyInA, onlyInB } = diffToolMapKeys(runtime, compile);
    // Fail with the exact drift so a future edit to one map is actionable.
    expect({ runtimeOnly: onlyInA, compileOnly: onlyInB }).toEqual({
      runtimeOnly: [],
      compileOnly: [],
    });
  });

  it("has no duplicate keys in the runtime list", () => {
    expect(new Set(CLI_RUNTIME_TOOL_KEYS).size).toBe(CLI_RUNTIME_TOOL_KEYS.length);
  });

  it("diffToolMapKeys reports the symmetric difference", () => {
    expect(diffToolMapKeys(["a", "b"], ["b", "c"])).toEqual({ onlyInA: ["a"], onlyInB: ["c"] });
  });
});

// -------- tools list --------

describe("buildToolList", () => {
  it("projects sorted rows with metadata", () => {
    const rows = buildToolList(TOOL_MAP);
    expect(rows.map((r) => r.key)).toEqual(["bash", "python", "read", "webFetch", "write"]);
    const webFetch = rows.find((r) => r.key === "webFetch");
    expect(webFetch).toMatchObject({
      name: "WebFetch",
      readOnly: true,
      scope: "external",
      ioCapability: "network",
    });
  });

  it("formats read-only / external / sandbox flags", () => {
    const lines = formatToolListLines(buildToolList(TOOL_MAP));
    const blob = lines.join("\n");
    expect(blob).toContain("read (Read) [read-only]");
    expect(blob).toContain("python (Python) [destructive, sandbox]");
    expect(blob).toContain("io:network");
  });
});

// -------- tools suggest --------

describe("suggestTools", () => {
  it("implies missing tools by instruction keywords, ranked by hit count", () => {
    const instructions =
      "You search the web and fetch a url, then grep the repo for the symbol and run a shell command.";
    const result = suggestTools(instructions, [], TOOL_KEYS, TOOL_MAP);
    const keys = result.missing.map((s) => s.key);
    expect(keys).toContain("webFetch");
    expect(keys).toContain("bash");
    // every suggestion carries the matched keywords as evidence
    for (const s of result.missing) expect(s.matchedKeywords.length).toBeGreaterThan(0);
  });

  it("separates already-present implied tools from missing ones", () => {
    const instructions = "read the file and write to disk";
    const result = suggestTools(instructions, ["read"], TOOL_KEYS, TOOL_MAP);
    expect(result.missing.map((s) => s.key)).toContain("write");
    expect(result.present.map((s) => s.key)).toContain("read");
    expect(result.missing.map((s) => s.key)).not.toContain("read");
  });

  it("flags granted tools that no keyword implied (possible over-grant)", () => {
    const result = suggestTools("just read a file", ["read", "python"], TOOL_KEYS, TOOL_MAP);
    expect(result.unimplied).toEqual(["python"]);
  });

  it("never suggests a tool absent from the resolvable key set", () => {
    // webFetch is implied by keywords but excluded from the key set here.
    const result = suggestTools("fetch a url from the web", [], ["read", "write"], TOOL_MAP);
    expect(result.missing.map((s) => s.key)).not.toContain("webFetch");
  });

  it("is deterministic and reports nothing on empty instructions", () => {
    const result = suggestTools("", [], TOOL_KEYS, TOOL_MAP);
    expect(result.missing).toEqual([]);
    expect(formatSuggestLines(result)[0]).toContain("no additional builtins");
  });
});

// -------- tools audit --------

describe("buildToolUsage", () => {
  it("aggregates tool_stats by PascalCase runtime name", () => {
    const usage = buildToolUsage([
      session("sess_00000000000000aa", [...statsFor("Read", 3, 0), ...statsFor("Bash", 2, 1)]),
    ]);
    expect(usage.get("Read")).toEqual({ calls: 3, errors: 0, totalDurationMs: 36 });
    expect(usage.get("Bash")).toEqual({ calls: 2, errors: 1, totalDurationMs: 24 });
  });

  it("tolerates old-vintage logs with no tool_stats lines", () => {
    const usage = buildToolUsage([
      session("sess_00000000000000bb", [
        { ts: 1, version: 1, kind: "assistant_message", payload: { text: "hi" } },
      ]),
    ]);
    expect(usage.size).toBe(0);
  });
});

describe("auditTools", () => {
  const sessions = [
    session("sess_00000000000000aa", [
      ...statsFor("Read", 12, 0), // clean, but Read is already readOnly
      ...statsFor("Bash", 6, 4), // failing (66%)
      ...statsFor("Python", 11, 0), // clean, NOT readOnly → learned-readOnly candidate
      // Write never called
    ]),
  ];
  const usage = buildToolUsage(sessions);

  it("flags unused grants only when the spec has an explicit list", () => {
    const result = auditTools({
      sessions,
      specTools: ["read", "write", "bash", "python"],
      usage,
      toolMap: TOOL_MAP,
      hasExplicitToolList: true,
    });
    const unused = result.findings.filter((f) => f.kind === "unused");
    expect(unused.map((f) => f.key)).toEqual(["write"]);
  });

  it("skips unused detection when no explicit list was declared", () => {
    const result = auditTools({
      sessions,
      specTools: [],
      usage,
      toolMap: TOOL_MAP,
      hasExplicitToolList: false,
    });
    expect(result.findings.some((f) => f.kind === "unused")).toBe(false);
  });

  it("flags chronically failing tools with rate evidence", () => {
    const result = auditTools({
      sessions,
      specTools: ["bash"],
      usage,
      toolMap: TOOL_MAP,
      hasExplicitToolList: true,
    });
    const failing = result.findings.find((f) => f.kind === "failing");
    expect(failing).toMatchObject({ key: "bash", name: "Bash", calls: 6, errors: 4 });
  });

  it("proposes learned-readOnly for a non-readOnly tool with many clean calls", () => {
    const result = auditTools({
      sessions,
      specTools: ["python"],
      usage,
      toolMap: TOOL_MAP,
      hasExplicitToolList: true,
    });
    const learned = result.findings.find((f) => f.kind === "learned-read-only");
    expect(learned).toMatchObject({ key: "python", name: "Python", calls: 11 });
    // Read is clean+many calls but already readOnly → never flagged.
    expect(result.findings.some((f) => f.kind === "learned-read-only" && f.key === "read")).toBe(
      false,
    );
  });

  it("orders findings unused → failing → learned-readOnly and formats them", () => {
    const result = auditTools({
      sessions,
      specTools: ["read", "write", "bash", "python"],
      usage,
      toolMap: TOOL_MAP,
      hasExplicitToolList: true,
    });
    const kinds = result.findings.map((f) => f.kind);
    expect(kinds.indexOf("unused")).toBeLessThan(kinds.indexOf("failing"));
    expect(kinds.indexOf("failing")).toBeLessThan(kinds.indexOf("learned-read-only"));
    const blob = formatAuditLines(result).join("\n");
    expect(blob).toContain("[remove?] write");
    expect(blob).toContain("[failing] bash");
    expect(blob).toContain("[read-only?] python");
  });

  it("reports a clean bill when grants match usage", () => {
    const clean = [session("sess_00000000000000cc", statsFor("Read", 3, 0))];
    const result = auditTools({
      sessions: clean,
      specTools: ["read"],
      usage: buildToolUsage(clean),
      toolMap: TOOL_MAP,
      hasExplicitToolList: true,
    });
    expect(result.findings).toEqual([]);
    expect(formatAuditLines(result)[0]).toContain("no tool-usage findings");
  });
});
