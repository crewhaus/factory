/**
 * A byte-mode QR Code encoder (ISO/IEC 18004), with no dependencies.
 *
 * Byte mode only, deliberately. The alternative modes — numeric, alphanumeric
 * and kanji — pay for themselves only with a segmentation optimiser, and the
 * payloads this exists for (`http://<host>:<port>/#t=<hex>`) contain lowercase
 * letters, so the alphanumeric set cannot hold them anyway. Byte mode over
 * UTF-8 encodes every input correctly; the cost is at most one extra version
 * for a payload that happens to be all digits.
 *
 * The pipeline, in order: pick the smallest version that fits → build the bit
 * stream (mode, character count, payload, terminator, pad bytes) → split into
 * Reed–Solomon blocks and interleave them → place the function patterns →
 * walk the data in the spec's zig-zag → score all eight masks and keep the
 * best → write the format (and, from version 7, version) information.
 */
import { rsRemainder } from "./galois";
import {
  EC_FORMAT_BITS,
  EC_ORDER,
  type EcLevel,
  MAX_VERSION,
  MIN_VERSION,
  alignmentCentres,
  dataCodewords,
  ecBlocks,
  ecCodewordsPerBlock,
  totalCodewords,
  versionSize,
} from "./tables";

export type { EcLevel } from "./tables";

/** A finished symbol. `modules[y][x] === true` means a dark module. */
export type QrCode = {
  readonly version: number;
  /** The level actually used, which may exceed the one requested — see
   *  {@link EncodeOptions.boostEcLevel}. */
  readonly ecLevel: EcLevel;
  /** The data mask applied, 0–7. */
  readonly mask: number;
  /** Side length in modules, excluding the quiet zone. */
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
};

export type EncodeOptions = {
  /** Minimum error-correction level. Default `"M"`. */
  readonly ecLevel?: EcLevel;
  /** Smallest version to consider. Default 1. */
  readonly minVersion?: number;
  /** Largest version to consider. Default 40. */
  readonly maxVersion?: number;
  /** Use this mask (0–7) instead of scoring all eight. Tests and oracle
   *  comparisons want this; production callers should not set it. */
  readonly mask?: number;
  /** Raise the EC level as far as the chosen version allows at no cost in
   *  symbol size. Default true — a bigger EC level for the same number of
   *  modules is free damage tolerance, which matters when the symbol is
   *  being photographed off a terminal at an angle. */
  readonly boostEcLevel?: boolean;
};

/** Byte-mode character-count-indicator width. 8 bits through version 9,
 *  16 bits from version 10 — byte mode never uses the 12-bit form that
 *  numeric and alphanumeric modes have. */
function characterCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Mode indicator for byte mode. */
const MODE_BYTE = 0b0100;

/** The two pad codewords, applied alternately once the payload and its
 *  terminator have been padded to a byte boundary. */
const PAD_CODEWORDS = [0xec, 0x11] as const;

/** Bits the payload occupies in a given version, header included. */
function payloadBits(byteLength: number, version: number): number {
  return 4 + characterCountBits(version) + byteLength * 8;
}

/**
 * Encode `text` as a QR symbol.
 *
 * Throws when the payload does not fit the allowed version range at the
 * requested EC level.
 */
export function encodeQr(text: string, options: EncodeOptions = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  const requested = options.ecLevel ?? "M";
  const minVersion = Math.max(MIN_VERSION, options.minVersion ?? MIN_VERSION);
  const maxVersion = Math.min(MAX_VERSION, options.maxVersion ?? MAX_VERSION);
  const forcedMask = options.mask;
  if (
    forcedMask !== undefined &&
    (!Number.isInteger(forcedMask) || forcedMask < 0 || forcedMask > 7)
  ) {
    throw new Error(`qr: mask must be an integer 0..7 (got ${forcedMask})`);
  }

  let version = 0;
  for (let candidate = minVersion; candidate <= maxVersion; candidate++) {
    if (payloadBits(bytes.length, candidate) <= dataCodewords(candidate, requested) * 8) {
      version = candidate;
      break;
    }
  }
  if (version === 0) {
    throw new Error(
      `qr: ${bytes.length} byte(s) do not fit a version ${minVersion}..${maxVersion} symbol at EC level ${requested}`,
    );
  }

  // The symbol size is already committed; spend any slack on error
  // correction rather than leaving it as pad codewords.
  let ecLevel = requested;
  if (options.boostEcLevel !== false) {
    for (const candidate of EC_ORDER) {
      if (EC_ORDER.indexOf(candidate) <= EC_ORDER.indexOf(ecLevel)) continue;
      if (payloadBits(bytes.length, version) <= dataCodewords(version, candidate) * 8) {
        ecLevel = candidate;
      }
    }
  }

  return buildSymbol(interleavedCodewords(bytes, version, ecLevel), version, ecLevel, forcedMask);
}

// ---------------------------------------------------------------------------
// Bit stream → codewords
// ---------------------------------------------------------------------------

/** Data codewords for the payload, padded to the version's full capacity. */
function dataCodewordsFor(bytes: Uint8Array, version: number, ec: EcLevel): Uint8Array {
  const capacityBits = dataCodewords(version, ec) * 8;
  const out = new Uint8Array(capacityBits / 8);
  let written = 0;

  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) {
      if (((value >>> i) & 1) === 1) {
        const index = written >>> 3;
        out[index] = (out[index] ?? 0) | (0x80 >>> (written & 7));
      }
      written++;
    }
  };

  push(MODE_BYTE, 4);
  push(bytes.length, characterCountBits(version));
  for (const byte of bytes) push(byte, 8);
  // Terminator: four zero bits, truncated if the symbol is nearly full.
  push(0, Math.min(4, capacityBits - written));
  // Round up to a whole codeword, then alternate pad bytes to capacity.
  push(0, (8 - (written % 8)) % 8);
  for (let i = 0; written < capacityBits; i++) push(PAD_CODEWORDS[i % 2] ?? 0, 8);

  return out;
}

/**
 * Split the data into its blocks, append each block's error correction, and
 * interleave.
 *
 * Interleaving is what makes a QR code survive a smudge: a burst of damage
 * that destroys a run of adjacent codewords is spread across every block, so
 * each block loses a little rather than one block losing everything. The two
 * block sizes differ by exactly one codeword, and the shorter blocks are the
 * ones missing a codeword in the final data column.
 */
function interleavedCodewords(bytes: Uint8Array, version: number, ec: EcLevel): Uint8Array {
  const data = dataCodewordsFor(bytes, version, ec);
  const blockCount = ecBlocks(version, ec);
  const ecLength = ecCodewordsPerBlock(version, ec);
  const total = totalCodewords(version);
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount) - ecLength;

  const dataBlocks: Uint8Array[] = [];
  const ecBlocksOut: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const length = shortLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocksOut.push(rsRemainder(block, ecLength));
  }

  const out = new Uint8Array(total);
  let written = 0;
  for (let i = 0; i <= shortLength; i++) {
    for (let b = 0; b < blockCount; b++) {
      // The short blocks have nothing in the final data column.
      if (i === shortLength && b < shortBlocks) continue;
      out[written++] = dataBlocks[b]?.[i] ?? 0;
    }
  }
  for (let i = 0; i < ecLength; i++) {
    for (let b = 0; b < blockCount; b++) out[written++] = ecBlocksOut[b]?.[i] ?? 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Module placement
// ---------------------------------------------------------------------------

/** A mutable symbol under construction: the modules, plus which of them are
 *  function patterns and therefore off-limits to data and masking. */
type Canvas = {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];
};

function newCanvas(size: number): Canvas {
  return {
    size,
    modules: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
    reserved: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
  };
}

function setModule(canvas: Canvas, x: number, y: number, dark: boolean): void {
  const row = canvas.modules[y];
  if (row !== undefined && x >= 0 && x < canvas.size) row[x] = dark;
}

function setFunction(canvas: Canvas, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  setModule(canvas, x, y, dark);
  const row = canvas.reserved[y];
  if (row !== undefined) row[x] = true;
}

function reserve(canvas: Canvas, x: number, y: number): void {
  const row = canvas.reserved[y];
  if (row !== undefined && x >= 0 && x < canvas.size) row[x] = true;
}

function isReserved(canvas: Canvas, x: number, y: number): boolean {
  return canvas.reserved[y]?.[x] === true;
}

/** Finder patterns, their separators, timing patterns, alignment patterns,
 *  the dark module, and the reserved format/version areas. */
function drawFunctionPatterns(canvas: Canvas, version: number): void {
  const size = canvas.size;

  // Three finders. The loop runs one module wide of the 7×7 pattern so the
  // white separator is drawn in the same pass.
  for (const [fx, fy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        setFunction(canvas, fx + dx, fy + dy, ring !== 2 && ring <= 3);
      }
    }
  }

  // Timing: the alternating row 6 and column 6, between the separators.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFunction(canvas, i, 6, dark);
    setFunction(canvas, 6, i, dark);
  }

  // Alignment patterns, except the three that would sit on a finder.
  const centres = alignmentCentres(version);
  for (const cy of centres) {
    for (const cx of centres) {
      const onFinder =
        (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
      if (onFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(canvas, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Format information is written after masking, but its cells must be held
  // back from the data walk now.
  for (let i = 0; i < 9; i++) {
    reserve(canvas, i, 8);
    reserve(canvas, 8, i);
  }
  for (let i = 0; i < 8; i++) {
    reserve(canvas, size - 1 - i, 8);
    reserve(canvas, 8, size - 1 - i);
  }
  // The dark module: always set, always at (8, 4·version + 9).
  setFunction(canvas, 8, size - 8, true);

  // Version information, from version 7: two 6×3 blocks beside the
  // top-right and bottom-left finders, least-significant bit first.
  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      setFunction(canvas, a, b, dark);
      setFunction(canvas, b, a, dark);
    }
  }
}

/**
 * Lay the codewords into the symbol.
 *
 * The walk is two modules wide and snakes bottom-to-top then top-to-bottom,
 * starting at the bottom-right corner — and column 6, the vertical timing
 * strip, is not part of the path at all, so the column index steps over it.
 */
function drawCodewords(canvas: Canvas, codewords: Uint8Array): void {
  const size = canvas.size;
  let bit = 0;
  const totalBits = codewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let column = 0; column < 2; column++) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (isReserved(canvas, x, y)) continue;
        // Remainder bits past the last codeword stay light.
        const dark =
          bit < totalBits && (((codewords[bit >>> 3] ?? 0) >>> (7 - (bit & 7))) & 1) === 1;
        setModule(canvas, x, y, dark);
        bit++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/** True where mask `pattern` inverts the module at (x, y). */
export function maskPredicate(pattern: number, x: number, y: number): boolean {
  switch (pattern) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** XOR the mask over every non-function module. Applying it twice restores
 *  the canvas, which is how the scoring loop tries all eight. */
function applyMask(canvas: Canvas, pattern: number): void {
  for (let y = 0; y < canvas.size; y++) {
    const modules = canvas.modules[y];
    const reserved = canvas.reserved[y];
    if (modules === undefined || reserved === undefined) continue;
    for (let x = 0; x < canvas.size; x++) {
      if (reserved[x] === true) continue;
      if (maskPredicate(pattern, x, y)) modules[x] = modules[x] !== true;
    }
  }
}

/** Penalty weights N1–N4 from the spec's mask-evaluation rules. */
const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER_LIKE = 40;
const PENALTY_BALANCE = 10;

/** The 1:1:3:1:1 run that a scanner mistakes for a finder. */
const FINDER_LIKE = [true, false, true, true, true, false, true] as const;

/** A reader over a square module grid; outside the symbol counts as light. */
type Modules = readonly (readonly boolean[])[];

const reader =
  (modules: Modules) =>
  (x: number, y: number): boolean =>
    modules[y]?.[x] === true;

/** Rule 1 — each run of five or more same-colour modules in a row or column
 *  costs 3, plus 1 for every module past the fifth. */
export function penaltyRuns(modules: Modules, size: number): number {
  const dark = reader(modules);
  let penalty = 0;
  for (let i = 0; i < size; i++) {
    let rowRun = 1;
    let columnRun = 1;
    for (let j = 1; j < size; j++) {
      rowRun = dark(j, i) === dark(j - 1, i) ? rowRun + 1 : 1;
      if (rowRun === 5) penalty += PENALTY_RUN;
      else if (rowRun > 5) penalty += 1;
      columnRun = dark(i, j) === dark(i, j - 1) ? columnRun + 1 : 1;
      if (columnRun === 5) penalty += PENALTY_RUN;
      else if (columnRun > 5) penalty += 1;
    }
  }
  return penalty;
}

/** Rule 2 — every 2×2 block of a single colour costs 3. Overlapping blocks
 *  each count, so a solid 3×3 costs four of them. */
export function penaltyBlocks(modules: Modules, size: number): number {
  const dark = reader(modules);
  let penalty = 0;
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const colour = dark(x, y);
      if (colour === dark(x + 1, y) && colour === dark(x, y + 1) && colour === dark(x + 1, y + 1)) {
        penalty += PENALTY_BLOCK;
      }
    }
  }
  return penalty;
}

/** Rule 3 — a 1:1:3:1:1 run with four light modules on either side reads to a
 *  scanner like a finder pattern, and costs 40 wherever it appears in either
 *  orientation. Modules outside the symbol count as light, which is what makes
 *  the pattern penalised at the very edge too. */
export function penaltyFinderLike(modules: Modules, size: number): number {
  const dark = reader(modules);
  const rowAt = (i: number) => (k: number) => (k < 0 || k >= size ? false : dark(k, i));
  const columnAt = (i: number) => (k: number) => (k < 0 || k >= size ? false : dark(i, k));
  let penalty = 0;
  for (let i = 0; i < size; i++) {
    for (const read of [rowAt(i), columnAt(i)]) {
      for (let j = 0; j + FINDER_LIKE.length <= size; j++) {
        if (!FINDER_LIKE.every((want, k) => read(j + k) === want)) continue;
        const lightBefore = [-4, -3, -2, -1].every((k) => !read(j + k));
        const lightAfter = [7, 8, 9, 10].every((k) => !read(j + k));
        if (lightBefore || lightAfter) penalty += PENALTY_FINDER_LIKE;
      }
    }
  }
  return penalty;
}

/**
 * Rule 4 — 10 for every whole 5 % the dark proportion strays from half.
 *
 * `steps` is the smallest k for which the dark ratio sits inside
 * 50 % ± 5(k+1), which is the spec's "distance to the nearer bracketing
 * multiple of five" stated without floating point.
 */
export function penaltyBalance(modules: Modules, size: number): number {
  const dark = reader(modules);
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (dark(x, y)) darkCount++;
  }
  const total = size * size;
  const steps = Math.max(0, Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1);
  return steps * PENALTY_BALANCE;
}

/**
 * Score a masked symbol; lower is better. The sum of the four rules, which
 * penalise long same-colour runs, solid 2×2 blocks, finder-lookalikes, and an
 * overall dark/light imbalance.
 */
export function maskPenalty(modules: Modules, size: number): number {
  return (
    penaltyRuns(modules, size) +
    penaltyBlocks(modules, size) +
    penaltyFinderLike(modules, size) +
    penaltyBalance(modules, size)
  );
}

// ---------------------------------------------------------------------------
// Format and version information
// ---------------------------------------------------------------------------

/** The 15-bit format information: EC level and mask, BCH(15,5)-protected and
 *  XORed with 0x5412 so an all-zero field is never valid. */
export function formatInfoBits(ecLevel: EcLevel, mask: number): number {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return (((data << 10) | remainder) ^ 0x5412) & 0x7fff;
}

/** The 18-bit version information for versions 7 and up: BCH(18,6). */
export function versionInfoBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

/** Write both copies of the format information. */
function drawFormatInfo(canvas: Canvas, ecLevel: EcLevel, mask: number): void {
  const size = canvas.size;
  const bits = formatInfoBits(ecLevel, mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;

  // Copy 1 — around the top-left finder, skipping the timing row/column.
  for (let i = 0; i <= 5; i++) setModule(canvas, 8, i, bit(i));
  setModule(canvas, 8, 7, bit(6));
  setModule(canvas, 8, 8, bit(7));
  setModule(canvas, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setModule(canvas, 14 - i, 8, bit(i));

  // Copy 2 — split between the other two finders.
  for (let i = 0; i < 8; i++) setModule(canvas, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setModule(canvas, 8, size - 15 + i, bit(i));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function buildSymbol(
  codewords: Uint8Array,
  version: number,
  ecLevel: EcLevel,
  forcedMask: number | undefined,
): QrCode {
  const canvas = newCanvas(versionSize(version));
  drawFunctionPatterns(canvas, version);
  drawCodewords(canvas, codewords);

  let mask = forcedMask ?? 0;
  if (forcedMask === undefined) {
    let best = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < 8; candidate++) {
      applyMask(canvas, candidate);
      drawFormatInfo(canvas, ecLevel, candidate);
      const penalty = maskPenalty(canvas.modules, canvas.size);
      if (penalty < best) {
        best = penalty;
        mask = candidate;
      }
      applyMask(canvas, candidate); // XOR is its own inverse
    }
  }
  applyMask(canvas, mask);
  drawFormatInfo(canvas, ecLevel, mask);

  return {
    version,
    ecLevel,
    mask,
    size: canvas.size,
    modules: canvas.modules.map((row) => [...row]),
  };
}
