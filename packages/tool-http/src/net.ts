/**
 * The network posture for `@crewhaus/tool-http`.
 *
 * Every outbound byte this package sends leaves through this module, and the
 * defences are the ones `@crewhaus/tool-fetch` established — carried over
 * whole, not re-derived, because a second HTTP surface with a weaker gate is
 * the same hole twice:
 *
 *   1. Empty allow-list ⇒ deny all. There is no "allow everything" value.
 *   2. Scheme must be http or https.
 *   3. Origin (scheme + lowercase host + non-default port) must match an
 *      allow-list entry exactly, after canonicalisation.
 *   4. SSRF: loopback, link-local (incl. the cloud metadata address),
 *      RFC1918, CGNAT, multicast, reserved and mDNS targets are refused even
 *      when the host is allow-listed — as an IP literal in any of its
 *      encodings, and as the DNS-resolved address. Classification is
 *      numeric, never a string prefix, and the ranges that carry an IPv4
 *      address (IPv4-mapped, NAT64, 6to4) are judged by the address they
 *      carry.
 *   5. The vetted IP is pinned for the actual connection, so a rebinding
 *      resolver cannot swap in a private address between the check and the
 *      socket (CWE-367).
 *   6. Redirects are followed manually, capped, and re-checked at every hop
 *      against 3 + 4 + 5.
 *   7. Credentials — `Authorization`, `Proxy-Authorization`, `Cookie`, AND
 *      whatever header the call's `auth` profile set — are dropped the moment
 *      a redirect leaves the origin they were minted for, and are redacted
 *      out of every echoed header map.
 *   7b. A URL carrying `user:pass@` is refused outright, at the first hop and
 *      at every redirect: userinfo is a credential that would otherwise ride
 *      in `finalUrl` and `redirects` straight back into a transcript.
 *   8. Every request is deadline-bounded and every body is byte-capped.
 *   9. `Cookie`, `Set-Cookie` and `Authorization` are stripped from response
 *      headers before anything is handed back to a model.
 *
 * What it does NOT do, so nobody assumes otherwise: it does not proxy, it
 * does not validate certificates any differently from the runtime's `fetch`
 * (`TlsInspect` is the tool for looking at a chain), and it keeps no cookie
 * jar — a session cookie must be passed explicitly on each call.
 */
import { Buffer } from "node:buffer";
import { lookup as dnsLookup } from "node:dns/promises";
import { CrewhausError } from "@crewhaus/errors";

/** Refusal by the allow-list, the SSRF gate, or a redirect rule. */
export class HttpPermissionError extends CrewhausError {
  override readonly name = "HttpPermissionError";
  constructor(message: string) {
    super("tool", message);
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

/** Compact JSON — every byte returned is a byte in somebody's context window. */
export const json = (value: unknown): string => JSON.stringify(value);

/** Locale-independent string order. `localeCompare` without a locale is not deterministic. */
export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export type HttpConfig = {
  /** Canonical origins. Empty (the default) denies every request. */
  readonly allowedOrigins: ReadonlySet<string>;
  /**
   * The hostnames those origins name, for the two tools that address a host
   * rather than a URL (`DnsLookup`, `TlsInspect`). Derived, never configured
   * separately, so there is exactly one list to audit.
   */
  readonly allowedHosts: ReadonlySet<string>;
};

export type HttpConfigInput = {
  readonly allowed_origins?: readonly string[];
  readonly allowedOrigins?: readonly string[];
};

const EMPTY_CONFIG: HttpConfig = {
  allowedOrigins: new Set<string>(),
  allowedHosts: new Set<string>(),
};

let httpConfig: HttpConfig = EMPTY_CONFIG;

/** Build a config from a spec-shaped block. Pure; both key spellings accepted. */
export function buildHttpConfig(input: HttpConfigInput): HttpConfig {
  const raw = input.allowedOrigins ?? input.allowed_origins ?? [];
  const origins = new Set<string>();
  const hosts = new Set<string>();
  for (const origin of raw) {
    const canonical = canonicalizeOrigin(origin);
    origins.add(canonical);
    hosts.add(new URL(canonical).hostname.toLowerCase());
  }
  return { allowedOrigins: origins, allowedHosts: hosts };
}

/** Replace the process-global allow-list. Codegen calls this at boot. */
export function registerHttpConfig(input: HttpConfigInput): void {
  httpConfig = buildHttpConfig(input);
}

export function getHttpConfig(): HttpConfig {
  return httpConfig;
}

/**
 * The config ONE call runs under: the serving candidate's `tool_config.http`
 * block when it declares one, else the boot registration. A non-object
 * override is ignored rather than widened — the allow-list only ever comes
 * from a spec block.
 */
export function resolveHttpConfig(override: unknown): HttpConfig {
  if (typeof override === "object" && override !== null && !Array.isArray(override)) {
    return buildHttpConfig(override as HttpConfigInput);
  }
  return httpConfig;
}

/** Test-only — back to fail-closed empty. */
export function _resetHttpConfig(): void {
  httpConfig = EMPTY_CONFIG;
}

/**
 * Canonicalise an origin for exact-match comparison: lowercase scheme and
 * host, drop path/query/fragment, elide the default port. Throws on a
 * malformed origin so a misconfiguration surfaces at boot, not at the first
 * request.
 */
export function canonicalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpPermissionError(`invalid origin "${raw}" — must be an absolute URL`);
  }
  return canonicalizeUrlOrigin(url, raw);
}

/**
 * The origin of a URL already parsed, without putting the URL back into any
 * message. `label` is what a refusal is allowed to name — never the full URL,
 * because a query string is where a signed link keeps its signature and an
 * error string is a thing that ends up in a transcript.
 */
export function canonicalizeUrlOrigin(url: URL, label = originLabel(url)): string {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpPermissionError(
      `invalid origin "${label}" — only http/https schemes are supported`,
    );
  }
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (host === "") {
    throw new HttpPermissionError(`invalid origin "${label}" — host is required`);
  }
  const portStr = url.port;
  let port = "";
  if (portStr !== "") {
    const isDefault =
      (scheme === "http:" && portStr === "80") || (scheme === "https:" && portStr === "443");
    port = isDefault ? "" : `:${portStr}`;
  }
  return `${scheme}//${host}${port}`;
}

/**
 * How a URL is allowed to appear in a message: scheme, host, port and path,
 * with the query string and fragment dropped. A presigned URL's signature, an
 * `?api_key=` and an OAuth `code` all live in the query, and an error message
 * is not the place to reprint them.
 */
export function safeUrlLabel(raw: string | URL): string {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    return String(raw);
  }
  const query = url.search !== "" || url.hash !== "" ? "?…" : "";
  return `${url.protocol}//${url.host}${url.pathname}${query}`;
}

/** Scheme + host + port only, safe to print. */
function originLabel(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/**
 * Refuse a URL that carries `user:pass@`.
 *
 * Userinfo is a credential the model wrote into a tool argument, which is the
 * exact thing the `auth` profile exists to prevent — and unlike a header it
 * survives into `finalUrl` and every entry of `redirects`, so it would be
 * echoed back into the transcript even on a call that succeeded.
 */
export function assertNoUserinfo(url: URL): void {
  if (url.username !== "" || url.password !== "") {
    throw new HttpPermissionError(
      `denied: the URL for "${originLabel(url)}" carries userinfo (user:password@host) — use the auth profile, which names an environment variable instead of putting the secret in the URL`,
    );
  }
}

/** Refuse a URL whose origin is not allow-listed. Empty list ⇒ refuse everything. */
export function assertOriginAllowed(url: URL, cfg: HttpConfig): void {
  if (cfg.allowedOrigins.size === 0) {
    throw new HttpPermissionError(
      `denied: origin "${url.origin}" is not in allowed_origins (empty allow-list = deny all)`,
    );
  }
  const canonical = canonicalizeUrlOrigin(url);
  if (!cfg.allowedOrigins.has(canonical)) {
    throw new HttpPermissionError(`denied: origin "${canonical}" is not in allowed_origins`);
  }
}

/**
 * Refuse a bare hostname that no allow-listed origin names. Used by the two
 * tools that address a host rather than a URL; the SSRF gate still runs on
 * top, so an allow-listed name pointing at 127.0.0.1 is refused as well.
 */
export function assertHostAllowed(host: string, cfg: HttpConfig): void {
  const lower = host.toLowerCase();
  if (cfg.allowedHosts.size === 0) {
    throw new HttpPermissionError(
      `denied: host "${host}" is not in allowed_origins (empty allow-list = deny all)`,
    );
  }
  if (!cfg.allowedHosts.has(lower)) {
    throw new HttpPermissionError(`denied: host "${host}" is not named by any allowed origin`);
  }
}

// ---------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------

export type DnsLookupFn = (
  host: string,
) => Promise<{ readonly address: string; readonly family: number }>;

const defaultDnsLookup: DnsLookupFn = (host) => dnsLookup(host, { verbatim: false });
let dnsLookupFn: DnsLookupFn = defaultDnsLookup;

/** Test-only resolver injection, as in `@crewhaus/tool-fetch`. */
export function _setDnsLookup(fn: DnsLookupFn | undefined): void {
  dnsLookupFn = fn ?? defaultDnsLookup;
}

/**
 * TEST-ONLY escape hatch for the private-address gate.
 *
 * The tests in this package drive the tools against a real `Bun.serve` on
 * 127.0.0.1, because mocking `fetch` would prove nothing about whether a
 * redirect chain, a deadline or a byte cap actually works. Reaching a real
 * local server means the loopback refusal has to be lifted for the duration
 * of a test, and this is the only thing that lifts it.
 *
 * It is deliberately NOT reachable from a spec: no `tool_config` key sets it,
 * nothing exported to the catalog calls it, and it defaults to `false` on
 * every process start. Production code has no path to a private address.
 *
 * It lifts LOOPBACK ONLY. The tests need 127.0.0.1 and `::1`; they have never
 * needed 169.254.169.254, an RFC1918 address or a `.local` name, so flipping
 * this flag — by a stray import, a leaked reset, whatever — must not open the
 * cloud metadata endpoint or the machine's LAN. Everything outside loopback
 * stays refused with the flag on.
 */
let privateHostsAllowedForTest = false;
export function __setPrivateHostsAllowedForTest(allowed: boolean): void {
  privateHostsAllowedForTest = allowed;
}

/** True for the loopback addresses, and only those. */
function isLoopback(ip: string): boolean {
  const bare = ip.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (bare.includes(":")) {
    const groups = expandIpv6(bare);
    if (groups === null) return false;
    const mapped =
      groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff);
    if (mapped) {
      if (groups[6] === 0 && groups[7] === 1) return true; // ::1
      const hi = groups[6] as number;
      const lo = groups[7] as number;
      return isLoopback([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join("."));
    }
    return false;
  }
  const normalized = normalizeIpv4(bare);
  return normalized?.startsWith("127.") === true;
}

/**
 * Reject a host that is — or resolves to — loopback, link-local, RFC1918,
 * CGNAT, or mDNS. Returns the vetted IP so the caller can pin the socket to
 * it instead of letting the stack re-resolve at connect time.
 */
export async function assertNotSsrf(hostname: string): Promise<string> {
  const lower = hostname.toLowerCase();
  const unbracketed = lower.replace(/^\[/, "").replace(/\]$/, "");

  /** The flag lifts loopback and nothing else — see its declaration. */
  const refused = (ip: string): boolean =>
    isPrivateIp(ip) && !(privateHostsAllowedForTest && isLoopback(ip));

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    if (!privateHostsAllowedForTest) {
      throw new HttpPermissionError(`SSRF: host "${hostname}" resolves to loopback`);
    }
  } else if (lower.endsWith(".local")) {
    throw new HttpPermissionError(`SSRF: mDNS host "${hostname}" is not allowed`);
  } else if (refused(unbracketed)) {
    throw new HttpPermissionError(`SSRF: host "${hostname}" is a private/loopback IP`);
  }

  // An IP literal is its own pinned target — no lookup, nothing to rebind. An
  // IPv6 literal is re-emitted in expanded form so the address that is pinned
  // is the address that was classified, not a spelling of it.
  const expanded = unbracketed.includes(":") ? expandIpv6(unbracketed) : null;
  const literal =
    normalizeIpv4(unbracketed) ??
    (expanded === null ? null : expanded.map((g) => g.toString(16)).join(":"));
  if (literal !== null) return literal;
  if (unbracketed.includes(":")) {
    // Colon means it was meant as an IPv6 literal; one this parser cannot
    // expand is one it could not classify, so it does not get dialled.
    throw new HttpPermissionError(`SSRF: host "${hostname}" is not a valid IPv6 address`);
  }

  let resolved: { readonly address: string; readonly family: number };
  try {
    resolved = await dnsLookupFn(lower);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpPermissionError(`SSRF: cannot resolve "${hostname}": ${msg}`);
  }
  if (refused(resolved.address)) {
    throw new HttpPermissionError(
      `SSRF: host "${hostname}" resolves to private IP ${resolved.address}`,
    );
  }
  return resolved.address;
}

/**
 * Normalise an IPv4 literal to dotted-decimal. Octal (`0177.0.0.1`), hex
 * (`0x7f000001`) and 32-bit integer (`2130706433`) forms all reach
 * 127.0.0.1, so they are canonicalised before classification — otherwise
 * they are an allow-list bypass. `null` when `raw` is not IPv4.
 */
export function normalizeIpv4(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const parseComponent = (s: string): number | null => {
    if (s === "") return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(s)) value = Number.parseInt(s.slice(2), 16);
    else if (/^0[0-7]+$/.test(s)) value = Number.parseInt(s, 8);
    else if (/^[0-9]+$/.test(s)) value = Number.parseInt(s, 10);
    else return null;
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

  const n = components.length;
  const octets = [0, 0, 0, 0];
  for (let i = 0; i < n - 1; i++) {
    const c = components[i] as number;
    if (c > 255) return null;
    octets[i] = c;
  }
  const last = components[n - 1] as number;
  if (last >= 2 ** (8 * (4 - (n - 1)))) return null;
  let rest = last;
  for (let i = 3; i >= n - 1; i--) {
    octets[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return octets.join(".");
}

/**
 * Expand an IPv6 literal into its eight numeric groups, or `null` when `raw`
 * is not IPv6 at all.
 *
 * Classifying IPv6 by string prefix — `ip.startsWith("fe80:")`, `ip === "::1"`
 * — only recognises the ONE spelling a resolver happens to print. `::1`,
 * `0:0:0:0:0:0:0:1`, `::0:1` and `0000:0000:0000:0000:0000:0000:0000:0001`
 * are the same address, and a gate that catches the first and waves the other
 * three through is not a gate. Everything is expanded to numbers first and
 * classified arithmetically, exactly as the IPv4 side is.
 */
export function expandIpv6(raw: string): number[] | null {
  let ip = raw.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // A zone id (`fe80::1%eth0`, or its percent-encoded `%25eth0` form) names a
  // local interface, not part of the address. Drop it before classification so
  // it cannot be used to dress a link-local address up as an unrecognised one.
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip.includes(":")) return null;

  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const side = (text: string): number[] | null => {
    if (text === "") return [];
    const parts = text.split(":");
    const out: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string;
      if (part.includes(".")) {
        // A trailing dotted quad (`::ffff:127.0.0.1`) occupies two groups.
        if (i !== parts.length - 1) return null;
        const dotted = normalizeIpv4(part);
        if (dotted === null) return null;
        const o = dotted.split(".").map((x) => Number.parseInt(x, 10));
        out.push((((o[0] as number) << 8) | (o[1] as number)) & 0xffff);
        out.push((((o[2] as number) << 8) | (o[3] as number)) & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };

  const head = side(halves[0] as string);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = side(halves[1] as string);
  if (tail === null) return null;
  // `::` stands for AT LEAST one group of zeros, so the explicit groups can
  // never fill all eight.
  if (head.length + tail.length > 7) return null;
  const filler = new Array<number>(8 - head.length - tail.length).fill(0);
  return [...head, ...filler, ...tail];
}

/** The dotted quad two IPv6 groups carry, for the embedded-IPv4 ranges. */
function embeddedIpv4(hi: number, lo: number): string {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
}

/** Classify eight expanded IPv6 groups. */
function isPrivateIpv6(g: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const topSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  if (topSixZero && g5 === 0) {
    // ::/128 unspecified, ::1/128 loopback, and the IPv4-compatible ::a.b.c.d
    // block — all of which either are, or embed, an address to refuse.
    if (g6 === 0 && g7 === 0) return true; // ::
    if (g6 === 0 && g7 === 1) return true; // ::1
    return isPrivateIp(embeddedIpv4(g6, g7));
  }
  // ::ffff:0:0/96 — IPv4-mapped.
  if (topSixZero && g5 === 0xffff) return isPrivateIp(embeddedIpv4(g6, g7));
  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64, which translates to IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIp(embeddedIpv4(g6, g7));
  }
  // 2002::/16 — 6to4 carries its IPv4 in the next two groups.
  if (g0 === 0x2002) return isPrivateIp(embeddedIpv4(g1, g2));

  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard-only
  return false;
}

/** True for an address inside a range a harness must never be steered into. */
export function isPrivateIp(addr: string): boolean {
  const ip = addr.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();

  if (ip.includes(":")) {
    const groups = expandIpv6(ip);
    // An IPv6-shaped string this parser cannot expand is REFUSED, not waved
    // through: "I could not classify it" must never be read as "it is public".
    return groups === null ? true : isPrivateIpv6(groups);
  }

  const normalized = normalizeIpv4(ip);
  if (normalized === null) return false;
  const parts = normalized.split(".").map((p) => Number.parseInt(p, 10));
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, and 255.255.255.255
  if (a === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// deadlines
// ---------------------------------------------------------------------------

export type Deadline = {
  readonly signal: AbortSignal;
  /** Milliseconds left; never negative. */
  remaining(): number;
  expired(): boolean;
  /** Clear the timer. Always call it, or the process keeps a handle alive. */
  cancel(): void;
};

/**
 * A deadline that also honours the runtime's own cancellation. Every
 * outbound tool in this package opens one before its first byte and cancels
 * it in a `finally` — a tool that can hang forever is a defect.
 */
export function startDeadline(ms: number, outer?: AbortSignal): Deadline {
  const ctrl = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => ctrl.abort(new Error(`deadline of ${ms}ms elapsed`)), ms);
  const onOuter = () => ctrl.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: ctrl.signal,
    remaining: () => Math.max(0, ms - (Date.now() - startedAt)),
    expired: () => Date.now() - startedAt >= ms,
    cancel: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

/** Resolve after `ms`, or as soon as `signal` aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

/**
 * An auth profile names an ENVIRONMENT VARIABLE, never a literal secret. A
 * model that can put a token in a tool argument is a model that can put it
 * in a transcript, a trace event and an eval report.
 */
export type AuthProfile = {
  readonly type: "bearer" | "basic" | "header";
  readonly envVar: string;
  /** Header name for `type: "header"` (e.g. `X-Api-Key`, `Cookie`). */
  readonly headerName?: string;
  /** Username for `type: "basic"`; the password comes from `envVar`. */
  readonly username?: string;
  /** Literal prefix before the secret for `type: "header"` (e.g. `token `). */
  readonly prefix?: string;
};

/** Header names that must never be supplied inline, and never survive a hop. */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);

/** Response headers stripped before anything reaches a model. */
const STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Refuse caller-supplied credential headers. The `auth` profile is the only
 * way to attach one, which keeps the secret out of the tool arguments and
 * therefore out of the transcript.
 */
export function rejectInlineCredentials(headers: Record<string, string>): string | null {
  for (const name of Object.keys(headers)) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
      return `header "${name}" cannot be set inline — use the auth profile, which names an environment variable instead of carrying the secret in the tool call`;
    }
  }
  return null;
}

/**
 * Apply an auth profile. Returns a readable message when the named variable
 * is unset or the profile is incomplete; the secret itself is never echoed,
 * not even in the error.
 */
export function applyAuth(
  headers: Record<string, string>,
  auth: AuthProfile | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (auth === undefined) return null;
  const secret = env[auth.envVar];
  if (secret === undefined || secret === "") {
    return `auth profile names environment variable "${auth.envVar}", which is unset or empty in this process`;
  }
  if (auth.type === "bearer") {
    headers["Authorization"] = `Bearer ${secret}`;
    return null;
  }
  if (auth.type === "basic") {
    if (auth.username === undefined) {
      return 'auth type "basic" needs a username; the password comes from envVar';
    }
    const encoded = Buffer.from(`${auth.username}:${secret}`, "utf8").toString("base64");
    headers["Authorization"] = `Basic ${encoded}`;
    return null;
  }
  if (auth.headerName === undefined) {
    return 'auth type "header" needs a headerName';
  }
  if (auth.headerName.toLowerCase() === "host") {
    return 'auth type "header" cannot set the Host header';
  }
  headers[auth.headerName] = `${auth.prefix ?? ""}${secret}`;
  return null;
}

/**
 * The header an auth profile will set, lowercased.
 *
 * `bearer` and `basic` land on `Authorization`, which is already a known
 * credential header. `header` lands wherever the profile says — `X-Api-Key`,
 * `X-Auth-Token`, anything — and the value is just as much a secret. Naming
 * it here is what lets `redactHeaders` and the redirect rule treat it as one
 * instead of only recognising the three well-known names.
 */
export function authHeaderName(auth: AuthProfile | undefined): string | undefined {
  if (auth === undefined) return undefined;
  if (auth.type === "bearer" || auth.type === "basic") return "authorization";
  return auth.headerName?.toLowerCase();
}

/**
 * Header map safe to echo back: credential values replaced, never shown.
 *
 * `alsoSecret` carries the lowercased names an auth profile set on this call.
 * Without it a `{ type: "header", headerName: "X-Api-Key" }` profile returns
 * the API key itself in `requestHeaders`, which puts the secret in the
 * transcript — the one thing the profile exists to prevent.
 */
export function redactHeaders(
  headers: Record<string, string>,
  alsoSecret: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers).sort(byString)) {
    const lower = key.toLowerCase();
    out[key] =
      CREDENTIAL_HEADERS.has(lower) || alsoSecret.has(lower)
        ? "<redacted>"
        : (headers[key] as string);
  }
  return out;
}

/** Response headers as a sorted plain object, credentials removed. */
export function responseHeaders(res: Response): Record<string, string> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of res.headers.entries()) {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    pairs.push([key.toLowerCase(), value]);
  }
  pairs.sort((a, b) => byString(a[0], b[0]));
  return Object.fromEntries(pairs);
}

// ---------------------------------------------------------------------------
// the request path
// ---------------------------------------------------------------------------

export type RawFetch = (req: Request, pinnedIp: string) => Promise<Response>;

/**
 * Dial the vetted IP while keeping the real hostname for the `Host` header
 * and TLS SNI, so virtual hosting and certificate validation still work.
 */
function pinnedFetch(req: Request, pinnedIp: string): Promise<Response> {
  const original = new URL(req.url);
  const host = original.hostname;
  const unbracketed = host.replace(/^\[/, "").replace(/\]$/, "");
  if (unbracketed === pinnedIp || pinnedIp === "") return globalThis.fetch(req);

  const pinnedUrl = new URL(original.toString());
  pinnedUrl.hostname = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;

  const headers = new Headers(req.headers);
  headers.set("host", original.port === "" ? host : `${host}:${original.port}`);

  const init: RequestInit & { tls?: { serverName: string }; duplex?: string } = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: req.signal,
    tls: { serverName: host },
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }
  return globalThis.fetch(pinnedUrl.toString(), init);
}

let rawFetch: RawFetch = pinnedFetch;
export function _setRawFetch(fn: RawFetch | undefined): void {
  rawFetch = fn ?? pinnedFetch;
}

export type RedirectPolicy = "follow" | "manual" | "error";

export type OpenOptions = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | undefined;
  readonly signal: AbortSignal;
  readonly cfg: HttpConfig;
  readonly redirect?: RedirectPolicy;
  readonly maxRedirects?: number;
  /**
   * Extra header names (lowercased) to treat as credentials on this call —
   * whatever the `auth` profile set. They are dropped on a cross-origin hop
   * alongside `Authorization`, `Proxy-Authorization` and `Cookie`.
   */
  readonly credentialHeaders?: ReadonlySet<string>;
};

export type OpenResult = {
  readonly res: Response;
  readonly finalUrl: string;
  /** Every `Location` followed, in order. Empty when there was no redirect. */
  readonly redirects: readonly string[];
  /** True when a cross-origin hop dropped the credential headers. */
  readonly credentialsDropped: boolean;
};

/**
 * Issue a request, following redirects by hand so the allow-list, the SSRF
 * gate and the credential rules run on every single hop. The response body
 * is left unread — the caller decides how to drain it under which cap.
 */
export async function openRequest(o: OpenOptions): Promise<OpenResult> {
  const policy = o.redirect ?? "follow";
  const limit = o.maxRedirects ?? MAX_REDIRECTS;
  const headers: Record<string, string> = { ...o.headers };
  const isCredential = (name: string): boolean => {
    const lower = name.toLowerCase();
    return CREDENTIAL_HEADERS.has(lower) || o.credentialHeaders?.has(lower) === true;
  };
  const redirects: string[] = [];
  let credentialsDropped = false;
  let current = o.url;
  let currentOrigin = canonicalizeOriginOf(o.url);
  let method = o.method;
  let body = o.body;

  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new HttpPermissionError(
        `denied: scheme "${current.protocol}" — only http/https are allowed`,
      );
    }
    assertNoUserinfo(current);
    assertOriginAllowed(current, o.cfg);
    const pinnedIp = await assertNotSsrf(current.hostname);

    const init: RequestInit = {
      method,
      redirect: "manual",
      signal: o.signal,
      headers,
      ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
    };
    const res = await rawFetch(new Request(current.toString(), init), pinnedIp);

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect || policy === "manual") {
      return { res, finalUrl: current.toString(), redirects, credentialsDropped };
    }
    if (policy === "error") {
      await discard(res);
      throw new HttpPermissionError(
        `redirect to "${res.headers.get("location") ?? ""}" refused — redirect policy is "error"`,
      );
    }
    if (hop >= limit) {
      await discard(res);
      throw new HttpPermissionError(`too many redirects (>${limit})`);
    }

    const location = res.headers.get("location") ?? "";
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      await discard(res);
      throw new HttpPermissionError(`invalid redirect target "${location}"`);
    }
    const nextOrigin = canonicalizeOriginOf(next);
    if (nextOrigin !== currentOrigin) {
      // The token was minted for the origin we asked, not for wherever it
      // points us next. Drop it before the socket opens — including whatever
      // header the auth profile chose, which is a secret even when it is not
      // called `Authorization`.
      for (const name of Object.keys(headers)) {
        if (isCredential(name)) {
          delete headers[name];
          credentialsDropped = true;
        }
      }
    }
    // RFC 9110 §15.4.4 and §15.4.3: a 303 always becomes a GET, and 301/302
    // after a non-GET have meant GET in every deployed client since Netscape.
    // Replaying a POST body at each hop is not what a server asking for a
    // redirect means, and it re-sends the request payload to an origin that
    // did not receive it the first time.
    if (
      (res.status === 303 || res.status === 301 || res.status === 302) &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      method = "GET";
      body = undefined;
      // Whatever casing the caller wrote: there is no body to describe now.
      for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (lower === "content-type" || lower === "content-length") delete headers[name];
      }
    }
    await discard(res);
    redirects.push(next.toString());
    current = next;
    currentOrigin = nextOrigin;
  }
}

function canonicalizeOriginOf(url: URL): string {
  try {
    return canonicalizeOrigin(url.toString());
  } catch {
    return url.origin;
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
  /** True when the cap cut the read short; `text` is the prefix that fit. */
  readonly truncated: boolean;
};

/**
 * Drain a body with a hard byte cap, cancelling the stream the moment the
 * cap is passed so a hostile server cannot pin memory.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<CappedBody> {
  const raw = await readBytesCapped(res, maxBytes);
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(raw.bytes),
    bytes: raw.bytes.byteLength,
    truncated: raw.truncated,
  };
}

export async function readBytesCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (res.body === null) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
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
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: merged, truncated };
}

/** A URL the caller supplied, or a readable refusal. */
export function parseUrl(raw: string): URL | string {
  try {
    return new URL(raw);
  } catch {
    return `"${raw}" is not an absolute URL — include the scheme, e.g. https://api.example.com/v1/items`;
  }
}

/**
 * Turn anything thrown on the network path into the one-line string a tool
 * returns. A refusal, a deadline and a transport failure read differently,
 * because the caller's next move differs.
 */
export function describeFailure(err: unknown, deadline?: Deadline): string {
  if (err instanceof HttpPermissionError) return err.message;
  if (deadline?.expired() === true) return "deadline elapsed before the request completed";
  if (err instanceof Error) {
    if (err.name === "AbortError") return "the request was aborted before it completed";
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
