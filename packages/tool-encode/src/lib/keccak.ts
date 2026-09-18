/**
 * Keccak-256, the hash Ethereum uses.
 *
 * This is NOT SHA3-256. They are the same permutation with different
 * padding — Keccak appends 0x01, the later NIST standard appends 0x06 — and
 * substituting one for the other produces a plausible 32-byte digest that is
 * wrong for every Ethereum purpose: a different function selector, a
 * different address, a different EIP-712 digest. `node:crypto` ships
 * `sha3-256` and not this, which is exactly the trap.
 *
 * Implemented here rather than taken as a dependency because every onchain
 * tool in this repository needs it and a hash is the wrong thing to have two
 * of. It is checked against the published vectors in the tests.
 */

/** Rate for Keccak-256: 1600 bits of state minus twice the 256-bit capacity. */
const RATE_BYTES = 136;
const OUTPUT_BYTES = 32;

/** Round constants ι, as 64-bit values split into low and high halves. */
const RC_LOW = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009,
  0x0000008a, 0x00000088, 0x80008009, 0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003,
  0x00008002, 0x00000080, 0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);
const RC_HIGH = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000,
  0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000,
  0x80000000, 0x80000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);

/** ρ offsets, in lane order. */
const ROTATION = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
/**
 * π lane permutation, as destination index per source lane.
 *
 * Derived from the spec's `B[y][2x+3y] = A[x][y]` with lanes indexed
 * `x + 5y`, which gives `dest = y + 5·((2x+3y) mod 5)`. Several published
 * tables state this transposed, for an implementation that indexes lanes
 * `y + 5x`; using one with the other's θ and χ produces a hash that is
 * self-consistent, looks perfectly random, and matches no known vector.
 */
const PI = [
  0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4,
];

/**
 * The Keccak-f[1600] permutation over 25 lanes of 64 bits.
 *
 * Each lane is two 32-bit words because JavaScript has no unsigned 64-bit
 * integer that is fast to work with; `state[2i]` is the low half and
 * `state[2i+1]` the high half.
 */
/** A typed-array read, narrowed. Every index in the permutation is in range. */
function at(array: Uint32Array, index: number): number {
  return array[index] as number;
}

function keccakF(state: Uint32Array): void {
  const c = new Uint32Array(10);
  const b = new Uint32Array(50);

  for (let round = 0; round < 24; round++) {
    // θ: parity of each column, then a rotated fold back into every lane.
    for (let x = 0; x < 5; x++) {
      const i = x * 2;
      // `at` is the typed-array read narrowed to a number; every index here
      // is in range by construction, and the assertion keeps the permutation
      // readable rather than burying it in non-null operators.
      c[i] =
        at(state, i) ^
        at(state, i + 10) ^
        at(state, i + 20) ^
        at(state, i + 30) ^
        at(state, i + 40);
      c[i + 1] =
        at(state, i + 1) ^
        at(state, i + 11) ^
        at(state, i + 21) ^
        at(state, i + 31) ^
        at(state, i + 41);
    }
    for (let x = 0; x < 5; x++) {
      const leftLow = c[((x + 4) % 5) * 2] as number;
      const leftHigh = c[((x + 4) % 5) * 2 + 1] as number;
      const rightLow = c[((x + 1) % 5) * 2] as number;
      const rightHigh = c[((x + 1) % 5) * 2 + 1] as number;
      // Rotate the right neighbour left by one, across the 64-bit pair.
      const dLow = leftLow ^ (((rightLow << 1) | (rightHigh >>> 31)) >>> 0);
      const dHigh = leftHigh ^ (((rightHigh << 1) | (rightLow >>> 31)) >>> 0);
      for (let y = 0; y < 25; y += 5) {
        const i = (x + y) * 2;
        state[i] = (at(state, i) ^ dLow) >>> 0;
        state[i + 1] = (at(state, i + 1) ^ dHigh) >>> 0;
      }
    }

    // ρ and π: rotate each lane, then move it to its permuted position.
    for (let lane = 0; lane < 25; lane++) {
      const offset = ROTATION[lane] as number;
      const target = PI[lane] as number;
      const low = at(state, lane * 2);
      const high = at(state, lane * 2 + 1);
      if (offset === 0) {
        b[target * 2] = low;
        b[target * 2 + 1] = high;
      } else if (offset < 32) {
        b[target * 2] = ((low << offset) | (high >>> (32 - offset))) >>> 0;
        b[target * 2 + 1] = ((high << offset) | (low >>> (32 - offset))) >>> 0;
      } else if (offset === 32) {
        b[target * 2] = high;
        b[target * 2 + 1] = low;
      } else {
        const shift = offset - 32;
        b[target * 2] = ((high << shift) | (low >>> (32 - shift))) >>> 0;
        b[target * 2 + 1] = ((low << shift) | (high >>> (32 - shift))) >>> 0;
      }
    }

    // χ: the only non-linear step.
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = (y + x) * 2;
        const n1 = (y + ((x + 1) % 5)) * 2;
        const n2 = (y + ((x + 2) % 5)) * 2;
        state[i] = (at(b, i) ^ (~at(b, n1) & at(b, n2))) >>> 0;
        state[i + 1] = (at(b, i + 1) ^ (~at(b, n1 + 1) & at(b, n2 + 1))) >>> 0;
      }
    }

    // ι: break the round symmetry.
    state[0] = (at(state, 0) ^ at(RC_LOW, round)) >>> 0;
    state[1] = (at(state, 1) ^ at(RC_HIGH, round)) >>> 0;
  }
}

/** Keccak-256 of some bytes. */
export function keccak256(input: Uint8Array): Uint8Array {
  const state = new Uint32Array(50);
  const blocks = Math.floor(input.length / RATE_BYTES);

  const absorb = (chunk: Uint8Array): void => {
    for (let i = 0; i < RATE_BYTES; i += 4) {
      const word =
        (chunk[i] as number) |
        ((chunk[i + 1] as number) << 8) |
        ((chunk[i + 2] as number) << 16) |
        ((chunk[i + 3] as number) << 24);
      state[i / 4] = (at(state, i / 4) ^ word) >>> 0;
    }
    keccakF(state);
  };

  for (let b = 0; b < blocks; b++) {
    absorb(input.subarray(b * RATE_BYTES, (b + 1) * RATE_BYTES));
  }

  // Pad10*1 with Keccak's 0x01 domain byte — NOT SHA-3's 0x06.
  const tail = new Uint8Array(RATE_BYTES);
  tail.set(input.subarray(blocks * RATE_BYTES));
  tail[input.length - blocks * RATE_BYTES] = 0x01;
  tail[RATE_BYTES - 1] = (tail[RATE_BYTES - 1] as number) | 0x80;
  absorb(tail);

  const out = new Uint8Array(OUTPUT_BYTES);
  for (let i = 0; i < OUTPUT_BYTES; i += 4) {
    const word = at(state, i / 4);
    out[i] = word & 0xff;
    out[i + 1] = (word >>> 8) & 0xff;
    out[i + 2] = (word >>> 16) & 0xff;
    out[i + 3] = (word >>> 24) & 0xff;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Keccak-256 of a UTF-8 string, as lowercase hex without a 0x prefix. */
export function keccak256Hex(text: string): string {
  return toHex(keccak256(new TextEncoder().encode(text)));
}
