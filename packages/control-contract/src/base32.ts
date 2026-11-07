/**
 * Lowercase Crockford base32. Its alphabet has no `-` and no `_`, so an encoded
 * value can never form the keyed-opaque shapes Hangar's masker rewrites.
 */

export const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

const VALUE_OF: ReadonlyMap<string, number> = new Map(
  Array.from(CROCKFORD, (char, index) => [char, index] as const),
);

export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/** The bytes, or `null` for a character outside the alphabet or stray padding bits. */
export function decodeBase32(text: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = VALUE_OF.get(char);
    if (value === undefined) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits >= 5 || buffer !== 0) return null;
  return out;
}
