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

// ---------------------------------------------------------------------------
// BEGIN SYNCHRONISED BLOCK — private-address classifier
//
// This block is BYTE-IDENTICAL across every package that guards an outbound
// request. Do not edit one copy: `apps/cli/src/tool-registry.test.ts` hashes
// them all and fails if any differs, and it asserts how many it found, because
// a copy-scanning guard that matches nothing reports green.
//
// It exists in copies rather than a shared package because these files are
// otherwise independent per-package networking layers; a guard proving the
// copies are identical is cheaper and safer than the import graph a shared
// package would need across `crawler`, `computer-use-driver` and ten tools.
//
// WHY IT PARSES INSTEAD OF MATCHING TEXT. Six copies were confirmed
// exploitable on 2026-09-18 because they compared address STRINGS. The WHATWG
// URL parser rewrites `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, so a
// text check never sees the spelling it was written for; and `64:ff9b::a9fe:a9fe`
// IS 169.254.169.254 on any network running DNS64/NAT64. Parsing numerically and
// recursing into the embedded IPv4 is the only form that holds.
//
// WHAT IT CANNOT DO. RFC 6052 lets an operator choose any Network-Specific
// Prefix for NAT64, so an embedded IPv4 behind an arbitrary NSP is undecidable
// from the address alone. That case is configuration, and the callers that need
// it resolve the host and re-check the ANSWER before dialling.
// ---------------------------------------------------------------------------
/**
 * Canonicalise an IPv4 literal.
 *
 * `inet_aton` forms are the classic allow-list bypass: `0177.0.0.1`,
 * `0x7f.0.0.1`, `2130706433` and `127.1` are all 127.0.0.1, and a check that
 * only understands dotted-decimal waves every one of them through. Returns
 * `null` when the string is not an IPv4 literal at all.
 */
export function normalizeIpv4(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || /[^0-9a-fA-FxX.]/.test(trimmed)) return null;
  const parts = trimmed.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }

  // The short forms pack the remaining octets into the last part: `127.1` is
  // 127.0.0.1, not 127.1.0.0. Getting this backwards is how a bypass survives.
  const last = values[values.length - 1] as number;
  const leading = values.slice(0, -1);
  if (leading.some((v) => v > 255)) return null;
  const remaining = 4 - leading.length;
  if (last >= 2 ** (8 * remaining)) return null;

  const octets = [...leading];
  for (let i = remaining - 1; i >= 0; i--) octets.push((last >>> (8 * i)) & 0xff);
  return octets.join(".");
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or `null` when the string
 * is not one.
 *
 * Classifying IPv6 by its TEXT is where the bypasses live, because one address
 * has many spellings and the one a check was written against is rarely the one
 * that arrives. `http://[::ffff:169.254.169.254]/` never reaches a guard in
 * that form: the WHATWG URL parser re-serialises the embedded quad as hex
 * pieces, so what the guard sees is `::ffff:a9fe:a9fe`. Normalising to numbers
 * first means the prefix tests below are arithmetic, and spelling stops
 * mattering.
 */
export function parseIpv6(raw: string): ReadonlyArray<number> | null {
  let text = raw.trim().toLowerCase();
  if (text.startsWith("[")) text = text.slice(1);
  if (text.endsWith("]")) text = text.slice(0, -1);
  const zone = text.indexOf("%"); // fe80::1%eth0
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(":")) return null;

  // A trailing dotted quad is the last two groups written in IPv4. Require all
  // three dots: without that, `::1` parses as a one-part inet_aton address and
  // takes a path that has nothing to do with what was written.
  const dotted = /^(.*:)(\d+(?:\.\d+){3})$/.exec(text);
  if (dotted !== null) {
    const quad = normalizeIpv4(dotted[2] as string);
    if (quad === null) return null;
    const o = quad.split(".").map((n) => Number.parseInt(n, 10)) as number[];
    const hi = ((o[0] as number) << 8) | (o[1] as number);
    const lo = ((o[2] as number) << 8) | (o[3] as number);
    text = `${dotted[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const pieces = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = pieces(halves[0] as string);
  const tail = halves.length === 2 ? pieces(halves[1] as string) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;

  const groups: number[] = [];
  for (const piece of head) {
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  for (let i = head.length + tail.length; i < 8; i++) groups.push(0);
  for (const piece of tail) {
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  return groups.length === 8 ? groups : null;
}

/**
 * The IPv4 address an IPv6 address carries, when it carries one.
 *
 * Every transition mechanism embeds a v4 address somewhere, and every one of
 * them is a way to reach a v4 destination while wearing a v6 spelling that no
 * v4 range check looks at. The NAT64 well-known prefix is the sharpest: a
 * DNS64 resolver answers an IPv4-only name with `64:ff9b::<the v4>`, so
 * `64:ff9b::a9fe:a9fe` IS the metadata service on any network that runs one.
 */
function embeddedIpv4(g: ReadonlyArray<number>): string | null {
  const quad = (hi: number, lo: number): string =>
    `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  const last = quad(g[6] as number, g[7] as number);

  if (zeros(0, 5) && g[5] === 0xffff) return last; // ::ffff:0:0/96, IPv4-mapped
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return last; // ::ffff:0:0:0/96, translated
  if (g[0] === 0x64 && g[1] === 0xff9b) return last; // 64:ff9b::/96 and 64:ff9b:1::/48, NAT64
  if (g[0] === 0x2002) return quad(g[1] as number, g[2] as number); // 2002::/16, 6to4
  // ::a.b.c.d, IPv4-compatible: deprecated, still routed by some stacks, and
  // not to be confused with `::` or `::1`, which are handled before this.
  if (zeros(0, 6)) return last;
  return null;
}

/** Ranges that are never a public RPC endpoint. */
export function isPrivateIp(address: string): boolean {
  const v4 = normalizeIpv4(address);
  if (v4 !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.split(".").map((n) => Number.parseInt(n, 10));
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, and the metadata service
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast, reserved, broadcast
    return a === 255 && b === 255 && c === 255 && d === 255;
  }

  const groups = parseIpv6(address);
  if (groups === null) return false;
  if (groups.every((g) => g === 0)) return true; // ::, the unspecified address
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1

  const carried = embeddedIpv4(groups);
  if (carried !== null) return isPrivateIp(carried);

  const head = groups[0] as number;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7, unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  return (head & 0xff00) === 0xff00; // ff00::/8, multicast
}
// END SYNCHRONISED BLOCK

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
  // A `Fetch(https://api.x/**)` rule is about the URL, matched as parsed.
  operativeArgs: [{ field: "url", kind: "url" }],
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
