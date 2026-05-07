import { lookup as dnsLookup } from "node:dns/promises";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

/**
 * Section 14 — generic HTTP fetch tool for API integrations.
 *
 * Defenses, layered fail-closed:
 *   1. Empty allow-list ⇒ deny all.
 *   2. URL scheme must be http or https.
 *   3. Origin (scheme+host+port) must match an entry in the allow-list
 *      exactly after canonicalisation (lowercase host, default ports
 *      normalised away).
 *   4. SSRF: even if a host is on the allow-list, reject loopback,
 *      link-local, RFC1918, and mDNS targets — both literal and as
 *      DNS-resolved IPs.
 *   5. Manual redirect handling, max 5; allow-list + SSRF re-checked at
 *      every hop.
 *   6. 30 s default timeout (honours `ctx.signal`).
 *   7. 5 MB response body cap (streaming abort once exceeded).
 *   8. `Cookie` and `Authorization` headers are stripped from the
 *      response before returning to the model.
 *
 * Layer R4. Pairs with the `target-cli` codegen contract — `BUILTIN_TOOL_MAP`
 * declares `fetch: { initSymbol: "registerFetchConfig" }` so the bundle
 * boot block calls `registerFetchConfig({ allowed_origins: [...] })`
 * before running the agent.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export class FetchPermissionError extends CrewhausError {
  override readonly name = "FetchPermissionError";
  constructor(message: string) {
    super("tool", message);
  }
}

const fetchSchema = z.object({
  url: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
  body: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

export type FetchConfig = {
  /**
   * Canonicalised origins (scheme + lowercase host + non-default port).
   * An empty list (default) denies every URL.
   */
  readonly allowedOrigins: ReadonlySet<string>;
};

let fetchConfig: FetchConfig = { allowedOrigins: new Set() };

export type FetchConfigInput = {
  readonly allowed_origins?: readonly string[];
  readonly allowedOrigins?: readonly string[];
};

/**
 * Replace the active Fetch config. Codegen calls this at boot from the
 * spec's `tool_config.fetch` block. Both snake_case and camelCase keys
 * are accepted so callers can pass the spec object verbatim.
 */
export function registerFetchConfig(input: FetchConfigInput): void {
  const raw = input.allowedOrigins ?? input.allowed_origins ?? [];
  const canonical = new Set<string>();
  for (const origin of raw) {
    canonical.add(canonicalizeOrigin(origin));
  }
  fetchConfig = { allowedOrigins: canonical };
}

export function getFetchConfig(): FetchConfig {
  return fetchConfig;
}

/** Test-only — reset config back to fail-closed empty. */
export function _resetFetchConfig(): void {
  fetchConfig = { allowedOrigins: new Set() };
}

/**
 * Canonicalise an origin string for exact-match comparison:
 *   - require a non-empty scheme + host
 *   - lowercase scheme and host
 *   - drop the path/query/fragment
 *   - elide default ports (80 for http, 443 for https) so callers can
 *     write either "https://api.x.com" or "https://api.x.com:443"
 *
 * Throws `FetchPermissionError` for malformed origins so misconfiguration
 * surfaces at boot time rather than first request.
 */
export function canonicalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchPermissionError(`invalid origin "${raw}" — must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchPermissionError(
      `invalid origin "${raw}" — only http/https schemes are supported`,
    );
  }
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (host === "") {
    throw new FetchPermissionError(`invalid origin "${raw}" — host is required`);
  }
  const portStr = url.port;
  let port = "";
  if (portStr !== "") {
    if ((scheme === "http:" && portStr === "80") || (scheme === "https:" && portStr === "443")) {
      port = "";
    } else {
      port = `:${portStr}`;
    }
  }
  return `${scheme}//${host}${port}`;
}

/**
 * DNS resolver injection point used by tests. Production callers leave it
 * at `dnsLookup` from `node:dns/promises`. Tests either mock it to assert
 * the rebinding-defense path, or stub it to a public-looking IP so the
 * other tests don't depend on actually reaching DNS.
 */
export type DnsLookupFn = (
  host: string,
) => Promise<{ readonly address: string; readonly family: number }>;
let dnsLookupFn: DnsLookupFn = (host) => dnsLookup(host, { verbatim: false });
export function _setDnsLookup(fn: DnsLookupFn | undefined): void {
  dnsLookupFn = fn ?? ((host) => dnsLookup(host, { verbatim: false }));
}

/**
 * Reject any host whose IP literal — or the DNS-resolved IP — sits in a
 * private/loopback/link-local/mDNS range. This blocks SSRF on top of the
 * origin allow-list (defence in depth: even if `localhost` is in the
 * allow-list, we still reject it here).
 */
export async function assertNotSsrf(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new FetchPermissionError(`SSRF: host "${hostname}" resolves to loopback`);
  }
  if (lower.endsWith(".local")) {
    throw new FetchPermissionError(`SSRF: mDNS host "${hostname}" is not allowed`);
  }
  if (isPrivateIp(lower)) {
    throw new FetchPermissionError(`SSRF: host "${hostname}" is a private/loopback IP`);
  }

  // Resolve the hostname so a public-looking name that points to 127.0.0.1
  // (DNS rebinding) is still caught.
  let resolved: { readonly address: string; readonly family: number };
  try {
    resolved = await dnsLookupFn(lower);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FetchPermissionError(`SSRF: cannot resolve "${hostname}": ${msg}`);
  }
  if (isPrivateIp(resolved.address)) {
    throw new FetchPermissionError(
      `SSRF: host "${hostname}" resolves to private IP ${resolved.address}`,
    );
  }
}

function isPrivateIp(addr: string): boolean {
  // Strip IPv6 brackets if present.
  const ip = addr.replace(/^\[/, "").replace(/\]$/, "");

  // IPv6 loopback / link-local / unique-local
  if (ip === "::1") return true;
  if (ip.toLowerCase().startsWith("fe80:")) return true;
  if (ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd")) return true;

  // IPv4 dotted-quad parsing
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function checkOriginAllowed(url: URL): void {
  if (fetchConfig.allowedOrigins.size === 0) {
    throw new FetchPermissionError(
      `Fetch denied: origin "${url.origin}" is not in allowed_origins (empty allow-list = deny all)`,
    );
  }
  const canonical = canonicalizeOrigin(url.toString());
  if (!fetchConfig.allowedOrigins.has(canonical)) {
    throw new FetchPermissionError(`Fetch denied: origin "${canonical}" is not in allowed_origins`);
  }
}

const STRIPPED_RESPONSE_HEADERS = new Set(["cookie", "set-cookie", "authorization"]);

/**
 * Drain a Response body with a hard byte cap. Aborts the underlying read
 * once the cap is exceeded so a hostile server can't pin memory.
 */
async function readBodyCapped(res: Response): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // ignore — we're already aborting
        }
        throw new FetchPermissionError(`response body exceeded ${MAX_BODY_BYTES} bytes — aborted`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function formatResponse(res: Response, body: string): string {
  const lines: string[] = [`HTTP ${res.status} ${res.statusText}`.trimEnd()];
  for (const [key, value] of res.headers.entries()) {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push("");
  lines.push(body);
  return lines.join("\n");
}

/**
 * Fetcher injection point used by tests so they can supply a mocked
 * `fetch` without touching the network. Production callers leave it at
 * `globalThis.fetch`.
 */
export type RawFetch = (req: Request) => Promise<Response>;
let rawFetch: RawFetch = (req) => globalThis.fetch(req);
export function _setRawFetch(fn: RawFetch | undefined): void {
  rawFetch = fn ?? ((req) => globalThis.fetch(req));
}

async function performFetch(
  initialUrl: URL,
  method: string,
  body: string | undefined,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
      throw new FetchPermissionError(
        `Fetch denied: scheme "${currentUrl.protocol}" — only http/https allowed`,
      );
    }
    checkOriginAllowed(currentUrl);
    await assertNotSsrf(currentUrl.hostname);

    const init: RequestInit = {
      method,
      redirect: "manual",
      signal,
      ...(body !== undefined ? { body } : {}),
      headers: headers ?? {},
    };
    const res = await rawFetch(new Request(currentUrl.toString(), init));

    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const loc = res.headers.get("location") ?? "";
      let next: URL;
      try {
        next = new URL(loc, currentUrl);
      } catch {
        throw new FetchPermissionError(`invalid redirect target "${loc}"`);
      }
      currentUrl = next;
      // Drain and discard the redirect body so the connection can be
      // reused by the runtime.
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      continue;
    }
    return res;
  }
  throw new FetchPermissionError(`too many redirects (>${MAX_REDIRECTS})`);
}

export const fetch: RegisteredTool = buildTool({
  name: "Fetch",
  description:
    "HTTP(S) request to an explicitly allow-listed origin. Returns status, headers (Cookie/Authorization stripped), and body (≤5 MB). Methods: GET/POST/PUT/DELETE. Refuses loopback, link-local, RFC1918, and mDNS targets even when allow-listed.",
  inputSchema: fetchSchema,
  execute: async (input, ctx) => {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new FetchPermissionError(`invalid URL "${input.url}"`);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("fetch timeout")), DEFAULT_TIMEOUT_MS);
    if (ctx?.signal !== undefined) {
      if (ctx.signal.aborted) ctrl.abort(ctx.signal.reason);
      else
        ctx.signal.addEventListener("abort", () => ctrl.abort(ctx.signal?.reason), {
          once: true,
        });
    }
    try {
      const res = await performFetch(
        url,
        input.method ?? "GET",
        input.body,
        input.headers,
        ctrl.signal,
      );
      const body = await readBodyCapped(res);
      return formatResponse(res, body);
    } finally {
      clearTimeout(timer);
    }
  },
});
