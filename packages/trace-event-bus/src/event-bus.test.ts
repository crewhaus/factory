/**
 * T1 unit tests for `TraceEventBus`: subscribe/publish, ring-buffer eviction,
 * `recent({ since, kinds })` filtering, ephemeral handling, traceparent
 * round-trip.
 */
import { describe, expect, test } from "bun:test";
import { TraceEventBus } from "./event-bus";
import { formatTraceparent, isValidSpanId, isValidTraceId, parseTraceparent } from "./traceparent";
import type { TraceEvent } from "./types";

const baseEnvelope = (bus: TraceEventBus, overrides: Partial<TraceEvent> = {}) => ({
  runId: bus.runId,
  sessionId: bus.sessionId,
  turnNumber: 1,
  traceId: bus.traceId,
  spanId: bus.rootSpanId,
  timestamp: new Date().toISOString(),
  ...overrides,
});

const turnStartAt = (bus: TraceEventBus, turn: number, isoTimestamp?: string): TraceEvent => ({
  ...baseEnvelope(bus, { turnNumber: turn }),
  kind: "turn_start",
  turn,
  messageCount: 0,
  timestamp: isoTimestamp ?? new Date().toISOString(),
});

describe("TraceEventBus.subscribe + publish", () => {
  test("subscriber receives every published event in order", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const seen: TraceEvent[] = [];
    bus.subscribe((e) => {
      seen.push(e);
    });
    bus.publish(turnStartAt(bus, 1));
    bus.publish(turnStartAt(bus, 2));
    expect(seen).toHaveLength(2);
    expect(seen[0]?.kind).toBe("turn_start");
  });

  test("unsubscribe removes the handler", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const seen: TraceEvent[] = [];
    const unsub = bus.subscribe((e) => {
      seen.push(e);
    });
    bus.publish(turnStartAt(bus, 1));
    unsub();
    bus.publish(turnStartAt(bus, 2));
    expect(seen).toHaveLength(1);
  });

  test("subscriber exception is isolated and logged", () => {
    const errors: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
    const stubLogger = {
      debug() {},
      info() {},
      warn() {},
      error(msg: string, fields?: Record<string, unknown>) {
        errors.push({ msg, fields });
      },
      child() {
        return stubLogger;
      },
    };
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", logger: stubLogger });
    bus.subscribe(() => {
      throw new Error("boom");
    });
    const seen: TraceEvent[] = [];
    bus.subscribe((e) => {
      seen.push(e);
    });
    bus.publish(turnStartAt(bus, 1));
    expect(seen).toHaveLength(1);
    expect(bus.stats().subscriberFailures).toBe(1);
    expect(errors[0]?.msg).toBe("subscriber.failed");
    expect(errors[0]?.fields?.["message"]).toBe("boom");
  });

  test("flush awaits async subscribers", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    let resolved = false;
    bus.subscribe(async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
    });
    bus.publish(turnStartAt(bus, 1));
    expect(resolved).toBe(false);
    await bus.flush();
    expect(resolved).toBe(true);
  });
});

describe("TraceEventBus.recent (ring buffer)", () => {
  test("evicts oldest events past capacity", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", ringSize: 3 });
    bus.publish(turnStartAt(bus, 1));
    bus.publish(turnStartAt(bus, 2));
    bus.publish(turnStartAt(bus, 3));
    bus.publish(turnStartAt(bus, 4));
    const recent = bus.recent();
    expect(recent.map((e) => (e.kind === "turn_start" ? e.turn : -1))).toEqual([2, 3, 4]);
  });

  test("filters by `since` timestamp", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    bus.publish(turnStartAt(bus, 1, "2026-05-07T10:00:00.000Z"));
    bus.publish(turnStartAt(bus, 2, "2026-05-07T11:00:00.000Z"));
    bus.publish(turnStartAt(bus, 3, "2026-05-07T12:00:00.000Z"));
    const recent = bus.recent({ since: "2026-05-07T10:30:00.000Z" });
    expect(recent.map((e) => (e.kind === "turn_start" ? e.turn : -1))).toEqual([2, 3]);
  });

  test("filters by `kinds`", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    bus.publish(turnStartAt(bus, 1));
    bus.publish({
      ...baseEnvelope(bus),
      kind: "turn_end",
      turn: 1,
      durationMs: 100,
    });
    const recent = bus.recent({ kinds: ["turn_start"] });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.kind).toBe("turn_start");
  });

  test("ephemeral events reach subscribers but are not stored", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const seen: TraceEvent[] = [];
    bus.subscribe((e) => {
      seen.push(e);
    });
    bus.publish(
      {
        ...baseEnvelope(bus),
        kind: "model_stream_token",
        chunkIndex: 0,
        deltaChars: 10,
      },
      { ephemeral: true },
    );
    bus.publish(turnStartAt(bus, 1));
    expect(seen).toHaveLength(2);
    const recent = bus.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0]?.kind).toBe("turn_start");
  });
});

describe("TraceEventBus traceparent / span helpers", () => {
  test("mints fresh traceId/spanId when no inheritance and no env", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });
    expect(isValidTraceId(bus.traceId)).toBe(true);
    expect(isValidSpanId(bus.rootSpanId)).toBe(true);
    expect(bus.rootParentSpanId).toBeUndefined();
  });

  test("inherits traceId when provided", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentSpanId = "00f067aa0ba902b7";
    const bus = new TraceEventBus({
      runId: "run_a",
      sessionId: "sess_1",
      inheritTraceId: traceId,
      inheritParentSpanId: parentSpanId,
    });
    expect(bus.traceId).toBe(traceId);
    expect(bus.rootParentSpanId).toBe(parentSpanId);
  });

  test("reads TRACEPARENT env when no inheritance", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentSpanId = "00f067aa0ba902b7";
    const bus = new TraceEventBus({
      runId: "run_a",
      sessionId: "sess_1",
      env: { TRACEPARENT: `00-${traceId}-${parentSpanId}-01` },
    });
    expect(bus.traceId).toBe(traceId);
    expect(bus.rootParentSpanId).toBe(parentSpanId);
  });

  test("currentTraceparent round-trips through parseTraceparent", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });
    const tp = bus.currentTraceparent();
    const parsed = parseTraceparent(tp);
    expect(parsed?.traceId).toBe(bus.traceId);
    expect(parsed?.parentSpanId).toBe(bus.rootSpanId);
  });

  test("startSpan returns a child whose parentSpanId is the bus's current span", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });
    const span = bus.startSpan("model_request");
    expect(span.traceId).toBe(bus.traceId);
    expect(span.parentSpanId).toBe(bus.rootSpanId);
    const elapsed = span.end();
    expect(typeof elapsed).toBe("number");
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  test("startSpan(parent) accepts another span as the parent", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });
    const outer = bus.startSpan("turn");
    const inner = bus.startSpan("model_request", outer);
    expect(inner.parentSpanId).toBe(outer.spanId);
  });

  test("formatTraceparent + parseTraceparent round-trip", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const tp = formatTraceparent(traceId, spanId);
    const parsed = parseTraceparent(tp);
    expect(parsed).toEqual({ traceId, parentSpanId: spanId, flags: 1 });
  });

  test("parseTraceparent rejects malformed input", () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent("not-a-traceparent")).toBeUndefined();
    expect(parseTraceparent("00-shorttrace-00f067aa0ba902b7-01")).toBeUndefined();
    expect(parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
  });
});

describe("TraceEventBus agentId (Batch C, item 4)", () => {
  test("envelope() stamps agentId when the bus carries one", () => {
    const bus = new TraceEventBus({
      runId: "run_a",
      sessionId: "sess_1",
      agentId: "ed25519:abc123",
      env: {},
    });
    expect(bus.agentId).toBe("ed25519:abc123");
    const env = bus.envelope();
    expect(env.agentId).toBe("ed25519:abc123");
  });

  test("envelope() omits agentId entirely when the bus has none", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });
    expect(bus.agentId).toBeUndefined();
    const env = bus.envelope();
    expect(env.agentId).toBeUndefined();
    expect("agentId" in env).toBe(false);
  });

  test("a child bus can inherit the parent's agentId so the whole trace attributes to one agent", () => {
    const parent = new TraceEventBus({
      runId: "run_a",
      sessionId: "sess_1",
      agentId: "ed25519:parent",
      env: {},
    });
    const child = new TraceEventBus({
      runId: "run_child",
      sessionId: "sess_child",
      inheritTraceId: parent.traceId,
      inheritParentSpanId: parent.currentSpanId,
      agentId: parent.agentId,
      env: {},
    });
    expect(child.envelope().agentId).toBe("ed25519:parent");
    expect(child.traceId).toBe(parent.traceId);
  });
});

describe("TraceEventBus — Batch C approval events round-trip the ring", () => {
  test("approval_requested + approval_resolved publish, store, and query by kind", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });
    const requested: TraceEvent = {
      ...baseEnvelope(bus),
      kind: "approval_requested",
      approvalId: "appr_1",
      toolName: "Bash",
      surface: "single-turn",
    };
    const resolved: TraceEvent = {
      ...baseEnvelope(bus),
      kind: "approval_resolved",
      approvalId: "appr_1",
      decision: "grant",
      by: "cli",
    };
    const seen: TraceEvent[] = [];
    bus.subscribe((e) => {
      seen.push(e);
    });
    bus.publish(requested);
    bus.publish(resolved);
    expect(seen.map((e) => e.kind)).toEqual(["approval_requested", "approval_resolved"]);
    const parked = bus.recent({ kinds: ["approval_requested"] });
    expect(parked).toHaveLength(1);
    const only = parked[0];
    expect(only?.kind === "approval_requested" && only.approvalId).toBe("appr_1");
  });
});
