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
  MIN_COST_ELAPSED_MS,
  MIN_COST_SAMPLES,
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

  test("cost-per-hour extrapolates the OBSERVED spend over the ELAPSED span (not the nominal window)", () => {
    const w = new SloWindow(60_000); // 1-minute window
    // $6.00 spent across a full minute of observation → $360/h projection. The
    // extrapolation base is the elapsed observation span, so the first sample at
    // t=0 and an evaluation at t=60s give exactly one minute of elapsed time.
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
    const m = w.evaluate(BASE + 60_000);
    expect(m.costPerHourUsd).toBeCloseTo(360, 0);
    expect(m.costSamples).toBe(1);
    expect(m.windowElapsedMs).toBe(60_000);
  });

  test("a fresh window annualises over the ELAPSED span, not the full window", () => {
    const w = new SloWindow(300_000); // 5-minute window
    // $0.20 spent, evaluated only 3 seconds into the run. The OLD (buggy)
    // behaviour divided by the 5-minute window → $2.40/h; the fixed behaviour
    // divides by the 3s elapsed span → $240/h — but crucially reports
    // windowElapsedMs so the detector's min-elapsed floor can reject it.
    w.fold(
      ev(
        {
          kind: "cost_accrual",
          provider: "anthropic",
          modelId: "m",
          inputTokens: 1,
          outputTokens: 1,
          cachedReadTokens: 0,
          costUsdMicros: 200_000,
        } as Partial<TraceEvent>,
        0,
      ),
    );
    const m = w.evaluate(BASE + 3_000);
    expect(m.windowElapsedMs).toBe(3_000);
    expect(m.costSamples).toBe(1);
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
        costSamples: 0,
        windowElapsedMs: 0,
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
        costSamples: 0,
        windowElapsedMs: 0,
        egressBlockRate: 1,
        externalCalls: 1,
      },
      targets,
    );
    expect(breaches).toHaveLength(0);
  });

  test("cost breaches once it has enough samples AND enough elapsed window", () => {
    const breaches = detectSloBreaches(
      {
        turnP95Ms: 0,
        turnSamples: 0,
        ttftP95Ms: 0,
        ttftSamples: 0,
        errorRate: 0,
        modelCalls: 0,
        costPerHourUsd: 250,
        costSamples: MIN_COST_SAMPLES,
        windowElapsedMs: MIN_COST_ELAPSED_MS,
        egressBlockRate: 0,
        externalCalls: 0,
      },
      targets,
    );
    expect(breaches.map((b) => b.metric)).toEqual(["cost_per_hour_usd"]);
  });

  test("cost extrapolated from 1 sample in a fresh near-empty window is NOT a breach", () => {
    // A single cold-start turn: $0.20 projects to a huge $/h, but only 1 sample
    // in a 3-second-old window — the min-sample + min-elapsed floor rejects it.
    const breaches = detectSloBreaches(
      {
        turnP95Ms: 0,
        turnSamples: 0,
        ttftP95Ms: 0,
        ttftSamples: 0,
        errorRate: 0,
        modelCalls: 0,
        costPerHourUsd: 240, // $0.20 over 3s → $240/h projection
        costSamples: 1,
        windowElapsedMs: 3_000,
        egressBlockRate: 0,
        externalCalls: 0,
      },
      targets,
    );
    expect(breaches).toHaveLength(0);
  });

  test("cost with enough samples but too-short elapsed window is NOT a breach", () => {
    const breaches = detectSloBreaches(
      {
        turnP95Ms: 0,
        turnSamples: 0,
        ttftP95Ms: 0,
        ttftSamples: 0,
        errorRate: 0,
        modelCalls: 0,
        costPerHourUsd: 500,
        costSamples: MIN_COST_SAMPLES + 2,
        windowElapsedMs: MIN_COST_ELAPSED_MS - 1,
        egressBlockRate: 0,
        externalCalls: 0,
      },
      targets,
    );
    expect(breaches).toHaveLength(0);
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
        costSamples: 0,
        windowElapsedMs: 0,
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

/** Fold a TTFT-breach batch (6 requests each ~2000ms TTFT) whose events sit
 *  near `atOffsetMs` so they stay inside the rolling window at that eval time. */
function seedTtftBreach(bus: TraceEventBus, atOffsetMs: number): void {
  for (let i = 0; i < 6; i += 1) {
    const traceId = `tr${atOffsetMs}_${i}`.padEnd(32, "0").slice(0, 32);
    bus.publish(ev({ kind: "model_request", traceId } as Partial<TraceEvent>, atOffsetMs + i));
    bus.publish(
      ev(
        {
          kind: "model_stream_token",
          traceId,
          chunkIndex: 0,
          deltaChars: 1,
        } as Partial<TraceEvent>,
        atOffsetMs + i + 2000,
      ),
    );
    bus.publish(
      ev({ kind: "model_response", traceId } as Partial<TraceEvent>, atOffsetMs + i + 2100),
    );
  }
}

describe("attachSloMonitor — sustained breach walks the mitigation ladder", () => {
  test("alert is immediate; pause-intake + rollback fire only once the breach is SUSTAINED", async () => {
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

    // Eval 1 (streak=1, only 3s elapsed): ALERT fires immediately, but the
    // destructive rungs must NOT — the breach is not yet sustained.
    seedTtftBreach(bus, 1000);
    clock = BASE + 3000;
    await monitor?.evaluate();
    expect(calls).toEqual(["audit:alert", "alert"]);
    expect(rollbacks).toHaveLength(0);

    // Eval 2, past the window with the breach still present (streak=2, ~67s
    // since the streak began): NOW the destructive rungs fire, once, in order.
    seedTtftBreach(bus, 69_000);
    clock = BASE + 70_000;
    await monitor?.evaluate();
    expect(calls).toEqual([
      "audit:alert",
      "alert",
      "audit:pause-intake",
      "pause-intake",
      "audit:rollback",
      "rollback",
    ]);
    expect(rollbacks[0]?.breach.metric).toBe("ttft_ms");

    // Eval 3, breach still present: nothing re-fires (alert + rollback are
    // one-shot; intake is already paused).
    seedTtftBreach(bus, 129_000);
    clock = BASE + 130_000;
    await monitor?.evaluate();
    expect(calls).toHaveLength(6); // unchanged

    monitor?.stop();
    monitor?.unsubscribe();
  });

  test("a single transient breach that clears next tick does NOT roll back or pause", async () => {
    const bus = newBus();
    const ctx = createRunContext();
    const calls: string[] = [];
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
        setInterval: () => 0,
        clearInterval: () => {},
        now: () => clock,
        sink: {
          audit: async (e) => {
            calls.push(`audit:${e.rung}`);
          },
          alert: async () => {
            calls.push("alert");
          },
          pauseIntake: async () => {
            calls.push("pause-intake");
          },
          rollback: async () => {
            calls.push("rollback");
          },
        },
      },
    );

    // Tick 1: a single breached evaluation → alert only (not sustained).
    seedTtftBreach(bus, 1000);
    clock = BASE + 3000;
    await monitor?.evaluate();
    expect(calls).toEqual(["audit:alert", "alert"]);

    // Tick 2, well past the window, but the breach has CLEARED (no fresh slow
    // TTFT samples; the old ones pruned out of the window). Fast, healthy TTFT.
    for (let i = 0; i < 6; i += 1) {
      const traceId = `ok${i}`.padEnd(32, "0");
      bus.publish(ev({ kind: "model_request", traceId } as Partial<TraceEvent>, 69_000 + i));
      bus.publish(
        ev(
          {
            kind: "model_stream_token",
            traceId,
            chunkIndex: 0,
            deltaChars: 1,
          } as Partial<TraceEvent>,
          69_000 + i + 100,
        ),
      );
    }
    clock = BASE + 70_000;
    await monitor?.evaluate();
    // The streak reset when the breach cleared — no destructive rung ever fired.
    expect(calls).toEqual(["audit:alert", "alert"]);
    expect(calls).not.toContain("rollback");
    expect(calls).not.toContain("pause-intake");

    // Tick 3: the breach returns, but the streak restarts from 1 — still only
    // one breached eval, so no destructive rung yet.
    seedTtftBreach(bus, 129_000);
    clock = BASE + 130_000;
    await monitor?.evaluate();
    expect(calls).not.toContain("rollback");

    monitor?.stop();
    monitor?.unsubscribe();
  });

  test("pause-intake resumes + re-arms when a sustained breach clears", async () => {
    const bus = newBus();
    const ctx = createRunContext();
    const calls: string[] = [];
    let clock = BASE;
    const monitor = attachSloMonitor(
      bus,
      ctx,
      { CREWHAUS_SLO: "1" },
      {
        targets: { ttftMs: 1400, windowMs: 60_000, mitigation: ["pause-intake"] },
        setInterval: () => 0,
        clearInterval: () => {},
        now: () => clock,
        sink: {
          pauseIntake: async () => {
            calls.push("pause");
          },
          resumeIntake: async () => {
            calls.push("resume");
          },
        },
      },
    );

    // Helper: fold 6 HEALTHY (fast-TTFT) samples near an offset so a later
    // evaluation, once the slow samples have aged out of the window, sees no
    // breach. (A TTFT sample is timestamped at the stream-token, ~2s after the
    // request for a slow turn — so the healthy evaluation must sit far enough
    // past the last slow batch that those slow samples are pruned.)
    const seedHealthy = (atOffsetMs: number): void => {
      for (let i = 0; i < 6; i += 1) {
        const traceId = `ok${atOffsetMs}_${i}`.padEnd(32, "0").slice(0, 32);
        bus.publish(ev({ kind: "model_request", traceId } as Partial<TraceEvent>, atOffsetMs + i));
        bus.publish(
          ev(
            {
              kind: "model_stream_token",
              traceId,
              chunkIndex: 0,
              deltaChars: 1,
            } as Partial<TraceEvent>,
            atOffsetMs + i + 100,
          ),
        );
      }
    };

    // Sustain a TTFT breach across two evals spanning the window → pause.
    seedTtftBreach(bus, 1000);
    clock = BASE + 3000;
    await monitor?.evaluate();
    seedTtftBreach(bus, 69_000);
    clock = BASE + 70_000;
    await monitor?.evaluate();
    expect(calls).toEqual(["pause"]);

    // Breach clears (healthy TTFT), evaluated far enough past the last slow
    // batch (~71s) that those slow samples have aged out of the 60s window → resume.
    seedHealthy(139_000);
    clock = BASE + 140_000;
    await monitor?.evaluate();
    expect(calls).toEqual(["pause", "resume"]);

    // A new sustained breach re-pauses (the rung re-armed on resume).
    seedTtftBreach(bus, 200_000);
    clock = BASE + 201_000;
    await monitor?.evaluate();
    seedTtftBreach(bus, 268_000);
    clock = BASE + 269_000;
    await monitor?.evaluate();
    expect(calls).toEqual(["pause", "resume", "pause"]);

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
    // Seed 10 model calls, 8 unrecovered errors → 80% error rate, and sustain it
    // across two evals spanning the window so the rollback rung is reached.
    const seedErrors = (atOffsetMs: number): void => {
      for (let i = 0; i < 10; i += 1) {
        bus.publish(
          ev(
            {
              kind: "model_response",
              traceId: `m${atOffsetMs}_${i}`.padEnd(32, "0").slice(0, 32),
            } as Partial<TraceEvent>,
            atOffsetMs + i,
          ),
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
            atOffsetMs + i,
          ),
        );
      }
    };
    seedErrors(1000);
    clock = BASE + 3000;
    await monitor?.evaluate();
    seedErrors(69_000);
    clock = BASE + 70_000;
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
