/**
 * T2 contract test — every mapped span uses the OTel `gen_ai/*` attribute
 * names verbatim. If the OTel spec evolves we want this test to fail.
 */
import { describe, expect, test } from "bun:test";
import type {
  ModelRequestEvent,
  ModelResponseEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "@crewhaus/trace-event-bus";
import { ATTR, buildModelSpan, buildToolSpan } from "./gen-ai-mapping";

const env = (overrides: Record<string, unknown> = {}) => ({
  runId: "run_a",
  sessionId: "sess_1",
  turnNumber: 1,
  traceId: `${"0".repeat(31)}1`,
  spanId: `${"0".repeat(15)}1`,
  parentSpanId: `${"0".repeat(15)}2`,
  timestamp: "2026-05-07T12:00:00.000Z",
  ...overrides,
});

const findAttr = (attrs: { key: string; value: unknown }[], key: string) =>
  attrs.find((a) => a.key === key);

describe("gen_ai mapping — model span", () => {
  test("attribute keys match the OTel GenAI semantic conventions", () => {
    const start = {
      startNano: "1746619200000000000",
      ev: {
        ...env(),
        kind: "model_request",
        model: "claude-opus-4-7",
        messageCount: 3,
        toolCount: 1,
        streaming: true,
      } as ModelRequestEvent,
      streamEvents: [],
    };
    const end: ModelResponseEvent = {
      ...env(),
      kind: "model_response",
      model: "claude-opus-4-7",
      stopReason: "end_turn",
      usage: { input: 100, output: 50, cacheRead: 5, cacheCreate: 2 },
      durationMs: 1000,
    };
    const span = buildModelSpan(start, end);
    expect(span.name).toBe("gen_ai.chat");
    const keys = span.attributes.map((a) => a.key);
    expect(keys).toContain("gen_ai.system");
    expect(keys).toContain("gen_ai.operation.name");
    expect(keys).toContain("gen_ai.request.model");
    expect(keys).toContain("gen_ai.usage.input_tokens");
    expect(keys).toContain("gen_ai.usage.output_tokens");
    expect(keys).toContain("gen_ai.response.finish_reason");
    expect(keys).toContain("gen_ai.usage.cache_read_input_tokens");
    expect(keys).toContain("gen_ai.usage.cache_creation_input_tokens");
    const system = findAttr(span.attributes, "gen_ai.system");
    expect(system?.value).toEqual({ stringValue: "anthropic" });
    const inputTokens = findAttr(span.attributes, "gen_ai.usage.input_tokens");
    expect(inputTokens?.value).toEqual({ intValue: "100" });
  });
});

describe("gen_ai mapping — tool span", () => {
  test("uses code.function and crewhaus.tool.* extension keys", () => {
    const start = {
      startNano: "1746619200000000000",
      ev: {
        ...env(),
        kind: "tool_call_start",
        toolUseId: "toolu_a",
        toolName: "Bash",
        inputBytes: 30,
      } as ToolCallStartEvent,
    };
    const end: ToolCallEndEvent = {
      ...env(),
      kind: "tool_call_end",
      toolUseId: "toolu_a",
      toolName: "Bash",
      isError: false,
      outputBytes: 200,
      durationMs: 12,
    };
    const span = buildToolSpan(start, end);
    expect(span.name).toBe("tool.Bash");
    const codeFn = findAttr(span.attributes, ATTR.CODE_FUNCTION);
    expect(codeFn?.value).toEqual({ stringValue: "Bash" });
    const isError = findAttr(span.attributes, ATTR.CREWHAUS_TOOL_IS_ERROR);
    expect(isError?.value).toEqual({ boolValue: false });
  });

  test("error tool sets STATUS_ERROR (code=2)", () => {
    const start = {
      startNano: "1746619200000000000",
      ev: {
        ...env(),
        kind: "tool_call_start",
        toolUseId: "toolu_a",
        toolName: "Bash",
        inputBytes: 30,
      } as ToolCallStartEvent,
    };
    const end: ToolCallEndEvent = {
      ...env(),
      kind: "tool_call_end",
      toolUseId: "toolu_a",
      toolName: "Bash",
      isError: true,
      outputBytes: 200,
      durationMs: 12,
    };
    const span = buildToolSpan(start, end);
    expect(span.status.code).toBe(2);
  });
});
