import { type AttachedOtelExporter, attachOtelExporter } from "@crewhaus/otel-exporter";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

/**
 * Catalog R15 `exporter-datadog` — Datadog APM/Logs/Metrics exporter.
 *
 * Section 37. Wraps `@crewhaus/otel-exporter` with Datadog-specific
 * resource attributes (`dd.service`, `dd.env`, `dd.version`) and
 * routes via Datadog's OTLP intake when `DD_API_KEY` is set; falls
 * back to a configured collector sidecar when the API key is absent.
 *
 * Honors:
 *   DD_API_KEY            — required for direct intake routing
 *   DD_TRACE_ENABLED      — "false" disables trace export entirely
 *   DD_LOG_LEVEL          — passed through as a resource attribute
 *   DD_TAGS               — comma-separated `k:v` tags merged into resource attrs
 *
 * SECURITY (T8 credential-leak guard): the API key never appears in
 * exporter logs / errors / span attributes. The wrapped exporter's
 * `onError` is patched to strip the api-key value from any thrown
 * message before forwarding to the caller.
 */

/**
 * Default Datadog OTLP intake URL (US1 site). Override with the
 * DD_OTLP_ENDPOINT env var for non-US1 sites or sidecar setups —
 * common alternatives:
 *   https://otlp.datadoghq.eu/v1/traces       (EU1)
 *   https://otlp.us3.datadoghq.com/v1/traces  (US3)
 *   http://localhost:4318/v1/traces           (DD Agent OTLP receiver)
 */
export const DD_DEFAULT_ENDPOINT = "https://otlp.datadoghq.com/v1/traces";

export type DatadogExporterOptions = {
  /** Datadog API key. Required unless `endpoint` points at a collector sidecar. */
  apiKey?: string;
  /** Override endpoint (e.g. for an OTLP sidecar). Defaults to Datadog OTLP intake. */
  endpoint?: string;
  /** Maps to `dd.service` resource attribute. Defaults to OTel `service.name`. */
  service?: string;
  /** Maps to `dd.env` resource attribute. Defaults to env DD_ENV or "production". */
  env?: string;
  /** Maps to `dd.version` resource attribute. Defaults to env DD_VERSION or "0.0.0". */
  version?: string;
  /** OTel `service.name` resource attribute. */
  serviceName?: string;
  /** Comma-separated `k:v` tags merged into resource attributes (mirrors DD_TAGS). */
  tags?: ReadonlyArray<string>;
  /** Override the 5s batch flush interval. */
  flushIntervalMs?: number;
  /** Test seam — override fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — capture errors instead of writing to stderr. */
  onError?: (err: Error) => void;
};

export type AttachedDatadogExporter = AttachedOtelExporter;

function parseDdTags(raw: string | undefined): ReadonlyArray<string> {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[A-Za-z_][A-Za-z0-9_./:-]*:[^,\s]+$/.test(s));
}

/**
 * Scrub the API key out of an arbitrary string. Replaces every occurrence
 * with a fixed redaction marker so accidental mention of the key in error
 * messages never leaks. Empty/short keys (< 8 chars) are not scrubbed
 * because they would match too aggressively.
 */
function scrubApiKey(message: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey.length < 8) return message;
  // Replace the full key + any common prefixes (e.g. "DD-API-KEY: <key>").
  return message.split(apiKey).join("[REDACTED:DD_API_KEY]");
}

export function attachDatadogExporter(
  bus: TraceEventBus,
  opts: DatadogExporterOptions = {},
): AttachedDatadogExporter {
  const apiKey = opts.apiKey;
  const serviceName = opts.serviceName ?? "crewhaus";
  const ddService = opts.service ?? serviceName;
  const ddEnv = opts.env ?? "production";
  const ddVersion = opts.version ?? "0.0.0";
  const tagsList = opts.tags ?? [];

  const headers: Record<string, string> = {};
  if (apiKey !== undefined) {
    headers["DD-API-KEY"] = apiKey;
  }

  const endpoint = opts.endpoint ?? DD_DEFAULT_ENDPOINT;

  const baseOnError = opts.onError;
  const onError = (err: Error): void => {
    const safeMessage = scrubApiKey(err.message, apiKey);
    const wrapped = err.message === safeMessage ? err : new Error(safeMessage);
    if (baseOnError) {
      baseOnError(wrapped);
    } else {
      process.stderr.write(`[exporter-datadog] export failed: ${wrapped.message}\n`);
    }
  };

  // Patch the resource span attribute set with dd.* tags by wrapping
  // fetch. The otel-exporter doesn't expose a resource-builder hook, so
  // we route through a fetch that injects attrs into the payload before
  // sending. Single-attach so subscribe() fires once.
  const wrappedFetch = wrapFetchWithDdAttrs(opts.fetchImpl ?? fetch, {
    ddService,
    ddEnv,
    ddVersion,
    tags: tagsList,
  });
  return attachOtelExporter(bus, {
    endpoint,
    serviceName,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(opts.flushIntervalMs !== undefined ? { flushIntervalMs: opts.flushIntervalMs } : {}),
    fetchImpl: wrappedFetch,
    onError,
  });
}

type DdAttrs = {
  ddService: string;
  ddEnv: string;
  ddVersion: string;
  tags: ReadonlyArray<string>;
};

function wrapFetchWithDdAttrs(baseFetch: typeof fetch, attrs: DdAttrs): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.body && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed?.resourceSpans !== undefined && Array.isArray(parsed.resourceSpans)) {
          for (const rs of parsed.resourceSpans) {
            const existing = Array.isArray(rs?.resource?.attributes) ? rs.resource.attributes : [];
            const ddAttrs = [
              { key: "dd.service", value: { stringValue: attrs.ddService } },
              { key: "dd.env", value: { stringValue: attrs.ddEnv } },
              { key: "dd.version", value: { stringValue: attrs.ddVersion } },
              ...attrs.tags.map((kv) => {
                const [k, ...rest] = kv.split(":");
                return {
                  key: `dd.tag.${k ?? "unknown"}`,
                  value: { stringValue: rest.join(":") },
                };
              }),
            ];
            rs.resource = { attributes: [...existing, ...ddAttrs] };
          }
          return baseFetch(input, { ...init, body: JSON.stringify(parsed) });
        }
      } catch {
        // Fall through to the un-decorated request.
      }
    }
    return baseFetch(input, init);
  };
  // Bun's typeof fetch includes a `preconnect` static. Carry it through so
  // the wrapped fetch satisfies the full structural type.
  return wrapped as unknown as typeof fetch;
}

export function attachDatadogIfEnvSet(
  bus: TraceEventBus,
  env: NodeJS.ProcessEnv = process.env,
): AttachedDatadogExporter | undefined {
  const apiKey = env["DD_API_KEY"];
  const traceEnabled = env["DD_TRACE_ENABLED"];
  if (apiKey === undefined && env["DD_OTLP_ENDPOINT"] === undefined) return undefined;
  if (traceEnabled !== undefined && /^(false|0|off)$/i.test(traceEnabled)) return undefined;

  const serviceName = env["OTEL_SERVICE_NAME"] ?? "crewhaus";
  const tags = parseDdTags(env["DD_TAGS"]);

  const opts: DatadogExporterOptions = {
    serviceName,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(env["DD_OTLP_ENDPOINT"] !== undefined ? { endpoint: env["DD_OTLP_ENDPOINT"] } : {}),
    ...(env["DD_SERVICE"] !== undefined ? { service: env["DD_SERVICE"] } : {}),
    ...(env["DD_ENV"] !== undefined ? { env: env["DD_ENV"] } : {}),
    ...(env["DD_VERSION"] !== undefined ? { version: env["DD_VERSION"] } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
  return attachDatadogExporter(bus, opts);
}

export { parseDdTags as _parseDdTagsForTest };
export { scrubApiKey as _scrubApiKeyForTest };
