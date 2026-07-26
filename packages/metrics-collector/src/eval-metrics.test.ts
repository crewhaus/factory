/**
 * E51 / NEW-E-2 — evaluation quality reaches the metrics sinks.
 *
 * Two paths: the ONLINE fold (in-loop `eval_graded`, `judge_verdict`,
 * `response_rated`, plus the eval runner's per-sample `test_verdict`) and the
 * OFFLINE run summary (`recordEvalRunSummary`).
 */
import { describe, expect, test } from "bun:test";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { recordEvalRunSummary } from "./eval-run";
import { EventToMetrics } from "./handlers";
import { Gauge, Registry } from "./registry";

const env = (overrides: Record<string, unknown> = {}) =>
  ({
    runId: "run_a",
    sessionId: "sess_1",
    turnNumber: 1,
    traceId: `${"0".repeat(31)}1`,
    spanId: `${"0".repeat(15)}1`,
    timestamp: "2026-07-26T12:00:00.000Z",
    ...overrides,
  }) as unknown as TraceEvent;

const seriesOf = (
  series: ReadonlyArray<{ labels: Record<string, string>; value: number }>,
  match: Record<string, string>,
) => series.find((s) => Object.entries(match).every(([k, v]) => s.labels[k] === v))?.value;

describe("in-loop quality fold", () => {
  test("eval_graded increments the verdict counter and the score histogram", () => {
    const registry = new Registry();
    const dispatch = new EventToMetrics(registry);
    dispatch.handle({
      ...env(),
      kind: "eval_graded",
      score: 0.9,
      threshold: 0.7,
      verdict: "pass",
      graderType: "llm_judge",
      retryIndex: 0,
    } as TraceEvent);
    dispatch.handle({
      ...env(),
      kind: "eval_graded",
      score: 0.1,
      threshold: 0.7,
      verdict: "fail",
      graderType: "llm_judge",
      retryIndex: 1,
    } as TraceEvent);
    expect(
      seriesOf(registry.evalVerdictsTotal.series(), { source: "in_loop", verdict: "pass" }),
    ).toBe(1);
    expect(
      seriesOf(registry.evalVerdictsTotal.series(), { source: "in_loop", verdict: "fail" }),
    ).toBe(1);
    const scores = registry.evalScore
      .series()
      .find((s) => s.labels["source"] === "in_loop" && s.labels["grader"] === "llm_judge");
    expect(scores?.total).toBe(2);
    expect(scores?.sum).toBeCloseTo(1.0, 10);
  });

  test("a rogue non-finite / out-of-range score is clamped, never NaN", () => {
    const registry = new Registry();
    const dispatch = new EventToMetrics(registry);
    dispatch.handle({
      ...env(),
      kind: "eval_graded",
      score: Number.NaN,
      threshold: 1,
      verdict: "fail",
      graderType: "contains",
      retryIndex: 0,
    } as TraceEvent);
    dispatch.handle({
      ...env(),
      kind: "eval_graded",
      score: 7,
      threshold: 1,
      verdict: "pass",
      graderType: "contains",
      retryIndex: 0,
    } as TraceEvent);
    const s = registry.evalScore.series().find((x) => x.labels["grader"] === "contains");
    expect(s?.sum).toBe(1);
    expect(Number.isNaN(s?.sum ?? Number.NaN)).toBe(false);
  });

  test("judge_verdict folds under its own source label", () => {
    const registry = new Registry();
    new EventToMetrics(registry).handle({
      ...env(),
      kind: "judge_verdict",
      stepOrNode: "gate",
      verdict: "fail",
      score: 0.25,
    } as TraceEvent);
    expect(
      seriesOf(registry.evalVerdictsTotal.series(), { source: "judge_step", verdict: "fail" }),
    ).toBe(1);
    expect(
      registry.evalScore.series().find((s) => s.labels["source"] === "judge_step")?.sum,
    ).toBeCloseTo(0.25, 10);
  });

  test("test_verdict counts offline per-sample outcomes including skip/error", () => {
    const registry = new Registry();
    const dispatch = new EventToMetrics(registry);
    for (const verdict of ["pass", "fail", "skip", "error"] as const) {
      dispatch.handle({
        ...env(),
        kind: "test_verdict",
        testId: `s-${verdict}`,
        verdict,
        durationMs: 5,
      } as TraceEvent);
    }
    for (const verdict of ["pass", "fail", "skip", "error"]) {
      expect(
        seriesOf(registry.evalVerdictsTotal.series(), { source: "eval_sample", verdict }),
      ).toBe(1);
    }
  });

  test("response_rated counts thumbs and folds an in-range numeric rating", () => {
    const registry = new Registry();
    const dispatch = new EventToMetrics(registry);
    dispatch.handle({
      ...env(),
      kind: "response_rated",
      rating: "up",
      source: "cli",
    } as TraceEvent);
    dispatch.handle({ ...env(), kind: "response_rated", rating: 0.75 } as TraceEvent);
    dispatch.handle({ ...env(), kind: "response_rated", rating: 4 } as TraceEvent);
    expect(seriesOf(registry.responseRatingsTotal.series(), { rating: "up", source: "cli" })).toBe(
      1,
    );
    expect(seriesOf(registry.responseRatingsTotal.series(), { rating: "4" })).toBe(1);
    const human = registry.evalScore.series().find((s) => s.labels["source"] === "human_rating");
    // The out-of-range 1-5 rating is counted but NOT silently rescaled.
    expect(human?.total).toBe(1);
    expect(human?.sum).toBeCloseTo(0.75, 10);
  });

  test("unrelated events still leave the eval instruments empty (no accidental fold)", () => {
    const registry = new Registry();
    new EventToMetrics(registry).handle({
      ...env(),
      kind: "turn_end",
      turn: 1,
      durationMs: 1000,
    } as TraceEvent);
    expect(registry.evalVerdictsTotal.series()).toHaveLength(0);
    expect(registry.evalScore.series()).toHaveLength(0);
  });
});

describe("Gauge", () => {
  test("last write wins per label set and non-finite values are dropped", () => {
    const g = new Gauge("g", "help");
    g.set(0.5, { a: "1" });
    g.set(0.9, { a: "1" });
    g.set(0.1, { a: "2" });
    g.set(Number.NaN, { a: "3" });
    expect(g.series()).toHaveLength(2);
    expect(seriesOf(g.series(), { a: "1" })).toBe(0.9);
    expect(g.prometheus()).toContain("# TYPE g gauge");
    expect(g.prometheus()).toContain('g{a="1"} 0.9');
  });
});

describe("recordEvalRunSummary", () => {
  const labels = { spec: "support", dataset: "golden" };

  test("writes every headline figure and counts the run", () => {
    const registry = new Registry();
    recordEvalRunSummary(registry, {
      specName: "support",
      datasetName: "golden",
      passRate: 0.8,
      meanScore: 0.72,
      sampleCount: 25,
      errorCount: 1,
      flakyCount: 3,
      needsHumanCount: 2,
      costUsd: 0.1234,
    });
    expect(seriesOf(registry.evalRunsTotal.series(), labels)).toBe(1);
    expect(seriesOf(registry.evalRunPassRate.series(), labels)).toBe(0.8);
    expect(seriesOf(registry.evalRunMeanScore.series(), labels)).toBe(0.72);
    expect(seriesOf(registry.evalRunSamples.series(), labels)).toBe(25);
    expect(seriesOf(registry.evalRunErrors.series(), labels)).toBe(1);
    expect(seriesOf(registry.evalRunFlakySamples.series(), labels)).toBe(3);
    expect(seriesOf(registry.evalRunNeedsHuman.series(), labels)).toBe(2);
    expect(seriesOf(registry.evalRunCostUsdMicros.series(), labels)).toBe(123_400);
  });

  test("absent flake/needs-human record as 0; an unpriced run writes no cost gauge", () => {
    const registry = new Registry();
    recordEvalRunSummary(registry, {
      specName: "support",
      datasetName: "golden",
      passRate: 1,
      meanScore: 1,
      sampleCount: 4,
      errorCount: 0,
    });
    expect(seriesOf(registry.evalRunFlakySamples.series(), labels)).toBe(0);
    expect(seriesOf(registry.evalRunNeedsHuman.series(), labels)).toBe(0);
    expect(registry.evalRunCostUsdMicros.series()).toHaveLength(0);
  });

  test("a second run of the same (spec, dataset) overwrites the gauges and bumps the counter", () => {
    const registry = new Registry();
    const base = {
      specName: "support",
      datasetName: "golden",
      meanScore: 0.5,
      sampleCount: 4,
      errorCount: 0,
    };
    recordEvalRunSummary(registry, { ...base, passRate: 0.5 });
    recordEvalRunSummary(registry, { ...base, passRate: 0.75 });
    expect(seriesOf(registry.evalRunsTotal.series(), labels)).toBe(2);
    expect(seriesOf(registry.evalRunPassRate.series(), labels)).toBe(0.75);
  });

  test("the summary reaches the exposition formats the sinks serialize", () => {
    const registry = new Registry();
    recordEvalRunSummary(registry, {
      specName: "support",
      datasetName: "golden",
      passRate: 0.8,
      meanScore: 0.72,
      sampleCount: 25,
      errorCount: 1,
    });
    const prom = registry.prometheus();
    expect(prom).toContain("# TYPE crewhaus_eval_run_pass_rate gauge");
    expect(prom).toContain('crewhaus_eval_run_pass_rate{dataset="golden",spec="support"} 0.8');
    const json = registry.jsonSnapshot();
    expect(json.gauges["crewhaus_eval_run_pass_rate"]?.[0]?.value).toBe(0.8);
    expect(json.counters["crewhaus_eval_runs_total"]?.[0]?.value).toBe(1);
  });
});
