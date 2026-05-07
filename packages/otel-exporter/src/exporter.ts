/**
 * `attachOtelExporter(bus, opts)` — subscribes to a `TraceEventBus`,
 * accumulates spans via `SpanTracker`, and POSTs them in OTLP/JSON to
 * `<endpoint>/v1/traces` on a 5-second flush interval. Synchronous flush on
 * shutdown so short runs (smoke tests, CI) never lose spans.
 */
import type { TraceEventBus, Unsubscribe } from "@crewhaus/trace-event-bus";
import { SpanTracker } from "./span-tracker";
import type {
  Attribute,
  OtelSpan,
  OtlpExportTraceServiceRequest,
  OtlpResourceSpans,
  OtlpScopeSpans,
} from "./types";

const SCOPE_NAME = "@crewhaus/otel-exporter";
const SCOPE_VERSION = "0.0.0";
const DEFAULT_BATCH_INTERVAL_MS = 5000;

export type OtelExporterOptions = {
  endpoint: string;
  /** Optional headers map (parsed from OTEL_EXPORTER_OTLP_HEADERS upstream). */
  headers?: Record<string, string>;
  /** OTel `service.name` resource attribute. */
  serviceName: string;
  /** Override the 5s batch flush interval (ms). 0 disables timer-based batching. */
  flushIntervalMs?: number;
  /** Override `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Suppress export errors (defaults: log to stderr). For tests. */
  onError?: (err: Error) => void;
};

export type AttachedOtelExporter = {
  unsubscribe: Unsubscribe;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  /** For tests / diagnostics. */
  pendingSpanCount(): number;
};

function buildResourceAttrs(serviceName: string): Attribute[] {
  return [
    { key: "service.name", value: { stringValue: serviceName } },
    { key: "telemetry.sdk.name", value: { stringValue: "crewhaus-otel-exporter" } },
    { key: "telemetry.sdk.language", value: { stringValue: "javascript" } },
    { key: "telemetry.sdk.version", value: { stringValue: SCOPE_VERSION } },
  ];
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/traces")) return trimmed;
  return `${trimmed}/v1/traces`;
}

export function attachOtelExporter(
  bus: TraceEventBus,
  opts: OtelExporterOptions,
): AttachedOtelExporter {
  const endpoint = normalizeEndpoint(opts.endpoint);
  const headers = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const onError =
    opts.onError ??
    ((err: Error) => {
      process.stderr.write(`[otel-exporter] export failed: ${err.message}\n`);
    });
  const resourceAttrs = buildResourceAttrs(opts.serviceName);

  const buffer: OtelSpan[] = [];
  const tracker = new SpanTracker((span) => {
    buffer.push(span);
  });
  const unsubscribe = bus.subscribe((ev) => tracker.ingest(ev));

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const buildPayload = (spans: OtelSpan[]): OtlpExportTraceServiceRequest => {
    const scopeSpans: OtlpScopeSpans = {
      scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
      spans,
    };
    const resourceSpans: OtlpResourceSpans = {
      resource: { attributes: resourceAttrs },
      scopeSpans: [scopeSpans],
    };
    return { resourceSpans: [resourceSpans] };
  };

  const flushOnce = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    const payload = buildPayload(batch);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`OTLP export ${res.status}: ${text.slice(0, 256)}`);
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const flush = async (): Promise<void> => {
    if (inFlight) {
      await inFlight;
    }
    if (buffer.length === 0) return;
    inFlight = flushOnce();
    try {
      await inFlight;
    } finally {
      inFlight = undefined;
    }
  };

  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  if (flushIntervalMs > 0) {
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  return {
    unsubscribe,
    flush,
    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      await flush();
      unsubscribe();
    },
    pendingSpanCount(): number {
      return buffer.length;
    },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

/**
 * Parse the `OTEL_EXPORTER_OTLP_HEADERS` env value. Format:
 *   "key1=value1,key2=value2"
 */
export function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const out: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (k.length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function attachIfEnvSet(
  bus: TraceEventBus,
  env: NodeJS.ProcessEnv = process.env,
): AttachedOtelExporter | undefined {
  const endpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (!endpoint) return undefined;
  const serviceName = env["OTEL_SERVICE_NAME"] ?? "crewhaus";
  const headers = parseHeaders(env["OTEL_EXPORTER_OTLP_HEADERS"]);
  return attachOtelExporter(bus, {
    endpoint,
    serviceName,
    ...(headers ? { headers } : {}),
  });
}
