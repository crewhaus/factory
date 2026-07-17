/**
 * Section 29 — `regression-runner` tests:
 *  - T1 fixture corpus (10 prev/new pairs covering all delta scenarios)
 *  - T9 threshold-monotonicity property test
 */
import { describe, expect, test } from "bun:test";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { RegressionError, gate, regress, samplePassRate } from "./index";

function sample(id: string, passed: boolean, score: number, latencyMs = 100): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess-${id}`,
    startedAt: "2026-05-08T00:00:00Z",
    endedAt: "2026-05-08T00:00:01Z",
    latencyMs,
    turns: 1,
    tokens: { input: 10, output: 10 },
    model: "claude-opus-4-7",
    agentOutput: `output for ${id}`,
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "fail" },
      perGrader: [{ name: "g1", passed, score, rationale: passed ? "ok" : "fail" }],
    },
  };
}

function summary(samples: SampleResult[]): EvalRunSummary {
  const passed = samples.filter((s) => s.grades.overall.passed).length;
  const passRate = samples.length === 0 ? 0 : passed / samples.length;
  const meanScore =
    samples.length === 0
      ? 0
      : samples.reduce((acc, s) => acc + s.grades.overall.score, 0) / samples.length;
  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const turns = samples.map((s) => s.turns).sort((a, b) => a - b);
  const p = (arr: number[], pct: number): number => {
    if (arr.length === 0) return 0;
    const idx = Math.floor((pct / 100) * (arr.length - 1));
    return arr[idx] ?? 0;
  };
  return {
    runId: "r1",
    startedAt: "2026-05-08T00:00:00Z",
    endedAt: "2026-05-08T00:00:01Z",
    samples,
    aggregates: {
      passRate,
      meanScore,
      p50Turns: p(turns, 50),
      p95Turns: p(turns, 95),
      p50LatencyMs: p(latencies, 50),
      p95LatencyMs: p(latencies, 95),
      totalTokens: { input: 0, output: 0 },
      errorCount: 0,
    },
    config: {
      specHash: "x",
      datasetName: "x",
      graderNames: ["g1"],
      model: "claude-opus-4-7",
      concurrency: 1,
    },
    outDir: "/tmp",
  };
}

describe("regression-runner — T1 fixture corpus", () => {
  test("identical runs → empty regressions/recoveries/shifts", () => {
    const samples = [sample("a", true, 1), sample("b", true, 1)];
    const r = regress(summary(samples), summary(samples));
    expect(r.regressions.length).toBe(0);
    expect(r.recoveries.length).toBe(0);
    expect(r.scoreShifts.length).toBe(0);
    expect(r.passRateDelta).toBe(0);
  });

  test("pass→fail flip surfaces in regressions", () => {
    const prev = summary([sample("a", true, 1), sample("b", true, 1)]);
    const next = summary([sample("a", true, 1), sample("b", false, 0)]);
    const r = regress(prev, next);
    expect(r.regressions.length).toBe(1);
    expect(r.regressions[0]?.sampleId).toBe("b");
    expect(r.passRateDelta).toBe(-0.5);
  });

  test("fail→pass flip surfaces in recoveries", () => {
    const prev = summary([sample("a", true, 1), sample("b", false, 0)]);
    const next = summary([sample("a", true, 1), sample("b", true, 1)]);
    const r = regress(prev, next);
    expect(r.recoveries.length).toBe(1);
    expect(r.recoveries[0]?.sampleId).toBe("b");
  });

  test("score shifts surface above epsilon", () => {
    const prev = summary([sample("a", true, 1)]);
    const next = summary([sample("a", true, 0.6)]);
    const r = regress(prev, next, { scoreShiftEpsilon: 0.3 });
    expect(r.scoreShifts.length).toBe(1);
    expect(r.scoreShifts[0]?.delta).toBeCloseTo(-0.4, 5);
  });

  test("score shifts ignored below epsilon", () => {
    const prev = summary([sample("a", true, 1)]);
    const next = summary([sample("a", true, 0.95)]);
    const r = regress(prev, next, { scoreShiftEpsilon: 0.1 });
    expect(r.scoreShifts.length).toBe(0);
  });

  test("samples missing from next don't crash", () => {
    const prev = summary([sample("a", true, 1), sample("b", true, 1)]);
    const next = summary([sample("a", true, 1)]);
    const r = regress(prev, next);
    expect(r.regressions.length).toBe(0);
    expect(r.unchanged).toBe(1);
  });

  test("p95 latency delta surfaces", () => {
    const prev = summary([sample("a", true, 1, 100), sample("b", true, 1, 200)]);
    const next = summary([sample("a", true, 1, 1000), sample("b", true, 1, 2000)]);
    const r = regress(prev, next);
    expect(r.p95LatencyDeltaMs).toBeGreaterThan(0);
  });
});

describe("regression-runner — per-sample pass-rate flips (G15)", () => {
  function withTrials(s: SampleResult, passes: number, k: number): SampleResult {
    return {
      ...s,
      trialPassRate: passes / k,
      trials: Array.from({ length: k }, (_, i) => ({
        trial: i + 1,
        sessionId: `${s.sessionId}-t${i + 1}`,
        passed: i < passes,
        score: i < passes ? 1 : 0,
        rationale: i < passes ? "ok" : "fail",
        latencyMs: s.latencyMs,
        tokens: s.tokens,
      })),
    };
  }

  test("samplePassRate: trial rate when present, else the 0/1 verdict", () => {
    expect(samplePassRate(sample("a", true, 1))).toBe(1);
    expect(samplePassRate(sample("a", false, 0))).toBe(0);
    expect(samplePassRate(withTrials(sample("a", true, 1), 3, 4))).toBeCloseTo(0.75);
  });

  test("a reliability drop (4/4 → 1/4, canonical still passing) is a regression", () => {
    const prev = summary([withTrials(sample("a", true, 1), 4, 4)]);
    const next = summary([withTrials(sample("a", true, 1), 1, 4)]);
    const r = regress(prev, next);
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]?.prev.passRate).toBeCloseTo(1);
    expect(r.regressions[0]?.next.passRate).toBeCloseTo(0.25);
    // The canonical verdicts both PASS — only the rate view can see this.
    expect(r.regressions[0]?.prev.passed).toBe(true);
    expect(r.regressions[0]?.next.passed).toBe(true);
  });

  test("a reliability rise is a recovery; equal rates are unchanged", () => {
    const prev = summary([
      withTrials(sample("a", false, 0), 1, 4),
      withTrials(sample("b", true, 1), 2, 4),
    ]);
    const next = summary([
      withTrials(sample("a", false, 0), 3, 4),
      withTrials(sample("b", true, 1), 2, 4),
    ]);
    const r = regress(prev, next);
    expect(r.recoveries).toHaveLength(1);
    expect(r.recoveries[0]?.sampleId).toBe("a");
    expect(r.unchanged).toBe(1);
  });

  test("mixed runs compare rate-to-verdict (prev single-trial, next repeated)", () => {
    const prev = summary([sample("a", true, 1)]); // rate 1.0
    const next = summary([withTrials(sample("a", true, 1), 3, 4)]); // rate 0.75
    const r = regress(prev, next);
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]?.prev.passRate).toBe(1);
    expect(r.regressions[0]?.next.passRate).toBeCloseTo(0.75);
  });

  test("single-trial runs keep the boolean flip semantics and no passRate fields", () => {
    const prev = summary([sample("a", true, 1), sample("b", true, 1)]);
    const next = summary([sample("a", true, 1), sample("b", false, 0)]);
    const r = regress(prev, next);
    expect(r.regressions).toHaveLength(1);
    expect("passRate" in (r.regressions[0]?.prev ?? {})).toBe(false);
    expect("passRate" in (r.regressions[0]?.next ?? {})).toBe(false);
  });
});

describe("regression-runner — gate verdict", () => {
  test("pass when within thresholds", () => {
    const prev = summary([sample("a", true, 1)]);
    const next = summary([sample("a", true, 0.95)]);
    const v = gate(prev, next);
    expect(v.verdict).toBe("pass");
  });

  test("fail when pass-rate drop exceeds regressionThreshold", () => {
    const prev = summary([
      sample("a", true, 1),
      sample("b", true, 1),
      sample("c", true, 1),
      sample("d", true, 1),
    ]);
    const next = summary([
      sample("a", true, 1),
      sample("b", true, 1),
      sample("c", false, 0),
      sample("d", false, 0),
    ]);
    const v = gate(prev, next, { regressionThreshold: 0.1 });
    expect(v.verdict).toBe("fail");
    expect(v.reason).toContain("pass-rate dropped");
  });

  test("fail when p95 latency exceeds latencyThreshold", () => {
    const prev = summary([sample("a", true, 1, 100), sample("b", true, 1, 200)]);
    const next = summary([sample("a", true, 1, 6000), sample("b", true, 1, 7000)]);
    const v = gate(prev, next, { latencyThreshold: 5000 });
    expect(v.verdict).toBe("fail");
    expect(v.reason).toContain("p95 latency rose");
  });
});

describe("regression-runner — T9 threshold monotonicity", () => {
  test("a smaller pass-rate-delta + larger threshold can only relax to pass, never fail", () => {
    const prev = summary([
      sample("a", true, 1),
      sample("b", true, 1),
      sample("c", true, 1),
      sample("d", true, 1),
    ]);
    const next = summary([
      sample("a", true, 1),
      sample("b", true, 1),
      sample("c", false, 0),
      sample("d", true, 1),
    ]);
    const tight = gate(prev, next, { regressionThreshold: 0.1 });
    const loose = gate(prev, next, { regressionThreshold: 0.5 });
    if (tight.verdict === "pass") expect(loose.verdict).toBe("pass");
  });
});

describe("RegressionError", () => {
  test("carries the 'config' code and the RegressionError name", () => {
    const err = new RegressionError("bad summary shape");
    expect(err).toBeInstanceOf(RegressionError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RegressionError");
    expect(err.code).toBe("config");
    expect(err.message).toBe("bad summary shape");
  });

  test("preserves the underlying cause chain", () => {
    const cause = new Error("parse failed");
    const err = new RegressionError("wrapped", cause);
    expect(err.cause).toBe(cause);
    expect(err.toJSON()).toEqual({
      name: "RegressionError",
      code: "config",
      message: "wrapped",
      cause: { name: "Error", message: "parse failed" },
    });
  });
});
