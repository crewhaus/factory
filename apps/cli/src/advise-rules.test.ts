/**
 * Item 14 — unit tests for the `crewhaus advise` rule library: context
 * building from seeded session JSONLs (new-vintage AND old-vintage logs),
 * each rule's hit / no-hit / threshold-edge behavior, SpecPatch
 * pre-validation, and the report/suggestions artifacts.
 */
import { describe, expect, it } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import { validatePatch } from "@crewhaus/spec-patch";
import {
  type AdviceFinding,
  type SessionEvents,
  buildAdviceContext,
  buildSuggestionsFile,
  formatFindingLines,
  parseJsonlObjects,
  renderAdviceHtml,
  ruleCompactionThrash,
  rulePermissionChurn,
  ruleRepeatedToolFailures,
  ruleStopReasonAnomalies,
  ruleTruncationPressure,
  runAdviceRules,
} from "./advise-rules";

const SESSION_A = "sess_00000000000000aa";
const SESSION_B = "sess_00000000000000bb";

function jsonl(lines: unknown[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

function line(kind: string, payload: unknown): unknown {
  return { ts: 1, version: 1, kind, payload };
}

function toolStatsLines(tool: string, calls: number, errors: number): unknown[] {
  return Array.from({ length: calls }, (_, i) =>
    line("tool_stats", { toolName: tool, durationMs: 10, isError: i < errors }),
  );
}

function askLines(tool: string, approved: number, denied: number): unknown[] {
  return [
    ...Array.from({ length: approved }, () =>
      line("permission", { toolName: tool, decision: "ask", askOutcome: "approved" }),
    ),
    ...Array.from({ length: denied }, () =>
      line("permission", { toolName: tool, decision: "ask", askOutcome: "denied" }),
    ),
  ];
}

function stopLines(reasons: string[]): unknown[] {
  return reasons.map((stopReason) => line("model_meta", { stopReason, model: "m" }));
}

function session(sessionId: string, lines: unknown[]): SessionEvents {
  return { sessionId, objects: parseJsonlObjects(jsonl(lines)) };
}

const CLI_SPEC = parseSpec(
  [
    "name: hello",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: help",
  ].join("\n"),
);

const CLI_SPEC_TUNED = parseSpec(
  [
    "name: hello",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: help",
    "  max_tokens: 8192",
    "tools: [Fetch]",
    "tool_config:",
    "  Fetch:",
    "    timeoutMs: 5000",
    "compaction:",
    "  curate: true",
  ].join("\n"),
);

// An OLD-VINTAGE transcript: only the kinds that existed before item 14.
const OLD_VINTAGE = [
  line("user_message", { content: "q" }),
  line("assistant_message", { content: [{ type: "text", text: "a" }] }),
  line("tool_use", { id: "tu_1", name: "Fetch", input: {} }),
  line("tool_result", { toolUseId: "tu_1", content: "ok", isError: false }),
  line("error", { name: "E", message: "boom" }),
  line("compaction", { kind: "snip", before: 40, after: 20 }),
];

describe("parseJsonlObjects", () => {
  it("skips blank and malformed lines without aborting", () => {
    const objects = parseJsonlObjects('{"kind":"a"}\n\nNOT JSON\n{"kind":"b"}\n');
    expect(objects).toEqual([{ kind: "a" }, { kind: "b" }]);
  });
});

describe("buildAdviceContext", () => {
  it("aggregates every advisor kind from a new-vintage log", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        ...toolStatsLines("Fetch", 3, 2),
        line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 1 }),
        line("recovery", { errorName: "OverloadedError", action: "retry", depth: 1 }),
        line("compaction", { kind: "snip", before: 40, after: 20 }),
        ...askLines("Write", 2, 1),
        ...stopLines(["end_turn", "max_tokens"]),
      ]),
    ]);
    expect(ctx.sessionIds).toEqual([SESSION_A]);
    expect(ctx.toolStats.get("Fetch")).toEqual({ calls: 3, errors: 2, totalDurationMs: 30 });
    expect(ctx.recoveriesByAction.get("continue")).toBe(1);
    expect(ctx.recoveriesByAction.get("retry")).toBe(1);
    expect(ctx.truncationContinues).toBe(1);
    expect(ctx.compactionsBySession.get(SESSION_A)).toBe(1);
    expect(ctx.asksByTool.get("Write")).toEqual({ asks: 3, approved: 2, denied: 1 });
    expect(ctx.stopReasons.get("max_tokens")).toBe(1);
    expect(ctx.modelResponses).toBe(2);
  });

  it("an old-vintage log (no advisor kinds) yields empty slices except compaction", () => {
    const ctx = buildAdviceContext([session(SESSION_A, OLD_VINTAGE)]);
    expect(ctx.toolStats.size).toBe(0);
    expect(ctx.truncationContinues).toBe(0);
    expect(ctx.asksByTool.size).toBe(0);
    expect(ctx.modelResponses).toBe(0);
    // `compaction` predates item 14 — old logs still feed the thrash rule.
    expect(ctx.compactionsBySession.get(SESSION_A)).toBe(1);
    // …and no rule fires on it below its threshold.
    expect(runAdviceRules(ctx)).toEqual([]);
  });

  it("tolerates malformed payloads and unknown kinds", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        line("tool_stats", null),
        line("tool_stats", { toolName: 42 }),
        line("permission", { decision: "ask" }), // no toolName
        line("model_meta", { stopReason: 7 }),
        line("some_future_kind", { x: 1 }),
        "not an object",
      ]),
    ]);
    expect(ctx.toolStats.size).toBe(0);
    expect(ctx.asksByTool.size).toBe(0);
    expect(ctx.modelResponses).toBe(0);
  });

  it("counts audit record kinds", () => {
    const ctx = buildAdviceContext(
      [session(SESSION_A, [])],
      parseJsonlObjects(
        jsonl([
          { ts: 1, version: 1, seq: 0, kind: "permission_justification_evaluated", payload: {} },
          { ts: 2, version: 1, seq: 1, kind: "permission_justification_evaluated", payload: {} },
          { ts: 3, version: 1, seq: 2, kind: "retention_enforcement", payload: {} },
        ]),
      ),
    );
    expect(ctx.auditKindCounts.get("permission_justification_evaluated")).toBe(2);
    expect(ctx.auditKindCounts.get("retention_enforcement")).toBe(1);
  });
});

describe("ruleRepeatedToolFailures", () => {
  it("fires at the threshold edge (5 calls, exactly 50% errors)", () => {
    const ctx = buildAdviceContext([session(SESSION_A, toolStatsLines("Fetch", 6, 3))]);
    const findings = ruleRepeatedToolFailures(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("repeated-tool-failures:Fetch");
    expect(findings[0]?.severity).toBe("warn");
    expect(findings[0]?.counts).toEqual({ calls: 6, errors: 3 });
    expect(findings[0]?.suggestion.kind).toBe("advice");
  });

  it("stays silent below the call floor even at 100% errors", () => {
    const ctx = buildAdviceContext([session(SESSION_A, toolStatsLines("Fetch", 4, 4))]);
    expect(ruleRepeatedToolFailures(ctx)).toEqual([]);
  });

  it("stays silent below the error-rate threshold", () => {
    const ctx = buildAdviceContext([session(SESSION_A, toolStatsLines("Fetch", 10, 4))]);
    expect(ruleRepeatedToolFailures(ctx)).toEqual([]);
  });

  it("mentions the tool_config block when the spec has one for the tool", () => {
    const ctx = buildAdviceContext([session(SESSION_A, toolStatsLines("Fetch", 5, 5))]);
    const withConfig = ruleRepeatedToolFailures(ctx, { spec: CLI_SPEC_TUNED });
    const without = ruleRepeatedToolFailures(ctx, { spec: CLI_SPEC });
    expect(withConfig[0]?.suggestion.kind === "advice" && withConfig[0].suggestion.text).toContain(
      "tool_config.Fetch",
    );
    expect(without[0]?.suggestion.kind === "advice" && without[0].suggestion.text).not.toContain(
      "tool_config",
    );
  });
});

describe("ruleTruncationPressure", () => {
  const twoContinues = [
    line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 1 }),
    line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 2 }),
  ];

  it("fires at the edge (2 continues) with an `add 16384` patch when the spec has no cap", () => {
    const ctx = buildAdviceContext([session(SESSION_A, twoContinues)]);
    const findings = ruleTruncationPressure(ctx, { spec: CLI_SPEC });
    expect(findings).toHaveLength(1);
    const suggestion = findings[0]?.suggestion;
    if (suggestion?.kind !== "spec-patch") throw new Error("expected a spec-patch suggestion");
    expect(suggestion.patch).toMatchObject({
      target: "cli",
      path: ["agent", "max_tokens"],
      op: "add",
      value: 16384,
    });
    // The emitted patch passes spec-patch's own validator (whitelist floor).
    expect(() => validatePatch(CLI_SPEC, suggestion.patch)).not.toThrow();
  });

  it("doubles an existing agent.max_tokens with a replace patch", () => {
    const ctx = buildAdviceContext([session(SESSION_A, twoContinues)]);
    const findings = ruleTruncationPressure(ctx, { spec: CLI_SPEC_TUNED });
    const suggestion = findings[0]?.suggestion;
    if (suggestion?.kind !== "spec-patch") throw new Error("expected a spec-patch suggestion");
    expect(suggestion.patch).toMatchObject({ op: "replace", value: 16384 });
    expect(() => validatePatch(CLI_SPEC_TUNED, suggestion.patch)).not.toThrow();
  });

  it("stays silent below the threshold (1 continue)", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 1 }),
      ]),
    ]);
    expect(ruleTruncationPressure(ctx, { spec: CLI_SPEC })).toEqual([]);
  });

  it("degrades to advice text when no spec is available", () => {
    const ctx = buildAdviceContext([session(SESSION_A, twoContinues)]);
    const findings = ruleTruncationPressure(ctx);
    expect(findings[0]?.suggestion.kind).toBe("advice");
  });

  it("non-continue recoveries (retry/compact) do not count", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        line("recovery", { errorName: "OverloadedError", action: "retry", depth: 1 }),
        line("recovery", { errorName: "PromptTooLong", action: "compact", depth: 1 }),
      ]),
    ]);
    expect(ruleTruncationPressure(ctx, { spec: CLI_SPEC })).toEqual([]);
  });
});

describe("ruleCompactionThrash", () => {
  function compactions(n: number): unknown[] {
    return Array.from({ length: n }, () =>
      line("compaction", { kind: "autocompact", before: 40, after: 10 }),
    );
  }

  it("fires at the edge (3 compactions in ONE session) as advice, never a patch", () => {
    const ctx = buildAdviceContext([session(SESSION_A, compactions(3))]);
    const findings = ruleCompactionThrash(ctx, { spec: CLI_SPEC });
    expect(findings).toHaveLength(1);
    const suggestion = findings[0]?.suggestion;
    if (suggestion?.kind !== "advice") throw new Error("expected an advice suggestion");
    // compaction.curate is not wired at runtime — the rule must not stamp
    // an inert patch that `optimize --from-advice` could write into the
    // user's spec while changing nothing.
    expect(suggestion.text).toContain("not yet wired at runtime");
    expect(suggestion.text).toContain("sub-agent");
  });

  it("compactions spread across sessions do not trip the per-session threshold", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, compactions(2)),
      session(SESSION_B, compactions(2)),
    ]);
    expect(ruleCompactionThrash(ctx, { spec: CLI_SPEC })).toEqual([]);
  });

  it("stays advice-only (with a curate-specific caveat) when curate is already enabled", () => {
    const ctx = buildAdviceContext([session(SESSION_A, compactions(4))]);
    const findings = ruleCompactionThrash(ctx, { spec: CLI_SPEC_TUNED });
    const suggestion = findings[0]?.suggestion;
    expect(suggestion?.kind).toBe("advice");
    expect(suggestion?.kind === "advice" && suggestion.text).toContain("already set");
    expect(suggestion?.kind === "advice" && suggestion.text).toContain("not yet wired at runtime");
  });
});

describe("rulePermissionChurn", () => {
  it("fires at the edge (3 asks, 100% approved) as info advice — never a patch", () => {
    const ctx = buildAdviceContext([session(SESSION_A, askLines("Write", 3, 0))]);
    const findings = rulePermissionChurn(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("permission-churn:Write");
    expect(findings[0]?.severity).toBe("info");
    const suggestion = findings[0]?.suggestion;
    expect(suggestion?.kind).toBe("advice");
    expect(suggestion?.kind === "advice" && suggestion.text).toContain("alwaysAllow");
  });

  it("a single denial breaks the 100%-approved condition", () => {
    const ctx = buildAdviceContext([session(SESSION_A, askLines("Write", 3, 1))]);
    expect(rulePermissionChurn(ctx)).toEqual([]);
  });

  it("stays silent below the ask floor", () => {
    const ctx = buildAdviceContext([session(SESSION_A, askLines("Write", 2, 0))]);
    expect(rulePermissionChurn(ctx)).toEqual([]);
  });
});

describe("ruleStopReasonAnomalies", () => {
  it("fires at the edge (4 responses, exactly 25% anomalous)", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, stopLines(["max_tokens", "end_turn", "tool_use", "end_turn"])),
    ]);
    const findings = ruleStopReasonAnomalies(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.counts).toEqual({ anomalous: 1, responses: 4 });
    expect(findings[0]?.summary).toContain("max_tokens×1");
  });

  it("tool_use and stop_sequence stops are healthy", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, stopLines(["tool_use", "tool_use", "stop_sequence", "end_turn"])),
    ]);
    expect(ruleStopReasonAnomalies(ctx)).toEqual([]);
  });

  it("stays silent below the response floor", () => {
    const ctx = buildAdviceContext([session(SESSION_A, stopLines(["max_tokens", "refusal"]))]);
    expect(ruleStopReasonAnomalies(ctx)).toEqual([]);
  });
});

describe("runAdviceRules", () => {
  it("ranks warn findings before info, then by count magnitude", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        ...askLines("Write", 3, 0), // info churn
        ...toolStatsLines("Fetch", 5, 5), // warn failures (count 5)
        line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 1 }),
        line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 2 }), // warn truncation (count 2)
      ]),
    ]);
    const findings = runAdviceRules(ctx, { spec: CLI_SPEC });
    expect(findings.map((f) => f.id)).toEqual([
      "repeated-tool-failures:Fetch",
      "truncation-pressure",
      "permission-churn:Write",
    ]);
  });

  it("every emitted spec-patch validates against the spec it was built from", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        ...toolStatsLines("Fetch", 6, 6),
        line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 1 }),
        line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 2 }),
        line("compaction", { kind: "snip", before: 40, after: 20 }),
        line("compaction", { kind: "snip", before: 40, after: 20 }),
        line("compaction", { kind: "autocompact", before: 40, after: 10 }),
      ]),
    ]);
    const findings = runAdviceRules(ctx, { spec: CLI_SPEC });
    const patches = findings.filter((f) => f.suggestion.kind === "spec-patch");
    // Only truncation-pressure patches here — compaction-thrash is
    // advice-only (compaction.curate is not wired at runtime, see
    // ruleCompactionThrash) and repeated-tool-failures never patches.
    expect(patches.length).toBeGreaterThanOrEqual(1);
    for (const f of findings) {
      if (f.suggestion.kind === "spec-patch") {
        expect(() => validatePatch(CLI_SPEC, f.suggestion.patch)).not.toThrow();
      }
    }
  });

  it("returns no findings for a quiet context", () => {
    expect(runAdviceRules(buildAdviceContext([session(SESSION_A, [])]))).toEqual([]);
  });
});

describe("artifacts", () => {
  const noisyContext = () =>
    buildAdviceContext([
      session(SESSION_A, [
        ...toolStatsLines("Fetch", 5, 5),
        line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 1 }),
        line("recovery", { errorName: "MaxTokensError", action: "continue", depth: 2 }),
      ]),
    ]);

  it("buildSuggestionsFile keeps only spec-patch findings", () => {
    const findings = runAdviceRules(noisyContext(), { spec: CLI_SPEC });
    const file = buildSuggestionsFile(findings, [SESSION_A], "2026-07-02T00:00:00.000Z");
    expect(file.sessionIds).toEqual([SESSION_A]);
    expect(file.suggestions).toHaveLength(1);
    expect(file.suggestions[0]?.findingId).toBe("truncation-pressure");
    expect(file.suggestions[0]?.patch.path).toEqual(["agent", "max_tokens"]);
  });

  it("renderAdviceHtml escapes evidence and renders the empty state", () => {
    const hostile: AdviceFinding = {
      id: "repeated-tool-failures:<script>",
      severity: "warn",
      summary: 'tool <script>alert("x")</script> failed',
      evidence: ['<img src=x onerror="pwn()">'],
      counts: { calls: 5 },
      suggestion: { kind: "advice", text: "swap <the> tool" },
    };
    const html = renderAdviceHtml({
      findings: [hostile],
      sessionIds: [SESSION_A],
      generatedAt: "2026-07-02T00:00:00.000Z",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('<img src=x onerror="pwn()">');
    expect(html).toContain("&lt;script&gt;");
    const empty = renderAdviceHtml({
      findings: [],
      sessionIds: [],
      generatedAt: "2026-07-02T00:00:00.000Z",
    });
    expect(empty).toContain("No findings");
  });

  it("formatFindingLines renders both suggestion kinds", () => {
    const findings = runAdviceRules(noisyContext(), { spec: CLI_SPEC });
    const lines = findings.flatMap(formatFindingLines);
    expect(lines.some((l) => l.includes("patch: add agent.max_tokens → 16384"))).toBe(true);
    expect(lines.some((l) => l.startsWith("  advice: "))).toBe(true);
  });
});
