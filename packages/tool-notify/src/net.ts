/**
 * The outbound posture for `@crewhaus/tool-notify`.
 *
 * Every byte this package sends — a chat post, an SMTP session, a webhook,
 * an SMS — leaves through this module. The gate is the one
 * `@crewhaus/tool-http` established, carried over rather than re-derived,
 * because a second outbound surface with a weaker gate is the same hole
 * twice:
 *
 *   1. Empty allow-list ⇒ deny all. There is no "allow everything" value,
 *      for origins, for SMTP hosts, or for email recipients.
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
 *      socket (CWE-367). The SMTP client pins the same way.
 *   6. A send never follows a redirect. A 3xx on a POST is reported as a
 *      failure, because the alternatives — replaying the body at the new
 *      origin, or silently downgrading to a GET that delivers nothing — are
 *      both worse than telling the caller to point the allow-list at the
 *      real endpoint. Only the read-only `DeliveryCheck` follows, and then
 *      the allow-list, the SSRF gate and the credential rules run again on
 *      every hop.
 *   7. Credentials are environment variable NAMES, never values. Whatever
 *      header a profile sets is dropped the moment a redirect leaves the
 *      origin it was minted for, and every result — success or failure —
 *      goes through a redactor built from the resolved secret.
 *   8. Every request is deadline-bounded and every response is byte-capped,
 *      with the cap bounding memory rather than applied after buffering.
 *
 * What it does NOT do, so nobody assumes otherwise: no proxy support, no
 * cookie jar, and no certificate handling beyond the runtime's own.
 */
import { Buffer } from "node:buffer";
import { lookup as dnsLookup } from "node:dns/promises";
import { CrewhausError } from "@crewhaus/errors";

/** Refusal by the allow-list, the SSRF gate, or a redirect rule. */
export class NotifyPermissionError extends CrewhausError {
  override readonly name = "NotifyPermissionError";
  constructor(message: string) {
    super("tool", message);
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_BYTES = 256 * 1024;
export const MAX_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

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
 * A REST provider described by the operator rather than hard-coded here.
 *
 * `SmsSend`, `PushNotify` and `DeliveryCheck` all speak this shape. Naming a
 * vendor in the code would mean a new release every time somebody moves from
 * one gateway to another; naming the endpoint, the auth variable and the
 * field mapping in the spec means the operator does it in a diff.
 */
export type ProviderProfile = {
  /** Absolute https URL. Its origin must also be in `allowed_origins`. */
  readonly endpoint: string;
  /** POST unless the provider insists otherwise. */
  readonly method?: string;
  /** "json" (default) or "form" — how the mapped fields are encoded. */
  readonly encoding?: "json" | "form";
  readonly auth?: AuthProfile;
  /**
   * Canonical field name → the provider's own field name. `to`, `body`,
   * `from`, `title`, `mediaUrl` and `data` are the names the tools use.
   */
  readonly fields?: Readonly<Record<string, string>>;
  /** Constant fields merged into every request (a sender id, an app id). */
  readonly staticFields?: Readonly<Record<string, string>>;
  /** Dotted path in the response holding the provider's message id. */
  readonly idPath?: string;
  /** Dotted path in the response holding a delivery status. */
  readonly statusPath?: string;
  /** URL template for `DeliveryCheck`; `{id}` is substituted. */
  readonly statusEndpoint?: string;
  /** Header carrying an idempotency key, when the provider honours one. */
  readonly idempotencyHeader?: string;
};

export type NotifyConfig = {
  /** Canonical origins. Empty (the default) denies every request. */
  readonly allowedOrigins: ReadonlySet<string>;
  /**
   * Who email may be addressed to: a full address, or `*@domain`. Empty
   * denies every recipient, which makes `EmailSend` unusable until an
   * operator says who the harness is allowed to write to.
   */
  readonly allowedRecipients: readonly string[];
  /** SMTP hosts the client may dial. Empty denies every one. */
  readonly allowedSmtpHosts: ReadonlySet<string>;
  /** Named REST providers for SMS, push and delivery lookups. */
  readonly providers: ReadonlyMap<string, ProviderProfile>;
};

export type NotifyConfigInput = {
  readonly allowed_origins?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly allowed_recipients?: readonly string[];
  readonly allowedRecipients?: readonly string[];
  readonly allowed_smtp_hosts?: readonly string[];
  readonly allowedSmtpHosts?: readonly string[];
  readonly providers?: Readonly<Record<string, ProviderProfile>>;
};

const EMPTY_CONFIG: NotifyConfig = {
  allowedOrigins: new Set<string>(),
  allowedRecipients: [],
  allowedSmtpHosts: new Set<string>(),
  providers: new Map<string, ProviderProfile>(),
};

let notifyConfig: NotifyConfig = EMPTY_CONFIG;

/** Build a config from a spec-shaped block. Pure; both key spellings accepted. */
export function buildNotifyConfig(input: NotifyConfigInput): NotifyConfig {
  const origins = new Set<string>();
  for (const origin of input.allowedOrigins ?? input.allowed_origins ?? []) {
    origins.add(canonicalizeOrigin(origin));
  }
  const recipients = [...(input.allowedRecipients ?? input.allowed_recipients ?? [])]
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r !== "")
    .sort(byString);
  const smtpHosts = new Set<string>();
  for (const host of input.allowedSmtpHosts ?? input.allowed_smtp_hosts ?? []) {
    const trimmed = host.trim().toLowerCase();
    if (trimmed !== "") smtpHosts.add(trimmed);
  }
  const providers = new Map<string, ProviderProfile>();
  for (const [name, profile] of Object.entries(input.providers ?? {})) {
    providers.set(name, profile);
  }
  return {
    allowedOrigins: origins,
    allowedRecipients: recipients,
    allowedSmtpHosts: smtpHosts,
    providers,
  };
}

/** Replace the process-global allow-list. Codegen calls this at boot. */
export function registerNotifyConfig(input: NotifyConfigInput): void {
  notifyConfig = buildNotifyConfig(input);
}

export function getNotifyConfig(): NotifyConfig {
  return notifyConfig;
}

/**
 * The config ONE call runs under: the serving candidate's
 * `tool_config.notify` block when it declares one, else the boot
 * registration. A non-object override is ignored rather than widened — the
 * allow-list only ever comes from a spec block.
 */
export function resolveNotifyConfig(override: unknown): NotifyConfig {
  if (typeof override === "object" && override !== null && !Array.isArray(override)) {
    return buildNotifyConfig(override as NotifyConfigInput);
  }
  return notifyConfig;
}

/** Test-only — back to fail-closed empty. */
export function _resetNotifyConfig(): void {
  notifyConfig = EMPTY_CONFIG;
}

/**
 * Canonicalise an origin for exact-match comparison: lowercase scheme and
 * host, drop path/query/fragment, elide the default port. Throws on a
 * malformed origin so a misconfiguration surfaces at boot, not at the first
 * send.
 */
export function canonicalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NotifyPermissionError(`invalid origin "${raw}" — must be an absolute URL`);
  }
  return canonicalizeUrlOrigin(url, `${url.protocol}//${url.host}`);
}

/**
 * The origin of a URL already parsed, without putting the URL back into any
 * message. `label` is what a refusal may name — never the full URL, because
 * a Slack or Teams incoming-webhook URL IS the credential, and an error
 * string is a thing that ends up in a transcript.
 */
export function canonicalizeUrlOrigin(url: URL, label = `${url.protocol}//${url.host}`): string {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NotifyPermissionError(
      `invalid origin "${label}" — only http/https schemes are supported`,
    );
  }
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (host === "") {
    throw new NotifyPermissionError(`invalid origin "${label}" — host is required`);
  }
  let port = "";
  if (url.port !== "") {
    const isDefault =
      (scheme === "http:" && url.port === "80") || (scheme === "https:" && url.port === "443");
    port = isDefault ? "" : `:${url.port}`;
  }
  return `${scheme}//${host}${port}`;
}

/**
 * How a webhook URL is allowed to appear in a message: scheme, host and a
 * path length, with the path itself and the query dropped.
 *
 * A Slack incoming webhook (`/services/T…/B…/xxxx`) and a Discord one
 * (`/api/webhooks/<id>/<token>`) both carry their whole authority in the
 * path. Printing the path into a refusal would post the credential into the
 * transcript, so only its shape is printed.
 */
export function safeUrlLabel(raw: string | URL): string {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    return "<unparseable url>";
  }
  const pathLen = url.pathname.length + url.search.length;
  return `${url.protocol}//${url.host} (path of ${pathLen} characters, not shown)`;
}

/** Refuse a URL that carries `user:pass@`. */
export function assertNoUserinfo(url: URL): void {
  if (url.username !== "" || url.password !== "") {
    throw new NotifyPermissionError(
      `denied: the URL for "${url.protocol}//${url.host}" carries userinfo (user:password@host) — use the auth profile, which names an environment variable instead of putting the secret in the URL`,
    );
  }
}

/** Refuse a URL whose origin is not allow-listed. Empty list ⇒ refuse everything. */
export function assertOriginAllowed(url: URL, cfg: NotifyConfig): void {
  if (cfg.allowedOrigins.size === 0) {
    throw new NotifyPermissionError(
      `denied: origin "${url.protocol}//${url.host}" is not in allowed_origins (empty allow-list = deny all)`,
    );
  }
  const canonical = canonicalizeUrlOrigin(url);
  if (!cfg.allowedOrigins.has(canonical)) {
    throw new NotifyPermissionError(`denied: origin "${canonical}" is not in allowed_origins`);
  }
}

/** Refuse an SMTP host no operator named. Empty list ⇒ refuse everything. */
export function assertSmtpHostAllowed(host: string, cfg: NotifyConfig): void {
  const lower = host.trim().toLowerCase();
  if (cfg.allowedSmtpHosts.size === 0) {
    throw new NotifyPermissionError(
      `denied: SMTP host "${host}" is not in allowed_smtp_hosts (empty allow-list = deny all)`,
    );
  }
  if (!cfg.allowedSmtpHosts.has(lower)) {
    throw new NotifyPermissionError(`denied: SMTP host "${host}" is not in allowed_smtp_hosts`);
  }
}

/**
 * Does `address` match an allow-list entry?
 *
 * An entry is either a whole address or `*@domain`. A bare domain is NOT
 * accepted as a wildcard: `example.com` would read to a human as "anyone at
 * example.com" and to this function as "the address example.com", and a gate
 * whose entries mean one thing to the operator and another to the code is
 * not a gate. Matching is case-insensitive on the whole address, which is
 * looser than RFC 5321 (local-parts are technically case-sensitive) and the
 * looseness is in the safe direction only for the domain — so a deliberately
 * case-varied local part cannot slip a DIFFERENT mailbox past an entry,
 * because the entry had to name that mailbox's spelling in the first place.
 */
export function recipientAllowed(address: string, cfg: NotifyConfig): boolean {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0 || at === lower.length - 1) return false;
  const domain = lower.slice(at + 1);
  for (const entry of cfg.allowedRecipients) {
    if (entry === lower) return true;
    if (entry.startsWith("*@") && entry.slice(2) === domain) return true;
  }
  return false;
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
 * The tests in this package drive the tools against a real `Bun.serve` and a
 * real SMTP listener on 127.0.0.1, because mocking `fetch` would prove
 * nothing about whether a deadline, a byte cap or an SMTP handshake actually
 * works. Reaching a real local server means the loopback refusal has to be
 * lifted for the duration of a test, and this is the only thing that lifts
 * it.
 *
 * It is deliberately NOT reachable from a spec: no `tool_config` key sets it,
 * nothing exported to the catalog calls it, and it defaults to `false` on
 * every process start.
 *
 * It lifts LOOPBACK ONLY. The tests need 127.0.0.1 and `::1`; they have never
 * needed 169.254.169.254, an RFC1918 address or a `.local` name, so flipping
 * this flag must not open the cloud metadata endpoint or the machine's LAN.
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
      throw new NotifyPermissionError(`SSRF: host "${hostname}" resolves to loopback`);
    }
  } else if (lower.endsWith(".local")) {
    throw new NotifyPermissionError(`SSRF: mDNS host "${hostname}" is not allowed`);
  } else if (refused(unbracketed)) {
    throw new NotifyPermissionError(`SSRF: host "${hostname}" is a private/loopback IP`);
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
    throw new NotifyPermissionError(`SSRF: host "${hostname}" is not a valid IPv6 address`);
  }

  let resolved: { readonly address: string; readonly family: number };
  try {
    resolved = await dnsLookupFn(lower);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new NotifyPermissionError(`SSRF: cannot resolve "${hostname}": ${msg}`);
  }
  if (refused(resolved.address)) {
    throw new NotifyPermissionError(
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
 * Classifying IPv6 by string prefix only recognises the ONE spelling a
 * resolver happens to print. `::1`, `0:0:0:0:0:0:0:1` and `::0:1` are the
 * same address, and a gate that catches the first and waves the others
 * through is not a gate. Everything is expanded to numbers and classified
 * arithmetically, exactly as the IPv4 side is.
 */
export function expandIpv6(raw: string): number[] | null {
  let ip = raw.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // A zone id (`fe80::1%eth0`) names a local interface, not part of the
  // address. Drop it before classification so it cannot dress a link-local
  // address up as an unrecognised one.
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
    if (g6 === 0 && g7 === 0) return true; // ::
    if (g6 === 0 && g7 === 1) return true; // ::1
    return isPrivateIp(embeddedIpv4(g6, g7)); // ::a.b.c.d
  }
  if (topSixZero && g5 === 0xffff) return isPrivateIp(embeddedIpv4(g6, g7)); // ::ffff:0:0/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIp(embeddedIpv4(g6, g7)); // NAT64
  }
  if (g0 === 0x2002) return isPrivateIp(embeddedIpv4(g1, g2)); // 6to4

  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard
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
  if (a >= 224) return true; // multicast, reserved, broadcast
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
 * outbound tool here opens one before its first byte and cancels it in a
 * `finally` — a tool that can hang forever is a defect.
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
 * model that can put a token in a tool argument is a model that can put it in
 * a transcript, a trace event and an eval report.
 */
export type AuthProfile = {
  readonly type: "bearer" | "basic" | "header";
  readonly envVar: string;
  /** Header name for `type: "header"` (e.g. `X-Api-Key`). */
  readonly headerName?: string;
  /** Username for `type: "basic"`; the password comes from `envVar`. */
  readonly username?: string;
  /** Literal prefix before the secret for `type: "header"` (e.g. `token `). */
  readonly prefix?: string;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_NAME_LENGTH = 64;
const SECRET_PREFIXES: readonly string[] = [
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "xapp-",
  "sk_live_",
  "sk_test_",
  "ghp_",
  "github_pat_",
  "glpat-",
  "whsec_",
  "bearer ",
  "sk-",
  "ac", // Twilio account sids are `AC` + 32 hex, and are paired with a token
];

/** True when a value that arrived as a NAME is really a secret. */
function looksLikeASecret(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.startsWith("ac") && /^ac[0-9a-f]{32}$/.test(lower)) return true;
  return SECRET_PREFIXES.filter((p) => p !== "ac").some((prefix) => lower.startsWith(prefix));
}

export type ResolvedSecret =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

/**
 * Read a secret out of the named environment variable.
 *
 * The NAME travels through the tool call; the value never does. A value that
 * is not shaped like an environment variable name, or that carries a known
 * secret prefix, is refused as a pasted credential — and the refusal quotes
 * nothing, because a tool result is a transcript, a trace and usually an
 * eval report.
 */
export function resolveSecret(
  envVar: string | undefined,
  what: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedSecret {
  if (envVar === undefined || envVar === "") {
    return {
      ok: false,
      message: `no ${what}: name the environment variable holding it — the secret itself is never accepted as an argument`,
    };
  }
  if (!ENV_NAME.test(envVar) || envVar.length > MAX_ENV_NAME_LENGTH || looksLikeASecret(envVar)) {
    return {
      ok: false,
      message: `${what} must be the NAME of an environment variable (letters, digits and underscores, e.g. SLACK_WEBHOOK_URL), not the secret. The value given is not a usable name and has not been echoed back; if it was the secret itself, treat it as exposed to whoever wrote it and set the variable instead`,
    };
  }
  const value = env[envVar];
  if (value === undefined || value === "") {
    return {
      ok: false,
      message: `${what} names environment variable "${envVar}", which is unset or empty in this process`,
    };
  }
  return { ok: true, value };
}

/** Header names that must never be supplied inline, and never survive a hop. */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
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

export type AppliedAuth =
  | { readonly ok: true; readonly secretHeaders: ReadonlySet<string>; readonly secrets: string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Apply an auth profile to `headers`. Returns the lowercased names of the
 * headers it set — so a profile that puts the secret in `X-Api-Key` is
 * guarded exactly as hard as one that puts it in `Authorization` — and the
 * resolved secret values, which feed the redactor.
 */
export function applyAuth(
  headers: Record<string, string>,
  auth: AuthProfile | undefined,
  env: Record<string, string | undefined> = process.env,
): AppliedAuth {
  if (auth === undefined) return { ok: true, secretHeaders: new Set(), secrets: [] };
  const resolved = resolveSecret(auth.envVar, "auth profile envVar", env);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const secret = resolved.value;
  if (auth.type === "bearer") {
    headers["Authorization"] = `Bearer ${secret}`;
    return { ok: true, secretHeaders: new Set(["authorization"]), secrets: [secret] };
  }
  if (auth.type === "basic") {
    if (auth.username === undefined) {
      return {
        ok: false,
        message: 'auth type "basic" needs a username; the password comes from envVar',
      };
    }
    const encoded = Buffer.from(`${auth.username}:${secret}`, "utf8").toString("base64");
    headers["Authorization"] = `Basic ${encoded}`;
    return { ok: true, secretHeaders: new Set(["authorization"]), secrets: [secret, encoded] };
  }
  if (auth.headerName === undefined) {
    return { ok: false, message: 'auth type "header" needs a headerName' };
  }
  const lower = auth.headerName.toLowerCase();
  if (lower === "host") {
    return { ok: false, message: 'auth type "header" cannot set the Host header' };
  }
  headers[auth.headerName] = `${auth.prefix ?? ""}${secret}`;
  return { ok: true, secretHeaders: new Set([lower]), secrets: [secret] };
}

/**
 * A function that scrubs secrets out of anything on its way back to the
 * caller.
 *
 * Everything this package returns — results, refusals, the text of a
 * provider error, an SMTP server's reply — goes through one of these. It is
 * the backstop rather than the primary defence: a secret is only ever placed
 * in a header or an SMTP AUTH line, never in a path or a body. But a
 * provider that echoes a header, a transport error that quotes a request, or
 * an SMTP server that repeats what it was sent would each put the secret in
 * a transcript, and that is not a mistake worth leaving one layer deep.
 *
 * Secrets shorter than six characters are left alone: replacing every "x" in
 * a result would mangle it without protecting anything real.
 */
export function redactorFor(secrets: readonly (string | undefined)[]): (text: string) => string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret === undefined || secret.length < 6) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    try {
      forms.add(Buffer.from(secret, "utf8").toString("base64"));
    } catch {
      // not encodable — the literal form is still covered
    }
  }
  const ordered = [...forms].filter((f) => f.length >= 6).sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return (text) => text;
  return (text: string): string => {
    let out = text;
    for (const form of ordered) out = out.split(form).join("<redacted>");
    return out;
  };
}

/** Response headers as a sorted plain object, credentials removed. */
const STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
]);

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

export type OpenOptions = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | undefined;
  readonly signal: AbortSignal;
  readonly cfg: NotifyConfig;
  /**
   * `"refuse"` (the default for every send) reports a 3xx as a failure.
   * `"follow"` is for read-only lookups and re-runs the whole gate per hop.
   */
  readonly redirect?: "refuse" | "follow";
  readonly maxRedirects?: number;
  /** Lowercased header names to treat as credentials on this call. */
  readonly credentialHeaders?: ReadonlySet<string>;
};

export type OpenResult = {
  readonly res: Response;
  readonly redirects: number;
  /** True when a cross-origin hop dropped the credential headers. */
  readonly credentialsDropped: boolean;
};

/**
 * Issue a request. Redirects, when followed at all, are followed by hand so
 * the allow-list, the SSRF gate and the credential rules run on every single
 * hop. The response body is left unread — the caller decides how to drain it
 * under which cap.
 */
export async function openRequest(o: OpenOptions): Promise<OpenResult> {
  const policy = o.redirect ?? "refuse";
  const limit = o.maxRedirects ?? MAX_REDIRECTS;
  const headers: Record<string, string> = { ...o.headers };
  const isCredential = (name: string): boolean => {
    const lower = name.toLowerCase();
    return CREDENTIAL_HEADERS.has(lower) || o.credentialHeaders?.has(lower) === true;
  };
  let redirects = 0;
  let credentialsDropped = false;
  let current = o.url;
  let currentOrigin = canonicalizeUrlOrigin(o.url);

  for (let hop = 0; ; hop++) {
    assertNoUserinfo(current);
    assertOriginAllowed(current, o.cfg);
    const pinnedIp = await assertNotSsrf(current.hostname);

    const init: RequestInit = {
      method: o.method,
      redirect: "manual",
      signal: o.signal,
      headers,
      ...(o.body !== undefined && o.method !== "GET" && o.method !== "HEAD"
        ? { body: o.body }
        : {}),
    };
    const res = await rawFetch(new Request(current.toString(), init), pinnedIp);

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) return { res, redirects, credentialsDropped };

    if (policy === "refuse") {
      await discard(res);
      // Deliberately not printing the Location: a redirect target chosen by
      // the far end is content, and this refusal is read by a model.
      throw new NotifyPermissionError(
        `the endpoint answered ${res.status} with a redirect, which a send never follows — replaying the body at another origin, or downgrading to a GET that delivers nothing, are both worse than stopping. Point the configuration at the endpoint that actually accepts the message.`,
      );
    }
    if (hop >= limit) {
      await discard(res);
      throw new NotifyPermissionError(`too many redirects (>${limit})`);
    }

    const location = res.headers.get("location") ?? "";
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      await discard(res);
      throw new NotifyPermissionError("the endpoint sent a redirect this tool could not parse");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      await discard(res);
      throw new NotifyPermissionError(
        `denied: redirect to scheme "${next.protocol}" — only http/https are allowed`,
      );
    }
    const nextOrigin = canonicalizeUrlOrigin(next);
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
    await discard(res);
    redirects += 1;
    current = next;
    currentOrigin = nextOrigin;
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
 * is passed so a hostile endpoint cannot pin memory. The cap bounds what is
 * ever held, not what is kept after buffering.
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

/** A URL the caller supplied, or a readable refusal that does not echo it. */
export function parseUrl(raw: string): URL | string {
  try {
    return new URL(raw);
  } catch {
    return "that is not an absolute URL — include the scheme, e.g. https://hooks.example.com/services/… (the value has not been echoed back, in case it was a webhook URL, which is itself a credential)";
  }
}

/** Read a dotted path out of a parsed JSON body. `undefined` when absent. */
export function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (segment === "") continue;
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Turn anything thrown on the outbound path into the one-line string a tool
 * returns. A refusal, a deadline and a transport failure read differently,
 * because the caller's next move differs.
 */
export function describeFailure(err: unknown, deadline?: Deadline): string {
  if (err instanceof NotifyPermissionError) return err.message;
  if (deadline?.expired() === true) return "deadline elapsed before the send completed";
  if (err instanceof Error) {
    if (err.name === "AbortError") return "the send was aborted before it completed";
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

export type LedgerEntry = { readonly tool: string; readonly result: string };

/**
 * The per-process record of what has already been sent under which key.
 *
 * A retry loop that re-runs a tool call is the normal failure mode of an
 * agent, and "post it again" is the wrong answer when the first post
 * succeeded. Every sending tool takes an `idempotencyKey`; the key is passed
 * to the provider when the provider honours one, AND recorded here, so a
 * second call with the same key returns the first call's result and posts
 * nothing.
 *
 * This is deliberate hidden state, and it is the one place in the package
 * where a repeated call does not repeat its effect — which is the entire
 * point. It lives for the life of the process, is capped so a long run
 * cannot grow it without bound, and is keyed by tool as well as key so two
 * different tools cannot collide on the same string.
 */
const LEDGER_LIMIT = 512;
const ledger = new Map<string, LedgerEntry>();

export function ledgerLookup(tool: string, key: string | undefined): LedgerEntry | undefined {
  if (key === undefined || key === "") return undefined;
  return ledger.get(`${tool} ${key}`);
}

export function ledgerRecord(tool: string, key: string | undefined, result: string): void {
  if (key === undefined || key === "") return;
  const id = `${tool} ${key}`;
  if (ledger.size >= LEDGER_LIMIT && !ledger.has(id)) {
    // Oldest first — Map preserves insertion order.
    const oldest = ledger.keys().next();
    if (!oldest.done) ledger.delete(oldest.value);
  }
  ledger.set(id, { tool, result });
}

/** Test-only — a fresh process's empty ledger. */
export function _resetIdempotencyLedger(): void {
  ledger.clear();
}
