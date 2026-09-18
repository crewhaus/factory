/**
 * Reed–Solomon error correction over GF(256), the field QR codes are defined
 * in: bytes as polynomial coefficients, addition as XOR, and multiplication
 * reduced modulo the primitive polynomial x⁸+x⁴+x³+x²+1 (0x11D).
 *
 * Nothing here is QR-specific beyond that choice of polynomial — the caller
 * supplies the block and the number of check bytes it wants.
 */

/** `GF_EXP[i]` = α^i. Doubled to 512 entries so a log-sum never needs a
 *  modulo: the largest sum of two logs is 254+254 = 508. */
const GF_EXP = new Uint8Array(512);
/** `GF_LOG[x]` = i such that α^i = x. `GF_LOG[0]` is meaningless and never
 *  read — {@link gfMul} short-circuits zero first. */
const GF_LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    // x *= α, i.e. shift left and fold back in on overflow.
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
}

/** Multiply in GF(256). */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

/**
 * The degree-`n` generator polynomial (x−α⁰)(x−α¹)…(x−αⁿ⁻¹), coefficients
 * highest-order first. Recomputed per call; the blocks in one symbol all
 * share a degree, so a caller encoding many blocks should hoist it.
 */
export function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      const coefficient = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ coefficient;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(coefficient, GF_EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

/**
 * The `degree` error-correction codewords for one data block — the remainder
 * of the block's polynomial divided by the generator.
 *
 * Long division carried out in place over a sliding window rather than on a
 * full-length copy of the message, so the cost is O(blockLength × degree)
 * with no allocation per codeword.
 */
export function rsRemainder(data: Uint8Array, degree: number, generator?: Uint8Array): Uint8Array {
  const gen = generator ?? rsGenerator(degree);
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i++) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMul(gen[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}
