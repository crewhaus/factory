/**
 * Catalog R-observability `otel-exporter` — OTLP/HTTP exporter for the
 * CrewHaus `TraceEventBus`. Maps lifecycle events to OpenTelemetry spans
 * using `gen_ai/*` semantic conventions for model/tool calls. POSTs spans
 * in OTLP/JSON to `<endpoint>/v1/traces` on a 5s batch interval; flushes
 * synchronously on `shutdown()` so short-lived runs do not lose data.
 *
 * Configuration honors the standard OpenTelemetry env vars:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  e.g. http://localhost:4318
 *   OTEL_EXPORTER_OTLP_HEADERS   "k1=v1,k2=v2"
 *   OTEL_SERVICE_NAME            defaults to "crewhaus"
 */

export {
  attachIfEnvSet,
  attachOtelExporter,
  parseHeaders,
  type AttachedOtelExporter,
  type OtelExporterOptions,
} from "./exporter";
export { SpanTracker } from "./span-tracker";
export {
  ATTR,
  GEN_AI_SYSTEM,
  genAiSystem,
  buildA2AMessageSpan,
  buildAlertRaisedSpan,
  buildApprovalRequestedSpan,
  buildApprovalResolvedSpan,
  buildCircuitStateChangedSpan,
  buildCompactionSpan,
  buildCostAccrualSpan,
  buildCoverageReportSpan,
  buildErrorRecoveredSpan,
  buildEvalGradedSpan,
  buildGenericSpan,
  buildHandoffSpan,
  buildHookSpan,
  buildJanitorActionSpan,
  buildJudgeVerdictSpan,
  buildMcpSpan,
  buildModelFailoverSpan,
  buildModelRouteSpan,
  buildModelSpan,
  buildModelTierRouteSpan,
  buildPermissionSpan,
  buildProgramOutputSpan,
  buildResponseRatedSpan,
  buildRoleSpan,
  buildRunFailedSpan,
  buildSanitizerReportSpan,
  buildStreamTokenEvent,
  buildSubAgentSpan,
  buildTestVerdictSpan,
  buildToolSpan,
  buildTurnSpan,
  type StartedMcp,
  type StartedModel,
  type StartedRole,
  type StartedSubAgent,
  type StartedTool,
  type StartedTurn,
} from "./gen-ai-mapping";
export type {
  Attribute,
  AttributeValue,
  OtelSpan,
  OtlpExportTraceServiceRequest,
  OtlpResource,
  OtlpResourceSpans,
  OtlpScope,
  OtlpScopeSpans,
  SpanEvent,
  SpanStatus,
} from "./types";
