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
  AlertRaisedEvent,
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
  ModelDirectiveEvent,
  ModelFailoverEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ModelRouteEvent,
  ModelStageEvent,
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
  // 0.6.0 (design §8.4) — the model that actually SERVED the call. Differs
  // from `gen_ai.request.model` when a failover chain rewrote the model
  // mid-call or a pool served a candidate other than the declared primary;
  // OTel's GenAI conventions define both keys for exactly this reason.
  GEN_AI_RESPONSE_MODEL: "gen_ai.response.model",
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
  // 0.6.0 (design §8.4) — per-call attribution on the gen_ai.chat span, set
  // only when the response carries the field (absent role ⇒ primary).
  CREWHAUS_MODEL_SPEC: "crewhaus.model.spec",
  CREWHAUS_MODEL_ROLE: "crewhaus.model.role",
  CREWHAUS_MODEL_PROFILE: "crewhaus.model.profile",
  CREWHAUS_MODEL_STAGE: "crewhaus.model.stage",
  CREWHAUS_MODEL_PARAMS_FINGERPRINT: "crewhaus.model.params_fingerprint",
  // 0.6.0 (design §8.4) — the `model_stage` / `model_directive` kinds and the
  // additive `model_route` attribution (§8.1). `crewhaus.model.strategy` is
  // the `model_pool.strategy` member owning a stage or a route; the rest are
  // the stage lifecycle and the routing lanes.
  CREWHAUS_MODEL_STRATEGY: "crewhaus.model.strategy",
  CREWHAUS_MODEL_STAGE_OUTCOME: "crewhaus.model.stage_outcome",
  CREWHAUS_MODEL_STAGE_CAUSE: "crewhaus.model.stage_cause",
  CREWHAUS_MODEL_DIRECTIVE_SOURCE: "crewhaus.model.directive_source",
  CREWHAUS_MODEL_DIRECTIVE_REQUESTED: "crewhaus.model.directive_requested",
  CREWHAUS_MODEL_DIRECTIVE_RESOLVED: "crewhaus.model.directive_resolved",
  CREWHAUS_MODEL_DIRECTIVE_ACCEPTED: "crewhaus.model.directive_accepted",
  CREWHAUS_MODEL_DIRECTIVE_REASON: "crewhaus.model.directive_reason",
  CREWHAUS_ROUTE_SCOPE: "crewhaus.route.scope",
  CREWHAUS_ROUTE_RULE_ID: "crewhaus.route.rule_id",
  CREWHAUS_ROUTE_HINT_SOURCE: "crewhaus.route.hint_source",
  CREWHAUS_ROUTE_ELIGIBLE: "crewhaus.route.eligible",
  CREWHAUS_ROUTE_TOOLSET_FINGERPRINT: "crewhaus.route.toolset_fingerprint",
  CREWHAUS_ROUTE_CLASSIFIER_LABEL: "crewhaus.route.classifier_label",
  // 0.6.0 (design §8.1) — judge attribution on `eval_graded` / `judge_verdict`.
  CREWHAUS_JUDGE_MODEL: "crewhaus.judge.model",
  CREWHAUS_JUDGE_PANEL: "crewhaus.judge.panel",
  CREWHAUS_JUDGE_COST_USD_MICROS: "crewhaus.judge.cost_usd_micros",
  CREWHAUS_EVAL_ESCALATED_TO: "crewhaus.eval.escalated_to",
  CREWHAUS_EVAL_REASON: "crewhaus.eval.reason",
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
    // 0.6.0 (design §8.4) — request.model is what the loop ASKED for (the
    // request's wire id); response.model is what SERVED. They agree on every
    // plain call and diverge when a failover chain rewrote the model
    // mid-call, which is the case a dashboard splitting spend by served model
    // needs to see.
    attrStr(ATTR.GEN_AI_REQUEST_MODEL, start.ev.model),
    attrStr(ATTR.GEN_AI_RESPONSE_MODEL, end.model),
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
  // 0.6.0 (design §8.4) — attribution, response-first with the request as
  // the fallback (a nested loop stamps both identically; a chain-wrapped
  // candidate can only know the served identity on the response).
  const specModel = end.specModel ?? start.ev.specModel;
  if (specModel !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_SPEC, specModel));
  const role = end.role ?? start.ev.role;
  if (role !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_ROLE, role));
  const profile = end.profile ?? start.ev.profile;
  if (profile !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_PROFILE, profile));
  const stage = end.stage ?? start.ev.stage;
  if (stage !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_STAGE, stage));
  const paramsFingerprint = end.paramsFingerprint ?? start.ev.paramsFingerprint;
  if (paramsFingerprint !== undefined) {
    attrs.push(attrStr(ATTR.CREWHAUS_MODEL_PARAMS_FINGERPRINT, paramsFingerprint));
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

/**
 * 0.6.0 (design §8.4) — cost on the model span. `cost_accrual` is published by
 * cost-tracker under a FRESH envelope (its own spanId) synchronously inside
 * the `model_response` dispatch, so it cannot be joined to the model span by
 * spanId; the SpanTracker instead remembers each completed `gen_ai.chat` span
 * until its accrual arrives and stamps the microdollar total onto it through
 * this helper. The exporter buffers span OBJECTS until the batch flush, so a
 * stamp that lands before the flush ships with the span. Mutates in place and
 * is idempotent per span (a second accrual for the same span is refused).
 */
export function stampModelSpanCost(span: OtelSpan, accrual: CostAccrualEvent): boolean {
  if (span.attributes.some((a) => a.key === ATTR.CREWHAUS_COST_USD_MICROS)) return false;
  span.attributes.push(attrInt(ATTR.CREWHAUS_COST_USD_MICROS, accrual.costUsdMicros));
  if (accrual.unpriced) span.attributes.push(attrBool(ATTR.CREWHAUS_COST_UNPRICED, true));
  return true;
}

/**
 * The join key a `cost_accrual` must match to be stamped onto a completed
 * model span: same trace, same served wire model and the same role (an
 * absent role is `primary` on both sides — cost-tracker copies the response's
 * `role` verbatim, so the two agree by construction). Turn number is NOT part
 * of the key: a side call re-published on the parent bus can carry a
 * different `turnNumber` than the response it prices.
 */
export function modelCostJoinKey(ev: {
  traceId: string;
  model: string;
  role?: string | undefined;
}): string {
  return `${ev.traceId}|${ev.model}|${ev.role ?? "primary"}`;
}

/**
 * Why a call is being closed without its `model_response`.
 * - `turn_end`: the turn closed with the call still open — runtime-core only
 *   publishes `model_response` on its success paths, so a thrown stream
 *   (abort, provider error, breaker trip, max_output_tokens recovery) leaves
 *   the request unpaired.
 * - `error_recovered`: the recovery engine took over after the turn's model
 *   call threw; the retry publishes a fresh `model_request`.
 * - `in_flight_cap`: a publisher minted more requests than responses and the
 *   tracker evicted the oldest to stay bounded.
 */
export type AbandonedModelCause = "turn_end" | "error_recovered" | "in_flight_cap";

/**
 * A `gen_ai.chat` span for a model call whose `model_response` never arrived.
 * Built from the request alone (no usage, no finish reason) with an ERROR
 * status naming the cause, so a failed call is visible in the trace backend
 * instead of vanishing — and so the SpanTracker can drop the entry.
 */
export function buildAbandonedModelSpan(
  start: StartedModel,
  endIso: string,
  cause: AbandonedModelCause,
): OtelSpan {
  const req = start.ev;
  const attrs: Attribute[] = [
    ...envelopeAttrs(req),
    attrStr(ATTR.GEN_AI_SYSTEM, genAiSystem(req.provider)),
    attrStr(ATTR.GEN_AI_OPERATION_NAME, "chat"),
    attrStr(ATTR.GEN_AI_REQUEST_MODEL, req.model),
    attrBool(ATTR.GEN_AI_REQUEST_STREAMING, req.streaming),
    attrStr(ATTR.CREWHAUS_ERROR_NAME, "model_response_missing"),
  ];
  if (req.specModel !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_SPEC, req.specModel));
  if (req.role !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_ROLE, req.role));
  if (req.profile !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_PROFILE, req.profile));
  if (req.stage !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_STAGE, req.stage));
  if (req.paramsFingerprint !== undefined) {
    attrs.push(attrStr(ATTR.CREWHAUS_MODEL_PARAMS_FINGERPRINT, req.paramsFingerprint));
  }
  return {
    traceId: req.traceId,
    spanId: req.spanId,
    ...(req.parentSpanId ? { parentSpanId: req.parentSpanId } : {}),
    name: "gen_ai.chat",
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: start.startNano,
    endTimeUnixNano: isoToNano(endIso),
    attributes: attrs,
    events: start.streamEvents.length > 0 ? start.streamEvents : undefined,
    status: { code: STATUS_ERROR, message: `no model_response before ${cause}` },
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
  // 0.6.0 (design §8.1) — attribution copied verbatim from the response by
  // cost-tracker; set only when present so an unattributed accrual is unchanged.
  if (ev.specModel !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_SPEC, ev.specModel));
  if (ev.role !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_ROLE, ev.role));
  if (ev.profile !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_PROFILE, ev.profile));
  if (ev.stage !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_STAGE, ev.stage));
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
  // 0.6.0 (design §8.1) — the additive routing attribution, each set only
  // when the decision carries it so a 0.5.x route span is byte-identical.
  if (ev.specModel !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_SPEC, ev.specModel));
  if (ev.profile !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_PROFILE, ev.profile));
  if (ev.stage !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_STAGE, ev.stage));
  if (ev.strategy !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_STRATEGY, ev.strategy));
  if (ev.scope !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_ROUTE_SCOPE, ev.scope));
  if (ev.ruleId !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_ROUTE_RULE_ID, ev.ruleId));
  if (ev.hint !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_ROUTE_HINT_SOURCE, ev.hint.source));
  if (ev.eligible !== undefined) {
    attrs.push(attrStr(ATTR.CREWHAUS_ROUTE_ELIGIBLE, ev.eligible.join(",")));
  }
  if (ev.toolsetFingerprint !== undefined) {
    attrs.push(attrStr(ATTR.CREWHAUS_ROUTE_TOOLSET_FINGERPRINT, ev.toolsetFingerprint));
  }
  if (ev.classifierVerdict !== undefined) {
    attrs.push(attrStr(ATTR.CREWHAUS_ROUTE_CLASSIFIER_LABEL, ev.classifierVerdict.label));
  }
  return pointSpan(ev, `model_route.${ev.routeKey}`, attrs, { code: STATUS_OK });
}

/**
 * 0.6.0 (design §7.3–§7.8, §8.4) — one hybrid-strategy stage transition
 * (`draft` → `verify` → `escalate`, a guide call, a shadow replay, a committee
 * member) as a point-in-time span named `model_stage.<stage>`. ERROR status on
 * a `failed` outcome so the shape of a turn is alertable, not just visible;
 * `skipped` is a normal lifecycle verdict (e.g. `max_escalations` reached) and
 * stays OK. The stage's own spend rides as `crewhaus.cost.usd_micros` when the
 * publisher knew it.
 */
export function buildModelStageSpan(ev: ModelStageEvent): OtelSpan {
  const attrs: Attribute[] = [
    attrStr(ATTR.CREWHAUS_MODEL_STAGE, ev.stage),
    attrStr(ATTR.CREWHAUS_MODEL_STRATEGY, ev.strategy),
    attrStr(ATTR.CREWHAUS_MODEL_ROLE, ev.role),
    attrStr(ATTR.GEN_AI_REQUEST_MODEL, ev.model),
    attrStr(ATTR.CREWHAUS_MODEL_STAGE_OUTCOME, ev.outcome),
  ];
  if (ev.profile !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_PROFILE, ev.profile));
  if (ev.cause !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_STAGE_CAUSE, ev.cause));
  if (ev.costUsdMicros !== undefined) {
    attrs.push(attrInt(ATTR.CREWHAUS_COST_USD_MICROS, ev.costUsdMicros));
  }
  const failed = ev.outcome === "failed";
  return pointSpan(ev, `model_stage.${ev.stage}`, attrs, {
    code: failed ? STATUS_ERROR : STATUS_OK,
    ...(failed ? { message: ev.cause ?? `stage ${ev.stage} failed` } : {}),
  });
}

/**
 * 0.6.0 (design §7.2.1) — a `/model …` directive parsed at a typed input seam,
 * as a point-in-time span. A refused directive (`accepted: false`) is a
 * routing fact, not a failure, so the status stays OK and the refusal reason
 * rides as an attribute.
 */
export function buildModelDirectiveSpan(ev: ModelDirectiveEvent): OtelSpan {
  const attrs: Attribute[] = [
    attrStr(ATTR.CREWHAUS_MODEL_DIRECTIVE_SOURCE, ev.source),
    attrStr(ATTR.CREWHAUS_MODEL_DIRECTIVE_REQUESTED, ev.requested),
    attrBool(ATTR.CREWHAUS_MODEL_DIRECTIVE_ACCEPTED, ev.accepted),
  ];
  if (ev.resolved !== undefined) {
    attrs.push(attrStr(ATTR.CREWHAUS_MODEL_DIRECTIVE_RESOLVED, ev.resolved));
  }
  if (ev.reason !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_DIRECTIVE_REASON, ev.reason));
  return pointSpan(ev, "model_directive", attrs, { code: STATUS_OK });
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
  // 0.6.0 (design §7.3, §8.1) — which arm was graded, which judge scored it,
  // what the judge cost, and where a failing draft was escalated to.
  if (ev.model !== undefined) attrs.push(attrStr(ATTR.GEN_AI_REQUEST_MODEL, ev.model));
  if (ev.profile !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_MODEL_PROFILE, ev.profile));
  if (ev.judgeModel !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_JUDGE_MODEL, ev.judgeModel));
  if (ev.judgeCostUsdMicros !== undefined) {
    attrs.push(attrInt(ATTR.CREWHAUS_JUDGE_COST_USD_MICROS, ev.judgeCostUsdMicros));
  }
  if (ev.escalatedTo !== undefined) {
    attrs.push(attrStr(ATTR.CREWHAUS_EVAL_ESCALATED_TO, ev.escalatedTo));
  }
  if (ev.reason !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_EVAL_REASON, ev.reason));
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
  // 0.6.0 (design §6.2, §8.1) — the judge (or panel) that scored the gate and
  // what it cost; set only when the gate helper reported them.
  if (ev.judgeModel !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_JUDGE_MODEL, ev.judgeModel));
  if (ev.panel !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_JUDGE_PANEL, ev.panel.join(",")));
  if (ev.costUsdMicros !== undefined) {
    attrs.push(attrInt(ATTR.CREWHAUS_JUDGE_COST_USD_MICROS, ev.costUsdMicros));
  }
  if (ev.reason !== undefined) attrs.push(attrStr(ATTR.CREWHAUS_EVAL_REASON, ev.reason));
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
