/**
 * T1 unit tests for the publisher-facing accessors on `TraceEventBus`:
 * `currentSpanId`, `turnNumber` / `setTurnNumber`, and `envelope()`. These
 * are the read paths exercised by mcp-host, hooks-engine, and
 * sub-agent-spawner when constructing fire-and-forget event envelopes.
 * Everything here is deterministic — no clock, no I/O.
 */
import { describe, expect, test } from "bun:test";
import { TraceEventBus } from "./event-bus";

describe("TraceEventBus.currentSpanId", () => {
  test("equals rootSpanId before any span is opened", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });
    expect(bus.currentSpanId).toBe(bus.rootSpanId);
  });

  test("tracks the most recently opened span and restores on end()", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });
    const span = bus.startSpan("tool_call");
    expect(bus.currentSpanId).toBe(span.spanId);
    expect(bus.currentSpanId).not.toBe(bus.rootSpanId);
    span.end();
    expect(bus.currentSpanId).toBe(bus.rootSpanId);
  });
});

describe("TraceEventBus.turnNumber / setTurnNumber", () => {
  test("starts at 0", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });
    expect(bus.turnNumber).toBe(0);
  });

  test("setTurnNumber updates the value read by the getter", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });
    bus.setTurnNumber(7);
    expect(bus.turnNumber).toBe(7);
    bus.setTurnNumber(8);
    expect(bus.turnNumber).toBe(8);
  });
});

describe("TraceEventBus.envelope", () => {
  test("builds an envelope from bus identity, current turn, trace, and current span", () => {
    const bus = new TraceEventBus({ runId: "run_x", sessionId: "sess_x", env: {} });
    bus.setTurnNumber(3);
    const now = new Date("2026-05-07T10:00:00.000Z");
    const env = bus.envelope(now);
    expect(env.runId).toBe("run_x");
    expect(env.sessionId).toBe("sess_x");
    expect(env.turnNumber).toBe(3);
    expect(env.traceId).toBe(bus.traceId);
    expect(env.parentSpanId).toBe(bus.currentSpanId);
    expect(env.parentSpanId).toBe(bus.rootSpanId);
    expect(env.timestamp).toBe("2026-05-07T10:00:00.000Z");
  });

  test("mints a fresh spanId per call distinct from the parent span", () => {
    const bus = new TraceEventBus({ runId: "run_x", sessionId: "sess_x", env: {} });
    const now = new Date("2026-05-07T10:00:00.000Z");
    const a = bus.envelope(now);
    const b = bus.envelope(now);
    expect(a.spanId).not.toBe(b.spanId);
    expect(a.spanId).not.toBe(a.parentSpanId);
  });

  test("nests under the active span when one is open", () => {
    const bus = new TraceEventBus({ runId: "run_x", sessionId: "sess_x", env: {} });
    const span = bus.startSpan("model_request");
    const env = bus.envelope(new Date("2026-05-07T10:00:00.000Z"));
    expect(env.parentSpanId).toBe(span.spanId);
  });

  test("defaults the timestamp to now when no Date is supplied", () => {
    const bus = new TraceEventBus({ runId: "run_x", sessionId: "sess_x", env: {} });
    const before = Date.now();
    const env = bus.envelope();
    const after = Date.now();
    const ts = Date.parse(env.timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("TraceEventBus async subscriber failures", () => {
  test("a rejecting async subscriber is caught during flush and counted", async () => {
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
    bus.subscribe(() => Promise.reject(new Error("async boom")));
    const now = new Date("2026-05-07T10:00:00.000Z");
    bus.publish({
      ...bus.envelope(now),
      kind: "turn_start",
      turn: 1,
      messageCount: 0,
    });
    // The rejection is registered as pending; flush settles it via the .catch.
    expect(bus.stats().subscriberFailures).toBe(0);
    await bus.flush();
    expect(bus.stats().subscriberFailures).toBe(1);
    expect(errors[0]?.msg).toBe("subscriber.failed");
    expect(errors[0]?.fields?.["message"]).toBe("async boom");
    // The pending set is drained once the promise settles.
    expect(bus.stats().subscriberFailures).toBe(1);
  });
});
