/**
 * T1 unit tests — pretty formatter golden-file coverage per kind.
 */
import { describe, expect, test } from "bun:test";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { formatJsonLine } from "./json";
import { formatLine } from "./pretty";

const env = (overrides: Partial<TraceEvent> = {}) => ({
  runId: "run_a",
  sessionId: "sess_1",
  turnNumber: 1,
  traceId: `${"0".repeat(31)}1`,
  spanId: `${"0".repeat(15)}1`,
  timestamp: "2026-05-07T12:00:00.000Z",
  ...overrides,
});

describe("formatLine — pretty", () => {
  test("turn_start", () => {
    const ev = { ...env(), kind: "turn_start", turn: 3, messageCount: 7 } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      "2026-05-07T12:00:00.000Z [turn_start]           turn=3 messages=7",
    );
  });

  test("turn_end with stop reason", () => {
    const ev = {
      ...env(),
      kind: "turn_end",
      turn: 3,
      durationMs: 1234.5,
      stopReason: "end_turn",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      "2026-05-07T12:00:00.000Z [turn_end]             turn=3 duration=1235ms stop=end_turn",
    );
  });

  test("model_request streaming", () => {
    const ev = {
      ...env(),
      kind: "model_request",
      model: "claude-opus-4-7",
      messageCount: 5,
      toolCount: 3,
      streaming: true,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      "2026-05-07T12:00:00.000Z [model_request]        model=claude-opus-4-7 messages=5 tools=3 streaming",
    );
  });

  test("tool_call_end with error", () => {
    const ev = {
      ...env(),
      kind: "tool_call_end",
      toolUseId: "toolu_x",
      toolName: "Bash",
      isError: true,
      outputBytes: 256,
      durationMs: 42,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      "2026-05-07T12:00:00.000Z [tool_call_end]        tool=Bash id=toolu_x ERROR output=256B duration=42ms",
    );
  });

  test("model_response with usage", () => {
    const ev = {
      ...env(),
      kind: "model_response",
      model: "claude-opus-4-7",
      stopReason: "end_turn",
      usage: { input: 100, output: 50 },
      durationMs: 1000,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      "2026-05-07T12:00:00.000Z [model_response]       model=claude-opus-4-7 stop=end_turn in=100 out=50 duration=1000ms",
    );
  });
});

describe("formatJsonLine — JSON Lines", () => {
  test("emits a single JSON object terminated by newline", () => {
    const ev = { ...env(), kind: "turn_start", turn: 1, messageCount: 0 } satisfies TraceEvent;
    const line = formatJsonLine(ev);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.kind).toBe("turn_start");
    expect(parsed.turn).toBe(1);
    expect(parsed.runId).toBe("run_a");
  });
});
