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
  A2AMessageEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  CircuitStateChangedEvent,
  CompactionFiredEvent,
  CostAccrualEvent,
  CoverageReportEvent,
  ErrorRecoveredEvent,
  EvalGradedEvent,
  HandoffEvent,
  HookFiredEvent,
  JanitorActionEvent,
  JudgeVerdictEvent,
  McpCallEndEvent,
  McpCallStartEvent,
  ModelFailoverEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ModelStreamTokenEvent,
  ModelTierRouteEvent,
  PermissionDecisionEvent,
  ProgramOutputEvent,
  ResponseRatedEvent,
  RoleEndEvent,
  RoleStartEvent,
  RunFailedEvent,
  SanitizerReportEvent,
  SubAgentEndEvent,
  SubAgentStartEvent,
  TestVerdictEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  TraceEvent,
  TraceEventEnvelope,
  TurnEndEvent,
  TurnStartEvent,
} from "@crewhaus/trace-event-bus";

// `AlertRaisedEvent` and `ModelRouteEvent` are defined in trace-event-bus's
// types.ts and are members of the exported `TraceEvent` union, but the
// package's index barrel does not re-export them by name (see cross-package
// note in the return). Derive them from the union so we depend only on the
// exported surface rather than editing the keystone package.
type AlertRaisedEvent = Extract<TraceEvent, { kind: "alert_raised" }>;
type ModelRouteEvent = Extract<TraceEvent, { kind: "model_route" }>;
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
  CREWHAUS_FEEDBACK_RATING: "crewhaus.feedback.rating",
  CREWHAUS_FEEDBACK_SOURCE: "crewhaus.feedback.source",
  CREWHAUS_FEEDBACK_COMMENT: "crewhaus.feedback.comment",
  // G58 — crew role / handoff / a2a.
  CREWHAUS_CREW_ROLE: "crewhaus.crew.role",
  CREWHAUS_CREW_ACTIVATION: "crewhaus.crew.activation",
  CREWHAUS_CREW_FINAL_BYTES: "crewhaus.crew.final_message_bytes",
  CREWHAUS_HANDOFF_FROM: "crewhaus.handoff.from",
  CREWHAUS_HANDOFF_TO: "crewhaus.handoff.to",
  CREWHAUS_HANDOFF_REASON: "crewhaus.handoff.reason",
  CREWHAUS_HANDOFF_DEPTH: "crewhaus.handoff.depth",
  CREWHAUS_A2A_FROM: "crewhaus.a2a.from",
  CREWHAUS_A2A_TO: "crewhaus.a2a.to",
  CREWHAUS_A2A_MESSAGE_KIND: "crewhaus.a2a.message_kind",
  CREWHAUS_A2A_PAYLOAD_BYTES: "crewhaus.a2a.payload_bytes",
  CREWHAUS_A2A_TRACEPARENT: "crewhaus.a2a.traceparent",
  // G58 — cost accrual. gen_ai.usage.* reuses the model-span attr names.
  CREWHAUS_COST_USD_MICROS: "crewhaus.cost.usd_micros",
  CREWHAUS_COST_UNPRICED: "crewhaus.cost.unpriced",
  CREWHAUS_COST_TENANT_ID: "crewhaus.cost.tenant_id",
  // G58 — run_failed.
  CREWHAUS_FAILURE_CLASS: "crewhaus.failure.class",
  CREWHAUS_FAILURE_MESSAGE: "crewhaus.failure.message",
  CREWHAUS_FAILURE_REMEDIATION: "crewhaus.failure.remediation",
  CREWHAUS_FAILURE_EXIT_CODE: "crewhaus.failure.exit_code",
  // G58 — circuit breaker / failover / route.
  CREWHAUS_CIRCUIT_ADAPTER: "crewhaus.circuit.adapter",
  CREWHAUS_CIRCUIT_FROM_STATE: "crewhaus.circuit.from_state",
  CREWHAUS_CIRCUIT_TO_STATE: "crewhaus.circuit.to_state",
  CREWHAUS_CIRCUIT_REASON: "crewhaus.circuit.reason",
  CREWHAUS_FAILOVER_FROM: "crewhaus.failover.from",
  CREWHAUS_FAILOVER_TO: "crewhaus.failover.to",
  CREWHAUS_FAILOVER_REASON: "crewhaus.failover.reason",
  CREWHAUS_ROUTE_KEY: "crewhaus.route.key",
  CREWHAUS_ROUTE_TIER: "crewhaus.route.tier",
  CREWHAUS_ROUTE_POLICY: "crewhaus.route.policy",
  CREWHAUS_ROUTE_REASON: "crewhaus.route.reason",
  CREWHAUS_ROUTE_ESCALATED: "crewhaus.route.escalated",
  CREWHAUS_ROUTE_EXPLORED: "crewhaus.route.explored",
  CREWHAUS_ROUTE_POLICY_VERSION: "crewhaus.route.policy_version",
  // G58 — janitor.
  CREWHAUS_JANITOR_STEP: "crewhaus.janitor.step",
  CREWHAUS_JANITOR_STATUS: "crewhaus.janitor.status",
  CREWHAUS_JANITOR_COUNT: "crewhaus.janitor.count",
  CREWHAUS_JANITOR_DETAIL: "crewhaus.janitor.detail",
  // G58 — alert.
  CREWHAUS_ALERT_METRIC: "crewhaus.alert.metric",
  CREWHAUS_ALERT_OBSERVED: "crewhaus.alert.observed",
  CREWHAUS_ALERT_THRESHOLD: "crewhaus.alert.threshold",
  CREWHAUS_ALERT_BASELINE_SESSIONS: "crewhaus.alert.baseline_sessions",
  CREWHAUS_ALERT_DETAIL: "crewhaus.alert.detail",
  // G58 — test-verdict family.
  CREWHAUS_TEST_ID: "crewhaus.test.id",
  CREWHAUS_TEST_VERDICT: "crewhaus.test.verdict",
  CREWHAUS_TEST_REASON: "crewhaus.test.reason",
  CREWHAUS_TEST_DURATION_MS: "crewhaus.test.duration_ms",
  CREWHAUS_PROGRAM_ID: "crewhaus.program.id",
  CREWHAUS_PROGRAM_EXIT_CODE: "crewhaus.program.exit_code",
  CREWHAUS_PROGRAM_STDOUT_BYTES: "crewhaus.program.stdout_bytes",
  CREWHAUS_PROGRAM_STDERR_BYTES: "crewhaus.program.stderr_bytes",
  CREWHAUS_PROGRAM_DURATION_MS: "crewhaus.program.duration_ms",
  CREWHAUS_COVERAGE_LINES_COVERED: "crewhaus.coverage.lines_covered",
  CREWHAUS_COVERAGE_LINES_TOTAL: "crewhaus.coverage.lines_total",
  CREWHAUS_COVERAGE_BRANCHES_COVERED: "crewhaus.coverage.branches_covered",
  CREWHAUS_COVERAGE_BRANCHES_TOTAL: "crewhaus.coverage.branches_total",
  // E51 / NEW-E-2 — in-loop evaluation verdicts. The `evaluation:` block's
  // per-turn grade and a judge step/node's verdict are quality measurements
  // an operator alerts on, so they get first-class attribute keys instead of
  // the generic `crewhaus.<kind>` fallback they used to fall into.
  CREWHAUS_EVAL_SCORE: "crewhaus.eval.score",
  CREWHAUS_EVAL_THRESHOLD: "crewhaus.eval.threshold",
  CREWHAUS_EVAL_VERDICT: "crewhaus.eval.verdict",
  CREWHAUS_EVAL_GRADER_TYPE: "crewhaus.eval.grader_type",
  CREWHAUS_EVAL_RETRY_INDEX: "crewhaus.eval.retry_index",
  CREWHAUS_EVAL_MAX_RETRIES: "crewhaus.eval.max_retries",
  CREWHAUS_JUDGE_AT: "crewhaus.judge.at",
  CREWHAUS_JUDGE_VERDICT: "crewhaus.judge.verdict",
  CREWHAUS_JUDGE_SCORE: "crewhaus.judge.score",
  CREWHAUS_JUDGE_RATIONALE: "crewhaus.judge.rationale",
  CREWHAUS_SANITIZER_KIND: "crewhaus.sanitizer.kind",
  CREWHAUS_SANITIZER_IS_ERROR: "crewhaus.sanitizer.is_error",
  CREWHAUS_SANITIZER_SUMMARY: "crewhaus.sanitizer.summary",
  // G58 — approvals.
  CREWHAUS_APPROVAL_ID: "crewhaus.approval.id",
  CREWHAUS_APPROVAL_TOOL: "crewhaus.approval.tool",
  CREWHAUS_APPROVAL_SURFACE: "crewhaus.approval.surface",
  CREWHAUS_APPROVAL_DECISION: "crewhaus.approval.decision",
  CREWHAUS_APPROVAL_BY: "crewhaus.approval.by",
  // G58 — generic fallback (default branch: never silently drop an event).
  CREWHAUS_EVENT_KIND: "crewhaus.event.kind",
  // Identity — the Ed25519 fingerprint of the publishing agent, when set.
  CREWHAUS_AGENT_ID: "crewhaus.agent.id",
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

function envelopeAttrs(ev: {
  runId: string;
  sessionId: string;
  turnNumber: number;
  agentId?: string;
}): Attribute[] {
  const attrs = [
    attrStr(ATTR.CREWHAUS_RUN_ID, ev.runId),
    attrStr(ATTR.CREWHAUS_SESSION_ID, ev.sessionId),
    attrInt(ATTR.CREWHAUS_TURN_NUMBER, ev.turnNumber),
  ];
  // Batch C keystone item 4 — stamp the publishing agent's Ed25519 fingerprint
  // when the bus supplied one, so a span attributes to the same agent as its
  // audit record. Additive: absent on isolated tests / pre-identity events.
  if (ev.agentId !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_AGENT_ID, ev.agentId));
  return attrs;
}

/** Zero-duration point-in-time span helper for events with no start/end pair. */
function pointSpan(
  ev: TraceEventEnvelope,
  name: string,
  extraAttrs: Attribute[],
  status: OtelSpan["status"],
  kind: OtelSpan["kind"] = SPAN_KIND_INTERNAL,
): OtelSpan {
  const nano = isoToNano(ev.timestamp);
  return {
    traceId: ev.traceId,
    spanId: ev.spanId,
    ...(ev.parentSpanId ? { parentSpanId: ev.parentSpanId } : {}),
    name,
    kind,
    startTimeUnixNano: nano,
    endTimeUnixNano: nano,
    attributes: [...envelopeAttrs(ev), ...extraAttrs],
    status,
  };
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

export function buildResponseRatedSpan(ev: ResponseRatedEvent): OtelSpan {
  const endNano = isoToNano(ev.timestamp);
  const rating = typeof ev.rating === "number" ? ev.rating.toString() : ev.rating;
  return {
    traceId: ev.traceId,
    spanId: ev.spanId,
    ...(ev.parentSpanId ? { parentSpanId: ev.parentSpanId } : {}),
    name: "feedback.response_rated",
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: endNano,
    endTimeUnixNano: endNano,
    attributes: [
      ...envelopeAttrs(ev),
      attrStr(ATTR.CREWHAUS_FEEDBACK_RATING, rating),
      ...(ev.source ? [attrStr(ATTR.CREWHAUS_FEEDBACK_SOURCE, ev.source)] : []),
      ...(ev.comment ? [attrStr(ATTR.CREWHAUS_FEEDBACK_COMMENT, ev.comment)] : []),
    ],
    status: { code: STATUS_OK },
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

// ---------------------------------------------------------------------------
// G58 — crew (role / handoff / a2a) span mappings.
// ---------------------------------------------------------------------------

export type StartedRole = {
  startNano: string;
  ev: RoleStartEvent;
};

/** A crew role's activation, `role_start` → `role_end`, mapped as one span. */
export function buildRoleSpan(start: StartedRole, end: RoleEndEvent): OtelSpan {
  return {
    traceId: end.traceId,
    spanId: end.spanId,
    ...(end.parentSpanId ? { parentSpanId: end.parentSpanId } : {}),
    name: `role.${end.role}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: start.startNano,
    endTimeUnixNano: isoToNano(end.timestamp),
    attributes: [
      ...envelopeAttrs(end),
      attrStr(ATTR.CREWHAUS_CREW_ROLE, end.role),
      attrInt(ATTR.CREWHAUS_CREW_ACTIVATION, end.activation),
      attrInt(ATTR.CREWHAUS_CREW_FINAL_BYTES, end.finalMessageBytes),
    ],
    status: { code: STATUS_OK },
  };
}

/** A crew control-handoff — a point-in-time span carrying the from/to/depth. */
export function buildHandoffSpan(ev: HandoffEvent): OtelSpan {
  return pointSpan(
    ev,
    "handoff",
    [
      attrStr(ATTR.CREWHAUS_HANDOFF_FROM, ev.from),
      attrStr(ATTR.CREWHAUS_HANDOFF_TO, ev.to),
      attrStr(ATTR.CREWHAUS_HANDOFF_REASON, ev.reason),
      attrInt(ATTR.CREWHAUS_HANDOFF_DEPTH, ev.depth),
    ],
    { code: STATUS_OK },
  );
}

/** An agent-to-agent message — a point-in-time span (SPAN_KIND_PRODUCER-ish;
 *  kept INTERNAL to match the rest of our nested crew spans). */
export function buildA2AMessageSpan(ev: A2AMessageEvent): OtelSpan {
  return pointSpan(
    ev,
    `a2a.${ev.messageKind}`,
    [
      attrStr(ATTR.CREWHAUS_A2A_FROM, ev.from),
      attrStr(ATTR.CREWHAUS_A2A_TO, ev.to),
      attrStr(ATTR.CREWHAUS_A2A_MESSAGE_KIND, ev.messageKind),
      attrInt(ATTR.CREWHAUS_A2A_PAYLOAD_BYTES, ev.payloadBytes),
      attrStr(ATTR.CREWHAUS_A2A_TRACEPARENT, ev.traceparent),
    ],
    { code: STATUS_OK },
  );
}

// ---------------------------------------------------------------------------
// G58 — cost / failure span mappings.
// ---------------------------------------------------------------------------

/** A per-call (or aggregate) cost accrual — a point-in-time span carrying the
 *  gen_ai.usage.* token counts plus the microdollar total. */
export function buildCostAccrualSpan(ev: CostAccrualEvent): OtelSpan {
  const attrs: Attribute[] = [
    attrStr(ATTR.GEN_AI_SYSTEM, genAiSystem(ev.provider)),
    attrStr(ATTR.GEN_AI_REQUEST_MODEL, ev.modelId),
    attrInt(ATTR.GEN_AI_USAGE_INPUT_TOKENS, ev.inputTokens),
    attrInt(ATTR.GEN_AI_USAGE_OUTPUT_TOKENS, ev.outputTokens),
    attrInt(ATTR.GEN_AI_USAGE_CACHE_READ_TOKENS, ev.cachedReadTokens),
    attrInt(ATTR.CREWHAUS_COST_USD_MICROS, ev.costUsdMicros),
  ];
  if (ev.cacheCreationTokens !== undefined) {
    attrs.push(attrInt(ATTR.GEN_AI_USAGE_CACHE_CREATE_TOKENS, ev.cacheCreationTokens));
  }
  if (ev.unpriced) attrs.push(attrBool(ATTR.CREWHAUS_COST_UNPRICED, true));
  if (ev.tenantId !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_COST_TENANT_ID, ev.tenantId));
  return pointSpan(ev, ev.summary ? "cost_accrual.summary" : "cost_accrual", attrs, {
    code: STATUS_OK,
  });
}

/** The terminal run failure — a point-in-time span with ERROR status. */
export function buildRunFailedSpan(ev: RunFailedEvent): OtelSpan {
  const attrs: Attribute[] = [
    attrStr(ATTR.CREWHAUS_FAILURE_CLASS, ev.class),
    attrStr(ATTR.CREWHAUS_FAILURE_MESSAGE, ev.message),
    attrInt(ATTR.CREWHAUS_FAILURE_EXIT_CODE, ev.exitCode),
  ];
  if (ev.remediation !== undefined) {
    attrs.push(attrStr(ATTR.CREWHAUS_FAILURE_REMEDIATION, ev.remediation));
  }
  return pointSpan(ev, `run_failed.${ev.class}`, attrs, {
    code: STATUS_ERROR,
    message: ev.message,
  });
}

// ---------------------------------------------------------------------------
// G58 — routing (circuit breaker / failover / tier / pool) span mappings.
// ---------------------------------------------------------------------------

/** A circuit-breaker transition — a point-in-time span. ERROR when it opened. */
export function buildCircuitStateChangedSpan(ev: CircuitStateChangedEvent): OtelSpan {
  const attrs: Attribute[] = [
    attrStr(ATTR.CREWHAUS_CIRCUIT_ADAPTER, ev.adapter),
    attrStr(ATTR.CREWHAUS_CIRCUIT_FROM_STATE, ev.fromState),
    attrStr(ATTR.CREWHAUS_CIRCUIT_TO_STATE, ev.toState),
  ];
  if (ev.reason !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_CIRCUIT_REASON, ev.reason));
  return pointSpan(ev, `circuit.${ev.toState}`, attrs, {
    code: ev.toState === "open" ? STATUS_ERROR : STATUS_OK,
  });
}

/** A model-router failover — a point-in-time span. */
export function buildModelFailoverSpan(ev: ModelFailoverEvent): OtelSpan {
  return pointSpan(
    ev,
    "model_failover",
    [
      attrStr(ATTR.CREWHAUS_FAILOVER_FROM, ev.from),
      attrStr(ATTR.CREWHAUS_FAILOVER_TO, ev.to),
      attrStr(ATTR.CREWHAUS_FAILOVER_REASON, ev.reason),
      attrStr(ATTR.GEN_AI_REQUEST_MODEL, ev.to),
    ],
    { code: STATUS_OK },
  );
}

/** A two-tier difficulty route — a point-in-time span. */
export function buildModelTierRouteSpan(ev: ModelTierRouteEvent): OtelSpan {
  const attrs: Attribute[] = [
    attrStr(ATTR.CREWHAUS_ROUTE_TIER, ev.tier),
    attrStr(ATTR.GEN_AI_REQUEST_MODEL, ev.model),
    attrStr(ATTR.CREWHAUS_ROUTE_REASON, ev.reason),
  ];
  if (ev.escalated !== undefined) attrs.push(attrBool(ATTR.CREWHAUS_ROUTE_ESCALATED, ev.escalated));
  return pointSpan(ev, `model_tier_route.${ev.tier}`, attrs, { code: STATUS_OK });
}

/** An N-candidate pool route (`model_pool`) — a point-in-time span. */
export function buildModelRouteSpan(ev: ModelRouteEvent): OtelSpan {
  const attrs: Attribute[] = [
    attrStr(ATTR.CREWHAUS_ROUTE_KEY, ev.routeKey),
    attrStr(ATTR.GEN_AI_REQUEST_MODEL, ev.model),
    attrStr(ATTR.CREWHAUS_ROUTE_POLICY, ev.policy),
    attrStr(ATTR.CREWHAUS_ROUTE_REASON, ev.reason),
  ];
  if (ev.explored !== undefined) attrs.push(attrBool(ATTR.CREWHAUS_ROUTE_EXPLORED, ev.explored));
  if (ev.policyVersion !== undefined) {
    attrs.push(attrStr(ATTR.CREWHAUS_ROUTE_POLICY_VERSION, ev.policyVersion));
  }
  return pointSpan(ev, `model_route.${ev.routeKey}`, attrs, { code: STATUS_OK });
}

// ---------------------------------------------------------------------------
// G58 — janitor / alert span mappings.
// ---------------------------------------------------------------------------

/** A boot-time self-heal janitor step — a point-in-time span. ERROR on "error". */
export function buildJanitorActionSpan(ev: JanitorActionEvent): OtelSpan {
  const attrs: Attribute[] = [
    attrStr(ATTR.CREWHAUS_JANITOR_STEP, ev.step),
    attrStr(ATTR.CREWHAUS_JANITOR_STATUS, ev.status),
  ];
  if (ev.count !== undefined) attrs.push(attrInt(ATTR.CREWHAUS_JANITOR_COUNT, ev.count));
  if (ev.detail !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_JANITOR_DETAIL, ev.detail));
  return pointSpan(ev, `janitor.${ev.step}`, attrs, {
    code: ev.status === "error" ? STATUS_ERROR : STATUS_OK,
    ...(ev.status === "error" && ev.detail !== undefined ? { message: ev.detail } : {}),
  });
}

/** An alert-watchdog breach — a point-in-time span with ERROR status. */
export function buildAlertRaisedSpan(ev: AlertRaisedEvent): OtelSpan {
  return pointSpan(
    ev,
    "alert_raised",
    [
      attrStr(ATTR.CREWHAUS_ALERT_METRIC, ev.metric),
      { key: ATTR.CREWHAUS_ALERT_OBSERVED, value: { doubleValue: ev.observed } },
      { key: ATTR.CREWHAUS_ALERT_THRESHOLD, value: { doubleValue: ev.threshold } },
      attrInt(ATTR.CREWHAUS_ALERT_BASELINE_SESSIONS, ev.baselineSessions),
      attrStr(ATTR.CREWHAUS_ALERT_DETAIL, ev.detail),
    ],
    { code: STATUS_ERROR, message: ev.detail },
  );
}

// ---------------------------------------------------------------------------
// G58 — test-verdict family (test_verdict / program_output / coverage_report /
// sanitizer_report) span mappings.
// ---------------------------------------------------------------------------

/** A structured test verdict — a point-in-time span. ERROR on fail/error. */
export function buildTestVerdictSpan(ev: TestVerdictEvent): OtelSpan {
  const attrs: Attribute[] = [
    attrStr(ATTR.CREWHAUS_TEST_ID, ev.testId),
    attrStr(ATTR.CREWHAUS_TEST_VERDICT, ev.verdict),
    attrInt(ATTR.CREWHAUS_TEST_DURATION_MS, ev.durationMs),
  ];
  if (ev.reason !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_TEST_REASON, ev.reason));
  const failed = ev.verdict === "fail" || ev.verdict === "error";
  return pointSpan(ev, `test_verdict.${ev.verdict}`, attrs, {
    code: failed ? STATUS_ERROR : STATUS_OK,
    ...(failed && ev.reason !== undefined ? { message: ev.reason } : {}),
  });
}

/**
 * E51 / NEW-E-2 — an in-loop `evaluation:` grade (one per grading pass,
 * retries included) as a point-in-time span. ERROR status on a failing
 * verdict so a trace backend's error-rate panel counts quality failures the
 * same way it counts tool failures; `crewhaus.eval.retry_index` +
 * `max_retries` let a dashboard tell "failed once then recovered" from
 * "burned the whole retry ladder".
 */
export function buildEvalGradedSpan(ev: EvalGradedEvent): OtelSpan {
  const attrs: Attribute[] = [
    { key: ATTR.CREWHAUS_EVAL_SCORE, value: { doubleValue: ev.score } },
    { key: ATTR.CREWHAUS_EVAL_THRESHOLD, value: { doubleValue: ev.threshold } },
    attrStr(ATTR.CREWHAUS_EVAL_VERDICT, ev.verdict),
    attrStr(ATTR.CREWHAUS_EVAL_GRADER_TYPE, ev.graderType),
    attrInt(ATTR.CREWHAUS_EVAL_RETRY_INDEX, ev.retryIndex),
  ];
  if (ev.maxRetries !== undefined) {
    attrs.push(attrInt(ATTR.CREWHAUS_EVAL_MAX_RETRIES, ev.maxRetries));
  }
  const failed = ev.verdict === "fail";
  return pointSpan(ev, `eval_graded.${ev.verdict}`, attrs, {
    code: failed ? STATUS_ERROR : STATUS_OK,
    ...(failed
      ? {
          message: `${ev.graderType} scored ${ev.score.toFixed(2)} below threshold ${ev.threshold.toFixed(2)}`,
        }
      : {}),
  });
}

/**
 * E51 / NEW-E-2 — a `kind: judge` workflow step / graph node verdict as a
 * point-in-time span. ERROR status on a fail, and the judge's rationale
 * rides as an attribute so the failing span carries its own explanation.
 */
export function buildJudgeVerdictSpan(ev: JudgeVerdictEvent): OtelSpan {
  const attrs: Attribute[] = [
    attrStr(ATTR.CREWHAUS_JUDGE_AT, ev.stepOrNode),
    attrStr(ATTR.CREWHAUS_JUDGE_VERDICT, ev.verdict),
    { key: ATTR.CREWHAUS_JUDGE_SCORE, value: { doubleValue: ev.score } },
  ];
  if (ev.rationale !== undefined) {
    attrs.push(attrStr(ATTR.CREWHAUS_JUDGE_RATIONALE, ev.rationale));
  }
  const failed = ev.verdict === "fail";
  return pointSpan(ev, `judge_verdict.${ev.verdict}`, attrs, {
    code: failed ? STATUS_ERROR : STATUS_OK,
    ...(failed && ev.rationale !== undefined ? { message: ev.rationale } : {}),
  });
}

/** A sandboxed program's exit summary — a point-in-time span. */
export function buildProgramOutputSpan(ev: ProgramOutputEvent): OtelSpan {
  return pointSpan(
    ev,
    "program_output",
    [
      attrStr(ATTR.CREWHAUS_PROGRAM_ID, ev.programId),
      attrInt(ATTR.CREWHAUS_PROGRAM_EXIT_CODE, ev.exitCode),
      attrInt(ATTR.CREWHAUS_PROGRAM_STDOUT_BYTES, ev.stdoutBytes),
      attrInt(ATTR.CREWHAUS_PROGRAM_STDERR_BYTES, ev.stderrBytes),
      attrInt(ATTR.CREWHAUS_PROGRAM_DURATION_MS, ev.durationMs),
    ],
    { code: ev.exitCode === 0 ? STATUS_OK : STATUS_ERROR },
  );
}

/** A coverage report — a point-in-time span. */
export function buildCoverageReportSpan(ev: CoverageReportEvent): OtelSpan {
  return pointSpan(
    ev,
    "coverage_report",
    [
      attrStr(ATTR.CREWHAUS_PROGRAM_ID, ev.programId),
      attrInt(ATTR.CREWHAUS_COVERAGE_LINES_COVERED, ev.linesCovered),
      attrInt(ATTR.CREWHAUS_COVERAGE_LINES_TOTAL, ev.linesTotal),
      attrInt(ATTR.CREWHAUS_COVERAGE_BRANCHES_COVERED, ev.branchesCovered),
      attrInt(ATTR.CREWHAUS_COVERAGE_BRANCHES_TOTAL, ev.branchesTotal),
    ],
    { code: STATUS_OK },
  );
}

/** A sanitizer report — a point-in-time span. ERROR when it flagged. */
export function buildSanitizerReportSpan(ev: SanitizerReportEvent): OtelSpan {
  return pointSpan(
    ev,
    `sanitizer.${ev.sanitizer}`,
    [
      attrStr(ATTR.CREWHAUS_PROGRAM_ID, ev.programId),
      attrStr(ATTR.CREWHAUS_SANITIZER_KIND, ev.sanitizer),
      attrBool(ATTR.CREWHAUS_SANITIZER_IS_ERROR, ev.isError),
      attrStr(ATTR.CREWHAUS_SANITIZER_SUMMARY, ev.summary),
    ],
    { code: ev.isError ? STATUS_ERROR : STATUS_OK, ...(ev.isError ? { message: ev.summary } : {}) },
  );
}

// ---------------------------------------------------------------------------
// G58 — approval span mappings.
// ---------------------------------------------------------------------------

/** A parked approval request — a point-in-time span. */
export function buildApprovalRequestedSpan(ev: ApprovalRequestedEvent): OtelSpan {
  return pointSpan(
    ev,
    "approval.requested",
    [
      attrStr(ATTR.CREWHAUS_APPROVAL_ID, ev.approvalId),
      attrStr(ATTR.CREWHAUS_APPROVAL_TOOL, ev.toolName),
      attrStr(ATTR.CREWHAUS_APPROVAL_SURFACE, ev.surface),
    ],
    { code: STATUS_OK },
  );
}

/** A resolved approval — a point-in-time span. ERROR when denied. */
export function buildApprovalResolvedSpan(ev: ApprovalResolvedEvent): OtelSpan {
  return pointSpan(
    ev,
    `approval.resolved.${ev.decision}`,
    [
      attrStr(ATTR.CREWHAUS_APPROVAL_ID, ev.approvalId),
      attrStr(ATTR.CREWHAUS_APPROVAL_DECISION, ev.decision),
      attrStr(ATTR.CREWHAUS_APPROVAL_BY, ev.by),
    ],
    { code: ev.decision === "deny" ? STATUS_ERROR : STATUS_OK },
  );
}

// ---------------------------------------------------------------------------
// G58 — generic fallback. The SpanTracker's default branch routes here so a
// TraceEvent kind with no dedicated mapping still produces a span (never
// silently dropped). Emits a zero-duration span named `crewhaus.<kind>` with
// the envelope attrs plus a best-effort dump of the event's own scalar fields.
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = new Set<string>([
  "runId",
  "sessionId",
  "turnNumber",
  "traceId",
  "spanId",
  "parentSpanId",
  "timestamp",
  "agentId",
  "kind",
]);

export function buildGenericSpan(ev: TraceEvent): OtelSpan {
  const extra: Attribute[] = [attrStr(ATTR.CREWHAUS_EVENT_KIND, ev.kind)];
  for (const [key, value] of Object.entries(ev as Record<string, unknown>)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    const attrKey = `crewhaus.event.${key}`;
    if (typeof value === "string") extra.push(attrStr(attrKey, value));
    else if (typeof value === "boolean") extra.push(attrBool(attrKey, value));
    else if (typeof value === "number") {
      extra.push(
        Number.isInteger(value)
          ? attrInt(attrKey, value)
          : { key: attrKey, value: { doubleValue: value } },
      );
    }
    // Objects/arrays/undefined are skipped — the scalar dump is a best-effort
    // fallback, not a full serializer; the dedicated builders carry structure.
  }
  return pointSpan(ev, `crewhaus.${ev.kind}`, extra, { code: STATUS_OK });
}
