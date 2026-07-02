/**
 * Item 16 — unit tests for `crewhaus permissions suggest`: ask/deny
 * aggregation from seeded permission + tool_use fixtures, read-only-first
 * ranking, the arg-glob derivation, and the additive settings.json diff/merge.
 */
import { describe, expect, it } from "bun:test";
import { parsePermissionsConfig } from "@crewhaus/permission-engine";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { type SessionEvents, parseJsonlObjects } from "./advise-rules";
import {
  aggregateAsks,
  applyToSettingsRoot,
  diffPermissions,
  existingSettingsRules,
  formatSettingsDiff,
  patternFor,
  rankSuggestions,
  readOnlyByName,
} from "./permissions-suggest";

function tool(name: string, readOnly: boolean): RegisteredTool {
  return {
    name,
    description: name,
    inputSchema: z.unknown(),
    execute: async () => ({ content: "" }) as never,
    concurrencySafe: false,
    readOnly,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: true,
    scope: "internal",
    requireJustification: false,
  };
}
const TOOL_MAP: Record<string, RegisteredTool> = {
  read: tool("Read", true),
  webFetch: tool("WebFetch", true),
  bash: tool("Bash", false),
  write: tool("Write", false),
};

function jsonl(lines: unknown[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}
function line(kind: string, payload: unknown): unknown {
  return { ts: 1, version: 1, kind, payload };
}
function ask(toolName: string, outcome: "approved" | "denied"): unknown {
  return line("permission", { toolName, decision: "ask", askOutcome: outcome });
}
function toolUse(name: string, input: unknown): unknown {
  return line("tool_use", { id: "toolu_1", name, input });
}
function session(sessionId: string, lines: unknown[]): SessionEvents {
  return { sessionId, objects: parseJsonlObjects(jsonl(lines)) };
}

// -------- aggregation --------

describe("aggregateAsks", () => {
  it("counts ask outcomes per tool and skips allow/deny decisions", () => {
    const s = session("sess_00000000000000aa", [
      ask("Read", "approved"),
      ask("Read", "approved"),
      ask("Read", "approved"),
      line("permission", { toolName: "Read", decision: "allow", askOutcome: null }),
      ask("Bash", "denied"),
      ask("Bash", "denied"),
    ]);
    const agg = aggregateAsks([s]);
    expect(agg.get("Read")).toMatchObject({ asks: 3, approved: 3, denied: 0 });
    expect(agg.get("Bash")).toMatchObject({ asks: 2, approved: 0, denied: 2 });
  });

  it("derives operative-arg samples from adjacent tool_use inputs", () => {
    const s = session("sess_00000000000000bb", [
      toolUse("Bash", { command: "git status" }),
      toolUse("Bash", { command: "git status" }), // dup — deduped
      ask("Bash", "approved"),
      ask("Bash", "approved"),
      ask("Bash", "approved"),
    ]);
    const agg = aggregateAsks([s]);
    expect(agg.get("Bash")?.argSamples).toEqual(["git status"]);
  });

  it("drops tools that only produced tool_use samples but never prompted", () => {
    const s = session("sess_00000000000000cc", [toolUse("Read", { path: "/a" })]);
    expect(aggregateAsks([s]).has("Read")).toBe(false);
  });

  it("tolerates old-vintage logs with no permission lines", () => {
    const s = session("sess_00000000000000dd", [line("assistant_message", { text: "hi" })]);
    expect(aggregateAsks([s]).size).toBe(0);
  });
});

// -------- pattern derivation --------

describe("patternFor", () => {
  it("emits a tool+arg glob for a single recurring operative value", () => {
    expect(
      patternFor({ toolName: "Bash", asks: 3, approved: 3, denied: 0, argSamples: ["git status"] }),
    ).toBe("Bash(git status)");
  });
  it("emits a bare tool glob when inputs varied", () => {
    expect(
      patternFor({ toolName: "Bash", asks: 3, approved: 3, denied: 0, argSamples: ["a", "b"] }),
    ).toBe("Bash");
  });
  it("emits a bare tool glob for a tool with no operative field", () => {
    expect(patternFor({ toolName: "Todo", asks: 3, approved: 3, denied: 0, argSamples: [] })).toBe(
      "Todo",
    );
  });
});

// -------- ranking --------

describe("rankSuggestions", () => {
  const readOnly = readOnlyByName(TOOL_MAP);

  it("proposes alwaysAllow for 100%-approved recurring asks, read-only first", () => {
    const agg = aggregateAsks([
      session("sess_00000000000000aa", [
        ...Array.from({ length: 4 }, () => ask("Bash", "approved")), // not read-only, more asks
        ...Array.from({ length: 3 }, () => ask("Read", "approved")), // read-only
      ]),
    ]);
    const suggestions = rankSuggestions(agg, readOnly);
    expect(suggestions.map((s) => s.toolName)).toEqual(["Read", "Bash"]); // read-only first
    expect(suggestions.every((s) => s.rule.type === "alwaysAllow")).toBe(true);
    expect(suggestions[0]?.rule.source).toBe("settings");
  });

  it("does NOT grant a tool with any denial; proposes alwaysAsk tightening instead", () => {
    const agg = aggregateAsks([
      session("sess_00000000000000bb", [
        ask("Write", "approved"),
        ask("Write", "denied"),
        ask("Write", "denied"),
      ]),
    ]);
    const suggestions = rankSuggestions(agg, readOnly);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ reason: "recurring-denied" });
    expect(suggestions[0]?.rule.type).toBe("alwaysAsk");
  });

  it("respects the minAsks threshold", () => {
    const agg = aggregateAsks([
      session("sess_00000000000000cc", [ask("Read", "approved"), ask("Read", "approved")]),
    ]);
    expect(rankSuggestions(agg, readOnly)).toEqual([]);
  });

  it("carries evidence counts on every suggestion", () => {
    const agg = aggregateAsks([
      session(
        "sess_00000000000000dd",
        Array.from({ length: 3 }, () => ask("Read", "approved")),
      ),
    ]);
    const [s] = rankSuggestions(agg, readOnly);
    expect(s?.evidence.some((e) => e.includes("3/3"))).toBe(true);
  });
});

// -------- settings.json diff + merge --------

describe("existingSettingsRules", () => {
  it("reads the buildRuleSet-shaped permissions.rules", () => {
    const root = {
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Read" }] },
      hooks: { foo: 1 },
    };
    expect(existingSettingsRules(root)).toEqual([{ type: "alwaysAllow", pattern: "Read" }]);
  });
  it("returns [] for a missing/foreign settings root", () => {
    expect(existingSettingsRules(undefined)).toEqual([]);
    expect(existingSettingsRules({ hooks: {} })).toEqual([]);
  });
});

describe("diffPermissions", () => {
  const readOnly = readOnlyByName(TOOL_MAP);
  const suggestions = rankSuggestions(
    aggregateAsks([
      session(
        "sess_00000000000000aa",
        Array.from({ length: 3 }, () => ask("Read", "approved")),
      ),
    ]),
    readOnly,
  );

  it("adds new rules and reports already-present ones as no-ops", () => {
    const diff = diffPermissions([{ type: "alwaysAllow", pattern: "Read" }], suggestions);
    expect(diff.additions).toEqual([]);
    expect(diff.alreadyPresent).toEqual([{ type: "alwaysAllow", pattern: "Read" }]);
    expect(diff.merged).toEqual([{ type: "alwaysAllow", pattern: "Read" }]);
  });

  it("appends additions after existing rules", () => {
    const diff = diffPermissions([{ type: "alwaysDeny", pattern: "Bash(rm**)" }], suggestions);
    expect(diff.additions).toEqual([{ type: "alwaysAllow", pattern: "Read" }]);
    expect(diff.merged).toEqual([
      { type: "alwaysDeny", pattern: "Bash(rm**)" },
      { type: "alwaysAllow", pattern: "Read" },
    ]);
  });

  it("formats a +/context settings diff", () => {
    const diff = diffPermissions([{ type: "alwaysDeny", pattern: "Bash(rm**)" }], suggestions);
    const blob = formatSettingsDiff(diff).join("\n");
    expect(blob).toContain('  + { type: alwaysAllow, pattern: "Read" }');
    expect(blob).toContain('    { type: alwaysDeny, pattern: "Bash(rm**)" }');
  });
});

describe("applyToSettingsRoot", () => {
  it("merges permissions.rules while preserving unrelated top-level keys", () => {
    const root = applyToSettingsRoot({ hooks: { onStop: "x" }, permissions: { mode: "default" } }, [
      { type: "alwaysAllow", pattern: "Read" },
    ]);
    expect(root).toEqual({
      hooks: { onStop: "x" },
      permissions: { mode: "default", rules: [{ type: "alwaysAllow", pattern: "Read" }] },
    });
  });

  it("creates the permissions block from an empty root", () => {
    const root = applyToSettingsRoot(undefined, [{ type: "alwaysAsk", pattern: "Bash" }]);
    expect(root).toEqual({ permissions: { rules: [{ type: "alwaysAsk", pattern: "Bash" }] } });
  });

  it("the applied settings root round-trips through the real settings validator", () => {
    // The whole point: what --apply writes must be readable by buildRuleSet's
    // parsePermissionsConfig (the exact validator the runtime loads with).
    const suggestions = rankSuggestions(
      aggregateAsks([
        session("sess_00000000000000aa", [
          ...Array.from({ length: 3 }, () => ask("Read", "approved")),
          ...Array.from({ length: 3 }, () => ask("WebFetch", "approved")),
        ]),
      ]),
      readOnlyByName(TOOL_MAP),
    );
    const diff = diffPermissions([], suggestions);
    const root = applyToSettingsRoot(undefined, diff.merged);
    // Round-trip: JSON.stringify (what the CLI writes) → parse → validate.
    const reparsed = JSON.parse(JSON.stringify(root)) as { permissions: unknown };
    const parsed = parsePermissionsConfig(reparsed.permissions, "settings");
    expect(parsed.rules.map((r) => r.pattern).sort()).toEqual(["Read", "WebFetch"]);
    expect(parsed.rules.every((r) => r.type === "alwaysAllow")).toBe(true);
  });
});
