import { describe, expect, test } from "bun:test";
import {
  type LoadDriver,
  LoadtestError,
  type RequestOutcome,
  aggregateLoadtest,
  evaluateGate,
  renderLoadtestHtml,
  renderLoadtestText,
  runLoadtest,
} from "./loadtest";

/** A deterministic driver: latency = base + idx (so percentiles are stable),
 *  every Kth request fails with `errorKind`. */
function stubDriver(opts: {
  baseMs: number;
  failEvery?: number;
  errorKind?: string;
  tokens?: { input: number; output: number };
}): LoadDriver {
  return async (idx: number): Promise<RequestOutcome> => {
    const fail = opts.failEvery !== undefined && idx > 0 && idx % opts.failEvery === 0;
    if (fail) {
      return { ok: false, latencyMs: opts.baseMs, errorKind: opts.errorKind ?? "429" };
    }
    return {
      ok: true,
      latencyMs: opts.baseMs + idx,
      ...(opts.tokens !== undefined ? { tokens: opts.tokens } : {}),
    };
  };
}

/** A fake monotonic clock advanced explicitly for deterministic wall-clock. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("runLoadtest (#68)", () => {
  test("drives the injected driver for the request budget + aggregates", async () => {
    const report = await runLoadtest(stubDriver({ baseMs: 10 }), {
      concurrency: 4,
      requests: 20,
    });
    expect(report.requests).toBe(20);
    expect(report.succeeded).toBe(20);
    expect(report.failed).toBe(0);
    expect(report.errorRate).toBe(0);
    expect(report.latency.min).toBeGreaterThanOrEqual(10);
    expect(report.latency.max).toBeGreaterThanOrEqual(report.latency.p50);
  });

  test("records failures + error-kind breakdown", async () => {
    const report = await runLoadtest(stubDriver({ baseMs: 5, failEvery: 4, errorKind: "429" }), {
      concurrency: 2,
      requests: 20,
    });
    expect(report.failed).toBeGreaterThan(0);
    expect(report.errorRate).toBeCloseTo(report.failed / 20, 5);
    expect(report.errorKinds["429"]).toBe(report.failed);
  });

  test("a thrown driver is recorded as an errored request, not a crash", async () => {
    let calls = 0;
    const flaky: LoadDriver = async () => {
      calls += 1;
      if (calls === 2) throw new Error("boom");
      return { ok: true, latencyMs: 1 };
    };
    const report = await runLoadtest(flaky, { concurrency: 1, requests: 3 });
    expect(report.requests).toBe(3);
    expect(report.failed).toBe(1);
  });

  test("computes cost/req from token usage + pricing", async () => {
    const report = await runLoadtest(
      stubDriver({ baseMs: 1, tokens: { input: 100, output: 50 } }),
      {
        concurrency: 1,
        requests: 10,
        pricePerMInput: 3, // $3 / 1M input tokens
        pricePerMOutput: 15, // $15 / 1M output tokens
      },
    );
    // per req: (100/1e6)*3 + (50/1e6)*15 = 0.0003 + 0.00075 = 0.00105
    expect(report.costPerReqUsd).toBeCloseTo(0.00105, 8);
    expect(report.totalCostUsd).toBeCloseTo(0.0105, 8);
  });

  test("wall-clock + throughput use the injected clock", async () => {
    const clock = fakeClock();
    // Each request advances the clock via the driver so the run has a
    // deterministic wall time.
    const driver: LoadDriver = async () => {
      clock.advance(10);
      return { ok: true, latencyMs: 10 };
    };
    const report = await runLoadtest(driver, {
      concurrency: 1,
      requests: 5,
      now: clock.now,
    });
    expect(report.wallClockMs).toBe(50);
    expect(report.throughputRps).toBeCloseTo(100, 1); // 5 req / 0.05s
  });

  test("rejects requests < 1", async () => {
    await expect(runLoadtest(stubDriver({ baseMs: 1 }), { requests: 0 })).rejects.toThrow(
      LoadtestError,
    );
  });
});

describe("aggregateLoadtest percentiles (#68)", () => {
  test("nearest-rank percentiles over successful latencies", () => {
    const outcomes: RequestOutcome[] = Array.from({ length: 100 }, (_, i) => ({
      ok: true,
      latencyMs: i + 1, // 1..100
    }));
    const report = aggregateLoadtest(outcomes, { wallClockMs: 1000 });
    expect(report.latency.p50).toBe(50);
    expect(report.latency.p95).toBe(95);
    expect(report.latency.p99).toBe(99);
    expect(report.latency.min).toBe(1);
    expect(report.latency.max).toBe(100);
  });
});

describe("evaluateGate (#68)", () => {
  const report = aggregateLoadtest(
    [
      { ok: true, latencyMs: 100 },
      { ok: true, latencyMs: 200 },
      { ok: false, latencyMs: 0, errorKind: "500" },
    ],
    { wallClockMs: 300 },
  );

  test("passes when within thresholds", () => {
    const v = evaluateGate(report, { maxP95LatencyMs: 500, maxErrorRate: 0.5 });
    expect(v.passed).toBe(true);
    expect(v.breaches).toHaveLength(0);
  });

  test("fails + lists breaches when exceeded", () => {
    const v = evaluateGate(report, { maxP95LatencyMs: 50, maxErrorRate: 0.1 });
    expect(v.passed).toBe(false);
    expect(v.breaches.join(" ")).toContain("p95 latency");
    expect(v.breaches.join(" ")).toContain("error rate");
  });

  test("empty thresholds always pass", () => {
    expect(evaluateGate(report, {}).passed).toBe(true);
  });
});

describe("renderers (#68)", () => {
  const report = aggregateLoadtest(
    [
      { ok: true, latencyMs: 10, tokens: { input: 5, output: 5 } },
      { ok: false, latencyMs: 0, errorKind: "429" },
    ],
    { wallClockMs: 100 },
  );

  test("text render includes latency + gate verdict", () => {
    const out = renderLoadtestText(report, { passed: false, breaches: ["p95 latency 10ms > 5ms"] });
    expect(out).toContain("loadtest:");
    expect(out).toContain("p95");
    expect(out).toContain("gate:        FAIL");
    expect(out).toContain("429×1");
  });

  test("html render is self-contained", () => {
    const html = renderLoadtestHtml(report, { passed: true, breaches: [] });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Loadtest report");
    expect(html).toContain("PASS");
  });
});
