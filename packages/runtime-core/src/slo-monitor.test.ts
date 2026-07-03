/**
 * Ops item 37 — tests for the production-signal SLO monitor: the rolling-window
 * accumulator, breach detection over declared targets, the sustained-breach
 * mitigation ladder (with an injected deployment-controller-style rollback +
 * pause-intake sink), the one-shot-per-rung guard, and the env+spec gate. No
 * real model / network / timers (an injected scheduler drives evaluation).
 */
import { describe, expect, test } from "bun:test";
import { createRunContext } from "@crewhaus/run-context";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import {
  type SloMitigationEvent,
  type SloTargets,
  SloWindow,
  attachSloMonitor,
  detectSloBreaches,
} from "./slo-monitor";

const BASE = Date.parse("2026-07-02T00:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

/** Build a bare TraceEvent with an explicit timestamp for windowing control. */
function ev(
  partial: Partial<TraceEvent> & { kind: TraceEvent["kind"] },
  offsetMs: number,
): TraceEvent {
  return {
    runId: "run_a",
    sessionId: "sess_0000000000000001",
    turnNumber: 1,
    traceId: "t".repeat(32),
    spanId: "s".repeat(16),
    timestamp: iso(offsetMs),
    ...partial,
  } as TraceEvent;
}

// ---------- SloWindow folding + evaluate ----------

describe("SloWindow — rolling window", () => {
  test("TTFT p95 is derived from model_request → first model_stream_token", () => {
    const w = new SloWindow(60_000);
    // Five requests each with a 1500ms TTFT.
    for (let i = 0; i < 5; i += 1) {
      const traceId = `trace${i}`.padEnd(32, "0");
      w.fold(ev({ kind: "model_request", traceId } as Partial<TraceEvent>, i * 10));
      w.fold(
        ev(
          {
            kind: "model_stream_token",
            traceId,
            chunkIndex: 0,
            deltaChars: 3,
          } as Partial<TraceEvent>,
          i * 10 + 1500,
        ),
      );
      w.fold(ev({ kind: "model_response", traceId } as Partial<TraceEvent>, i * 10 + 3000));
    }
    const m = w.evaluate(BASE + 5000);
    expect(m.ttftSamples).toBe(5);
    expect(m.ttftP95Ms).toBeGreaterThanOrEqual(1400);
    expect(m.ttftP95Ms).toBeLessThanOrEqual(1600);
  });

  test("prunes samples older than the window", () => {
    const w = new SloWindow(1000);
    w.fold(ev({ kind: "turn_end", turn: 1, durationMs: 5000 } as Partial<TraceEvent>, 0));
    // Evaluate 2s later — the sample at t=0 is outside the 1s window.
    const m = w.evaluate(BASE + 2000);
    expect(m.turnSamples).toBe(0);
  });

  test("egress block rate derives from permission_decision egress outcomes", () => {
    const w = new SloWindow(60_000);
    // 8 external calls, 4 blocked.
    for (let i = 0; i < 4; i += 1) {
      w.fold(
        ev(
          {
            kind: "permission_decision",
            toolName: "Fetch",
            decision: "allow",
            mode: "auto",
            outcome: "egress-passed",
          } as Partial<TraceEvent>,
          i,
        ),
      );
      w.fold(
        ev(
          {
            kind: "permission_decision",
            toolName: "Fetch",
            decision: "deny",
            mode: "auto",
            outcome: "egress-blocked",
          } as Partial<TraceEvent>,
          i + 100,
        ),
      );
    }
    const m = w.evaluate(BASE + 500);
    expect(m.externalCalls).toBe(8);
    expect(m.egressBlockRate).toBeCloseTo(0.5, 5);
  });

  test("cost-per-hour extrapolates windowed spend to a full hour", () => {
    const w = new SloWindow(60_000); // 1-minute window
    // $6.00 in micros over the window → $360/h projection.
    w.fold(
      ev(
        {
          kind: "cost_accrual",
          provider: "anthropic",
          modelId: "m",
          inputTokens: 1,
          outputTokens: 1,
          cachedReadTokens: 0,
          costUsdMicros: 6_000_000,
        } as Partial<TraceEvent>,
        0,
      ),
    );
    const m = w.evaluate(BASE + 100);
    expect(m.costPerHourUsd).toBeCloseTo(360, 0);
  });

  test("cost_accrual summary aggregates are ignored (no double-count)", () => {
    const w = new SloWindow(60_000);
    w.fold(
      ev(
        {
          kind: "cost_accrual",
          provider: "anthropic",
          modelId: "m",
          inputTokens: 1,
          outputTokens: 1,
          cachedReadTokens: 0,
          costUsdMicros: 1_000_000,
          summary: true,
        } as Partial<TraceEvent>,
        0,
      ),
    );
    const m = w.evaluate(BASE + 100);
    expect(m.costPerHourUsd).toBe(0);
  });

  test("error rate is unrecovered errors over model calls", () => {
    const w = new SloWindow(60_000);
    for (let i = 0; i < 10; i += 1) {
      w.fold(
        ev({ kind: "model_response", traceId: `x${i}`.padEnd(32, "0") } as Partial<TraceEvent>, i),
      );
    }
    for (let i = 0; i < 3; i += 1) {
      w.fold(
        ev(
          {
            kind: "error_recovered",
            action: "fail",
            errorName: "Boom",
            depth: 0,
          } as Partial<TraceEvent>,
          i,
        ),
      );
    }
    const m = w.evaluate(BASE + 100);
    expect(m.errorRate).toBeCloseTo(0.3, 5);
  });
});

// ---------- detectSloBreaches ----------

describe("detectSloBreaches", () => {
  const targets: SloTargets = {
    ttftMs: 1400,
    errorRate: 0.05,
    egressBlockRate: 0.1,
    costPerHourUsd: 100,
    mitigation: ["alert"],
  };

  test("flags a TTFT breach with a named candidate-worthy detail", () => {
    const breaches = detectSloBreaches(
      {
        turnP95Ms: 0,
        turnSamples: 0,
        ttftP95Ms: 2000,
        ttftSamples: 6,
        errorRate: 0,
        modelCalls: 6,
        costPerHourUsd: 0,
        egressBlockRate: 0,
        externalCalls: 0,
      },
      targets,
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.metric).toBe("ttft_ms");
    expect(breaches[0]?.observed).toBe(2000);
    expect(breaches[0]?.detail).toContain("2000ms");
    expect(breaches[0]?.detail).toContain("1400ms");
  });

  test("does not breach on too few samples (cold-start noise)", () => {
    const breaches = detectSloBreaches(
      {
        turnP95Ms: 0,
        turnSamples: 0,
        ttftP95Ms: 9999,
        ttftSamples: 2,
        errorRate: 1,
        modelCalls: 1,
        costPerHourUsd: 0,
        egressBlockRate: 1,
        externalCalls: 1,
      },
      targets,
    );
    expect(breaches).toHaveLength(0);
  });

  test("cost breaches with no minimum-sample gate", () => {
    const breaches = detectSloBreaches(
      {
        turnP95Ms: 0,
        turnSamples: 0,
        ttftP95Ms: 0,
        ttftSamples: 0,
        errorRate: 0,
        modelCalls: 0,
        costPerHourUsd: 250,
        egressBlockRate: 0,
        externalCalls: 0,
      },
      targets,
    );
    expect(breaches.map((b) => b.metric)).toEqual(["cost_per_hour_usd"]);
  });

  test("an omitted target is never checked", () => {
    const breaches = detectSloBreaches(
      {
        turnP95Ms: 99999,
        turnSamples: 100,
        ttftP95Ms: 0,
        ttftSamples: 0,
        errorRate: 0,
        modelCalls: 0,
        costPerHourUsd: 0,
        egressBlockRate: 0,
        externalCalls: 0,
      },
      { ttftMs: 1400, mitigation: ["alert"] }, // no p95_latency_ms target
    );
    expect(breaches).toHaveLength(0);
  });
});

// ---------- attachSloMonitor: gate + ladder ----------

function newBus(): TraceEventBus {
  return new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
}

describe("attachSloMonitor — env + spec gate", () => {
  test("no monitor without CREWHAUS_SLO", () => {
    const m = attachSloMonitor(
      newBus(),
      createRunContext(),
      {},
      { targets: { ttftMs: 1, mitigation: ["alert"] } },
    );
    expect(m).toBeUndefined();
  });

  test("no monitor without targets", () => {
    const m = attachSloMonitor(newBus(), createRunContext(), { CREWHAUS_SLO: "1" }, {});
    expect(m).toBeUndefined();
  });

  test("attaches with both env + targets", () => {
    const m = attachSloMonitor(
      newBus(),
      createRunContext(),
      { CREWHAUS_SLO: "1" },
      {
        targets: { ttftMs: 1, mitigation: ["alert"] },
        setInterval: () => 0,
        clearInterval: () => {},
      },
    );
    expect(m).not.toBeUndefined();
    m?.stop();
    m?.unsubscribe();
  });
});

describe("attachSloMonitor — sustained breach walks the mitigation ladder", () => {
  test("alert → pause-intake → rollback each fire once, audited, in order", async () => {
    const bus = newBus();
    const ctx = createRunContext();
    const calls: string[] = [];
    const rollbacks: SloMitigationEvent[] = [];
    const alertEvents: TraceEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "alert_raised") alertEvents.push(e);
    });

    let clock = BASE;
    const monitor = attachSloMonitor(
      bus,
      ctx,
      { CREWHAUS_SLO: "1" },
      {
        targets: {
          ttftMs: 1400,
          windowMs: 60_000,
          mitigation: ["alert", "pause-intake", "rollback"],
        },
        setInterval: () => 0, // no real timer; we drive evaluate() manually
        clearInterval: () => {},
        now: () => clock,
        sink: {
          audit: async (ev2) => {
            calls.push(`audit:${ev2.rung}`);
          },
          alert: async () => {
            calls.push("alert");
          },
          pauseIntake: async () => {
            calls.push("pause-intake");
          },
          rollback: async (ev2) => {
            calls.push("rollback");
            rollbacks.push(ev2);
          },
        },
      },
    );
    expect(monitor).not.toBeUndefined();

    // Seed a sustained TTFT breach: 6 requests each ~2000ms TTFT.
    for (let i = 0; i < 6; i += 1) {
      const traceId = `tr${i}`.padEnd(32, "0");
      bus.publish(ev({ kind: "model_request", traceId } as Partial<TraceEvent>, i * 10));
      bus.publish(
        ev(
          {
            kind: "model_stream_token",
            traceId,
            chunkIndex: 0,
            deltaChars: 1,
          } as Partial<TraceEvent>,
          i * 10 + 2000,
        ),
      );
      bus.publish(ev({ kind: "model_response", traceId } as Partial<TraceEvent>, i * 10 + 2500));
    }
    clock = BASE + 3000;
    await monitor?.evaluate();

    // Ladder walked once, in order, each rung audited before its handler.
    expect(calls).toEqual([
      "audit:alert",
      "alert",
      "audit:pause-intake",
      "pause-intake",
      "audit:rollback",
      "rollback",
    ]);
    // Rollback carried the breach detail (a deployment-controller would rollback the pin).
    expect(rollbacks[0]?.breach.metric).toBe("ttft_ms");
    // One alert_raised trace event per rung, tagged slo:.
    expect(alertEvents.map((e) => (e as { metric: string }).metric)).toEqual([
      "slo:ttft_ms",
      "slo:ttft_ms",
      "slo:ttft_ms",
    ]);

    // A SECOND evaluation with the breach still present does NOT re-fire any rung.
    clock = BASE + 6000;
    await monitor?.evaluate();
    expect(calls).toHaveLength(6); // unchanged

    monitor?.stop();
    monitor?.unsubscribe();
  });

  test("a rung with no injected handler is a no-op but still audited (degrades to alert-only)", async () => {
    const bus = newBus();
    const ctx = createRunContext();
    const audited: string[] = [];
    let clock = BASE;
    const monitor = attachSloMonitor(
      bus,
      ctx,
      { CREWHAUS_SLO: "1" },
      {
        targets: { errorRate: 0.05, windowMs: 60_000, mitigation: ["alert", "rollback"] },
        setInterval: () => 0,
        clearInterval: () => {},
        now: () => clock,
        sink: {
          audit: async (e) => {
            audited.push(e.rung);
          },
          // No rollback handler wired — a cli shape with no deployment controller.
        },
      },
    );
    // Seed 10 model calls, 8 unrecovered errors → 80% error rate.
    for (let i = 0; i < 10; i += 1) {
      bus.publish(
        ev({ kind: "model_response", traceId: `m${i}`.padEnd(32, "0") } as Partial<TraceEvent>, i),
      );
    }
    for (let i = 0; i < 8; i += 1) {
      bus.publish(
        ev(
          {
            kind: "error_recovered",
            action: "fail",
            errorName: "E",
            depth: 0,
          } as Partial<TraceEvent>,
          i,
        ),
      );
    }
    clock = BASE + 1000;
    await monitor?.evaluate();
    // Both rungs audited as attempted even though rollback had no handler.
    expect(audited).toEqual(["alert", "rollback"]);
    monitor?.stop();
    monitor?.unsubscribe();
  });

  test("no breach ⇒ no mitigation", async () => {
    const bus = newBus();
    const ctx = createRunContext();
    const calls: string[] = [];
    let clock = BASE;
    const monitor = attachSloMonitor(
      bus,
      ctx,
      { CREWHAUS_SLO: "1" },
      {
        targets: { ttftMs: 5000, windowMs: 60_000, mitigation: ["alert"] },
        setInterval: () => 0,
        clearInterval: () => {},
        now: () => clock,
        sink: {
          alert: async () => {
            calls.push("alert");
          },
        },
      },
    );
    for (let i = 0; i < 6; i += 1) {
      const traceId = `ok${i}`.padEnd(32, "0");
      bus.publish(ev({ kind: "model_request", traceId } as Partial<TraceEvent>, i * 10));
      bus.publish(
        ev(
          {
            kind: "model_stream_token",
            traceId,
            chunkIndex: 0,
            deltaChars: 1,
          } as Partial<TraceEvent>,
          i * 10 + 200,
        ),
      );
    }
    clock = BASE + 1000;
    await monitor?.evaluate();
    expect(calls).toHaveLength(0);
    monitor?.stop();
    monitor?.unsubscribe();
  });
});
