/**
 * IP addresses as bytes: loopback, and CIDR membership for a trusted proxy's peers. Pure.
 * An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is read as the IPv4 address it carries,
 * so a dual-stack listener's peer matches an IPv4 rule.
 */

export type ParsedIp = { readonly family: 4 | 6; readonly bytes: Uint8Array };

const IPV4_PART_RE = /^(?:0|[1-9][0-9]{0,2})$/;

function parseIpv4(text: string): Uint8Array | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (const [i, part] of parts.entries()) {
    if (!IPV4_PART_RE.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6(text: string): Uint8Array | undefined {
  let body = text;
  const zone = body.indexOf("%");
  if (zone !== -1) body = body.slice(0, zone);
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  if (body === "" || !/^[0-9A-Fa-f:.]+$/.test(body)) return undefined;
  const halves = body.split("::");
  if (halves.length > 2) return undefined;
  const groupsOf = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (const [i, piece] of pieces.entries()) {
      if (piece.includes(".")) {
        if (i !== pieces.length - 1) return undefined;
        const v4 = parseIpv4(piece);
        if (v4 === undefined) return undefined;
        out.push(
          ((v4[0] as number) << 8) | (v4[1] as number),
          ((v4[2] as number) << 8) | (v4[3] as number),
        );
        continue;
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(piece)) return undefined;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };
  const head = groupsOf(halves[0] as string);
  const tail = halves.length === 2 ? groupsOf(halves[1] as string) : [];
  if (head === undefined || tail === undefined) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  for (const [i, group] of groups.entries()) {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function isMappedV4(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/** An address as bytes, an IPv4-mapped IPv6 address as its IPv4 address; `undefined` when unreadable. */
export function parseIp(text: string | null | undefined): ParsedIp | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  const v4 = parseIpv4(text);
  if (v4 !== undefined) return { family: 4, bytes: v4 };
  const v6 = parseIpv6(text);
  if (v6 === undefined) return undefined;
  if (isMappedV4(v6)) return { family: 4, bytes: v6.slice(12) };
  return { family: 6, bytes: v6 };
}

/**
 * Whether an address is this computer's own: `127.0.0.0/8`, `::1` in every spelling, and
 * `::ffff:127.x.y.z`. `null` (a request that did not arrive over TCP) is not.
 *
 * First consumer: `authenticate`, which accepts Home's own key over TCP only from here.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  const ip = parseIp(address);
  if (ip === undefined) return false;
  if (ip.family === 4) return ip.bytes[0] === 127;
  for (let i = 0; i < 15; i++) if (ip.bytes[i] !== 0) return false;
  return ip.bytes[15] === 1;
}

export type Cidr = { readonly family: 4 | 6; readonly bytes: Uint8Array; readonly bits: number };

/**
 * `10.0.0.0/8`, `fd00::/8`, or a bare address (all its bits). `undefined` when unreadable.
 *
 * First consumer: Home's settings reader, which refuses a trusted proxy whose peers are not CIDR blocks.
 */
export function parseCidr(text: string): Cidr | undefined {
  const slash = text.indexOf("/");
  const ip = parseIp(slash === -1 ? text : text.slice(0, slash));
  if (ip === undefined) return undefined;
  const max = ip.family === 4 ? 32 : 128;
  // A mapped address given with an IPv6 prefix length counts its IPv4 bits.
  let bits = max;
  if (slash !== -1) {
    const raw = text.slice(slash + 1);
    if (!/^[0-9]{1,3}$/.test(raw)) return undefined;
    bits = Number(raw);
    const given = text.slice(0, slash).includes(":") && ip.family === 4 ? bits - 96 : bits;
    if (given < 0 || given > max) return undefined;
    bits = given;
  }
  return { family: ip.family, bytes: ip.bytes, bits };
}

/**
 * Whether `address` lies inside `cidr`.
 *
 * First consumer: `authenticate`, for a trusted proxy's listed peers.
 */
export function cidrContains(cidr: Cidr, address: string | null | undefined): boolean {
  const ip = parseIp(address);
  if (ip === undefined || ip.family !== cidr.family) return false;
  let bits = cidr.bits;
  for (let i = 0; i < ip.bytes.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((ip.bytes[i] as number) & mask) !== ((cidr.bytes[i] as number) & mask)) return false;
  }
  return true;
}
