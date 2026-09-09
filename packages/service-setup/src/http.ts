/**
 * The one HTTP seam every service client goes through.
 *
 * Factory has no shared fetch wrapper — the house convention is bare global
 * `fetch` behind an injected `readonly fetchImpl?: typeof fetch`, with
 * `AbortSignal.timeout(ms)` and a `res.json().catch(() => ({}))` tolerance
 * for non-JSON error bodies. This module is that convention written once,
 * so the three clients cannot drift on timeouts or on how a body that isn't
 * JSON is handled.
 *
 * It deliberately does NOT retry. Two of the three providers have
 * side-effecting POSTs whose idempotency we do not control (Slack's
 * `apps.manifest.create` mints an app whose signing secret is returned
 * exactly once), so a blind retry can leave an orphan. Callers that want a
 * retry ask for one explicitly, around a call they know is safe to repeat.
 */
import type { ServiceDeps } from "./types";

export const DEFAULT_TIMEOUT_MS = 30_000;

export type JsonRequest = {
  readonly url: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialized as JSON when present. */
  readonly json?: unknown;
  /** Sent as `application/x-www-form-urlencoded`. Mutually exclusive with `json`. */
  readonly form?: Readonly<Record<string, string>>;
};

export type JsonResponse = {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed body, or `{}` when the body was empty or not JSON. */
  readonly body: unknown;
  /** Response headers, lowercased keys. */
  readonly headers: Readonly<Record<string, string>>;
};

/**
 * Perform one JSON request. Never throws on a non-2xx — the status comes back
 * for the caller to classify, because each provider encodes failure
 * differently (Slack answers 200 with `ok: false`, Cloudflare and Thredz use
 * real status codes).
 *
 * A transport failure (DNS, TLS, timeout) DOES throw, wrapped so the message
 * names the host instead of surfacing a bare `TypeError: fetch failed`.
 */
export async function requestJson(req: JsonRequest, deps: ServiceDeps = {}): Promise<JsonResponse> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(req.form).toString();
  } else if (req.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.json);
  }

  let res: Response;
  try {
    res = await doFetch(req.url, {
      method: req.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const host = safeHost(req.url);
    const reason = err instanceof Error ? err.message : String(err);
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(
      timedOut
        ? `${host} did not respond within ${timeoutMs}ms`
        : `could not reach ${host}: ${reason}`,
    );
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = {};
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      // A non-JSON body (an HTML error page from a proxy, say) is not fatal —
      // the status still classifies the failure, and the raw text is kept so
      // an unexpected shape is debuggable.
      parsed = { _raw: text.slice(0, 2000) };
    }
  }

  const outHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    outHeaders[key.toLowerCase()] = value;
  });

  return { status: res.status, ok: res.ok, body: parsed, headers: outHeaders };
}

/** Host for an error message, tolerant of an unparseable URL. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Narrow an unknown parsed body to a record without `any`. */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read a string field off an unknown body, or undefined. */
export function readString(value: unknown, key: string): string | undefined {
  const v = asRecord(value)[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}
