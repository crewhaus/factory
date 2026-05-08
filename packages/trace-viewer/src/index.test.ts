import { describe, expect, test } from "bun:test";
import type { TraceEvent, TraceEventEnvelope } from "@crewhaus/trace-event-bus";
import { buildTimeline, drilldownSpan, replay } from "./index.js";

function envelope(
  spanId: string,
  parentSpanId?: string,
  ts = "2026-05-08T00:00:00.000Z",
): TraceEventEnvelope {
  return {
    runId: "run_test",
    sessionId: "sess_0000000000000000",
    turnNumber: 0,
    traceId: "0".repeat(32),
    spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    timestamp: ts,
  };
}

describe("buildTimeline (T1 snapshot)", () => {
  test("empty events → empty timeline", () => {
    const tl = buildTimeline([]);
    expect(tl).toEqual({ t0: 0, t1: 0, spans: [] });
  });

  test("pairs model_request + model_response into one span", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("span_1", "root", "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "claude-sonnet-4-6",
        messageCount: 3,
        toolCount: 2,
        streaming: false,
      },
      {
        ...envelope("span_1", "root", "2026-05-08T00:00:01.500Z"),
        kind: "model_response",
        model: "claude-sonnet-4-6",
        stopReason: "end_turn",
        usage: { input: 100, output: 50 },
        durationMs: 1500,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.kind).toBe("model");
    expect(s.label).toBe("model: claude-sonnet-4-6");
    expect(s.t1 - s.t0).toBe(1500);
  });

  test("tool_call_start + tool_call_end pair → tool span with tool name in label", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("span_t", "model_span", "2026-05-08T00:00:00.000Z"),
        kind: "tool_call_start",
        toolUseId: "tu_1",
        toolName: "WebFetch",
        inputBytes: 32,
      },
      {
        ...envelope("span_t", "model_span", "2026-05-08T00:00:00.250Z"),
        kind: "tool_call_end",
        toolUseId: "tu_1",
        toolName: "WebFetch",
        isError: false,
        outputBytes: 1024,
        durationMs: 250,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    expect(tl.spans[0]?.label).toBe("tool: WebFetch");
  });

  test("point events (hook_fired, permission_decision, error_recovered, handoff, a2a_message, crew_done) become point spans (t0 === t1)", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("h1", "root", "2026-05-08T00:00:00.100Z"),
        kind: "hook_fired",
        event: "pre-tool",
        allowed: true,
        durationMs: 5,
      },
      {
        ...envelope("p1", "root", "2026-05-08T00:00:00.200Z"),
        kind: "permission_decision",
        toolName: "Bash",
        decision: "allow",
        mode: "default",
      },
      {
        ...envelope("ho1", "root", "2026-05-08T00:00:00.300Z"),
        kind: "handoff",
        from: "researcher",
        to: "writer",
        reason: "done",
        depth: 1,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(3);
    for (const s of tl.spans) {
      expect(s.t0).toBe(s.t1);
    }
    expect(tl.spans.find((s) => s.kind === "handoff")?.label).toBe("handoff: researcher→writer");
  });

  test("depth is computed via parentSpanId chain", () => {
    const events: TraceEvent[] = [
      // Root model span (no parent in the corpus)
      {
        ...envelope("model_root", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("model_root", undefined, "2026-05-08T00:00:01.000Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 10, output: 5 },
        durationMs: 1000,
      },
      // Tool span nested under it
      {
        ...envelope("tool_inner", "model_root", "2026-05-08T00:00:00.500Z"),
        kind: "tool_call_start",
        toolUseId: "tu",
        toolName: "T",
        inputBytes: 0,
      },
      {
        ...envelope("tool_inner", "model_root", "2026-05-08T00:00:00.700Z"),
        kind: "tool_call_end",
        toolUseId: "tu",
        toolName: "T",
        isError: false,
        outputBytes: 0,
        durationMs: 200,
      },
    ];
    const tl = buildTimeline(events);
    const root = tl.spans.find((s) => s.spanId === "model_root");
    const inner = tl.spans.find((s) => s.spanId === "tool_inner");
    expect(root?.depth).toBe(0);
    expect(inner?.depth).toBe(1);
  });

  test("corpus t0/t1 = min/max of all span boundaries", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("a", undefined, "2026-05-08T00:00:02.000Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 0, output: 0 },
        durationMs: 2000,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.t0).toBe(Date.parse("2026-05-08T00:00:00.000Z"));
    expect(tl.t1).toBe(Date.parse("2026-05-08T00:00:02.000Z"));
  });
});

describe("trace-viewer v1 — Section 31 replay + drilldown", () => {
  test("replay yields events in order with deterministic timing", async () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("a", undefined, "2026-05-08T00:00:01.000Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 10, output: 10 },
        durationMs: 1000,
      },
    ];
    const setTimeoutCalls: number[] = [];
    const stubSetTimeout = (cb: () => void, ms: number): void => {
      setTimeoutCalls.push(ms);
      cb();
    };
    const out: TraceEvent[] = [];
    for await (const ev of replay(events, { speed: 1, setTimeoutImpl: stubSetTimeout })) {
      out.push(ev);
    }
    expect(out.length).toBe(2);
    // Second event scheduled with 1000ms gap.
    expect(setTimeoutCalls).toContain(1000);
  });

  test("replay raw mode yields immediately (no setTimeout calls)", async () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("a", undefined, "2026-05-08T01:00:00.000Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 10, output: 10 },
        durationMs: 1000,
      },
    ];
    let calls = 0;
    const stubSetTimeout = (cb: () => void): void => {
      calls++;
      cb();
    };
    const out: TraceEvent[] = [];
    for await (const ev of replay(events, { speed: "raw", setTimeoutImpl: stubSetTimeout })) {
      out.push(ev);
    }
    expect(calls).toBe(0);
    expect(out.length).toBe(2);
  });

  test("replay 4× quarters the wait", async () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.400Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 10, output: 10 },
        durationMs: 400,
      },
    ];
    const calls: number[] = [];
    const stubSetTimeout = (cb: () => void, ms: number): void => {
      calls.push(ms);
      cb();
    };
    const out: TraceEvent[] = [];
    for await (const ev of replay(events, { speed: 4, setTimeoutImpl: stubSetTimeout }))
      out.push(ev);
    // 400ms gap / 4 = 100ms wait
    expect(calls).toContain(100);
  });

  test("drilldownSpan returns the span + related events", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("a", undefined, "2026-05-08T00:00:01.000Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 10, output: 10 },
        durationMs: 1000,
      },
    ];
    const tl = buildTimeline(events);
    const drilldown = drilldownSpan(tl, events, "a");
    expect(drilldown).toBeDefined();
    expect(drilldown?.events.length).toBe(2);
  });

  test("drilldownSpan returns undefined for unknown spanId", () => {
    const events: TraceEvent[] = [];
    const tl = buildTimeline(events);
    expect(drilldownSpan(tl, events, "missing")).toBeUndefined();
  });
});
