import { type AttachedOtelExporter, attachOtelExporter } from "@crewhaus/otel-exporter";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

/**
 * Catalog R15 `exporter-newrelic` — New Relic OTLP exporter.
 *
 * Section 37. OTLP/HTTP exporter pointed at `https://otlp.nr-data.net`
 * (US default; `https://otlp.eu01.nr-data.net` for EU) with the
 * `api-key` header carrying the New Relic license key. New Relic's
 * "entity" routing maps from the `entity.guid` resource attribute,
 * which the adapter exposes as a config option.
 *
 * Honors:
 *   NEW_RELIC_LICENSE_KEY  — required (also matches NR_LICENSE_KEY)
 *   NEW_RELIC_ENTITY_GUID  — optional `entity.guid` resource attribute
 *   NEW_RELIC_REGION       — "EU" or unset (US default)
 *
 * SECURITY (T8 credential-leak guard): the license key is scrubbed
 * from any error message before bubbling up to the caller.
 */

export const NR_DEFAULT_ENDPOINT_US = "https://otlp.nr-data.net/v1/traces";
export const NR_DEFAULT_ENDPOINT_EU = "https://otlp.eu01.nr-data.net/v1/traces";

export type NewRelicExporterOptions = {
  licenseKey?: string;
  /** "US" (default) or "EU". Selects between the regional OTLP intakes. */
  region?: "US" | "EU";
  /** Override endpoint (e.g. sidecar collector). Takes precedence over region. */
  endpoint?: string;
  /** OTel `service.name` resource attribute. */
  serviceName?: string;
  /** Maps to `entity.guid` resource attribute. */
  entityGuid?: string;
  /** Override the 5s batch flush interval. */
  flushIntervalMs?: number;
  /** Test seam — override fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — capture errors. */
  onError?: (err: Error) => void;
};

export type AttachedNewRelicExporter = AttachedOtelExporter;

function scrubLicenseKey(message: string, licenseKey: string | undefined): string {
  if (licenseKey === undefined || licenseKey.length < 8) return message;
  return message.split(licenseKey).join("[REDACTED:NEW_RELIC_LICENSE_KEY]");
}

export function attachNewRelicExporter(
  bus: TraceEventBus,
  opts: NewRelicExporterOptions = {},
): AttachedNewRelicExporter {
  const licenseKey = opts.licenseKey;
  const serviceName = opts.serviceName ?? "crewhaus";
  const region = opts.region ?? "US";

  let endpoint: string;
  if (opts.endpoint !== undefined) {
    endpoint = opts.endpoint;
  } else if (region === "EU") {
    endpoint = NR_DEFAULT_ENDPOINT_EU;
  } else {
    endpoint = NR_DEFAULT_ENDPOINT_US;
  }

  const headers: Record<string, string> = {};
  if (licenseKey !== undefined) {
    headers["api-key"] = licenseKey;
  }

  const baseOnError = opts.onError;
  const onError = (err: Error): void => {
    const safeMessage = scrubLicenseKey(err.message, licenseKey);
    const wrapped = err.message === safeMessage ? err : new Error(safeMessage);
    if (baseOnError) {
      baseOnError(wrapped);
    } else {
      process.stderr.write(`[exporter-newrelic] export failed: ${wrapped.message}\n`);
    }
  };

  // entity.guid surfaces as a resource attr via fetch-wrapper injection.
  const wrappedFetch =
    opts.entityGuid !== undefined
      ? wrapFetchWithEntityGuid(opts.fetchImpl ?? fetch, opts.entityGuid)
      : (opts.fetchImpl ?? fetch);

  return attachOtelExporter(bus, {
    endpoint,
    serviceName,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(opts.flushIntervalMs !== undefined ? { flushIntervalMs: opts.flushIntervalMs } : {}),
    fetchImpl: wrappedFetch,
    onError,
  });
}

function wrapFetchWithEntityGuid(baseFetch: typeof fetch, entityGuid: string): typeof fetch {
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
            rs.resource = {
              attributes: [...existing, { key: "entity.guid", value: { stringValue: entityGuid } }],
            };
          }
          return baseFetch(input, { ...init, body: JSON.stringify(parsed) });
        }
      } catch {
        // Fall through.
      }
    }
    return baseFetch(input, init);
  };
  return wrapped as unknown as typeof fetch;
}

export function attachNewRelicIfEnvSet(
  bus: TraceEventBus,
  env: NodeJS.ProcessEnv = process.env,
): AttachedNewRelicExporter | undefined {
  const licenseKey = env["NEW_RELIC_LICENSE_KEY"] ?? env["NR_LICENSE_KEY"];
  if (licenseKey === undefined) return undefined;

  const region = env["NEW_RELIC_REGION"] === "EU" ? "EU" : "US";
  const opts: NewRelicExporterOptions = {
    licenseKey,
    region,
    ...(env["OTEL_SERVICE_NAME"] !== undefined ? { serviceName: env["OTEL_SERVICE_NAME"] } : {}),
    ...(env["NEW_RELIC_ENTITY_GUID"] !== undefined
      ? { entityGuid: env["NEW_RELIC_ENTITY_GUID"] }
      : {}),
  };
  return attachNewRelicExporter(bus, opts);
}

export {
  scrubLicenseKey as _scrubLicenseKeyForTest,
  wrapFetchWithEntityGuid as _wrapFetchWithEntityGuidForTest,
};
