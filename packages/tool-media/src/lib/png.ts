/**
 * A PNG encoder and decoder, written against the PNG specification (ISO
 * 15948) rather than pulled from a dependency, because a deterministic
 * package cannot ship a native image library and still promise the same
 * bytes on every machine.
 *
 * ## Writing — supported
 *
 * - 8-bit truecolour with alpha (colour type 6), truecolour (2), greyscale
 *   with alpha (4) and greyscale (0).
 * - One `IHDR`, one `IDAT`, one `IEND`. No interlacing, no ancillary
 *   chunks, no palette. The filter used on every scanline is chosen from
 *   None/Sub/Up/Average/Paeth by the minimum-sum-of-absolute-differences
 *   heuristic the specification itself suggests, which is a pure function
 *   of the pixels — so the same pixels always produce the same file.
 * - zlib compression comes from `node:zlib` at a pinned level, again so the
 *   bytes do not move underneath a caller comparing two renders.
 *
 * ## Reading — supported
 *
 * - Bit depth 8, colour types 0, 2, 3 (palette, with `tRNS`), 4 and 6.
 * - Multiple `IDAT` chunks, concatenated as the specification requires.
 * - `tRNS` for greyscale and truecolour (a single transparent sample value).
 * - The CRC of every chunk it reads is checked against the bytes, so a
 *   corrupt file is reported as corrupt rather than decoded into pixels that
 *   are not the picture.
 *
 * ## Reading — refused, loudly, rather than guessed at
 *
 * - Bit depths 1, 2, 4 and 16. A 16-bit image silently truncated to 8 bits
 *   is not the image the caller handed over.
 * - Adam7 interlacing.
 * - Any file whose declared dimensions exceed the caller's pixel cap. The
 *   check happens on `IHDR`, before a single byte is inflated, and the
 *   inflate itself is given `maxOutputLength` so a lying stream cannot get
 *   past it either.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { ByteReader, MediaFormatError, concatBytes, crc32, startsWith } from "./bytes";

export const PNG_SIGNATURE: ReadonlyArray<number> = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
];

/** Decoded pixels, always 8-bit RGBA, row-major, top-left origin. */
export type RgbaImage = {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes: R, G, B, A. */
  readonly data: Uint8Array;
};

export type PngColorType = "rgba" | "rgb" | "gray" | "gray-alpha";

const COLOR_TYPE_CODE: Record<PngColorType, number> = {
  gray: 0,
  rgb: 2,
  "gray-alpha": 4,
  rgba: 6,
};

const CHANNELS: Record<PngColorType, number> = { gray: 1, rgb: 3, "gray-alpha": 2, rgba: 4 };

/** What a decoded file turned out to be, for reporting back to the caller. */
export type PngDecoded = RgbaImage & {
  readonly sourceColorType: number;
  readonly sourceBitDepth: number;
  readonly hadAlpha: boolean;
};

/** A CRC as the eight hex digits a PNG tool would print it as. */
function hex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
  return concatBytes([u32(data.length), typeBytes, data, u32(crc32(typeBytes, data))]);
}

/** Greyscale luma, ITU-R BT.601, the coefficients PNG's own spec cites. */
export function luma(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

/**
 * True when every pixel is fully opaque — the fact `colorType: "auto"`
 * keys on when choosing between colour type 6 and the smaller type 2.
 */
export function isOpaque(image: RgbaImage): boolean {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] !== 255) return false;
  }
  return true;
}

/** True when every pixel's R, G and B are equal, so greyscale loses nothing. */
export function isGrayscale(image: RgbaImage): boolean {
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] !== image.data[i + 1] || image.data[i] !== image.data[i + 2]) return false;
  }
  return true;
}

/** The colour type `"auto"` resolves to for these pixels. */
export function autoColorType(image: RgbaImage): PngColorType {
  const opaque = isOpaque(image);
  const gray = isGrayscale(image);
  if (gray) return opaque ? "gray" : "gray-alpha";
  return opaque ? "rgb" : "rgba";
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Pack RGBA pixels into the raw sample stream for `colorType`. */
function packSamples(image: RgbaImage, colorType: PngColorType): Uint8Array {
  const bpp = CHANNELS[colorType];
  const out = new Uint8Array(image.width * image.height * bpp);
  const src = image.data;
  let o = 0;
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i] as number;
    const g = src[i + 1] as number;
    const b = src[i + 2] as number;
    const a = src[i + 3] as number;
    switch (colorType) {
      case "rgba":
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
        out[o++] = a;
        break;
      case "rgb":
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
        break;
      case "gray-alpha":
        out[o++] = luma(r, g, b);
        out[o++] = a;
        break;
      case "gray":
        out[o++] = luma(r, g, b);
        break;
    }
  }
  return out;
}

/**
 * Filter each scanline with whichever of the five filter types gives the
 * smallest sum of absolute signed differences, the heuristic in the PNG
 * spec's own "Filter selection" note. Pure in the pixels, so reproducible.
 */
function filterScanlines(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const row = samples.subarray(rowStart, rowStart + stride);
    let bestType = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const raw = row[x] as number;
        const left = x >= bpp ? (row[x - bpp] as number) : 0;
        const up = prev[x] as number;
        const upLeft = x >= bpp ? (prev[x - bpp] as number) : 0;
        let value: number;
        switch (type) {
          case 1:
            value = (raw - left) & 0xff;
            break;
          case 2:
            value = (raw - up) & 0xff;
            break;
          case 3:
            value = (raw - ((left + up) >> 1)) & 0xff;
            break;
          case 4:
            value = (raw - paeth(left, up, upLeft)) & 0xff;
            break;
          default:
            value = raw;
        }
        candidate[x] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(candidate);
      }
    }
    out[y * (stride + 1)] = bestType;
    out.set(best, y * (stride + 1) + 1);
    prev = row.slice();
  }
  return out;
}

export type EncodeOptions = {
  /** `"auto"` picks the smallest lossless type for these exact pixels. */
  readonly colorType?: PngColorType | "auto";
  /** zlib level, pinned so two runs of the same render compare equal. */
  readonly level?: number;
};

/** Encode RGBA pixels as a PNG file. */
export function encodePng(image: RgbaImage, options: EncodeOptions = {}): Uint8Array {
  if (image.width <= 0 || image.height <= 0) {
    throw new MediaFormatError(`cannot encode a ${image.width}x${image.height} image`);
  }
  const expected = image.width * image.height * 4;
  if (image.data.length !== expected) {
    throw new MediaFormatError(
      `pixel buffer is ${image.data.length} bytes, but ${image.width}x${image.height} RGBA needs ${expected}`,
    );
  }
  const requested = options.colorType ?? "auto";
  const colorType = requested === "auto" ? autoColorType(image) : requested;
  const bpp = CHANNELS[colorType];
  const samples = packSamples(image, colorType);
  const filtered = filterScanlines(samples, image.width, image.height, bpp);
  const idat = deflateSync(filtered, { level: options.level ?? 9 });
  const ihdr = concatBytes([
    u32(image.width),
    u32(image.height),
    new Uint8Array([8, COLOR_TYPE_CODE[colorType], 0, 0, 0]),
  ]);
  return concatBytes([
    new Uint8Array(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(idat.buffer, idat.byteOffset, idat.byteLength)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export type DecodeLimits = {
  /** Largest `width * height` this will decode. */
  readonly maxPixels: number;
};

export const DEFAULT_DECODE_LIMITS: DecodeLimits = Object.freeze({ maxPixels: 16_000_000 });

/** Header facts, read without inflating anything. */
export type PngHeader = {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlace: number;
};

/**
 * Read `IHDR` alone. Throws `MediaFormatError` if this is not a PNG.
 *
 * The CRC is checked BEFORE the fields are believed. Every cap downstream is
 * derived from these thirteen bytes, so a flipped bit here is the difference
 * between "this is a 4x4 image" and a dimension nothing else in the file
 * agrees with — and the honest answer to that is "this file is corrupt",
 * not a refusal that blames the caller for a size they never wrote.
 */
export function readPngHeader(bytes: Uint8Array): PngHeader {
  if (!startsWith(bytes, PNG_SIGNATURE)) {
    throw new MediaFormatError("not a PNG: the 8-byte signature does not match");
  }
  const reader = new ByteReader(bytes);
  reader.seek(8);
  const length = reader.u32be();
  const type = reader.ascii(4);
  if (type !== "IHDR" || length !== 13) {
    throw new MediaFormatError(`expected a 13-byte IHDR first, found a ${length}-byte ${type}`);
  }
  const declaredCrc = new ByteReader(bytes.subarray(8 + 8 + 13, 8 + 8 + 13 + 4)).u32be();
  const actualCrc = crc32(bytes.subarray(12, 16), bytes.subarray(16, 29));
  if (actualCrc !== declaredCrc) {
    throw new MediaFormatError(
      `chunk IHDR at offset 8 declares CRC ${hex8(declaredCrc)}, but its 13 bytes check to ${hex8(actualCrc)}`,
    );
  }
  const width = reader.u32be();
  const height = reader.u32be();
  const bitDepth = reader.u8();
  const colorType = reader.u8();
  reader.u8(); // compression method; only 0 is defined
  reader.u8(); // filter method; only 0 is defined
  const interlace = reader.u8();
  if (width === 0 || height === 0) {
    throw new MediaFormatError(`IHDR declares a ${width}x${height} image, which is not valid`);
  }
  return { width, height, bitDepth, colorType, interlace };
}

const SAMPLES_PER_PIXEL: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Chunks whose CRC is checked. Every chunk this decoder READS is here: a
 * corrupt `IDAT` that inflates anyway would hand back pixels that are not
 * the picture, and a flipped bit in `IHDR` or `PLTE` is worse still. Chunks
 * it skips are left alone, so an ancillary chunk written by something sloppy
 * does not stop a file this decoder can otherwise read correctly.
 */
const CRC_CHECKED: ReadonlySet<string> = new Set(["IHDR", "PLTE", "IDAT", "tRNS", "IEND"]);

/** Decode a PNG to 8-bit RGBA. */
export function decodePng(
  bytes: Uint8Array,
  limits: DecodeLimits = DEFAULT_DECODE_LIMITS,
): PngDecoded {
  const header = readPngHeader(bytes);
  const { width, height, bitDepth, colorType, interlace } = header;
  if (interlace !== 0) {
    throw new MediaFormatError("Adam7-interlaced PNGs are not supported by this decoder");
  }
  if (bitDepth !== 8) {
    throw new MediaFormatError(
      `bit depth ${bitDepth} is not supported; this decoder reads 8-bit samples only`,
    );
  }
  const channels = SAMPLES_PER_PIXEL[colorType];
  if (channels === undefined) {
    throw new MediaFormatError(`colour type ${colorType} is not a PNG colour type`);
  }
  // CAP FIRST. The dimensions come from the file, so they are checked before
  // anything sized by them is allocated or inflated.
  if (width * height > limits.maxPixels) {
    throw new MediaFormatError(
      `${width}x${height} is ${width * height} pixels, over the ${limits.maxPixels} cap`,
    );
  }

  const reader = new ByteReader(bytes);
  reader.seek(8);
  const idatParts: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  let paletteAlpha: Uint8Array | undefined;
  let transparentSample: ReadonlyArray<number> | undefined;
  let sawEnd = false;
  while (reader.remaining >= 8 && !sawEnd) {
    const chunkAt = reader.offset;
    const length = reader.u32be();
    const typeAt = reader.offset;
    const type = reader.ascii(4);
    if (length > bytes.length) {
      throw new MediaFormatError(`chunk ${type} declares ${length} bytes, longer than the file`);
    }
    const data = reader.take(length);
    const declaredCrc = reader.u32be();
    if (CRC_CHECKED.has(type)) {
      const actual = crc32(bytes.subarray(typeAt, typeAt + 4), data);
      if (actual !== declaredCrc) {
        throw new MediaFormatError(
          `chunk ${type} at offset ${chunkAt} declares CRC ${hex8(declaredCrc)}, but its ${length} bytes check to ${hex8(actual)}`,
        );
      }
    }
    switch (type) {
      case "IDAT":
        idatParts.push(data);
        break;
      case "PLTE":
        palette = data.slice();
        break;
      case "tRNS":
        if (colorType === 3) paletteAlpha = data.slice();
        else if (colorType === 0) transparentSample = [new ByteReader(data).u16be()];
        else if (colorType === 2) {
          const r = new ByteReader(data);
          transparentSample = [r.u16be(), r.u16be(), r.u16be()];
        }
        break;
      case "IEND":
        sawEnd = true;
        break;
      default:
        break;
    }
  }
  if (idatParts.length === 0) throw new MediaFormatError("the file carries no IDAT data");
  if (colorType === 3 && palette === undefined) {
    throw new MediaFormatError("a palette image with no PLTE chunk cannot be decoded");
  }

  const stride = width * channels;
  const rawSize = height * (stride + 1);
  // `maxOutputLength` makes the inflate itself refuse to exceed the size the
  // header implies, so a compression bomb aborts mid-stream.
  let raw: Uint8Array;
  try {
    const inflated = inflateSync(concatBytes(idatParts), { maxOutputLength: rawSize });
    raw = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  } catch (err) {
    throw new MediaFormatError(`the IDAT stream did not inflate: ${(err as Error).message}`);
  }
  if (raw.length < rawSize) {
    throw new MediaFormatError(
      `IDAT inflated to ${raw.length} bytes, short of the ${rawSize} the header implies`,
    );
  }

  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  let prev = new Uint8Array(stride);
  let hadAlpha = colorType === 4 || colorType === 6 || paletteAlpha !== undefined;
  if (transparentSample !== undefined) hadAlpha = true;

  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at] as number;
    for (let x = 0; x < stride; x++) {
      const value = raw[at + 1 + x] as number;
      const left = x >= channels ? (line[x - channels] as number) : 0;
      const up = prev[x] as number;
      const upLeft = x >= channels ? (prev[x - channels] as number) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new MediaFormatError(
            `scanline ${y} uses filter type ${filter}, which is not defined`,
          );
      }
      line[x] = restored & 0xff;
    }
    // Expand this scanline's samples to RGBA.
    let o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      switch (colorType) {
        case 0: {
          r = line[s] as number;
          g = r;
          b = r;
          if (transparentSample !== undefined && r === transparentSample[0]) a = 0;
          break;
        }
        case 2: {
          r = line[s] as number;
          g = line[s + 1] as number;
          b = line[s + 2] as number;
          if (
            transparentSample !== undefined &&
            r === transparentSample[0] &&
            g === transparentSample[1] &&
            b === transparentSample[2]
          ) {
            a = 0;
          }
          break;
        }
        case 3: {
          const index = line[s] as number;
          const pal = palette as Uint8Array;
          if (index * 3 + 2 >= pal.length) {
            throw new MediaFormatError(`palette index ${index} is outside the PLTE chunk`);
          }
          r = pal[index * 3] as number;
          g = pal[index * 3 + 1] as number;
          b = pal[index * 3 + 2] as number;
          if (paletteAlpha !== undefined && index < paletteAlpha.length) {
            a = paletteAlpha[index] as number;
          }
          break;
        }
        case 4: {
          r = line[s] as number;
          g = r;
          b = r;
          a = line[s + 1] as number;
          break;
        }
        default: {
          r = line[s] as number;
          g = line[s + 1] as number;
          b = line[s + 2] as number;
          a = line[s + 3] as number;
          break;
        }
      }
      out[o++] = r;
      out[o++] = g;
      out[o++] = b;
      out[o++] = a;
    }
    prev = line.slice();
  }

  return {
    width,
    height,
    data: out,
    sourceColorType: colorType,
    sourceBitDepth: bitDepth,
    hadAlpha,
  };
}
