/**
 * Identifying a file by what it IS, and reading the handful of facts every
 * image format puts in its header.
 *
 * Nothing here decodes an image. Every format below states its dimensions,
 * its sample depth and whether it carries an alpha channel within the first
 * few dozen bytes, so a caller can learn all of that from a slice of the
 * file rather than from a megabyte of pixels. The one exception is GIF
 * transparency, which lives in a Graphic Control Extension after the header
 * — that scan is bounded and gives up rather than reading the whole file.
 */
import { ByteReader, MediaFormatError, asciiAt, startsWith } from "./bytes";

/** A format this package can name from its magic bytes. */
export type FileKind = {
  /** Short, stable identifier: `"png"`, `"jpeg"`, `"mp4"`, … */
  readonly kind: string;
  readonly mediaType: string;
  /** Conventional extensions, lowercase, without the dot. First is preferred. */
  readonly extensions: ReadonlyArray<string>;
  /** Broad family, for a caller routing on it. */
  readonly family: "image" | "audio" | "video" | "document" | "archive" | "text" | "font";
};

type Signature = FileKind & { readonly match: (b: Uint8Array) => boolean };

const eq = (offset: number, text: string) => (b: Uint8Array) => asciiAt(b, offset, text);
const magic = (prefix: ReadonlyArray<number>) => (b: Uint8Array) => startsWith(b, prefix);

/** True for an ISO base-media file whose `ftyp` brand is in `brands`. */
function ftypBrand(bytes: Uint8Array, brands: ReadonlyArray<string>): boolean {
  if (!asciiAt(bytes, 4, "ftyp")) return false;
  for (const brand of brands) {
    if (asciiAt(bytes, 8, brand)) return true;
  }
  // Compatible brands follow the major brand and its 4-byte minor version.
  for (let at = 16; at + 4 <= Math.min(bytes.length, 64); at += 4) {
    for (const brand of brands) {
      if (asciiAt(bytes, at, brand)) return true;
    }
  }
  return false;
}

/**
 * Ordered: the first match wins, so more specific signatures come first
 * (AVIF and HEIC before the generic MP4 they share a container with).
 */
const SIGNATURES: ReadonlyArray<Signature> = [
  {
    kind: "png",
    mediaType: "image/png",
    extensions: ["png"],
    family: "image",
    match: magic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    kind: "jpeg",
    mediaType: "image/jpeg",
    extensions: ["jpg", "jpeg", "jpe"],
    family: "image",
    match: magic([0xff, 0xd8, 0xff]),
  },
  {
    kind: "gif",
    mediaType: "image/gif",
    extensions: ["gif"],
    family: "image",
    match: (b) => asciiAt(b, 0, "GIF87a") || asciiAt(b, 0, "GIF89a"),
  },
  {
    kind: "webp",
    mediaType: "image/webp",
    extensions: ["webp"],
    family: "image",
    match: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WEBP"),
  },
  {
    kind: "bmp",
    mediaType: "image/bmp",
    extensions: ["bmp", "dib"],
    family: "image",
    match: eq(0, "BM"),
  },
  {
    kind: "tiff",
    mediaType: "image/tiff",
    extensions: ["tif", "tiff"],
    family: "image",
    match: (b) => magic([0x49, 0x49, 0x2a, 0x00])(b) || magic([0x4d, 0x4d, 0x00, 0x2a])(b),
  },
  {
    kind: "ico",
    mediaType: "image/x-icon",
    extensions: ["ico"],
    family: "image",
    match: magic([0x00, 0x00, 0x01, 0x00]),
  },
  {
    kind: "avif",
    mediaType: "image/avif",
    extensions: ["avif"],
    family: "image",
    match: (b) => ftypBrand(b, ["avif", "avis"]),
  },
  {
    kind: "heic",
    mediaType: "image/heic",
    extensions: ["heic", "heif"],
    family: "image",
    match: (b) => ftypBrand(b, ["heic", "heix", "mif1", "msf1"]),
  },
  {
    kind: "mp4",
    mediaType: "video/mp4",
    extensions: ["mp4", "m4v", "m4a"],
    family: "video",
    match: (b) => ftypBrand(b, ["isom", "mp41", "mp42", "M4V ", "M4A ", "dash", "iso2"]),
  },
  {
    kind: "matroska",
    mediaType: "video/webm",
    extensions: ["webm", "mkv"],
    family: "video",
    match: magic([0x1a, 0x45, 0xdf, 0xa3]),
  },
  {
    kind: "quicktime",
    mediaType: "video/quicktime",
    extensions: ["mov"],
    family: "video",
    match: (b) => ftypBrand(b, ["qt  "]),
  },
  {
    kind: "ogg",
    mediaType: "application/ogg",
    extensions: ["ogg", "oga", "ogv", "opus"],
    family: "audio",
    match: eq(0, "OggS"),
  },
  {
    kind: "wav",
    mediaType: "audio/wav",
    extensions: ["wav"],
    family: "audio",
    match: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WAVE"),
  },
  {
    kind: "flac",
    mediaType: "audio/flac",
    extensions: ["flac"],
    family: "audio",
    match: eq(0, "fLaC"),
  },
  {
    kind: "mp3",
    mediaType: "audio/mpeg",
    extensions: ["mp3"],
    family: "audio",
    // An ID3v2 tag, or a bare MPEG audio frame sync with a valid layer.
    match: (b) =>
      asciiAt(b, 0, "ID3") ||
      (b.length > 1 &&
        b[0] === 0xff &&
        ((b[1] as number) & 0xe0) === 0xe0 &&
        (((b[1] as number) >> 1) & 0x03) !== 0),
  },
  {
    kind: "pdf",
    mediaType: "application/pdf",
    extensions: ["pdf"],
    family: "document",
    match: eq(0, "%PDF-"),
  },
  {
    kind: "zip",
    mediaType: "application/zip",
    extensions: ["zip"],
    family: "archive",
    match: magic([0x50, 0x4b, 0x03, 0x04]),
  },
  {
    kind: "gzip",
    mediaType: "application/gzip",
    extensions: ["gz"],
    family: "archive",
    match: magic([0x1f, 0x8b]),
  },
  {
    kind: "woff2",
    mediaType: "font/woff2",
    extensions: ["woff2"],
    family: "font",
    match: eq(0, "wOF2"),
  },
];

/** Leading whitespace and an optional UTF-8 BOM, for the text sniffs. */
function textHead(bytes: Uint8Array, limit = 512): string {
  let start = 0;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) start = 3;
  const slice = bytes.subarray(start, Math.min(bytes.length, start + limit));
  return new TextDecoder("utf-8", { fatal: false }).decode(slice).trimStart();
}

const SVG: FileKind = {
  kind: "svg",
  mediaType: "image/svg+xml",
  extensions: ["svg"],
  family: "image",
};

/**
 * Name the format from the bytes. Returns `undefined` when nothing matches,
 * which is the honest answer — "unknown" beats a guess from the extension.
 */
export function detectKind(bytes: Uint8Array): FileKind | undefined {
  for (const signature of SIGNATURES) {
    if (signature.match(bytes)) {
      const { match: _match, ...kind } = signature;
      return kind;
    }
  }
  // SVG has no magic number; it is XML, so it is sniffed last and only from
  // a leading `<svg` or an XML declaration followed by one.
  const head = textHead(bytes);
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return SVG;
  return undefined;
}

/** Every format `detectKind` can name, sorted, for a tool to report. */
export function knownKinds(): ReadonlyArray<string> {
  return [...SIGNATURES.map((s) => s.kind), SVG.kind].sort();
}

/** Look up the kinds an extension conventionally names. */
export function kindsForExtension(extension: string): ReadonlyArray<string> {
  const ext = extension.replace(/^\./, "").toLowerCase();
  const out: string[] = [];
  for (const signature of [...SIGNATURES, SVG]) {
    if (signature.extensions.includes(ext)) out.push(signature.kind);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Header facts

export type ImageHeader = {
  readonly format: string;
  readonly width: number;
  readonly height: number;
  /** Bits per sample (per channel), where the format states one. */
  readonly bitDepth?: number;
  /** A human-readable colour model: `"rgb"`, `"palette"`, `"ycbcr"`, … */
  readonly colorType: string;
  readonly hasAlpha: boolean;
  /** Anything worth saying that does not fit the fields above. */
  readonly notes?: ReadonlyArray<string>;
};

const PNG_COLOR_TYPES: Record<number, string> = {
  0: "grayscale",
  2: "rgb",
  3: "palette",
  4: "grayscale-alpha",
  6: "rgba",
};

function pngHeader(bytes: Uint8Array): ImageHeader {
  const reader = new ByteReader(bytes);
  reader.seek(8);
  reader.u32be();
  reader.ascii(4);
  const width = reader.u32be();
  const height = reader.u32be();
  const bitDepth = reader.u8();
  const colorType = reader.u8();
  reader.u8();
  reader.u8();
  const interlace = reader.u8();
  reader.skip(4); // the IHDR chunk's CRC
  // `tRNS` gives an otherwise opaque colour type transparency; look for it
  // in the chunks that precede the first IDAT.
  let hasTrns = false;
  try {
    while (reader.remaining >= 8) {
      const length = reader.u32be();
      const type = reader.ascii(4);
      if (type === "IDAT" || type === "IEND") break;
      if (type === "tRNS") {
        hasTrns = true;
        break;
      }
      reader.skip(length + 4);
    }
  } catch {
    // A header slice that stops mid-chunk simply tells us nothing more.
  }
  const notes: string[] = [];
  if (interlace === 1) notes.push("Adam7 interlaced");
  if (hasTrns) notes.push("carries a tRNS transparency chunk");
  return {
    format: "png",
    width,
    height,
    bitDepth,
    colorType: PNG_COLOR_TYPES[colorType] ?? `unknown(${colorType})`,
    hasAlpha: colorType === 4 || colorType === 6 || hasTrns,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

const JPEG_PROGRESSIVE = new Set([0xc2, 0xc6, 0xca, 0xce]);

function jpegHeader(bytes: Uint8Array): ImageHeader {
  const reader = new ByteReader(bytes);
  reader.seek(2);
  while (reader.remaining >= 4) {
    let marker = reader.u8();
    if (marker !== 0xff) {
      // Re-synchronise: fill bytes of 0xFF are legal between segments.
      continue;
    }
    while (marker === 0xff && reader.remaining > 0) marker = reader.u8();
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    const length = reader.u16be();
    if (length < 2)
      throw new MediaFormatError(`JPEG segment FF${marker.toString(16)} has length ${length}`);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const precision = reader.u8();
      const height = reader.u16be();
      const width = reader.u16be();
      const components = reader.u8();
      const colorType =
        components === 1
          ? "grayscale"
          : components === 3
            ? "ycbcr"
            : components === 4
              ? "ycck-or-cmyk"
              : `${components}-component`;
      const notes: string[] = [];
      if (JPEG_PROGRESSIVE.has(marker)) notes.push("progressive");
      return {
        format: "jpeg",
        width,
        height,
        bitDepth: precision,
        colorType,
        // Baseline JPEG has no alpha channel at all.
        hasAlpha: false,
        ...(notes.length > 0 ? { notes } : {}),
      };
    }
    reader.skip(length - 2);
  }
  throw new MediaFormatError("no JPEG frame header (SOFn) found before the scan data");
}

function gifHeader(bytes: Uint8Array): ImageHeader {
  const reader = new ByteReader(bytes);
  const version = reader.ascii(6);
  const width = reader.u16le();
  const height = reader.u16le();
  const packed = reader.u8();
  const bitsPerColor = ((packed >> 4) & 0x07) + 1;
  const hasGlobalTable = (packed & 0x80) !== 0;
  // Transparency is declared per-frame in a Graphic Control Extension, so
  // scan for the first one. The scan is bounded by the slice it was given.
  let hasAlpha = false;
  for (let i = 13; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
      if (((bytes[i + 3] as number) & 0x01) !== 0) {
        hasAlpha = true;
        break;
      }
    }
  }
  return {
    format: "gif",
    width,
    height,
    bitDepth: bitsPerColor,
    colorType: "palette",
    hasAlpha,
    notes: [
      version,
      hasGlobalTable ? "global colour table" : "no global colour table",
      "alpha is a single fully transparent palette index, not a channel",
    ],
  };
}

function webpHeader(bytes: Uint8Array): ImageHeader {
  const reader = new ByteReader(bytes);
  reader.seek(12);
  const fourcc = reader.ascii(4);
  const length = reader.u32le();
  switch (fourcc) {
    case "VP8 ": {
      if (length < 10) throw new MediaFormatError("WebP VP8 chunk is too short for a frame header");
      reader.skip(3); // frame tag
      const sync = reader.take(3);
      if (sync[0] !== 0x9d || sync[1] !== 0x01 || sync[2] !== 0x2a) {
        throw new MediaFormatError("WebP VP8 frame is missing its 9D 01 2A start code");
      }
      const width = reader.u16le() & 0x3fff;
      const height = reader.u16le() & 0x3fff;
      return {
        format: "webp",
        width,
        height,
        colorType: "ycbcr",
        hasAlpha: false,
        notes: ["lossy (VP8)"],
      };
    }
    case "VP8L": {
      const signature = reader.u8();
      if (signature !== 0x2f)
        throw new MediaFormatError("WebP VP8L chunk is missing its 0x2F signature");
      const bits = reader.u32le();
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      const hasAlpha = ((bits >>> 28) & 0x01) === 1;
      return {
        format: "webp",
        width,
        height,
        colorType: "rgba",
        hasAlpha,
        notes: ["lossless (VP8L)"],
      };
    }
    case "VP8X": {
      const flags = reader.u8();
      reader.skip(3); // reserved
      const width = (reader.u8() | (reader.u8() << 8) | (reader.u8() << 16)) + 1;
      const height = (reader.u8() | (reader.u8() << 8) | (reader.u8() << 16)) + 1;
      const notes = ["extended (VP8X)"];
      if ((flags & 0x02) !== 0) notes.push("animated");
      if ((flags & 0x08) !== 0) notes.push("has an ICC profile");
      if ((flags & 0x04) !== 0) notes.push("has EXIF metadata");
      return {
        format: "webp",
        width,
        height,
        colorType: "rgba",
        hasAlpha: (flags & 0x10) !== 0,
        notes,
      };
    }
    default:
      throw new MediaFormatError(`WebP body starts with an unexpected "${fourcc}" chunk`);
  }
}

function bmpHeader(bytes: Uint8Array): ImageHeader {
  const reader = new ByteReader(bytes);
  reader.seek(14);
  const dibSize = reader.u32le();
  if (dibSize === 12) {
    // BITMAPCOREHEADER: 16-bit unsigned dimensions.
    const width = reader.u16le();
    const height = reader.u16le();
    reader.u16le(); // planes
    const bitCount = reader.u16le();
    return {
      format: "bmp",
      width,
      height,
      bitDepth: bitCount,
      colorType: bitCount <= 8 ? "palette" : "rgb",
      hasAlpha: false,
      notes: ["BITMAPCOREHEADER"],
    };
  }
  if (dibSize < 40)
    throw new MediaFormatError(`BMP DIB header is ${dibSize} bytes, too short to read`);
  const width = reader.i32le();
  const signedHeight = reader.i32le();
  reader.u16le(); // planes
  const bitCount = reader.u16le();
  const compression = reader.u32le();
  let hasAlpha = false;
  if (dibSize >= 108) {
    // BITMAPV4HEADER and later state the channel masks; an alpha mask of
    // zero means the 32nd bit is padding, not transparency.
    reader.skip(20); // image size, x/y ppm, colours used, colours important
    reader.u32le(); // red mask
    reader.u32le(); // green mask
    reader.u32le(); // blue mask
    hasAlpha = reader.u32le() !== 0;
  } else if (bitCount === 32 && compression === 6) {
    // BI_ALPHABITFIELDS.
    hasAlpha = true;
  }
  const notes = [`DIB header ${dibSize} bytes`];
  if (signedHeight < 0) notes.push("top-down row order");
  if (bitCount === 32 && !hasAlpha)
    notes.push("32bpp with no declared alpha mask: the 4th byte is padding");
  return {
    format: "bmp",
    width: Math.abs(width),
    height: Math.abs(signedHeight),
    bitDepth: bitCount,
    colorType: bitCount <= 8 ? "palette" : "rgb",
    hasAlpha,
    notes,
  };
}

/** The formats `readImageHeader` understands, in the order it tries them. */
export const HEADER_FORMATS: ReadonlyArray<string> = Object.freeze([
  "png",
  "jpeg",
  "gif",
  "webp",
  "bmp",
]);

/**
 * Dimensions and colour facts from a file header alone. Throws
 * `MediaFormatError` when the bytes are not one of `HEADER_FORMATS`, or
 * when they are but the header is malformed or truncated.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const detected = detectKind(bytes);
  switch (detected?.kind) {
    case "png":
      return pngHeader(bytes);
    case "jpeg":
      return jpegHeader(bytes);
    case "gif":
      return gifHeader(bytes);
    case "webp":
      return webpHeader(bytes);
    case "bmp":
      return bmpHeader(bytes);
    default:
      throw new MediaFormatError(
        `header reading covers ${HEADER_FORMATS.join(", ")}; these bytes are ${
          detected === undefined ? "not a recognised format" : detected.kind
        }`,
      );
  }
}
