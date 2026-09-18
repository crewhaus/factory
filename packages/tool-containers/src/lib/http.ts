/**
 * The HTTP floor these tools stand on: SSRF-guarded, redirect-aware, and
 * BYTE-PRESERVING.
 *
 * Byte preservation is the whole reason this is not `globalThis.fetch(...)
 * .then(r => r.json())`. A manifest's digest is sha256 over the exact bytes the
 * registry sent; decoding to a string and re-encoding is lossless only for
 * well-formed UTF-8, and `JSON.parse` + `JSON.stringify` is not lossless at
 * all. Everything here hands the caller a `Uint8Array` and lets the caller
 * decide when it is safe to parse.
 *
 * The SSRF guard is `@crewhaus/tool-fetch`'s `assertNotSsrf` — the same
 * checker the Fetch tool uses, including the DNS-rebinding backstop and the
 * pinned IP it returns. A registry that answers a manifest request with
 * `302 Location: http://169.254.169.254/latest/meta-data/` is the attack this
 * closes, and it closes it at EVERY hop, not just the first.
 */
import { assertNotSsrf } from "@crewhaus/tool-fetch";

export class RegistryHttpError extends Error {
  override readonly name = "RegistryHttpError";
}

/** Registries redirect blobs to object storage; five hops is already generous. */
const MAX_REDIRECTS = 5;

export type RawResponse = {
  readonly status: number;
  readonly headers: Headers;
  /** The response body exactly as it arrived. Never decoded, never re-encoded. */
  readonly bytes: Uint8Array;
  /** The URL the body actually came from, after redirects. */
  readonly url: string;
};

/**
 * Fetch injection point. Tests replace it so the suite never opens a socket;
 * production leaves it at `pinnedFetch`, which dials the exact IP the SSRF
 * check validated.
 */
export type RegistryFetch = (req: Request, pinnedIp: string) => Promise<Response>;

/**
 * Dial `pinnedIp` while keeping the real hostname for the Host header and TLS
 * SNI, so certificate validation and virtual-host routing still work. Mirrors
 * `@crewhaus/tool-fetch`'s own dialer, which is module-private there: resolving
 * in the guard and letting `fetch` re-resolve at connect time is a rebinding
 * TOCTOU, so the pin has to be applied by whoever makes the request.
 */
function pinnedFetch(req: Request, pinnedIp: string): Promise<Response> {
  const original = new URL(req.url);
  const host = original.hostname;
  const unbracketed = host.replace(/^\[/, "").replace(/\]$/, "");
  if (pinnedIp === "" || unbracketed === pinnedIp) return globalThis.fetch(req);

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

let rawFetch: RegistryFetch = pinnedFetch;

/** Test seam — `_setFetch(undefined)` restores the production dialer. */
export function _setFetch(fn: RegistryFetch | undefined): void {
  rawFetch = fn ?? pinnedFetch;
}

export type GetOptions = {
  readonly accept?: string;
  readonly authorization?: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  /** `HEAD` is never used here: a body is the only thing we can verify. */
  readonly method?: "GET";
};

const USER_AGENT = "crewhaus-tool-containers/0.6";

/**
 * GET a URL, following redirects by hand.
 *
 * Two rules the default `fetch` would not enforce for us:
 *   - every hop is re-checked against the SSRF guard and pinned to the IP it
 *     validated, because only the first URL is ours — the rest come from the
 *     server;
 *   - the `Authorization` header is DROPPED the moment a redirect leaves the
 *     origin it was minted for. Registries redirect to CDNs and object stores;
 *     forwarding a pull token to `random-bucket.example.com` hands it away.
 */
export async function httpGet(url: URL, options: GetOptions): Promise<RawResponse> {
  const tokenOrigin = url.origin;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "https:" && current.protocol !== "http:") {
      throw new RegistryHttpError(
        `refusing scheme "${current.protocol.replace(":", "")}" — registry requests are http(s) only`,
      );
    }
    const pinnedIp = await assertNotSsrf(current.hostname);

    const headers = new Headers({ "user-agent": USER_AGENT });
    if (options.accept !== undefined) headers.set("accept", options.accept);
    if (options.authorization !== undefined && current.origin === tokenOrigin) {
      headers.set("authorization", options.authorization);
    }

    const res = await rawFetch(
      new Request(current.toString(), {
        method: options.method ?? "GET",
        redirect: "manual",
        headers,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      }),
      pinnedIp,
    );

    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const location = res.headers.get("location") ?? "";
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new RegistryHttpError(`registry redirected to an unparseable location "${location}"`);
      }
      try {
        await res.body?.cancel();
      } catch {
        // Already discarding this response; a failed cancel changes nothing.
      }
      current = next;
      continue;
    }

    const bytes = await readCapped(res, options.maxBytes);
    return { status: res.status, headers: res.headers, bytes, url: current.toString() };
  }
  throw new RegistryHttpError(`registry redirected more than ${MAX_REDIRECTS} times`);
}

/**
 * Drain a body with a hard byte cap, aborting the read once it is exceeded so a
 * hostile or misconfigured registry cannot pin memory. Concatenation happens
 * once at the end, over the exact chunks that arrived.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Already aborting.
        }
        throw new RegistryHttpError(
          `response body exceeded ${maxBytes} bytes — aborted before reading it all`,
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be released; nothing to do.
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * A signal that aborts on the caller's cancellation OR after `timeoutMs`,
 * whichever comes first. The returned `dispose` must run in a `finally` so a
 * fast call does not leave a timer holding the process open.
 */
export function deadlineSignal(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new RegistryHttpError(`registry request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onAbort = (): void => controller.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}
