/**
 * Bytes in, bytes out: the conversions every other module in this package
 * stands on.
 *
 * Everything here works on `Uint8Array` rather than on strings-pretending-to-
 * be-bytes, because the classic encoding bug is a byte sequence that is not
 * valid UTF-8 being round-tripped through a string and silently mangled. The
 * decoders here are strict and say so when input is malformed, rather than
 * substituting U+FFFD and returning something that looks fine.
 *
 * Base64 and hex are implemented directly rather than via `btoa`/`atob`, which
 * are defined over Latin-1 code units and therefore wrong for arbitrary bytes.
 */

const HEX_LOWER = "0123456789abcdef";
const BASE64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Reverse table for base64 decoding; accepts both the standard and URL alphabets. */
const BASE64_REVERSE: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < BASE64_STD.length; i++) m.set(BASE64_STD[i] as string, i);
  m.set("-", 62);
  m.set("_", 63);
  return m;
})();

/** Read one byte with the index-safety the strict compiler wants. */
export function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
}

/** UTF-8 encode. Lone surrogates become U+FFFD, which is what TextEncoder does. */
export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Strict UTF-8 decode: throws on a byte sequence that is not valid UTF-8
 * instead of quietly producing replacement characters. Callers holding
 * arbitrary bytes should ask for hex or base64 instead.
 */
export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Lowercase (or uppercase) hex, with an optional separator between bytes. */
export function bytesToHex(bytes: Uint8Array, uppercase = false, separator = ""): string {
  const out: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = byteAt(bytes, i);
    out[i] = (HEX_LOWER[b >> 4] as string) + (HEX_LOWER[b & 0x0f] as string);
  }
  const joined = out.join(separator);
  return uppercase ? joined.toUpperCase() : joined;
}

/**
 * Parse hex. Whitespace, `:` and `-` separators are tolerated (they are what
 * fingerprints and hexdumps come wrapped in) and a leading `0x` is stripped;
 * anything else is an error naming the offending character.
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0[xX]/, "").replace(/[\s:_-]/g, "");
  if (cleaned.length % 2 !== 0) {
    throw new Error(`hex has an odd number of digits (${cleaned.length}) — a byte is two digits`);
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    const pair = cleaned.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new Error(`"${pair}" at byte ${i} is not a hex digit pair`);
    }
    out[i] = Number.parseInt(pair, 16);
  }
  return out;
}

export type Base64Options = { urlSafe?: boolean; padding?: boolean };

/** Base64 encode, standard or URL alphabet, padding optional. */
export function bytesToBase64(bytes: Uint8Array, options: Base64Options = {}): string {
  const urlSafe = options.urlSafe ?? false;
  const padding = options.padding ?? !urlSafe;
  const alphabet = urlSafe ? BASE64_URL : BASE64_STD;
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = byteAt(bytes, i);
    const b1 = byteAt(bytes, i + 1);
    const b2 = byteAt(bytes, i + 2);
    const remaining = bytes.length - i;
    out += alphabet[b0 >> 2] as string;
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)] as string;
    out +=
      remaining > 1 ? (alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] as string) : padding ? "=" : "";
    out += remaining > 2 ? (alphabet[b2 & 0x3f] as string) : padding ? "=" : "";
  }
  return out;
}

/**
 * Base64 decode. Accepts both alphabets, with or without padding, and
 * tolerates embedded whitespace (PEM bodies and wrapped headers arrive that
 * way). Throws with the offending character on anything else — a caller
 * mistake should be legible, not a silent truncation.
 */
export function base64ToBytes(text: string): Uint8Array {
  const cleaned = text.replace(/[\s\r\n]/g, "").replace(/=+$/, "");
  if (cleaned.length % 4 === 1) {
    throw new Error(`base64 length ${cleaned.length} is impossible — one leftover character`);
  }
  const out = new Uint8Array(Math.floor((cleaned.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i] as string;
    const value = BASE64_REVERSE.get(ch);
    if (value === undefined) {
      throw new Error(`"${ch}" at position ${i} is not a base64 character`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

/** Base64url with no padding — the encoding JWT and WebAuthn use. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes, { urlSafe: true, padding: false });
}

/**
 * Compare two byte sequences without leaking the position of the first
 * difference through timing. Used for signature comparison, where a fast
 * `===` is a real (if modest) oracle.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= byteAt(a, i) ^ byteAt(b, i);
  return diff === 0;
}

export type BinaryEncoding = "utf8" | "hex" | "base64" | "base64url";

/** Decode caller-supplied data in whichever encoding they said it was in. */
export function decodeInput(text: string, encoding: BinaryEncoding): Uint8Array {
  switch (encoding) {
    case "utf8":
      return utf8ToBytes(text);
    case "hex":
      return hexToBytes(text);
    default:
      return base64ToBytes(text);
  }
}

/** Render bytes in whichever encoding the caller asked for. */
export function encodeOutput(bytes: Uint8Array, encoding: BinaryEncoding): string {
  switch (encoding) {
    case "utf8":
      return bytesToUtf8(bytes);
    case "hex":
      return bytesToHex(bytes);
    case "base64":
      return bytesToBase64(bytes);
    default:
      return bytesToBase64Url(bytes);
  }
}
