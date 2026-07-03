/**
 * Ops item 31 — integration tests for the alert-watchdog bus subscriber wired
 * into observability.ts. Exercises the env gate, snapshot persistence,
 * baseline-derived breach detection, the `alert_raised` trace event, and the
 * injected audit + hook sinks. No real model / network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunContext } from "@crewhaus/run-context";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { type AlertBreachPayload, attachAlertWatchdog } from "./observability";

let tmpRoot = "";
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "alert-attach-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function newBus(): TraceEventBus {
  return new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
}

function slowTurn(bus: TraceEventBus, durationMs: number): void {
  bus.publish({ ...bus.envelope(), kind: "turn_end", turn: 1, durationMs } as TraceEvent);
}

describe("attachAlertWatchdog — env gate", () => {
  test("no watchdog without CREWHAUS_ALERTS", () => {
    const bus = newBus();
    const ctx = createRunContext();
    const wd = attachAlertWatchdog(bus, ctx, {}, { metricsDir: join(tmpRoot, "m") });
    expect(wd).toBeUndefined();
  });

  test("attaches when CREWHAUS_ALERTS=1", () => {
    const bus = newBus();
    const ctx = createRunContext();
    const wd = attachAlertWatchdog(
      bus,
      ctx,
      { CREWHAUS_ALERTS: "1" },
      { metricsDir: join(tmpRoot, "m") },
    );
    expect(wd).not.toBeUndefined();
    wd?.unsubscribe();
  });
});

describe("attachAlertWatchdog — snapshot persistence + breach", () => {
  test("persists a snapshot on finalize even with no history", async () => {
    const bus = newBus();
    const ctx = createRunContext();
    const metricsDir = join(tmpRoot, "m");
    const wd = attachAlertWatchdog(bus, ctx, { CREWHAUS_ALERTS: "1" }, { metricsDir });
    slowTurn(bus, 1000);
    await wd?.finalize();
    const { readMetricsHistory } = await import("./alert-watchdog");
    expect(readMetricsHistory(metricsDir)).toHaveLength(1);
  });

  test("cold start: a wildly-slow turn breaches the bootstrap threshold ⇒ alert event + sinks", async () => {
    const bus = newBus();
    const ctx = createRunContext();
    const metricsDir = join(tmpRoot, "m");
    const alerts: TraceEvent[] = [];
    bus.subscribe((ev) => {
      if (ev.kind === "alert_raised") alerts.push(ev);
    });
    const audited: AlertBreachPayload[] = [];
    const hooked: AlertBreachPayload[] = [];
    const wd = attachAlertWatchdog(
      bus,
      ctx,
      { CREWHAUS_ALERTS: "1" },
      {
        metricsDir,
        alertSink: {
          appendAudit: async (b) => {
            audited.push(b);
          },
          fireAlertHook: async (b) => {
            hooked.push(b);
          },
        },
      },
    );
    // Bootstrap turn-latency threshold is 120s; a 300s turn breaches it.
    slowTurn(bus, 300_000);
    await wd?.finalize();

    expect(alerts.length).toBeGreaterThan(0);
    const turnAlert = alerts.find(
      (a) => a.kind === "alert_raised" && a.metric === "turn_p95_seconds",
    );
    expect(turnAlert).not.toBeUndefined();
    expect(audited.map((a) => a.metric)).toContain("turn_p95_seconds");
    expect(hooked.map((a) => a.metric)).toContain("turn_p95_seconds");
    // The baseline was a cold start (0 prior sessions).
    expect(audited[0]?.baselineSessions).toBe(0);
  });

  test("derives against PRIOR history: a session far above the trailing p95 alerts", async () => {
    const bus0 = newBus();
    const ctx = createRunContext();
    const metricsDir = join(tmpRoot, "m");
    // Seed 6 healthy sessions (~1s turns) so a real baseline forms.
    for (let i = 0; i < 6; i++) {
      const b = newBus();
      const wd = attachAlertWatchdog(b, ctx, { CREWHAUS_ALERTS: "1" }, { metricsDir });
      slowTurn(b, 1000);
      await wd?.finalize();
    }
    // Now a 30s turn — far above the ~1s baseline × 1.5.
    const alerts: TraceEvent[] = [];
    bus0.subscribe((ev) => {
      if (ev.kind === "alert_raised") alerts.push(ev);
    });
    const wd = attachAlertWatchdog(bus0, ctx, { CREWHAUS_ALERTS: "1" }, { metricsDir });
    slowTurn(bus0, 30_000);
    await wd?.finalize();
    const turnAlert = alerts.find(
      (a) => a.kind === "alert_raised" && a.metric === "turn_p95_seconds",
    );
    expect(turnAlert).not.toBeUndefined();
    if (turnAlert?.kind === "alert_raised") {
      expect(turnAlert.baselineSessions).toBe(6);
      expect(turnAlert.observed).toBe(30);
    }
  });

  test("a healthy session against a healthy baseline raises nothing", async () => {
    const metricsDir = join(tmpRoot, "m");
    const ctx = createRunContext();
    for (let i = 0; i < 6; i++) {
      const b = newBus();
      const wd = attachAlertWatchdog(b, ctx, { CREWHAUS_ALERTS: "1" }, { metricsDir });
      slowTurn(b, 1000);
      await wd?.finalize();
    }
    const bus = newBus();
    const alerts: TraceEvent[] = [];
    bus.subscribe((ev) => {
      if (ev.kind === "alert_raised") alerts.push(ev);
    });
    const wd = attachAlertWatchdog(bus, ctx, { CREWHAUS_ALERTS: "1" }, { metricsDir });
    slowTurn(bus, 1100); // within baseline variance
    await wd?.finalize();
    expect(alerts).toHaveLength(0);
  });

  test("finalize is idempotent (flush + shutdown both call it)", async () => {
    const bus = newBus();
    const ctx = createRunContext();
    const metricsDir = join(tmpRoot, "m");
    const wd = attachAlertWatchdog(bus, ctx, { CREWHAUS_ALERTS: "1" }, { metricsDir });
    slowTurn(bus, 1000);
    await wd?.finalize();
    await wd?.finalize();
    const { readMetricsHistory } = await import("./alert-watchdog");
    // Only ONE snapshot despite two finalize calls.
    expect(readMetricsHistory(metricsDir)).toHaveLength(1);
  });

  test("a throwing audit sink is swallowed (never breaks finalize)", async () => {
    const bus = newBus();
    const ctx = createRunContext();
    const metricsDir = join(tmpRoot, "m");
    const wd = attachAlertWatchdog(
      bus,
      ctx,
      { CREWHAUS_ALERTS: "1" },
      {
        metricsDir,
        alertSink: {
          appendAudit: async () => {
            throw new Error("audit down");
          },
        },
      },
    );
    slowTurn(bus, 300_000); // breaches bootstrap
    // Must resolve, not reject.
    await wd?.finalize();
    const { readMetricsHistory } = await import("./alert-watchdog");
    expect(readMetricsHistory(metricsDir)).toHaveLength(1);
  });
});
