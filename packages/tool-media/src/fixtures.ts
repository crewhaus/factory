/**
 * Binary fixtures, BUILT rather than committed.
 *
 * A checked-in .jpg or .webp is an opaque blob: nobody can see what a test
 * is actually asserting about, and nobody can adjust it. Every fixture here
 * is constructed byte by byte from readable parts, so a test that says "a
 * JPEG whose EXIF puts it in Reykjavik, rotated 90 degrees" has that file
 * written out in front of it.
 *
 * This file ships rather than living under a `.test` extension because the
 * type checker should check it too, and because the PNG builder below is
 * the only independent writer this package has for verifying its own
 * decoder — it writes every scanline with filter type 0, which is a path
 * `encodePng` never takes.
 */
import { deflateSync } from "node:zlib";
import { concatBytes, crc32 } from "./lib/bytes";

function u16le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32le(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function u16be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

// --- PNG -----------------------------------------------------------------

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = ascii(type);
  return concatBytes([u32be(data.length), typeBytes, data, u32be(crc32(typeBytes, data))]);
}

export const PNG_SIGNATURE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type HandPngOptions = {
  readonly width: number;
  readonly height: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  readonly colorType: number;
  /** Raw samples, row-major, WITHOUT the per-scanline filter byte. */
  readonly samples: Uint8Array;
  readonly palette?: Uint8Array;
  readonly transparency?: Uint8Array;
  /** Split the IDAT across this many chunks, to exercise concatenation. */
  readonly idatChunks?: number;
  readonly bitDepth?: number;
  readonly interlace?: number;
};

const CHANNELS_FOR: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * A PNG assembled by hand: filter type 0 on every scanline, one IHDR, the
 * requested ancillary chunks, and the IDAT stream optionally split. Written
 * independently of `encodePng` so the decoder is tested against something
 * other than this package's own encoder.
 */
export function handWrittenPng(options: HandPngOptions): Uint8Array {
  const { width, height, colorType, samples } = options;
  const channels = CHANNELS_FOR[colorType] ?? 1;
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    raw.set(samples.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = deflateSync(raw);
  const idat = new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  const parts: Uint8Array[] = [
    PNG_SIGNATURE_BYTES,
    pngChunk(
      "IHDR",
      concatBytes([
        u32be(width),
        u32be(height),
        new Uint8Array([options.bitDepth ?? 8, colorType, 0, 0, options.interlace ?? 0]),
      ]),
    ),
  ];
  if (options.palette !== undefined) parts.push(pngChunk("PLTE", options.palette));
  if (options.transparency !== undefined) parts.push(pngChunk("tRNS", options.transparency));
  const chunks = Math.max(1, options.idatChunks ?? 1);
  const per = Math.ceil(idat.length / chunks);
  for (let i = 0; i < chunks; i++) {
    parts.push(pngChunk("IDAT", idat.subarray(i * per, Math.min(idat.length, (i + 1) * per))));
  }
  parts.push(pngChunk("IEND", new Uint8Array(0)));
  return concatBytes(parts);
}

/** An RGBA sample buffer from a pure function of the coordinates. */
export function rgbaSamples(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number, number],
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  let o = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y);
      out[o++] = r;
      out[o++] = g;
      out[o++] = b;
      out[o++] = a;
    }
  }
  return out;
}

// --- EXIF and JPEG -------------------------------------------------------

type TiffEntry = { tag: number; type: number; count: number; bytes: Uint8Array };

function asciiEntry(tag: number, value: string): TiffEntry {
  const bytes = ascii(`${value}\0`);
  return { tag, type: 2, count: bytes.length, bytes };
}

function shortEntry(tag: number, value: number): TiffEntry {
  return { tag, type: 3, count: 1, bytes: u16le(value) };
}

function byteEntry(tag: number, value: number): TiffEntry {
  return { tag, type: 1, count: 1, bytes: new Uint8Array([value]) };
}

function longEntry(tag: number, value: number): TiffEntry {
  return { tag, type: 4, count: 1, bytes: u32le(value) };
}

function rationalEntry(tag: number, values: ReadonlyArray<[number, number]>): TiffEntry {
  const bytes = concatBytes(values.flatMap(([n, d]) => [u32le(n), u32le(d)]));
  return { tag, type: 5, count: values.length, bytes };
}

/**
 * Serialise one IFD at `ifdAt`, appending any value over four bytes to
 * `heap`, which starts at `heapAt`. Entries are written in ascending tag
 * order, as the TIFF specification requires.
 */
function writeIfd(
  entries: ReadonlyArray<TiffEntry>,
  ifdAt: number,
  heapAt: number,
  heap: Uint8Array[],
): Uint8Array {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const parts: Uint8Array[] = [u16le(sorted.length)];
  let heapSize = heap.reduce((sum, part) => sum + part.length, 0);
  for (const entry of sorted) {
    const inline = new Uint8Array(4);
    if (entry.bytes.length <= 4) {
      inline.set(entry.bytes, 0);
    } else {
      inline.set(u32le(heapAt + heapSize), 0);
      // Values are word-aligned, which every real writer does.
      const padded =
        entry.bytes.length % 2 === 0 ? entry.bytes : concatBytes([entry.bytes, new Uint8Array(1)]);
      heap.push(padded);
      heapSize += padded.length;
    }
    parts.push(u16le(entry.tag), u16le(entry.type), u32le(entry.count), inline);
  }
  parts.push(u32le(0)); // no next IFD
  void ifdAt;
  return concatBytes(parts);
}

export type ExifFixture = {
  readonly make?: string;
  readonly model?: string;
  readonly orientation?: number;
  readonly dateTimeOriginal?: string;
  readonly fNumber?: [number, number];
  readonly isoSpeed?: number;
  /** Decimal degrees; converted to the degrees/minutes/seconds the tags use. */
  readonly latitude?: number;
  readonly longitude?: number;
  readonly altitudeMeters?: number;
};

function toDms(value: number): Array<[number, number]> {
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutes = Math.floor((abs - degrees) * 60);
  // Thousandths of a second, so the fixture's coordinates survive the round
  // trip without a floating-point argument about the last decimal.
  const seconds = Math.round((abs - degrees - minutes / 60) * 3600 * 1000);
  return [
    [degrees, 1],
    [minutes, 1],
    [seconds, 1000],
  ];
}

/** An `APP1` payload: `Exif\0\0` plus a little-endian TIFF block. */
export function exifApp1Payload(fixture: ExifFixture): Uint8Array {
  const exifEntries: TiffEntry[] = [];
  if (fixture.dateTimeOriginal !== undefined) {
    exifEntries.push(asciiEntry(0x9003, fixture.dateTimeOriginal));
  }
  if (fixture.fNumber !== undefined) exifEntries.push(rationalEntry(0x829d, [fixture.fNumber]));
  if (fixture.isoSpeed !== undefined) exifEntries.push(shortEntry(0x8827, fixture.isoSpeed));

  const gpsEntries: TiffEntry[] = [];
  if (fixture.latitude !== undefined && fixture.longitude !== undefined) {
    gpsEntries.push(asciiEntry(0x0001, fixture.latitude >= 0 ? "N" : "S"));
    gpsEntries.push(rationalEntry(0x0002, toDms(fixture.latitude)));
    gpsEntries.push(asciiEntry(0x0003, fixture.longitude >= 0 ? "E" : "W"));
    gpsEntries.push(rationalEntry(0x0004, toDms(fixture.longitude)));
    if (fixture.altitudeMeters !== undefined) {
      gpsEntries.push(byteEntry(0x0005, fixture.altitudeMeters >= 0 ? 0 : 1));
      gpsEntries.push(
        rationalEntry(0x0006, [[Math.round(Math.abs(fixture.altitudeMeters) * 100), 100]]),
      );
    }
  }

  const ifd0Entries: TiffEntry[] = [];
  if (fixture.make !== undefined) ifd0Entries.push(asciiEntry(0x010f, fixture.make));
  if (fixture.model !== undefined) ifd0Entries.push(asciiEntry(0x0110, fixture.model));
  if (fixture.orientation !== undefined) {
    ifd0Entries.push(shortEntry(0x0112, fixture.orientation));
  }

  const sizeOf = (entries: ReadonlyArray<TiffEntry>): number => 2 + entries.length * 12 + 4;
  const hasExif = exifEntries.length > 0;
  const hasGps = gpsEntries.length > 0;
  // IFD0 gains a pointer entry for each sub-IFD that exists.
  const ifd0Count = ifd0Entries.length + (hasExif ? 1 : 0) + (hasGps ? 1 : 0);
  const ifd0At = 8;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifAt = ifd0At + ifd0Size;
  const gpsAt = exifAt + (hasExif ? sizeOf(exifEntries) : 0);
  const heapAt = gpsAt + (hasGps ? sizeOf(gpsEntries) : 0);

  if (hasExif) ifd0Entries.push(longEntry(0x8769, exifAt));
  if (hasGps) ifd0Entries.push(longEntry(0x8825, gpsAt));

  const heap: Uint8Array[] = [];
  const ifd0 = writeIfd(ifd0Entries, ifd0At, heapAt, heap);
  const exif = hasExif ? writeIfd(exifEntries, exifAt, heapAt, heap) : new Uint8Array(0);
  const gps = hasGps ? writeIfd(gpsEntries, gpsAt, heapAt, heap) : new Uint8Array(0);
  const tiff = concatBytes([ascii("II"), u16le(42), u32le(ifd0At), ifd0, exif, gps, ...heap]);
  return concatBytes([ascii("Exif"), new Uint8Array([0, 0]), tiff]);
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  return concatBytes([new Uint8Array([0xff, marker]), u16be(payload.length + 2), payload]);
}

export type JpegFixture = {
  readonly width: number;
  readonly height: number;
  readonly components?: number;
  readonly exif?: ExifFixture;
  readonly comment?: string;
  readonly iccProfile?: boolean;
  readonly jfif?: boolean;
  /** Bytes of pretend entropy-coded data; must contain no 0xFF. */
  readonly scanBytes?: number;
};

/**
 * A JPEG's SEGMENT STRUCTURE — a real marker sequence with a real SOF0 and
 * whatever metadata segments were asked for, and pretend scan data. It is
 * not a decodable picture, and nothing in this package decodes JPEG; what
 * it exercises is exactly what the readers here look at.
 */
export function sampleJpeg(fixture: JpegFixture): Uint8Array {
  const components = fixture.components ?? 3;
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (fixture.jfif !== false) {
    parts.push(
      jpegSegment(
        0xe0,
        concatBytes([
          ascii("JFIF"),
          new Uint8Array([0, 1, 2, 0]),
          u16be(72),
          u16be(72),
          new Uint8Array([0, 0]),
        ]),
      ),
    );
  }
  if (fixture.exif !== undefined) parts.push(jpegSegment(0xe1, exifApp1Payload(fixture.exif)));
  if (fixture.iccProfile === true) {
    parts.push(
      jpegSegment(
        0xe2,
        concatBytes([ascii("ICC_PROFILE"), new Uint8Array([0, 1, 1]), new Uint8Array(32).fill(7)]),
      ),
    );
  }
  if (fixture.comment !== undefined) parts.push(jpegSegment(0xfe, ascii(fixture.comment)));
  const sof = concatBytes([
    new Uint8Array([8]),
    u16be(fixture.height),
    u16be(fixture.width),
    new Uint8Array([components]),
    ...Array.from({ length: components }, (_, i) => new Uint8Array([i + 1, 0x11, 0])),
  ]);
  parts.push(jpegSegment(0xc0, sof));
  const sos = concatBytes([
    new Uint8Array([components]),
    ...Array.from({ length: components }, (_, i) => new Uint8Array([i + 1, 0])),
    new Uint8Array([0, 63, 0]),
  ]);
  parts.push(jpegSegment(0xda, sos));
  parts.push(new Uint8Array(fixture.scanBytes ?? 64).fill(0x42));
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concatBytes(parts);
}

// --- GIF, WebP, BMP ------------------------------------------------------

export function sampleGif(
  width: number,
  height: number,
  options: { transparent?: boolean; version?: "GIF87a" | "GIF89a" } = {},
): Uint8Array {
  const parts: Uint8Array[] = [
    ascii(options.version ?? "GIF89a"),
    u16le(width),
    u16le(height),
    // Global colour table, 8-bit colour resolution, two entries.
    new Uint8Array([0b1_111_0_000, 0, 0]),
    new Uint8Array([0, 0, 0, 255, 255, 255]),
  ];
  if (options.transparent === true) {
    // Graphic Control Extension with the transparency flag set.
    parts.push(new Uint8Array([0x21, 0xf9, 0x04, 0x01, 0, 0, 0x00, 0x00]));
  }
  parts.push(
    new Uint8Array([0x2c]),
    u16le(0),
    u16le(0),
    u16le(width),
    u16le(height),
    new Uint8Array([0, 2, 2, 0x44, 0x01, 0x00, 0x3b]),
  );
  return concatBytes(parts);
}

function riff(fourcc: string, payload: Uint8Array): Uint8Array {
  const chunk = concatBytes([
    ascii(fourcc),
    u32le(payload.length),
    payload,
    payload.length % 2 === 1 ? new Uint8Array(1) : new Uint8Array(0),
  ]);
  return concatBytes([ascii("RIFF"), u32le(4 + chunk.length), ascii("WEBP"), chunk]);
}

/** A lossless WebP header: dimensions and the alpha flag, nothing decodable. */
export function sampleWebpLossless(width: number, height: number, alpha: boolean): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  return riff("VP8L", concatBytes([new Uint8Array([0x2f]), u32le(bits >>> 0), new Uint8Array(8)]));
}

/** An extended WebP header, which is how an animated or alpha WebP starts. */
export function sampleWebpExtended(
  width: number,
  height: number,
  flags: { alpha?: boolean; animation?: boolean; icc?: boolean } = {},
): Uint8Array {
  const flagByte =
    (flags.alpha === true ? 0x10 : 0) |
    (flags.animation === true ? 0x02 : 0) |
    (flags.icc === true ? 0x08 : 0);
  const triple = (value: number): Uint8Array =>
    new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]);
  return riff(
    "VP8X",
    concatBytes([new Uint8Array([flagByte, 0, 0, 0]), triple(width - 1), triple(height - 1)]),
  );
}

/** A lossy WebP header, with the VP8 keyframe start code. */
export function sampleWebpLossy(width: number, height: number): Uint8Array {
  return riff(
    "VP8 ",
    concatBytes([
      new Uint8Array([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a]),
      u16le(width),
      u16le(height),
      new Uint8Array(4),
    ]),
  );
}

export function sampleBmp(
  width: number,
  height: number,
  options: { bitCount?: number; topDown?: boolean; alphaMask?: boolean } = {},
): Uint8Array {
  const bitCount = options.bitCount ?? 24;
  const dibSize = options.alphaMask === true ? 108 : 40;
  const header = concatBytes([
    u32le(dibSize),
    u32le(width),
    u32le(options.topDown === true ? -height >>> 0 : height),
    u16le(1),
    u16le(bitCount),
    u32le(options.alphaMask === true ? 3 : 0),
    u32le(0),
    u32le(2835),
    u32le(2835),
    u32le(0),
    u32le(0),
    ...(options.alphaMask === true
      ? [
          u32le(0x00ff0000),
          u32le(0x0000ff00),
          u32le(0x000000ff),
          u32le(0xff000000),
          new Uint8Array(dibSize - 56),
        ]
      : []),
  ]);
  const pixels = new Uint8Array(width * height * (bitCount / 8));
  const fileHeader = concatBytes([
    ascii("BM"),
    u32le(14 + header.length + pixels.length),
    u32le(0),
    u32le(14 + header.length),
  ]);
  return concatBytes([fileHeader, header, pixels]);
}

// --- Subtitles -----------------------------------------------------------

/** A three-cue SRT document, with CRLF line endings and a BOM. */
export const SAMPLE_SRT =
  "\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\nFirst line\r\nsecond line\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nA much longer caption that will need re-wrapping to fit\r\n\r\n3\r\n00:01:00,250 --> 00:01:02,000\r\nLast\r\n";

/** A WebVTT document with a NOTE block, a cue id and cue settings. */
export const SAMPLE_VTT =
  "WEBVTT - the sample\n\nNOTE this block is not a cue\n\nintro\n00:00:01.000 --> 00:00:03.500 align:start position:10%\nFirst line\n\n00:00:04.000 --> 00:00:06.000\nSecond\n";

/** ffprobe's JSON for a short H.264 clip with one audio track. */
export const SAMPLE_FFPROBE_JSON = JSON.stringify({
  streams: [
    {
      index: 1,
      codec_name: "aac",
      codec_long_name: "AAC (Advanced Audio Coding)",
      codec_type: "audio",
      sample_rate: "48000",
      channels: 2,
      channel_layout: "stereo",
      bit_rate: "128000",
      duration: "12.032000",
      tags: { language: "eng", title: "Main" },
    },
    {
      index: 0,
      codec_name: "h264",
      codec_long_name: "H.264 / AVC",
      codec_type: "video",
      profile: "High",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p",
      r_frame_rate: "30000/1001",
      avg_frame_rate: "30000/1001",
      bit_rate: "4500000",
      duration: "12.000000",
    },
  ],
  format: {
    filename: "/somewhere/private/clip.mp4",
    nb_streams: 2,
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    format_long_name: "QuickTime / MOV",
    duration: "12.032000",
    size: "7012345",
    bit_rate: "4661234",
    tags: { major_brand: "isom", title: "Sample clip", encoder: "Lavf60" },
  },
});
