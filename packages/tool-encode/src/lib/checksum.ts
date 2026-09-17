/**
 * Non-cryptographic checksums: CRC-32 and Adler-32.
 *
 * These answer "did these bytes change in transit or on disk", which is a
 * different question from "did someone tamper with these bytes". Both are
 * trivially forgeable; use a hash for the second question. They earn their
 * place because they are what zip, gzip, PNG and zlib actually store, so
 * reading or producing those formats means computing exactly these.
 */
import { byteAt } from "./bytes";

/** CRC-32 (IEEE 802.3 polynomial 0xEDB88320, reflected), as used by zip/gzip/PNG. */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const index = (crc ^ byteAt(bytes, i)) & 0xff;
    crc = (crc >>> 8) ^ (CRC32_TABLE[index] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Adler-32 (RFC 1950), as used by zlib. Weaker than CRC-32 on short inputs. */
export function adler32(bytes: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  // 5552 is the largest block that cannot overflow a 32-bit accumulator.
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(start + 5552, bytes.length);
    for (let i = start; i < end; i++) {
      a += byteAt(bytes, i);
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

export type ChecksumAlgorithm = "crc32" | "adler32";

export const CHECKSUM_ALGORITHMS: ReadonlyArray<ChecksumAlgorithm> = ["crc32", "adler32"];

export function checksum(algorithm: ChecksumAlgorithm, bytes: Uint8Array): number {
  return algorithm === "crc32" ? crc32(bytes) : adler32(bytes);
}

/** The eight-digit lowercase hex these checksums are conventionally written in. */
export function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
