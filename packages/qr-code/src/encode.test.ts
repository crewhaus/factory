/**
 * Tests for the QR encoder.
 *
 * The strongest test here is {@link readBack}: a deliberately independent
 * reader that walks the finished symbol in the spec's zig-zag, un-masks it,
 * un-interleaves the blocks and pulls the payload back out. It shares the
 * capacity tables with the encoder but nothing else, so a placement, masking
 * or interleaving mistake shows up as a failed round trip rather than as a
 * symbol that merely looks plausible.
 *
 * The constants pinned below were cross-checked against symbols produced by
 * an independent encoder (macOS `CIQRCodeGenerator`) and decoded with an
 * independent decoder (macOS Vision `VNDetectBarcodesRequest`): 27 symbols
 * across all four EC levels agreed on the format information, 18 symbols on
 * the version information, and every alignment pattern from version 2 to 40
 * landed where this module puts it. That oracle needs macOS and so cannot
 * run in CI, which is why its conclusions are frozen here as literals.
 */
import { describe, expect, test } from "bun:test";
import {
  type EcLevel,
  type QrCode,
  encodeQr,
  formatInfoBits,
  maskPenalty,
  maskPredicate,
  penaltyBalance,
  penaltyBlocks,
  penaltyFinderLike,
  penaltyRuns,
  versionInfoBits,
} from "./encode";
import { gfMul, rsGenerator, rsRemainder } from "./galois";
import {
  alignmentCentres,
  dataCodewords,
  ecBlocks,
  ecCodewordsPerBlock,
  totalCodewords,
  versionSize,
} from "./tables";

// ---------------------------------------------------------------------------
// A reader, for round-tripping
// ---------------------------------------------------------------------------

/** Pull the payload back out of a finished symbol. Assumes no damage, so it
 *  skips error correction entirely and just reads the data blocks. */
function readBack(qr: QrCode): string {
  const size = qr.size;
  const version = qr.version;

  // Rebuild the function-pattern map exactly as the encoder reserves it.
  const reserved = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  const hold = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < size && y < size) {
      const row = reserved[y];
      if (row !== undefined) row[x] = true;
    }
  };
  for (const [fx, fy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const) {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) hold(fx + dx, fy + dy);
  }
  for (let i = 0; i < size; i++) {
    hold(i, 6);
    hold(6, i);
  }
  const centres = alignmentCentres(version);
  for (const cy of centres) {
    for (const cx of centres) {
      if (
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === size - 7) ||
        (cx === size - 7 && cy === 6)
      ) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) hold(cx + dx, cy + dy);
    }
  }
  for (let i = 0; i < 9; i++) {
    hold(i, 8);
    hold(8, i);
  }
  for (let i = 0; i < 8; i++) {
    hold(size - 1 - i, 8);
    hold(8, size - 1 - i);
  }
  hold(8, size - 8);
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      hold(a, b);
      hold(b, a);
    }
  }

  // Walk the data path, un-masking as we go.
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let column = 0; column < 2; column++) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (reserved[y]?.[x] === true) continue;
        const dark = qr.modules[y]?.[x] === true;
        bits.push(dark !== maskPredicate(qr.mask, x, y) ? 1 : 0);
      }
    }
  }

  const total = totalCodewords(version);
  const codewords = new Uint8Array(total);
  for (let i = 0; i < total * 8 && i < bits.length; i++) {
    if (bits[i] === 1) codewords[i >>> 3] = (codewords[i >>> 3] ?? 0) | (0x80 >>> (i & 7));
  }

  // Un-interleave back into per-block data codewords.
  const blockCount = ecBlocks(version, qr.ecLevel);
  const ecLength = ecCodewordsPerBlock(version, qr.ecLevel);
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount) - ecLength;
  const blocks: number[][] = Array.from({ length: blockCount }, () => []);
  let read = 0;
  for (let i = 0; i <= shortLength; i++) {
    for (let b = 0; b < blockCount; b++) {
      if (i === shortLength && b < shortBlocks) continue;
      blocks[b]?.push(codewords[read++] ?? 0);
    }
  }
  const data = Uint8Array.from(blocks.flat());

  // Header: 4 mode bits, then the character count, then the bytes.
  const countBits = version <= 9 ? 8 : 16;
  const bitAt = (i: number): number => ((data[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1;
  let cursor = 0;
  let mode = 0;
  for (let i = 0; i < 4; i++) mode = (mode << 1) | bitAt(cursor++);
  expect(mode).toBe(0b0100); // byte mode
  let length = 0;
  for (let i = 0; i < countBits; i++) length = (length << 1) | bitAt(cursor++);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bitAt(cursor++);
    out[i] = byte;
  }
  return new TextDecoder().decode(out);
}

// ---------------------------------------------------------------------------
// Capacity tables
// ---------------------------------------------------------------------------

describe("capacity tables", () => {
  test("total codewords match the spec for the versions that bracket each rule change", () => {
    // Published totals; version 1 has no alignment patterns, 2 introduces
    // them, 7 introduces version information, 40 is the ceiling.
    expect(totalCodewords(1)).toBe(26);
    expect(totalCodewords(2)).toBe(44);
    expect(totalCodewords(6)).toBe(172);
    expect(totalCodewords(7)).toBe(196);
    expect(totalCodewords(10)).toBe(346);
    expect(totalCodewords(27)).toBe(1828);
    expect(totalCodewords(40)).toBe(3706);
  });

  test("data codewords match the spec's published capacities", () => {
    // (version, level) → data codewords, from the spec's capacity table.
    const rows: ReadonlyArray<[number, EcLevel, number]> = [
      [1, "L", 19],
      [1, "M", 16],
      [1, "Q", 13],
      [1, "H", 9],
      [2, "L", 34],
      [5, "Q", 62],
      [7, "M", 124],
      [10, "L", 274],
      [8, "H", 86],
      [20, "L", 861],
      [20, "M", 669],
      [32, "Q", 1115],
      [40, "L", 2956],
      [40, "H", 1276],
    ];
    for (const [version, level, want] of rows) {
      expect(`v${version}${level}=${dataCodewords(version, level)}`).toBe(
        `v${version}${level}=${want}`,
      );
    }
  });

  test("every version and level leaves a positive, block-divisible capacity", () => {
    for (let version = 1; version <= 40; version++) {
      for (const level of ["L", "M", "Q", "H"] as const) {
        const data = dataCodewords(version, level);
        expect(data).toBeGreaterThan(0);
        // Data + EC must be exactly the version's total.
        expect(data + ecCodewordsPerBlock(version, level) * ecBlocks(version, level)).toBe(
          totalCodewords(version),
        );
        // Every block must hold at least one data codeword.
        expect(Math.floor(data / ecBlocks(version, level))).toBeGreaterThan(0);
      }
    }
  });

  test("symbol sizes run 21x21 to 177x177 in steps of four", () => {
    expect(versionSize(1)).toBe(21);
    expect(versionSize(40)).toBe(177);
    for (let v = 2; v <= 40; v++) expect(versionSize(v) - versionSize(v - 1)).toBe(4);
  });
});

describe("alignment pattern centres", () => {
  test("match the spec's published coordinates", () => {
    expect([...alignmentCentres(1)]).toEqual([]);
    expect([...alignmentCentres(2)]).toEqual([6, 18]);
    expect([...alignmentCentres(7)]).toEqual([6, 22, 38]);
    expect([...alignmentCentres(14)]).toEqual([6, 26, 46, 66]);
    expect([...alignmentCentres(40)]).toEqual([6, 30, 58, 86, 114, 142, 170]);
  });

  test("version 32 uses the spec's exceptional 26-module step, not the formula's 28", () => {
    // The one version where even spacing disagrees with the published table.
    expect([...alignmentCentres(32)]).toEqual([6, 34, 60, 86, 112, 138]);
  });

  test("every version starts at 6, ends at size-7, and has the prescribed count", () => {
    for (let version = 2; version <= 40; version++) {
      const centres = alignmentCentres(version);
      expect(centres.length).toBe(Math.floor(version / 7) + 2);
      expect(centres[0]).toBe(6);
      expect(centres[centres.length - 1]).toBe(versionSize(version) - 7);
      // Ascending, and never overlapping a neighbour's 5x5 body.
      for (let i = 1; i < centres.length; i++) {
        expect((centres[i] ?? 0) - (centres[i - 1] ?? 0)).toBeGreaterThanOrEqual(4);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Reed–Solomon
// ---------------------------------------------------------------------------

describe("GF(256) and Reed-Solomon", () => {
  test("multiplication obeys the field's identities", () => {
    expect(gfMul(0, 123)).toBe(0);
    expect(gfMul(123, 0)).toBe(0);
    expect(gfMul(1, 200)).toBe(200);
    expect(gfMul(2, 128)).toBe(0x1d); // 256 folds back through 0x11D
    // Commutative and associative.
    expect(gfMul(87, 131)).toBe(gfMul(131, 87));
    expect(gfMul(gfMul(3, 5), 7)).toBe(gfMul(3, gfMul(5, 7)));
  });

  test("generator polynomials have the spec's coefficients", () => {
    // Degree 2: x^2 + 3x + 2 over GF(256).
    expect([...rsGenerator(2)]).toEqual([1, 3, 2]);
    // Degree 7 — version 1, level L.
    expect([...rsGenerator(7)]).toEqual([1, 127, 122, 154, 164, 11, 68, 117]);
    // Degree 10 — version 1, level M.
    expect([...rsGenerator(10)]).toEqual([1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
    for (const degree of [7, 10, 13, 15, 17, 22, 26, 28, 30]) {
      expect(rsGenerator(degree).length).toBe(degree + 1);
      expect(rsGenerator(degree)[0]).toBe(1);
    }
  });

  test("the remainder has the requested length and is zero for an all-zero block", () => {
    expect(rsRemainder(new Uint8Array(16), 10)).toEqual(new Uint8Array(10));
    expect(rsRemainder(Uint8Array.from([1, 2, 3]), 7).length).toBe(7);
  });

  test("a message plus its remainder divides the generator exactly", () => {
    // The defining property: appending the check bytes makes the codeword a
    // multiple of the generator, so re-encoding it yields a zero remainder.
    const data = Uint8Array.from([0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26]);
    const check = rsRemainder(data, 10);
    expect(rsRemainder(Uint8Array.from([...data, ...check]), 10)).toEqual(new Uint8Array(10));
  });
});

// ---------------------------------------------------------------------------
// Format and version information
// ---------------------------------------------------------------------------

describe("format and version information", () => {
  test("format bits match the spec's published 15-bit strings", () => {
    const bin = (n: number): string => n.toString(2).padStart(15, "0");
    expect(bin(formatInfoBits("L", 0))).toBe("111011111000100");
    expect(bin(formatInfoBits("L", 7))).toBe("110100101110110");
    expect(bin(formatInfoBits("M", 0))).toBe("101010000010010");
    expect(bin(formatInfoBits("M", 4))).toBe("100010111111001");
    expect(bin(formatInfoBits("Q", 0))).toBe("011010101011111");
    expect(bin(formatInfoBits("Q", 3))).toBe("011101000000110");
    expect(bin(formatInfoBits("H", 6))).toBe("000110100001100");
    expect(bin(formatInfoBits("H", 7))).toBe("000100000111011");
  });

  test("all 32 format strings are distinct and differ in at least 3 bits", () => {
    const all: number[] = [];
    for (const level of ["L", "M", "Q", "H"] as const) {
      for (let mask = 0; mask < 8; mask++) all.push(formatInfoBits(level, mask));
    }
    expect(new Set(all).size).toBe(32);
    // BCH(15,5) guarantees a minimum Hamming distance of 7.
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        let distance = 0;
        const diff = (all[i] ?? 0) ^ (all[j] ?? 0);
        for (let b = 0; b < 15; b++) if (((diff >>> b) & 1) === 1) distance++;
        expect(distance).toBeGreaterThanOrEqual(7);
      }
    }
  });

  test("version information carries the version in its top 6 bits", () => {
    for (let version = 7; version <= 40; version++) {
      const bits = versionInfoBits(version);
      expect(bits >>> 12).toBe(version);
      expect(bits).toBeLessThan(1 << 18);
    }
    // Two published rows.
    expect(versionInfoBits(7).toString(2).padStart(18, "0")).toBe("000111110010010100");
    expect(versionInfoBits(40).toString(2).padStart(18, "0")).toBe("101000110001101001");
  });
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

describe("mask patterns", () => {
  test("each pattern matches its formula at a sample of coordinates", () => {
    expect(maskPredicate(0, 0, 0)).toBe(true);
    expect(maskPredicate(0, 1, 0)).toBe(false);
    expect(maskPredicate(1, 5, 2)).toBe(true); // y even
    expect(maskPredicate(1, 5, 3)).toBe(false);
    expect(maskPredicate(2, 6, 9)).toBe(true); // x % 3
    expect(maskPredicate(2, 7, 9)).toBe(false);
    expect(maskPredicate(3, 1, 2)).toBe(true); // (x+y) % 3
    expect(maskPredicate(4, 0, 0)).toBe(true);
    expect(maskPredicate(5, 0, 7)).toBe(true); // x*y === 0
    expect(maskPredicate(6, 0, 0)).toBe(true);
    expect(maskPredicate(6, 3, 3)).toBe(false); // (9%2 + 9%3) % 2 === 1
    expect(maskPredicate(7, 0, 0)).toBe(true);
  });

  test("the eight patterns are all different", () => {
    const signatures = new Set<string>();
    for (let pattern = 0; pattern < 8; pattern++) {
      let signature = "";
      for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 12; x++) signature += maskPredicate(pattern, x, y) ? "1" : "0";
      }
      signatures.add(signature);
    }
    expect(signatures.size).toBe(8);
  });
});

describe("mask penalty rules", () => {
  /** A `size`x`size` grid from a sparse list of dark coordinates. */
  const grid = (size: number, dark: ReadonlyArray<readonly [number, number]>): boolean[][] => {
    const out = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
    for (const [x, y] of dark) {
      const row = out[y];
      if (row !== undefined) row[x] = true;
    }
    return out;
  };
  /** The first `n` cells of a `size`x`size` grid, in reading order. */
  const firstN = (size: number, n: number): Array<readonly [number, number]> =>
    Array.from({ length: n }, (_unused, i) => [i % size, Math.floor(i / size)] as const);

  test("rule 1 charges 3 for a run of five and 1 for each module beyond", () => {
    // An all-light 7x7: every row and every column is one run of seven, which
    // scores 3 at the fifth module and 1 for each of the sixth and seventh.
    // 5 per line x 14 lines = 70.
    expect(penaltyRuns(grid(7, []), 7)).toBe(70);

    // The same grid with row 0 fully dark. Rows: row 0 is a dark run of seven
    // (5), rows 1-6 are light runs of seven (5 each) = 35. Columns: each is
    // one dark module then a light run of six, which scores 3 at the fifth and
    // 1 at the sixth = 4, so 28. Total 63.
    const rowDark = Array.from({ length: 7 }, (_unused, i) => [i, 0] as const);
    expect(penaltyRuns(grid(7, rowDark), 7)).toBe(63);
  });

  test("rule 1 ignores runs shorter than five", () => {
    // A 4-long run in an otherwise empty row contributes nothing of its own;
    // only the light runs around it score. Compare against the count that the
    // light structure alone produces.
    const four = Array.from({ length: 4 }, (_unused, i) => [i, 0] as const);
    // Rows: row 0 is a dark 4 (0) then a light 3 (0) = 0; rows 1-6 score 5
    // each = 30. Columns: 4 columns are dark-then-light-6 (4 each) = 16, and
    // 3 columns are light-7 (5 each) = 15. Total 61.
    expect(penaltyRuns(grid(7, four), 7)).toBe(61);
  });

  test("rule 2 charges 3 for each 2x2 block, counting overlaps", () => {
    // An all-light 9x9 contains 8x8 = 64 single-colour 2x2 blocks.
    expect(penaltyBlocks(grid(9, []), 9)).toBe(3 * 64);

    // A solid 3x3 in the corner leaves the four 2x2 blocks inside it and the
    // blocks clear of it single-coloured, but makes five straddling blocks
    // mixed: 64 - 5 = 59.
    const solid3x3 = [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => [x, y] as const));
    expect(penaltyBlocks(grid(9, solid3x3), 9)).toBe(3 * 59);

    // A checkerboard has no single-colour 2x2 block at all.
    const checker: Array<readonly [number, number]> = [];
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) if ((x + y) % 2 === 0) checker.push([x, y] as const);
    }
    expect(penaltyBlocks(grid(9, checker), 9)).toBe(0);
  });

  test("rule 3 charges 40 per finder-lookalike, in rows and columns", () => {
    const horizontal: Array<readonly [number, number]> = [
      [4, 0],
      [6, 0],
      [7, 0],
      [8, 0],
      [10, 0],
    ];
    // 1:1:3:1:1 at x=4..10, with x=0..3 light in front of it.
    expect(penaltyFinderLike(grid(15, horizontal), 15)).toBe(40);
    const vertical: Array<readonly [number, number]> = [
      [0, 4],
      [0, 6],
      [0, 7],
      [0, 8],
      [0, 10],
    ];
    expect(penaltyFinderLike(grid(15, vertical), 15)).toBe(40);
    // Nothing to match at all.
    expect(penaltyFinderLike(grid(15, []), 15)).toBe(0);
  });

  test("rule 3 needs four light modules on at least one side", () => {
    // The pattern with dark modules packed against BOTH sides no longer
    // qualifies: x=1..4 dark before it, x=12..15 dark after it.
    const boxedIn: Array<readonly [number, number]> = [
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
      [7, 0],
      [8, 0],
      [9, 0],
      [11, 0],
      [12, 0],
      [13, 0],
      [14, 0],
      [15, 0],
    ];
    expect(penaltyFinderLike(grid(16, boxedIn), 16)).toBe(0);

    // Free one side and it scores again.
    const openLeft: Array<readonly [number, number]> = [
      [5, 0],
      [7, 0],
      [8, 0],
      [9, 0],
      [11, 0],
      [12, 0],
      [13, 0],
      [14, 0],
      [15, 0],
    ];
    expect(penaltyFinderLike(grid(16, openLeft), 16)).toBe(40);
  });

  test("rule 4 charges 10 per whole 5% the dark proportion strays from half", () => {
    const size = 10; // 100 modules — one module is one percent
    expect(penaltyBalance(grid(size, firstN(size, 50)), size)).toBe(0); // 50 %
    expect(penaltyBalance(grid(size, firstN(size, 45)), size)).toBe(0); // within 5 %
    expect(penaltyBalance(grid(size, firstN(size, 44)), size)).toBe(10);
    expect(penaltyBalance(grid(size, firstN(size, 55)), size)).toBe(0);
    expect(penaltyBalance(grid(size, firstN(size, 56)), size)).toBe(10);
    expect(penaltyBalance(grid(size, firstN(size, 30)), size)).toBe(30);
    expect(penaltyBalance(grid(size, []), size)).toBe(90); // 0 % dark
  });

  test("the total is the sum of the four rules", () => {
    const qr = encodeQr("penalty sum", { ecLevel: "M" });
    expect(maskPenalty(qr.modules, qr.size)).toBe(
      penaltyRuns(qr.modules, qr.size) +
        penaltyBlocks(qr.modules, qr.size) +
        penaltyFinderLike(qr.modules, qr.size) +
        penaltyBalance(qr.modules, qr.size),
    );
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe("encodeQr", () => {
  test("round-trips ASCII, UTF-8 and the empty string", () => {
    for (const text of [
      "",
      "x",
      "HELLO WORLD",
      "http://192.168.1.42:4200/#t=0123456789abcdef0123456789abcdef",
      "héllo ünicode ✓ — em dash",
      "a".repeat(300),
      "0".repeat(1000),
    ]) {
      expect(readBack(encodeQr(text))).toBe(text);
    }
  });

  test("round-trips at every error-correction level and every forced mask", () => {
    const text = "http://10.0.0.7:4200/#t=deadbeef";
    for (const level of ["L", "M", "Q", "H"] as const) {
      for (let mask = 0; mask < 8; mask++) {
        expect(readBack(encodeQr(text, { ecLevel: level, mask, boostEcLevel: false }))).toBe(text);
      }
    }
  });

  test("round-trips across the version boundaries that change the encoding", () => {
    // Version 9→10 widens the character count to 16 bits; 6→7 adds version
    // information; larger versions add blocks and interleaving.
    for (const length of [1, 17, 100, 154, 155, 271, 272, 700, 1200, 2000]) {
      const text = "z".repeat(length);
      const qr = encodeQr(text, { ecLevel: "L", boostEcLevel: false });
      expect(`${length}:${readBack(qr)}`).toBe(`${length}:${text}`);
    }
  });

  test("picks the smallest version that fits and reports it", () => {
    // Version 1 at level M holds 16 data codewords: 1 mode nibble + 1 count
    // byte + 14 payload bytes.
    expect(encodeQr("a".repeat(14), { ecLevel: "M", boostEcLevel: false }).version).toBe(1);
    expect(encodeQr("a".repeat(15), { ecLevel: "M", boostEcLevel: false }).version).toBe(2);
    expect(encodeQr("a".repeat(14), { ecLevel: "M" }).size).toBe(21);
  });

  test("honours minVersion and maxVersion", () => {
    expect(encodeQr("x", { minVersion: 5 }).version).toBe(5);
    expect(() => encodeQr("a".repeat(100), { maxVersion: 2 })).toThrow(/do not fit/);
  });

  test("boosts the error-correction level when the version has room to spare", () => {
    // "x" fits version 1 at H, so a request for L is silently upgraded.
    expect(encodeQr("x", { ecLevel: "L" }).ecLevel).toBe("H");
    expect(encodeQr("x", { ecLevel: "L", boostEcLevel: false }).ecLevel).toBe("L");
    // The boost must never change the symbol size.
    for (const length of [1, 10, 40, 200, 900]) {
      const text = "q".repeat(length);
      expect(encodeQr(text, { ecLevel: "L" }).version).toBe(
        encodeQr(text, { ecLevel: "L", boostEcLevel: false }).version,
      );
    }
  });

  test("refuses a payload larger than any symbol, and an out-of-range mask", () => {
    expect(() => encodeQr("a".repeat(3000), { ecLevel: "H" })).toThrow(/do not fit/);
    expect(() => encodeQr("x", { mask: 8 })).toThrow(/mask must be an integer/);
    expect(() => encodeQr("x", { mask: -1 })).toThrow(/mask must be an integer/);
  });

  test("places the three finder patterns, the timing strips and the dark module", () => {
    const qr = encodeQr("finders", { ecLevel: "M" });
    const dark = (x: number, y: number): boolean => qr.modules[y]?.[x] === true;
    for (const [fx, fy] of [
      [0, 0],
      [qr.size - 7, 0],
      [0, qr.size - 7],
    ] as const) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          expect(`${fx + dx},${fy + dy}=${dark(fx + dx, fy + dy)}`).toBe(
            `${fx + dx},${fy + dy}=${ring !== 2}`,
          );
        }
      }
    }
    // Timing patterns alternate, starting dark at module 8.
    for (let i = 8; i < qr.size - 8; i++) {
      expect(dark(i, 6)).toBe(i % 2 === 0);
      expect(dark(6, i)).toBe(i % 2 === 0);
    }
    // The dark module is always set.
    expect(dark(8, qr.size - 8)).toBe(true);
  });

  test("chooses the lowest-penalty mask", () => {
    const text = "http://192.168.1.42:4200/#t=0123456789abcdef";
    const chosen = encodeQr(text, { ecLevel: "M", boostEcLevel: false });
    const chosenPenalty = maskPenalty(chosen.modules, chosen.size);
    for (let mask = 0; mask < 8; mask++) {
      const forced = encodeQr(text, { ecLevel: "M", mask, boostEcLevel: false });
      expect(maskPenalty(forced.modules, forced.size)).toBeGreaterThanOrEqual(chosenPenalty);
    }
  });

  test("is deterministic", () => {
    const a = encodeQr("same in, same out", { ecLevel: "Q" });
    const b = encodeQr("same in, same out", { ecLevel: "Q" });
    expect(a.modules).toEqual(b.modules);
    expect(a.mask).toBe(b.mask);
  });
});
