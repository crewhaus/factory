/**
 * Maps `TraceEvent` pairs into OTLP spans using the OpenTelemetry GenAI
 * semantic conventions.
 *
 * Reference: https://opentelemetry.io/docs/specification/genai/llm-spans/
 *   - gen_ai.system           e.g. "anthropic"
 *   - gen_ai.operation.name   e.g. "chat"
 *   - gen_ai.request.model    e.g. "claude-opus-4-7"
 *   - gen_ai.usage.input_tokens / output_tokens
 *   - gen_ai.response.finish_reason
 *
 * Tool spans are recorded under `code.function = <toolName>` plus our
 * `crewhaus.tool.*` extension keys.
 */
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
  type Attribute,
  type OtelSpan,
  SPAN_KIND_CLIENT,
  SPAN_KIND_INTERNAL,
  STATUS_ERROR,
  STATUS_OK,
  type SpanEvent,
} from "./types";

export const GEN_AI_SYSTEM = "anthropic";

/**
 * Section 17 — map our internal `ProviderId` to the OTel GenAI
 * `gen_ai.system` value. Defaults to "anthropic" for backwards
 * compatibility (events emitted before the multi-provider refactor
 * had no `provider` field).
 *
 * OTel canonical values: https://opentelemetry.io/docs/specification/genai/
 *   - "anthropic" → Anthropic Messages API
 *   - "openai"    → OpenAI Chat Completions / Responses
 *   - "gcp.gemini" → Google Gemini
 *   - "aws.bedrock" → AWS Bedrock
 */
export function genAiSystem(provider: string | undefined): string {
  switch (provider) {
    case "openai":
      return "openai";
    case "gemini":
      return "gcp.gemini";
    case "bedrock":
      return "aws.bedrock";
    case "anthropic":
    case undefined:
      return GEN_AI_SYSTEM;
    default:
      return provider;
  }
}

export const ATTR = {
  GEN_AI_SYSTEM: "gen_ai.system",
  GEN_AI_OPERATION_NAME: "gen_ai.operation.name",
  GEN_AI_REQUEST_MODEL: "gen_ai.request.model",
  GEN_AI_USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  GEN_AI_USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  GEN_AI_USAGE_CACHE_READ_TOKENS: "gen_ai.usage.cache_read_input_tokens",
  GEN_AI_USAGE_CACHE_CREATE_TOKENS: "gen_ai.usage.cache_creation_input_tokens",
  GEN_AI_RESPONSE_FINISH_REASON: "gen_ai.response.finish_reason",
  GEN_AI_REQUEST_STREAMING: "gen_ai.request.streaming",
  CODE_FUNCTION: "code.function",
  MCP_SERVER_NAME: "mcp.server.name",
  MCP_TOOL_NAME: "mcp.tool.name",
  CREWHAUS_RUN_ID: "crewhaus.run.id",
  CREWHAUS_SESSION_ID: "crewhaus.session.id",
  CREWHAUS_TURN_NUMBER: "crewhaus.turn.number",
  CREWHAUS_TOOL_INPUT_BYTES: "crewhaus.tool.input_bytes",
  CREWHAUS_TOOL_OUTPUT_BYTES: "crewhaus.tool.output_bytes",
  CREWHAUS_TOOL_IS_ERROR: "crewhaus.tool.is_error",
  CREWHAUS_TOOL_DURATION_MS: "crewhaus.tool.duration_ms",
  CREWHAUS_MCP_DURATION_MS: "crewhaus.mcp.duration_ms",
  CREWHAUS_MCP_IS_ERROR: "crewhaus.mcp.is_error",
  CREWHAUS_TURN_NUMBER_END: "crewhaus.turn.number",
  CREWHAUS_TURN_DURATION_MS: "crewhaus.turn.duration_ms",
  CREWHAUS_HOOK_EVENT: "crewhaus.hook.event",
  CREWHAUS_HOOK_MATCHER: "crewhaus.hook.matcher",
  CREWHAUS_HOOK_ALLOWED: "crewhaus.hook.allowed",
  CREWHAUS_HOOK_DURATION_MS: "crewhaus.hook.duration_ms",
  CREWHAUS_COMPACTION_KIND: "crewhaus.compaction.kind",
  CREWHAUS_COMPACTION_PHASE: "crewhaus.compaction.phase",
  CREWHAUS_COMPACTION_BEFORE: "crewhaus.compaction.before",
  CREWHAUS_COMPACTION_AFTER: "crewhaus.compaction.after",
  CREWHAUS_PERMISSION_DECISION: "crewhaus.permission.decision",
  CREWHAUS_PERMISSION_MODE: "crewhaus.permission.mode",
  CREWHAUS_PERMISSION_REASON: "crewhaus.permission.reason",
  CREWHAUS_RECOVERY_ACTION: "crewhaus.recovery.action",
  CREWHAUS_ERROR_NAME: "crewhaus.error.name",
  CREWHAUS_RECOVERY_DEPTH: "crewhaus.recovery.depth",
  CREWHAUS_SUB_AGENT_NAME: "crewhaus.sub_agent.name",
  CREWHAUS_SUB_AGENT_CHILD_RUN_ID: "crewhaus.sub_agent.child_run_id",
  CREWHAUS_SUB_AGENT_CHILD_SESSION_ID: "crewhaus.sub_agent.child_session_id",
  CREWHAUS_SUB_AGENT_TOOL_CALLS: "crewhaus.sub_agent.tool_calls",
  CREWHAUS_SUB_AGENT_FINAL_BYTES: "crewhaus.sub_agent.final_message_bytes",
} as const;

function attrStr(key: string, v: string): Attribute {
  return { key, value: { stringValue: v } };
}

function attrInt(key: string, v: number): Attribute {
  return { key, value: { intValue: String(Math.trunc(v)) } };
}

function attrBool(key: string, v: boolean): Attribute {
  return { key, value: { boolValue: v } };
}

function isoToNano(iso: string): string {
  return `${BigInt(Date.parse(iso))}000000`;
}

function nanoFromMs(ms: number): string {
  return `${BigInt(Math.trunc(ms))}000000`;
}

function envelopeAttrs(ev: { runId: string; sessionId: string; turnNumber: number }): Attribute[] {
  return [
    attrStr(ATTR.CREWHAUS_RUN_ID, ev.runId),
    attrStr(ATTR.CREWHAUS_SESSION_ID, ev.sessionId),
    attrInt(ATTR.CREWHAUS_TURN_NUMBER, ev.turnNumber),
  ];
}

export type StartedTurn = {
  startNano: string;
  ev: TurnStartEvent;
};

export type StartedModel = {
  startNano: string;
  ev: ModelRequestEvent;
  streamEvents: SpanEvent[];
};

export type StartedTool = {
  startNano: string;
  ev: ToolCallStartEvent;
};

export type StartedMcp = {
  startNano: string;
  ev: McpCallStartEvent;
};

export type StartedSubAgent = {
  startNano: string;
  ev: SubAgentStartEvent;
};

export function buildTurnSpan(start: StartedTurn, end: TurnEndEvent): OtelSpan {
  return {
    traceId: end.traceId,
    spanId: end.spanId,
    ...(end.parentSpanId ? { parentSpanId: end.parentSpanId } : {}),
    name: "turn",
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: start.startNano,
    endTimeUnixNano: isoToNano(end.timestamp),
    attributes: [
      ...envelopeAttrs(end),
      attrInt(ATTR.CREWHAUS_TURN_NUMBER_END, end.turn),
      attrInt(ATTR.CREWHAUS_TURN_DURATION_MS, end.durationMs),
      ...(end.stopReason ? [attrStr(ATTR.GEN_AI_RESPONSE_FINISH_REASON, end.stopReason)] : []),
    ],
    status: { code: STATUS_OK },
  };
}

export function buildModelSpan(start: StartedModel, end: ModelResponseEvent): OtelSpan {
  const attrs: Attribute[] = [
    ...envelopeAttrs(end),
    attrStr(ATTR.GEN_AI_SYSTEM, genAiSystem(end.provider ?? start.ev.provider)),
    attrStr(ATTR.GEN_AI_OPERATION_NAME, "chat"),
    attrStr(ATTR.GEN_AI_REQUEST_MODEL, end.model),
    attrInt(ATTR.GEN_AI_USAGE_INPUT_TOKENS, end.usage.input),
    attrInt(ATTR.GEN_AI_USAGE_OUTPUT_TOKENS, end.usage.output),
    attrStr(ATTR.GEN_AI_RESPONSE_FINISH_REASON, end.stopReason),
    attrBool(ATTR.GEN_AI_REQUEST_STREAMING, start.ev.streaming),
  ];
  if (end.usage.cacheRead !== undefined) {
    attrs.push(attrInt(ATTR.GEN_AI_USAGE_CACHE_READ_TOKENS, end.usage.cacheRead));
  }
  if (end.usage.cacheCreate !== undefined) {
    attrs.push(attrInt(ATTR.GEN_AI_USAGE_CACHE_CREATE_TOKENS, end.usage.cacheCreate));
  }
  return {
    traceId: end.traceId,
    spanId: end.spanId,
    ...(end.parentSpanId ? { parentSpanId: end.parentSpanId } : {}),
    name: "gen_ai.chat",
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: start.startNano,
    endTimeUnixNano: isoToNano(end.timestamp),
    attributes: attrs,
    events: start.streamEvents.length > 0 ? start.streamEvents : undefined,
    status: { code: STATUS_OK },
  };
}

export function buildStreamTokenEvent(token: ModelStreamTokenEvent): SpanEvent {
  return {
    timeUnixNano: isoToNano(token.timestamp),
    name: "gen_ai.completion.chunk",
    attributes: [
      attrInt("gen_ai.completion.chunk_index", token.chunkIndex),
      attrInt("gen_ai.completion.delta_chars", token.deltaChars),
    ],
  };
}

export function buildToolSpan(start: StartedTool, end: ToolCallEndEvent): OtelSpan {
  return {
    traceId: end.traceId,
    spanId: end.spanId,
    ...(end.parentSpanId ? { parentSpanId: end.parentSpanId } : {}),
    name: `tool.${end.toolName}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: start.startNano,
    endTimeUnixNano: isoToNano(end.timestamp),
    attributes: [
      ...envelopeAttrs(end),
      attrStr(ATTR.CODE_FUNCTION, end.toolName),
      attrInt(ATTR.CREWHAUS_TOOL_INPUT_BYTES, start.ev.inputBytes),
      attrInt(ATTR.CREWHAUS_TOOL_OUTPUT_BYTES, end.outputBytes),
      attrBool(ATTR.CREWHAUS_TOOL_IS_ERROR, end.isError),
      attrInt(ATTR.CREWHAUS_TOOL_DURATION_MS, end.durationMs),
    ],
    status: end.isError ? { code: STATUS_ERROR } : { code: STATUS_OK },
  };
}

export function buildMcpSpan(start: StartedMcp, end: McpCallEndEvent): OtelSpan {
  return {
    traceId: end.traceId,
    spanId: end.spanId,
    ...(end.parentSpanId ? { parentSpanId: end.parentSpanId } : {}),
    name: `mcp.${end.toolName}`,
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: start.startNano,
    endTimeUnixNano: isoToNano(end.timestamp),
    attributes: [
      ...envelopeAttrs(end),
      attrStr(ATTR.MCP_SERVER_NAME, end.server),
      attrStr(ATTR.MCP_TOOL_NAME, end.toolName),
      attrInt(ATTR.CREWHAUS_MCP_DURATION_MS, end.durationMs),
      attrBool(ATTR.CREWHAUS_MCP_IS_ERROR, end.isError),
    ],
    status: end.isError ? { code: STATUS_ERROR } : { code: STATUS_OK },
  };
}

export function buildSubAgentSpan(start: StartedSubAgent, end: SubAgentEndEvent): OtelSpan {
  return {
    traceId: end.traceId,
    spanId: end.spanId,
    ...(end.parentSpanId ? { parentSpanId: end.parentSpanId } : {}),
    name: `sub_agent.${end.name}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: start.startNano,
    endTimeUnixNano: isoToNano(end.timestamp),
    attributes: [
      ...envelopeAttrs(end),
      attrStr(ATTR.CREWHAUS_SUB_AGENT_NAME, end.name),
      attrStr(ATTR.CREWHAUS_SUB_AGENT_CHILD_RUN_ID, end.childRunId),
      attrStr(ATTR.CREWHAUS_SUB_AGENT_CHILD_SESSION_ID, end.childSessionId),
      attrInt(ATTR.CREWHAUS_SUB_AGENT_TOOL_CALLS, end.toolCallCount),
      attrInt(ATTR.CREWHAUS_SUB_AGENT_FINAL_BYTES, end.finalMessageBytes),
    ],
    status: end.isError ? { code: STATUS_ERROR } : { code: STATUS_OK },
  };
}

export function buildHookSpan(ev: HookFiredEvent): OtelSpan {
  const endNano = isoToNano(ev.timestamp);
  const startNano = nanoFromMs(Date.parse(ev.timestamp) - ev.durationMs);
  return {
    traceId: ev.traceId,
    spanId: ev.spanId,
    ...(ev.parentSpanId ? { parentSpanId: ev.parentSpanId } : {}),
    name: `hook.${ev.event}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: [
      ...envelopeAttrs(ev),
      attrStr(ATTR.CREWHAUS_HOOK_EVENT, ev.event),
      ...(ev.matcher ? [attrStr(ATTR.CREWHAUS_HOOK_MATCHER, ev.matcher)] : []),
      attrBool(ATTR.CREWHAUS_HOOK_ALLOWED, ev.allowed),
      attrInt(ATTR.CREWHAUS_HOOK_DURATION_MS, ev.durationMs),
    ],
    status: ev.allowed ? { code: STATUS_OK } : { code: STATUS_ERROR },
  };
}

export function buildCompactionSpan(ev: CompactionFiredEvent): OtelSpan {
  const endNano = isoToNano(ev.timestamp);
  return {
    traceId: ev.traceId,
    spanId: ev.spanId,
    ...(ev.parentSpanId ? { parentSpanId: ev.parentSpanId } : {}),
    name: `compaction.${ev.subKind}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: endNano,
    endTimeUnixNano: endNano,
    attributes: [
      ...envelopeAttrs(ev),
      attrStr(ATTR.CREWHAUS_COMPACTION_KIND, ev.subKind),
      attrStr(ATTR.CREWHAUS_COMPACTION_PHASE, ev.phase),
      attrInt(ATTR.CREWHAUS_COMPACTION_BEFORE, ev.before),
      attrInt(ATTR.CREWHAUS_COMPACTION_AFTER, ev.after),
    ],
    status: { code: STATUS_OK },
  };
}

export function buildPermissionSpan(ev: PermissionDecisionEvent): OtelSpan {
  const endNano = isoToNano(ev.timestamp);
  return {
    traceId: ev.traceId,
    spanId: ev.spanId,
    ...(ev.parentSpanId ? { parentSpanId: ev.parentSpanId } : {}),
    name: `permission.${ev.decision}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: endNano,
    endTimeUnixNano: endNano,
    attributes: [
      ...envelopeAttrs(ev),
      attrStr(ATTR.CODE_FUNCTION, ev.toolName),
      attrStr(ATTR.CREWHAUS_PERMISSION_DECISION, ev.decision),
      attrStr(ATTR.CREWHAUS_PERMISSION_MODE, ev.mode),
      ...(ev.reason ? [attrStr(ATTR.CREWHAUS_PERMISSION_REASON, ev.reason)] : []),
    ],
    status: ev.decision === "deny" ? { code: STATUS_ERROR } : { code: STATUS_OK },
  };
}

export function buildErrorRecoveredSpan(ev: ErrorRecoveredEvent): OtelSpan {
  const endNano = isoToNano(ev.timestamp);
  return {
    traceId: ev.traceId,
    spanId: ev.spanId,
    ...(ev.parentSpanId ? { parentSpanId: ev.parentSpanId } : {}),
    name: `error_recovered.${ev.action}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: endNano,
    endTimeUnixNano: endNano,
    attributes: [
      ...envelopeAttrs(ev),
      attrStr(ATTR.CREWHAUS_RECOVERY_ACTION, ev.action),
      attrStr(ATTR.CREWHAUS_ERROR_NAME, ev.errorName),
      attrInt(ATTR.CREWHAUS_RECOVERY_DEPTH, ev.depth),
    ],
    status: { code: STATUS_ERROR, message: ev.errorName },
  };
}
