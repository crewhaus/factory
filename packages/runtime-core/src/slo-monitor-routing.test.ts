/**
 * 0.6.0 (design §8.4) — the SLO monitor's hybrid-routing targets:
 * `escalation_rate`, `judge_fail_rate`, `floor_block_rate` over the rolling
 * window, each gated on its own denominator reaching MIN_SLO_SAMPLES, and the
 * ladder's `alert` rung firing on a synthetic stream that trips one.
 */
import { describe, expect, test } from "bun:test";
import { createRunContext } from "@crewhaus/run-context";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { FLOOR_BLOCKED_ROUTE_REASON } from "./alert-watchdog";
import {
  MIN_SLO_SAMPLES,
  type SloMitigationEvent,
  SloWindow,
  attachSloMonitor,
  detectSloBreaches,
} from "./slo-monitor";

const BASE = Date.parse("2026-09-04T00:00:00.000Z");
const iso = (offsetMs: number): string => new Date(BASE + offsetMs).toISOString();

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

const turnEnd = (i: number): TraceEvent =>
  ev({ kind: "turn_end", turn: i, durationMs: 100 } as Partial<TraceEvent>, i * 10);
const escalation = (offset: number, outcome = "started"): TraceEvent =>
  ev(
    {
      kind: "model_stage",
      stage: "escalate",
      strategy: "cascade",
      role: "escalation",
      model: "m",
      outcome,
    } as Partial<TraceEvent>,
    offset,
  );
const graded = (verdict: "pass" | "fail", offset: number): TraceEvent =>
  ev(
    {
      kind: "eval_graded",
      score: 0.5,
      threshold: 0.7,
      verdict,
      graderType: "llm_judge",
      retryIndex: 0,
    } as Partial<TraceEvent>,
    offset,
  );
const route = (reason: string, offset: number): TraceEvent =>
  ev(
    {
      kind: "model_route",
      routeKey: "hard",
      model: "m",
      policy: "learned",
      reason,
    } as Partial<TraceEvent>,
    offset,
  );

describe("SloWindow — routing rates", () => {
  test("escalation_rate is escalations over turns in the window; stage `done` does not double-count", () => {
    const w = new SloWindow(60_000);
    for (let i = 1; i <= 4; i += 1) w.fold(turnEnd(i));
    w.fold(escalation(50));
    w.fold(escalation(51, "done"));
    w.fold(escalation(52));
    const m = w.evaluate(BASE + 1000);
    expect(m.escalations).toBe(2);
    expect(m.escalationRate).toBeCloseTo(0.5);
  });

  test("judge_fail_rate and floor_block_rate over their own denominators", () => {
    const w = new SloWindow(60_000);
    w.fold(graded("fail", 1));
    w.fold(graded("pass", 2));
    w.fold(
      ev(
        {
          kind: "judge_verdict",
          stepOrNode: "review",
          verdict: "fail",
          score: 0.1,
        } as Partial<TraceEvent>,
        3,
      ),
    );
    w.fold(route("best arm", 4));
    w.fold(route(FLOOR_BLOCKED_ROUTE_REASON, 5));
    const m = w.evaluate(BASE + 1000);
    expect(m.judgeVerdicts).toBe(3);
    expect(m.judgeFailRate).toBeCloseTo(2 / 3);
    expect(m.routeDecisions).toBe(2);
    expect(m.floorBlockRate).toBeCloseTo(0.5);
  });

  test("routing samples are pruned with the window", () => {
    const w = new SloWindow(1000);
    w.fold(turnEnd(1));
    w.fold(escalation(20));
    w.fold(route(FLOOR_BLOCKED_ROUTE_REASON, 30));
    w.fold(graded("fail", 40));
    const m = w.evaluate(BASE + 5000);
    expect(m.escalations).toBe(0);
    expect(m.routeDecisions).toBe(0);
    expect(m.judgeVerdicts).toBe(0);
    expect(m.escalationRate).toBe(0);
  });
});

describe("detectSloBreaches — routing targets", () => {
  const base = {
    turnP95Ms: 0,
    turnSamples: 0,
    ttftP95Ms: 0,
    ttftSamples: 0,
    errorRate: 0,
    modelCalls: 0,
    costPerHourUsd: 0,
    costSamples: 0,
    windowElapsedMs: 0,
    egressBlockRate: 0,
    externalCalls: 0,
    escalationRate: 0,
    escalations: 0,
    judgeFailRate: 0,
    judgeVerdicts: 0,
    floorBlockRate: 0,
    routeDecisions: 0,
  };

  test("each rate breaches only past its target AND with enough of its own samples", () => {
    const targets = {
      escalationRate: 0.3,
      judgeFailRate: 0.3,
      floorBlockRate: 0.3,
      mitigation: ["alert" as const],
    };
    // Enough turns, escalating on 60% of them.
    const hot = detectSloBreaches(
      {
        ...base,
        turnSamples: MIN_SLO_SAMPLES,
        escalations: 3,
        escalationRate: 0.6,
        judgeVerdicts: MIN_SLO_SAMPLES,
        judgeFailRate: 0.6,
        routeDecisions: MIN_SLO_SAMPLES,
        floorBlockRate: 0.6,
      },
      targets,
    );
    expect(hot.map((b) => b.metric)).toEqual([
      "escalation_rate",
      "judge_fail_rate",
      "floor_block_rate",
    ]);
    expect(hot[0]?.detail).toBe("escalation_rate 60.0% exceeded SLO target 30.0%");

    // Same rates on too few samples: cold-start noise, not a violation.
    const cold = detectSloBreaches(
      {
        ...base,
        turnSamples: MIN_SLO_SAMPLES - 1,
        escalationRate: 1,
        judgeVerdicts: MIN_SLO_SAMPLES - 1,
        judgeFailRate: 1,
        routeDecisions: MIN_SLO_SAMPLES - 1,
        floorBlockRate: 1,
      },
      targets,
    );
    expect(cold).toEqual([]);
  });

  test("an omitted routing target is never checked", () => {
    const breaches = detectSloBreaches(
      { ...base, turnSamples: 50, escalationRate: 1, judgeVerdicts: 50, judgeFailRate: 1 },
      { errorRate: 0.5, mitigation: ["alert"] },
    );
    expect(breaches).toEqual([]);
  });
});

describe("attachSloMonitor — an escalation storm walks the alert rung", () => {
  test("alert fires with slo:escalation_rate on a synthetic stream", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_0000000000000001" });
    const runContext = createRunContext({ sessionId: "sess_0000000000000001" });
    const alerts: SloMitigationEvent[] = [];
    let now = BASE;
    const raised: string[] = [];
    bus.subscribe((e) => {
      if (e.kind === "alert_raised") raised.push(e.metric);
    });
    const monitor = attachSloMonitor(
      bus,
      runContext,
      { CREWHAUS_SLO: "1" },
      {
        targets: { escalationRate: 0.4, windowMs: 60_000, mitigation: ["alert"] },
        sink: {
          alert: async (e) => {
            alerts.push(e);
          },
        },
        now: () => now,
        setInterval: () => ({}),
        clearInterval: () => undefined,
      },
    );
    expect(monitor).toBeDefined();
    if (monitor === undefined) throw new Error("monitor should attach");
    // Six turns, five of which escalated.
    for (let i = 1; i <= 6; i += 1) bus.publish(turnEnd(i));
    for (let i = 0; i < 5; i += 1) bus.publish(escalation(100 + i));
    now = BASE + 1000;
    await monitor.evaluate();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.rung).toBe("alert");
    expect(alerts[0]?.breach.metric).toBe("escalation_rate");
    expect(alerts[0]?.breach.observed).toBeCloseTo(5 / 6);
    expect(raised).toEqual(["slo:escalation_rate"]);
    monitor.stop();
    monitor.unsubscribe();
  });
});
