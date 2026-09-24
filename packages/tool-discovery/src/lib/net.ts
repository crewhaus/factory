/**
 * The network posture for `FederationDiscover` — the one place in this package
 * a socket can be opened, and the gate every URL passes through first.
 *
 * A peer id is attacker-influenced input. `FederationDiscover` turns it into
 * `https://<peer>/.well-known/crewhaus.json` and dials it, so an unguarded
 * dial here is a server-side request forgery primitive with a model holding
 * the steering wheel: `169.254.169.254` is the cloud metadata service and
 * `127.0.0.1:6379` is somebody's Redis. Worse than a plain `Fetch`, because
 * the peer's own answer names a SECOND address (`endpoint`) that whatever
 * federates next will dial — so that one is vetted too, and the verdict is
 * reported rather than swallowed.
 *
 * The defences, in the order they run:
 *
 *   1. Scheme must be http or https, and `user:pass@` is refused outright —
 *      userinfo is a credential that would otherwise ride into the result.
 *   2. When an operator has set an allow-list, the origin must be on it. It is
 *      deliberately not a field in any tool's input schema: a gate a model can
 *      open for itself is not a gate.
 *   3. Loopback, link-local (including the metadata address), RFC1918, CGNAT,
 *      multicast and reserved ranges are refused — as an IP literal in any of
 *      its encodings, and as the DNS-resolved address of a name.
 *   4. The vetted IP is what the socket goes to. Resolving in the guard and
 *      letting `fetch` re-resolve at connect time is the DNS-rebinding TOCTOU
 *      (CWE-367) the guard exists to close.
 *   5. Redirects are NOT followed. A 3xx is reported as the peer's answer,
 *      because following one would dial a host that went through none of the
 *      above.
 *   6. Every request is deadline-bounded and every body is byte-capped.
 *
 * The classifier in the synchronised block below is `@crewhaus/tool-fetch`'s,
 * byte-identical, because `apps/cli/src/tool-registry.test.ts` hashes every
 * copy in the repository and fails if one differs. It is carried rather than
 * imported: `tool-fetch` is not a dependency of this package, and a standing
 * maintainer decision keeps this package's dependency list to the registries
 * it exposes. Do not edit the block — edit every copy or none.
 *
 * WHAT THE VERDICT IS NOT. `{ ok: false, code: "unresolvable" }` is not a
 * refusal: the guard could not find out, which is a different answer from
 * "this address is private" and the caller classifies it differently. That
 * distinction is the whole reason this returns a verdict instead of throwing.
 */
import { CrewhausError } from "@crewhaus/errors";

export class PeerEndpointError extends CrewhausError {
  override readonly name = "PeerEndpointError";
  constructor(message: string) {
    super("tool", message);
  }
}

/** A peer's `.well-known` document is a few hundred bytes. This is slack. */
export const MAX_WELLKNOWN_BYTES = 256 * 1024;
/** Per-peer deadline when the caller names none. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Ceiling on a caller-supplied deadline, so one call cannot park a run. */
export const MAX_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// operator policy — bound at boot, never reachable from a tool's input
// ---------------------------------------------------------------------------

export type PeerPolicy = {
  /**
   * Permit loopback and private-range peers. A federation fixture on
   * `https://127.0.0.1:8443` is the reason this exists, and that address is
   * also every unauthenticated service on the box the agent runs on, which is
   * the reason it is off by default.
   */
  readonly allowPrivateHosts?: boolean;
  /**
   * When set, the ONLY origins that may be dialled. An operator who knows its
   * federation should set it; it turns the guard from a deny-list into an
   * allow-list. An empty array means "nothing may be dialled", not "anything".
   */
  readonly allowedOrigins?: ReadonlyArray<string>;
};

let policy: PeerPolicy = {};

/**
 * Bind the policy. A compiled bundle, `crewhaus run` and `crewhaus eval` bind
 * it at boot through {@link registerDiscoveryConfig}, from the spec's
 * `tool_config.federationDiscover` block; a host may call it directly.
 */
export function setPeerPolicy(next: PeerPolicy): void {
  policy = next;
}

/** The spec's `tool_config.federationDiscover` block. */
export type DiscoveryConfigInput = {
  readonly allowed_origins?: ReadonlyArray<string>;
  readonly allowedOrigins?: ReadonlyArray<string>;
};

/**
 * Deliver the spec's block at boot: `allowed_origins` becomes the ONLY peer
 * origins `FederationDiscover` may dial, and an empty list dials nothing. It
 * can only narrow — a spec that tries to open loopback and the private ranges
 * is refused, because a spec may come from a template or a pull request.
 */
export function registerDiscoveryConfig(input: DiscoveryConfigInput): void {
  const block = (input ?? {}) as Record<string, unknown>;
  for (const key of ["allow_private_hosts", "allowPrivateHosts"]) {
    if (Object.hasOwn(block, key)) {
      throw new PeerEndpointError(
        `tool_config.federationDiscover.${key} is not accepted: a spec cannot open loopback or private addresses. Remove it, and list the peer origins under allowed_origins.`,
      );
    }
  }
  if (Object.hasOwn(block, "allowed_origins") && Object.hasOwn(block, "allowedOrigins")) {
    throw new PeerEndpointError(
      "tool_config.federationDiscover sets both allowed_origins and allowedOrigins. Write the list once, as allowed_origins.",
    );
  }
  const raw = block["allowed_origins"] ?? block["allowedOrigins"];
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.some((o) => typeof o !== "string")) {
    throw new PeerEndpointError(
      'tool_config.federationDiscover.allowed_origins must be a list of origins, for example ["https://peer.example"].',
    );
  }
  const origins = (raw as string[]).map((o) => {
    let url: URL;
    try {
      url = new URL(o);
    } catch {
      throw new PeerEndpointError(
        `tool_config.federationDiscover.allowed_origins has "${o}", which is not an origin. Write it as https://host[:port].`,
      );
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new PeerEndpointError(
        `tool_config.federationDiscover.allowed_origins has "${url.protocol}//${url.host}", which is not http(s). Write it as https://host[:port].`,
      );
    }
    return url.origin;
  });
  setPeerPolicy({ ...policy, allowedOrigins: origins });
}

/** Read it back — `FederationDiscover` reports the posture it ran under. */
export function getPeerPolicy(): PeerPolicy {
  return policy;
}

/** Test-only: back to the fail-closed default. */
export function _resetPeerPolicy(): void {
  policy = {};
}

// ---------------------------------------------------------------------------
// resolution seam
// ---------------------------------------------------------------------------

export type DnsLookupFn = (
  host: string,
) => Promise<{ readonly address: string; readonly family: number }>;

/**
 * Production uses `node:dns/promises`; every test in this package replaces it,
 * so the suite never sends a DNS query and never opens a socket. `verbatim:
 * false` keeps the v4/v6 ordering deterministic for the check below.
 */
const defaultDnsLookup: DnsLookupFn = async (host) => {
  const dns = await import("node:dns/promises");
  return dns.lookup(host, { verbatim: false });
};

let dnsLookupFn: DnsLookupFn = defaultDnsLookup;

/** `_setDnsLookup(undefined)` restores the production resolver. */
export function _setDnsLookup(fn: DnsLookupFn | undefined): void {
  dnsLookupFn = fn ?? defaultDnsLookup;
}

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
// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

/**
 * Why a URL was not dialled.
 *
 * A CODE, not a message to match on: the caller branches on it to decide
 * whether the peer was refused (we never asked) or unreachable (we asked and
 * nothing came back), and those two are opposite answers about the same peer.
 * `unresolvable` is deliberately in the second camp.
 */
export type VetCode =
  | "not-a-url"
  | "scheme"
  | "userinfo"
  | "not-allow-listed"
  | "private"
  | "unresolvable";

export type Vetted =
  | {
      readonly ok: true;
      readonly url: URL;
      readonly pinnedIp: string;
      /**
       * True when an ADDRESS was established for this host — an IP literal
       * parsed numerically, or a name this process resolved.
       *
       * False in exactly one case: `allowPrivateHosts` is set, so there was
       * nothing left for a resolution to decide and none was done. The URL
       * passed the scheme, credential and allow-list gates and nothing here
       * found out whether it points anywhere at all. A caller reporting
       * "dialable" must report THAT as unknown, not as a yes — `ok: true`
       * alone means "not refused", which is a weaker claim.
       */
      readonly resolved: boolean;
    }
  | { readonly ok: false; readonly code: VetCode; readonly reason: string };

function deniedPrivate(host: string, what: string): string {
  return `refusing to dial "${host}" — it is ${what}, and reaching one from a model-supplied peer id is how an agent ends up reading a metadata service or an unauthenticated local port. An operator can permit it with setPeerPolicy({ allowPrivateHosts: true }) for a local fixture.`;
}

/**
 * Vet a URL and resolve the address the socket must go to.
 *
 * Returns a verdict rather than throwing, because two of the outcomes are not
 * errors of the same kind: a private address is a refusal to ask, and a name
 * that does not resolve is an unanswered question.
 */
export async function vetPeerUrl(rawUrl: string): Promise<Vetted> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: "not-a-url", reason: `"${rawUrl}" is not a URL` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      code: "scheme",
      reason: `refusing scheme "${url.protocol.replace(":", "")}" — a federation peer is reached over http(s)`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    // Userinfo lands in logs and in any error message quoting the URL, and
    // this tool quotes the URL in every one of its results.
    return {
      ok: false,
      code: "userinfo",
      reason: "refusing a URL with credentials in it — strip the user:password@",
    };
  }

  const allowed = policy.allowedOrigins;
  if (allowed !== undefined && !allowed.includes(url.origin)) {
    return {
      ok: false,
      code: "not-allow-listed",
      reason: `refusing "${url.origin}" — the operator's federation allow-list is ${allowed.length === 0 ? "empty, so nothing may be dialled" : allowed.join(", ")}`,
    };
  }

  const host = url.hostname.toLowerCase();
  const allowPrivate = policy.allowPrivateHosts === true;

  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost"))) {
    return { ok: false, code: "private", reason: deniedPrivate(url.hostname, "loopback") };
  }
  if (!allowPrivate && host.endsWith(".local")) {
    return { ok: false, code: "private", reason: deniedPrivate(url.hostname, "an mDNS name") };
  }

  const unbracketed = host.replace(/^\[/, "").replace(/\]$/, "");
  // PARSED, not sniffed for a colon: an address this cannot expand is not an
  // address it can classify either, and treating it as a literal would skip
  // the resolution that is the only other thing between a name and a private
  // range. `isPrivateIp` is then given the parsed value, never the spelling
  // the caller wrote — `0177.0.0.1`, `2130706433` and `64:ff9b::a9fe:a9fe` all
  // reach the same verdict as `127.0.0.1` and `169.254.169.254`.
  const literal =
    normalizeIpv4(unbracketed) ?? (parseIpv6(unbracketed) === null ? null : unbracketed);
  if (literal !== null) {
    if (!allowPrivate && isPrivateIp(literal)) {
      return {
        ok: false,
        code: "private",
        reason: deniedPrivate(url.hostname, `the private address ${literal}`),
      };
    }
    // A literal IS the address, classified numerically above.
    return { ok: true, url, pinnedIp: literal, resolved: true };
  }

  if (allowPrivate) {
    // The operator opened the private ranges, so a resolution has nothing left
    // to decide — and resolving anyway would break the offline fixture the
    // flag exists for.
    return { ok: true, url, pinnedIp: "", resolved: false };
  }

  let resolved: { readonly address: string; readonly family: number };
  try {
    resolved = await dnsLookupFn(host);
  } catch (err) {
    return {
      ok: false,
      code: "unresolvable",
      reason: `the name "${url.hostname}" did not resolve (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (isPrivateIp(resolved.address)) {
    return {
      ok: false,
      code: "private",
      reason: deniedPrivate(url.hostname, `the private address ${resolved.address}`),
    };
  }
  return { ok: true, url, pinnedIp: resolved.address, resolved: true };
}

// ---------------------------------------------------------------------------
// the dialer
// ---------------------------------------------------------------------------

export type PeerFetch = (req: Request, pinnedIp: string) => Promise<Response>;

/**
 * Dial the vetted IP while keeping the real hostname for the `Host` header and
 * TLS SNI, so virtual hosting and certificate validation still work against
 * the real name. Mirrors `tool-fetch`'s and `tool-chainread`'s dialer rather
 * than re-deriving it.
 *
 * This function is the one place in the package a test never executes, because
 * executing it means opening a socket.
 */
const pinnedFetch: PeerFetch = async (req, pinnedIp) => {
  const original = new URL(req.url);
  const host = original.hostname;
  const unbracketed = host.replace(/^\[/, "").replace(/\]$/, "");
  if (pinnedIp === "" || unbracketed === pinnedIp) return globalThis.fetch(req);

  const pinnedUrl = new URL(original.toString());
  pinnedUrl.hostname = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;
  const headers = new Headers(req.headers);
  headers.set("host", original.port === "" ? host : `${host}:${original.port}`);
  const init: RequestInit & { tls?: { serverName: string } } = {
    method: "GET",
    headers,
    signal: req.signal,
    redirect: "manual",
    tls: { serverName: host },
  };
  return globalThis.fetch(pinnedUrl.toString(), init);
};

let peerFetch: PeerFetch = pinnedFetch;

/**
 * Test seam — `_setFetch(undefined)` restores the production dialer. A suite
 * that sets it must restore it, or the next file in the same bun process
 * inherits the stub.
 */
export function _setFetch(fn: PeerFetch | undefined): void {
  peerFetch = fn ?? pinnedFetch;
}

// ---------------------------------------------------------------------------
// one attempt, and what came of it
// ---------------------------------------------------------------------------

/**
 * What happened when this tool tried to reach one URL.
 *
 * Three kinds, because they are three different facts about a peer:
 * `refused` — no socket was opened, so nothing is known about the peer;
 * `no-answer` — a socket was attempted and nothing came back;
 * `answered` — bytes came back, whatever they say.
 *
 * Recorded as a VALUE at the moment it happens. The classifier downstream
 * reads this record rather than parsing an exception's message, so a reworded
 * error in a library cannot turn "the peer is down" into "the peer is fine".
 */
export type Attempt =
  | {
      readonly kind: "refused";
      readonly url: string;
      readonly code: VetCode;
      readonly reason: string;
    }
  | {
      readonly kind: "no-answer";
      readonly url: string;
      readonly code: "unresolvable" | "transport" | "timeout" | "cancelled";
      readonly reason: string;
    }
  | {
      readonly kind: "answered";
      readonly url: string;
      readonly status: number;
      readonly bytes: number;
      /** Set when the body hit {@link MAX_WELLKNOWN_BYTES} and was cut. */
      readonly truncated: boolean;
      /** A 3xx `Location`, recorded and NOT followed. */
      readonly location?: string;
    };

export type FetchOptions = {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

/** Read a body with a hard cap, aborting the stream once it is exceeded. */
async function readCapped(res: Response): Promise<{ text: string; bytes: number; cut: boolean }> {
  if (res.body === null) return { text: "", bytes: 0, cut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cut = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      if (total > MAX_WELLKNOWN_BYTES) {
        cut = true;
        try {
          await reader.cancel();
        } catch {
          // already aborting
        }
        break;
      }
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
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(merged.slice(0, MAX_WELLKNOWN_BYTES)),
    bytes: total,
    cut,
  };
}

/**
 * Fetch one URL, and say exactly what happened.
 *
 * The two abort sources are kept apart. A deadline this tool set is a fact
 * about the PEER ("nothing came back in time"); the run being cancelled is a
 * fact about US, and reporting it as a silent peer would put a healthy peer in
 * the down column. So the timer sets its own flag and the caller's signal sets
 * another, and the flags decide — never the abort reason's text, which the
 * runtime is free to reword.
 */
export async function fetchOnce(
  rawUrl: string,
  opts: FetchOptions,
): Promise<{ attempt: Attempt; body?: string }> {
  const vet = await vetPeerUrl(rawUrl);
  if (!vet.ok) {
    return vet.code === "unresolvable"
      ? { attempt: { kind: "no-answer", url: rawUrl, code: "unresolvable", reason: vet.reason } }
      : { attempt: { kind: "refused", url: rawUrl, code: vet.code, reason: vet.reason } };
  }

  const ctrl = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new Error("deadline"));
  }, opts.timeoutMs);
  const onOuter = (): void => {
    cancelled = true;
    ctrl.abort(new Error("cancelled"));
  };
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) onOuter();
    else opts.signal.addEventListener("abort", onOuter, { once: true });
  }

  try {
    const req = new Request(vet.url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: ctrl.signal,
    });
    const res = await peerFetch(req, vet.pinnedIp);
    const location =
      res.status >= 300 && res.status < 400
        ? (res.headers.get("location") ?? undefined)
        : undefined;
    const { text, bytes, cut } = await readCapped(res);
    return {
      attempt: {
        kind: "answered",
        url: rawUrl,
        status: res.status,
        bytes,
        truncated: cut,
        ...(location !== undefined ? { location } : {}),
      },
      body: text,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cancelled) {
      return {
        attempt: {
          kind: "no-answer",
          url: rawUrl,
          code: "cancelled",
          reason: "the run was cancelled before this peer answered — nothing was learned about it",
        },
      };
    }
    if (timedOut) {
      return {
        attempt: {
          kind: "no-answer",
          url: rawUrl,
          code: "timeout",
          reason: `no response within ${opts.timeoutMs}ms`,
        },
      };
    }
    return {
      attempt: {
        kind: "no-answer",
        url: rawUrl,
        code: "transport",
        reason: `the connection failed (${message.slice(0, 200)})`,
      },
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuter);
  }
}
