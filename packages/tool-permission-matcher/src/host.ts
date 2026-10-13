/**
 * A host as the tools that look one up or dial it read it.
 *
 * A recipient that is a bare host — DeliverabilityCheck's domain,
 * WaitForPort's host, a FederationDiscover peer, DnsLookup's name — reaches
 * the same place under other spellings: the IDNA form of a name
 * (`münchen.de` is looked up as `xn--mnchen-3ya.de`, and full-width letters
 * and ideographic dots fold into ASCII ones), and an IPv4 address in any
 * numeric form (`10.5`, `0xa.0.0.5` and `167772165` are all `10.0.0.5`). A
 * deny or ask rule reads these, so it decides on the place the tool reaches
 * rather than on how the call spelled it.
 */
import { withoutTrailingDots } from "./trim";

/** An IPv6 literal that reaches an IPv4 host, as WHATWG writes it: mapped, or NAT64. */
export const IPV4_IN_IPV6 = /^\[(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;

/** One part of a numeric IPv4 address: hex (`0xa`), octal (`012`) or decimal. */
function ipv4Part(part: string): number | undefined {
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
  else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
  else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10);
  else return undefined;
  return Number.isFinite(value) ? value : undefined;
}

/**
 * An IPv4 address written in any of the forms the tools that dial one take:
 * one to four parts, each decimal, octal (`012`) or hex (`0xa`), the last
 * filling the octets that are left, so `10.5`, `0xa.0.0.5` and `167772165`
 * are all `10.0.0.5`. It reads a part as WaitForPort's own parser does: one
 * such as `08`, which is not octal, is decimal. The dotted quad, or
 * `undefined` for anything else.
 */
export function ipv4Address(raw: string): string | undefined {
  const text = raw.trim();
  let dots = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x2e && ++dots > 3) return undefined;
  }
  const values: number[] = [];
  for (const part of text.split(".")) {
    const value = ipv4Part(part);
    if (value === undefined) return undefined;
    values.push(value);
  }
  const last = values.pop() as number;
  if (values.some((v) => v > 255)) return undefined;
  const remaining = 4 - values.length;
  if (last >= 2 ** (8 * remaining)) return undefined;
  for (let i = remaining - 1; i >= 0; i--) values.push(Math.floor(last / 2 ** (8 * i)) % 256);
  return values.join(".");
}

/**
 * A host with nothing around it: not empty, and holding no whitespace,
 * control character or character that would make it a URL's user name,
 * path, query or fragment.
 */
function isBareHost(host: string): boolean {
  if (host === "") return false;
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0x40 || c === 0x2f || c === 0x5c) return false;
    if (c === 0x3f || c === 0x23) return false;
  }
  return true;
}

/**
 * The other spellings of a bare host that a tool which looks it up or dials
 * it reaches, lower-cased: as the WHATWG host parser reads it (IDNA, case,
 * an IPv4 address in any numeric form as its dotted quad, an IPv6 address in
 * its shortest form) without a root dot, as {@link ipv4Address} reads it,
 * and an IPv4-mapped IPv6 address as the IPv4 one. `[]` for a value that is
 * not a bare host: an address, a URL, a path, a number with spaces.
 */
export function hostSpellings(raw: string): string[] {
  const host = raw.trim();
  if (!isBareHost(host)) return [];
  const out: string[] = [];
  const v4 = ipv4Address(host);
  if (v4 !== undefined) out.push(v4);
  // A `:` is only ever an IPv6 address here: in brackets it is one, and
  // `name:port` is no longer a host.
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  let url: URL;
  try {
    url = new URL(`http://${inner.includes(":") ? `[${inner}]` : inner}/`);
  } catch {
    return out;
  }
  if (url.port !== "" || url.pathname !== "/" || url.search !== "" || url.username !== "") {
    return out;
  }
  const name = url.hostname;
  if (name.startsWith("[")) {
    out.push(name.slice(1, -1));
    const mapped = name.match(IPV4_IN_IPV6);
    if (mapped !== null) {
      const hi = Number.parseInt(mapped[1] as string, 16);
      const lo = Number.parseInt(mapped[2] as string, 16);
      out.push(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  } else {
    const bare = withoutTrailingDots(name);
    if (bare !== "") out.push(bare);
  }
  return out;
}
