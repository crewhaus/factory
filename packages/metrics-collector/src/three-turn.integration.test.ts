/**
 * T3 integration — drive the bus through 3 simulated turns plus one Bash
 * tool call, then assert the headline counter values.
 */
import { describe, expect, test } from "bun:test";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { attachMetricsCollector } from "./index";

const env = (bus: TraceEventBus, overrides: Partial<TraceEvent> = {}) => ({
  runId: bus.runId,
  sessionId: bus.sessionId,
  turnNumber: 1,
  traceId: bus.traceId,
  spanId: bus.rootSpanId,
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe("metrics-collector three-turn integration", () => {
  test("three turns + one Bash tool call produces the expected headline counters", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const metrics = await attachMetricsCollector(bus, {
      sink: { kind: "stdout" },
      stdoutWrite: () => {
        // suppressed
      },
    });

    // Turn 1: includes the Bash tool call
    bus.publish({ ...env(bus), kind: "turn_start", turn: 1, messageCount: 0 });
    bus.publish({
      ...env(bus),
      kind: "model_request",
      model: "claude-opus-4-7",
      messageCount: 1,
      toolCount: 1,
      streaming: true,
    });
    bus.publish({
      ...env(bus),
      kind: "model_response",
      model: "claude-opus-4-7",
      stopReason: "tool_use",
      usage: { input: 100, output: 30 },
      durationMs: 800,
    });
    bus.publish({
      ...env(bus),
      kind: "tool_call_start",
      toolUseId: "toolu_a",
      toolName: "Bash",
      inputBytes: 20,
    });
    bus.publish({
      ...env(bus),
      kind: "tool_call_end",
      toolUseId: "toolu_a",
      toolName: "Bash",
      isError: false,
      outputBytes: 50,
      durationMs: 12,
    });
    bus.publish({
      ...env(bus),
      kind: "model_request",
      model: "claude-opus-4-7",
      messageCount: 3,
      toolCount: 1,
      streaming: true,
    });
    bus.publish({
      ...env(bus),
      kind: "model_response",
      model: "claude-opus-4-7",
      stopReason: "end_turn",
      usage: { input: 150, output: 60 },
      durationMs: 700,
    });
    bus.publish({ ...env(bus), kind: "turn_end", turn: 1, durationMs: 1500 });

    // Turns 2 and 3: no tool calls
    for (let t = 2; t <= 3; t += 1) {
      bus.publish({ ...env(bus), kind: "turn_start", turn: t, messageCount: 0 });
      bus.publish({
        ...env(bus),
        kind: "model_request",
        model: "claude-opus-4-7",
        messageCount: 1,
        toolCount: 0,
        streaming: true,
      });
      bus.publish({
        ...env(bus),
        kind: "model_response",
        model: "claude-opus-4-7",
        stopReason: "end_turn",
        usage: { input: 50, output: 20 },
        durationMs: 500,
      });
      bus.publish({ ...env(bus), kind: "turn_end", turn: t, durationMs: 600 });
    }

    const snap = metrics.registry.jsonSnapshot();
    expect(snap.counters["crewhaus_turns_total"]?.[0]?.value).toBe(3);
    const bashRow = snap.counters["crewhaus_tool_calls_total"]?.find(
      (s) => s.labels["tool"] === "Bash",
    );
    expect(bashRow?.value).toBe(1);
    const inTokens = snap.counters["crewhaus_tokens_total"]?.find(
      (s) => s.labels["direction"] === "in",
    );
    const outTokens = snap.counters["crewhaus_tokens_total"]?.find(
      (s) => s.labels["direction"] === "out",
    );
    expect(inTokens?.value).toBe(100 + 150 + 50 + 50);
    expect(outTokens?.value).toBe(30 + 60 + 20 + 20);

    let captured = "";
    const m2 = await attachMetricsCollector(bus, {
      sink: { kind: "stdout" },
      stdoutWrite: (c) => {
        captured += c;
      },
    });
    await m2.flush();
    expect(captured).toContain("crewhaus_turns_total");
    await metrics.shutdown();
    await m2.shutdown();
  });
});
