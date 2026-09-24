/**
 * What WaitForPort may dial (C144).
 *
 * WaitForPort is read-only, so plan and auto mode run it unasked, and it
 * used to connect() to any host a call named: the cloud metadata address,
 * the LAN, any port on loopback in an inet_aton spelling — a port-scan
 * oracle, and a DNS query for any name the model chose. Its purpose is
 * waiting for a server the harness just started, which is loopback. So
 * loopback is allowed without configuration, and anything else only when
 * the operator lists it in `tool_config.proc.wait_for_port_hosts`.
 *
 * Addresses are classified NUMERICALLY by the repository's shared
 * private-address classifier, carried here as the byte-identical block
 * apps/cli/src/tool-registry.test.ts hashes across every copy (so
 * `0x7f.1`, `2130706433` and `::ffff:127.0.0.1` are all loopback, and
 * `::ffff:169.254.169.254` is link-local).
 */

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

/** True for 127.0.0.0/8, ::1, and a v6 spelling that carries a 127/8 address. */
export function isLoopbackIp(address: string): boolean {
  const v4 = normalizeIpv4(address);
  if (v4 !== null) return v4.startsWith("127.");
  const groups = parseIpv6(address);
  if (groups === null) return false;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  const carried = embeddedIpv4(groups);
  return carried !== null && carried.startsWith("127.");
}

/**
 * True for link-local addresses, where cloud metadata services live:
 * 169.254.0.0/16, fe80::/10, AWS's fd00:ec2::254, and a v6 spelling that
 * carries a 169.254/16 address.
 */
export function isLinkLocalIp(address: string): boolean {
  const v4 = normalizeIpv4(address);
  if (v4 !== null) return v4.startsWith("169.254.");
  const groups = parseIpv6(address);
  if (groups === null) return false;
  const carried = embeddedIpv4(groups);
  if (carried !== null) return carried.startsWith("169.254.");
  if (((groups[0] as number) & 0xffc0) === 0xfe80) return true;
  const ec2 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254];
  return groups.every((g, i) => g === ec2[i]);
}

/** The canonical spelling of an IP literal (dotted quad, or v6 as written), or null. */
export function canonicalIp(address: string): string | null {
  const v4 = normalizeIpv4(address);
  if (v4 !== null) return v4;
  return parseIpv6(address) === null ? null : address.toLowerCase();
}

// ---------------------------------------------------------------------------
// the WaitForPort gate

export type DnsLookup = (host: string) => Promise<ReadonlyArray<string>>;

const systemLookup: DnsLookup = async (host) => {
  const { lookup } = await import("node:dns/promises");
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

let dnsLookup: DnsLookup = systemLookup;

/** Test seam: replace the resolver; `undefined` restores the system one. */
export function _setDnsLookup(fn: DnsLookup | undefined): void {
  dnsLookup = fn ?? systemLookup;
}

export type PortTarget =
  | { readonly ok: true; readonly dial: string }
  | { readonly ok: false; readonly message: string };

/**
 * Decide what one WaitForPort call dials for `host`, or why it may not.
 *
 * - `localhost`, and any IP literal that is loopback in any spelling, is
 *   allowed with no configuration and no DNS (a literal is dialled in its
 *   canonical form, so `0x7f.1` dials 127.0.0.1).
 * - Any other host must be listed in `allowed` (the operator's
 *   `tool_config.proc.wait_for_port_hosts`), and is refused BEFORE any DNS
 *   query, so an unlisted name is not a way to send one either.
 * - A listed NAME is resolved once, and the address is what is dialled for
 *   every probe, so a resolver that answers differently later cannot move the
 *   probe. A name that resolves to a link-local address (the cloud metadata
 *   service) is refused unless that address itself is listed.
 */
export async function portTarget(
  host: string,
  allowed: ReadonlyArray<string>,
  configKey: string,
): Promise<PortTarget> {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "localhost.") return { ok: true, dial: "localhost" };
  const literal = canonicalIp(host);
  if (literal !== null && isLoopbackIp(host)) return { ok: true, dial: literal };
  const listed = allowed.includes(lower) || (literal !== null && allowed.includes(literal));
  if (!listed) {
    return {
      ok: false,
      message: `[WaitForPort error] "${host}" is not a loopback address. WaitForPort probes loopback (localhost, 127.0.0.1, ::1) unless the operator lists the host in ${configKey}.`,
    };
  }
  if (literal !== null) return { ok: true, dial: literal };
  let answers: ReadonlyArray<string>;
  try {
    answers = await dnsLookup(host);
  } catch {
    answers = [];
  }
  const first = answers[0];
  if (first === undefined) {
    return { ok: false, message: `[WaitForPort error] "${host}" does not resolve.` };
  }
  for (const address of answers) {
    const canonical = canonicalIp(address) ?? address.toLowerCase();
    if (isLinkLocalIp(address) && !allowed.includes(canonical)) {
      return {
        ok: false,
        message: `[WaitForPort error] "${host}" resolves to a link-local address, where cloud metadata services live; list that address itself in ${configKey} to probe it.`,
      };
    }
  }
  return { ok: true, dial: canonicalIp(first) ?? first };
}
