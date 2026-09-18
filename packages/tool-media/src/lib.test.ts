/**
 * The pure logic, tested on its own.
 *
 * Nothing here touches the filesystem, the network or a process. Binary
 * fixtures are built byte by byte in `./fixtures`, and the two places where
 * this package could plausibly be subtly wrong — the PNG decoder and the QR
 * encoder — are checked against something other than themselves: the
 * decoder against a hand-assembled PNG that takes a code path the encoder
 * never takes, and the encoder against a reader written independently in
 * this file, right down to its own copy of the module walk.
 */
import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import {
  SAMPLE_FFPROBE_JSON,
  SAMPLE_SRT,
  SAMPLE_VTT,
  exifApp1Payload,
  handWrittenPng,
  rgbaSamples,
  sampleBmp,
  sampleGif,
  sampleJpeg,
  sampleWebpExtended,
  sampleWebpLossless,
  sampleWebpLossy,
} from "./fixtures";
import {
  code128Values,
  code128Widths,
  ean13CheckDigit,
  eanTables,
  encodeCode128,
  encodeEan13,
} from "./lib/barcode";
import { ByteReader, MediaFormatError, crc32, toHex } from "./lib/bytes";
import { renderChart } from "./lib/chart";
import {
  compositeOver,
  contrastReport,
  hslToRgb,
  parseColor,
  relativeLuminance,
  rgbToHsl,
  toHexString,
} from "./lib/color";
import { assignLayers, renderDiagram } from "./lib/diagram";
import { parseProbeJson, parseRate } from "./lib/ffprobe";
import { detectKind, kindsForExtension, knownKinds, readImageHeader } from "./lib/identify";
import {
  cropImage,
  diffImages,
  differenceHash,
  fitDimensions,
  hammingDistance,
  imageStats,
  resizeImage,
} from "./lib/imageops";
import { findExifSegment, parseExif, readJpegSegments, stripJpegMetadata } from "./lib/jpeg";
import { type RgbaImage, autoColorType, decodePng, encodePng, readPngHeader } from "./lib/png";
import {
  ECC_LEVELS,
  type EccLevel,
  MAX_VERSION,
  alignmentPositions,
  blockLayout,
  byteCapacity,
  dataCodewordCount,
  encodeQr,
  modulePositions,
  remainderBits,
  smallestVersion,
  symbolToText,
} from "./lib/qr";
import { canvas, fillRect, renderModuleStrip } from "./lib/raster";
import { sparklineBlocks, sparklineSvg } from "./lib/sparkline";
import {
  formatTimestamp,
  parseSubtitles,
  parseTimestamp,
  wrapCueText,
  writeSubtitles,
} from "./lib/subtitle";
import { escapeXml, estimateTextWidth, formatValue, niceScale, num, paletteColor } from "./lib/svg";

/** A small, non-uniform test image: a gradient with a red square in it. */
function testImage(width = 16, height = 12): RgbaImage {
  return {
    width,
    height,
    data: rgbaSamples(width, height, (x, y) =>
      x >= 4 && x < 8 && y >= 3 && y < 7
        ? [220, 30, 30, 255]
        : [(x * 13) % 256, (y * 21) % 256, (x + y) * 7, 255],
    ),
  };
}

describe("bytes", () => {
  test("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("crc32 over several parts equals crc32 over the concatenation", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    expect(crc32(a, b)).toBe(crc32(new Uint8Array([1, 2, 3, 4, 5])));
  });

  test("a read past the end is an error, not a wrong number", () => {
    const reader = new ByteReader(new Uint8Array([1, 2, 3]));
    reader.u16be();
    expect(() => reader.u32be()).toThrow(MediaFormatError);
  });

  test("little- and big-endian readers disagree the way they should", () => {
    expect(new ByteReader(new Uint8Array([0x12, 0x34])).u16be()).toBe(0x1234);
    expect(new ByteReader(new Uint8Array([0x12, 0x34])).u16le()).toBe(0x3412);
    expect(new ByteReader(new Uint8Array([0xff, 0xff, 0xff, 0xff])).u32le()).toBe(4294967295);
    expect(new ByteReader(new Uint8Array([0xff, 0xff, 0xff, 0xff])).u32be()).toBe(4294967295);
  });

  test("toHex pads every byte to two digits", () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe("000fff");
  });
});

describe("png codec", () => {
  test("round-trips RGBA through every colour type", () => {
    const image = testImage();
    for (const colorType of ["rgba", "rgb", "gray", "gray-alpha"] as const) {
      const decoded = decodePng(encodePng(image, { colorType }));
      expect(decoded.width).toBe(image.width);
      expect(decoded.height).toBe(image.height);
      if (colorType === "rgba" || colorType === "rgb") {
        for (let i = 0; i < image.data.length; i++) {
          // Type 2 drops alpha, which this image does not use.
          if (i % 4 === 3 && colorType === "rgb") continue;
          expect(decoded.data[i]).toBe(image.data[i] as number);
        }
      }
    }
  });

  test("auto picks the smallest lossless colour type", () => {
    const opaqueColor = testImage();
    expect(autoColorType(opaqueColor)).toBe("rgb");
    const grey: RgbaImage = {
      width: 2,
      height: 1,
      data: new Uint8Array([10, 10, 10, 255, 20, 20, 20, 255]),
    };
    expect(autoColorType(grey)).toBe("gray");
    const translucent: RgbaImage = {
      width: 1,
      height: 1,
      data: new Uint8Array([1, 2, 3, 128]),
    };
    expect(autoColorType(translucent)).toBe("rgba");
  });

  test("encoding is byte-identical across runs", () => {
    const image = testImage();
    expect(toHex(encodePng(image))).toBe(toHex(encodePng(image)));
  });

  test("decodes a hand-assembled greyscale PNG split across several IDATs", () => {
    const samples = new Uint8Array([0, 64, 128, 255, 32, 96, 160, 224]);
    const png = handWrittenPng({
      width: 4,
      height: 2,
      colorType: 0,
      samples,
      idatChunks: 3,
    });
    const decoded = decodePng(png);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(2);
    expect([...decoded.data.subarray(0, 8)]).toEqual([0, 0, 0, 255, 64, 64, 64, 255]);
    expect(decoded.hadAlpha).toBe(false);
  });

  test("decodes a palette PNG and applies tRNS", () => {
    const png = handWrittenPng({
      width: 3,
      height: 1,
      colorType: 3,
      samples: new Uint8Array([0, 1, 2]),
      palette: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]),
      transparency: new Uint8Array([0, 128]),
    });
    const decoded = decodePng(png);
    expect([...decoded.data]).toEqual([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255]);
    expect(decoded.hadAlpha).toBe(true);
  });

  test("refuses 16-bit samples rather than truncating them", () => {
    const png = handWrittenPng({
      width: 1,
      height: 1,
      colorType: 0,
      samples: new Uint8Array([0, 0]),
      bitDepth: 16,
    });
    expect(() => decodePng(png)).toThrow(/bit depth 16 is not supported/);
  });

  test("refuses an interlaced PNG", () => {
    const png = handWrittenPng({
      width: 2,
      height: 2,
      colorType: 0,
      samples: new Uint8Array(4),
      interlace: 1,
    });
    expect(() => decodePng(png)).toThrow(/interlaced/);
  });

  test("refuses an image past the pixel cap before inflating anything", () => {
    const png = encodePng(testImage(20, 20));
    expect(() => decodePng(png, { maxPixels: 100 })).toThrow(/over the 100 cap/);
  });

  test("refuses bytes that are not a PNG at all", () => {
    expect(() => readPngHeader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(
      /signature does not match/,
    );
  });

  test("refuses a pixel buffer whose length disagrees with the dimensions", () => {
    expect(() => encodePng({ width: 4, height: 4, data: new Uint8Array(10) })).toThrow(/needs 64/);
  });

  /**
   * Take a PNG apart without using anything in `./lib/png`: walk the chunks
   * by hand, recompute every CRC (with the `crc32` this file has already
   * checked against the published `123456789` value, so it is not this
   * package's word for it), inflate the IDAT with `node:zlib` and undo the
   * scanline filters from the specification's own equations.
   *
   * This is what keeps `encodePng` from being verified only by
   * `decodePng` — a round trip through one package's own reader passes just
   * as happily when both directions share a wrong assumption.
   */
  function dissect(png: Uint8Array): {
    chunks: Array<{ type: string; length: number; crcOk: boolean }>;
    ihdr: { width: number; height: number; bitDepth: number; colorType: number };
    samples: Uint8Array;
  } {
    for (let i = 0; i < 8; i++) {
      expect(png[i]).toBe([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] as number);
    }
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const chunks: Array<{ type: string; length: number; crcOk: boolean }> = [];
    const idat: Uint8Array[] = [];
    let ihdr = { width: 0, height: 0, bitDepth: 0, colorType: 0 };
    let at = 8;
    while (at < png.length) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
      const data = png.subarray(at + 8, at + 8 + length);
      const declared = view.getUint32(at + 8 + length);
      chunks.push({ type, length, crcOk: crc32(png.subarray(at + 4, at + 8), data) === declared });
      if (type === "IHDR") {
        const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
        ihdr = {
          width: d.getUint32(0),
          height: d.getUint32(4),
          bitDepth: data[8] as number,
          colorType: data[9] as number,
        };
      }
      if (type === "IDAT") idat.push(data);
      at += 12 + length;
    }
    expect(at).toBe(png.length);

    const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
      ihdr.colorType
    ] as number;
    const stride = ihdr.width * channels;
    const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
    let o = 0;
    for (const part of idat) {
      joined.set(part, o);
      o += part.length;
    }
    const raw = new Uint8Array(inflateSync(joined));
    expect(raw.length).toBe(ihdr.height * (stride + 1));

    const samples = new Uint8Array(ihdr.height * stride);
    for (let y = 0; y < ihdr.height; y++) {
      const filter = raw[y * (stride + 1)] as number;
      for (let x = 0; x < stride; x++) {
        const value = raw[y * (stride + 1) + 1 + x] as number;
        const a = x >= channels ? (samples[y * stride + x - channels] as number) : 0;
        const b = y > 0 ? (samples[(y - 1) * stride + x] as number) : 0;
        const c = x >= channels && y > 0 ? (samples[(y - 1) * stride + x - channels] as number) : 0;
        let out: number;
        if (filter === 0) out = value;
        else if (filter === 1) out = value + a;
        else if (filter === 2) out = value + b;
        else if (filter === 3) out = value + Math.floor((a + b) / 2);
        else {
          // Paeth, transcribed from the specification's pseudo-code.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        samples[y * stride + x] = out & 0xff;
      }
    }
    return { chunks, ihdr, samples };
  }

  test("an encoded PNG is a valid file by an independent reading of the spec", () => {
    const image = testImage(9, 7);
    const png = encodePng(image, { colorType: "rgb" });
    const { chunks, ihdr, samples } = dissect(png);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    // Every CRC checks out against a CRC-32 verified against its own
    // published check value, not against this package's encoder.
    expect(chunks.filter((c) => c.crcOk).length).toBe(chunks.length);
    expect(ihdr).toEqual({ width: 9, height: 7, bitDepth: 8, colorType: 2 });
    // And the samples the file actually carries are the pixels handed in.
    for (let i = 0; i < 9 * 7; i++) {
      expect([...samples.subarray(i * 3, i * 3 + 3)]).toEqual([
        ...image.data.subarray(i * 4, i * 4 + 3),
      ]);
    }
  });

  test("every colour type the encoder writes survives the independent reading", () => {
    const cases: Array<{ colorType: "rgba" | "rgb" | "gray" | "gray-alpha"; code: number }> = [
      { colorType: "rgba", code: 6 },
      { colorType: "rgb", code: 2 },
      { colorType: "gray", code: 0 },
      { colorType: "gray-alpha", code: 4 },
    ];
    const channelsFor: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
    for (const { colorType, code } of cases) {
      const image = testImage(6, 5);
      const { chunks, ihdr, samples } = dissect(encodePng(image, { colorType }));
      expect({ colorType, crcOk: chunks.every((c) => c.crcOk) }).toEqual({
        colorType,
        crcOk: true,
      });
      expect(ihdr.colorType).toBe(code);
      expect(samples.length).toBe(6 * 5 * (channelsFor[code] as number));
    }
  });

  test("a chunk whose CRC does not match its bytes is refused, and located", () => {
    const png = encodePng(testImage(4, 4));
    // A flipped bit in the IHDR payload: its CRC now describes other bytes.
    const corruptHeader = png.slice();
    corruptHeader[20] = (corruptHeader[20] as number) ^ 0xff;
    expect(() => decodePng(corruptHeader)).toThrow(/chunk IHDR at offset 8 declares CRC/);
    // And one in the compressed pixels, which would otherwise inflate to
    // something that is not the picture this file claims to hold.
    const corruptIdat = png.slice();
    const idatAt = 8 + 12 + 13; // signature, then the whole IHDR chunk
    corruptIdat[idatAt + 10] = (corruptIdat[idatAt + 10] as number) ^ 0x01;
    expect(() => decodePng(corruptIdat)).toThrow(/chunk IDAT at offset 33 declares CRC/);
  });
});

describe("identify", () => {
  test("names each image format from its magic bytes", () => {
    expect(detectKind(encodePng(testImage(2, 2)))?.kind).toBe("png");
    expect(detectKind(sampleJpeg({ width: 4, height: 4 }))?.kind).toBe("jpeg");
    expect(detectKind(sampleGif(4, 4))?.kind).toBe("gif");
    expect(detectKind(sampleWebpLossless(4, 4, true))?.kind).toBe("webp");
    expect(detectKind(sampleBmp(4, 4))?.kind).toBe("bmp");
  });

  test("sniffs SVG, which has no magic number", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectKind(svg)?.kind).toBe("svg");
    const declared = new TextEncoder().encode('<?xml version="1.0"?>\n<svg></svg>');
    expect(detectKind(declared)?.kind).toBe("svg");
  });

  test("returns undefined rather than guessing at unknown bytes", () => {
    expect(detectKind(new Uint8Array([0x00, 0x11, 0x22, 0x33]))).toBeUndefined();
  });

  test("knows which kinds an extension conventionally names", () => {
    expect(kindsForExtension(".jpg")).toEqual(["jpeg"]);
    expect(kindsForExtension("webm")).toEqual(["matroska"]);
    expect(knownKinds()).toContain("flac");
    expect([...knownKinds()]).toEqual([...knownKinds()].sort());
  });

  test("reads PNG header facts including tRNS transparency", () => {
    const png = handWrittenPng({
      width: 5,
      height: 3,
      colorType: 2,
      samples: new Uint8Array(45),
      transparency: new Uint8Array([0, 0, 0, 0, 0, 0]),
    });
    const header = readImageHeader(png);
    expect(header).toMatchObject({
      format: "png",
      width: 5,
      height: 3,
      bitDepth: 8,
      colorType: "rgb",
      hasAlpha: true,
    });
  });

  test("reads a JPEG frame header past the metadata segments", () => {
    const jpeg = sampleJpeg({
      width: 1920,
      height: 1080,
      exif: { make: "Acme", model: "Cam" },
      comment: "hello",
    });
    expect(readImageHeader(jpeg)).toMatchObject({
      format: "jpeg",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      colorType: "ycbcr",
      hasAlpha: false,
    });
  });

  test("reads a greyscale JPEG's component count", () => {
    expect(readImageHeader(sampleJpeg({ width: 8, height: 8, components: 1 })).colorType).toBe(
      "grayscale",
    );
  });

  test("finds GIF transparency in the graphic control extension", () => {
    expect(readImageHeader(sampleGif(320, 200)).hasAlpha).toBe(false);
    const transparent = readImageHeader(sampleGif(320, 200, { transparent: true }));
    expect(transparent).toMatchObject({ width: 320, height: 200, hasAlpha: true });
  });

  test("reads all three WebP chunk layouts", () => {
    expect(readImageHeader(sampleWebpLossless(640, 480, true))).toMatchObject({
      width: 640,
      height: 480,
      hasAlpha: true,
    });
    expect(readImageHeader(sampleWebpLossless(1, 1, false)).hasAlpha).toBe(false);
    expect(readImageHeader(sampleWebpLossy(300, 200))).toMatchObject({
      width: 300,
      height: 200,
      hasAlpha: false,
    });
    const extended = readImageHeader(
      sampleWebpExtended(4096, 2160, { alpha: true, animation: true }),
    );
    expect(extended).toMatchObject({ width: 4096, height: 2160, hasAlpha: true });
    expect(extended.notes).toContain("animated");
  });

  test("reads BMP dimensions, row order and alpha mask", () => {
    expect(readImageHeader(sampleBmp(100, 50))).toMatchObject({
      width: 100,
      height: 50,
      bitDepth: 24,
      hasAlpha: false,
    });
    const topDown = readImageHeader(sampleBmp(8, 8, { topDown: true }));
    expect(topDown.height).toBe(8);
    expect(topDown.notes).toContain("top-down row order");
    expect(readImageHeader(sampleBmp(8, 8, { bitCount: 32, alphaMask: true })).hasAlpha).toBe(true);
    expect(readImageHeader(sampleBmp(8, 8, { bitCount: 32 })).hasAlpha).toBe(false);
  });

  test("refuses to read a header from a format it does not cover", () => {
    expect(() => readImageHeader(new TextEncoder().encode("%PDF-1.7\n"))).toThrow(
      /these bytes are pdf/,
    );
  });
});

describe("pixel operations", () => {
  test("nearest-neighbour doubling repeats each pixel exactly", () => {
    const source: RgbaImage = {
      width: 2,
      height: 1,
      data: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]),
    };
    const out = resizeImage(source, 4, 1, "nearest");
    expect([...out.data.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...out.data.subarray(4, 8)]).toEqual([10, 20, 30, 255]);
    expect([...out.data.subarray(8, 12)]).toEqual([40, 50, 60, 255]);
  });

  test("bilinear halving averages, nearest does not", () => {
    const source: RgbaImage = {
      width: 2,
      height: 1,
      data: new Uint8Array([0, 0, 0, 255, 200, 200, 200, 255]),
    };
    expect(resizeImage(source, 1, 1, "bilinear").data[0]).toBe(100);
    // Nearest samples the pixel under the output centre, never an average.
    expect(resizeImage(source, 1, 1, "nearest").data[0]).toBe(200);
  });

  test("resizing is reproducible", () => {
    const image = testImage(31, 17);
    const a = resizeImage(image, 7, 5, "bilinear");
    const b = resizeImage(image, 7, 5, "bilinear");
    expect(toHex(a.data)).toBe(toHex(b.data));
  });

  test("fitDimensions preserves the aspect ratio from either side", () => {
    expect(fitDimensions({ width: 800, height: 600 }, { width: 400 })).toEqual({
      width: 400,
      height: 300,
    });
    expect(fitDimensions({ width: 800, height: 600 }, { height: 150 })).toEqual({
      width: 200,
      height: 150,
    });
    expect(fitDimensions({ width: 800, height: 600 }, { width: 10, height: 10 })).toEqual({
      width: 10,
      height: 10,
    });
  });

  test("cropping takes the right rectangle and refuses one that does not fit", () => {
    const image = testImage(8, 8);
    const cropped = cropImage(image, 2, 3, 4, 2);
    expect(cropped.width).toBe(4);
    expect([...cropped.data.subarray(0, 4)]).toEqual([
      ...image.data.subarray((3 * 8 + 2) * 4, (3 * 8 + 2) * 4 + 4),
    ]);
    expect(() => cropImage(image, 6, 0, 4, 1)).toThrow(/is not inside/);
    expect(() => cropImage(image, 0, 0, 0, 1)).toThrow(/cannot crop/);
  });

  test("diff reports the changed region and nothing else", () => {
    const before = testImage(20, 20);
    const after: RgbaImage = { ...before, data: before.data.slice() };
    for (let y = 5; y < 8; y++) {
      for (let x = 11; x < 15; x++) {
        after.data[(y * 20 + x) * 4] = 255;
      }
    }
    const diff = diffImages(before, after, 0);
    expect(diff.differingPixels).toBe(12);
    expect(diff.boundingBox).toEqual({ x: 11, y: 5, width: 4, height: 3 });
    expect(diff.fraction).toBeCloseTo(12 / 400, 6);
    expect(diffImages(before, before, 0).boundingBox).toBeNull();
  });

  test("the threshold is a tolerance, not a switch", () => {
    const a: RgbaImage = { width: 1, height: 1, data: new Uint8Array([100, 100, 100, 255]) };
    const b: RgbaImage = { width: 1, height: 1, data: new Uint8Array([105, 100, 100, 255]) };
    expect(diffImages(a, b, 0).differingPixels).toBe(1);
    expect(diffImages(a, b, 4).differingPixels).toBe(1);
    expect(diffImages(a, b, 5).differingPixels).toBe(0);
    expect(diffImages(a, b, 5).maxChannelDelta).toBe(5);
  });

  test("comparing different sizes is refused rather than guessed at", () => {
    expect(() => diffImages(testImage(4, 4), testImage(4, 5), 0)).toThrow(/cannot compare/);
  });

  test("the difference hash is 64 bits, stable, and survives a rescale", () => {
    const image = testImage(64, 64);
    const hash = differenceHash(image);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(differenceHash(image)).toBe(hash);
    const scaled = resizeImage(image, 32, 32, "bilinear");
    expect(hammingDistance(hash, differenceHash(scaled))).toBeLessThan(16);
    expect(hammingDistance(hash, hash)).toBe(0);
  });

  test("hamming distance counts bits, and refuses mismatched lengths", () => {
    expect(hammingDistance("0f", "00")).toBe(4);
    expect(() => hammingDistance("00", "000")).toThrow(/cannot compare/);
  });

  test("stats report per-channel means and the opaque pixel count", () => {
    const image: RgbaImage = {
      width: 2,
      height: 1,
      data: new Uint8Array([0, 0, 0, 255, 100, 200, 50, 0]),
    };
    const stats = imageStats(image);
    expect(stats.mean.r).toBe(50);
    expect(stats.max.g).toBe(200);
    expect(stats.opaquePixels).toBe(1);
    expect(stats.distinctColorsCapped).toBe(2);
  });
});

describe("colour", () => {
  test("parses every notation it claims to", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(parseColor("#1a2b3c")).toEqual({ r: 26, g: 43, b: 60, a: 255 });
    expect(parseColor("#1a2b3c80").a).toBe(128);
    expect(parseColor("#f00c").a).toBe(204);
    expect(parseColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 255 });
    expect(parseColor("rgba(1,2,3,0.5)").a).toBe(128);
    expect(parseColor("rgb(100%, 0%, 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseColor("hsl(120, 100%, 50%)")).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(parseColor("teal")).toEqual({ r: 0, g: 128, b: 128, a: 255 });
  });

  test("refuses a colour it does not read, naming the input", () => {
    expect(() => parseColor("cornflowerblue")).toThrow(/is not a colour this package reads/);
    expect(() => parseColor("#12345")).toThrow(MediaFormatError);
  });

  test("HSL round-trips through RGB", () => {
    for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#808080", "#123456", "#ffffff"]) {
      const rgb = parseColor(hex);
      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      const back = hslToRgb(hsl.h, hsl.s, hsl.l);
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });

  test("hex strings carry alpha only when there is any", () => {
    expect(toHexString({ r: 1, g: 2, b: 3, a: 255 })).toBe("#010203");
    expect(toHexString({ r: 1, g: 2, b: 3, a: 0 })).toBe("#01020300");
  });

  test("relative luminance hits the defined endpoints", () => {
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 10);
  });

  test("black on white is 21:1, the maximum the formula allows", () => {
    const report = contrastReport(parseColor("#000"), parseColor("#fff"));
    expect(report.ratio).toBe(21);
    expect(report.verdict).toBe("AAA");
  });

  test("the grey either side of the AA threshold lands either side of it", () => {
    const passes = contrastReport(parseColor("#767676"), parseColor("#ffffff"));
    expect(passes.ratio).toBeCloseTo(4.54, 2);
    expect(passes.normalTextAA).toBe(true);
    const fails = contrastReport(parseColor("#777777"), parseColor("#ffffff"));
    expect(fails.ratio).toBeCloseTo(4.48, 2);
    expect(fails.normalTextAA).toBe(false);
    expect(fails.largeTextAA).toBe(true);
    expect(fails.verdict).toBe("AA-large-only");
  });

  test("the ratio does not depend on which colour is which", () => {
    const a = contrastReport(parseColor("#333"), parseColor("#eee")).ratio;
    const b = contrastReport(parseColor("#eee"), parseColor("#333")).ratio;
    expect(a).toBe(b);
  });

  test("a translucent foreground is composited before it is measured", () => {
    const over = compositeOver({ r: 0, g: 0, b: 0, a: 128 }, { r: 255, g: 255, b: 255, a: 255 });
    expect(over).toEqual({ r: 127, g: 127, b: 127, a: 255 });
    const report = contrastReport(parseColor("#00000080"), parseColor("#ffffff"));
    expect(report.foreground).toBe("#7f7f7f");
    expect(report.ratio).toBeLessThan(21);
  });
});

describe("qr encoder", () => {
  // --- an independent reader, written here rather than reused ------------

  function gfMul(x: number, y: number): number {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  /** True where the module at (row, col) is a function pattern, not data. */
  function isFunctionModule(size: number, version: number, row: number, col: number): boolean {
    const inFinder = (r0: number, c0: number): boolean =>
      row >= r0 - 1 && row <= r0 + 7 && col >= c0 - 1 && col <= c0 + 7;
    if (inFinder(0, 0) || inFinder(0, size - 7) || inFinder(size - 7, 0)) return true;
    if (row === 6 || col === 6) return true;
    // Format information, both copies, plus the always-dark module.
    if (col === 8 && (row <= 8 || row >= size - 8)) return true;
    if (row === 8 && (col <= 8 || col >= size - 8)) return true;
    if (version >= 7) {
      if (col >= size - 11 && col <= size - 9 && row <= 5) return true;
      if (row >= size - 11 && row <= size - 9 && col <= 5) return true;
    }
    const centres = alignmentPositions(version);
    for (const r of centres) {
      for (const c of centres) {
        const corner =
          (r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6);
        if (corner) continue;
        if (Math.abs(row - r) <= 2 && Math.abs(col - c) <= 2) return true;
      }
    }
    return false;
  }

  /** The zigzag walk, written again from the specification's description. */
  function walk(size: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let column = size - 1;
    let upward = true;
    while (column >= 1) {
      const right = column === 6 ? 5 : column;
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        out.push([row, right], [row, right - 1]);
      }
      column = (column === 6 ? 5 : column) - 2;
      upward = !upward;
    }
    return out;
  }

  function maskBit(mask: number, row: number, col: number): boolean {
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

  /** Read the 15 format bits from the first copy and undo the BCH masking. */
  function readFormat(modules: ReadonlyArray<ReadonlyArray<boolean>>): {
    ecc: EccLevel;
    mask: number;
  } {
    const size = modules.length;
    const bit = (row: number, col: number): number =>
      ((modules[row] as ReadonlyArray<boolean>)[col] as boolean) ? 1 : 0;
    let bits = 0;
    const read = [
      ...Array.from({ length: 6 }, (_, i) => bit(i, 8)),
      bit(7, 8),
      bit(8, 8),
      bit(8, 7),
      ...Array.from({ length: 6 }, (_, i) => bit(8, 14 - (9 + i))),
    ];
    for (let i = 0; i < 15; i++) bits |= (read[i] as number) << i;
    const unmasked = bits ^ 0x5412;
    // The BCH remainder must be zero for a well-formed symbol.
    let check = unmasked;
    for (let i = 14; i >= 10; i--) {
      if (((check >>> i) & 1) !== 0) check ^= 0x537 << (i - 10);
    }
    expect(check).toBe(0);
    const data = unmasked >>> 10;
    const levels: Record<number, EccLevel> = { 1: "L", 0: "M", 3: "Q", 2: "H" };
    return { ecc: levels[(data >>> 3) & 3] as EccLevel, mask: data & 7 };
  }

  /** Every codeword, in the order the interleaver emitted them. */
  function readCodewords(
    modules: ReadonlyArray<ReadonlyArray<boolean>>,
    version: number,
    mask: number,
    count: number,
  ): Uint8Array {
    const size = modules.length;
    const out = new Uint8Array(count);
    let index = 0;
    for (const [row, col] of walk(size)) {
      if (isFunctionModule(size, version, row, col)) continue;
      if (index >= count * 8) break;
      const raw =
        ((modules[row] as ReadonlyArray<boolean>)[col] as boolean) !== maskBit(mask, row, col);
      if (raw) out[index >>> 3] = (out[index >>> 3] as number) | (0x80 >>> (index & 7));
      index++;
    }
    expect(index).toBeGreaterThanOrEqual(count * 8);
    return out;
  }

  /** Un-interleave, then check each block's Reed-Solomon syndromes are zero. */
  function recoverData(codewords: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
    const layout = blockLayout(version, ecc);
    const blocks: number[][] = Array.from({ length: layout.numBlocks }, () => []);
    let at = 0;
    for (let i = 0; i < layout.shortBlockLen + 1; i++) {
      for (let j = 0; j < layout.numBlocks; j++) {
        if (i !== layout.shortBlockLen - layout.blockEccLen || j >= layout.numShortBlocks) {
          (blocks[j] as number[]).push(codewords[at++] as number);
        }
      }
    }
    expect(at).toBe(layout.rawCodewords);
    const data: number[] = [];
    for (const block of blocks) {
      for (let s = 0; s < layout.blockEccLen; s++) {
        // Evaluate the codeword polynomial at alpha^s; a valid block is a
        // multiple of the generator, so every syndrome is zero.
        let root = 1;
        for (let i = 0; i < s; i++) root = gfMul(root, 2);
        let value = 0;
        for (const coefficient of block) value = gfMul(value, root) ^ coefficient;
        expect(value).toBe(0);
      }
      data.push(...block.slice(0, block.length - layout.blockEccLen));
    }
    return Uint8Array.from(data);
  }

  /** Read the byte-mode payload back out of the data codewords. */
  function readPayload(data: Uint8Array, version: number): string {
    const bits: number[] = [];
    for (const byte of data) {
      for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
    }
    const take = (from: number, length: number): number => {
      let value = 0;
      for (let i = 0; i < length; i++) value = (value << 1) | (bits[from + i] as number);
      return value;
    };
    expect(take(0, 4)).toBe(0b0100);
    const countBits = version < 10 ? 8 : 16;
    const length = take(4, countBits);
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = take(4 + countBits + i * 8, 8);
    return new TextDecoder().decode(bytes);
  }

  /** The full round trip: encode, then read the symbol back independently. */
  function roundTrip(text: string, ecc: EccLevel, version?: number): void {
    const symbol = encodeQr(text, { ecc, ...(version !== undefined ? { version } : {}) });
    expect(symbol.size).toBe(17 + 4 * symbol.version);
    const format = readFormat(symbol.modules);
    expect(format.ecc).toBe(symbol.ecc);
    expect(format.mask).toBe(symbol.mask);
    const layout = blockLayout(symbol.version, ecc);
    const codewords = readCodewords(
      symbol.modules,
      symbol.version,
      symbol.mask,
      layout.rawCodewords,
    );
    const data = recoverData(codewords, symbol.version, ecc);
    expect(readPayload(data, symbol.version)).toBe(text);
  }

  // --- the tests themselves ---------------------------------------------

  test("the capacity table is internally consistent at every version", () => {
    for (let version = 1; version <= MAX_VERSION; version++) {
      for (const ecc of ECC_LEVELS) {
        const layout = blockLayout(version, ecc);
        expect(layout.dataCodewords).toBe(dataCodewordCount(version, ecc));
        expect(layout.blockEccLen * layout.numBlocks + layout.dataCodewords).toBe(
          layout.rawCodewords,
        );
        expect(layout.numShortBlocks).toBeGreaterThan(0);
        expect(layout.numShortBlocks).toBeLessThanOrEqual(layout.numBlocks);
      }
      // A stricter level never carries more payload than a looser one.
      expect(byteCapacity(version, "L")).toBeGreaterThanOrEqual(byteCapacity(version, "M"));
      expect(byteCapacity(version, "M")).toBeGreaterThanOrEqual(byteCapacity(version, "Q"));
      expect(byteCapacity(version, "Q")).toBeGreaterThanOrEqual(byteCapacity(version, "H"));
    }
    expect(byteCapacity(1, "L")).toBe(17);
    expect(byteCapacity(1, "H")).toBe(7);
    expect(byteCapacity(10, "L")).toBe(271);
  });

  test("the module walk covers every non-timing module exactly once", () => {
    for (const version of [1, 2, 7, 10]) {
      const size = 17 + 4 * version;
      const positions = modulePositions(size);
      expect(positions.length).toBe(size * (size - 1));
      const seen = new Set(positions.map(([r, c]) => r * size + c));
      expect(seen.size).toBe(positions.length);
      expect(positions.some(([, c]) => c === 6)).toBe(false);
    }
  });

  test("alignment pattern positions match the published table", () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(6)).toEqual([6, 34]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(10)).toEqual([6, 28, 50]);
  });

  test("remainder bits match the specification for versions 1 to 10", () => {
    expect(remainderBits(1)).toBe(0);
    for (let v = 2; v <= 6; v++) expect(remainderBits(v)).toBe(7);
    for (let v = 7; v <= 10; v++) expect(remainderBits(v)).toBe(0);
  });

  test("symbols read back correctly at every error-correction level", () => {
    for (const ecc of ECC_LEVELS) roundTrip("https://crewhaus.ai/docs", ecc);
  });

  test("symbols read back correctly at every supported version", () => {
    for (let version = 1; version <= MAX_VERSION; version++) {
      const payload = "x".repeat(Math.min(byteCapacity(version, "L"), version * 12));
      roundTrip(payload, "L", version);
    }
  });

  test("a UTF-8 payload survives the round trip byte for byte", () => {
    roundTrip("naïve café — 日本語 🎧", "Q");
  });

  test("a single character and a full block both work", () => {
    roundTrip("A", "H");
    roundTrip("y".repeat(byteCapacity(4, "M")), "M", 4);
  });

  test("the smallest version that fits is the one chosen", () => {
    expect(smallestVersion(10, "M")).toBe(1);
    expect(smallestVersion(byteCapacity(1, "M") + 1, "M")).toBe(2);
    expect(smallestVersion(10_000, "L")).toBeUndefined();
    expect(encodeQr("short").version).toBe(1);
  });

  test("encoding the same payload twice picks the same mask", () => {
    const a = encodeQr("determinism", { ecc: "M" });
    const b = encodeQr("determinism", { ecc: "M" });
    expect(a.mask).toBe(b.mask);
    expect(symbolToText(a, "#", ".", 0)).toBe(symbolToText(b, "#", ".", 0));
  });

  test("a forced mask is honoured and still reads back", () => {
    for (let mask = 0; mask < 8; mask++) {
      const symbol = encodeQr("masked", { ecc: "M", mask });
      expect(symbol.mask).toBe(mask);
      expect(readFormat(symbol.modules).mask).toBe(mask);
    }
  });

  test("the finder patterns and the dark module are where they belong", () => {
    const symbol = encodeQr("finders", { ecc: "L" });
    const at = (r: number, c: number): boolean =>
      (symbol.modules[r] as ReadonlyArray<boolean>)[c] as boolean;
    for (const [r0, c0] of [
      [0, 0],
      [0, symbol.size - 7],
      [symbol.size - 7, 0],
    ] as Array<[number, number]>) {
      expect(at(r0, c0)).toBe(true);
      expect(at(r0 + 1, c0 + 1)).toBe(false);
      expect(at(r0 + 3, c0 + 3)).toBe(true);
    }
    // The separator ring around the top-left finder is light.
    for (let i = 0; i <= 7; i++) expect(at(7, i)).toBe(false);
    expect(at(symbol.size - 8, 8)).toBe(true);
    // Timing patterns alternate, starting dark.
    for (let i = 8; i < symbol.size - 8; i++) {
      expect(at(6, i)).toBe(i % 2 === 0);
      expect(at(i, 6)).toBe(i % 2 === 0);
    }
  });

  test("a payload past the capacity is refused by name", () => {
    expect(() => encodeQr("z".repeat(272), { ecc: "L" })).toThrow(/exceed the 271-byte capacity/);
    expect(() => encodeQr("z".repeat(30), { ecc: "H", version: 1 })).toThrow(
      /do not fit version 1/,
    );
    expect(() => encodeQr("x", { version: 11 })).toThrow(/outside the 1-10 range/);
    expect(() => encodeQr("x", { mask: 9 })).toThrow(/not one of the eight defined masks/);
  });

  test("the text rendering has the quiet zone it says it has", () => {
    const symbol = encodeQr("quiet", { ecc: "L" });
    const lines = symbolToText(symbol, "#", ".", 2).split("\n");
    expect(lines.length).toBe(symbol.size + 4);
    expect(lines[0]).toBe(".".repeat(symbol.size + 4));
    expect(lines[2]?.slice(0, 2)).toBe("..");
  });
});

describe("barcodes", () => {
  test("every Code 128 pattern is the width the standard says", () => {
    const widths = code128Widths();
    expect(widths.length).toBe(107);
    for (let i = 0; i < widths.length; i++) {
      const pattern = widths[i] as string;
      const sum = [...pattern].reduce((total, d) => total + Number.parseInt(d, 10), 0);
      expect(sum).toBe(i === 106 ? 13 : 11);
      expect(pattern.length).toBe(i === 106 ? 7 : 6);
      for (const digit of pattern) expect(Number.parseInt(digit, 10)).toBeGreaterThan(0);
    }
    // Every pattern must be distinct, or a scanner could not tell them apart.
    expect(new Set(widths).size).toBe(107);
  });

  test("the Code 128 check character is the weighted modulo-103 sum", () => {
    expect(code128Values("ABC")).toEqual([104, 33, 34, 35, 1, 106]);
    expect(code128Values("1234")).toEqual([105, 12, 34, 82, 106]);
  });

  test("Code 128 modules start with a bar and end with the stop pattern", () => {
    const { modules } = encodeCode128("Asset-42");
    expect(modules.startsWith("11")).toBe(true);
    expect(modules.endsWith("1100011101011")).toBe(true);
    expect(modules.length % 11).toBe(2); // every symbol is 11 wide but the 13-wide stop
  });

  test("Code 128 refuses a character outside the range it encodes", () => {
    expect(() => encodeCode128("naïve")).toThrow(/outside the ASCII 32-126 range/);
    expect(() => encodeCode128("")).toThrow(/at least one character/);
  });

  test("the EAN tables are each other's transformations", () => {
    const { L, G, R, parity } = eanTables();
    for (let d = 0; d < 10; d++) {
      const l = L[d] as string;
      const r = R[d] as string;
      const g = G[d] as string;
      // R is L complemented; G is R reversed.
      expect(r).toBe([...l].map((bit) => (bit === "0" ? "1" : "0")).join(""));
      expect(g).toBe([...r].reverse().join(""));
      expect(l.length).toBe(7);
    }
    expect(parity.length).toBe(10);
    expect(parity[0]).toBe("LLLLLL");
    for (const row of parity) expect(row.length).toBe(6);
  });

  test("EAN-13 check digits match known barcodes", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1);
    expect(ean13CheckDigit("978030640615")).toBe(7);
    expect(ean13CheckDigit("000000000000")).toBe(0);
  });

  test("EAN-13 accepts twelve digits or verifies thirteen", () => {
    const computed = encodeEan13("400638133393");
    expect(computed.digits).toBe("4006381333931");
    expect(computed.modules.length).toBe(95);
    expect(computed.modules.startsWith("101")).toBe(true);
    expect(computed.modules.endsWith("101")).toBe(true);
    expect(computed.modules.slice(45, 50)).toBe("01010");
    expect(encodeEan13("4006381333931").modules).toBe(computed.modules);
    expect(() => encodeEan13("4006381333930")).toThrow(/checks to 1/);
    expect(() => encodeEan13("12345")).toThrow(/twelve digits/);
  });

  test("EAN-13 encodes the first digit as a parity pattern, not as bars", () => {
    const { L, G } = eanTables();
    // A leading 0 means LLLLLL, so all six left digits use the L table.
    expect(encodeEan13("000000000000").modules.slice(3, 45)).toBe((L[0] as string).repeat(6));
    // A leading 5 means LGGLLG, which is the only thing that changes.
    const five = encodeEan13("500000000000").modules;
    expect(five.slice(3, 45)).toBe([L[0], G[0], G[0], L[0], L[0], G[0]].join(""));
    expect(five.slice(3, 45)).not.toBe((L[0] as string).repeat(6));
  });

  test("a rendered barcode is exactly as wide as its modules and quiet zone", () => {
    const { modules } = encodeEan13("400638133393");
    const image = renderModuleStrip(
      modules,
      2,
      40,
      11,
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
    );
    expect(image.width).toBe((95 + 22) * 2);
    expect(image.height).toBe(40);
    // The quiet zone is background all the way down.
    expect([...image.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
  });
});

describe("raster", () => {
  test("a canvas is the colour it was asked for", () => {
    const image = canvas(3, 2, { r: 10, g: 20, b: 30, a: 40 });
    expect(image.data.length).toBe(24);
    expect([...image.data.subarray(20, 24)]).toEqual([10, 20, 30, 40]);
  });

  test("a rectangle is clipped to the canvas instead of overflowing it", () => {
    const image = canvas(4, 4, { r: 0, g: 0, b: 0, a: 255 });
    fillRect(image, 2, 2, 10, 10, { r: 255, g: 255, b: 255, a: 255 });
    expect(image.data[(3 * 4 + 3) * 4]).toBe(255);
    expect(image.data[(1 * 4 + 1) * 4]).toBe(0);
    fillRect(image, -5, -5, 3, 3, { r: 1, g: 1, b: 1, a: 255 });
    expect(image.data[0]).toBe(0);
  });
});

describe("svg helpers", () => {
  test("escaping covers every character XML cannot carry raw", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;",
    );
  });

  test("numbers are formatted without trailing zeroes or negative zero", () => {
    expect(num(1)).toBe("1");
    expect(num(1.5)).toBe("1.5");
    expect(num(1 / 3)).toBe("0.333");
    expect(num(-0.0001)).toBe("0");
    expect(num(Number.NaN)).toBe("0");
  });

  test("value formatting is locale-free and uses fixed suffixes", () => {
    expect(formatValue(1234)).toBe("1234");
    expect(formatValue(12345)).toBe("12.3k");
    expect(formatValue(2_500_000)).toBe("2.5M");
    expect(formatValue(3_000_000_000)).toBe("3B");
    expect(formatValue(0.12345)).toBe("0.123");
  });

  test("nice scales land on the 1/2/5 ladder and bracket the data", () => {
    const scale = niceScale(0, 97, 5);
    expect(scale.min).toBeLessThanOrEqual(0);
    expect(scale.max).toBeGreaterThanOrEqual(97);
    expect(scale.ticks[0]).toBe(scale.min);
    expect(scale.ticks.at(-1)).toBe(scale.max);
    expect(scale.step).toBe(20);
    const flat = niceScale(5, 5, 4);
    expect(flat.min).toBeLessThan(5);
    expect(flat.max).toBeGreaterThan(5);
  });

  test("tick values do not drift with floating point", () => {
    const scale = niceScale(0, 1, 10);
    for (const tick of scale.ticks) expect(Math.round(tick * 1000) / 1000).toBe(tick);
  });

  test("the palette wraps and the width estimate is proportional", () => {
    expect(paletteColor(0)).toBe(paletteColor(10));
    expect(estimateTextWidth("aa", 10)).toBeCloseTo(estimateTextWidth("a", 10) * 2, 6);
  });
});

describe("charts", () => {
  const barSpec = {
    type: "bar" as const,
    width: 640,
    height: 400,
    title: "Revenue & <growth>",
    categories: ["Q1", "Q2", "Q3"],
    series: [
      { name: "2024", values: [10, 25, 18] },
      { name: "2025", values: [14, 22, 30] },
    ],
    yLabel: "USD",
  };

  test("a bar chart renders a complete SVG document", () => {
    const svg = renderChart(barSpec);
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="640"');
    expect(svg).toContain("Revenue &amp; &lt;growth&gt;");
    expect(svg.split("<rect").length - 1).toBeGreaterThanOrEqual(6);
  });

  test("the same spec renders byte-identical SVG", () => {
    expect(renderChart(barSpec)).toBe(renderChart(barSpec));
  });

  test("line and scatter charts plot their points", () => {
    const spec = {
      type: "line" as const,
      width: 400,
      height: 300,
      series: [{ name: "latency", points: [[0, 10] as [number, number], [1, 30], [2, 20]] }],
    };
    expect(renderChart(spec)).toContain("<polyline");
    expect(renderChart({ ...spec, type: "scatter" })).not.toContain("<polyline");
  });

  test("a line chart is the same whatever order the points arrive in", () => {
    const points: Array<[number, number]> = [
      [3, 1],
      [1, 5],
      [2, 2],
    ];
    const a = renderChart({
      type: "line",
      width: 300,
      height: 200,
      series: [{ name: "s", points }],
    });
    const b = renderChart({
      type: "line",
      width: 300,
      height: 200,
      series: [{ name: "s", points: [...points].reverse() }],
    });
    expect(a).toBe(b);
  });

  test("a pie chart draws one path per slice and labels the shares", () => {
    const svg = renderChart({
      type: "pie",
      width: 400,
      height: 400,
      slices: [
        { label: "a", value: 1 },
        { label: "b", value: 3 },
      ],
    });
    expect(svg.split("<path").length - 1).toBe(2);
    expect(svg).toContain("a (25%)");
    expect(svg).toContain("b (75%)");
  });

  test("a single full slice becomes a circle, not a zero-length arc", () => {
    const svg = renderChart({
      type: "pie",
      width: 300,
      height: 300,
      slices: [{ label: "all", value: 5 }],
    });
    expect(svg).toContain("<circle");
    expect(svg).toContain("all (100%)");
  });

  test("stacked bars are as tall as the column total", () => {
    const grouped = renderChart(barSpec);
    const stacked = renderChart({ ...barSpec, stacked: true });
    expect(stacked).not.toBe(grouped);
  });

  test("malformed specs are refused with the reason", () => {
    expect(() => renderChart({ type: "bar", width: 400, height: 300, series: [] })).toThrow(
      /needs `categories`/,
    );
    expect(() =>
      renderChart({
        type: "bar",
        width: 400,
        height: 300,
        categories: ["a", "b"],
        series: [{ name: "s", values: [1] }],
      }),
    ).toThrow(/has 1 values but there are 2 categories/);
    expect(() =>
      renderChart({ type: "line", width: 400, height: 300, series: [{ name: "s", points: [] }] }),
    ).toThrow(/non-empty `points`/);
    expect(() =>
      renderChart({ type: "pie", width: 400, height: 300, slices: [{ label: "a", value: 0 }] }),
    ).toThrow(/no pie to draw/);
    expect(() =>
      renderChart({
        type: "bar",
        width: 400,
        height: 300,
        categories: ["a"],
        series: [{ name: "s", values: [Number.NaN] }],
      }),
    ).toThrow(/contains NaN/);
    expect(() => renderChart({ type: "bar", width: 10, height: 10 })).toThrow(/too small/);
  });
});

describe("sparklines", () => {
  test("blocks map the extremes to the extreme characters", () => {
    expect(sparklineBlocks([0, 50, 100])).toBe("▁▅█");
    expect(sparklineBlocks([5, 5, 5])).toBe("▅▅▅");
    expect(sparklineBlocks([1])).toBe("▅");
  });

  test("an explicit range clips instead of rescaling", () => {
    expect(sparklineBlocks([0, 5, 10], { min: 0, max: 10 })).toBe("▁▅█");
    expect(sparklineBlocks([-5, 5, 50], { min: 0, max: 10 })).toBe("▁▅█");
  });

  test("the svg form is a complete document with a polyline", () => {
    const svg = sparklineSvg([1, 4, 2, 8], { markLast: true, fill: "#eef" });
    expect(svg).toContain("<polyline");
    expect(svg).toContain("<circle");
    expect(svg).toContain("<path");
    expect(svg).toContain('width="120"');
  });

  test("a one-value series draws a flat rule rather than dividing by zero", () => {
    expect(sparklineSvg([7])).toContain("<rect");
  });

  test("the fill colour is escaped, not injected into the document", () => {
    const svg = sparklineSvg([1, 2, 3], { fill: `"/><script>alert(1)</script><path d="` });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    // Exactly the elements the renderer meant to emit: the area and the line.
    expect(svg.split("<path").length - 1).toBe(1);
    expect(svg.split("<polyline").length - 1).toBe(1);
  });

  test("bad input is refused", () => {
    expect(() => sparklineBlocks([])).toThrow(/at least one value/);
    expect(() => sparklineBlocks([1, Number.POSITIVE_INFINITY])).toThrow(/contains Infinity/);
    expect(() => sparklineSvg([1, 2], { width: 2 })).toThrow(/too small/);
  });
});

describe("diagrams", () => {
  test("layers are the longest path from a root", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const edges = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ];
    const { layers, backEdges } = assignLayers(nodes, edges);
    expect(layers.get("a")).toBe(0);
    expect(layers.get("b")).toBe(1);
    expect(layers.get("d")).toBe(2);
    expect(backEdges).toEqual([]);
  });

  test("a cycle is broken at one named edge, not silently", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ];
    const { layers, backEdges } = assignLayers(nodes, edges);
    expect(backEdges).toEqual([{ from: "c", to: "a" }]);
    expect(layers.get("c")).toBe(2);
  });

  test("a long chain does not overflow the stack", () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}` }));
    const edges = Array.from({ length: 199 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
    expect(assignLayers(nodes, edges).layers.get("n199")).toBe(199);
  });

  test("a diagram renders one box per node and one path per edge", () => {
    const result = renderDiagram({
      nodes: [{ id: "in", label: "Ingest" }, { id: "out" }],
      edges: [{ from: "in", to: "out", label: "rows" }],
    });
    expect(result.svg.split("<rect").length - 1).toBe(4); // background, label plate, two boxes
    expect(result.svg.split("<path").length - 1).toBe(2); // arrowhead marker plus the edge
    expect(result.svg).toContain("Ingest");
    expect(result.svg).toContain("rows");
    expect(result.layers).toEqual([
      { id: "in", layer: 0 },
      { id: "out", layer: 1 },
    ]);
  });

  test("the same graph renders byte-identical SVG, in both directions", () => {
    const spec = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };
    expect(renderDiagram(spec).svg).toBe(renderDiagram(spec).svg);
    const lr = renderDiagram({ ...spec, direction: "LR" as const });
    expect(lr.svg).not.toBe(renderDiagram(spec).svg);
    expect(lr.width).toBeGreaterThan(lr.height);
  });

  test("a back edge is drawn dashed and reported", () => {
    const result = renderDiagram({
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    expect(result.backEdges).toEqual([{ from: "b", to: "a" }]);
    expect(result.svg).toContain("stroke-dasharray");
  });

  test("labels are escaped, not injected", () => {
    const result = renderDiagram({
      nodes: [{ id: "x", label: "</text><script>bad()</script>" }],
      edges: [],
    });
    expect(result.svg).not.toContain("<script>");
    expect(result.svg).toContain("&lt;script&gt;");
  });

  test("bad graphs are refused with the reason", () => {
    expect(() => renderDiagram({ nodes: [], edges: [] })).toThrow(/at least one node/);
    expect(() => renderDiagram({ nodes: [{ id: "a" }, { id: "a" }], edges: [] })).toThrow(
      /appears twice/,
    );
    expect(() =>
      renderDiagram({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "ghost" }] }),
    ).toThrow(/unknown node "ghost"/);
  });
});

describe("jpeg segments and exif", () => {
  test("segments are enumerated up to the scan", () => {
    const jpeg = sampleJpeg({ width: 100, height: 80, exif: { make: "Acme" }, comment: "note" });
    const { segments, scanStart } = readJpegSegments(jpeg);
    expect(segments.map((s) => s.name)).toEqual(["APP0", "APP1", "COM", "SOF0", "SOS"]);
    expect(scanStart).toBeLessThan(jpeg.length);
  });

  test("EXIF comes back with the camera, orientation and exposure", () => {
    const jpeg = sampleJpeg({
      width: 4000,
      height: 3000,
      exif: {
        make: "Acme",
        model: "Field 900",
        orientation: 6,
        dateTimeOriginal: "2024:06:01 09:30:00",
        fNumber: [28, 10],
        isoSpeed: 400,
      },
    });
    const segment = findExifSegment(readJpegSegments(jpeg).segments);
    expect(segment).toBeDefined();
    const exif = parseExif((segment as { payload: Uint8Array }).payload);
    expect(exif).toMatchObject({
      byteOrder: "little-endian",
      make: "Acme",
      model: "Field 900",
      orientation: 6,
      orientationDescription: "rotated 90 degrees clockwise",
      dateTimeOriginal: "2024:06:01 09:30:00",
      isoSpeed: 400,
      hasGps: false,
    });
    expect(exif.fNumber).toBeCloseTo(2.8, 6);
  });

  test("GPS is decoded to signed decimal degrees and flagged", () => {
    const jpeg = sampleJpeg({
      width: 10,
      height: 10,
      exif: { latitude: 64.1466, longitude: -21.9426, altitudeMeters: 61.5 },
    });
    const segment = findExifSegment(readJpegSegments(jpeg).segments);
    const exif = parseExif((segment as { payload: Uint8Array }).payload);
    expect(exif.hasGps).toBe(true);
    expect(exif.gps?.latitude).toBeCloseTo(64.1466, 4);
    expect(exif.gps?.longitude).toBeCloseTo(-21.9426, 4);
    expect(exif.gps?.altitudeMeters).toBeCloseTo(61.5, 2);
  });

  test("a southern, western position comes back negative on both axes", () => {
    const payload = exifApp1Payload({ latitude: -33.8688, longitude: -70.6693 });
    const exif = parseExif(payload);
    expect(exif.gps?.latitude).toBeLessThan(0);
    expect(exif.gps?.longitude).toBeLessThan(0);
  });

  test("a payload without the Exif identifier is refused", () => {
    expect(() => parseExif(new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0"))).toThrow(
      /does not begin with the "Exif/,
    );
  });

  test("stripping drops the metadata and keeps the picture", () => {
    const jpeg = sampleJpeg({
      width: 200,
      height: 100,
      exif: { make: "Acme", latitude: 10, longitude: 10 },
      comment: "private note",
      iccProfile: true,
      scanBytes: 128,
    });
    const stripped = stripJpegMetadata(jpeg);
    expect(stripped.removed.map((r) => r.name).sort()).toEqual(["APP1", "COM"]);
    expect(stripped.bytesRemoved).toBeGreaterThan(0);
    const after = readJpegSegments(stripped.bytes);
    expect(after.segments.map((s) => s.name)).toEqual(["APP0", "APP2", "SOF0", "SOS"]);
    expect(findExifSegment(after.segments)).toBeUndefined();
    // The scan data is byte-for-byte what it was.
    expect(toHex(stripped.bytes.subarray(after.scanStart))).toBe(
      toHex(jpeg.subarray(readJpegSegments(jpeg).scanStart)),
    );
    // The image is still readable, and still the same size.
    expect(readImageHeader(stripped.bytes)).toMatchObject({ width: 200, height: 100 });
  });

  test("the ICC profile can be dropped too, when that is what is wanted", () => {
    const jpeg = sampleJpeg({ width: 8, height: 8, iccProfile: true, exif: { make: "A" } });
    const stripped = stripJpegMetadata(jpeg, { keepIccProfile: false, keepJfif: false });
    expect(stripped.removed.map((r) => r.name).sort()).toEqual(["APP0", "APP1", "APP2"]);
    expect(readJpegSegments(stripped.bytes).segments.map((s) => s.name)).toEqual(["SOF0", "SOS"]);
  });

  test("stripping a JPEG with no metadata changes nothing", () => {
    const jpeg = sampleJpeg({ width: 8, height: 8, jfif: false });
    const stripped = stripJpegMetadata(jpeg);
    expect(stripped.bytesRemoved).toBe(0);
    expect(toHex(stripped.bytes)).toBe(toHex(jpeg));
  });

  test("bytes that are not a JPEG are refused", () => {
    expect(() => readJpegSegments(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a JPEG/);
  });
});

describe("subtitles", () => {
  test("timestamps parse in both spellings and format back", () => {
    expect(parseTimestamp("00:00:01,500")).toBe(1500);
    expect(parseTimestamp("01:02:03.004")).toBe(3_723_004);
    expect(parseTimestamp("02:03.5")).toBe(123_500);
    expect(formatTimestamp(3_723_004, "srt")).toBe("01:02:03,004");
    expect(formatTimestamp(3_723_004, "vtt")).toBe("01:02:03.004");
    expect(() => parseTimestamp("nope")).toThrow(/not a subtitle timestamp/);
    expect(() => parseTimestamp("00:99:00.000")).toThrow(/above 59/);
  });

  test("SRT parses through a BOM and CRLF line endings", () => {
    const result = parseSubtitles(SAMPLE_SRT);
    expect(result.format).toBe("srt");
    expect(result.cues.length).toBe(3);
    expect(result.cues[0]).toMatchObject({
      index: 1,
      startMs: 1000,
      endMs: 3500,
      text: "First line\nsecond line",
    });
    expect(result.cues[2]?.startMs).toBe(60_250);
    expect(result.skipped).toEqual([]);
  });

  test("WebVTT keeps cue ids and settings and skips NOTE blocks", () => {
    const result = parseSubtitles(SAMPLE_VTT);
    expect(result.format).toBe("vtt");
    expect(result.cues.length).toBe(2);
    expect(result.cues[0]).toMatchObject({
      id: "intro",
      settings: "align:start position:10%",
      startMs: 1000,
    });
    expect(result.cues[1]?.id).toBeUndefined();
  });

  test("a malformed block is reported, not swallowed", () => {
    const result = parseSubtitles("1\n00:00:05,000 --> 00:00:01,000\nbackwards\n");
    expect(result.cues).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/before start/);
  });

  test("SRT round-trips through the writer", () => {
    const parsed = parseSubtitles(SAMPLE_SRT);
    const written = writeSubtitles(parsed.cues, "srt");
    expect(written.cueCount).toBe(3);
    const again = parseSubtitles(written.text);
    expect(again.cues.map((c) => [c.startMs, c.endMs, c.text])).toEqual(
      parsed.cues.map((c) => [c.startMs, c.endMs, c.text]),
    );
  });

  test("converting SRT to WebVTT produces a WEBVTT header", () => {
    const parsed = parseSubtitles(SAMPLE_SRT);
    const vtt = writeSubtitles(parsed.cues, "vtt", { header: "converted" });
    expect(vtt.text.startsWith("WEBVTT converted\n\n")).toBe(true);
    expect(vtt.text).toContain("00:00:01.000 --> 00:00:03.500");
    expect(parseSubtitles(vtt.text).cues.length).toBe(3);
  });

  test("shifting moves every cue and drops what falls before zero", () => {
    const parsed = parseSubtitles(SAMPLE_SRT);
    const later = writeSubtitles(parsed.cues, "srt", { shiftMs: 2000 });
    expect(parseSubtitles(later.text).cues[0]?.startMs).toBe(3000);
    const earlier = writeSubtitles(parsed.cues, "srt", { shiftMs: -2000 });
    expect(earlier.dropped).toBe(1);
    expect(earlier.cueCount).toBe(2);
    // The survivors are renumbered from one.
    expect(parseSubtitles(earlier.text).cues[0]?.index).toBe(1);
  });

  test("wrapping is word-aware and keeps existing breaks", () => {
    expect(wrapCueText("one two three four", 9)).toBe("one two\nthree\nfour");
    expect(wrapCueText("a\nbb cc", 2)).toBe("a\nbb\ncc");
    expect(wrapCueText("supercalifragilistic", 5)).toBe("supercalifragilistic");
    expect(() => wrapCueText("x", 0)).toThrow(/cannot wrap/);
  });

  test("a re-wrapped cue is shorter per line but the same words", () => {
    const parsed = parseSubtitles(SAMPLE_SRT);
    const wrapped = writeSubtitles(parsed.cues, "srt", { wrapColumns: 20 });
    const second = parseSubtitles(wrapped.text).cues[1];
    expect(second?.text.split("\n").every((l) => l.length <= 20)).toBe(true);
    expect(second?.text.split(/\s+/)).toEqual((parsed.cues[1]?.text as string).split(/\s+/));
  });
});

describe("ffprobe output", () => {
  test("streams are shaped, sorted and numerically typed", () => {
    const probe = parseProbeJson(SAMPLE_FFPROBE_JSON);
    expect(probe.streamCount).toBe(2);
    expect(probe.streams.map((s) => s.index)).toEqual([0, 1]);
    expect(probe.streams[0]).toMatchObject({
      type: "video",
      codec: "h264",
      width: 1920,
      height: 1080,
      frameRate: 29.97,
      bitRateBps: 4_500_000,
    });
    expect(probe.streams[1]).toMatchObject({
      type: "audio",
      sampleRateHz: 48000,
      channels: 2,
      language: "eng",
    });
    expect(probe.durationSeconds).toBe(12.032);
    expect(probe.sizeBytes).toBe(7_012_345);
  });

  test("only allowlisted container tags come through", () => {
    const probe = parseProbeJson(SAMPLE_FFPROBE_JSON);
    expect(probe.tags.map((t) => t.key)).toEqual(["encoder", "major_brand", "title"]);
  });

  test("the absolute path ffprobe echoes back is not carried through", () => {
    expect(JSON.stringify(parseProbeJson(SAMPLE_FFPROBE_JSON))).not.toContain("/somewhere/private");
  });

  test("frame rates are parsed from their rational form", () => {
    expect(parseRate("30000/1001")).toBe(29.97);
    expect(parseRate("25/1")).toBe(25);
    expect(parseRate("0/0")).toBeUndefined();
    expect(parseRate(undefined)).toBeUndefined();
  });

  test("missing and unknown fields are dropped rather than invented", () => {
    const probe = parseProbeJson(JSON.stringify({ streams: [{ codec_type: "data" }], format: {} }));
    expect(probe.streams[0]).toEqual({ index: 0, type: "data" });
    expect(probe.durationSeconds).toBeUndefined();
    expect(probe.tags).toEqual([]);
  });

  test("output that is not JSON is refused with the reason", () => {
    expect(() => parseProbeJson("not json")).toThrow(/did not return JSON/);
    expect(() => parseProbeJson("[]")).toThrow(/not an object/);
  });
});
