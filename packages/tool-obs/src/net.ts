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

/**
 * Normalise an IPv4 literal to dotted-decimal. Octal (`0177.0.0.1`), hex
 * (`0x7f000001`) and 32-bit integer (`2130706433`) forms all reach 127.0.0.1,
 * so they are canonicalised before classification — otherwise they are an
 * allow-list bypass. `null` when `raw` is not IPv4.
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
 * Classifying IPv6 by string prefix only recognises the ONE spelling a
 * resolver happens to print. `::1`, `0:0:0:0:0:0:0:1` and `::0:1` are the same
 * address, and a gate that catches the first and waves the others through is
 * not a gate. Everything is expanded to numbers and classified arithmetically.
 */
export function expandIpv6(raw: string): number[] | null {
  let ip = raw.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // A zone id (`fe80::1%eth0`, or its percent-encoded `%25eth0` form) names a
  // local interface, not part of the address. Drop it before classification so
  // it cannot dress a link-local address up as an unrecognised one.
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
  // 64:ff9b::/96 — the well-known NAT64 prefix, which translates to IPv4 and
  // carries that address in its last two groups.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIp(embeddedIpv4(g6, g7));
  }
  // 64:ff9b:1::/48 — RFC 8215's LOCAL-USE NAT64 prefix. Its embedded IPv4 sits
  // at a position that depends on the translator's prefix length, so there is
  // no one pair of groups to read it out of; the whole block is refused
  // instead. Reading the wrong two groups would classify `64:ff9b:1::7f00:1`
  // — loopback through a local translator — as a public address, which is how
  // this range gets used as a bypass.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0x0001) return true;
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
    // through: "I could not classify it" must never read as "it is public".
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
