/**
 * T9 ordering invariants. Subscribers see events in the order they were
 * published, and lifecycle pairs (turn_start/turn_end, tool_call_start/end)
 * are well-formed.
 */
import { describe, expect, test } from "bun:test";
import { TraceEventBus } from "./event-bus";
import type { TraceEvent } from "./types";

const baseEnvelope = (bus: TraceEventBus) => ({
  runId: bus.runId,
  sessionId: bus.sessionId,
  turnNumber: 1,
  traceId: bus.traceId,
  spanId: bus.rootSpanId,
  timestamp: new Date().toISOString(),
});

describe("TraceEventBus ordering", () => {
  test("subscribers receive events in publish order", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const seen: number[] = [];
    bus.subscribe((e) => {
      if (e.kind === "turn_start") seen.push(e.turn);
    });
    for (let t = 1; t <= 50; t += 1) {
      bus.publish({
        ...baseEnvelope(bus),
        kind: "turn_start",
        turn: t,
        messageCount: 0,
        turnNumber: t,
      });
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  test("each turn_start has a matching turn_end before any turn_start{turn:n+1}", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const events: TraceEvent[] = [];
    bus.subscribe((e) => {
      events.push(e);
    });
    for (let t = 1; t <= 5; t += 1) {
      bus.publish({
        ...baseEnvelope(bus),
        kind: "turn_start",
        turn: t,
        messageCount: 0,
        turnNumber: t,
      });
      bus.publish({
        ...baseEnvelope(bus),
        kind: "turn_end",
        turn: t,
        durationMs: 100,
        turnNumber: t,
      });
    }
    let openTurn: number | undefined;
    for (const e of events) {
      if (e.kind === "turn_start") {
        expect(openTurn).toBeUndefined();
        openTurn = e.turn;
      } else if (e.kind === "turn_end") {
        expect(openTurn).toBe(e.turn);
        openTurn = undefined;
      }
    }
    expect(openTurn).toBeUndefined();
  });

  test("tool_call_start always precedes its matching tool_call_end by toolUseId", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const events: TraceEvent[] = [];
    bus.subscribe((e) => {
      events.push(e);
    });
    const ids = ["toolu_a", "toolu_b", "toolu_c"];
    for (const id of ids) {
      bus.publish({
        ...baseEnvelope(bus),
        kind: "tool_call_start",
        toolUseId: id,
        toolName: "Bash",
        inputBytes: 5,
      });
    }
    for (const id of ids) {
      bus.publish({
        ...baseEnvelope(bus),
        kind: "tool_call_end",
        toolUseId: id,
        toolName: "Bash",
        isError: false,
        outputBytes: 10,
        durationMs: 5,
      });
    }
    const startIdx = new Map<string, number>();
    const endIdx = new Map<string, number>();
    events.forEach((e, idx) => {
      if (e.kind === "tool_call_start") startIdx.set(e.toolUseId, idx);
      if (e.kind === "tool_call_end") endIdx.set(e.toolUseId, idx);
    });
    for (const id of ids) {
      const s = startIdx.get(id);
      const en = endIdx.get(id);
      expect(s).toBeDefined();
      expect(en).toBeDefined();
      expect(s as number).toBeLessThan(en as number);
    }
  });

  test("randomized property: every turn_start{n} precedes turn_end{n} which precedes turn_start{n+1}", () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
      const events: TraceEvent[] = [];
      bus.subscribe((e) => {
        events.push(e);
      });
      const turnCount = 1 + Math.floor(Math.random() * 10);
      for (let t = 1; t <= turnCount; t += 1) {
        bus.publish({
          ...baseEnvelope(bus),
          kind: "turn_start",
          turn: t,
          messageCount: Math.floor(Math.random() * 20),
          turnNumber: t,
        });
        const innerCount = Math.floor(Math.random() * 5);
        for (let i = 0; i < innerCount; i += 1) {
          bus.publish({
            ...baseEnvelope(bus),
            kind: "tool_call_start",
            toolUseId: `tu_${t}_${i}`,
            toolName: "X",
            inputBytes: 1,
          });
          bus.publish({
            ...baseEnvelope(bus),
            kind: "tool_call_end",
            toolUseId: `tu_${t}_${i}`,
            toolName: "X",
            isError: false,
            outputBytes: 1,
            durationMs: 1,
          });
        }
        bus.publish({
          ...baseEnvelope(bus),
          kind: "turn_end",
          turn: t,
          durationMs: 5,
          turnNumber: t,
        });
      }
      let lastEndedTurn = 0;
      for (const e of events) {
        if (e.kind === "turn_start") {
          expect(e.turn).toBe(lastEndedTurn + 1);
        }
        if (e.kind === "turn_end") {
          expect(e.turn).toBe(lastEndedTurn + 1);
          lastEndedTurn = e.turn;
        }
      }
      expect(lastEndedTurn).toBe(turnCount);
    }
  });
});
