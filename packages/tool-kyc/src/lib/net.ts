/**
 * The network posture for `@crewhaus/tool-kyc`.
 *
 * Two of this package's three tools read a public register over HTTPS, and
 * every byte they send leaves through `getJson`. As in `@crewhaus/tool-registry`,
 * no caller supplies a URL, a host or an origin: a caller supplies a VAT id,
 * an LEI, a CIK or a ticker, the value is checked against its own grammar, and
 * the URL is built from one of the constants below. There is no allow-list to
 * widen.
 *
 * No request carries a credential. VIES, HMRC's VAT checker, GLEIF and SEC
 * EDGAR are all open-access endpoints; there is nothing to put in an
 * `Authorization` header, so there is nothing to leak at a redirect. If one of
 * them ever answers 401 or 403, that is reported as *could-not-check* with the
 * status in it, never as "not registered" — see `ALWAYS THREE OUTCOMES` in the
 * README.
 *
 * The SSRF gate and the connect-time IP pin live in the default dialler, which
 * is what `_setKycFetch` replaces, so no test in this package resolves a name
 * or opens a socket.
 */
import { CrewhausError } from "@crewhaus/errors";
import { assertNotSsrf } from "@crewhaus/tool-fetch";

/** A refusal by the origin rule, the redirect rule or the byte cap. */
export class KycNetworkError extends CrewhausError {
  override readonly name = "KycNetworkError";
  constructor(message: string) {
    super("tool", message);
  }
}

/**
 * Every origin this package can dial, and the only ones.
 *
 * `www.sec.gov` is here as well as `data.sec.gov` because EDGAR's
 * ticker→CIK map is published on the website host while the submissions
 * documents are on the data host — one company lookup by ticker legitimately
 * touches both.
 */
export const ORIGINS = Object.freeze({
  /** VIES, the EU's proxy to the member states' own VAT systems. */
  vies: "https://ec.europa.eu",
  /** HMRC's VAT check-a-number API. VIES has not covered GB since 2021. */
  hmrc: "https://api.service.hmrc.gov.uk",
  /** GLEIF, the LEI issuer of record. */
  gleif: "https://api.gleif.org",
  /** EDGAR submissions. */
  edgarData: "https://data.sec.gov",
  /** EDGAR's ticker→CIK map. */
  edgarFiles: "https://www.sec.gov",
});

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(Object.values(ORIGINS));

/**
 * SEC asks every automated reader for a User-Agent that identifies the caller
 * and says where to complain, and answers 403 without one. The others do not
 * care, so one header for all four keeps the request path identical.
 */
export const USER_AGENT = "crewhaus-tool-kyc (+https://github.com/crewhaus/factory)";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_REDIRECTS = 3;

/**
 * 8 MB. An EDGAR submissions document for a frequent filer genuinely runs to
 * megabytes and the ticker map is over a megabyte on its own; this is memory,
 * not context, since only a handful of fields is ever returned.
 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Compact JSON — every byte returned is a byte in somebody's context window. */
export const json = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------
// the seam
// ---------------------------------------------------------------------------

export type KycFetch = (req: Request) => Promise<Response>;

/**
 * Dial the vetted IP while keeping the real hostname for the `Host` header and
 * TLS SNI. Carried over from `tool-fetch`'s own dialler rather than
 * re-derived: resolving in the guard and letting `fetch` resolve again at
 * connect time is a DNS-rebinding TOCTOU, so the pin has to be applied by
 * whoever makes the request.
 *
 * This function and `guardedFetch` are the two things in this package no test
 * executes, because executing them means opening a socket. That is the point
 * of putting the seam above them.
 */
function pinnedFetch(req: Request, pinnedIp: string): Promise<Response> {
  const original = new URL(req.url);
  const host = original.hostname;
  if (pinnedIp === "" || host === pinnedIp) return globalThis.fetch(req);

  const pinnedUrl = new URL(original.toString());
  pinnedUrl.hostname = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;
  const headers = new Headers(req.headers);
  headers.set("host", original.port === "" ? host : `${host}:${original.port}`);
  const init: RequestInit & { tls?: { serverName: string } } = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: req.signal,
    tls: { serverName: host },
  };
  return globalThis.fetch(pinnedUrl.toString(), init);
}

const guardedFetch: KycFetch = async (req) => {
  const url = new URL(req.url);
  const pinnedIp = await assertNotSsrf(url.hostname);
  return pinnedFetch(req, pinnedIp);
};

let kycFetch: KycFetch = guardedFetch;

/**
 * Test-only injection point, the convention every networked package here
 * follows. `undefined` restores the guarded dialler; a suite that sets it must
 * restore it, or the next file in the same bun process inherits the stub.
 */
export function _setKycFetch(fn: KycFetch | undefined): void {
  kycFetch = fn ?? guardedFetch;
}

// ---------------------------------------------------------------------------
// the request path
// ---------------------------------------------------------------------------

/**
 * Why a read did not produce a document.
 *
 * These are kept apart because they are different answers about the SUBJECT,
 * not just different plumbing failures. `notFound` is genuinely about the
 * thing asked for — no LEI record with that id — and every other kind means
 * *this tool could not find out*, which is the distinction the whole package
 * exists to preserve.
 */
export type FetchFailureKind =
  | "notFound"
  | "rateLimited"
  | "unauthorized"
  | "status"
  | "tooLarge"
  | "malformed"
  | "refused"
  | "transport";

/** The kinds that mean "could not check", i.e. everything except `notFound`. */
export function isUnavailable(kind: FetchFailureKind): boolean {
  return kind !== "notFound";
}

export type JsonFetch =
  | { readonly ok: true; readonly value: unknown; readonly status: number; readonly bytes: number }
  | {
      readonly ok: false;
      readonly kind: FetchFailureKind;
      readonly status?: number;
      readonly message: string;
      /** Seconds the server asked us to wait, when it said. */
      readonly retryAfter?: string;
    };

export type GetJsonOptions = {
  readonly signal?: AbortSignal;
  readonly accept?: string;
  readonly maxBytes?: number;
  /**
   * A JSON body, which makes the call a POST.
   *
   * Exactly one endpoint needs it: VIES issues a consultation number — the
   * receipt an auditor asks for — only on the two-party call, and that call is
   * a POST. Nothing here sends a body anywhere else, and a POST is never
   * redirected (see below).
   */
  readonly postJson?: unknown;
};

function assertKnownOrigin(url: URL): void {
  if (!ALLOWED_ORIGINS.has(url.origin)) {
    throw new KycNetworkError(
      `refusing to dial "${url.origin}" — this package only reaches ${[...ALLOWED_ORIGINS].join(", ")}`,
    );
  }
}

/**
 * GET a JSON document from one of the registers above.
 *
 * Failures are RETURNED rather than thrown: a caller reading four registers
 * wants a row saying what went wrong with one of them, not to lose the other
 * three. The one exception is a URL whose origin is not ours, which is a
 * defect in this package and throws.
 */
export async function getJson(rawUrl: string, options: GetJsonOptions = {}): Promise<JsonFetch> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new KycNetworkError(`built an invalid URL: "${rawUrl}"`);
  }
  assertKnownOrigin(current);

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const isPost = options.postJson !== undefined;
  const headers: Record<string, string> = {
    accept: options.accept ?? "application/json",
    "user-agent": USER_AGENT,
    ...(isPost ? { "content-type": "application/json" } : {}),
  };

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      const init: RequestInit = {
        method: isPost ? "POST" : "GET",
        redirect: "manual",
        headers,
        ...(isPost ? { body: JSON.stringify(options.postJson) } : {}),
      };
      if (options.signal !== undefined) init.signal = options.signal;
      res = await kycFetch(new Request(current.toString(), init));
    } catch (err) {
      if (err instanceof KycNetworkError)
        return { ok: false, kind: "refused", message: err.message };
      const error = err as Error;
      if (error?.name === "FetchPermissionError") {
        // What `assertNotSsrf` throws when the name resolved somewhere it will
        // not dial. A refusal, not a transport failure: retrying is exactly
        // what will not help.
        return { ok: false, kind: "refused", message: error.message };
      }
      if (error?.name === "AbortError" || options.signal?.aborted === true) {
        return {
          ok: false,
          kind: "transport",
          message: `the deadline elapsed before ${safeLabel(current)} answered`,
        };
      }
      return {
        ok: false,
        kind: "transport",
        message: `could not reach ${safeLabel(current)}: ${error?.message ?? String(err)}`,
      };
    }

    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const location = res.headers.get("location") ?? "";
      await discard(res);
      if (isPost) {
        // A 307/308 re-sends the body and a 302 silently turns it into a GET;
        // neither is something to do on the caller's behalf when the body
        // carries the requester's own VAT id. One endpoint, no redirects.
        return {
          ok: false,
          kind: "refused",
          message: `${safeLabel(current)} redirected a POST to "${location}" — this package does not re-send a body to a new location`,
        };
      }
      if (hop >= MAX_REDIRECTS) {
        return {
          ok: false,
          kind: "refused",
          message: `too many redirects (>${MAX_REDIRECTS}) from ${safeLabel(current)}`,
        };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { ok: false, kind: "refused", message: `invalid redirect target "${location}"` };
      }
      if (!ALLOWED_ORIGINS.has(next.origin)) {
        return {
          ok: false,
          kind: "refused",
          message: `refusing a redirect from ${safeLabel(current)} to "${next.origin}" — outside the registers this package reads`,
        };
      }
      current = next;
      continue;
    }

    if (res.status === 404 || res.status === 410) {
      await discard(res);
      return {
        ok: false,
        kind: "notFound",
        status: res.status,
        message: `${safeLabel(current)} answered ${res.status}`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      await discard(res);
      // These are open-access endpoints, so this means something changed at
      // their end (or a proxy is in the way). It is emphatically NOT evidence
      // about the subject, and a tool that read it as "not registered" would
      // be inventing a legal fact out of an access-control response.
      return {
        ok: false,
        kind: "unauthorized",
        status: res.status,
        message: `${safeLabel(current)} answered ${res.status} — this tool holds no credential for it, so the register could not be read`,
      };
    }
    if (res.status === 429) {
      await discard(res);
      const retryAfter = res.headers.get("retry-after") ?? undefined;
      return {
        ok: false,
        kind: "rateLimited",
        status: 429,
        message: `${safeLabel(current)} rate-limited this read${retryAfter === undefined ? "" : `; it asked for ${retryAfter}s`} — this package does not retry, so the caller decides when to ask again`,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      };
    }
    if (!res.ok) {
      await discard(res);
      return {
        ok: false,
        kind: "status",
        status: res.status,
        message: `${safeLabel(current)} answered ${res.status} ${res.statusText}`.trimEnd(),
      };
    }

    const body = await readCapped(res, maxBytes);
    if (body.truncated) {
      // Parsing the prefix is the tempting mistake: half an EDGAR submissions
      // document still parses into a shorter, plausible, WRONG answer.
      return {
        ok: false,
        kind: "tooLarge",
        status: res.status,
        message: `the document at ${safeLabel(current)} is larger than the ${maxBytes}-byte cap — refusing to answer from a prefix of it`,
      };
    }
    try {
      return { ok: true, value: JSON.parse(body.text), status: res.status, bytes: body.bytes };
    } catch (err) {
      return {
        ok: false,
        kind: "malformed",
        status: res.status,
        message: `${safeLabel(current)} answered ${body.bytes} bytes that are not JSON: ${(err as Error).message}`,
      };
    }
  }
}

/** Scheme, host and path — never the query, which can carry a subject's name. */
export function safeLabel(url: URL | string): string {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed — nothing to release
  }
}

export type CappedBody = {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
};

/**
 * Drain a body with a hard byte cap, cancelling the stream the moment the cap
 * is passed. The cap bounds MEMORY, not just what is kept.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<CappedBody> {
  if (res.body === null) {
    const text = await res.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    return bytes > maxBytes
      ? { text: "", bytes, truncated: true }
      : { text, bytes, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      if (total + value.byteLength > maxBytes) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // already aborting
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  if (truncated) return { text: "", bytes: total, truncated: true };
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(merged),
    bytes: total,
    truncated: false,
  };
}

// ---------------------------------------------------------------------------
// deadlines
// ---------------------------------------------------------------------------

export type Deadline = {
  readonly signal: AbortSignal;
  /** Clear the timer. Always call it, or the process keeps a handle alive. */
  cancel(): void;
};

/**
 * A deadline that also honours the runtime's own cancellation. Every tool here
 * opens one before its first byte and cancels it in a `finally`: VIES in
 * particular can hang for a member state that is half up, and a tool that
 * hangs forever is worse than one that reports `unavailable`.
 */
export function startDeadline(ms: number, outer?: AbortSignal): Deadline {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`deadline of ${ms}ms elapsed`)), ms);
  const onOuter = (): void => ctrl.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

/**
 * An instant, as an ISO-8601 string WITH an offset.
 *
 * Offset-less strings are refused: per ECMAScript they mean local time, so the
 * same evidence record would carry a different day on two machines — and the
 * day a screening ran is the part of the record that matters later.
 */
export function parseInstant(value: string, field: string): number {
  const text = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    throw new Error(
      `${field} ("${text}") has no UTC offset — write it as e.g. 2026-01-01T00:00:00Z, because an offset-less string means local time and would differ between machines`,
    );
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Error(`${field} ("${text}") is not a valid ISO-8601 instant`);
  return parsed;
}
