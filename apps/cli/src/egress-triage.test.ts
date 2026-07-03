import { describe, expect, test } from "bun:test";
import type { Spec } from "@crewhaus/spec";
import {
  buildEgressTriageContext,
  formatEgressFindingLines,
  ruleJustificationJudgeUpgrade,
  ruleSemanticMatcher,
  ruleSinkRelaxation,
  runEgressTriage,
} from "./egress-triage";

/** A durable egress_decision audit record, as the runtime writer emits it. */
function egressRecord(
  sinkId: string,
  verdict: "warn" | "block",
  origins: string[],
  sinkScope = "external-configured",
): unknown {
  return {
    kind: "egress_decision",
    payload: { sinkId, sinkScope, verdict, originsFound: origins, matchCount: origins.length },
  };
}

/** A rule-based justification record. */
function justRecord(verdict: "allow" | "deny", judgeModel = "rule-based"): unknown {
  return {
    kind: "permission_justification_evaluated",
    payload: { toolName: "fetch", verdict, judgeModel },
  };
}

/** A minimal cli spec (no security block) for patch-validation tests. */
function cliSpec(security?: Record<string, unknown>): Spec {
  return {
    target: "cli",
    agent: { model: "claude-haiku-4-5", instructions: "do the thing" },
    ...(security !== undefined ? { security } : {}),
  } as unknown as Spec;
}

describe("buildEgressTriageContext", () => {
  test("clusters egress records per sink; tolerant of malformed/other kinds", () => {
    const ctx = buildEgressTriageContext([
      egressRecord("fetch", "warn", ["subagent"]),
      egressRecord("fetch", "warn", ["subagent"]),
      egressRecord("fetch", "block", ["mcp"]),
      egressRecord("mcp__slack__send", "warn", ["channel"], "external-dynamic"),
      justRecord("deny"),
      justRecord("allow"),
      null,
      { kind: "egress_decision" }, // no payload → skipped
      { kind: "egress_decision", payload: { verdict: "pass" } }, // pass never durable → skipped
      "garbage",
    ]);
    expect(ctx.egressRecords).toBe(4);
    expect(ctx.totalWarned).toBe(3);
    expect(ctx.totalBlocked).toBe(1);
    expect(ctx.ruleBasedDenials).toBe(1);
    expect(ctx.ruleBasedEvaluated).toBe(2);
    // fetch cluster ranks first (it has the block).
    expect(ctx.clusters[0]?.sinkId).toBe("fetch");
    expect(ctx.clusters[0]).toEqual({
      sinkId: "fetch",
      sinkScope: "external-configured",
      origins: ["mcp", "subagent"],
      warned: 2,
      blocked: 1,
      total: 3,
    });
  });

  test("only rule-based justification records count toward denials", () => {
    const ctx = buildEgressTriageContext([
      justRecord("deny", "rule-based"),
      justRecord("deny", "claude-haiku-4-5"), // not rule-based → ignored
    ]);
    expect(ctx.ruleBasedDenials).toBe(1);
    expect(ctx.ruleBasedEvaluated).toBe(1);
  });
});

describe("ruleSinkRelaxation", () => {
  test("proposes advice (never a patch) for a chronic warn-only sink", () => {
    const records = Array.from({ length: 6 }, () => egressRecord("fetch", "warn", ["subagent"]));
    const ctx = buildEgressTriageContext(records);
    const findings = ruleSinkRelaxation(ctx, { spec: cliSpec() });
    expect(findings.length).toBe(1);
    expect(findings[0]?.id).toBe("egress-relax:fetch");
    // Never a patch: egressPolicy is reserved and not in the schema.
    expect(findings[0]?.suggestion.kind).toBe("advice");
    if (findings[0]?.suggestion.kind === "advice") {
      expect(findings[0].suggestion.text).toContain("security.egressPolicy");
    }
  });

  test("never relaxes a sink that also blocked", () => {
    const records = [
      ...Array.from({ length: 6 }, () => egressRecord("fetch", "warn", ["subagent"])),
      egressRecord("fetch", "block", ["subagent"]),
    ];
    const ctx = buildEgressTriageContext(records);
    expect(ruleSinkRelaxation(ctx)).toEqual([]);
  });

  test("below threshold → silent", () => {
    const records = Array.from({ length: 3 }, () => egressRecord("fetch", "warn", ["subagent"]));
    const ctx = buildEgressTriageContext(records);
    expect(ruleSinkRelaxation(ctx)).toEqual([]);
  });
});

describe("ruleSemanticMatcher", () => {
  test("proposes semantic (advice) when warn-noise is high and blocks are zero", () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      egressRecord(`sink${i % 3}`, "warn", ["subagent"]),
    );
    const ctx = buildEgressTriageContext(records);
    const findings = ruleSemanticMatcher(ctx, { spec: cliSpec() });
    expect(findings.length).toBe(1);
    expect(findings[0]?.id).toBe("egress-matcher-semantic");
    expect(findings[0]?.suggestion.kind).toBe("advice"); // never optimizer-whitelisted
  });

  test("silent when any block occurred (real blocks → don't loosen matching)", () => {
    const records = [
      ...Array.from({ length: 12 }, () => egressRecord("fetch", "warn", ["subagent"])),
      egressRecord("fetch", "block", ["subagent"]),
    ];
    const ctx = buildEgressTriageContext(records);
    expect(ruleSemanticMatcher(ctx)).toEqual([]);
  });

  test("silent when the spec already selects semantic", () => {
    const records = Array.from({ length: 12 }, () => egressRecord("fetch", "warn", ["subagent"]));
    const ctx = buildEgressTriageContext(records);
    expect(ruleSemanticMatcher(ctx, { spec: cliSpec({ egressMatcher: "semantic" }) })).toEqual([]);
  });
});

describe("ruleJustificationJudgeUpgrade", () => {
  test("emits a VALIDATED spec-patch on a cli spec (rides optimize --from-advice)", () => {
    const records = Array.from({ length: 5 }, () => justRecord("deny"));
    const ctx = buildEgressTriageContext(records);
    const findings = ruleJustificationJudgeUpgrade(ctx, { spec: cliSpec() });
    expect(findings.length).toBe(1);
    expect(findings[0]?.suggestion.kind).toBe("spec-patch");
    if (findings[0]?.suggestion.kind === "spec-patch") {
      const p = findings[0].suggestion.patch;
      expect(p.path).toEqual(["security", "justification"]);
      expect(p.op).toBe("add");
      expect(p.value).toEqual({ judge: "claude" });
    }
  });

  test("preserves an existing model when upgrading judge (replace op)", () => {
    const records = Array.from({ length: 5 }, () => justRecord("deny"));
    const ctx = buildEgressTriageContext(records);
    const findings = ruleJustificationJudgeUpgrade(ctx, {
      spec: cliSpec({ justification: { judge: "rule-based", model: "claude-haiku-4-5" } }),
    });
    expect(findings[0]?.suggestion.kind).toBe("spec-patch");
    if (findings[0]?.suggestion.kind === "spec-patch") {
      expect(findings[0].suggestion.patch.op).toBe("replace");
      expect(findings[0].suggestion.patch.value).toEqual({
        judge: "claude",
        model: "claude-haiku-4-5",
      });
    }
  });

  test("degrades to advice when there is no spec", () => {
    const records = Array.from({ length: 5 }, () => justRecord("deny"));
    const ctx = buildEgressTriageContext(records);
    const findings = ruleJustificationJudgeUpgrade(ctx);
    expect(findings[0]?.suggestion.kind).toBe("advice");
  });

  test("silent when the spec already uses the claude judge", () => {
    const records = Array.from({ length: 5 }, () => justRecord("deny"));
    const ctx = buildEgressTriageContext(records);
    expect(
      ruleJustificationJudgeUpgrade(ctx, { spec: cliSpec({ justification: { judge: "claude" } }) }),
    ).toEqual([]);
  });

  test("below threshold → silent", () => {
    const records = Array.from({ length: 2 }, () => justRecord("deny"));
    const ctx = buildEgressTriageContext(records);
    expect(ruleJustificationJudgeUpgrade(ctx)).toEqual([]);
  });
});

describe("runEgressTriage + formatting", () => {
  test("runs all rules and ranks warn before info", () => {
    const records = [
      ...Array.from({ length: 6 }, () => egressRecord("fetch", "warn", ["subagent"])),
      ...Array.from({ length: 5 }, () => justRecord("deny")),
    ];
    const ctx = buildEgressTriageContext(records);
    const findings = runEgressTriage(ctx, { spec: cliSpec() });
    // warn-severity judge upgrade + semantic (warn) before the info relaxation.
    expect(findings.map((f) => f.severity)[0]).toBe("warn");
    expect(findings.some((f) => f.id === "egress-relax:fetch")).toBe(true);
    expect(findings.some((f) => f.id === "justification-judge-upgrade")).toBe(true);
    // formatting renders a patch line for the whitelisted upgrade.
    const upgrade = findings.find((f) => f.id === "justification-judge-upgrade");
    if (upgrade !== undefined) {
      const lines = formatEgressFindingLines(upgrade);
      expect(lines.some((l) => l.startsWith("  patch: "))).toBe(true);
    }
  });

  test("healthy history → no findings", () => {
    const ctx = buildEgressTriageContext([egressRecord("fetch", "warn", ["subagent"])]);
    expect(runEgressTriage(ctx, { spec: cliSpec() })).toEqual([]);
  });
});
