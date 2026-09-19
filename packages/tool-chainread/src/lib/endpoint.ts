/**
 * Which endpoints this package is willing to dial.
 *
 * Every other networked package here — `tool-registry`, `tool-containers` —
 * builds its URLs from constants, so a model never picks a host. This one
 * cannot: reading a chain the caller names means the caller names the RPC URL,
 * and an unguarded `fetch(input.rpcUrl)` is a server-side request forgery
 * primitive with a model holding the steering wheel. `http://169.254.169.254/`
 * is the cloud metadata service; `http://127.0.0.1:6379/` is somebody's Redis.
 *
 * So the host is vetted before the socket opens, the vetted IP is what gets
 * dialled (resolving here and letting `fetch` re-resolve at connect time is a
 * DNS-rebinding TOCTOU), and the loopback/private ranges are refused unless an
 * OPERATOR opened them — `setRpcEndpointPolicy` is bound at boot by the
 * runtime, exactly like `setEvmAdapterResolver` in `tool-evm`. It is
 * deliberately not a field in any tool's input schema: a gate a model can open
 * for itself is not a gate.
 *
 * This is a narrower guard than `@crewhaus/tool-fetch`'s `assertNotSsrf`, which
 * is the repo's canonical one and is not a dependency of this package. What is
 * here covers the same ground for this package's one shape of request — a
 * single origin, no redirects followed, no credentials attached — and the
 * README says so rather than implying parity.
 */
import { CrewhausError } from "@crewhaus/errors";

export class RpcEndpointError extends CrewhausError {
  override readonly name = "RpcEndpointError";
  constructor(message: string) {
    super("tool", message);
  }
}

/** What the runtime may loosen at boot. Nothing here is reachable from a tool's input. */
export type RpcEndpointPolicy = {
  /**
   * Permit loopback and private-range endpoints. A local anvil or hardhat node
   * at `http://127.0.0.1:8545` is the reason this exists, and it is the whole
   * reason it is off by default: that address is also every unauthenticated
   * service on the box the agent happens to be running on.
   */
  readonly allowPrivateHosts?: boolean;
  /**
   * When set, the ONLY origins that may be dialled, e.g.
   * `["https://mainnet.base.org"]`. An operator that knows its endpoints should
   * set this; it turns the guard from a deny-list into an allow-list.
   */
  readonly allowedOrigins?: ReadonlyArray<string>;
};

let policy: RpcEndpointPolicy = {};

/** Bind the endpoint policy at boot. Generated daemons call this before registering the tools. */
export function setRpcEndpointPolicy(next: RpcEndpointPolicy): void {
  policy = next;
}

/** Read the policy back — for `EvmRpcHealth`, which reports the posture it is operating under. */
export function getRpcEndpointPolicy(): RpcEndpointPolicy {
  return policy;
}

export type DnsLookupFn = (
  host: string,
) => Promise<{ readonly address: string; readonly family: number }>;

/**
 * Resolution seam. Production uses `node:dns/promises`; every test in this
 * package replaces it, so the suite never sends a DNS query and never opens a
 * socket — which is the point, because CI has no egress.
 */
const defaultDnsLookup: DnsLookupFn = async (host) => {
  const dns = await import("node:dns/promises");
  return dns.lookup(host, { verbatim: false });
};

let dnsLookupFn: DnsLookupFn = defaultDnsLookup;

export function _setDnsLookup(fn: DnsLookupFn | undefined): void {
  dnsLookupFn = fn ?? defaultDnsLookup;
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

export type VettedEndpoint = {
  readonly url: URL;
  /** The address the socket must go to. Empty when there is nothing to pin. */
  readonly pinnedIp: string;
};

/**
 * Validate an RPC URL and resolve the address to pin the connection to.
 *
 * Throws `RpcEndpointError` for everything a caller could have got wrong, with
 * the reason in the message, because every one of these is a refusal a model
 * should read and act on rather than retry.
 */
export async function vetEndpoint(rawUrl: string): Promise<VettedEndpoint> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RpcEndpointError(`"${rawUrl}" is not a URL`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RpcEndpointError(
      `refusing scheme "${url.protocol.replace(":", "")}" — an RPC endpoint is http(s); a websocket is a different transport this package does not speak`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    // A provider key belongs in the path (Alchemy, Infura) or a header, not in
    // userinfo, which lands in logs and in any error message quoting the URL.
    throw new RpcEndpointError(
      "refusing a URL with credentials in it — strip the user:password@ and put the provider key in the path",
    );
  }

  const allowed = policy.allowedOrigins;
  if (allowed !== undefined && !allowed.includes(url.origin)) {
    throw new RpcEndpointError(
      `refusing "${url.origin}" — the operator's rpc allow-list is ${allowed.length === 0 ? "empty" : allowed.join(", ")}`,
    );
  }

  const host = url.hostname.toLowerCase();
  const allowPrivate = policy.allowPrivateHosts === true;

  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost"))) {
    throw new RpcEndpointError(deniedPrivate(url.hostname, "loopback"));
  }
  if (!allowPrivate && host.endsWith(".local")) {
    throw new RpcEndpointError(deniedPrivate(url.hostname, "an mDNS name"));
  }

  const unbracketed = host.replace(/^\[/, "").replace(/\]$/, "");
  // Parsed, not sniffed for a colon: an address this cannot expand is not an
  // address it can classify either, and treating it as a literal would skip the
  // resolution that is the only other thing standing between a name and a
  // private range.
  const literal =
    normalizeIpv4(unbracketed) ?? (parseIpv6(unbracketed) === null ? null : unbracketed);
  if (literal !== null) {
    if (!allowPrivate && isPrivateIp(literal)) {
      throw new RpcEndpointError(deniedPrivate(url.hostname, `the private address ${literal}`));
    }
    return { url, pinnedIp: literal };
  }

  if (allowPrivate) {
    // The operator opened the private ranges, so a resolution has nothing left
    // to decide — and resolving anyway would break the offline devnet case the
    // flag exists for.
    return { url, pinnedIp: "" };
  }

  let resolved: { readonly address: string; readonly family: number };
  try {
    resolved = await dnsLookupFn(host);
  } catch (err) {
    throw new RpcEndpointError(
      `cannot resolve "${url.hostname}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (isPrivateIp(resolved.address)) {
    throw new RpcEndpointError(
      deniedPrivate(url.hostname, `the private address ${resolved.address}`),
    );
  }
  return { url, pinnedIp: resolved.address };
}

function deniedPrivate(host: string, what: string): string {
  return `refusing to dial "${host}" — it is ${what}, and reaching one from a model-supplied URL is how an agent ends up reading a metadata service or an unauthenticated local port. An operator can permit it with setRpcEndpointPolicy({ allowPrivateHosts: true }) for a local devnet.`;
}
