/**
 * Coverage tests for `attachDefaultSubscribers` and `logFlushError`
 * (observability.ts). Drives the cost-tracker / cost-inline / flushAll /
 * shutdownAll branches deterministically by:
 *   - mocking the metrics-collector + otel-exporter attach helpers so their
 *     `flush`/`shutdown` resolve or reject under test control (NO real
 *     network sinks, NO leaked handles), and
 *   - publishing real `cost_accrual` events through a real TraceEventBus to
 *     exercise the inline-cost stdout handler.
 *
 * The mock.module replacements are reinstalled to the REAL modules in
 * afterAll — `mock.restore()` (run in afterEach for the spies) does not undo
 * `mock.module`, and Bun shares one module registry across all test files in
 * nondeterministic order, so without that re-mock the fakes would leak into
 * the rest of the runtime-core suite.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
// Real modules captured for the afterAll restore — as plain-object SNAPSHOTS:
// an `import * as` namespace is a live view that resolves to the fakes once
// mock.module patches the module, so restoring from it would be a no-op.
import * as realMetricsCollectorNS from "@crewhaus/metrics-collector";
import * as realOtelExporterNS from "@crewhaus/otel-exporter";
import { createRunContext } from "@crewhaus/run-context";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import type { CostAccrualEvent } from "@crewhaus/trace-event-bus";

const realMetricsCollectorSnapshot = { ...realMetricsCollectorNS };
const realOtelExporterSnapshot = { ...realOtelExporterNS };

// Controllable fakes for the two heavyweight subscribers. The booleans let
// each test decide whether flush()/shutdown() reject so the catch → logFlushError
// branches (102, 105, 113-114) are reachable without real I/O.
const metricsState = {
  flushRejects: false,
  shutdownRejects: false,
  flushCalls: 0,
  shutdownCalls: 0,
  unsubscribeCalls: 0,
  attached: true,
};
const otelState = {
  flushRejects: false,
  shutdownRejects: false,
  flushCalls: 0,
  shutdownCalls: 0,
  unsubscribeCalls: 0,
  attached: true,
};

function resetState(): void {
  for (const s of [metricsState, otelState]) {
    s.flushRejects = false;
    s.shutdownRejects = false;
    s.flushCalls = 0;
    s.shutdownCalls = 0;
    s.unsubscribeCalls = 0;
    s.attached = true;
  }
}

beforeEach(() => {
  resetState();
  mock.module("@crewhaus/metrics-collector", () => ({
    attachIfEnvSet: async () =>
      metricsState.attached
        ? {
            registry: {},
            unsubscribe: () => {
              metricsState.unsubscribeCalls += 1;
            },
            flush: async () => {
              metricsState.flushCalls += 1;
              if (metricsState.flushRejects) throw new Error("metrics flush boom");
            },
            shutdown: async () => {
              metricsState.shutdownCalls += 1;
              if (metricsState.shutdownRejects) throw new Error("metrics shutdown boom");
            },
          }
        : undefined,
  }));
  mock.module("@crewhaus/otel-exporter", () => ({
    attachIfEnvSet: () =>
      otelState.attached
        ? {
            unsubscribe: () => {
              otelState.unsubscribeCalls += 1;
            },
            flush: async () => {
              otelState.flushCalls += 1;
              if (otelState.flushRejects) throw new Error("otel flush boom");
            },
            shutdown: async () => {
              otelState.shutdownCalls += 1;
              if (otelState.shutdownRejects) throw new Error("otel shutdown boom");
            },
          }
        : undefined,
  }));
});

afterEach(() => {
  mock.restore();
});

afterAll(() => {
  // Reinstall the real modules — mock.restore() only undoes spies, not
  // mock.module, so without these the fakes leak into sibling test files.
  mock.module("@crewhaus/metrics-collector", () => realMetricsCollectorSnapshot);
  mock.module("@crewhaus/otel-exporter", () => realOtelExporterSnapshot);
});

function makeAccrual(overrides: Partial<CostAccrualEvent> = {}): CostAccrualEvent {
  return {
    kind: "cost_accrual",
    traceId: "trace_a",
    runId: "run_a",
    sessionId: "sess_0000000000000001",
    timestamp: 0,
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    inputTokens: 2_000,
    outputTokens: 500,
    cachedReadTokens: 0,
    costUsdMicros: 4_200,
    ...overrides,
  } as CostAccrualEvent;
}

describe("attachDefaultSubscribers — cost tracking + inline cost line", () => {
  test("cost tracker is created with tenantId when CREWHAUS_TENANT_ID is set", async () => {
    const { attachDefaultSubscribers } = await import("./observability");
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    const subs = await attachDefaultSubscribers(bus, ctx, {
      CREWHAUS_COST_TRACKING: "1",
      CREWHAUS_TENANT_ID: "tenant-xyz",
    });
    // The cost tracker exists (lines 67-74 — including the tenantId spread).
    expect(subs.costTracker).toBeDefined();
    await subs.flushAll();
    await subs.shutdownAll();
  });

  test("cost tracker is created without tenantId when the env var is absent", async () => {
    const { attachDefaultSubscribers } = await import("./observability");
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    const subs = await attachDefaultSubscribers(bus, ctx, {
      CREWHAUS_COST_TRACKING: "true",
    });
    expect(subs.costTracker).toBeDefined();
    await subs.shutdownAll();
  });

  test("inline cost handler prints one line per cost_accrual and ignores other events", async () => {
    const { attachDefaultSubscribers } = await import("./observability");
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    const writes: string[] = [];
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const subs = await attachDefaultSubscribers(bus, ctx, {
        CREWHAUS_COST_TRACKING: "1",
        CREWHAUS_COST_INLINE: "1",
      });
      expect(subs.costInlineUnsubscribe).toBeDefined();

      // A non-cost event must hit the early `return` (line 85) → no write.
      bus.publish({ ...bus.envelope(), kind: "turn_start", turn: 1, messageCount: 0 });
      const beforeCost = writes.length;
      // A cost_accrual event triggers the inline line (lines 86-88).
      bus.publish(makeAccrual({ costUsdMicros: 4_200 }));
      const costLines = writes.filter((w) => w.includes("💸"));
      expect(costLines.length).toBe(1);
      expect(costLines[0]).toContain("$0.0042");
      expect(beforeCost).toBe(0); // turn_start wrote nothing

      // Unsubscribe stops further inline lines.
      subs.costInlineUnsubscribe?.();
      bus.publish(makeAccrual({ costUsdMicros: 9_999 }));
      expect(writes.filter((w) => w.includes("💸")).length).toBe(1);
      await subs.shutdownAll();
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("inline cost is NOT enabled when CREWHAUS_COST_TRACKING is missing", async () => {
    const { attachDefaultSubscribers } = await import("./observability");
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    // COST_INLINE set but no COST_TRACKING → costTracker undefined → inline off.
    const subs = await attachDefaultSubscribers(bus, ctx, { CREWHAUS_COST_INLINE: "1" });
    expect(subs.costTracker).toBeUndefined();
    expect(subs.costInlineUnsubscribe).toBeUndefined();
    await subs.shutdownAll();
  });
});

describe("attachDefaultSubscribers — flushAll / shutdownAll error handling", () => {
  test("flushAll flushes metrics + otel + bus and tolerates rejections (logFlushError)", async () => {
    const { attachDefaultSubscribers } = await import("./observability");
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    const errSpy = spyOn(ctx.logger, "error");

    metricsState.flushRejects = true;
    otelState.flushRejects = true;
    // Both subscribers attached (their attach helpers are mocked to return
    // truthy objects). bus.flush is also exercised; force it to reject too so
    // the bus-flush catch arm (logFlushError "bus") runs.
    const busFlushSpy = spyOn(bus, "flush").mockImplementation(async () => {
      throw new Error("bus flush boom");
    });

    const subs = await attachDefaultSubscribers(bus, ctx, {
      CREWHAUS_METRICS: "stdout",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    });
    // Should resolve despite all three flush paths rejecting.
    await subs.flushAll();

    expect(metricsState.flushCalls).toBe(1);
    expect(otelState.flushCalls).toBe(1);
    expect(busFlushSpy).toHaveBeenCalled();
    // logFlushError logged once per failing surface (metrics, otel, bus).
    const flushFailedLogs = errSpy.mock.calls.filter((c) => c[0] === "observability.flush_failed");
    expect(flushFailedLogs.length).toBe(3);
    busFlushSpy.mockRestore();
  });

  test("shutdownAll awaits metrics + otel shutdown and tolerates rejections", async () => {
    const { attachDefaultSubscribers } = await import("./observability");
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    const errSpy = spyOn(ctx.logger, "error");

    metricsState.shutdownRejects = true;
    otelState.shutdownRejects = true;

    const subs = await attachDefaultSubscribers(bus, ctx, {
      CREWHAUS_METRICS: "stdout",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      CREWHAUS_COST_TRACKING: "1",
      CREWHAUS_COST_INLINE: "1",
    });
    await subs.shutdownAll();

    // Both shutdowns ran (lines 101-106), both failures logged (113-114),
    // and the cost tracker + inline subscription were torn down (107-108).
    expect(metricsState.shutdownCalls).toBe(1);
    expect(otelState.shutdownCalls).toBe(1);
    const shutdownFailedLogs = errSpy.mock.calls.filter(
      (c) => c[0] === "observability.flush_failed",
    );
    expect(shutdownFailedLogs.length).toBe(2);
  });

  test("logFlushError stringifies a non-Error rejection value", async () => {
    const { attachDefaultSubscribers } = await import("./observability");
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    const errSpy = spyOn(ctx.logger, "error");

    // Reject with a plain string (not an Error) so the `String(err)` branch
    // of logFlushError (line 114) is exercised. Use Promise.reject rather than
    // `throw "literal"` to avoid the throw-literal lint while still rejecting
    // with a non-Error value.
    const busFlushSpy = spyOn(bus, "flush").mockImplementation(() =>
      Promise.reject("plain-string-failure"),
    );

    const subs = await attachDefaultSubscribers(bus, ctx, {});
    await subs.flushAll();

    const log = errSpy.mock.calls.find((c) => c[0] === "observability.flush_failed");
    expect(log).toBeDefined();
    expect((log?.[1] as { message: string }).message).toBe("plain-string-failure");
    busFlushSpy.mockRestore();
  });

  test("flushAll with no subscribers attached only flushes the bus", async () => {
    const { attachDefaultSubscribers } = await import("./observability");
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const ctx = createRunContext();
    // No env → metrics/otel attach helpers (mocked) still return objects, so
    // flip `attached` off to model the genuine no-subscriber case (the `if`
    // guards on lines 93-95 / 101-106 skip their bodies).
    metricsState.attached = false;
    otelState.attached = false;
    const subs = await attachDefaultSubscribers(bus, ctx, {});
    expect(subs.metrics).toBeUndefined();
    expect(subs.otel).toBeUndefined();
    await subs.flushAll();
    await subs.shutdownAll();
    expect(metricsState.flushCalls).toBe(0);
    expect(otelState.flushCalls).toBe(0);
  });
});
