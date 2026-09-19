/**
 * The network posture for `@crewhaus/tool-codehost`.
 *
 * Every outbound byte this package sends leaves through this module. The
 * defences are the ones `@crewhaus/tool-http` and `@crewhaus/tool-fetch`
 * established, carried over rather than re-derived, because a third HTTP
 * surface with a weaker gate is the same hole a third time:
 *
 *   1. Empty allow-list ⇒ deny all. There is no "allow everything" value, and
 *      no default origin is implicitly trusted — `https://api.github.com` has
 *      to be allow-listed like anything else.
 *   2. Scheme must be http or https.
 *   3. Origin (scheme + lowercase host + non-default port) must match an
 *      allow-list entry exactly, after canonicalisation. A self-hosted
 *      GitHub Enterprise or GitLab instance is reached by allow-listing it,
 *      never by relaxing the rule.
 *   4. SSRF: loopback, link-local (including the cloud metadata address),
 *      RFC1918, CGNAT, multicast and reserved targets are refused even when
 *      the host is allow-listed — as an IP literal in any of its encodings
 *      and as the DNS-resolved address. Classification is numeric, never a
 *      string prefix.
 *   5. The vetted IP is pinned for the connection, so a rebinding resolver
 *      cannot swap in a private address between the check and the socket.
 *   6. Redirects are followed manually, capped, and re-checked at every hop
 *      against 3 + 4 + 5. This matters here more than usual: a GitHub Actions
 *      log URL answers with a 302 to a storage origin, and that origin gets
 *      no free pass.
 *   7. The API token is dropped the moment a redirect leaves the origin it
 *      was minted for, and is redacted out of every string this package
 *      returns — result, error and all.
 *   8. Every request is deadline-bounded — including the DNS lookup, which
 *      `node:dns` will otherwise run without a timeout or a signal and hold
 *      open past the deadline that is supposed to bound it — and every body
 *      is byte-capped while it is being READ, so a hostile or merely enormous
 *      response cannot pin memory.
 *
 * The token itself only ever arrives as the NAME of an environment variable.
 * A token a model can put in a tool argument is a token in the transcript,
 * the trace and the eval report.
 */
import { Buffer } from "node:buffer";
import { lookup as dnsLookup } from "node:dns/promises";
import { CrewhausError } from "@crewhaus/errors";

/** Refusal by the allow-list, the SSRF gate, a redirect rule or a credential rule. */
export class CodehostPermissionError extends CrewhausError {
  override readonly name = "CodehostPermissionError";
  constructor(message: string) {
    super("tool", message);
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

/** Compact JSON — every byte returned is a byte in somebody's context window. */
export const json = (value: unknown): string => JSON.stringify(value);

/** Locale-independent string order. `localeCompare` without a locale is not deterministic. */
export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The two hosts this package speaks to. */
export type HostKind = "github" | "gitlab";

/** Where each host's API lives when the caller names no base URL. */
export const DEFAULT_BASE_URL: Record<HostKind, string> = {
  github: "https://api.github.com",
  gitlab: "https://gitlab.com/api/v4",
};

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export type CodehostConfig = {
  /** Canonical origins. Empty (the default) denies every request. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** Base URL for calls that do not name one. */
  readonly baseUrl?: string;
  /** NAME of the environment variable holding the token, never the token. */
  readonly tokenEnv?: string;
  /** Default host kind for calls that do not name one. */
  readonly host?: HostKind;
};

export type CodehostConfigInput = {
  readonly allowed_origins?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly base_url?: string;
  readonly baseUrl?: string;
  readonly token_env?: string;
  readonly tokenEnv?: string;
  readonly host?: string;
};

const EMPTY_CONFIG: CodehostConfig = { allowedOrigins: new Set<string>() };

let codehostConfig: CodehostConfig = EMPTY_CONFIG;

/** Build a config from a spec-shaped block. Pure; both key spellings accepted. */
export function buildCodehostConfig(input: CodehostConfigInput): CodehostConfig {
  const raw = input.allowedOrigins ?? input.allowed_origins ?? [];
  const origins = new Set<string>();
  for (const origin of raw) origins.add(canonicalizeOrigin(origin));
  const baseUrl = input.baseUrl ?? input.base_url;
  const tokenEnv = input.tokenEnv ?? input.token_env;
  const host = input.host === "github" || input.host === "gitlab" ? input.host : undefined;
  return {
    allowedOrigins: origins,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
    ...(host !== undefined ? { host } : {}),
  };
}

/** Replace the process-global config. Codegen calls this at boot. */
export function registerCodehostConfig(input: CodehostConfigInput): void {
  codehostConfig = buildCodehostConfig(input);
}

export function getCodehostConfig(): CodehostConfig {
  return codehostConfig;
}

/**
 * The config ONE call runs under: the serving candidate's
 * `tool_config.codehost` block when it declares one, else the boot
 * registration. A non-object override is ignored rather than widened — the
 * allow-list only ever comes from a spec block.
 */
export function resolveCodehostConfig(override: unknown): CodehostConfig {
  if (typeof override === "object" && override !== null && !Array.isArray(override)) {
    return buildCodehostConfig(override as CodehostConfigInput);
  }
  return codehostConfig;
}

/** Test-only — back to fail-closed empty. */
export function _resetCodehostConfig(): void {
  codehostConfig = EMPTY_CONFIG;
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
    throw new CodehostPermissionError(`invalid origin "${raw}" — must be an absolute URL`);
  }
  return canonicalizeUrlOrigin(url, raw);
}

/** The origin of a URL already parsed, without putting the whole URL in a message. */
export function canonicalizeUrlOrigin(url: URL, label = originLabel(url)): string {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CodehostPermissionError(
      `invalid origin "${label}" — only http/https schemes are supported`,
    );
  }
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (host === "") {
    throw new CodehostPermissionError(`invalid origin "${label}" — host is required`);
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

/** Scheme + host + port only, safe to print. */
function originLabel(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/**
 * How a URL may appear in a message: scheme, host, port and path, with the
 * query string and fragment dropped. A signed log URL keeps its signature in
 * the query, and an error message is not the place to reprint it.
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

/** Refuse a URL that carries `user:pass@` — userinfo is a credential in a URL. */
export function assertNoUserinfo(url: URL): void {
  if (url.username !== "" || url.password !== "") {
    throw new CodehostPermissionError(
      `denied: the URL for "${originLabel(url)}" carries userinfo (user:password@host) — name an environment variable with tokenEnv instead of putting a secret in the URL`,
    );
  }
}

/** Refuse a URL whose origin is not allow-listed. Empty list ⇒ refuse everything. */
export function assertOriginAllowed(url: URL, cfg: CodehostConfig): void {
  if (cfg.allowedOrigins.size === 0) {
    throw new CodehostPermissionError(
      `denied: origin "${originLabel(url)}" is not in allowed_origins (empty allow-list = deny all)`,
    );
  }
  const canonical = canonicalizeUrlOrigin(url);
  if (!cfg.allowedOrigins.has(canonical)) {
    throw new CodehostPermissionError(
      `denied: origin "${canonical}" is not in allowed_origins — add it to the codehost tool_config block to reach it`,
    );
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

/** Test-only resolver injection, as in `@crewhaus/tool-http`. */
export function _setDnsLookup(fn: DnsLookupFn | undefined): void {
  dnsLookupFn = fn ?? defaultDnsLookup;
}

/**
 * The hard ceiling on one name resolution, used when no call deadline is
 * supplied. `node:dns` takes neither a timeout nor an `AbortSignal`, so a
 * wedged or hostile resolver would otherwise hold a tool call open forever —
 * the one place a request could outlive the deadline that is supposed to
 * bound it.
 */
export const DNS_TIMEOUT_MS = 10_000;

/**
 * Resolve a name under a bound.
 *
 * The bound is whichever comes first: the call's own deadline (through its
 * `AbortSignal`) or `capMs`. Losing the race is a REFUSAL rather than a
 * fall-through, because "I could not check this host in time" must never be
 * read as "this host is fine".
 */
async function lookupBounded(
  host: string,
  signal: AbortSignal | undefined,
  capMs: number,
): Promise<{ readonly address: string; readonly family: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      dnsLookupFn(host),
      new Promise<never>((_resolve, reject) => {
        const cutShort = (): void => {
          reject(
            new CodehostPermissionError(
              `SSRF: the deadline elapsed while resolving "${host}" — nothing was dialled`,
            ),
          );
        };
        timer = setTimeout(() => {
          reject(
            new CodehostPermissionError(
              `SSRF: the DNS lookup for "${host}" did not answer within ${capMs}ms`,
            ),
          );
        }, capMs);
        if (signal === undefined) return;
        if (signal.aborted) {
          cutShort();
          return;
        }
        onAbort = cutShort;
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * TEST-ONLY escape hatch for the private-address gate.
 *
 * The tests drive the tools at a real `Bun.serve` on 127.0.0.1, because a
 * stubbed `fetch` would prove nothing about whether a redirect really drops
 * the token, a deadline really fires or a byte cap really cancels a stream.
 * Reaching a real local server means lifting the loopback refusal, and this
 * is the only thing that lifts it: no `tool_config` key sets it, nothing in
 * the catalog calls it, and it is `false` on every process start.
 *
 * It lifts LOOPBACK ONLY, so a stray flip cannot open 169.254.169.254 or the
 * machine's LAN.
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
  return normalizeIpv4(bare)?.startsWith("127.") === true;
}

/**
 * Reject a host that is — or resolves to — loopback, link-local, RFC1918,
 * CGNAT or mDNS. Returns the vetted IP so the caller can pin the socket to it
 * instead of letting the stack re-resolve at connect time.
 *
 * `signal` is the call's deadline: a name that needs resolving is looked up
 * under it, so a resolver that never answers cannot outlive the deadline it
 * is supposed to run inside.
 */
export async function assertNotSsrf(
  hostname: string,
  signal?: AbortSignal,
  capMs: number = DNS_TIMEOUT_MS,
): Promise<string> {
  const lower = hostname.toLowerCase();
  const unbracketed = lower.replace(/^\[/, "").replace(/\]$/, "");

  const refused = (ip: string): boolean =>
    isPrivateIp(ip) && !(privateHostsAllowedForTest && isLoopback(ip));

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    if (!privateHostsAllowedForTest) {
      throw new CodehostPermissionError(`SSRF: host "${hostname}" resolves to loopback`);
    }
  } else if (lower.endsWith(".local")) {
    throw new CodehostPermissionError(`SSRF: mDNS host "${hostname}" is not allowed`);
  } else if (refused(unbracketed)) {
    throw new CodehostPermissionError(`SSRF: host "${hostname}" is a private/loopback IP`);
  }

  const expanded = unbracketed.includes(":") ? expandIpv6(unbracketed) : null;
  const literal =
    normalizeIpv4(unbracketed) ??
    (expanded === null ? null : expanded.map((g) => g.toString(16)).join(":"));
  if (literal !== null) return literal;
  if (unbracketed.includes(":")) {
    throw new CodehostPermissionError(`SSRF: host "${hostname}" is not a valid IPv6 address`);
  }

  let resolved: { readonly address: string; readonly family: number };
  try {
    resolved = await lookupBounded(lower, signal, Math.max(1, capMs));
  } catch (err) {
    if (err instanceof CodehostPermissionError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new CodehostPermissionError(`SSRF: cannot resolve "${hostname}": ${msg}`);
  }
  if (refused(resolved.address)) {
    throw new CodehostPermissionError(
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

/**
 * Back-compat alias for {@link parseIpv6}: this package's `isLoopback` and its
 * tests were written against the older name and a mutable array. It is a thin
 * wrapper OUTSIDE the synchronised block on purpose — the block's bytes are
 * hashed and must stay identical to every other copy.
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
 * A deadline that also honours the runtime's own cancellation. Every tool in
 * this package opens one before its first byte and cancels it in a `finally`
 * — a tool that can hang forever is a defect, and one that paginates can hang
 * in more ways than one.
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

// ---------------------------------------------------------------------------
// the token
// ---------------------------------------------------------------------------

/** The header each host reads the token from. */
const TOKEN_HEADER: Record<HostKind, string> = {
  github: "Authorization",
  gitlab: "PRIVATE-TOKEN",
};

/** Lowercased names that must never survive a cross-origin hop or be echoed. */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "private-token",
  "job-token",
]);

export type ResolvedToken =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly message: string };

/**
 * The shape of an environment variable name, and the shapes a host token
 * takes.
 *
 * Both hosts mint tokens out of letters, digits and underscores, so
 * a pasted `ghp_…` token is a perfectly legal variable
 * NAME as far as a character class is concerned. The prefixes are therefore
 * checked as well, because the field most likely to receive a pasted secret
 * is the one whose name ends in `Env`.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_NAME_LENGTH = 64;
const TOKEN_PREFIXES: readonly string[] = [
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "glptt-",
  "gldt-",
  "bearer ",
];

/** True when a value that arrived as a NAME is really a secret. */
function looksLikeAToken(value: string): boolean {
  const lower = value.toLowerCase();
  return TOKEN_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Read the token out of the named environment variable.
 *
 * The NAME is what travels through the tool call; the value never does. Two
 * rules keep it that way, and neither of them ever prints the value it
 * refused:
 *
 *   - A value that is not shaped like an environment variable name, or that
 *     carries a known host-token prefix, is refused as a pasted secret. The
 *     refusal says what to pass instead and quotes nothing, because a tool
 *     result is a transcript, a trace and usually an eval report.
 *   - A name that IS a name may be quoted back, since "GITHUB_TOKEN is unset"
 *     is the whole point of the message and a variable name is not a secret.
 */
export function resolveToken(
  envVar: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedToken {
  if (envVar === undefined || envVar === "") {
    return {
      ok: false,
      message:
        "no token: set tokenEnv (or token_env in the codehost tool_config block) to the NAME of an environment variable holding the API token — the token itself is never accepted as an argument",
    };
  }
  if (!ENV_NAME.test(envVar) || envVar.length > MAX_ENV_NAME_LENGTH || looksLikeAToken(envVar)) {
    return {
      ok: false,
      // Deliberately no quoting of `envVar`: if this fired because a secret
      // was pasted in, echoing it back is the leak this whole path exists to
      // prevent.
      message:
        "tokenEnv must be the NAME of an environment variable (letters, digits and underscores, e.g. GITHUB_TOKEN), not a token. The value given is not a usable name and has not been echoed back; if it was the token itself, treat it as exposed to whoever wrote it and set the variable instead",
    };
  }
  const value = env[envVar];
  if (value === undefined || value === "") {
    return {
      ok: false,
      message: `tokenEnv names environment variable "${envVar}", which is unset or empty in this process`,
    };
  }
  return { ok: true, token: value };
}

/**
 * A function that scrubs a secret out of anything on its way back to the
 * caller.
 *
 * Everything this package returns — results, refusals, the text of an API
 * error — goes through one of these. It is the backstop rather than the
 * primary defence: the token is only ever placed in a request header, never
 * in a path, a query string or a body. But an API that echoes a header, a
 * transport error that quotes a request, or a future tool that forgets, would
 * each put the token in a transcript, and that is not a mistake worth leaving
 * one layer deep.
 *
 * Secrets shorter than six characters are left alone: replacing every "x" in
 * a result would mangle it without protecting anything real, and no usable
 * host token is that short.
 */
export function redactorFor(secret: string | undefined): (text: string) => string {
  if (secret === undefined || secret.length < 6) return (text) => text;
  const encodedForms = new Set<string>([secret, encodeURIComponent(secret)]);
  try {
    encodedForms.add(Buffer.from(secret, "utf8").toString("base64"));
  } catch {
    // not encodable — the literal form is still covered
  }
  return (text: string): string => {
    let out = text;
    for (const form of [...encodedForms].sort((a, b) => b.length - a.length)) {
      if (form.length < 6) continue;
      out = out.split(form).join("<redacted>");
    }
    return out;
  };
}

/** The auth header for a host, ready to merge into a request. */
export function authHeaders(host: HostKind, token: string): Record<string, string> {
  if (host === "github") return { Authorization: `Bearer ${token}` };
  return { [TOKEN_HEADER.gitlab]: token };
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

export type OpenOptions = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | undefined;
  readonly signal: AbortSignal;
  readonly cfg: CodehostConfig;
  readonly maxRedirects?: number;
};

export type OpenResult = {
  readonly res: Response;
  readonly finalUrl: string;
  /** Every `Location` followed, in order, with query strings stripped. */
  readonly redirects: readonly string[];
  /** True when a cross-origin hop dropped the token. */
  readonly credentialsDropped: boolean;
};

/**
 * Issue a request, following redirects by hand so the allow-list, the SSRF
 * gate and the credential rule run on every hop.
 *
 * The body is left unread — the caller decides how to drain it under which
 * cap. A GitHub Actions log URL is the case that motivates all of this: it
 * answers 302 to a storage origin with its own signed query string, so the
 * token must be dropped at the hop and the new origin must be allow-listed on
 * its own merits.
 */
export async function openRequest(o: OpenOptions): Promise<OpenResult> {
  const limit = o.maxRedirects ?? MAX_REDIRECTS;
  const headers: Record<string, string> = { ...o.headers };
  const redirects: string[] = [];
  let credentialsDropped = false;
  let current = o.url;
  let currentOrigin = canonicalizeOriginOf(o.url);
  let method = o.method;
  let body = o.body;

  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new CodehostPermissionError(
        `denied: scheme "${current.protocol}" — only http/https are allowed`,
      );
    }
    assertNoUserinfo(current);
    assertOriginAllowed(current, o.cfg);
    // The call's own signal bounds the lookup; DNS_TIMEOUT_MS is the backstop
    // for a caller that opened no deadline at all.
    const pinnedIp = await assertNotSsrf(current.hostname, o.signal);

    const init: RequestInit = {
      method,
      redirect: "manual",
      signal: o.signal,
      headers,
      ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
    };
    const res = await rawFetch(new Request(current.toString(), init), pinnedIp);

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) {
      return { res, finalUrl: current.toString(), redirects, credentialsDropped };
    }
    if (hop >= limit) {
      await discard(res);
      throw new CodehostPermissionError(`too many redirects (>${limit})`);
    }

    const location = res.headers.get("location") ?? "";
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      await discard(res);
      throw new CodehostPermissionError(`invalid redirect target "${safeUrlLabel(location)}"`);
    }
    const nextOrigin = canonicalizeOriginOf(next);
    if (nextOrigin !== currentOrigin) {
      // The token was minted for the origin we asked, not for wherever it
      // points us next.
      for (const name of Object.keys(headers)) {
        if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
          delete headers[name];
          credentialsDropped = true;
        }
      }
    }
    // RFC 9110 §15.4.3/§15.4.4: a 303 always becomes a GET, and 301/302 after
    // a non-GET has meant GET in every deployed client for decades. Replaying
    // a POST body at a hop the caller never asked for would create the same
    // issue or comment twice.
    if (
      (res.status === 303 || res.status === 301 || res.status === 302) &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      method = "GET";
      body = undefined;
      for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (lower === "content-type" || lower === "content-length") delete headers[name];
      }
    }
    await discard(res);
    redirects.push(safeUrlLabel(next));
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
 * Drain a body with a hard byte cap, cancelling the stream the moment the cap
 * is passed. The cap bounds MEMORY, not just what is returned: chunks past it
 * are never retained and the reader is cancelled rather than drained.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<CappedBody> {
  if (res.body === null) return { text: "", bytes: 0, truncated: false };
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
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(merged),
    bytes: total,
    truncated,
  };
}

/**
 * Turn anything thrown on the network path into the one-line string a tool
 * returns. A refusal, a deadline and a transport failure read differently,
 * because the caller's next move differs.
 */
export function describeFailure(err: unknown, deadline?: Deadline): string {
  if (err instanceof CodehostPermissionError) return err.message;
  if (deadline?.expired() === true) return "deadline elapsed before the request completed";
  if (err instanceof Error) {
    if (err.name === "AbortError") return "the request was aborted before it completed";
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
