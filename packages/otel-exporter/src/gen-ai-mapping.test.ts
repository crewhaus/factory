/**
 * T2 contract test — every mapped span uses the OTel `gen_ai/*` attribute
 * names verbatim. If the OTel spec evolves we want this test to fail.
 */
import { describe, expect, test } from "bun:test";
import type {
  CompactionFiredEvent,
  ErrorRecoveredEvent,
  HookFiredEvent,
  McpCallEndEvent,
  McpCallStartEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ModelStreamTokenEvent,
  PermissionDecisionEvent,
  SubAgentEndEvent,
  SubAgentStartEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@crewhaus/trace-event-bus";
import {
  ATTR,
  GEN_AI_SYSTEM,
  type StartedMcp,
  type StartedModel,
  type StartedSubAgent,
  type StartedTool,
  type StartedTurn,
  buildCompactionSpan,
  buildErrorRecoveredSpan,
  buildHookSpan,
  buildMcpSpan,
  buildModelSpan,
  buildPermissionSpan,
  buildStreamTokenEvent,
  buildSubAgentSpan,
  buildToolSpan,
  buildTurnSpan,
  genAiSystem,
} from "./gen-ai-mapping";
import { SPAN_KIND_CLIENT, SPAN_KIND_INTERNAL, STATUS_ERROR, STATUS_OK } from "./types";

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

describe("genAiSystem — ProviderId → gen_ai.system mapping", () => {
  test("maps every canonical provider", () => {
    expect(genAiSystem("openai")).toBe("openai");
    expect(genAiSystem("gemini")).toBe("gcp.gemini");
    expect(genAiSystem("bedrock")).toBe("aws.bedrock");
    expect(genAiSystem("anthropic")).toBe(GEN_AI_SYSTEM);
    expect(genAiSystem("anthropic")).toBe("anthropic");
  });
  test("defaults undefined provider to anthropic (backwards compat)", () => {
    expect(genAiSystem(undefined)).toBe("anthropic");
  });
  test("passes through unknown provider verbatim", () => {
    expect(genAiSystem("cohere")).toBe("cohere");
  });
});

describe("buildModelSpan — provider + cache + parentSpanId branches", () => {
  test("falls back to start.ev.provider when end.provider is absent", () => {
    const start: StartedModel = {
      startNano: "1746619200000000000",
      ev: {
        ...env(),
        kind: "model_request",
        provider: "openai",
        model: "gpt-4o",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      } as ModelRequestEvent,
      streamEvents: [],
    };
    const end: ModelResponseEvent = {
      ...env(),
      kind: "model_response",
      model: "gpt-4o",
      stopReason: "stop",
      usage: { input: 10, output: 5 },
      durationMs: 100,
    };
    const span = buildModelSpan(start, end);
    expect(findAttr(span.attributes, ATTR.GEN_AI_SYSTEM)?.value).toEqual({
      stringValue: "openai",
    });
    // streaming=false threads through.
    expect(findAttr(span.attributes, ATTR.GEN_AI_REQUEST_STREAMING)?.value).toEqual({
      boolValue: false,
    });
    // No cache usage → no cache attributes, no stream events.
    expect(findAttr(span.attributes, ATTR.GEN_AI_USAGE_CACHE_READ_TOKENS)).toBeUndefined();
    expect(findAttr(span.attributes, ATTR.GEN_AI_USAGE_CACHE_CREATE_TOKENS)).toBeUndefined();
    expect(span.events).toBeUndefined();
    expect(span.kind).toBe(SPAN_KIND_CLIENT);
  });

  test("end.provider wins over start.ev.provider", () => {
    const start: StartedModel = {
      startNano: "1746619200000000000",
      ev: {
        ...env(),
        kind: "model_request",
        provider: "anthropic",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: true,
      } as ModelRequestEvent,
      streamEvents: [
        buildStreamTokenEvent({
          ...env(),
          kind: "model_stream_token",
          chunkIndex: 0,
          deltaChars: 3,
        } as ModelStreamTokenEvent),
      ],
    };
    const end: ModelResponseEvent = {
      ...env(),
      kind: "model_response",
      provider: "gemini",
      model: "m",
      stopReason: "end_turn",
      usage: { input: 1, output: 1, cacheRead: 7, cacheCreate: 9 },
      durationMs: 1,
    };
    const span = buildModelSpan(start, end);
    expect(findAttr(span.attributes, ATTR.GEN_AI_SYSTEM)?.value).toEqual({
      stringValue: "gcp.gemini",
    });
    // cache attributes present.
    expect(findAttr(span.attributes, ATTR.GEN_AI_USAGE_CACHE_READ_TOKENS)?.value).toEqual({
      intValue: "7",
    });
    expect(findAttr(span.attributes, ATTR.GEN_AI_USAGE_CACHE_CREATE_TOKENS)?.value).toEqual({
      intValue: "9",
    });
    // stream events attached.
    expect(span.events).toHaveLength(1);
  });

  test("omits parentSpanId when absent on the end event", () => {
    const start: StartedModel = {
      startNano: "1746619200000000000",
      ev: {
        ...env({ parentSpanId: undefined }),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      } as ModelRequestEvent,
      streamEvents: [],
    };
    const end: ModelResponseEvent = {
      ...env({ parentSpanId: undefined }),
      kind: "model_response",
      model: "m",
      stopReason: "end_turn",
      usage: { input: 1, output: 1 },
      durationMs: 1,
    };
    const span = buildModelSpan(start, end);
    expect("parentSpanId" in span).toBe(false);
  });
});

describe("buildTurnSpan", () => {
  const startedTurn = (): StartedTurn => ({
    startNano: "1746619200000000000",
    ev: {
      ...env(),
      kind: "turn_start",
      turn: 1,
      messageCount: 0,
    } as TurnStartEvent,
  });

  test("includes finish_reason + parentSpanId when stopReason present", () => {
    const end: TurnEndEvent = {
      ...env(),
      kind: "turn_end",
      turn: 1,
      stopReason: "end_turn",
      durationMs: 1500,
    };
    const span = buildTurnSpan(startedTurn(), end);
    expect(span.name).toBe("turn");
    expect(span.kind).toBe(SPAN_KIND_INTERNAL);
    expect(span.parentSpanId).toBe(end.parentSpanId);
    expect(findAttr(span.attributes, ATTR.GEN_AI_RESPONSE_FINISH_REASON)?.value).toEqual({
      stringValue: "end_turn",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_TURN_DURATION_MS)?.value).toEqual({
      intValue: "1500",
    });
    expect(span.status.code).toBe(STATUS_OK);
    // endTimeUnixNano derived from ISO timestamp → nanoseconds string.
    expect(span.endTimeUnixNano).toBe(`${Date.parse(end.timestamp)}000000`);
  });

  test("omits finish_reason + parentSpanId when both absent", () => {
    const end: TurnEndEvent = {
      ...env({ parentSpanId: undefined }),
      kind: "turn_end",
      turn: 1,
      durationMs: 200,
    };
    const span = buildTurnSpan(startedTurn(), end);
    expect("parentSpanId" in span).toBe(false);
    expect(findAttr(span.attributes, ATTR.GEN_AI_RESPONSE_FINISH_REASON)).toBeUndefined();
  });
});

describe("buildStreamTokenEvent", () => {
  test("maps chunk index + delta chars to a completion.chunk event", () => {
    const ev = buildStreamTokenEvent({
      ...env({ timestamp: "2026-05-07T12:00:00.500Z" }),
      kind: "model_stream_token",
      chunkIndex: 4,
      deltaChars: 12,
    } as ModelStreamTokenEvent);
    expect(ev.name).toBe("gen_ai.completion.chunk");
    expect(ev.timeUnixNano).toBe(`${Date.parse("2026-05-07T12:00:00.500Z")}000000`);
    expect(findAttr(ev.attributes ?? [], "gen_ai.completion.chunk_index")?.value).toEqual({
      intValue: "4",
    });
    expect(findAttr(ev.attributes ?? [], "gen_ai.completion.delta_chars")?.value).toEqual({
      intValue: "12",
    });
  });
});

describe("buildMcpSpan", () => {
  const startedMcp = (): StartedMcp => ({
    startNano: "1746619200000000000",
    ev: {
      ...env(),
      kind: "mcp_call_start",
      server: "filesystem",
      toolName: "read_file",
    } as McpCallStartEvent,
  });

  test("ok call → CLIENT kind, OK status, mcp.* attributes", () => {
    const end: McpCallEndEvent = {
      ...env(),
      kind: "mcp_call_end",
      server: "filesystem",
      toolName: "read_file",
      isError: false,
      durationMs: 42,
    };
    const span = buildMcpSpan(startedMcp(), end);
    expect(span.name).toBe("mcp.read_file");
    expect(span.kind).toBe(SPAN_KIND_CLIENT);
    expect(span.parentSpanId).toBe(end.parentSpanId);
    expect(findAttr(span.attributes, ATTR.MCP_SERVER_NAME)?.value).toEqual({
      stringValue: "filesystem",
    });
    expect(findAttr(span.attributes, ATTR.MCP_TOOL_NAME)?.value).toEqual({
      stringValue: "read_file",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_MCP_DURATION_MS)?.value).toEqual({
      intValue: "42",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_MCP_IS_ERROR)?.value).toEqual({
      boolValue: false,
    });
    expect(span.status.code).toBe(STATUS_OK);
  });

  test("error call → ERROR status, parentSpanId omitted when absent", () => {
    const start: StartedMcp = {
      startNano: "1746619200000000000",
      ev: {
        ...env({ parentSpanId: undefined }),
        kind: "mcp_call_start",
        server: "filesystem",
        toolName: "read_file",
      } as McpCallStartEvent,
    };
    const end: McpCallEndEvent = {
      ...env({ parentSpanId: undefined }),
      kind: "mcp_call_end",
      server: "filesystem",
      toolName: "read_file",
      isError: true,
      durationMs: 9,
    };
    const span = buildMcpSpan(start, end);
    expect(span.status.code).toBe(STATUS_ERROR);
    expect("parentSpanId" in span).toBe(false);
  });
});

describe("buildSubAgentSpan", () => {
  const startedSub = (): StartedSubAgent => ({
    startNano: "1746619200000000000",
    ev: {
      ...env(),
      kind: "sub_agent_start",
      name: "researcher",
      childRunId: "run_child",
      childSessionId: "sess_child",
      toolCount: 2,
      promptBytes: 100,
    } as SubAgentStartEvent,
  });

  test("ok sub-agent → INTERNAL kind, OK status, sub_agent.* attributes", () => {
    const end: SubAgentEndEvent = {
      ...env(),
      kind: "sub_agent_end",
      name: "researcher",
      childRunId: "run_child",
      childSessionId: "sess_child",
      isError: false,
      toolCallCount: 3,
      finalMessageBytes: 512,
      durationMs: 200,
    };
    const span = buildSubAgentSpan(startedSub(), end);
    expect(span.name).toBe("sub_agent.researcher");
    expect(span.kind).toBe(SPAN_KIND_INTERNAL);
    expect(span.parentSpanId).toBe(end.parentSpanId);
    expect(findAttr(span.attributes, ATTR.CREWHAUS_SUB_AGENT_NAME)?.value).toEqual({
      stringValue: "researcher",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_SUB_AGENT_CHILD_RUN_ID)?.value).toEqual({
      stringValue: "run_child",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_SUB_AGENT_CHILD_SESSION_ID)?.value).toEqual({
      stringValue: "sess_child",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_SUB_AGENT_TOOL_CALLS)?.value).toEqual({
      intValue: "3",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_SUB_AGENT_FINAL_BYTES)?.value).toEqual({
      intValue: "512",
    });
    expect(span.status.code).toBe(STATUS_OK);
  });

  test("error sub-agent → ERROR status, parentSpanId omitted when absent", () => {
    const start: StartedSubAgent = {
      startNano: "1746619200000000000",
      ev: {
        ...env({ parentSpanId: undefined }),
        kind: "sub_agent_start",
        name: "researcher",
        childRunId: "run_child",
        childSessionId: "sess_child",
        toolCount: 0,
        promptBytes: 1,
      } as SubAgentStartEvent,
    };
    const end: SubAgentEndEvent = {
      ...env({ parentSpanId: undefined }),
      kind: "sub_agent_end",
      name: "researcher",
      childRunId: "run_child",
      childSessionId: "sess_child",
      isError: true,
      toolCallCount: 0,
      finalMessageBytes: 0,
      durationMs: 1,
    };
    const span = buildSubAgentSpan(start, end);
    expect(span.status.code).toBe(STATUS_ERROR);
    expect("parentSpanId" in span).toBe(false);
  });
});

describe("buildHookSpan", () => {
  test("allowed hook with matcher → OK status; startNano derived via nanoFromMs", () => {
    const ts = "2026-05-07T12:00:01.000Z";
    const ev: HookFiredEvent = {
      ...env({ timestamp: ts }),
      kind: "hook_fired",
      event: "PreToolUse",
      matcher: "Bash",
      allowed: true,
      durationMs: 250,
    };
    const span = buildHookSpan(ev);
    expect(span.name).toBe("hook.PreToolUse");
    expect(span.kind).toBe(SPAN_KIND_INTERNAL);
    expect(span.parentSpanId).toBe(ev.parentSpanId);
    expect(span.status.code).toBe(STATUS_OK);
    expect(findAttr(span.attributes, ATTR.CREWHAUS_HOOK_EVENT)?.value).toEqual({
      stringValue: "PreToolUse",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_HOOK_MATCHER)?.value).toEqual({
      stringValue: "Bash",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_HOOK_ALLOWED)?.value).toEqual({
      boolValue: true,
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_HOOK_DURATION_MS)?.value).toEqual({
      intValue: "250",
    });
    // start = end - durationMs (nanoFromMs), end = isoToNano(timestamp).
    const endMs = Date.parse(ts);
    expect(span.endTimeUnixNano).toBe(`${endMs}000000`);
    expect(span.startTimeUnixNano).toBe(`${endMs - 250}000000`);
  });

  test("denied hook without matcher → ERROR status, parentSpanId omitted", () => {
    const ev: HookFiredEvent = {
      ...env({ parentSpanId: undefined }),
      kind: "hook_fired",
      event: "PreToolUse",
      allowed: false,
      durationMs: 10,
    };
    const span = buildHookSpan(ev);
    expect(span.status.code).toBe(STATUS_ERROR);
    expect("parentSpanId" in span).toBe(false);
    expect(findAttr(span.attributes, ATTR.CREWHAUS_HOOK_MATCHER)).toBeUndefined();
  });
});

describe("buildCompactionSpan", () => {
  test("zero-duration span (start==end) with compaction.* attributes", () => {
    const ts = "2026-05-07T12:00:02.000Z";
    const ev: CompactionFiredEvent = {
      ...env({ timestamp: ts }),
      kind: "compaction_fired",
      subKind: "autocompact",
      before: 9000,
      after: 4000,
      phase: "pre-turn",
    };
    const span = buildCompactionSpan(ev);
    expect(span.name).toBe("compaction.autocompact");
    expect(span.kind).toBe(SPAN_KIND_INTERNAL);
    expect(span.parentSpanId).toBe(ev.parentSpanId);
    const nano = `${Date.parse(ts)}000000`;
    expect(span.startTimeUnixNano).toBe(nano);
    expect(span.endTimeUnixNano).toBe(nano);
    expect(findAttr(span.attributes, ATTR.CREWHAUS_COMPACTION_KIND)?.value).toEqual({
      stringValue: "autocompact",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_COMPACTION_PHASE)?.value).toEqual({
      stringValue: "pre-turn",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_COMPACTION_BEFORE)?.value).toEqual({
      intValue: "9000",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_COMPACTION_AFTER)?.value).toEqual({
      intValue: "4000",
    });
    expect(span.status.code).toBe(STATUS_OK);
  });

  test("omits parentSpanId when absent", () => {
    const ev: CompactionFiredEvent = {
      ...env({ parentSpanId: undefined }),
      kind: "compaction_fired",
      subKind: "reactive",
      before: 1,
      after: 0,
      phase: "reactive",
    };
    const span = buildCompactionSpan(ev);
    expect("parentSpanId" in span).toBe(false);
  });
});

describe("buildPermissionSpan", () => {
  test("allow decision with reason → OK status", () => {
    const ev: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Bash",
      decision: "allow",
      mode: "default",
      reason: "user trusted",
    };
    const span = buildPermissionSpan(ev);
    expect(span.name).toBe("permission.allow");
    expect(span.kind).toBe(SPAN_KIND_INTERNAL);
    expect(span.parentSpanId).toBe(ev.parentSpanId);
    expect(findAttr(span.attributes, ATTR.CODE_FUNCTION)?.value).toEqual({
      stringValue: "Bash",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_PERMISSION_DECISION)?.value).toEqual({
      stringValue: "allow",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_PERMISSION_MODE)?.value).toEqual({
      stringValue: "default",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_PERMISSION_REASON)?.value).toEqual({
      stringValue: "user trusted",
    });
    expect(span.status.code).toBe(STATUS_OK);
  });

  test("deny decision without reason → ERROR status, parentSpanId omitted", () => {
    const ev: PermissionDecisionEvent = {
      ...env({ parentSpanId: undefined }),
      kind: "permission_decision",
      toolName: "Bash",
      decision: "deny",
      mode: "default",
    };
    const span = buildPermissionSpan(ev);
    expect(span.name).toBe("permission.deny");
    expect(span.status.code).toBe(STATUS_ERROR);
    expect("parentSpanId" in span).toBe(false);
    expect(findAttr(span.attributes, ATTR.CREWHAUS_PERMISSION_REASON)).toBeUndefined();
  });

  test("ask decision → OK status (only deny is an error)", () => {
    const ev: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Bash",
      decision: "ask",
      mode: "plan",
    };
    const span = buildPermissionSpan(ev);
    expect(span.status.code).toBe(STATUS_OK);
  });
});

describe("buildErrorRecoveredSpan", () => {
  test("maps recovery.* attributes; status ERROR carries errorName message", () => {
    const ev: ErrorRecoveredEvent = {
      ...env(),
      kind: "error_recovered",
      action: "retry",
      errorName: "RateLimitError",
      depth: 2,
    };
    const span = buildErrorRecoveredSpan(ev);
    expect(span.name).toBe("error_recovered.retry");
    expect(span.kind).toBe(SPAN_KIND_INTERNAL);
    expect(span.parentSpanId).toBe(ev.parentSpanId);
    expect(findAttr(span.attributes, ATTR.CREWHAUS_RECOVERY_ACTION)?.value).toEqual({
      stringValue: "retry",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_ERROR_NAME)?.value).toEqual({
      stringValue: "RateLimitError",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_RECOVERY_DEPTH)?.value).toEqual({
      intValue: "2",
    });
    expect(span.status.code).toBe(STATUS_ERROR);
    expect(span.status.message).toBe("RateLimitError");
  });

  test("omits parentSpanId when absent", () => {
    const ev: ErrorRecoveredEvent = {
      ...env({ parentSpanId: undefined }),
      kind: "error_recovered",
      action: "fail",
      errorName: "FatalError",
      depth: 0,
    };
    const span = buildErrorRecoveredSpan(ev);
    expect("parentSpanId" in span).toBe(false);
  });
});
