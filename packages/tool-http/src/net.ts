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
  // The ANSWER gets the same fail-closed reading as the literal above. The
  // classifier answers "not private" for a string it cannot parse, which is
  // the right answer for a predicate and the wrong one for a gate: an address
  // nothing could classify must not become the pinned target.
  if (resolved.address.includes(":") && expandIpv6(resolved.address) === null) {
    throw new HttpPermissionError(
      `SSRF: host "${hostname}" resolves to "${resolved.address}", which is not a valid IPv6 address`,
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

/**
 * The name this package has always exported for `parseIpv6`, kept so callers
 * and tests keep working, and because they expect a mutable array back.
 *
 * It lives OUTSIDE the synchronised block on purpose: the block's own text is
 * byte-identical everywhere, and per-package naming is adapted around it.
 */
export function expandIpv6(raw: string): number[] | null {
  const groups = parseIpv6(raw);
  return groups === null ? null : [...groups];
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
