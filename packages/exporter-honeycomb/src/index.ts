import { type AttachedOtelExporter, attachOtelExporter } from "@crewhaus/otel-exporter";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

/**
 * Catalog R15 `exporter-honeycomb` — Honeycomb tracing exporter.
 *
 * Section 37. OTLP/HTTP exporter pointed at api.honeycomb.io with
 * `x-honeycomb-team: <api-key>` and (optionally) `x-honeycomb-dataset`.
 * Honeycomb's "dataset" maps to OTel `service.name` by default; the
 * adapter exposes a `dataset` option for callers that want to split
 * one service across multiple datasets.
 *
 * Honors:
 *   HONEYCOMB_API_KEY   — required
 *   HONEYCOMB_DATASET   — optional override of the dataset name
 *   HONEYCOMB_API_HOST  — optional override (e.g. EU region: api.eu1.honeycomb.io)
 *
 * SECURITY (T8 credential-leak guard): the API key is scrubbed from
 * any error message before bubbling up to caller code.
 */

export const HC_DEFAULT_API_HOST = "https://api.honeycomb.io";
const HC_TRACES_PATH = "/v1/traces";

export type HoneycombExporterOptions = {
  apiKey?: string;
  /** Override the OTel `service.name` resource attribute. */
  serviceName?: string;
  /** Honeycomb dataset (defaults to `serviceName`). */
  dataset?: string;
  /** Override the API host (e.g. EU region). */
  apiHost?: string;
  /** Override the 5s batch flush interval. */
  flushIntervalMs?: number;
  /** Test seam — override fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — capture errors. */
  onError?: (err: Error) => void;
};

export type AttachedHoneycombExporter = AttachedOtelExporter;

function scrubApiKey(message: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey.length < 8) return message;
  return message.split(apiKey).join("[REDACTED:HONEYCOMB_API_KEY]");
}

export function attachHoneycombExporter(
  bus: TraceEventBus,
  opts: HoneycombExporterOptions = {},
): AttachedHoneycombExporter {
  const apiKey = opts.apiKey;
  const serviceName = opts.serviceName ?? "crewhaus";
  const dataset = opts.dataset ?? serviceName;
  const apiHost = (opts.apiHost ?? HC_DEFAULT_API_HOST).replace(/\/+$/, "");
  const endpoint = `${apiHost}${HC_TRACES_PATH}`;

  const headers: Record<string, string> = {
    "x-honeycomb-dataset": dataset,
  };
  if (apiKey !== undefined) {
    headers["x-honeycomb-team"] = apiKey;
  }

  const baseOnError = opts.onError;
  const onError = (err: Error): void => {
    const safeMessage = scrubApiKey(err.message, apiKey);
    const wrapped = err.message === safeMessage ? err : new Error(safeMessage);
    if (baseOnError) {
      baseOnError(wrapped);
    } else {
      process.stderr.write(`[exporter-honeycomb] export failed: ${wrapped.message}\n`);
    }
  };

  return attachOtelExporter(bus, {
    endpoint,
    serviceName,
    headers,
    ...(opts.flushIntervalMs !== undefined ? { flushIntervalMs: opts.flushIntervalMs } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    onError,
  });
}

export function attachHoneycombIfEnvSet(
  bus: TraceEventBus,
  env: NodeJS.ProcessEnv = process.env,
): AttachedHoneycombExporter | undefined {
  const apiKey = env["HONEYCOMB_API_KEY"];
  if (apiKey === undefined) return undefined;

  const opts: HoneycombExporterOptions = {
    apiKey,
    ...(env["OTEL_SERVICE_NAME"] !== undefined ? { serviceName: env["OTEL_SERVICE_NAME"] } : {}),
    ...(env["HONEYCOMB_DATASET"] !== undefined ? { dataset: env["HONEYCOMB_DATASET"] } : {}),
    ...(env["HONEYCOMB_API_HOST"] !== undefined ? { apiHost: env["HONEYCOMB_API_HOST"] } : {}),
  };
  return attachHoneycombExporter(bus, opts);
}

export { scrubApiKey as _scrubApiKeyForTest };
