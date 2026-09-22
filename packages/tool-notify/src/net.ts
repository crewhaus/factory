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
import { lookup as dnsLookup, resolveTxt } from "node:dns/promises";
import { CrewhausError } from "@crewhaus/errors";
import { joinTxtChunks, normalizeDomain } from "./lib/dns-records";

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
  /**
   * Domains this harness may ask public DNS about, canonicalised. Empty
   * denies every one, which makes `DeliverabilityCheck` unusable until an
   * operator says which domains are theirs.
   *
   * A DNS query is not an HTTP request and so does not pass through the
   * origin allow-list — but the name queried is still chosen by the caller
   * and still leaves the machine, which is the shape of an exfiltration
   * channel. This is the gate for that surface, and it is fail-closed like
   * every other one here.
   */
  readonly allowedSenderDomains: ReadonlySet<string>;
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
  readonly allowed_sender_domains?: readonly string[];
  readonly allowedSenderDomains?: readonly string[];
  readonly providers?: Readonly<Record<string, ProviderProfile>>;
};

const EMPTY_CONFIG: NotifyConfig = {
  allowedOrigins: new Set<string>(),
  allowedRecipients: [],
  allowedSmtpHosts: new Set<string>(),
  allowedSenderDomains: new Set<string>(),
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
  const senderDomains = new Set<string>();
  for (const domain of input.allowedSenderDomains ?? input.allowed_sender_domains ?? []) {
    if (domain.trim() === "") continue;
    // Canonicalised by the SAME function the tool runs on its argument, so
    // an operator writing `München.DE` and a caller writing `xn--mnchen-3ya.de`
    // name the same domain rather than two that never match. A malformed
    // entry throws here rather than sitting in the set matching nothing,
    // which is how a misconfiguration surfaces at boot and not at the first
    // lookup.
    const normalized = normalizeDomain(domain);
    if (!normalized.ok) {
      throw new NotifyPermissionError(
        `invalid entry in allowed_sender_domains: ${normalized.reason}`,
      );
    }
    senderDomains.add(normalized.name);
  }
  const providers = new Map<string, ProviderProfile>();
  for (const [name, profile] of Object.entries(input.providers ?? {})) {
    providers.set(name, profile);
  }
  return {
    allowedOrigins: origins,
    allowedRecipients: recipients,
    allowedSmtpHosts: smtpHosts,
    allowedSenderDomains: senderDomains,
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
 * Refuse a domain no operator named. Empty list ⇒ refuse everything.
 *
 * `domain` must ALREADY be the canonical form — the caller normalises once
 * and then uses that one value for the gate, for the names it derives and
 * for what it reports, so there is no spelling that passes the check and a
 * different one that reaches the resolver.
 */
export function assertSenderDomainAllowed(domain: string, cfg: NotifyConfig): void {
  if (cfg.allowedSenderDomains.size === 0) {
    throw new NotifyPermissionError(
      `denied: "${domain}" is not in allowed_sender_domains (empty allow-list = deny all). An operator lists the domains this harness may ask public DNS about`,
    );
  }
  if (!cfg.allowedSenderDomains.has(domain)) {
    throw new NotifyPermissionError(`denied: "${domain}" is not in allowed_sender_domains`);
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

// ---------------------------------------------------------------------------
// TXT lookups
// ---------------------------------------------------------------------------

/**
 * Every TXT record at a name, each still split into the character-strings
 * DNS carried it in. The joining rule belongs to the parser, not here, so
 * the seam a test injects hands back exactly what a resolver hands back.
 */
export type DnsTxtFn = (name: string) => Promise<ReadonlyArray<ReadonlyArray<string>>>;

const defaultDnsTxt: DnsTxtFn = (name) => resolveTxt(name);
let dnsTxtFn: DnsTxtFn = defaultDnsTxt;

/** Test-only resolver injection. No test in this package may reach real DNS. */
export function _setDnsTxtResolver(fn: DnsTxtFn | undefined): void {
  dnsTxtFn = fn ?? defaultDnsTxt;
}

/**
 * What a TXT lookup found — with "nothing is published" and "the question
 * could not be answered" kept apart.
 *
 * This is the whole reason the type has four arms rather than returning
 * `string[]`. "No SPF record" is a finding about a domain; "the resolver
 * returned SERVFAIL" is a finding about the lookup, and reporting the second
 * as the first tells somebody their DNS is fine when nobody asked it
 * anything.
 */
export type TxtAnswer =
  | { readonly outcome: "records"; readonly records: readonly string[] }
  /** The name exists and publishes no TXT record. */
  | { readonly outcome: "none" }
  /** The name does not exist at all. */
  | { readonly outcome: "nxdomain" }
  | { readonly outcome: "unknown"; readonly reason: string };

/**
 * What this package will read back from a name, and report.
 *
 * A DKIM key at 4096 bits is about 800 characters, so these are generous;
 * what they stop is an answer nobody can use ending up in a transcript, a
 * trace and an eval report. The bound is on what is REPORTED — the resolver
 * has already buffered whatever it received by the time this sees it, which
 * is the one place in this package where a cap cannot come first.
 */
const MAX_TXT_RECORDS = 32;
const MAX_TXT_RECORD_CHARS = 8192;

/**
 * Race a lookup against the call's deadline.
 *
 * `dns.promises` takes no signal, so the deadline is applied here instead.
 * The losing lookup is left to finish on its own — its rejection is already
 * attached below, so it cannot surface later as an unhandled one.
 */
function withDeadline<T>(work: Promise<T>, deadline: Deadline): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = deadline.signal;
    const fail = (): void => reject(new Error("aborted"));
    if (signal.aborted) {
      fail();
      return;
    }
    const onAbort = (): void => fail();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Ask for the TXT records at `name`.
 *
 * The two codes that ARE answers are mapped to answers: c-ares reports
 * NXDOMAIN as `ENOTFOUND` and "the name exists but has no record of this
 * type" as `ENODATA`, and both of those genuinely mean nothing is published.
 * Everything else — SERVFAIL, a refused query, a timeout, a resolver that is
 * not reachable — is `unknown` WITH the reason, because a lookup that did
 * not happen must not read as a domain that published nothing.
 */
export async function lookupTxt(name: string, deadline: Deadline): Promise<TxtAnswer> {
  let raw: ReadonlyArray<ReadonlyArray<string>>;
  try {
    raw = await withDeadline(dnsTxtFn(name), deadline);
  } catch (err) {
    if (deadline.expired()) {
      return { outcome: "unknown", reason: `the lookup of "${name}" hit the deadline` };
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND") return { outcome: "nxdomain" };
    if (code === "ENODATA") return { outcome: "none" };
    const detail = err instanceof Error ? err.message : String(err);
    return {
      outcome: "unknown",
      reason: `the lookup of "${name}" failed: ${code === undefined ? detail : code}`,
    };
  }
  // Answer order is not stable — a resolver may rotate records between
  // queries — so the list is sorted before anybody reads it, and a repeated
  // call reports the same bytes. Order WITHIN a record is untouched: an SPF
  // record's terms are evaluated left to right and mean different things
  // rearranged.
  const records = raw.map((chunks) => joinTxtChunks([...chunks])).sort(byString);
  // Over the cap is `unknown`, never a truncated record: a parser handed the
  // first 8192 characters of an SPF record would report the `-all` it did
  // not see as missing, which is a wrong answer where this is a missing one.
  if (records.length > MAX_TXT_RECORDS) {
    return {
      outcome: "unknown",
      reason: `"${name}" has ${records.length} TXT records, more than the ${MAX_TXT_RECORDS} this tool will read`,
    };
  }
  const oversized = records.find((record) => record.length > MAX_TXT_RECORD_CHARS);
  if (oversized !== undefined) {
    return {
      outcome: "unknown",
      reason: `"${name}" has a TXT record of ${oversized.length} characters, over the ${MAX_TXT_RECORD_CHARS} this tool will read`,
    };
  }
  return records.length === 0 ? { outcome: "none" } : { outcome: "records", records };
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
 * `parseIpv6` under this package's older name, returning a mutable array.
 *
 * Deliberately OUTSIDE the synchronised block: `smtp.ts` uses it to decide
 * whether a host is an IP literal and so has no SNI name, the SSRF gate
 * re-emits an IPv6 literal in expanded form from it, and `lib.test.ts`
 * imports it. The block's own text must not change, so the adaptation to
 * this package's older name and signature lives here instead.
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
  return ledger.get(`${tool}\u0000${key}`);
}

export function ledgerRecord(tool: string, key: string | undefined, result: string): void {
  if (key === undefined || key === "") return;
  const id = `${tool}\u0000${key}`;
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
