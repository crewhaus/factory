import { describe, expect, test } from "bun:test";
import type { JustificationJudge } from "@crewhaus/permission-engine";
import type { SessionEvents } from "./advise-rules";
import {
  type JustificationRecord,
  buildToolOutcomes,
  calibrateJustification,
  extractJustificationRecords,
  preflightJustification,
  proposeThreshold,
  renderCalibrationLines,
} from "./justification-calibrate";

/** A durable justification audit record envelope. */
function auditRec(
  toolName: string,
  verdict: "allow" | "deny",
  confidence: number | undefined,
  justification = "fetch the requested data for the user's report",
  judgeModel = "rule-based",
): unknown {
  return {
    kind: "permission_justification_evaluated",
    payload: {
      toolName,
      justification,
      verdict,
      reason: "because",
      judgeModel,
      ...(confidence !== undefined ? { confidence } : {}),
    },
  };
}

/** A session with N tool_stats lines for `toolName`, `errors` of them errored. */
function sessionWithToolStats(
  sessionId: string,
  toolName: string,
  calls: number,
  errors: number,
): SessionEvents {
  const objects: unknown[] = [];
  for (let i = 0; i < calls; i++) {
    objects.push({
      kind: "tool_stats",
      payload: { toolName, isError: i < errors, durationMs: 10 },
    });
  }
  return { sessionId, objects };
}

describe("extractJustificationRecords", () => {
  test("extracts valid records; skips malformed / other kinds", () => {
    const recs = extractJustificationRecords([
      auditRec("Fetch", "allow", 0.8),
      auditRec("Bash", "deny", 0.7),
      { kind: "egress_decision", payload: {} },
      { kind: "permission_justification_evaluated" }, // no payload
      { kind: "permission_justification_evaluated", payload: { toolName: "X" } }, // no verdict
      null,
    ]);
    expect(recs.length).toBe(2);
    expect(recs[0]).toMatchObject({ toolName: "Fetch", verdict: "allow", confidence: 0.8 });
    expect(recs[1]).toMatchObject({ toolName: "Bash", verdict: "deny", confidence: 0.7 });
  });
});

describe("buildToolOutcomes", () => {
  test("folds tool_stats into per-tool { calls, errors }", () => {
    const outcomes = buildToolOutcomes([
      sessionWithToolStats("sess_a", "Fetch", 5, 1),
      sessionWithToolStats("sess_b", "Fetch", 3, 0),
    ]);
    expect(outcomes.get("Fetch")).toEqual({ calls: 8, errors: 1 });
  });
});

describe("proposeThreshold", () => {
  test("returns 0.5 when there is no contrast (all good or all bad)", () => {
    expect(proposeThreshold([{ confidence: 0.9, outcomeBad: false }])).toBe(0.5);
    expect(proposeThreshold([])).toBe(0.5);
  });

  test("finds a separating cut: good allows high-confidence, bad allows low", () => {
    const samples = [
      { confidence: 0.9, outcomeBad: false },
      { confidence: 0.85, outcomeBad: false },
      { confidence: 0.2, outcomeBad: true },
      { confidence: 0.3, outcomeBad: true },
    ];
    const thr = proposeThreshold(samples);
    // The boundary should sit between 0.3 and 0.85.
    expect(thr).toBeGreaterThan(0.3);
    expect(thr).toBeLessThanOrEqual(0.85);
  });
});

describe("calibrateJustification", () => {
  test("classifies an allowed-but-erroring tool as over-allow (high disagreement)", () => {
    const records: JustificationRecord[] = [
      {
        toolName: "Bash",
        justification: "run the thing",
        verdict: "allow",
        judgeModel: "rule-based",
        confidence: 0.9,
      },
      {
        toolName: "Bash",
        justification: "run again",
        verdict: "allow",
        judgeModel: "rule-based",
        confidence: 0.85,
      },
    ];
    // Bash errored on 4/5 actual calls → over-allow.
    const outcomes = buildToolOutcomes([sessionWithToolStats("s", "Bash", 5, 4)]);
    const result = calibrateJustification(records, outcomes);
    const bash = result.perTool.find((t) => t.toolName === "Bash");
    expect(bash?.allowAgreement).toBe("over-allow");
    expect(result.highDisagreementTools).toContain("Bash");
    expect(result.allowAgreementRate).toBe(0); // the only trusted-allow tool disagrees
  });

  test("classifies an allowed-and-succeeding tool as agree", () => {
    const records: JustificationRecord[] = [
      {
        toolName: "Fetch",
        justification: "get data",
        verdict: "allow",
        judgeModel: "rule-based",
        confidence: 0.9,
      },
    ];
    const outcomes = buildToolOutcomes([sessionWithToolStats("s", "Fetch", 5, 0)]);
    const result = calibrateJustification(records, outcomes);
    expect(result.perTool[0]?.allowAgreement).toBe("agree");
    expect(result.allowAgreementRate).toBe(1);
  });

  test("unknown when there are too few observed calls to trust the outcome", () => {
    const records: JustificationRecord[] = [
      {
        toolName: "Rare",
        justification: "do it",
        verdict: "allow",
        judgeModel: "rule-based",
        confidence: 0.9,
      },
    ];
    const outcomes = buildToolOutcomes([sessionWithToolStats("s", "Rare", 1, 1)]); // 1 < minCalls
    const result = calibrateJustification(records, outcomes);
    expect(result.perTool[0]?.allowAgreement).toBe("unknown");
    expect(result.allowAgreementRate).toBeNull();
  });

  test("estimates false-block rate from low-confidence denies", () => {
    const records: JustificationRecord[] = [
      // Two denies: one high-confidence, one low.
      {
        toolName: "A",
        justification: "x",
        verdict: "deny",
        judgeModel: "rule-based",
        confidence: 0.9,
      },
      {
        toolName: "B",
        justification: "y",
        verdict: "deny",
        judgeModel: "rule-based",
        confidence: 0.1,
      },
      // An allowing tool that errored, to force a threshold above 0.1.
      {
        toolName: "C",
        justification: "z",
        verdict: "allow",
        judgeModel: "rule-based",
        confidence: 0.9,
      },
      {
        toolName: "C",
        justification: "z2",
        verdict: "allow",
        judgeModel: "rule-based",
        confidence: 0.2,
      },
    ];
    const outcomes = buildToolOutcomes([sessionWithToolStats("s", "C", 4, 3)]);
    const result = calibrateJustification(records, outcomes);
    // With a threshold learned above 0.1, the 0.1 deny counts as a possible
    // false block → estimatedFalseBlockRate > 0.
    expect(result.estimatedFalseBlockRate).not.toBeNull();
    expect(result.estimatedFalseBlockRate as number).toBeGreaterThan(0);
  });

  test("empty history → all-null aggregates, default threshold", () => {
    const result = calibrateJustification([], new Map());
    expect(result.evaluated).toBe(0);
    expect(result.denyRate).toBeNull();
    expect(result.allowAgreementRate).toBeNull();
    expect(result.proposedThreshold).toBe(0.5);
  });
});

describe("preflightJustification", () => {
  test("replays the rule-based judge and reports flips vs stored verdict", async () => {
    const records: JustificationRecord[] = [
      // Too-brief justification → rule-based denies (< 16 chars).
      { toolName: "A", justification: "short", verdict: "allow", judgeModel: "rule-based" },
      // Long + overlapping with the goal → rule-based allows.
      {
        toolName: "B",
        justification: "fetch the sales report data for the user",
        verdict: "allow",
        judgeModel: "rule-based",
      },
    ];
    const r = await preflightJustification(records, "fetch the sales report data");
    // A flips allow→deny (too brief); B stays allow.
    expect(r.sampled).toBe(2);
    expect(r.flips.length).toBe(1);
    expect(r.flips[0]).toEqual({ toolName: "A", stored: "allow", replayed: "deny" });
    expect(r.degraded).toBe(false);
  });

  test("degraded flag set when no session goal is supplied", async () => {
    const records: JustificationRecord[] = [
      {
        toolName: "A",
        justification: "a sufficiently long justification here",
        verdict: "allow",
        judgeModel: "rule-based",
      },
    ];
    const r = await preflightJustification(records, "");
    expect(r.degraded).toBe(true);
  });

  test("accepts a custom (injected) judge — no credentials required", async () => {
    const alwaysDeny: JustificationJudge = () => ({
      allow: false,
      reason: "test judge",
      judgeModel: "test",
    });
    const records: JustificationRecord[] = [
      { toolName: "A", justification: "whatever", verdict: "allow", judgeModel: "rule-based" },
    ];
    const r = await preflightJustification(records, "goal", alwaysDeny);
    expect(r.wouldDeny).toBe(1);
    expect(r.flips.length).toBe(1);
  });
});

describe("renderCalibrationLines", () => {
  test("renders aggregate + per-tool lines with the proxy caveat", () => {
    const records: JustificationRecord[] = [
      {
        toolName: "Bash",
        justification: "run",
        verdict: "allow",
        judgeModel: "rule-based",
        confidence: 0.9,
      },
    ];
    const outcomes = buildToolOutcomes([sessionWithToolStats("s", "Bash", 5, 4)]);
    const lines = renderCalibrationLines(calibrateJustification(records, outcomes)).join("\n");
    expect(lines).toContain("proposed confidence threshold");
    expect(lines).toContain("Bash");
    expect(lines).toContain("PER-TOOL proxy");
  });
});
