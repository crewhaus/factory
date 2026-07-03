/**
 * Ops item 31 — alert-watchdog core tests: event folding into a session
 * snapshot, baseline-derived threshold computation, breach detection, and the
 * snapshot-history persistence round-trip.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceEvent, TraceEventEnvelope } from "@crewhaus/trace-event-bus";
import {
  HEADROOM_FACTOR,
  MIN_BASELINE_SESSIONS,
  SessionMetricsAccumulator,
  type SessionMetricsSnapshot,
  appendMetricsSnapshot,
  deriveThresholds,
  detectBreaches,
  percentile,
  readMetricsHistory,
} from "./alert-watchdog";

let tmpRoot = "";
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "alert-watchdog-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function env(timestamp: string, traceId = "trace-1"): TraceEventEnvelope {
  return {
    runId: "run-1",
    sessionId: "sess_0000000000000001",
    turnNumber: 1,
    traceId,
    spanId: "span-1",
    timestamp,
  };
}

function snap(overrides: Partial<SessionMetricsSnapshot>): SessionMetricsSnapshot {
  return {
    sessionId: "sess_x",
    ts: "2026-07-02T00:00:00Z",
    turns: 1,
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

describe("percentile", () => {
  test("empty ⇒ 0", () => {
    expect(percentile([], 0.95)).toBe(0);
  });
  test("nearest-rank p95 (index floor(p*(n-1)))", () => {
    // floor(0.95 * 9) = 8 ⇒ the 9th value.
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(9);
    // floor(0.95 * 19) = 18 ⇒ the 19th value.
    expect(
      percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.95),
    ).toBe(19);
    expect(percentile([5], 0.95)).toBe(5);
  });
});

describe("SessionMetricsAccumulator.fold + snapshot", () => {
  test("folds turn durations, TTFT, model calls, and cost", () => {
    const acc = new SessionMetricsAccumulator();
    // Two model calls with TTFT.
    acc.fold({ ...env("2026-07-02T00:00:00.000Z"), kind: "model_request" } as TraceEvent);
    acc.fold({
      ...env("2026-07-02T00:00:00.500Z"),
      kind: "model_stream_token",
      chunkIndex: 0,
      deltaChars: 5,
    } as TraceEvent);
    acc.fold({
      ...env("2026-07-02T00:00:01.000Z"),
      kind: "model_response",
      model: "m",
      stopReason: "end_turn",
      usage: { input: 100, output: 50 },
      durationMs: 1000,
    } as TraceEvent);
    acc.fold({
      ...env("2026-07-02T00:00:02.000Z"),
      kind: "turn_end",
      turn: 1,
      durationMs: 2000,
    } as TraceEvent);
    acc.fold({
      ...env("2026-07-02T00:00:03.000Z"),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "m",
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 0,
      costUsdMicros: 3_000_000,
    } as TraceEvent);

    const s = acc.snapshot("sess_x", new Date("2026-07-02T00:00:04.000Z"));
    expect(s.modelCalls).toBe(1);
    expect(s.turns).toBe(1);
    expect(s.turnP95Seconds).toBe(2);
    expect(s.ttftP95Seconds).toBeCloseTo(0.5);
    expect(s.costUsdMicros).toBe(3_000_000);
    // Wall clock 00:00 → 00:03 = 3s = 0.05 min; $3 / 0.05 = $60/min.
    expect(s.costBurnUsdPerMin).toBeCloseTo(60, 0);
  });

  test("counts only terminal-fail errors as unrecovered; ignores retry/compact", () => {
    const acc = new SessionMetricsAccumulator();
    acc.fold({
      ...env("2026-07-02T00:00:00Z"),
      kind: "error_recovered",
      action: "retry",
      errorName: "Timeout",
      depth: 1,
    } as TraceEvent);
    acc.fold({
      ...env("2026-07-02T00:00:01Z"),
      kind: "error_recovered",
      action: "fail",
      errorName: "Fatal",
      depth: 1,
    } as TraceEvent);
    acc.fold({
      ...env("2026-07-02T00:00:02Z"),
      kind: "model_response",
      model: "m",
      stopReason: "end_turn",
      usage: { input: 1, output: 1 },
      durationMs: 5,
    } as TraceEvent);
    const s = acc.snapshot("sess_x");
    expect(s.unrecoveredErrors).toBe(1);
    expect(s.errorRate).toBe(1); // 1 unrecovered / 1 model call
  });

  test("counts a $0-priced non-empty accrual as a pricing miss; skips FR-003 summary", () => {
    const acc = new SessionMetricsAccumulator();
    acc.fold({
      ...env("2026-07-02T00:00:00Z"),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "unknown-model",
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 0,
      costUsdMicros: 0,
    } as TraceEvent);
    // Terminal aggregate must NOT be counted.
    acc.fold({
      ...env("2026-07-02T00:00:01Z"),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "m",
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 0,
      costUsdMicros: 9_000_000,
      summary: true,
    } as TraceEvent);
    const s = acc.snapshot("sess_x");
    expect(s.pricingMisses).toBe(1);
    expect(s.costUsdMicros).toBe(0); // summary skipped
  });

  test("folds circuit opens, egress blocks, and permission denials", () => {
    const acc = new SessionMetricsAccumulator();
    acc.fold({
      ...env("2026-07-02T00:00:00Z"),
      kind: "circuit_state_changed",
      adapter: "anthropic",
      fromState: "closed",
      toState: "open",
    } as TraceEvent);
    acc.fold({
      ...env("2026-07-02T00:00:01Z"),
      kind: "permission_decision",
      toolName: "fetch",
      decision: "deny",
      mode: "auto",
      outcome: "egress-blocked",
    } as TraceEvent);
    acc.fold({
      ...env("2026-07-02T00:00:02Z"),
      kind: "permission_decision",
      toolName: "bash",
      decision: "deny",
      mode: "auto",
    } as TraceEvent);
    const s = acc.snapshot("sess_x");
    expect(s.circuitOpens).toBe(1);
    expect(s.egressBlocked).toBe(1);
    expect(s.permissionDenials).toBe(1);
  });
});

describe("deriveThresholds", () => {
  test("cold start (< MIN_BASELINE_SESSIONS) uses bootstrap defaults", () => {
    const history: SessionMetricsSnapshot[] = [snap({}), snap({})];
    expect(history.length).toBeLessThan(MIN_BASELINE_SESSIONS);
    const t = deriveThresholds(history);
    expect(t.baselineSessions).toBe(2);
    expect(t.errorRate).toBe(0.5);
    expect(t.circuitOpens).toBe(1);
  });

  test("with history, thresholds are trailing p95 × headroom", () => {
    // 10 sessions with turn p95 all = 2s ⇒ p95 = 2, threshold = 2 × 1.5 = 3.
    const history = Array.from({ length: 10 }, () => snap({ turnP95Seconds: 2 }));
    const t = deriveThresholds(history);
    expect(t.baselineSessions).toBe(10);
    expect(t.turnP95Seconds).toBeCloseTo(2 * HEADROOM_FACTOR);
  });

  test("error-rate threshold has a floor so a quiet baseline still tolerates some noise", () => {
    const history = Array.from({ length: 10 }, () => snap({ errorRate: 0 }));
    const t = deriveThresholds(history);
    expect(t.errorRate).toBe(0.05); // floored, not 0
  });
});

describe("detectBreaches", () => {
  test("a session well inside baseline ⇒ no breaches", () => {
    const history = Array.from({ length: 10 }, () => snap({ turnP95Seconds: 2, errorRate: 0.1 }));
    const t = deriveThresholds(history);
    const clean = snap({ turnP95Seconds: 2, errorRate: 0.1 });
    expect(detectBreaches(clean, t)).toHaveLength(0);
  });

  test("a turn-latency spike above threshold is reported", () => {
    const history = Array.from({ length: 10 }, () => snap({ turnP95Seconds: 2 }));
    const t = deriveThresholds(history); // threshold 3s
    const slow = snap({ turnP95Seconds: 10 });
    const breaches = detectBreaches(slow, t);
    expect(breaches.map((b) => b.metric)).toContain("turn_p95_seconds");
    const b = breaches.find((x) => x.metric === "turn_p95_seconds");
    expect(b?.observed).toBe(10);
    expect(b?.detail).toContain("baseline threshold");
  });

  test("a first-ever circuit open breaches the floor-1 count threshold", () => {
    const history = Array.from({ length: 10 }, () => snap({ circuitOpens: 0 }));
    const t = deriveThresholds(history);
    const tripped = snap({ circuitOpens: 3 });
    expect(detectBreaches(tripped, t).map((b) => b.metric)).toContain("circuit_opens");
  });

  test("cost-burn spike above the derived threshold is reported", () => {
    const history = Array.from({ length: 10 }, () => snap({ costBurnUsdPerMin: 1 }));
    const t = deriveThresholds(history); // threshold 1.5
    const pricey = snap({ costBurnUsdPerMin: 5 });
    expect(detectBreaches(pricey, t).map((b) => b.metric)).toContain("cost_burn_usd_per_min");
  });
});

describe("snapshot persistence", () => {
  test("append then read round-trips, oldest first", () => {
    const dir = join(tmpRoot, "metrics");
    appendMetricsSnapshot(snap({ sessionId: "a" }), dir);
    appendMetricsSnapshot(snap({ sessionId: "b" }), dir);
    const history = readMetricsHistory(dir);
    expect(history.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  test("missing file ⇒ empty history", () => {
    expect(readMetricsHistory(join(tmpRoot, "nope"))).toEqual([]);
  });

  test("a torn line is skipped, not thrown", () => {
    const dir = join(tmpRoot, "metrics");
    appendMetricsSnapshot(snap({ sessionId: "a" }), dir);
    // Corrupt the file with a torn line, then append a good one.
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(join(dir, "sessions.jsonl"), '{"sessionId":"broken"\n');
    appendMetricsSnapshot(snap({ sessionId: "c" }), dir);
    const history = readMetricsHistory(dir);
    expect(history.map((s) => s.sessionId)).toEqual(["a", "c"]);
  });
});
