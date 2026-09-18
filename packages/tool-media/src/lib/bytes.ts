/**
 * Byte-level primitives shared by every format reader in this package.
 *
 * Two rules hold everywhere below. First, a read that runs off the end of
 * the buffer throws `MediaFormatError` rather than returning a silently
 * wrong number — a truncated file must be reported as truncated, never
 * decoded as if the missing bytes were zeroes. Second, nothing here
 * allocates on behalf of a length the file itself supplied without that
 * length having been checked against a cap first.
 */

/** Raised when bytes do not say what the format says they should. */
export class MediaFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaFormatError";
  }
}

/** A bounds-checked cursor over a byte buffer, big- or little-endian. */
export class ByteReader {
  readonly bytes: Uint8Array;
  private pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.length) {
      throw new MediaFormatError(
        `seek to ${offset} is outside the ${this.bytes.length}-byte buffer`,
      );
    }
    this.pos = offset;
  }

  skip(count: number): void {
    this.seek(this.pos + count);
  }

  private need(count: number): void {
    if (this.pos + count > this.bytes.length) {
      throw new MediaFormatError(
        `truncated: wanted ${count} byte(s) at offset ${this.pos}, only ${this.remaining} left`,
      );
    }
  }

  u8(): number {
    this.need(1);
    const v = this.bytes[this.pos] as number;
    this.pos += 1;
    return v;
  }

  u16be(): number {
    this.need(2);
    const v = ((this.bytes[this.pos] as number) << 8) | (this.bytes[this.pos + 1] as number);
    this.pos += 2;
    return v;
  }

  u16le(): number {
    this.need(2);
    const v = (this.bytes[this.pos] as number) | ((this.bytes[this.pos + 1] as number) << 8);
    this.pos += 2;
    return v;
  }

  u32be(): number {
    this.need(4);
    const b = this.bytes;
    const v =
      (b[this.pos] as number) * 0x1000000 +
      (((b[this.pos + 1] as number) << 16) |
        ((b[this.pos + 2] as number) << 8) |
        (b[this.pos + 3] as number));
    this.pos += 4;
    return v;
  }

  u32le(): number {
    this.need(4);
    const b = this.bytes;
    const low =
      (b[this.pos] as number) |
      ((b[this.pos + 1] as number) << 8) |
      ((b[this.pos + 2] as number) << 16);
    const v = (low >>> 0) + (b[this.pos + 3] as number) * 0x1000000;
    this.pos += 4;
    return v;
  }

  i32le(): number {
    const v = this.u32le();
    return v >= 0x80000000 ? v - 0x100000000 : v;
  }

  /** `count` bytes as a subarray of the SAME backing store — no copy. */
  take(count: number): Uint8Array {
    this.need(count);
    const out = this.bytes.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }

  /** ASCII of the next `count` bytes; non-ASCII becomes `?`. */
  ascii(count: number): string {
    const raw = this.take(count);
    let out = "";
    for (const byte of raw) out += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "?";
    return out;
  }
}

/** True when `bytes` begins with `prefix`. */
export function startsWith(bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/** True when the ASCII of `bytes[at..]` equals `text`. */
export function asciiAt(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Uppercase hex of a byte run, for hashes and magic-byte reporting. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32/ISO-HDLC, as PNG chunks and ZIP entries both use it. */
export function crc32(...parts: ReadonlyArray<Uint8Array>): number {
  let c = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Concatenate byte runs into one fresh buffer. */
export function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
