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
  LOOP_NUDGE_PREFIX,
  type SessionEvents,
  buildAdviceContext,
  buildSuggestionsFile,
  formatFindingLines,
  loopSignatureOf,
  parseJsonlObjects,
  renderAdviceHtml,
  ruleCompactionThrash,
  ruleFailureTaxonomy,
  ruleLoopBreak,
  rulePermissionChurn,
  rulePoolCandidateDemotion,
  rulePoolPolicyUpgrade,
  rulePoolStaleExploitation,
  ruleRepeatedToolFailures,
  ruleStopReasonAnomalies,
  ruleSubAgentSplit,
  ruleTruncationPressure,
  runAdviceRules,
  subAgentFragment,
  taxonomyPatternTooBroad,
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

// -------- item 19: failure_taxonomy + loop-break --------

function recoveryLine(errorName: string, action: string): unknown {
  return line("recovery", { errorName, action, depth: 1 });
}
function loopNudge(toolName: string): unknown {
  return line("user_message", {
    content: `${LOOP_NUDGE_PREFIX} tool "${toolName}" has been called 3 times with the same input within the last 5 calls. Reconsider before repeating; respond with a different approach or final text.`,
    synthetic: true,
  });
}

describe("buildAdviceContext — item 19 fields", () => {
  it("clusters recovery events by errorName with their action distribution", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "fail"),
        recoveryLine("PromptTooLong", "compact"),
      ]),
    ]);
    const overloaded = ctx.recoveriesByErrorName.get("OverloadedError");
    expect(overloaded?.count).toBe(3);
    expect(overloaded?.actions.get("retry")).toBe(2);
    expect(overloaded?.actions.get("fail")).toBe(1);
    expect(ctx.recoveriesByErrorName.get("PromptTooLong")?.count).toBe(1);
  });

  it("mines loop-detection nudges by tool signature", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [loopNudge("Bash"), loopNudge("Bash"), loopNudge("Read")]),
    ]);
    expect(ctx.loopSignatures.get("tool:Bash")).toBe(2);
    expect(ctx.loopSignatures.get("tool:Read")).toBe(1);
  });

  it("ignores ordinary user_message content (not a loop nudge)", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [line("user_message", { content: "please read the file" })]),
    ]);
    expect(ctx.loopSignatures.size).toBe(0);
  });
});

describe("loopSignatureOf", () => {
  it("extracts tool:<name> from a nudge and rejects non-nudges", () => {
    expect(loopSignatureOf(`${LOOP_NUDGE_PREFIX} tool "Grep" has been called`)).toBe("tool:Grep");
    expect(loopSignatureOf("hello")).toBeUndefined();
    expect(loopSignatureOf(42)).toBeUndefined();
    expect(loopSignatureOf([{ type: "text" }])).toBeUndefined();
  });
});

describe("ruleFailureTaxonomy", () => {
  it("drafts a validated failure_taxonomy patch from clustered recoveries", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "fail"),
      ]),
    ]);
    const [finding] = ruleFailureTaxonomy(ctx, { spec: CLI_SPEC });
    expect(finding?.suggestion.kind).toBe("spec-patch");
    if (finding?.suggestion.kind === "spec-patch") {
      const p = finding.suggestion.patch;
      expect(p.path).toEqual(["failure_taxonomy"]);
      expect(p.op).toBe("add"); // spec had no taxonomy
      validatePatch(CLI_SPEC, p); // must not throw (OPTIMIZABLE_PATHS)
      const entries = p.value as Array<{ class: string; recovery: string }>;
      expect(entries[0]).toMatchObject({ class: "OverloadedError", recovery: "retry" });
    }
  });

  it("respects the cluster threshold (fewer than min → no finding)", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [recoveryLine("Rare", "retry"), recoveryLine("Rare", "retry")]),
    ]);
    expect(ruleFailureTaxonomy(ctx, { spec: CLI_SPEC })).toEqual([]);
  });

  it("merges with an existing taxonomy and skips already-covered classes", () => {
    const spec = parseSpec(
      [
        "name: hello",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: help",
        "failure_taxonomy:",
        "  - class: OverloadedError",
        "    pattern: overloaded",
        "    recovery: retry",
      ].join("\n"),
    );
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        // Already covered — must be skipped.
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "retry"),
        // New class — must be drafted, appended after the existing entry.
        recoveryLine("TimeoutError", "retry"),
        recoveryLine("TimeoutError", "retry"),
        recoveryLine("TimeoutError", "retry"),
      ]),
    ]);
    const [finding] = ruleFailureTaxonomy(ctx, { spec });
    expect(finding?.suggestion.kind).toBe("spec-patch");
    if (finding?.suggestion.kind === "spec-patch") {
      const p = finding.suggestion.patch;
      expect(p.op).toBe("replace"); // existing array present
      const entries = p.value as Array<{ class: string }>;
      expect(entries.map((e) => e.class)).toEqual(["OverloadedError", "TimeoutError"]);
    }
  });

  it("downgrades to advice text when no spec is available", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "retry"),
      ]),
    ]);
    const [finding] = ruleFailureTaxonomy(ctx, {});
    expect(finding?.suggestion.kind).toBe("advice");
  });

  // F4 — specificity floor: a too-short/generic errorName must NOT draft a
  // verbatim (broad) pattern; it is surfaced as advice instead.
  it("does NOT draft a patch for a too-short errorName (< floor) — advice only", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        recoveryLine("Err", "retry"),
        recoveryLine("Err", "retry"),
        recoveryLine("Err", "retry"),
      ]),
    ]);
    const findings = ruleFailureTaxonomy(ctx, { spec: CLI_SPEC });
    // No spec-patch was drafted from the broad name.
    expect(findings.some((f) => f.suggestion.kind === "spec-patch")).toBe(false);
    const broad = findings.find((f) => f.id === "failure-taxonomy-too-broad");
    expect(broad?.suggestion.kind).toBe("advice");
    if (broad?.suggestion.kind === "advice") {
      expect(broad.suggestion.text).toContain("Err");
      expect(broad.suggestion.text.toLowerCase()).toContain("pattern");
    }
  });

  it('does NOT draft a patch for a generic token errorName (e.g. "Error") — advice only', () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        recoveryLine("Error", "retry"),
        recoveryLine("Error", "retry"),
        recoveryLine("Error", "retry"),
      ]),
    ]);
    const findings = ruleFailureTaxonomy(ctx, { spec: CLI_SPEC });
    expect(findings.some((f) => f.suggestion.kind === "spec-patch")).toBe(false);
    expect(findings.some((f) => f.id === "failure-taxonomy-too-broad")).toBe(true);
  });

  it("still drafts a patch for a specific errorName alongside a skipped broad one", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        // Specific → drafts a patch.
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "retry"),
        // Generic → skipped from the patch, surfaced as advice.
        recoveryLine("fail", "fail"),
        recoveryLine("fail", "fail"),
        recoveryLine("fail", "fail"),
      ]),
    ]);
    const findings = ruleFailureTaxonomy(ctx, { spec: CLI_SPEC });
    const patchFinding = findings.find((f) => f.suggestion.kind === "spec-patch");
    expect(patchFinding).toBeDefined();
    if (patchFinding?.suggestion.kind === "spec-patch") {
      const entries = patchFinding.suggestion.patch.value as Array<{ class: string }>;
      expect(entries.map((e) => e.class)).toEqual(["OverloadedError"]); // "fail" excluded
    }
    expect(findings.some((f) => f.id === "failure-taxonomy-too-broad")).toBe(true);
  });
});

describe("taxonomyPatternTooBroad (F4 specificity floor)", () => {
  it("flags too-short and generic names, passes specific ones", () => {
    expect(taxonomyPatternTooBroad("Err")).toBe(true); // < 4 chars
    expect(taxonomyPatternTooBroad("Error")).toBe(true); // generic token
    expect(taxonomyPatternTooBroad("FAIL")).toBe(true); // generic, case-insensitive
    expect(taxonomyPatternTooBroad("OverloadedError")).toBe(false);
    expect(taxonomyPatternTooBroad("PromptTooLong")).toBe(false);
  });
});

describe("ruleLoopBreak", () => {
  it("drafts instructions ADVICE (never a patch) for recurring loop signatures", () => {
    const ctx = buildAdviceContext([session(SESSION_A, [loopNudge("Bash"), loopNudge("Bash")])]);
    const [finding] = ruleLoopBreak(ctx, { spec: CLI_SPEC });
    expect(finding?.suggestion.kind).toBe("advice");
    if (finding?.suggestion.kind === "advice") {
      expect(finding.suggestion.text).toContain("Bash");
      expect(finding.suggestion.text.toLowerCase()).toContain("loop");
    }
    // A loop is not eligible for failure_taxonomy — nothing patchable here.
    const suggestions = buildSuggestionsFile([finding as AdviceFinding], [SESSION_A], "t");
    expect(suggestions.suggestions).toEqual([]);
  });

  it("respects the loop-signature threshold", () => {
    const ctx = buildAdviceContext([session(SESSION_A, [loopNudge("Bash")])]);
    expect(ruleLoopBreak(ctx, { spec: CLI_SPEC })).toEqual([]);
  });

  it("is wired into runAdviceRules", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "retry"),
        recoveryLine("OverloadedError", "retry"),
        loopNudge("Bash"),
        loopNudge("Bash"),
      ]),
    ]);
    const ids = runAdviceRules(ctx, { spec: CLI_SPEC }).map((f) => f.id);
    expect(ids).toContain("failure-taxonomy-learned");
    expect(ids).toContain("loop-break");
  });
});

// -------- item 21: sub-agent split under chronic context pressure --------

function toolUseLine(id: string, name: string, input: unknown): unknown {
  return line("tool_use", { id, name, input });
}
function toolResultLine(toolUseId: string, content: string): unknown {
  return line("tool_result", { toolUseId, content, isError: false });
}
function compactionLine(): unknown {
  return line("compaction", { kind: "autocompact", before: 40, after: 20 });
}
/** A cli spec has agent.sub_agents; an eval spec does NOT (gating check). */
const EVAL_SPEC = parseSpec(
  [
    "name: e",
    "target: eval",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: judge",
    "dataset:",
    "  name: ds",
    "  version: v1",
    "graders:",
    "  - name: exact_match",
  ].join("\n"),
);

describe("buildAdviceContext — item 21 per-tool bytes", () => {
  it("attributes tool_use input + correlated tool_result bytes to the tool", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [
        toolUseLine("t1", "Bash", { command: "x".repeat(100) }),
        toolResultLine("t1", "y".repeat(200)),
        toolUseLine("t2", "Read", { path: "/a" }),
        toolResultLine("t2", "z".repeat(10)),
        toolResultLine("orphan", "no matching tool_use"), // unattributed → ignored
      ]),
    ]);
    // Bash: input JSON (~115 bytes) + 200 result bytes; Read much smaller.
    const bash = ctx.perToolBytes.get("Bash") ?? 0;
    const read = ctx.perToolBytes.get("Read") ?? 0;
    expect(bash).toBeGreaterThan(300);
    expect(read).toBeGreaterThan(0);
    expect(bash).toBeGreaterThan(read);
    expect(ctx.totalToolBytes).toBe(bash + read);
  });
});

describe("subAgentFragment", () => {
  it("round-trips into a cli spec's agent.sub_agents via parseSpec", () => {
    const frag = subAgentFragment("Bash");
    expect(frag).toContain("sub_agents:"); // the correct key, not `agents:`
    const spec = parseSpec(
      [
        "name: heavy",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: heavy work",
        frag,
      ].join("\n"),
    );
    const specRecord = spec as unknown as {
      agent: { sub_agents?: Record<string, { tools?: string[] }> };
    };
    expect(Object.keys(specRecord.agent.sub_agents ?? {})).toEqual(["bash_worker"]);
    expect(specRecord.agent.sub_agents?.["bash_worker"]?.tools).toEqual(["bash"]);
  });
});

describe("ruleSubAgentSplit", () => {
  const heavyBytes = [
    session(SESSION_A, [
      toolUseLine("t1", "Bash", { command: "x".repeat(40_000) }),
      toolResultLine("t1", "y".repeat(40_000)),
      toolUseLine("t2", "Read", { path: "/a" }),
      toolResultLine("t2", "z".repeat(100)),
    ]),
  ];

  it("fires on tool byte-dominance and emits a pasteable sub_agents fragment (advice-only)", () => {
    const ctx = buildAdviceContext(heavyBytes);
    const [finding] = ruleSubAgentSplit(ctx, { spec: CLI_SPEC });
    expect(finding?.id).toBe("sub-agent-split");
    expect(finding?.suggestion.kind).toBe("advice"); // NEVER a patch
    if (finding?.suggestion.kind === "advice") {
      expect(finding.suggestion.text).toContain("sub_agents:");
      expect(finding.suggestion.text).toContain("NOT `agents:`");
      expect(finding.suggestion.text).toContain("Bash");
    }
    // Structural advice never lands in suggestions.json (report-only).
    const file = buildSuggestionsFile([finding as AdviceFinding], [SESSION_A], "t");
    expect(file.suggestions).toEqual([]);
  });

  it("fires on chronic compaction across multiple sessions", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [compactionLine(), compactionLine(), compactionLine()]),
      session(SESSION_B, [compactionLine(), compactionLine(), compactionLine()]),
    ]);
    const [finding] = ruleSubAgentSplit(ctx, { spec: CLI_SPEC });
    expect(finding?.id).toBe("sub-agent-split");
    expect(finding?.evidence.some((e) => e.includes("compacted"))).toBe(true);
  });

  it("is GATED per target — silent on a target without a sub_agents block (eval)", () => {
    const ctx = buildAdviceContext(heavyBytes);
    expect(ruleSubAgentSplit(ctx, { spec: EVAL_SPEC })).toEqual([]);
  });

  it("is silent with no spec (nowhere to paste the fragment)", () => {
    const ctx = buildAdviceContext(heavyBytes);
    expect(ruleSubAgentSplit(ctx, {})).toEqual([]);
  });

  it("stays silent below the byte-total floor even when one tool dominates", () => {
    const ctx = buildAdviceContext([
      session(SESSION_A, [toolUseLine("t1", "Bash", { command: "x" }), toolResultLine("t1", "y")]),
    ]);
    expect(ruleSubAgentSplit(ctx, { spec: CLI_SPEC })).toEqual([]);
  });
});

// -------- adaptive model routing rules (model_pool scoreboard mining) --------

const POOL_SPEC = parseSpec(
  [
    "name: pooled",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: help",
    "  model_pool:",
    "    candidates:",
    "      - { model: claude-haiku-4-5, tags: [cheap] }",
    "      - { model: claude-sonnet-4-6, tags: [balanced] }",
    "      - { model: claude-opus-4-1, tags: [strong] }",
  ].join("\n"),
);

/** Minimal ArmStats-shaped row for the routing rules. */
function arm(routeKey: string, model: string, n: number, meanReward: number) {
  return {
    routeKey,
    model,
    n,
    meanReward,
    varReward: 0.01,
    meanLatencyMs: 500,
    meanCostUsd: 0.01,
    costCount: n,
  };
}

/** Full-coverage arms: every POOL_SPEC candidate ≥ n in both bands. */
function fullCoverageArms(n: number) {
  return [
    arm("hard", "claude-haiku-4-5", n, 0.3),
    arm("hard", "claude-sonnet-4-6", n, 0.75),
    arm("hard", "claude-opus-4-1", n, 0.8),
    arm("easy", "claude-haiku-4-5", n, 0.85),
    arm("easy", "claude-sonnet-4-6", n, 0.8),
    arm("easy", "claude-opus-4-1", n, 0.4),
  ];
}

describe("rulePoolPolicyUpgrade", () => {
  it("proposes flipping policy to learned when every candidate is past the floor", () => {
    const ctx = buildAdviceContext([], [], fullCoverageArms(30));
    const findings = rulePoolPolicyUpgrade(ctx, { spec: POOL_SPEC });
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f?.id).toBe("pool-policy-upgrade");
    if (f?.suggestion.kind !== "spec-patch") throw new Error("expected a spec-patch suggestion");
    expect(f.suggestion.patch.path).toEqual(["agent", "model_pool", "policy"]);
    expect(f.suggestion.patch.value).toBe("learned");
    // POOL_SPEC omits the policy key (zod-defaulted) → `add`, not `replace`.
    expect(f.suggestion.patch.op).toBe("add");
    // And the patch survives the whitelist — the end-to-end contract.
    expect(() => validatePatch(POOL_SPEC, f.suggestion.patch)).not.toThrow();
  });

  it("uses replace when specHasPath reports the policy key is present", () => {
    const ctx = buildAdviceContext([], [], fullCoverageArms(30));
    const findings = rulePoolPolicyUpgrade(ctx, { spec: POOL_SPEC, specHasPath: () => true });
    if (findings[0]?.suggestion.kind !== "spec-patch") throw new Error("expected patch");
    expect(findings[0].suggestion.patch.op).toBe("replace");
  });

  it("does not fire under the floor, when already learned, or without arms", () => {
    // One candidate short of the floor in BOTH bands → no full-coverage band.
    const partial = fullCoverageArms(30).map((a) =>
      a.model === "claude-opus-4-1" ? { ...a, n: 3 } : a,
    );
    expect(rulePoolPolicyUpgrade(buildAdviceContext([], [], partial), { spec: POOL_SPEC })).toEqual(
      [],
    );
    // Already learned → nothing to upgrade.
    const learnedSpec = parseSpec(
      [
        "name: pooled",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: help",
        "  model_pool:",
        "    policy: learned",
        "    candidates:",
        "      - { model: claude-haiku-4-5 }",
        "      - { model: claude-opus-4-1 }",
      ].join("\n"),
    );
    expect(
      rulePoolPolicyUpgrade(buildAdviceContext([], [], fullCoverageArms(30)), {
        spec: learnedSpec,
      }),
    ).toEqual([]);
    // No arms at all → silent.
    expect(rulePoolPolicyUpgrade(buildAdviceContext([], [], []), { spec: POOL_SPEC })).toEqual([]);
  });

  it("honours the spec's own learning.minSamplesPerArm floor", () => {
    const spec = parseSpec(
      [
        "name: pooled",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: help",
        "  model_pool:",
        "    candidates:",
        "      - { model: claude-haiku-4-5 }",
        "      - { model: claude-sonnet-4-6 }",
        "      - { model: claude-opus-4-1 }",
        "    learning: { minSamplesPerArm: 50 }",
      ].join("\n"),
    );
    // 30 samples clears the default 25 but NOT the spec's 50 → no finding.
    expect(
      rulePoolPolicyUpgrade(buildAdviceContext([], [], fullCoverageArms(30)), { spec }),
    ).toEqual([]);
    expect(
      rulePoolPolicyUpgrade(buildAdviceContext([], [], fullCoverageArms(60)), { spec }),
    ).toHaveLength(1);
  });
});

describe("rulePoolCandidateDemotion", () => {
  it("names a candidate trailing the band best by ≥ the gap in every full band — advice-only", () => {
    const arms = [
      arm("hard", "claude-haiku-4-5", 30, 0.8),
      arm("hard", "claude-sonnet-4-6", 30, 0.75),
      arm("hard", "claude-opus-4-1", 30, 0.4), // trails 0.8 by 0.4
      arm("easy", "claude-haiku-4-5", 30, 0.9),
      arm("easy", "claude-sonnet-4-6", 30, 0.85),
      arm("easy", "claude-opus-4-1", 30, 0.5), // trails 0.9 by 0.4
    ];
    const findings = rulePoolCandidateDemotion(buildAdviceContext([], [], arms), {
      spec: POOL_SPEC,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("pool-candidate-demotion:claude-opus-4-1");
    expect(findings[0]?.suggestion.kind).toBe("advice"); // roster is human-owned
  });

  it("does not fire when the trailing candidate wins somewhere, or for a 2-candidate pool", () => {
    // opus trails hard but WINS easy → not a consistent loser.
    const mixed = [
      arm("hard", "claude-haiku-4-5", 30, 0.8),
      arm("hard", "claude-sonnet-4-6", 30, 0.7),
      arm("hard", "claude-opus-4-1", 30, 0.4),
      arm("easy", "claude-haiku-4-5", 30, 0.5),
      arm("easy", "claude-sonnet-4-6", 30, 0.5),
      arm("easy", "claude-opus-4-1", 30, 0.9),
    ];
    expect(
      rulePoolCandidateDemotion(buildAdviceContext([], [], mixed), { spec: POOL_SPEC }),
    ).toEqual([]);
    // 2-candidate pool → demotion would collapse routing; always silent.
    const twoSpec = parseSpec(
      [
        "name: pooled",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: help",
        "  model_pool:",
        "    candidates:",
        "      - { model: claude-haiku-4-5 }",
        "      - { model: claude-opus-4-1 }",
      ].join("\n"),
    );
    const twoArms = [
      arm("hard", "claude-haiku-4-5", 30, 0.9),
      arm("hard", "claude-opus-4-1", 30, 0.2),
    ];
    expect(
      rulePoolCandidateDemotion(buildAdviceContext([], [], twoArms), { spec: twoSpec }),
    ).toEqual([]);
  });
});

describe("rulePoolStaleExploitation", () => {
  const learnedSpec = (learningYaml: string) =>
    parseSpec(
      [
        "name: pooled",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: help",
        "  model_pool:",
        "    policy: learned",
        "    candidates:",
        "      - { model: claude-haiku-4-5 }",
        "      - { model: claude-sonnet-4-6 }",
        "      - { model: claude-opus-4-1 }",
        ...(learningYaml.length > 0 ? [learningYaml] : []),
      ].join("\n"),
    );

  it("proposes explorationRate 0.05 for a converged learned pool, preserving existing learning fields", () => {
    const spec = learnedSpec("    learning: { minSamplesPerArm: 25, latencyRefMs: 3000 }");
    const findings = rulePoolStaleExploitation(buildAdviceContext([], [], fullCoverageArms(30)), {
      spec,
      specHasPath: (p) => p.join(".") === "agent.model_pool.learning", // learning key present
    });
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f?.id).toBe("pool-stale-exploitation");
    if (f?.suggestion.kind !== "spec-patch") throw new Error("expected a spec-patch suggestion");
    expect(f.suggestion.patch.path).toEqual(["agent", "model_pool", "learning"]);
    expect(f.suggestion.patch.op).toBe("replace"); // key textually present
    // Whole-block replace preserves the spec's other learning fields.
    expect(f.suggestion.patch.value).toEqual({
      minSamplesPerArm: 25,
      latencyRefMs: 3000,
      explorationRate: 0.05,
    });
    expect(() => validatePatch(spec, f.suggestion.patch)).not.toThrow();
  });

  it("uses add when the spec has no learning block", () => {
    const spec = learnedSpec("");
    const findings = rulePoolStaleExploitation(buildAdviceContext([], [], fullCoverageArms(30)), {
      spec, // no specHasPath → assumes absent → add
    });
    if (findings[0]?.suggestion.kind !== "spec-patch") throw new Error("expected patch");
    expect(findings[0].suggestion.patch.op).toBe("add");
    expect(findings[0].suggestion.patch.value).toEqual({ explorationRate: 0.05 });
  });

  it("stays silent when already exploring, when thompson, when warming up, or for non-learned pools", () => {
    const arms = fullCoverageArms(30);
    // ε already set → healthy.
    expect(
      rulePoolStaleExploitation(buildAdviceContext([], [], arms), {
        spec: learnedSpec("    learning: { explorationRate: 0.1 }"),
      }),
    ).toEqual([]);
    // Thompson self-explores.
    expect(
      rulePoolStaleExploitation(buildAdviceContext([], [], arms), {
        spec: learnedSpec("    learning: { bandit: thompson }"),
      }),
    ).toEqual([]);
    // Still warming up (no full-coverage band) — the floor explores for it.
    const partial = arms.map((a) => (a.model === "claude-opus-4-1" ? { ...a, n: 3 } : a));
    expect(
      rulePoolStaleExploitation(buildAdviceContext([], [], partial), { spec: learnedSpec("") }),
    ).toEqual([]);
    // Heuristic pool → not this rule's business (POOL_SPEC defaults to heuristic).
    expect(
      rulePoolStaleExploitation(buildAdviceContext([], [], arms), { spec: POOL_SPEC }),
    ).toEqual([]);
  });
});
