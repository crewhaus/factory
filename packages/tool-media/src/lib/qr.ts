/**
 * A QR Code encoder, written from ISO/IEC 18004.
 *
 * ## What it does
 *
 * - **Byte mode only.** The payload is encoded as UTF-8 bytes under mode
 *   indicator `0100`. Numeric and alphanumeric modes would pack digits and
 *   uppercase text more densely, but byte mode encodes every input
 *   correctly, and a scanner reads all of them. ECI is not emitted; readers
 *   overwhelmingly treat byte mode as UTF-8, which is what this produces.
 * - **Versions 1 to 10** (21x21 up to 57x57 modules), which is 271 bytes at
 *   error-correction level L. Beyond version 10 the block layout table grows
 *   another 120 rows; rather than carry a table this package cannot
 *   meaningfully test, larger payloads are refused by name.
 * - **All four error-correction levels** — L (~7%), M (~15%), Q (~25%),
 *   H (~30%) — with Reed-Solomon over GF(2^8) modulo 0x11D, block splitting
 *   and interleaving exactly as the standard specifies.
 * - **All eight data masks**, scored with the standard's four penalty rules;
 *   the lowest-penalty mask wins, ties going to the lower mask number. That
 *   makes mask selection a pure function of the payload.
 * - Format information as BCH(15,5) XOR 0x5412, and version information as
 *   BCH(18,6) for versions 7 and up.
 *
 * ## What it does not do
 *
 * Structured Append (splitting one payload across several symbols), Micro QR,
 * Kanji mode, and FNC1/GS1 application indicators. Each of those changes what
 * a scanner does with the result, so none of them is approximated here.
 */
import { MediaFormatError } from "./bytes";

export type EccLevel = "L" | "M" | "Q" | "H";

export const ECC_LEVELS: ReadonlyArray<EccLevel> = Object.freeze(["L", "M", "Q", "H"]);

/** Lowest and highest symbol version this encoder produces. */
export const MIN_VERSION = 1;
export const MAX_VERSION = 10;

/** ECC level to its two-bit format indicator (note: not the L/M/Q/H order). */
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Error-correction codewords per block, by level, for versions 1..10. */
const ECC_CODEWORDS_PER_BLOCK: Record<EccLevel, ReadonlyArray<number>> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};

/** Error-correction block count, by level, for versions 1..10. */
const ECC_BLOCKS: Record<EccLevel, ReadonlyArray<number>> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

// --- GF(2^8) -------------------------------------------------------------

/** Multiply in GF(2^8) modulo the QR primitive polynomial x^8+x^4+x^3+x^2+1. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Coefficients of the degree-`degree` Reed-Solomon generator polynomial. */
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < degree) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The Reed-Solomon remainder — the error-correction codewords for a block. */
export function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ (result[0] as number);
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) {
      result[i] = (result[i] as number) ^ gfMultiply(divisor[i] as number, factor);
    }
  }
  return result;
}

// --- Capacity ------------------------------------------------------------

/** Alignment-pattern centre coordinates for a version, ascending. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = 17 + 4 * version;
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result: number[] = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** Data modules available in a symbol before codewords are laid out. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;
    result -= (25 * count - 10) * count - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (payload plus padding) a version/level pair carries. */
export function dataCodewordCount(version: number, ecc: EccLevel): number {
  const index = version - 1;
  return (
    Math.floor(rawDataModules(version) / 8) -
    (ECC_CODEWORDS_PER_BLOCK[ecc][index] as number) * (ECC_BLOCKS[ecc][index] as number)
  );
}

/**
 * How a version/level pair splits its codewords into blocks. Exported
 * because reversing the interleave — which is what a test that reads a
 * finished symbol back has to do — needs exactly these five numbers.
 */
export function blockLayout(
  version: number,
  ecc: EccLevel,
): {
  rawCodewords: number;
  numBlocks: number;
  blockEccLen: number;
  shortBlockLen: number;
  numShortBlocks: number;
  dataCodewords: number;
} {
  const index = version - 1;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numBlocks = ECC_BLOCKS[ecc][index] as number;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][index] as number;
  return {
    rawCodewords,
    numBlocks,
    blockEccLen,
    shortBlockLen: Math.floor(rawCodewords / numBlocks),
    numShortBlocks: numBlocks - (rawCodewords % numBlocks),
    dataCodewords: rawCodewords - blockEccLen * numBlocks,
  };
}

/** Remainder bits after the last codeword, which stay light. */
export function remainderBits(version: number): number {
  return rawDataModules(version) % 8;
}

/** Payload bytes that fit in this version at this level, in byte mode. */
export function byteCapacity(version: number, ecc: EccLevel): number {
  const countBits = version < 10 ? 8 : 16;
  const available = dataCodewordCount(version, ecc) * 8 - 4 - countBits;
  return Math.max(0, Math.floor(available / 8));
}

/** The smallest version that fits `byteLength` at `ecc`, or `undefined`. */
export function smallestVersion(byteLength: number, ecc: EccLevel): number | undefined {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    if (byteCapacity(version, ecc) >= byteLength) return version;
  }
  return undefined;
}

// --- Bit buffer ----------------------------------------------------------

class BitBuffer {
  private readonly bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toCodewords(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i] === 1) out[i >>> 3] = (out[i >>> 3] as number) | (0x80 >>> (i & 7));
    }
    return out;
  }
}

/** Mode indicator, character count, payload, terminator and pad codewords. */
export function encodeDataCodewords(
  payload: Uint8Array,
  version: number,
  ecc: EccLevel,
): Uint8Array {
  const capacityBits = dataCodewordCount(version, ecc) * 8;
  const countBits = version < 10 ? 8 : 16;
  const buffer = new BitBuffer();
  buffer.append(0b0100, 4);
  buffer.append(payload.length, countBits);
  for (const byte of payload) buffer.append(byte, 8);
  if (buffer.length > capacityBits) {
    throw new MediaFormatError(
      `${payload.length} bytes need ${buffer.length} bits, over version ${version}-${ecc}'s ${capacityBits}`,
    );
  }
  // Terminator: up to four zero bits, then zero-fill to a codeword boundary.
  buffer.append(0, Math.min(4, capacityBits - buffer.length));
  buffer.append(0, (8 - (buffer.length % 8)) % 8);
  const codewords = Array.from(buffer.toCodewords());
  // The standard's pad codewords, alternating, until the block is full.
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return Uint8Array.from(codewords);
}

/** Split into blocks, append each block's ECC, and interleave the result. */
export function addEccAndInterleave(data: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const index = version - 1;
  const numBlocks = ECC_BLOCKS[ecc][index] as number;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][index] as number;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);

  const blocks: Uint8Array[] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.subarray(k, k + dataLen);
    k += dataLen;
    const block = new Uint8Array(shortBlockLen + 1);
    block.set(dat, 0);
    // A short block is padded by one byte here purely so the interleave loop
    // below can index every block alike; that byte is skipped when emitted.
    block.set(rsRemainder(dat, divisor), shortBlockLen + 1 - blockEccLen);
    blocks.push(block);
  }

  const result = new Uint8Array(rawCodewords);
  let at = 0;
  for (let i = 0; i < shortBlockLen + 1; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result[at++] = (blocks[j] as Uint8Array)[i] as number;
      }
    }
  }
  return result;
}

// --- Matrix --------------------------------------------------------------

/** A finished symbol: `modules[row][col]` is true where the module is dark. */
export type QrSymbol = {
  readonly version: number;
  readonly ecc: EccLevel;
  readonly mask: number;
  readonly size: number;
  readonly modules: ReadonlyArray<ReadonlyArray<boolean>>;
};

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  setFunction(row: number, col: number, dark: boolean): void {
    (this.modules[row] as boolean[])[col] = dark;
    (this.reserved[row] as boolean[])[col] = true;
  }

  isDark(row: number, col: number): boolean {
    return (this.modules[row] as boolean[])[col] as boolean;
  }
}

function drawFinder(matrix: Matrix, row: number, col: number): void {
  // The 7x7 finder plus its one-module separator, clipped to the symbol.
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const r = row + dy;
      const c = col + dx;
      if (r < 0 || r >= matrix.size || c < 0 || c >= matrix.size) continue;
      // Chebyshev distance from the centre: 0-1 dark, 2 light, 3 dark,
      // 4 light — the last ring being the mandatory separator.
      const distance = Math.max(Math.abs(dy - 3), Math.abs(dx - 3));
      matrix.setFunction(r, c, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(matrix: Matrix, row: number, col: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      matrix.setFunction(row + dy, col + dx, Math.max(Math.abs(dy), Math.abs(dx)) !== 1);
    }
  }
}

function drawFunctionPatterns(matrix: Matrix, version: number): void {
  const size = matrix.size;
  // Timing patterns, drawn first so the finders overwrite their own corners.
  for (let i = 0; i < size; i++) {
    matrix.setFunction(6, i, i % 2 === 0);
    matrix.setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(matrix, 0, 0);
  drawFinder(matrix, 0, size - 7);
  drawFinder(matrix, size - 7, 0);

  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      // The three corners belong to the finders.
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (!corner) drawAlignment(matrix, positions[i] as number, positions[j] as number);
    }
  }

  // Reserve the format-information modules (written for real later).
  for (let i = 0; i <= 5; i++) matrix.setFunction(i, 8, false);
  matrix.setFunction(7, 8, false);
  matrix.setFunction(8, 8, false);
  matrix.setFunction(8, 7, false);
  for (let i = 9; i < 15; i++) matrix.setFunction(8, 14 - i, false);
  for (let i = 0; i < 8; i++) matrix.setFunction(8, size - 1 - i, false);
  for (let i = 8; i < 15; i++) matrix.setFunction(size - 15 + i, 8, false);
  matrix.setFunction(size - 8, 8, true); // the always-dark module

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = ((version << 12) | rem) >>> 0;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      matrix.setFunction(b, a, dark);
      matrix.setFunction(a, b, dark);
    }
  }
}

function drawFormatBits(matrix: Matrix, ecc: EccLevel, mask: number): void {
  const size = matrix.size;
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (((data << 10) | rem) ^ 0x5412) >>> 0;
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) matrix.setFunction(i, 8, bit(i));
  matrix.setFunction(7, 8, bit(6));
  matrix.setFunction(8, 8, bit(7));
  matrix.setFunction(8, 7, bit(8));
  for (let i = 9; i < 15; i++) matrix.setFunction(8, 14 - i, bit(i));

  for (let i = 0; i < 8; i++) matrix.setFunction(8, size - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) matrix.setFunction(size - 15 + i, 8, bit(i));
  matrix.setFunction(size - 8, 8, true);
}

/**
 * The zigzag codeword walk: two-module-wide columns from the right edge
 * leftwards, alternating upward and downward, skipping the vertical timing
 * column. Exported so a test can walk it back the other way.
 */
export function modulePositions(size: number): Array<[number, number]> {
  const positions: Array<[number, number]> = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern; the pair that would contain
    // it shifts one column left, and every pair after it shifts with it.
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      positions.push([row, right]);
      positions.push([row, right - 1]);
    }
  }
  return positions;
}

function drawCodewords(matrix: Matrix, codewords: Uint8Array): void {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (const [row, col] of modulePositions(matrix.size)) {
    if ((matrix.reserved[row] as boolean[])[col] === true) continue;
    // Any module past the last codeword is a remainder bit, left light.
    const dark =
      bitIndex < totalBits &&
      (((codewords[bitIndex >>> 3] as number) >>> (7 - (bitIndex & 7))) & 1) !== 0;
    (matrix.modules[row] as boolean[])[col] = dark;
    bitIndex++;
  }
}

function applyMask(matrix: Matrix, mask: number): void {
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if ((matrix.reserved[row] as boolean[])[col] === true) continue;
      if (maskAt(mask, row, col)) {
        (matrix.modules[row] as boolean[])[col] = !((matrix.modules[row] as boolean[])[
          col
        ] as boolean);
      }
    }
  }
}

const FINDER_RUN: ReadonlyArray<boolean> = [true, false, true, true, true, false, true];

function hasFinderLike(line: ReadonlyArray<boolean>, at: number): boolean {
  for (let i = 0; i < 7; i++) {
    if (line[at + i] !== FINDER_RUN[i]) return false;
  }
  return true;
}

/** Penalty score under the standard's four rules; lower is better. */
export function penaltyScore(matrix: Matrix): number {
  const size = matrix.size;
  let score = 0;
  const lines: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    lines.push(Array.from({ length: size }, (_, col) => matrix.isDark(row, col)));
  }
  for (let col = 0; col < size; col++) {
    lines.push(Array.from({ length: size }, (_, row) => matrix.isDark(row, col)));
  }

  for (const line of lines) {
    // Rule 1 — runs of five or more identical modules.
    let runLength = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        runLength++;
      } else {
        if (runLength >= 5) score += 3 + (runLength - 5);
        runLength = 1;
      }
    }
    // Rule 3 — the finder-like 1:1:3:1:1 run with four light modules beside
    // it, in either order. Modules past the symbol edge count as light,
    // because that is the quiet zone.
    for (let i = 0; i + 7 <= size; i++) {
      if (!hasFinderLike(line, i)) continue;
      const window = (from: number): boolean[] =>
        Array.from({ length: 4 }, (_, k) => line[from + k] ?? false);
      const clear = (run: boolean[]): boolean => run.every((m) => !m);
      if (clear(window(i - 4)) || clear(window(i + 7))) score += 40;
    }
  }

  // Rule 2 — every 2x2 block of one colour.
  for (let row = 0; row + 1 < size; row++) {
    for (let col = 0; col + 1 < size; col++) {
      const value = matrix.isDark(row, col);
      if (
        matrix.isDark(row, col + 1) === value &&
        matrix.isDark(row + 1, col) === value &&
        matrix.isDark(row + 1, col + 1) === value
      ) {
        score += 3;
      }
    }
  }

  // Rule 4 — how far the dark proportion strays from half.
  let dark = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) if (matrix.isDark(row, col)) dark++;
  }
  // Rule 4 — every whole 5% the dark proportion strays from half, scored in
  // integers so the comparison never depends on floating point.
  const total = size * size;
  const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
  score += k * 10;
  return score;
}

export type EncodeQrOptions = {
  readonly ecc?: EccLevel;
  /** Force a version; otherwise the smallest that fits is chosen. */
  readonly version?: number;
  /** Force a mask 0-7; otherwise the lowest-penalty one is chosen. */
  readonly mask?: number;
};

/** Encode `text` (as UTF-8) into a QR symbol. */
export function encodeQr(text: string, options: EncodeQrOptions = {}): QrSymbol {
  const ecc = options.ecc ?? "M";
  const payload = new TextEncoder().encode(text);
  let version: number;
  if (options.version !== undefined) {
    version = options.version;
    if (version < MIN_VERSION || version > MAX_VERSION) {
      throw new MediaFormatError(
        `version ${version} is outside the ${MIN_VERSION}-${MAX_VERSION} range this encoder supports`,
      );
    }
    if (payload.length > byteCapacity(version, ecc)) {
      throw new MediaFormatError(
        `${payload.length} bytes do not fit version ${version} at level ${ecc} (capacity ${byteCapacity(version, ecc)})`,
      );
    }
  } else {
    const found = smallestVersion(payload.length, ecc);
    if (found === undefined) {
      throw new MediaFormatError(
        `${payload.length} bytes exceed the ${byteCapacity(MAX_VERSION, ecc)}-byte capacity of version ${MAX_VERSION} at level ${ecc}`,
      );
    }
    version = found;
  }

  const codewords = addEccAndInterleave(encodeDataCodewords(payload, version, ecc), version, ecc);
  const size = 17 + 4 * version;

  const build = (mask: number): Matrix => {
    const matrix = new Matrix(size);
    drawFunctionPatterns(matrix, version);
    drawCodewords(matrix, codewords);
    applyMask(matrix, mask);
    drawFormatBits(matrix, ecc, mask);
    return matrix;
  };

  let chosenMask = options.mask;
  let matrix: Matrix;
  if (chosenMask === undefined) {
    let best = Number.POSITIVE_INFINITY;
    let bestMask = 0;
    let bestMatrix = build(0);
    for (let mask = 0; mask < 8; mask++) {
      const candidate = mask === 0 ? bestMatrix : build(mask);
      const score = penaltyScore(candidate);
      if (score < best) {
        best = score;
        bestMask = mask;
        bestMatrix = candidate;
      }
    }
    chosenMask = bestMask;
    matrix = bestMatrix;
  } else {
    if (chosenMask < 0 || chosenMask > 7) {
      throw new MediaFormatError(`mask ${chosenMask} is not one of the eight defined masks`);
    }
    matrix = build(chosenMask);
  }

  return { version, ecc, mask: chosenMask, size, modules: matrix.modules.map((row) => [...row]) };
}

/** Render a symbol as text, one line per row, with a quiet zone. */
export function symbolToText(
  symbol: QrSymbol,
  dark: string,
  light: string,
  quietZone: number,
): string {
  const lines: string[] = [];
  const width = symbol.size + quietZone * 2;
  const blank = light.repeat(width);
  for (let i = 0; i < quietZone; i++) lines.push(blank);
  for (const row of symbol.modules) {
    let line = light.repeat(quietZone);
    for (const module of row) line += module ? dark : light;
    lines.push(line + light.repeat(quietZone));
  }
  for (let i = 0; i < quietZone; i++) lines.push(blank);
  return lines.join("\n");
}
