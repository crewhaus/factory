/**
 * The network posture for `@crewhaus/tool-registry`.
 *
 * Every outbound byte this package sends leaves through `getJson`, and it can
 * only ever land on one of three origins that are written down HERE. That is
 * the whole design: unlike `@crewhaus/tool-fetch` and
 * `@crewhaus/tool-codehost`, no caller — model or spec — supplies a URL, a
 * host or an origin. A caller supplies a package NAME, the name is validated
 * against its ecosystem's grammar (see `./names`), and the URL is built from a
 * constant. There is no allow-list to widen and no private-mirror escape
 * hatch, because either would put a model-chosen host back into the dialling
 * path, which is the hole both of those packages spend hundreds of lines
 * defending.
 *
 * What survives from those packages, because it still applies:
 *
 *   1. Redirects are followed by hand, capped, and re-checked against the
 *      same three origins at every hop. A registry that 302s to an object
 *      store is not followed there.
 *   2. Bodies are byte-capped WHILE being read, and a body that hits the cap
 *      is refused rather than parsed as a prefix — half a packument parses to
 *      nothing useful, but half a JSON array can parse to a plausible WRONG
 *      answer.
 *   3. The SSRF gate and the IP pin live in the default dialler, which is what
 *      `_setRegistryFetch` replaces. Tests drive the seam, so nothing below it
 *      — no DNS, no socket — is reachable from a test, which is the point:
 *      the suite runs on a CI box with no egress.
 *
 * No request carries a credential. These are anonymous reads of public
 * metadata; there is nothing to put in an Authorization header and so nothing
 * to leak at a redirect.
 */
import { CrewhausError } from "@crewhaus/errors";
import { assertNotSsrf } from "@crewhaus/tool-fetch";

/** A refusal by the origin rule, the redirect rule or the byte cap. */
export class RegistryError extends CrewhausError {
  override readonly name = "RegistryError";
  constructor(message: string) {
    super("tool", message);
  }
}

/** The three registries this package can read. */
export type Ecosystem = "npm" | "pypi" | "crates";

/**
 * The only origins this package ever dials. A URL built anywhere in this
 * package is checked against this set before it is dialled, so a bug in a
 * path template can only ever produce a 404, never a request somewhere else.
 */
export const REGISTRY_ORIGINS: Readonly<Record<Ecosystem, string>> = Object.freeze({
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org",
  crates: "https://crates.io",
});

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(Object.values(REGISTRY_ORIGINS));

/**
 * crates.io answers 403 to a request with no User-Agent, and its crawler
 * policy asks for one that identifies the caller and says where to complain.
 * npm and PyPI do not care, so one header for all three keeps the request
 * path identical.
 */
export const USER_AGENT = "crewhaus-tool-registry (+https://github.com/crewhaus/factory)";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_REDIRECTS = 3;

/**
 * 8 MB. A packument for a package with thousands of releases genuinely runs
 * to megabytes, and this is memory, not context — only the handful of fields
 * a tool extracts is ever returned. The cap exists so one pathological
 * package cannot pin the process, and hitting it is reported as a refusal
 * with the number in it.
 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Compact JSON — every byte returned is a byte in somebody's context window. */
export const json = (value: unknown): string => JSON.stringify(value);

/** Locale-independent string order. `localeCompare` without a locale is not deterministic. */
export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// the seam
// ---------------------------------------------------------------------------

/**
 * The dialling step, as one function, so a test can replace all of it.
 *
 * All of it is the point: the SSRF check and the IP pin live BELOW this seam,
 * inside the default dialler, so a test that installs a stub never resolves a
 * name. The alternative — checking above the seam — would make every test in
 * this package depend on DNS for registry.npmjs.org.
 */
export type RegistryFetch = (req: Request) => Promise<Response>;

/**
 * Dial the vetted IP while keeping the real hostname for the `Host` header
 * and TLS SNI, so virtual hosting and certificate validation still work.
 * Carried over from `tool-fetch`'s `pinnedFetch` rather than re-derived — a
 * fourth hand-written version of this would be the fourth chance to get the
 * SNI wrong.
 *
 * NOTE: this function and `guardedFetch` below are the two lines of this
 * package that no test executes, because executing them means resolving a
 * name and opening a socket. That is deliberate: `_setRegistryFetch` replaces
 * both, and a test that reached a real registry would fail on a runner with
 * no egress and flake on somebody else's rate limit.
 */
function pinnedFetch(req: Request, pinnedIp: string): Promise<Response> {
  const original = new URL(req.url);
  const host = original.hostname;
  if (host === pinnedIp || pinnedIp === "") return globalThis.fetch(req);

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

/**
 * The production dialler: vet the host, then dial the address that was vetted.
 *
 * The three origins are public names, so this is defence in depth rather than
 * the main gate — but a resolver that answers 127.0.0.1 for registry.npmjs.org
 * is exactly the case where "we only talk to npm" stops being true.
 */
const guardedFetch: RegistryFetch = async (req) => {
  const url = new URL(req.url);
  const pinnedIp = await assertNotSsrf(url.hostname);
  return pinnedFetch(req, pinnedIp);
};

let registryFetch: RegistryFetch = guardedFetch;

/**
 * Test-only injection point, the convention every networked package here
 * follows. `undefined` restores the guarded dialler; a suite that sets it
 * must restore it, or the next file in the same bun process inherits a stub.
 */
export function _setRegistryFetch(fn: RegistryFetch | undefined): void {
  registryFetch = fn ?? guardedFetch;
}

// ---------------------------------------------------------------------------
// the request path
// ---------------------------------------------------------------------------

/**
 * Why a read did not produce a document. Each one is a different next move
 * for the caller, which is why they are not collapsed into one boolean:
 * `notFound` is an answer about the package, `rateLimited` means try later,
 * `tooLarge` means the package is too big to answer about at all, and
 * `malformed` means the registry said something this package cannot read.
 */
export type FetchFailureKind =
  | "notFound"
  | "rateLimited"
  | "status"
  | "tooLarge"
  | "malformed"
  | "refused"
  | "transport";

export type JsonFetch =
  | { readonly ok: true; readonly value: unknown; readonly status: number; readonly bytes: number }
  | {
      readonly ok: false;
      readonly kind: FetchFailureKind;
      readonly status?: number;
      readonly message: string;
      /** Seconds the registry asked us to wait, when it said. */
      readonly retryAfter?: string;
    };

export type GetJsonOptions = {
  readonly signal?: AbortSignal;
  readonly accept?: string;
  readonly maxBytes?: number;
};

/** Refuse a URL whose origin is not one of the three constants above. */
function assertKnownOrigin(url: URL): void {
  if (!ALLOWED_ORIGINS.has(url.origin)) {
    throw new RegistryError(
      `refusing to dial "${url.origin}" — this package only reaches ${[...ALLOWED_ORIGINS].join(", ")}`,
    );
  }
}

/**
 * GET a JSON document from one of the three registries.
 *
 * Failures are RETURNED, not thrown, because the caller with the most at
 * stake — `RegistryOutdated`, reading fifty packages — wants a row saying
 * what went wrong for one package rather than losing the other forty-nine.
 * The one exception is a URL whose origin is not ours, which is a defect in
 * this package and throws.
 */
export async function getJson(rawUrl: string, options: GetJsonOptions = {}): Promise<JsonFetch> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new RegistryError(`built an invalid registry URL: "${rawUrl}"`);
  }
  assertKnownOrigin(current);

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const headers: Record<string, string> = {
    accept: options.accept ?? "application/json",
    "user-agent": USER_AGENT,
  };

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      const init: RequestInit = { method: "GET", redirect: "manual", headers };
      if (options.signal !== undefined) init.signal = options.signal;
      res = await registryFetch(new Request(current.toString(), init));
    } catch (err) {
      if (err instanceof RegistryError) return { ok: false, kind: "refused", message: err.message };
      const error = err as Error;
      if (error?.name === "FetchPermissionError") {
        // What `assertNotSsrf` throws when the name resolved somewhere it
        // will not dial. That is a refusal, not a transport failure: the
        // caller should not read it as "the registry was unreachable, try
        // again", because trying again is exactly what will not help.
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
        // A registry that points somewhere else is not followed there. The
        // three origins are the trust boundary; a 302 is not a reason to
        // move it.
        return {
          ok: false,
          kind: "refused",
          message: `refusing a redirect from ${safeLabel(current)} to "${next.origin}" — outside the registry origins this package reads`,
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
      // Parsing the prefix is the tempting mistake: a truncated array can
      // still parse into a shorter, plausible, WRONG list of versions.
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

/** Scheme, host and path — never the query, which can carry a search term. */
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
 * is passed. The cap bounds MEMORY, not just what is kept: chunks past it are
 * never retained and the reader is cancelled rather than drained.
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
  expired(): boolean;
  /** Clear the timer. Always call it, or the process keeps a handle alive. */
  cancel(): void;
};

/**
 * A deadline that also honours the runtime's own cancellation. Every tool
 * here opens one before its first byte and cancels it in a `finally` — a tool
 * that can hang forever is a defect, and one that fans out over fifty
 * packages can hang in fifty ways.
 */
export function startDeadline(ms: number, outer?: AbortSignal): Deadline {
  const ctrl = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => ctrl.abort(new Error(`deadline of ${ms}ms elapsed`)), ms);
  const onOuter = (): void => ctrl.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: ctrl.signal,
    expired: () => Date.now() - startedAt >= ms,
    cancel: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

/**
 * Run `work` over `items` with at most `limit` in flight, preserving input
 * order in the result.
 *
 * Order is preserved because the result is a TABLE: a row order that depends
 * on which registry answered first is a diff that changes for no reason
 * between two identical runs.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await work(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return out;
}
