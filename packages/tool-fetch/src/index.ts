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
  fetchConfig = buildFetchConfig(input);
}

/** Build a config from a spec-shaped block (pure; both key spellings accepted). */
function buildFetchConfig(input: FetchConfigInput): FetchConfig {
  const raw = input.allowedOrigins ?? input.allowed_origins ?? [];
  const canonical = new Set<string>();
  for (const origin of raw) {
    canonical.add(canonicalizeOrigin(origin));
  }
  return { allowedOrigins: canonical };
}

/**
 * 0.6.0 §4.4 — the config ONE call runs under: the serving candidate's
 * `tool_config.fetch` block when its profile declares one
 * (`ToolExecuteContext.toolConfig`, REPLACING the registered block for this
 * call exactly as `registerFetchConfig` replaces it at boot), else the
 * process-global registration. A non-object override is ignored, never
 * widened: the allow-list only ever comes from a spec block.
 */
export function resolveFetchConfig(override: unknown): FetchConfig {
  if (typeof override === "object" && override !== null && !Array.isArray(override)) {
    return buildFetchConfig(override as FetchConfigInput);
  }
  return fetchConfig;
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
// Single production default, referenced by both the initial binding and the
// `_setDnsLookup(undefined)` restorer so there is exactly one resolver function
// to reason about (and to cover). `verbatim: false` keeps the v4/v6 ordering
// deterministic for the SSRF check.
const defaultDnsLookup: DnsLookupFn = (host) => dnsLookup(host, { verbatim: false });
let dnsLookupFn: DnsLookupFn = defaultDnsLookup;
export function _setDnsLookup(fn: DnsLookupFn | undefined): void {
  dnsLookupFn = fn ?? defaultDnsLookup;
}

/**
 * Reject any host whose IP literal — or the DNS-resolved IP — sits in a
 * private/loopback/link-local/mDNS range. This blocks SSRF on top of the
 * origin allow-list (defence in depth: even if `localhost` is in the
 * allow-list, we still reject it here).
 *
 * Returns the validated IP address so the caller can *pin* the connection to
 * that exact host. Resolving here and connecting somewhere else (the default
 * `fetch`, which re-resolves at connect time) is a DNS-rebinding TOCTOU: a
 * hostile resolver can answer with a public IP for this check and a private
 * one (127.0.0.1, 169.254.169.254, …) milliseconds later for the socket.
 * `performFetch` dials the returned address directly. For IP-literal hosts the
 * pinned value is the (normalised) literal itself.
 */
export async function assertNotSsrf(hostname: string): Promise<string> {
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

  // An IP literal is its own pinned target — no DNS lookup, nothing to rebind.
  // Strip any IPv6 brackets so the pinned value matches a resolver's output.
  const unbracketed = lower.replace(/^\[/, "").replace(/\]$/, "");
  const literal = normalizeIpv4(unbracketed) ?? (unbracketed.includes(":") ? unbracketed : null);
  if (literal !== null) {
    return literal;
  }

  // Resolve the hostname so a public-looking name that points to 127.0.0.1
  // (DNS rebinding) is still caught — and return the resolved address so the
  // caller connects to *this* IP rather than re-resolving at connect time.
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
  return resolved.address;
}

/**
 * Normalise an IPv4 literal to canonical dotted-decimal. Browsers and many
 * HTTP stacks accept octal (`0177.0.0.1`), hex (`0x7f.0.0.1` / `0x7f000001`),
 * and 32-bit integer (`2130706433`) forms — all of which resolve to the same
 * address as `127.0.0.1`. We canonicalise here so `isPrivateIp` classifies
 * them, closing an SSRF allow-list bypass. Returns the dotted-decimal form, or
 * `null` if `raw` is not a recognisable IPv4 literal.
 */
function normalizeIpv4(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const parseComponent = (s: string): number | null => {
    if (s === "") return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(s)) {
      value = Number.parseInt(s.slice(2), 16);
    } else if (/^0[0-7]+$/.test(s)) {
      value = Number.parseInt(s, 8);
    } else if (/^[0-9]+$/.test(s)) {
      value = Number.parseInt(s, 10);
    } else {
      return null;
    }
    return Number.isNaN(value) ? null : value;
  };

  const segments = trimmed.split(".");
  if (segments.length > 4) return null;

  const components: number[] = [];
  for (const seg of segments) {
    const value = parseComponent(seg);
    if (value === null || value < 0) return null;
    components.push(value);
  }

  // RFC-3986-style packing: the final component absorbs the remaining bytes
  // (e.g. `127.1` ⇒ 127.0.0.1, `2130706433` ⇒ 127.0.0.1, `0x7f.0.0.1`).
  const n = components.length;
  const octets = [0, 0, 0, 0];
  for (let i = 0; i < n - 1; i++) {
    const c = components[i] as number;
    if (c > 255) return null;
    octets[i] = c;
  }
  const last = components[n - 1] as number;
  const maxLast = 2 ** (8 * (4 - (n - 1)));
  if (last >= maxLast) return null;
  let rest = last;
  for (let i = 3; i >= n - 1; i--) {
    octets[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return octets.join(".");
}

function isPrivateIp(addr: string): boolean {
  // Strip IPv6 brackets if present.
  const ip = addr.replace(/^\[/, "").replace(/\]$/, "");
  const lowerIp = ip.toLowerCase();

  // IPv6 unspecified / loopback / link-local / unique-local
  if (lowerIp === "::" || lowerIp === "::1") return true;
  if (lowerIp.startsWith("fe80:")) return true;
  if (lowerIp.startsWith("fc") || lowerIp.startsWith("fd")) return true;

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 / ::ffff:7f00:1) — classify by the
  // embedded IPv4 address so a mapped literal can't smuggle past the checks.
  const mapped = lowerIp.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1] as string;
    if (tail.includes(".")) {
      return isPrivateIp(tail);
    }
    // Hex form ::ffff:7f00:0001 → 127.0.0.1
    const hexGroups = tail.split(":");
    if (hexGroups.length === 2 && hexGroups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const hi = Number.parseInt(hexGroups[0] as string, 16);
      const lo = Number.parseInt(hexGroups[1] as string, 16);
      return isPrivateIp([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join("."));
    }
    return false;
  }

  // IPv4 — normalise octal/hex/integer literals to dotted-decimal first.
  const normalized = normalizeIpv4(ip);
  if (normalized === null) return false;
  const parts = normalized.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((nn) => Number.isNaN(nn) || nn < 0 || nn > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC6598)
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF protocol (RFC6890)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking (RFC2544)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function checkOriginAllowed(url: URL, cfg: FetchConfig): void {
  if (cfg.allowedOrigins.size === 0) {
    throw new FetchPermissionError(
      `Fetch denied: origin "${url.origin}" is not in allowed_origins (empty allow-list = deny all)`,
    );
  }
  const canonical = canonicalizeOrigin(url.toString());
  if (!cfg.allowedOrigins.has(canonical)) {
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
 * `fetch` without touching the network. Production callers leave it at the
 * IP-pinning default below.
 *
 * `pinnedIp` is the address `assertNotSsrf` validated for `req`'s host. The
 * production fetcher connects to *that* address (preserving the original Host
 * header and TLS SNI) so the socket can't be rebound to a private IP between
 * the SSRF check and `connect()`. Test stubs may ignore the argument.
 */
export type RawFetch = (req: Request, pinnedIp: string) => Promise<Response>;

/**
 * Dial `pinnedIp` directly while keeping the request's original host for the
 * `Host` header and TLS SNI, so certificate validation and virtual-host
 * routing still work against the real hostname.
 */
function pinnedFetch(req: Request, pinnedIp: string): Promise<Response> {
  const original = new URL(req.url);
  const host = original.hostname;
  const hostUnbracketed = host.replace(/^\[/, "").replace(/\]$/, "");

  // Already an IP literal (or no resolution happened) ⇒ nothing to rewrite.
  if (hostUnbracketed === pinnedIp || pinnedIp === "") {
    return globalThis.fetch(req);
  }

  // Rebuild the URL pointing at the pinned IP. Bracket IPv6 literals.
  const hostForUrl = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;
  const pinnedUrl = new URL(original.toString());
  pinnedUrl.hostname = hostForUrl;

  const headers = new Headers(req.headers);
  // Preserve virtual-host routing against the real name.
  headers.set("host", original.port === "" ? host : `${host}:${original.port}`);

  const init: RequestInit & { tls?: { serverName: string } } = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: req.signal,
    // SNI must still be the real hostname so TLS cert validation passes.
    tls: { serverName: host },
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // Streaming a request body in Bun/undici requires duplex: "half".
    (init as { duplex?: string }).duplex = "half";
  }
  return globalThis.fetch(pinnedUrl.toString(), init);
}

let rawFetch: RawFetch = pinnedFetch;
export function _setRawFetch(fn: RawFetch | undefined): void {
  rawFetch = fn ?? pinnedFetch;
}

async function performFetch(
  initialUrl: URL,
  method: string,
  body: string | undefined,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
  cfg: FetchConfig,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
      throw new FetchPermissionError(
        `Fetch denied: scheme "${currentUrl.protocol}" — only http/https allowed`,
      );
    }
    checkOriginAllowed(currentUrl, cfg);
    // Re-validate every hop and pin the connection to the exact IP we just
    // vetted, so a rebinding resolver can't swap in a private address between
    // this check and the socket connect (CWE-367 TOCTOU).
    const pinnedIp = await assertNotSsrf(currentUrl.hostname);

    const init: RequestInit = {
      method,
      redirect: "manual",
      signal,
      ...(body !== undefined ? { body } : {}),
      headers: headers ?? {},
    };
    const res = await rawFetch(new Request(currentUrl.toString(), init), pinnedIp);

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
  // Pillar 3 sink-side: HTTP egress is the canonical external sink. Body
  // and URL parameters can both carry exfiltrated lineage; egress-classifier
  // scans both before the request fires.
  scope: "external",
  // FR-002 — declare the io-capability fact so the compile-time audit binds
  // scope:"external" to this tool by capability, not only by its name.
  ioCapability: "network",
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
        resolveFetchConfig(ctx?.toolConfig),
      );
      const body = await readBodyCapped(res);
      return formatResponse(res, body);
    } finally {
      clearTimeout(timer);
    }
  },
});
