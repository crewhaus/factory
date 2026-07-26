/**
 * E51 — offline eval results reach the configured exporters.
 *
 * Everything rides the injectable `attach` seam (no `mock.module`, no process
 * globals): a stub `attachDefaultSubscribers` returns a fake subscriber set
 * whose bus events and metrics registry are inspectable, so the three
 * contracts — presence gating, emission, and never-fail-the-run — are
 * assertable without an OTLP endpoint or a real collector.
 */
import { describe, expect, test } from "bun:test";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import type { createRunContext } from "@crewhaus/run-context";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import {
  attachEvalTelemetry,
  evalRunSummaryMetrics,
  evalTelemetryConfigured,
} from "./eval-telemetry";

/**
 * A structural stand-in for `@crewhaus/metrics-collector`'s `Registry`,
 * carrying only the eval instruments this module writes. Built here rather
 * than imported because `apps/cli` deliberately has NO direct dependency on
 * metrics-collector — the registry reaches the CLI through the attach
 * result's type, which is exactly the coupling this test should exercise.
 * (The real Registry's own behaviour is covered in its package tests.)
 */
type FakeSeries = { labels: Record<string, string>; value: number };
type FakeInstrument = {
  inc(labels?: Record<string, string>, by?: number): void;
  set(value: number, labels?: Record<string, string>): void;
  series(): ReadonlyArray<FakeSeries>;
};
function fakeInstrument(): FakeInstrument {
  const values = new Map<string, FakeSeries>();
  const key = (l: Record<string, string>) =>
    Object.keys(l)
      .sort()
      .map((k) => `${k}=${l[k]}`)
      .join(",");
  return {
    inc(labels = {}, by = 1) {
      const k = key(labels);
      const existing = values.get(k);
      if (existing) existing.value += by;
      else values.set(k, { labels: { ...labels }, value: by });
    },
    set(value, labels = {}) {
      values.set(key(labels), { labels: { ...labels }, value });
    },
    series: () => Array.from(values.values()),
  };
}
function fakeRegistry() {
  return {
    evalRunsTotal: fakeInstrument(),
    evalRunPassRate: fakeInstrument(),
    evalRunMeanScore: fakeInstrument(),
    evalRunSamples: fakeInstrument(),
    evalRunErrors: fakeInstrument(),
    evalRunFlakySamples: fakeInstrument(),
    evalRunNeedsHuman: fakeInstrument(),
    evalRunCostUsdMicros: fakeInstrument(),
  };
}

type StubOptions = {
  readonly registry?: ReturnType<typeof fakeRegistry>;
  readonly flushThrows?: boolean;
  readonly shutdownThrows?: boolean;
  readonly attachThrows?: boolean;
};

/** A stub `attachDefaultSubscribers` capturing the bus events it observes. */
function stubAttach(opts: StubOptions = {}) {
  const seen: TraceEvent[] = [];
  const envSeen: NodeJS.ProcessEnv[] = [];
  const registry = opts.registry ?? fakeRegistry();
  let flushed = 0;
  let shutdown = 0;
  const attach = (async (
    bus: { subscribe: (fn: (e: TraceEvent) => void) => () => void },
    _ctx: unknown,
    env: NodeJS.ProcessEnv,
  ) => {
    envSeen.push(env);
    if (opts.attachThrows === true) throw new Error("collector unreachable");
    bus.subscribe((e) => seen.push(e));
    return {
      printer: undefined,
      metrics: { registry, unsubscribe: () => {}, flush: async () => {}, shutdown: async () => {} },
      otel: undefined,
      costTracker: undefined,
      costInlineUnsubscribe: undefined,
      securityTally: undefined,
      flushAll: async () => {
        flushed += 1;
        if (opts.flushThrows === true) throw new Error("OTLP POST failed: 503");
      },
      shutdownAll: async () => {
        shutdown += 1;
        if (opts.shutdownThrows === true) throw new Error("socket already closed");
      },
    };
  }) as unknown as Parameters<typeof attachEvalTelemetry>[0] extends undefined
    ? never
    : NonNullable<Parameters<typeof attachEvalTelemetry>[0]>["attach"];
  return {
    attach,
    seen,
    envSeen,
    registry,
    counts: () => ({ flushed, shutdown }),
  };
}

const OTLP_ENV = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" };

function sample(id: string, over: Record<string, unknown> = {}) {
  return {
    sampleId: id,
    sessionId: `sess-${id}`,
    startedAt: "2026-07-26T00:00:00.000Z",
    endedAt: "2026-07-26T00:00:01.000Z",
    latencyMs: 1234,
    turns: 1,
    tokens: { input: 10, output: 5 },
    model: "m",
    agentOutput: "answer",
    grades: { overall: { passed: true, score: 1 }, perGrader: [] },
    ...over,
  };
}

function summaryOf(over: Record<string, unknown> = {}): EvalRunSummary {
  return {
    runId: "run_1",
    startedAt: "2026-07-26T00:00:00.000Z",
    endedAt: "2026-07-26T00:00:10.000Z",
    samples: [sample("s1")],
    aggregates: {
      passRate: 1,
      meanScore: 1,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 1,
      p95LatencyMs: 1,
      totalTokens: { input: 10, output: 5 },
      errorCount: 0,
    },
    config: {
      specHash: "abc",
      datasetName: "golden",
      graderNames: ["exact_match"],
      model: "m",
      concurrency: 1,
    },
    ...over,
  } as unknown as EvalRunSummary;
}

describe("presence gate", () => {
  test("no exporter env ⇒ no telemetry object at all (zero overhead)", async () => {
    expect(evalTelemetryConfigured({})).toBe(false);
    expect(evalTelemetryConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " })).toBe(false);
    expect(evalTelemetryConfigured({ CREWHAUS_METRICS: "" })).toBe(false);
    const stub = stubAttach();
    const telemetry = await attachEvalTelemetry({ env: {}, attach: stub.attach });
    expect(telemetry).toBeUndefined();
    // The attach seam was never even reached.
    expect(stub.envSeen).toHaveLength(0);
  });

  test("either exporter env is enough", () => {
    expect(evalTelemetryConfigured(OTLP_ENV)).toBe(true);
    expect(evalTelemetryConfigured({ CREWHAUS_METRICS: "stdout" })).toBe(true);
  });

  test("only exporter-relevant env is forwarded — a trace/printer opt-in never leaks in", async () => {
    const stub = stubAttach();
    const telemetry = await attachEvalTelemetry({
      env: {
        ...OTLP_ENV,
        OTEL_SERVICE_NAME: "evals",
        CREWHAUS_METRICS: "stdout",
        CREWHAUS_TRACE: "pretty",
        CREWHAUS_COST_INLINE: "1",
        CREWHAUS_ALERTS: "1",
        CREWHAUS_SECURITY_DIGEST: "1",
        PATH: "/usr/bin",
      },
      attach: stub.attach,
    });
    expect(telemetry).toBeDefined();
    expect(Object.keys(stub.envSeen[0] ?? {}).sort()).toEqual([
      "CREWHAUS_METRICS",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_SERVICE_NAME",
    ]);
    await telemetry?.finish();
  });
});

describe("emission", () => {
  test("every graded sample becomes a test_verdict on the live run bus", async () => {
    const stub = stubAttach();
    const telemetry = await attachEvalTelemetry({ env: OTLP_ENV, attach: stub.attach });
    telemetry?.publishSampleVerdicts(
      summaryOf({
        samples: [
          sample("pass-1"),
          sample("fail-1", {
            grades: {
              overall: { passed: false, score: 0.2, rationale: "off topic" },
              perGrader: [],
            },
          }),
          sample("abstained-1", {
            grades: { overall: { passed: false, score: 0, abstained: true }, perGrader: [] },
          }),
          sample("errored-1", { error: "provider timeout" }),
        ],
      }),
    );
    const verdicts = stub.seen.filter(
      (e): e is Extract<TraceEvent, { kind: "test_verdict" }> => e.kind === "test_verdict",
    );
    expect(verdicts.map((v) => [v.testId, v.verdict])).toEqual([
      ["pass-1", "pass"],
      ["fail-1", "fail"],
      ["abstained-1", "skip"],
      ["errored-1", "error"],
    ]);
    expect(verdicts[1]?.reason).toBe("off topic");
    expect(verdicts[0]?.durationMs).toBe(1234);
    await telemetry?.finish();
  });

  test("each verdict carries its SAMPLE's session id, under one run-level trace", async () => {
    const stub = stubAttach();
    const telemetry = await attachEvalTelemetry({ env: OTLP_ENV, attach: stub.attach });
    telemetry?.publishSampleVerdicts(summaryOf({ samples: [sample("s1"), sample("s2")] }));
    const verdicts = stub.seen.filter(
      (e): e is Extract<TraceEvent, { kind: "test_verdict" }> => e.kind === "test_verdict",
    );
    // Without this, all N verdicts land under the CLI's synthetic run-level
    // session id — which matches nothing a backend has seen — and a failing
    // verdict cannot be joined to the transcript it grades except by
    // string-matching the test id.
    expect(verdicts.map((v) => v.sessionId)).toEqual(["sess-s1", "sess-s2"]);
    // …while the run stays ONE trace: run/trace ids are run-level.
    expect(new Set(verdicts.map((v) => v.traceId)).size).toBe(1);
    expect(verdicts[0]?.runId).toBe(telemetry?.runContext.runId);
    await telemetry?.finish();
  });

  test("the run summary lands on the metrics registry the sinks serialize", async () => {
    const stub = stubAttach();
    const telemetry = await attachEvalTelemetry({ env: OTLP_ENV, attach: stub.attach });
    telemetry?.recordRunSummary({
      specName: "support",
      datasetName: "golden",
      passRate: 0.8,
      meanScore: 0.7,
      sampleCount: 10,
      errorCount: 1,
      flakyCount: 2,
      needsHumanCount: 3,
      costUsd: 0.5,
    });
    const labelled = (series: ReadonlyArray<FakeSeries>) =>
      series.find((s) => s.labels["spec"] === "support" && s.labels["dataset"] === "golden")?.value;
    expect(labelled(stub.registry.evalRunPassRate.series())).toBe(0.8);
    expect(labelled(stub.registry.evalRunMeanScore.series())).toBe(0.7);
    expect(labelled(stub.registry.evalRunSamples.series())).toBe(10);
    expect(labelled(stub.registry.evalRunErrors.series())).toBe(1);
    expect(labelled(stub.registry.evalRunFlakySamples.series())).toBe(2);
    expect(labelled(stub.registry.evalRunNeedsHuman.series())).toBe(3);
    expect(labelled(stub.registry.evalRunCostUsdMicros.series())).toBe(500_000);
    expect(labelled(stub.registry.evalRunsTotal.series())).toBe(1);
    await telemetry?.finish();
  });

  test("flush happens AFTER the last verdict (the E51 bug: verdicts on a dead bus)", async () => {
    const stub = stubAttach();
    const telemetry = await attachEvalTelemetry({ env: OTLP_ENV, attach: stub.attach });
    expect(stub.counts().flushed).toBe(0);
    telemetry?.publishSampleVerdicts(summaryOf());
    expect(stub.seen.some((e) => e.kind === "test_verdict")).toBe(true);
    expect(stub.counts().flushed).toBe(0);
    await telemetry?.finish();
    expect(stub.counts()).toEqual({ flushed: 1, shutdown: 1 });
  });

  test("evalRunSummaryMetrics projects the aggregates, presence-gating the optional buckets", () => {
    const bare = evalRunSummaryMetrics(summaryOf(), { specName: "support" });
    expect(bare).toEqual({
      specName: "support",
      datasetName: "golden",
      passRate: 1,
      meanScore: 1,
      sampleCount: 1,
      errorCount: 0,
    });
    const rich = evalRunSummaryMetrics(
      summaryOf({
        aggregates: {
          ...summaryOf().aggregates,
          flaky: 2,
          needsHuman: 1,
        },
      }),
      { specName: "support", costUsd: 0.25 },
    );
    expect(rich.flakyCount).toBe(2);
    expect(rich.needsHumanCount).toBe(1);
    expect(rich.costUsd).toBe(0.25);
  });
});

describe("never fails the run", () => {
  test("an attach that throws disables telemetry and warns — it does not propagate", async () => {
    const warnings: string[] = [];
    const stub = stubAttach({ attachThrows: true });
    const telemetry = await attachEvalTelemetry({
      env: OTLP_ENV,
      attach: stub.attach,
      warn: (l) => warnings.push(l),
    });
    expect(telemetry).toBeUndefined();
    expect(warnings[0]).toContain("[eval] telemetry disabled: collector unreachable");
  });

  test("a throwing flush and shutdown are both reported and swallowed", async () => {
    const warnings: string[] = [];
    const stub = stubAttach({ flushThrows: true, shutdownThrows: true });
    const telemetry = await attachEvalTelemetry({
      env: OTLP_ENV,
      attach: stub.attach,
      warn: (l) => warnings.push(l),
    });
    telemetry?.publishSampleVerdicts(summaryOf());
    await telemetry?.finish();
    expect(warnings.join("\n")).toContain("telemetry flush failed: OTLP POST failed: 503");
    // Shutdown still runs even though flush threw.
    expect(warnings.join("\n")).toContain("telemetry shutdown failed: socket already closed");
    expect(stub.counts()).toEqual({ flushed: 1, shutdown: 1 });
  });

  test("a subscriber that throws on publish does not escape publishSampleVerdicts", async () => {
    const warnings: string[] = [];
    // A real bus swallows subscriber errors; this asserts the CLI-side guard
    // by making the PUBLISH itself throw (a bus in a broken state).
    const attach = (async (bus: { subscribe: (fn: (e: TraceEvent) => void) => () => void }) => {
      bus.subscribe(() => {});
      return {
        printer: undefined,
        metrics: undefined,
        otel: undefined,
        costTracker: undefined,
        costInlineUnsubscribe: undefined,
        securityTally: undefined,
        flushAll: async () => {},
        shutdownAll: async () => {},
      };
    }) as never;
    const telemetry = await attachEvalTelemetry({
      env: OTLP_ENV,
      attach,
      warn: (l) => warnings.push(l),
    });
    expect(telemetry).toBeDefined();
    const ctx = telemetry?.runContext as ReturnType<typeof createRunContext>;
    (ctx.eventBus as unknown as { publish: () => void }).publish = () => {
      throw new Error("bus closed");
    };
    expect(() => telemetry?.publishSampleVerdicts(summaryOf())).not.toThrow();
    expect(warnings.join("\n")).toContain("telemetry verdict publish failed: bus closed");
    // A missing metrics registry (OTLP-only config) is a silent no-op, not a throw.
    expect(() =>
      telemetry?.recordRunSummary({
        specName: "s",
        datasetName: "d",
        passRate: 1,
        meanScore: 1,
        sampleCount: 1,
        errorCount: 0,
      }),
    ).not.toThrow();
    await telemetry?.finish();
  });
});
