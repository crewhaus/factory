/**
 * Catalog R-observability `trace-event-bus` — single bus per `runChatLoop`
 * invocation, attached to `RunContext`. Pluggable subscribers (otel, metrics,
 * pretty printer) hook in via `subscribe()`. The bus also exposes a bounded
 * ring buffer so the eval runner can pull recent events in-process without
 * standing up a real OpenTelemetry collector.
 *
 * Reference: build-roadmap.md §15.
 */

export type {
  A2AMessageEvent,
  AlertRaisedEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  CacheRotationEvent,
  CircuitStateChangedEvent,
  CompactionFiredEvent,
  CostAccrualEvent,
  CoverageReportEvent,
  CrewDoneEvent,
  EffectiveParams,
  ErrorRecoveredEvent,
  EvalGradedEvent,
  HandoffEvent,
  HookFiredEvent,
  JanitorActionEvent,
  JudgeVerdictEvent,
  McpCallEndEvent,
  McpCallStartEvent,
  ModelAttributionFields,
  ModelClassifierVerdict,
  ModelDirectiveEvent,
  ModelFailoverEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ModelRole,
  ModelRouteEvent,
  ModelRouteHint,
  ModelRouteSignals,
  ModelStageEvent,
  ModelStreamTokenEvent,
  ModelTierRouteEvent,
  ModelUsage,
  PermissionDecisionEvent,
  ProgramOutputEvent,
  ProviderId,
  PublishOptions,
  RecentQuery,
  ResponseRatedEvent,
  RoleEndEvent,
  RoleStartEvent,
  RunFailedEvent,
  SanitizerReportEvent,
  Span,
  SubAgentEndEvent,
  SubAgentStartEvent,
  Subscriber,
  TestVerdictEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolStreamChunkEvent,
  TraceEvent,
  TraceEventEnvelope,
  TraceEventKind,
  TurnEndEvent,
  TurnStartEvent,
  Unsubscribe,
} from "./types";

export { AUXILIARY_MODEL_ROLES, isAuxiliaryModelRole } from "./types";
export { RingBuffer } from "./ring-buffer";
export {
  formatTraceparent,
  isValidSpanId,
  isValidTraceId,
  newSpanId,
  newTraceId,
  parseTraceparent,
  readEnvTraceparent,
  type ParsedTraceparent,
} from "./traceparent";
export { TraceEventBus, type TraceEventBusOptions } from "./event-bus";
