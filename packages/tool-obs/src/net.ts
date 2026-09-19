/**
 * The network posture for `@crewhaus/tool-obs`.
 *
 * Only the REMOTE half of this package comes through here — `MetricsQuery`,
 * `LogsQuery`, `AlertList`, `AlertAck`, `StatusPagePost` and `HealthProbe`.
 * The local half never opens a socket at all.
 *
 * The gate is `@crewhaus/tool-http`'s gate, carried over rather than
 * re-derived, because a second HTTP surface with a weaker gate is the same
 * hole twice:
 *
 *   1. Empty allow-list ⇒ deny all. There is no "allow everything" value.
 *   2. Scheme must be http or https.
 *   3. Origin (scheme + lowercase host + non-default port) must match an
 *      allow-list entry exactly, after canonicalisation.
 *   4. SSRF: loopback, link-local (including the cloud metadata address),
 *      RFC1918, CGNAT, multicast, reserved and mDNS targets are refused even
 *      when the host is allow-listed — as an IP literal in any of its
 *      encodings, and as the DNS-resolved address. Classification is numeric,
 *      never a string prefix, and the ranges that carry an IPv4 address
 *      (IPv4-mapped, NAT64, 6to4) are judged by the address they carry.
 *   5. The vetted IP is pinned for the actual connection, so a rebinding
 *      resolver cannot swap in a private address between the check and the
 *      socket (CWE-367).
 *   6. Redirects are followed by hand, capped, and re-checked at every hop
 *      against 3 + 4 + 5.
 *   7. The credential — whichever header the configured auth profile set,
 *      plus `Authorization`, `Proxy-Authorization` and `Cookie` — is dropped
 *      the moment a redirect leaves the origin it was minted for, and is
 *      scrubbed out of every string on the way back.
 *   7b. A URL carrying `user:pass@` is refused outright, at the first hop and
 *      at every redirect: userinfo would otherwise ride in `finalUrl` and in
 *      every redirect entry straight into a transcript.
 *   7c. The credential is scoped to the CONFIGURED surfaces, not to the
 *      allow-list. The allow-list says what may be reached — a fleet
 *      allow-lists everything it wants probed — and sending the token to all
 *      of it would hand the credential to whoever runs those services.
 *   8. Every request is deadline-bounded and every body is byte-capped, with
 *      the cap bounding memory rather than being applied after buffering. The
 *      DNS step is bounded too: `dns.lookup` takes no signal, so the resolver's
 *      own timeout would otherwise outlive the deadline that was declared.
 *
 * The token is named, never pasted: `tokenEnv` is the NAME of an environment
 * variable. A token a model can put in a tool argument is a token in the
 * transcript, the trace and the eval report.
 *
 * What this does NOT do, so nobody assumes otherwise: it does not proxy, it
 * validates certificates exactly as the runtime's `fetch` does, and it keeps
 * no cookie jar.
 */
import { Buffer } from "node:buffer";
import { lookup as dnsLookup } from "node:dns/promises";
import { CrewhausError } from "@crewhaus/errors";

/** Refusal by the allow-list, the SSRF gate, a redirect rule or the config. */
export class ObsPermissionError extends CrewhausError {
  override readonly name = "ObsPermissionError";
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

/**
 * One configured remote surface: where it lives and which paths on it answer.
 *
 * Every field is a SPEC fact, not a model argument. The point of putting the
 * vendor's shape here is that no tool in this package hard-codes Prometheus,
 * Loki, Alertmanager or any status page — a deployment describes its own
 * platform once, in the spec, and the tools stay generic.
 */
export type EndpointConfig = {
  /** Absolute origin + optional path prefix, e.g. `https://prom.example.com`. */
  readonly baseUrl: string;
  /** Path template appended to `baseUrl`; `{id}` is substituted where noted. */
  readonly path?: string;
  /** HTTP method for a write surface. */
  readonly method?: string;
  /** Dot path to the payload inside the response body, e.g. `data.result`. */
  readonly resultPath?: string;
  /** Request parameter names, for surfaces whose query grammar differs. */
  readonly params?: Readonly<Record<string, string>>;
};

export type ObsConfig = {
  /** Canonical origins. Empty (the default) denies every request. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** NAME of the environment variable holding the API token, never the token. */
  readonly tokenEnv?: string;
  /** Header the token is sent in. Defaults to `Authorization`. */
  readonly authHeader?: string;
  /** Literal prefix before the token, e.g. `Bearer `. Defaults to `Bearer `. */
  readonly authPrefix?: string;
  readonly metrics?: EndpointConfig;
  readonly logs?: EndpointConfig;
  readonly alerts?: EndpointConfig;
  /** Where `AlertAck` sends its acknowledgement; `{id}` in `path` is the alert. */
  readonly alertAck?: EndpointConfig;
  readonly statusPage?: EndpointConfig;
};

type RawEndpoint = {
  readonly base_url?: unknown;
  readonly baseUrl?: unknown;
  readonly path?: unknown;
  readonly method?: unknown;
  readonly result_path?: unknown;
  readonly resultPath?: unknown;
  readonly params?: unknown;
};

export type ObsConfigInput = {
  readonly allowed_origins?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly token_env?: string;
  readonly tokenEnv?: string;
  readonly auth_header?: string;
  readonly authHeader?: string;
  readonly auth_prefix?: string;
  readonly authPrefix?: string;
  readonly metrics?: RawEndpoint;
  readonly logs?: RawEndpoint;
  readonly alerts?: RawEndpoint;
  readonly alert_ack?: RawEndpoint;
  readonly alertAck?: RawEndpoint;
  readonly status_page?: RawEndpoint;
  readonly statusPage?: RawEndpoint;
};

const EMPTY_CONFIG: ObsConfig = { allowedOrigins: new Set<string>() };

let obsConfig: ObsConfig = EMPTY_CONFIG;

function asStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A params map with only string values, keys sorted so it serialises stably. */
function paramsOf(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort(byString)) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw === "string") out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function endpointOf(raw: RawEndpoint | undefined): EndpointConfig | undefined {
  if (raw === undefined) return undefined;
  const baseUrl = asStr(raw.baseUrl) ?? asStr(raw.base_url);
  if (baseUrl === undefined) return undefined;
  const path = asStr(raw.path);
  const method = asStr(raw.method);
  const resultPath = asStr(raw.resultPath) ?? asStr(raw.result_path);
  const params = paramsOf(raw.params);
  return {
    baseUrl,
    ...(path !== undefined ? { path } : {}),
    ...(method !== undefined ? { method: method.toUpperCase() } : {}),
    ...(resultPath !== undefined ? { resultPath } : {}),
    ...(params !== undefined ? { params } : {}),
  };
}

/** Build a config from a spec-shaped block. Pure; both key spellings accepted. */
export function buildObsConfig(input: ObsConfigInput): ObsConfig {
  const raw = input.allowedOrigins ?? input.allowed_origins ?? [];
  const origins = new Set<string>();
  for (const origin of raw) origins.add(canonicalizeOrigin(origin));
  const tokenEnv = input.tokenEnv ?? input.token_env;
  const authHeader = input.authHeader ?? input.auth_header;
  const authPrefix = input.authPrefix ?? input.auth_prefix;
  const metrics = endpointOf(input.metrics);
  const logs = endpointOf(input.logs);
  const alerts = endpointOf(input.alerts);
  const alertAck = endpointOf(input.alertAck ?? input.alert_ack);
  const statusPage = endpointOf(input.statusPage ?? input.status_page);
  return {
    allowedOrigins: origins,
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
    ...(authHeader !== undefined ? { authHeader } : {}),
    ...(authPrefix !== undefined ? { authPrefix } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(logs !== undefined ? { logs } : {}),
    ...(alerts !== undefined ? { alerts } : {}),
    ...(alertAck !== undefined ? { alertAck } : {}),
    ...(statusPage !== undefined ? { statusPage } : {}),
  };
}

/** Replace the process-global config. Codegen calls this at boot. */
export function registerObsConfig(input: ObsConfigInput): void {
  obsConfig = buildObsConfig(input);
}

export function getObsConfig(): ObsConfig {
  return obsConfig;
}

/**
 * The config ONE call runs under: the serving candidate's `tool_config.obs`
 * block when it declares one, else the boot registration. A non-object
 * override is ignored rather than widened — the allow-list only ever comes
 * from a spec block.
 */
export function resolveObsConfig(override: unknown): ObsConfig {
  if (typeof override === "object" && override !== null && !Array.isArray(override)) {
    return buildObsConfig(override as ObsConfigInput);
  }
  return obsConfig;
}

/** Test-only — back to fail-closed empty. */
export function _resetObsConfig(): void {
  obsConfig = EMPTY_CONFIG;
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
    throw new ObsPermissionError(`invalid origin "${raw}" — must be an absolute URL`);
  }
  return canonicalizeUrlOrigin(url, raw);
}

/** The origin of a URL already parsed, without putting the whole URL in a message. */
export function canonicalizeUrlOrigin(url: URL, label = originLabel(url)): string {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ObsPermissionError(
      `invalid origin "${label}" — only http/https schemes are supported`,
    );
  }
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (host === "") {
    throw new ObsPermissionError(`invalid origin "${label}" — host is required`);
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
 * query string and fragment dropped. A PromQL query carries a customer's
 * label values and a log query carries their search terms; both live in the
 * query string, and an error message is not the place to reprint them.
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
    throw new ObsPermissionError(
      `denied: the URL for "${originLabel(url)}" carries userinfo (user:password@host) — name an environment variable with tokenEnv instead of putting a secret in the URL`,
    );
  }
}

/** Refuse a URL whose origin is not allow-listed. Empty list ⇒ refuse everything. */
export function assertOriginAllowed(url: URL, cfg: ObsConfig): void {
  if (cfg.allowedOrigins.size === 0) {
    throw new ObsPermissionError(
      `denied: origin "${originLabel(url)}" is not in allowed_origins (empty allow-list = deny all)`,
    );
  }
  const canonical = canonicalizeUrlOrigin(url);
  if (!cfg.allowedOrigins.has(canonical)) {
    throw new ObsPermissionError(
      `denied: origin "${canonical}" is not in allowed_origins — add it to the obs tool_config block to reach it`,
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
 * TEST-ONLY escape hatch for the private-address gate.
 *
 * The tests in this package drive the remote tools against a real `Bun.serve`
 * on 127.0.0.1, because mocking `fetch` would prove nothing about whether a
 * redirect chain drops the token, whether a deadline fires, or whether a byte
 * cap really cancels a stream. Reaching a real local server means lifting the
 * loopback refusal, and this is the only thing that lifts it.
 *
 * It is deliberately NOT reachable from a spec: no `tool_config` key sets it,
 * nothing exported to the catalog calls it, and it is `false` on every process
 * start. It lifts LOOPBACK ONLY — 169.254.169.254, an RFC1918 address and a
 * `.local` name stay refused with the flag on, so a stray import cannot open
 * the cloud metadata endpoint or the machine's LAN.
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

/** An abort shaped the way `describeFailure` reads it. */
function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("the request was aborted before it completed");
  err.name = "AbortError";
  return err;
}

/**
 * Lose to an abort as well as to a rejection.
 *
 * `dns.lookup` takes no signal, so without this the RESOLVER's own timeout —
 * tens of seconds against a black-holed nameserver, and longer with retries —
 * outlives the deadline the caller declared. A tool that can outrun its own
 * deadline can hang, which is the whole thing the deadline exists to stop; the
 * lookup itself is left to finish into nothing, because there is no way to
 * cancel it and its result is no longer wanted.
 */
function raceSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Reject a host that is — or resolves to — loopback, link-local, RFC1918,
 * CGNAT, or mDNS. Returns the vetted IP so the caller can pin the socket to
 * it instead of letting the stack re-resolve at connect time.
 *
 * `signal` bounds the DNS step by the caller's deadline. It is optional only
 * so the classification helpers stay callable from a test without one.
 */
export async function assertNotSsrf(hostname: string, signal?: AbortSignal): Promise<string> {
  const lower = hostname.toLowerCase();
  const unbracketed = lower.replace(/^\[/, "").replace(/\]$/, "");

  /** The flag lifts loopback and nothing else — see its declaration. */
  const refused = (ip: string): boolean =>
    isPrivateIp(ip) && !(privateHostsAllowedForTest && isLoopback(ip));

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    if (!privateHostsAllowedForTest) {
      throw new ObsPermissionError(`SSRF: host "${hostname}" resolves to loopback`);
    }
  } else if (lower.endsWith(".local")) {
    throw new ObsPermissionError(`SSRF: mDNS host "${hostname}" is not allowed`);
  } else if (refused(unbracketed)) {
    throw new ObsPermissionError(`SSRF: host "${hostname}" is a private/loopback IP`);
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
    throw new ObsPermissionError(`SSRF: host "${hostname}" is not a valid IPv6 address`);
  }

  let resolved: { readonly address: string; readonly family: number };
  try {
    resolved = await raceSignal(dnsLookupFn(lower), signal);
  } catch (err) {
    // An abort is the deadline, not a resolver failure, and must keep its own
    // name so the caller is told which of the two happened.
    if (err instanceof Error && err.name === "AbortError") throw err;
    if (signal?.aborted === true) throw abortError(signal);
    const msg = err instanceof Error ? err.message : String(err);
    throw new ObsPermissionError(`SSRF: cannot resolve "${hostname}": ${msg}`);
  }
  if (refused(resolved.address)) {
    throw new ObsPermissionError(
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
 * A deadline that also honours the runtime's own cancellation. Every outbound
 * tool here opens one before its first byte and cancels it in a `finally` — a
 * tool that can hang forever is a defect.
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
// credentials
// ---------------------------------------------------------------------------

/** Header names that must never be supplied inline, and never survive a hop. */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);

/** Response headers stripped before anything reaches a model. */
const STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  ...CREDENTIAL_HEADERS,
  "set-cookie",
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_NAME_LENGTH = 128;

/** Prefixes that mark a value which arrived as a NAME as really a secret. */
const TOKEN_PREFIXES: readonly string[] = [
  "ghp_",
  "gho_",
  "github_pat_",
  "glpat-",
  "sk-",
  "xoxb-",
  "xoxp-",
  "pk_",
  "bearer ",
  "eyj", // a JWT's base64 `{"` header
];

function looksLikeAToken(value: string): boolean {
  const lower = value.toLowerCase();
  return TOKEN_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export type ResolvedToken =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly message: string };

/**
 * Read the token out of the named environment variable.
 *
 * The NAME is what travels through the tool call; the value never does. Two
 * rules keep it that way, and neither of them ever prints the value it
 * refused:
 *
 *   - A value that is not shaped like an environment variable name, or that
 *     carries a known token prefix, is refused as a pasted secret. The refusal
 *     quotes nothing, because a tool result is a transcript, a trace and
 *     usually an eval report.
 *   - A name that IS a name may be quoted back, since "PROM_TOKEN is unset" is
 *     the whole point of the message and a variable name is not a secret.
 *
 * `optional` is for the read-only surfaces that a deployment may expose
 * without auth at all: with no `tokenEnv` configured they proceed with no
 * credential rather than refusing.
 */
export function resolveToken(
  envVar: string | undefined,
  env: Record<string, string | undefined> = process.env,
  optional = false,
): ResolvedToken {
  if (envVar === undefined || envVar === "") {
    if (optional) return { ok: true, token: "" };
    return {
      ok: false,
      message:
        "no token: set token_env in the obs tool_config block to the NAME of an environment variable holding the API token — the token itself is never accepted as an argument",
    };
  }
  if (!ENV_NAME.test(envVar) || envVar.length > MAX_ENV_NAME_LENGTH || looksLikeAToken(envVar)) {
    return {
      ok: false,
      // Deliberately no quoting of `envVar`: if this fired because a secret was
      // pasted in, echoing it back is the leak this path exists to prevent.
      message:
        "token_env must be the NAME of an environment variable (letters, digits and underscores, e.g. PROM_TOKEN), not a token. The value given is not a usable name and has not been echoed back; if it was the token itself, treat it as exposed to whoever wrote it and set the variable instead",
    };
  }
  const value = env[envVar];
  if (value === undefined || value === "") {
    return {
      ok: false,
      message: `token_env names environment variable "${envVar}", which is unset or empty in this process`,
    };
  }
  return { ok: true, token: value };
}

/**
 * A function that scrubs a secret out of anything on its way back to the
 * caller.
 *
 * Everything this package returns — results, refusals, the text of an API
 * error — goes through one of these. It is the backstop, not the primary
 * defence: the token is only ever placed in a request header, never in a path,
 * a query string or a body. But a platform that echoes a header, or a
 * transport error that quotes a request, would each put the token in a
 * transcript, and that is not a mistake worth leaving one layer deep.
 *
 * Secrets shorter than six characters are left alone: replacing every "x" in a
 * result would mangle it without protecting anything real, and no usable API
 * token is that short.
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

/**
 * The origins the configured surfaces address.
 *
 * `allowed_origins` is the reachability list and is deliberately wider: a
 * deployment allow-lists every endpoint a probe may touch. The TOKEN, though,
 * was minted for the observability platform the spec configured, and sending
 * it to an origin that is merely reachable hands it to whoever runs that
 * origin. So credentials are scoped to this set, not to the allow-list.
 *
 * A `base_url` that does not parse is skipped rather than throwing: the
 * surface that carries it refuses when it is used, with a message that names
 * it, and one bad entry must not disarm the scoping for the others.
 */
export function configuredOrigins(cfg: ObsConfig): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const endpoint of [cfg.metrics, cfg.logs, cfg.alerts, cfg.alertAck, cfg.statusPage]) {
    if (endpoint === undefined) continue;
    try {
      origins.add(canonicalizeOrigin(endpoint.baseUrl));
    } catch {
      // not a usable origin — the surface using it refuses on its own path
    }
  }
  return origins;
}

/** True when a URL addresses one of the surfaces the spec configured. */
export function isConfiguredOrigin(url: URL, origins: ReadonlySet<string>): boolean {
  try {
    return origins.has(canonicalizeUrlOrigin(url));
  } catch {
    return false;
  }
}

/** The auth header a config's profile sets, or `{}` when there is no token. */
export function authHeaders(cfg: ObsConfig, token: string): Record<string, string> {
  if (token === "") return {};
  const name = cfg.authHeader ?? "Authorization";
  const prefix = cfg.authPrefix ?? "Bearer ";
  return { [name]: `${prefix}${token}` };
}

/** Response headers as a sorted plain object, credentials removed. */
export function responseHeaders(res: Response): Record<string, string> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of res.headers.entries()) {
    const lower = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    pairs.push([lower, value]);
  }
  pairs.sort((a, b) => byString(a[0], b[0]));
  return Object.fromEntries(pairs);
}

// ---------------------------------------------------------------------------
// the request path
// ---------------------------------------------------------------------------

export type RawFetch = (req: Request, pinnedIp: string) => Promise<Response>;

/**
 * Dial the vetted IP while keeping the real hostname for the `Host` header and
 * TLS SNI, so virtual hosting and certificate validation still work.
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
  readonly cfg: ObsConfig;
  readonly maxRedirects?: number;
  /**
   * Extra header names (lowercased) to treat as credentials on this call —
   * whatever the configured auth profile set. They are dropped on a
   * cross-origin hop alongside the three well-known names.
   */
  readonly credentialHeaders?: ReadonlySet<string>;
};

export type OpenResult = {
  readonly res: Response;
  /** The URL actually answered, with the query string dropped. */
  readonly finalUrl: string;
  /** Every `Location` followed, in order, with query strings dropped. */
  readonly redirects: readonly string[];
  /** True when a cross-origin hop dropped the credential. */
  readonly credentialsDropped: boolean;
};

/**
 * Issue a request, following redirects by hand so the allow-list, the SSRF
 * gate and the credential rule run on every hop. The response body is left
 * unread — the caller decides how to drain it under which cap.
 */
export async function openRequest(o: OpenOptions): Promise<OpenResult> {
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
      throw new ObsPermissionError(
        `denied: scheme "${current.protocol}" — only http/https are allowed`,
      );
    }
    assertNoUserinfo(current);
    assertOriginAllowed(current, o.cfg);
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
      return {
        res,
        finalUrl: safeUrlLabel(current),
        redirects,
        credentialsDropped,
      };
    }
    if (hop >= limit) {
      await discard(res);
      throw new ObsPermissionError(`too many redirects (>${limit})`);
    }

    const location = res.headers.get("location") ?? "";
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      await discard(res);
      throw new ObsPermissionError(`invalid redirect target "${safeUrlLabel(location)}"`);
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
    // Replaying an alert acknowledgement at each hop is not what a server
    // asking for a redirect means.
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
 * is passed so a hostile or merely enormous response cannot pin memory. The
 * cap bounds what is HELD, not what is returned after buffering.
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

/** A URL the caller supplied, or a readable refusal. */
export function parseUrl(raw: string): URL | string {
  try {
    return new URL(raw);
  } catch {
    return `"${raw}" is not an absolute URL — include the scheme, e.g. https://prom.example.com`;
  }
}

/**
 * Turn anything thrown on the network path into the one-line string a tool
 * returns. A refusal, a deadline and a transport failure read differently,
 * because the caller's next move differs.
 */
export function describeFailure(err: unknown, deadline?: Deadline): string {
  if (err instanceof ObsPermissionError) return err.message;
  if (deadline?.expired() === true) return "deadline elapsed before the request completed";
  if (err instanceof Error) {
    if (err.name === "AbortError") return "the request was aborted before it completed";
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
