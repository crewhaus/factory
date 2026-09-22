/**
 * The two ISO/IEC 18004 tables that cannot be derived, plus the capacity
 * arithmetic that can.
 *
 * Most QR implementations carry a 160-row block table (version × EC level →
 * total codewords, blocks, data codewords per block). Three of those four
 * columns are derivable, and every derived column is one fewer row to
 * mistype — so only `EC_CODEWORDS_PER_BLOCK` and `EC_BLOCKS` are transcribed
 * here, and {@link totalCodewords} computes the rest from the symbol's own
 * geometry. The transcription is pinned by tests that check every version
 * against the spec's published data capacities.
 */

/** Error-correction level. Higher levels survive more damage and carry less
 *  data in the same symbol: L ≈ 7 %, M ≈ 15 %, Q ≈ 25 %, H ≈ 30 %. */
export type EcLevel = "L" | "M" | "Q" | "H";

/** Weakest → strongest. The order EC levels are *boosted* along, and NOT the
 *  order they are numbered in the format-information field. */
export const EC_ORDER: readonly EcLevel[] = ["L", "M", "Q", "H"];

/** The 2-bit EC value written into the format information. Deliberately not
 *  the L<M<Q<H ordinal — the spec numbers them M=0, L=1, H=2, Q=3, and
 *  swapping the two is the classic "scans on no phone" bug. */
export const EC_FORMAT_BITS: Readonly<Record<EcLevel, number>> = { M: 0, L: 1, H: 2, Q: 3 };

/** Smallest and largest symbol versions (21×21 up to 177×177). */
export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

/** Error-correction codewords per block, indexed `[level][version]`.
 *  Index 0 is unused so the array is indexed by version directly. */
const EC_CODEWORDS_PER_BLOCK: Readonly<Record<EcLevel, readonly number[]>> = {
  L: [
    0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  M: [
    0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  Q: [
    0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
    30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  H: [
    0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
};

/** Number of error-correction blocks, indexed `[level][version]`. */
const EC_BLOCKS: Readonly<Record<EcLevel, readonly number[]>> = {
  L: [
    0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  M: [
    0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
    26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  Q: [
    0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  H: [
    0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37,
    40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
};

/** Indexed read that satisfies `noUncheckedIndexedAccess` without an
 *  assertion; every caller has already validated the version. */
function row(list: readonly number[], version: number): number {
  return list[version] ?? 0;
}

export function ecCodewordsPerBlock(version: number, ec: EcLevel): number {
  return row(EC_CODEWORDS_PER_BLOCK[ec], version);
}

export function ecBlocks(version: number, ec: EcLevel): number {
  return row(EC_BLOCKS[ec], version);
}

/** A symbol's side length in modules. */
export function versionSize(version: number): number {
  return version * 4 + 17;
}

/**
 * Modules a symbol has left for data and error correction, i.e. every module
 * that is not a function pattern.
 *
 * The closed form is the spec's own function-pattern accounting: the full
 * area, less the three 8×8 finder-plus-separator corners, the two timing
 * strips, the alignment patterns (and the two they overlap with timing), and
 * — from version 7 — the two version-information blocks.
 */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    result -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data + EC codewords a version holds. The floor matters: versions 2–6 and
 *  14–20 (among others) end with 3–7 remainder bits that carry nothing. */
export function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

/** Codewords left for the payload once error correction has taken its share. */
export function dataCodewords(version: number, ec: EcLevel): number {
  return totalCodewords(version) - ecCodewordsPerBlock(version, ec) * ecBlocks(version, ec);
}

/**
 * Alignment-pattern centre coordinates for a version, in ascending order.
 *
 * Version 1 has none. Otherwise the first centre is always row/column 6 and
 * the last is always `size - 7`; the ones between are spaced by an even step
 * measured from the far edge inward, which is why the FIRST gap is the one
 * allowed to be narrower than the rest.
 */
export function alignmentCentres(version: number): readonly number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = versionSize(version);
  // Even spacing, rounded up to an even number of modules — except at
  // version 32, the one version where that arithmetic disagrees with the
  // spec's published table (it yields 28 where the table says 26). The
  // exception is in the standard, not a workaround for it.
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const centres: number[] = [6];
  for (let pos = size - 7; centres.length < count; pos -= step) centres.splice(1, 0, pos);
  centres.sort((a, b) => a - b);
  return centres;
}
