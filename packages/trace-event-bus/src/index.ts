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
  CircuitStateChangedEvent,
  CompactionFiredEvent,
  CostAccrualEvent,
  CrewDoneEvent,
  ErrorRecoveredEvent,
  HandoffEvent,
  HookFiredEvent,
  McpCallEndEvent,
  McpCallStartEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ModelStreamTokenEvent,
  ModelUsage,
  PermissionDecisionEvent,
  ProviderId,
  PublishOptions,
  RecentQuery,
  RoleEndEvent,
  RoleStartEvent,
  Span,
  SubAgentEndEvent,
  SubAgentStartEvent,
  Subscriber,
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
