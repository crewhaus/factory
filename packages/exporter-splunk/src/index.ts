import { type AttachedOtelExporter, attachOtelExporter } from "@crewhaus/otel-exporter";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

/**
 * Catalog R15 `exporter-splunk` — Splunk Observability Cloud exporter.
 *
 * Section 37. OTLP/HTTP exporter pointed at
 * `https://ingest.<realm>.signalfx.com/v2/trace/otlp` with the
 * `X-SF-TOKEN` access-token header.
 *
 * Honors:
 *   SPLUNK_REALM         — required (e.g. "us0", "us1", "eu0")
 *   SPLUNK_ACCESS_TOKEN  — required
 *   SPLUNK_INDEX         — optional, surfaces as `splunk.index` resource attr
 *   SPLUNK_SOURCE        — optional, surfaces as `splunk.source` resource attr
 *
 * SECURITY (T8 credential-leak guard): the access token is scrubbed
 * from any error message before bubbling up to the caller.
 */

export type SplunkExporterOptions = {
  /** Splunk realm (e.g. "us0", "us1", "eu0"). Required unless `endpoint` is set. */
  realm?: string;
  /** Override endpoint (sidecar collector etc.). Takes precedence over `realm`. */
  endpoint?: string;
  /** Splunk access token. Sent in the `X-SF-TOKEN` header. */
  accessToken?: string;
  /** OTel `service.name` resource attribute. */
  serviceName?: string;
  /** Maps to `splunk.index` resource attribute. */
  index?: string;
  /** Maps to `splunk.source` resource attribute. */
  source?: string;
  /** Override the 5s batch flush interval. */
  flushIntervalMs?: number;
  /** Test seam — override fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — capture errors. */
  onError?: (err: Error) => void;
};

export type AttachedSplunkExporter = AttachedOtelExporter;

export function buildSplunkEndpoint(realm: string): string {
  return `https://ingest.${realm}.signalfx.com/v2/trace/otlp`;
}

function scrubAccessToken(message: string, token: string | undefined): string {
  if (token === undefined || token.length < 8) return message;
  return message.split(token).join("[REDACTED:SPLUNK_ACCESS_TOKEN]");
}

export function attachSplunkExporter(
  bus: TraceEventBus,
  opts: SplunkExporterOptions = {},
): AttachedSplunkExporter {
  const accessToken = opts.accessToken;
  const serviceName = opts.serviceName ?? "crewhaus";

  let endpoint: string;
  if (opts.endpoint !== undefined) {
    endpoint = opts.endpoint;
  } else if (opts.realm !== undefined) {
    if (!/^[a-z0-9]+$/.test(opts.realm)) {
      throw new Error(`SPLUNK_REALM "${opts.realm}" is not lowercase alphanumeric`);
    }
    endpoint = buildSplunkEndpoint(opts.realm);
  } else {
    throw new Error("attachSplunkExporter requires either `realm` or `endpoint`");
  }

  const headers: Record<string, string> = {};
  if (accessToken !== undefined) {
    headers["X-SF-TOKEN"] = accessToken;
  }

  const baseOnError = opts.onError;
  const onError = (err: Error): void => {
    const safeMessage = scrubAccessToken(err.message, accessToken);
    const wrapped = err.message === safeMessage ? err : new Error(safeMessage);
    if (baseOnError) {
      baseOnError(wrapped);
    } else {
      process.stderr.write(`[exporter-splunk] export failed: ${wrapped.message}\n`);
    }
  };

  // Surface splunk.index / splunk.source via a fetch wrapper that
  // injects the resource attrs into the OTLP payload before send.
  const splunkAttrs: { index?: string; source?: string } = {};
  if (opts.index !== undefined) splunkAttrs.index = opts.index;
  if (opts.source !== undefined) splunkAttrs.source = opts.source;
  const wrappedFetch = wrapFetchWithSplunkAttrs(opts.fetchImpl ?? fetch, splunkAttrs);

  return attachOtelExporter(bus, {
    endpoint,
    serviceName,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(opts.flushIntervalMs !== undefined ? { flushIntervalMs: opts.flushIntervalMs } : {}),
    fetchImpl: wrappedFetch,
    onError,
  });
}

function wrapFetchWithSplunkAttrs(
  baseFetch: typeof fetch,
  attrs: { index?: string; source?: string },
): typeof fetch {
  if (attrs.index === undefined && attrs.source === undefined) {
    return baseFetch;
  }
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.body && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed?.resourceSpans !== undefined && Array.isArray(parsed.resourceSpans)) {
          const extras: Array<{ key: string; value: { stringValue: string } }> = [];
          if (attrs.index !== undefined)
            extras.push({ key: "splunk.index", value: { stringValue: attrs.index } });
          if (attrs.source !== undefined)
            extras.push({ key: "splunk.source", value: { stringValue: attrs.source } });
          for (const rs of parsed.resourceSpans) {
            const existing = Array.isArray(rs?.resource?.attributes) ? rs.resource.attributes : [];
            rs.resource = { attributes: [...existing, ...extras] };
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

export function attachSplunkIfEnvSet(
  bus: TraceEventBus,
  env: NodeJS.ProcessEnv = process.env,
): AttachedSplunkExporter | undefined {
  const realm = env["SPLUNK_REALM"];
  const accessToken = env["SPLUNK_ACCESS_TOKEN"];
  if (realm === undefined || accessToken === undefined) return undefined;

  const opts: SplunkExporterOptions = {
    realm,
    accessToken,
    ...(env["OTEL_SERVICE_NAME"] !== undefined ? { serviceName: env["OTEL_SERVICE_NAME"] } : {}),
    ...(env["SPLUNK_INDEX"] !== undefined ? { index: env["SPLUNK_INDEX"] } : {}),
    ...(env["SPLUNK_SOURCE"] !== undefined ? { source: env["SPLUNK_SOURCE"] } : {}),
  };
  return attachSplunkExporter(bus, opts);
}

export { scrubAccessToken as _scrubAccessTokenForTest };
