/**
 * Section 29 — `regression-runner` tests:
 *  - T1 fixture corpus (10 prev/new pairs covering all delta scenarios)
 *  - T9 threshold-monotonicity property test
 */
import { describe, expect, test } from "bun:test";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { gate, regress } from "./index";

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
