/**
 * 0.6.0 (design §8.4) — the alert watchdog's hybrid-routing rates:
 * `escalation_rate`, `judge_fail_rate`, `floor_block_rate`. Folds synthetic
 * event streams into a snapshot, derives thresholds from mixed-vintage history
 * (0.5.x lines lack the new fields), and asserts the breaches fire on exactly
 * the sessions that should trip them.
 */
import { describe, expect, test } from "bun:test";
import type { TraceEvent, TraceEventEnvelope } from "@crewhaus/trace-event-bus";
import {
  FLOOR_BLOCKED_ROUTE_REASON,
  HEADROOM_FACTOR,
  MIN_BASELINE_SESSIONS,
  SessionMetricsAccumulator,
  type SessionMetricsSnapshot,
  deriveThresholds,
  detectBreaches,
  isEscalationEvent,
  isFloorBlockedRoute,
} from "./alert-watchdog";

function env(offsetMs = 0): TraceEventEnvelope {
  return {
    runId: "run-1",
    sessionId: "sess_0000000000000001",
    turnNumber: 1,
    traceId: "trace-1",
    spanId: "span-1",
    timestamp: new Date(Date.parse("2026-09-04T00:00:00.000Z") + offsetMs).toISOString(),
  };
}

const turnEnd = (i: number): TraceEvent =>
  ({ ...env(i * 1000), kind: "turn_end", turn: i, durationMs: 500 }) as TraceEvent;

const stage = (outcome: string, role = "escalation"): TraceEvent =>
  ({
    ...env(),
    kind: "model_stage",
    stage: "escalate",
    strategy: "cascade",
    role,
    model: "claude-opus-5",
    outcome,
  }) as TraceEvent;

const route = (reason: string): TraceEvent =>
  ({
    ...env(),
    kind: "model_route",
    routeKey: "hard",
    model: "claude-opus-5",
    policy: "learned",
    reason,
  }) as TraceEvent;

const graded = (verdict: "pass" | "fail"): TraceEvent =>
  ({
    ...env(),
    kind: "eval_graded",
    score: verdict === "pass" ? 0.9 : 0.2,
    threshold: 0.7,
    verdict,
    graderType: "llm_judge",
    retryIndex: 0,
  }) as TraceEvent;

const gate = (verdict: "pass" | "fail"): TraceEvent =>
  ({
    ...env(),
    kind: "judge_verdict",
    stepOrNode: "review",
    verdict,
    score: verdict === "pass" ? 0.9 : 0.1,
  }) as TraceEvent;

/** A 0.5.x-vintage snapshot line: none of the routing fields. */
function legacySnap(overrides: Partial<SessionMetricsSnapshot> = {}): SessionMetricsSnapshot {
  return {
    sessionId: "sess_x",
    ts: "2026-07-02T00:00:00Z",
    turns: 10,
    modelCalls: 10,
    unrecoveredErrors: 0,
    errorRate: 0,
    turnP95Seconds: 1,
    ttftP95Seconds: 0.5,
    costUsdMicros: 0,
    costBurnUsdPerMin: 0,
    pricingMisses: 0,
    circuitOpens: 0,
    egressBlocked: 0,
    permissionDenials: 0,
    ...overrides,
  };
}

describe("event classification helpers", () => {
  test("an escalation stage counts once, on start; drafts and tier non-escalations do not", () => {
    expect(isEscalationEvent(stage("started"))).toBe(true);
    expect(isEscalationEvent(stage("done"))).toBe(false);
    expect(isEscalationEvent(stage("started", "draft"))).toBe(false);
    expect(
      isEscalationEvent({
        ...env(),
        kind: "model_tier_route",
        tier: "default",
        model: "m",
        reason: "escalated after fast-tier failure",
        escalated: true,
      } as TraceEvent),
    ).toBe(true);
    expect(
      isEscalationEvent({
        ...env(),
        kind: "model_tier_route",
        tier: "fast",
        model: "m",
        reason: "no tools",
      } as TraceEvent),
    ).toBe(false);
    expect(isEscalationEvent(turnEnd(1))).toBe(false);
  });

  test("floor-blocked routes are keyed on the §7.10 reason string verbatim", () => {
    expect(FLOOR_BLOCKED_ROUTE_REASON).toBe("floor-blocked");
    expect(isFloorBlockedRoute({ reason: "floor-blocked" })).toBe(true);
    expect(isFloorBlockedRoute({ reason: "best arm" })).toBe(false);
  });
});

describe("SessionMetricsAccumulator — routing rates", () => {
  test("escalation_rate is escalations over turns; only stage starts and tier recoveries count", () => {
    const acc = new SessionMetricsAccumulator();
    for (let i = 1; i <= 4; i += 1) acc.fold(turnEnd(i));
    acc.fold(stage("started"));
    acc.fold(stage("done"));
    acc.fold(stage("started", "draft"));
    acc.fold({
      ...env(),
      kind: "model_tier_route",
      tier: "default",
      model: "m",
      reason: "escalated after fast-tier failure",
      escalated: true,
    } as TraceEvent);
    const s = acc.snapshot("sess_x");
    expect(s.escalations).toBe(2);
    expect(s.escalationRate).toBeCloseTo(0.5);
  });

  test("judge_fail_rate folds in-loop grades AND judge-gate verdicts", () => {
    const acc = new SessionMetricsAccumulator();
    acc.fold(graded("pass"));
    acc.fold(graded("fail"));
    acc.fold(gate("pass"));
    acc.fold(gate("fail"));
    acc.fold(gate("fail"));
    const s = acc.snapshot("sess_x");
    expect(s.judgeVerdicts).toBe(5);
    expect(s.judgeFails).toBe(3);
    expect(s.judgeFailRate).toBeCloseTo(0.6);
  });

  test("floor_block_rate is floor-blocked decisions over all route decisions", () => {
    const acc = new SessionMetricsAccumulator();
    acc.fold(route("best arm"));
    acc.fold(route(FLOOR_BLOCKED_ROUTE_REASON));
    acc.fold(route(FLOOR_BLOCKED_ROUTE_REASON));
    acc.fold(route("exploring"));
    const s = acc.snapshot("sess_x");
    expect(s.routeDecisions).toBe(4);
    expect(s.floorBlocks).toBe(2);
    expect(s.floorBlockRate).toBeCloseTo(0.5);
  });

  test("a session with no routing activity reports zero rates (never NaN)", () => {
    const s = new SessionMetricsAccumulator().snapshot("sess_x");
    expect(s.escalationRate).toBe(0);
    expect(s.judgeFailRate).toBe(0);
    expect(s.floorBlockRate).toBe(0);
  });
});

describe("deriveThresholds — routing rates", () => {
  test("bootstrap defaults are 0.5 for each rate", () => {
    const t = deriveThresholds([]);
    expect(t.escalationRate).toBe(0.5);
    expect(t.judgeFailRate).toBe(0.5);
    expect(t.floorBlockRate).toBe(0.5);
  });

  test("0.5.x history lines (no routing fields) derive the 5% floor, not NaN", () => {
    const history = Array.from({ length: MIN_BASELINE_SESSIONS + 2 }, () => legacySnap());
    const t = deriveThresholds(history);
    expect(t.baselineSessions).toBe(MIN_BASELINE_SESSIONS + 2);
    expect(t.escalationRate).toBe(0.05);
    expect(t.judgeFailRate).toBe(0.05);
    expect(t.floorBlockRate).toBe(0.05);
  });

  test("with routing history, thresholds are trailing p95 × headroom", () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      legacySnap({
        escalationRate: 0.1 + i * 0.01,
        judgeFailRate: 0.2,
        floorBlockRate: 0.02 + i * 0.001,
      }),
    );
    const t = deriveThresholds(history);
    // p95 over 10 values is the 9th (index floor(0.95*9)=8) ⇒ 0.18.
    expect(t.escalationRate).toBeCloseTo(0.18 * HEADROOM_FACTOR);
    expect(t.judgeFailRate).toBeCloseTo(0.2 * HEADROOM_FACTOR);
    // 0.028 × 1.5 = 0.042 is BELOW the 5% floor, so the floor wins.
    expect(t.floorBlockRate).toBe(0.05);
  });
});

describe("detectBreaches — routing rates on synthetic sessions", () => {
  const thresholds = deriveThresholds(
    Array.from({ length: 10 }, () =>
      legacySnap({ escalationRate: 0.1, judgeFailRate: 0.2, floorBlockRate: 0.1 }),
    ),
  );

  test("a cascade escalating on most turns breaches escalation_rate", () => {
    const acc = new SessionMetricsAccumulator();
    for (let i = 1; i <= 4; i += 1) acc.fold(turnEnd(i));
    for (let i = 0; i < 3; i += 1) acc.fold(stage("started"));
    const breaches = detectBreaches(acc.snapshot("sess_x"), thresholds);
    const esc = breaches.find((b) => b.metric === "escalation_rate");
    expect(esc?.observed).toBeCloseTo(0.75);
    expect(esc?.threshold).toBeCloseTo(0.15);
    expect(esc?.detail).toContain("escalation_rate");
    expect(breaches.map((b) => b.metric)).not.toContain("judge_fail_rate");
    expect(breaches.map((b) => b.metric)).not.toContain("floor_block_rate");
  });

  test("a judge failing most drafts breaches judge_fail_rate", () => {
    const acc = new SessionMetricsAccumulator();
    for (let i = 1; i <= 4; i += 1) acc.fold(turnEnd(i));
    acc.fold(graded("fail"));
    acc.fold(graded("fail"));
    acc.fold(graded("fail"));
    acc.fold(graded("pass"));
    const breaches = detectBreaches(acc.snapshot("sess_x"), thresholds);
    expect(breaches.map((b) => b.metric)).toEqual(["judge_fail_rate"]);
    expect(breaches[0]?.observed).toBeCloseTo(0.75);
  });

  test("a floor blocking most decisions breaches floor_block_rate", () => {
    const acc = new SessionMetricsAccumulator();
    for (let i = 1; i <= 4; i += 1) acc.fold(turnEnd(i));
    acc.fold(route(FLOOR_BLOCKED_ROUTE_REASON));
    acc.fold(route(FLOOR_BLOCKED_ROUTE_REASON));
    acc.fold(route("best arm"));
    const breaches = detectBreaches(acc.snapshot("sess_x"), thresholds);
    expect(breaches.map((b) => b.metric)).toEqual(["floor_block_rate"]);
  });

  test("a healthy hybrid session and a 0.5.x snapshot line breach nothing", () => {
    const acc = new SessionMetricsAccumulator();
    for (let i = 1; i <= 10; i += 1) acc.fold(turnEnd(i));
    acc.fold(stage("started"));
    for (let i = 0; i < 9; i += 1) acc.fold(graded("pass"));
    acc.fold(graded("fail"));
    for (let i = 0; i < 10; i += 1) acc.fold(route("best arm"));
    expect(detectBreaches(acc.snapshot("sess_x"), thresholds)).toEqual([]);
    // A snapshot persisted before 0.6.0 has no routing fields at all.
    expect(detectBreaches(legacySnap(), thresholds)).toEqual([]);
  });
});
