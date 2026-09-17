/**
 * Hashing.
 *
 * SHA-1/256/384/512 and HMAC come from Web Crypto (`crypto.subtle`), which is
 * present and identical on Bun and on Node 18+. MD5 is implemented here
 * because Web Crypto deliberately does not offer it; it is still needed for
 * reading other people's data — legacy ETags, artifact manifests, UUID v3 —
 * and that is the only reason it exists in this file.
 *
 * MD5 and SHA-1 are broken for any security purpose. Nothing here treats them
 * otherwise, and every tool that exposes them says so.
 */
export type ShaAlgorithm = "sha1" | "sha256" | "sha384" | "sha512";
export type HashAlgorithm = ShaAlgorithm | "md5";

export const SHA_ALGORITHMS: ReadonlyArray<ShaAlgorithm> = ["sha1", "sha256", "sha384", "sha512"];
export const HASH_ALGORITHMS: ReadonlyArray<HashAlgorithm> = ["md5", ...SHA_ALGORITHMS];

/** Algorithms a hash is not to be trusted with, reported alongside every digest. */
export const BROKEN_FOR_SECURITY: ReadonlyArray<HashAlgorithm> = ["md5", "sha1"];

const SUBTLE_NAME: Record<ShaAlgorithm, string> = {
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

/** Digest bytes with any supported algorithm. */
export async function digest(algorithm: HashAlgorithm, bytes: Uint8Array): Promise<Uint8Array> {
  if (algorithm === "md5") return md5(bytes);
  const buffer = await crypto.subtle.digest(SUBTLE_NAME[algorithm], bytes);
  return new Uint8Array(buffer);
}

/**
 * Keyed HMAC. The SHA family only: Web Crypto has no MD5, and an HMAC built
 * on a hash this package implemented by hand is not a thing to hand a caller
 * who is about to verify a webhook signature with it.
 *
 * An empty key is rejected rather than silently accepted, because an empty
 * key is nearly always an unset environment variable.
 */
export async function hmac(
  algorithm: ShaAlgorithm,
  key: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  if (key.length === 0) throw new Error("hmac key is empty — check the secret was actually loaded");
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: { name: SUBTLE_NAME[algorithm] } },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", imported, message);
  return new Uint8Array(signature);
}

// ---------------------------------------------------------------------------
// MD5 (RFC 1321). Straight transcription of the reference algorithm; the test
// file pins it to the RFC's own vectors.

// biome-ignore format: the constant table reads as four rounds of sixteen.
const MD5_K: ReadonlyArray<number> = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

// biome-ignore format: the shift table reads as four rounds of sixteen.
const MD5_S: ReadonlyArray<number> = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function rotateLeft32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

/** MD5 of a byte sequence. 16 bytes out. Not a security primitive. */
export function md5(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  // Message + 0x80 + zero padding to 56 mod 64 + 8 bytes of little-endian length.
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x1_0000_0000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Int32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (f + a + (MD5_K[i] ?? 0) + (words[g] ?? 0)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft32(sum, MD5_S[i] ?? 0)) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

/** Digest length in bytes, for describing a result without measuring it. */
export function digestLength(algorithm: HashAlgorithm): number {
  switch (algorithm) {
    case "md5":
      return 16;
    case "sha1":
      return 20;
    case "sha256":
      return 32;
    case "sha384":
      return 48;
    default:
      return 64;
  }
}
