/**
 * OTLP/JSON span shape — a small subset of the OpenTelemetry protocol's
 * `Span` message, sufficient for the events we emit. Field names match the
 * OTLP/JSON wire format (camelCase, hex IDs, string-encoded nano timestamps).
 *
 * Reference: https://opentelemetry.io/docs/specification/protocol/otlp/#otlphttp
 */

export type AttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export type Attribute = {
  key: string;
  value: AttributeValue;
};

export type SpanEvent = {
  /** Time of the event (nanoseconds since Unix epoch, decimal string). */
  timeUnixNano: string;
  name: string;
  attributes?: Attribute[];
};

export type SpanStatus = {
  /** 0=Unset, 1=OK, 2=Error */
  code: 0 | 1 | 2;
  message?: string;
};

export type OtelSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 0=Unspecified, 1=Internal, 2=Server, 3=Client, 4=Producer, 5=Consumer */
  kind: 0 | 1 | 2 | 3 | 4 | 5;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  events?: SpanEvent[];
  status: SpanStatus;
};

export type OtlpResource = {
  attributes: Attribute[];
};

export type OtlpScope = {
  name: string;
  version?: string;
};

export type OtlpScopeSpans = {
  scope: OtlpScope;
  spans: OtelSpan[];
};

export type OtlpResourceSpans = {
  resource: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
};

export type OtlpExportTraceServiceRequest = {
  resourceSpans: OtlpResourceSpans[];
};

export const SPAN_KIND_INTERNAL = 1 as const;
export const SPAN_KIND_CLIENT = 3 as const;
export const STATUS_OK = 1 as const;
export const STATUS_ERROR = 2 as const;
