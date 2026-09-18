/**
 * `@crewhaus/tool-media` — deterministic media tools.
 *
 * Image headers, PNG encoding and decoding, screenshot comparison, EXIF,
 * QR codes and barcodes, charts, sparklines and diagrams, subtitles, and a
 * probe for audio and video. Every format reader and writer here is
 * hand-written against its published specification: there is no image
 * library in this package, and nothing is pulled in at runtime.
 *
 * Two properties hold across the whole surface.
 *
 * **Determinism.** The same inputs against the same files produce the same
 * bytes, on any machine. Nothing reads the clock, nothing uses unseeded
 * randomness, listings are sorted, and text is formatted without a locale.
 * The single exception is `MediaProbe`, which shells out to `ffprobe` and
 * is therefore only as deterministic as the `ffprobe` on the machine — its
 * description says so.
 *
 * **Containment.** Every caller-supplied path goes through
 * `resolveSafe`, which refuses anything resolving outside the workspace
 * root, symlinks included. Every file read is size-checked before it is
 * read, every decode is capped before it allocates, and the one tool that
 * spawns a process bounds its runtime and its output.
 */
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { encodeCode128, encodeEan13 } from "./lib/barcode";
import { MediaFormatError, toHex } from "./lib/bytes";
import { type ChartSpec, renderChart } from "./lib/chart";
import {
  colorKeywords,
  contrastReport,
  parseColor,
  relativeLuminance,
  rgbToHsl,
  toHexString,
} from "./lib/color";
import { renderDiagram } from "./lib/diagram";
import { parseProbeJson } from "./lib/ffprobe";
import {
  HEADER_FORMATS,
  detectKind,
  kindsForExtension,
  knownKinds,
  readImageHeader,
} from "./lib/identify";
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
import {
  DEFAULT_DECODE_LIMITS,
  type PngColorType,
  type PngDecoded,
  type RgbaImage,
  decodePng,
  encodePng,
} from "./lib/png";
import {
  ECC_LEVELS,
  type EccLevel,
  MAX_VERSION,
  byteCapacity,
  encodeQr,
  symbolToText,
} from "./lib/qr";
import { renderModuleGrid, renderModuleStrip } from "./lib/raster";
import { sparklineBlocks, sparklineSvg } from "./lib/sparkline";
import { type Cue, type SubtitleFormat, parseSubtitles, writeSubtitles } from "./lib/subtitle";
import { type SafePath, ToolPermissionError, resolveSafe } from "./paths";
import {
  DEFAULT_PROCESS_TIMEOUT_MS,
  MAX_PROCESS_TIMEOUT_MS,
  describeFailure,
  runProcess,
} from "./proc";

/** Compact JSON — the reader is a model, and every byte returned is context. */
const json = (value: unknown): string => JSON.stringify(value);

/** Largest file any tool here reads whole. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** How much of a file a header reader looks at. Headers live near the front. */
const HEADER_WINDOW_BYTES = 1024 * 1024;
/** Largest image any tool here decodes, in pixels. */
const MAX_DECODE_PIXELS = 16_000_000;
/** Largest base64 pixel payload `PngWrite` accepts, before decoding it. */
const MAX_PIXEL_BASE64_CHARS = 90_000_000;
/** Largest base64 blob `PngRead` will hand back rather than refuse. */
const DEFAULT_MAX_RETURNED_BASE64 = 1_400_000;

/**
 * A caller mistake this package states in its own words: a wrong argument
 * combination, a file that is too big, a destination that already exists.
 * Distinct from a plain `Error` so `explain` can tell a message written FOR
 * the caller apart from a bug's message, which was written for nobody.
 */
class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

/**
 * Turn an expected failure into a readable sentence. A malformed file, a
 * path outside the workspace or a format this package does not read is an
 * ANSWER, not a crash: the model is told what went wrong and can act on it.
 *
 * Anything NOT in that list is a bug in this package, and returning its
 * message would hand the caller `undefined is not an object` where a result
 * belongs — indistinguishable from content. Those are rethrown.
 */
function explain(err: unknown): string | null {
  if (
    err instanceof MediaFormatError ||
    err instanceof ToolPermissionError ||
    err instanceof ToolInputError
  ) {
    return err.message;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return `no such file: ${(err as NodeJS.ErrnoException).path ?? ""}`;
  if (code === "EACCES") return `permission denied: ${(err as NodeJS.ErrnoException).path ?? ""}`;
  if (code === "EISDIR") return "that path is a directory, not a file";
  if (code === "EPERM" || code === "EROFS") {
    return `cannot write there: ${(err as NodeJS.ErrnoException).path ?? ""}`;
  }
  return null;
}

/** Run a tool body, converting the expected failures into a readable string. */
async function attempt(body: () => string | Promise<string>): Promise<string> {
  try {
    return await body();
  } catch (err) {
    const message = explain(err);
    if (message === null) throw err;
    return message;
  }
}

/**
 * Read a whole file after checking its size, so an enormous file is refused
 * rather than read and then rejected. The `stat` is on the RESOLVED path,
 * which is the same path the read uses.
 */
function readWhole(
  toolName: string,
  rel: string,
  maxBytes = MAX_FILE_BYTES,
): { path: SafePath; bytes: Uint8Array; size: number } {
  const path = resolveSafe(toolName, rel);
  const stats = statSync(path.real);
  if (stats.isDirectory()) throw new ToolInputError(`"${rel}" is a directory, not a file`);
  if (stats.size > maxBytes) {
    throw new ToolInputError(
      `"${rel}" is ${stats.size} bytes, over the ${maxBytes}-byte limit for this tool`,
    );
  }
  const fd = openSync(path.real, "r");
  try {
    const buffer = new Uint8Array(stats.size);
    let read = 0;
    while (read < stats.size) {
      const n = readSync(fd, buffer, read, stats.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { path, bytes: buffer.subarray(0, read), size: stats.size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read only the first `window` bytes. A header reader never needs more, and
 * reading the head of a 4 GB video must not cost 4 GB.
 */
function readHead(
  toolName: string,
  rel: string,
  window = HEADER_WINDOW_BYTES,
): { path: SafePath; bytes: Uint8Array; size: number } {
  const path = resolveSafe(toolName, rel);
  const stats = statSync(path.real);
  if (stats.isDirectory()) throw new ToolInputError(`"${rel}" is a directory, not a file`);
  const want = Math.min(window, stats.size);
  const fd = openSync(path.real, "r");
  try {
    const buffer = new Uint8Array(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, read);
      if (n === 0) break;
      read += n;
    }
    return { path, bytes: buffer.subarray(0, read), size: stats.size };
  } finally {
    closeSync(fd);
  }
}

/** Write bytes to a contained path, refusing to clobber unless told to. */
function writeSafe(
  toolName: string,
  rel: string,
  data: Uint8Array | string,
  overwrite: boolean,
): SafePath {
  const path = resolveSafe(toolName, rel);
  if (!overwrite) {
    let exists = true;
    try {
      statSync(path.real);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      exists = false;
    }
    if (exists) throw new ToolInputError(`"${rel}" already exists; pass overwrite to replace it`);
  }
  writeFileSync(path.real, data);
  return path;
}

/**
 * Decode a PNG from disk with this package's caps applied. The format is
 * checked from the MAGIC BYTES first, so a JPEG named `.png` gets told what
 * it actually is rather than "the signature does not match".
 */
function loadPng(
  toolName: string,
  rel: string,
  maxPixels = MAX_DECODE_PIXELS,
): { path: SafePath; image: PngDecoded } {
  const { path, bytes } = readWhole(toolName, rel);
  const kind = detectKind(bytes);
  if (kind?.kind !== "png") {
    throw new ToolInputError(
      `"${rel}" is ${kind === undefined ? "not a recognised format" : kind.kind}; this tool decodes PNG only (use ImageInfo for the header facts of other formats)`,
    );
  }
  return { path, image: decodePng(bytes, { maxPixels }) };
}

const pathField = z.string().min(1);
const overwriteField = z.boolean().optional().describe("replace the destination if it exists");

// ---------------------------------------------------------------------------
// Inspection

export const imageInfo: RegisteredTool = buildTool({
  name: "ImageInfo",
  description:
    "Read an image's dimensions, bit depth, colour model and whether it has an alpha channel, from the file header alone. Use before deciding how to handle an image, or to check a rendered asset came out the size it should have, without decoding a single pixel.",
  inputSchema: z.object({
    path: pathField.describe("a PNG, JPEG, GIF, WebP or BMP inside the workspace"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const { path, bytes, size } = readHead("ImageInfo", input.path);
      const header = readImageHeader(bytes);
      return json({
        path: path.rel,
        fileBytes: size,
        ...header,
        megapixels: Math.round((header.width * header.height) / 10_000) / 100,
        // A header may declare a zero dimension. Reporting `null` says the
        // ratio is undefined; the arithmetic would give Infinity or NaN,
        // both of which JSON renders as a bare `null` that reads like a bug.
        aspectRatio:
          header.height === 0 ? null : Math.round((header.width / header.height) * 1000) / 1000,
      });
    }),
});

export const imageKind: RegisteredTool = buildTool({
  name: "ImageKind",
  description:
    "Identify a file by its magic bytes and say whether the extension agrees with the content. Use when a file may be mislabelled — a .jpg that is really a PNG, or an upload with no extension at all — before handing it to something that trusts the name.",
  inputSchema: z.object({
    path: pathField.describe("any file inside the workspace"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const { path, bytes, size } = readHead("ImageKind", input.path, 4096);
      const kind = detectKind(bytes);
      const dot = path.rel.lastIndexOf(".");
      const extension = dot > 0 ? path.rel.slice(dot + 1).toLowerCase() : "";
      const expected = extension === "" ? [] : kindsForExtension(extension);
      const base = {
        path: path.rel,
        fileBytes: size,
        extension: extension === "" ? null : extension,
        magic: toHex(bytes.subarray(0, 8)),
      };
      if (kind === undefined) {
        return json({
          ...base,
          kind: null,
          recognised: false,
          note: `not one of the ${knownKinds().length} formats this tool recognises; the leading bytes are reported so a caller can look them up`,
        });
      }
      const agrees = expected.length === 0 ? null : expected.includes(kind.kind);
      return json({
        ...base,
        kind: kind.kind,
        recognised: true,
        mediaType: kind.mediaType,
        family: kind.family,
        expectedExtensions: kind.extensions,
        extensionAgrees: agrees,
        ...(agrees === false
          ? {
              warning: `the extension ".${extension}" names ${expected.join(" or ")}, but the content is ${kind.kind}`,
            }
          : {}),
      });
    }),
});

export const pngRead: RegisteredTool = buildTool({
  name: "PngRead",
  description:
    "Decode a PNG to raw RGBA pixels, or to per-channel statistics when the pixels would be too large to return. Use to inspect the actual colours in a rendered image, or to get pixels to transform and hand back to PngWrite.",
  inputSchema: z.object({
    path: pathField,
    region: z
      .object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional()
      .describe("decode the whole image, then return only this rectangle"),
    statsOnly: z
      .boolean()
      .optional()
      .describe("return per-channel means and extremes instead of the pixels"),
    maxBase64Chars: z
      .number()
      .int()
      .positive()
      .max(20_000_000)
      .optional()
      .describe(`cap on the returned pixel blob; default ${DEFAULT_MAX_RETURNED_BASE64}`),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const { path, image: decoded } = loadPng(
        "PngRead",
        input.path,
        DEFAULT_DECODE_LIMITS.maxPixels,
      );
      const image: RgbaImage =
        input.region === undefined
          ? decoded
          : cropImage(
              decoded,
              input.region.x,
              input.region.y,
              input.region.width,
              input.region.height,
            );
      const meta = {
        path: path.rel,
        width: image.width,
        height: image.height,
        fullWidth: decoded.width,
        fullHeight: decoded.height,
        sourceColorType: decoded.sourceColorType,
        sourceBitDepth: decoded.sourceBitDepth,
        hasAlpha: decoded.hadAlpha,
        pixelFormat: "rgba8",
      };
      if (input.statsOnly === true) {
        return json({ ...meta, stats: imageStats(image) });
      }
      const limit = input.maxBase64Chars ?? DEFAULT_MAX_RETURNED_BASE64;
      const base64Chars = Math.ceil(image.data.length / 3) * 4;
      if (base64Chars > limit) {
        return json({
          ...meta,
          pixels: null,
          refused: `${image.width}x${image.height} RGBA is ${base64Chars} base64 characters, over the ${limit} cap — pass a smaller \`region\`, or \`statsOnly\``,
        });
      }
      return json({ ...meta, pixels: Buffer.from(image.data).toString("base64") });
    }),
});

export const exifRead: RegisteredTool = buildTool({
  name: "ExifRead",
  description:
    "Read a JPEG's EXIF metadata: capture time, camera, lens, exposure, orientation, and GPS coordinates when the file carries them. Use before publishing or sharing a photograph, because `hasGps: true` means the file is carrying the location it was taken at.",
  inputSchema: z.object({ path: pathField.describe("a JPEG inside the workspace") }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const { path, bytes } = readHead("ExifRead", input.path);
      const kind = detectKind(bytes);
      if (kind?.kind !== "jpeg") {
        throw new ToolInputError(
          `"${input.path}" is ${kind === undefined ? "not a recognised format" : kind.kind}; EXIF reading here covers JPEG only`,
        );
      }
      const { segments } = readJpegSegments(bytes);
      const segment = findExifSegment(segments);
      if (segment === undefined) {
        return json({
          path: path.rel,
          hasExif: false,
          hasGps: false,
          note: "no APP1 EXIF segment; the file carries no EXIF metadata this reader can see",
          metadataSegments: segments
            .filter((s) => s.marker >= 0xe0 && s.marker <= 0xef)
            .map((s) => s.name)
            .sort(),
        });
      }
      const exif = parseExif(segment.payload);
      return json({
        path: path.rel,
        hasExif: true,
        ...exif,
        ...(exif.hasGps
          ? {
              privacyWarning:
                "this file records where it was taken; publishing it publishes that location. ExifStrip removes it.",
            }
          : {}),
      });
    }),
});

export const imageDiff: RegisteredTool = buildTool({
  name: "ImageDiff",
  description:
    "Compare two PNGs pixel by pixel and by perceptual hash, returning the fraction of pixels that differ and a bounding box around the change. Use as the screenshot-regression check: the bounding box says WHERE a render moved, and the hash distance says whether it is the same picture at all.",
  inputSchema: z.object({
    a: pathField.describe("the baseline PNG"),
    b: pathField.describe("the PNG to compare against it"),
    threshold: z
      .number()
      .int()
      .min(0)
      .max(255)
      .optional()
      .describe("per-channel tolerance before a pixel counts as different; default 0 (exact)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const a = loadPng("ImageDiff", input.a);
      const b = loadPng("ImageDiff", input.b);
      const hashA = differenceHash(a.image);
      const hashB = differenceHash(b.image);
      const perceptual = {
        hashA,
        hashB,
        hashDistance: hammingDistance(hashA, hashB),
        hashBits: 64,
      };
      if (a.image.width !== b.image.width || a.image.height !== b.image.height) {
        return json({
          a: a.path.rel,
          b: b.path.rel,
          identical: false,
          sizeMismatch: {
            a: { width: a.image.width, height: a.image.height },
            b: { width: b.image.width, height: b.image.height },
          },
          note: "different dimensions, so there is no per-pixel comparison; the perceptual hashes are still comparable",
          ...perceptual,
        });
      }
      const diff = diffImages(a.image, b.image, input.threshold ?? 0);
      return json({
        a: a.path.rel,
        b: b.path.rel,
        identical: diff.differingPixels === 0,
        threshold: input.threshold ?? 0,
        ...diff,
        ...perceptual,
      });
    }),
});

// ---------------------------------------------------------------------------
// Writing images

const colorTypeField = z
  .enum(["auto", "rgba", "rgb", "gray", "gray-alpha"])
  .optional()
  .describe("`auto` (the default) picks the smallest type that is lossless for these pixels");

export const pngWrite: RegisteredTool = buildTool({
  name: "PngWrite",
  description:
    "Encode raw RGBA pixels as a valid PNG file, choosing the smallest lossless colour type by default. Use to write out an image a tool or a script has computed pixel by pixel, without adding an image library to the project.",
  inputSchema: z.object({
    path: pathField.describe("where to write the PNG, inside the workspace"),
    width: z.number().int().positive().max(20_000),
    height: z.number().int().positive().max(20_000),
    pixels: z.string().describe("base64 of exactly width * height * 4 bytes, as R, G, B, A"),
    colorType: colorTypeField,
    overwrite: overwriteField,
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      if (input.width * input.height > MAX_DECODE_PIXELS) {
        throw new ToolInputError(
          `${input.width}x${input.height} is over the ${MAX_DECODE_PIXELS}-pixel cap`,
        );
      }
      if (input.pixels.length > MAX_PIXEL_BASE64_CHARS) {
        throw new ToolInputError(
          `the pixel blob is ${input.pixels.length} characters, over the ${MAX_PIXEL_BASE64_CHARS} cap`,
        );
      }
      const data = new Uint8Array(Buffer.from(input.pixels, "base64"));
      const expected = input.width * input.height * 4;
      if (data.length !== expected) {
        throw new ToolInputError(
          `the pixel blob decodes to ${data.length} bytes, but ${input.width}x${input.height} RGBA needs ${expected}`,
        );
      }
      const image: RgbaImage = { width: input.width, height: input.height, data };
      const bytes = encodePng(image, {
        colorType: (input.colorType ?? "auto") as PngColorType | "auto",
      });
      const path = writeSafe("PngWrite", input.path, bytes, input.overwrite === true);
      return json({
        path: path.rel,
        bytes: bytes.length,
        width: input.width,
        height: input.height,
        colorType: input.colorType ?? "auto",
        filter: "per-scanline, minimum sum of absolute differences",
      });
    }),
});

export const imageResize: RegisteredTool = buildTool({
  name: "ImageResize",
  description:
    "Resize a PNG to a new size and write it out as a PNG, stating the resampling method used. Use to produce a thumbnail or a fixed-width asset; pass only a width or only a height to keep the aspect ratio.",
  inputSchema: z.object({
    path: pathField.describe("the source PNG"),
    output: pathField.describe("where to write the resized PNG"),
    width: z.number().int().positive().max(20_000).optional(),
    height: z.number().int().positive().max(20_000).optional(),
    method: z
      .enum(["nearest", "bilinear"])
      .optional()
      .describe("`bilinear` (default) for photographs, `nearest` to preserve exact colours"),
    colorType: colorTypeField,
    overwrite: overwriteField,
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      if (input.width === undefined && input.height === undefined) {
        throw new ToolInputError("give a width, a height, or both");
      }
      const { path, image } = loadPng("ImageResize", input.path);
      const target = fitDimensions(image, {
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
      });
      if (target.width * target.height > MAX_DECODE_PIXELS) {
        throw new ToolInputError(
          `${target.width}x${target.height} is over the ${MAX_DECODE_PIXELS}-pixel cap`,
        );
      }
      const method = input.method ?? "bilinear";
      const resized = resizeImage(image, target.width, target.height, method);
      const bytes = encodePng(resized, {
        colorType: (input.colorType ?? "auto") as PngColorType | "auto",
      });
      const out = writeSafe("ImageResize", input.output, bytes, input.overwrite === true);
      return json({
        source: path.rel,
        path: out.rel,
        from: { width: image.width, height: image.height },
        to: target,
        method,
        resampling:
          method === "bilinear"
            ? "bilinear interpolation of the four neighbouring pixels; no area averaging, so shrinking by a large factor will alias"
            : "nearest neighbour; exact source colours, visible stair-stepping on photographs",
        bytes: bytes.length,
      });
    }),
});

export const imageCrop: RegisteredTool = buildTool({
  name: "ImageCrop",
  description:
    "Cut a rectangle out of a PNG and write it out as a PNG. Use to isolate a region of a screenshot — the part a diff flagged, or one panel of a wider capture — before comparing or reading it.",
  inputSchema: z.object({
    path: pathField.describe("the source PNG"),
    output: pathField.describe("where to write the cropped PNG"),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    colorType: colorTypeField,
    overwrite: overwriteField,
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const { path, image } = loadPng("ImageCrop", input.path);
      const cropped = cropImage(image, input.x, input.y, input.width, input.height);
      const bytes = encodePng(cropped, {
        colorType: (input.colorType ?? "auto") as PngColorType | "auto",
      });
      const out = writeSafe("ImageCrop", input.output, bytes, input.overwrite === true);
      return json({
        source: path.rel,
        path: out.rel,
        from: { width: image.width, height: image.height },
        region: { x: input.x, y: input.y, width: input.width, height: input.height },
        bytes: bytes.length,
      });
    }),
});

export const exifStrip: RegisteredTool = buildTool({
  name: "ExifStrip",
  description:
    "Write a copy of a JPEG with its metadata segments removed, keeping the image data byte for byte. Use before publishing a photograph, to drop the GPS coordinates, camera serial and capture time without re-encoding and losing quality.",
  inputSchema: z.object({
    path: pathField.describe("the source JPEG"),
    output: pathField.describe("where to write the stripped JPEG"),
    keepIccProfile: z
      .boolean()
      .optional()
      .describe("keep the APP2 colour profile; default true, because dropping it shifts colours"),
    keepJfif: z.boolean().optional().describe("keep the APP0 JFIF header; default true"),
    overwrite: overwriteField,
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const { path, bytes } = readWhole("ExifStrip", input.path);
      const kind = detectKind(bytes);
      if (kind?.kind !== "jpeg") {
        throw new ToolInputError(
          `"${input.path}" is ${kind === undefined ? "not a recognised format" : kind.kind}; this tool rewrites JPEG only`,
        );
      }
      const result = stripJpegMetadata(bytes, {
        keepIccProfile: input.keepIccProfile ?? true,
        keepJfif: input.keepJfif ?? true,
      });
      const out = writeSafe("ExifStrip", input.output, result.bytes, input.overwrite === true);
      return json({
        source: path.rel,
        path: out.rel,
        bytesBefore: bytes.length,
        bytesAfter: result.bytes.length,
        bytesRemoved: result.bytesRemoved,
        removed: result.removed,
        note: "the entropy-coded scan data was copied verbatim; the picture is unchanged",
      });
    }),
});

// ---------------------------------------------------------------------------
// Codes

export const qrEncode: RegisteredTool = buildTool({
  name: "QrEncode",
  description:
    "Generate a QR code from text, as a PNG file or as a text matrix, with a chosen error-correction level. Use to turn a URL, a Wi-Fi string or a payload into a scannable code without a service call; versions 1 to 10 are supported, which is up to 271 bytes at level L.",
  inputSchema: z.object({
    text: z.string().min(1).describe("the payload; encoded as UTF-8 in byte mode"),
    format: z
      .enum(["png", "text"])
      .optional()
      .describe("`png` (default, needs `path`) or `text` for a matrix of characters"),
    path: pathField.optional().describe("where to write the PNG; required when format is png"),
    ecc: z
      .enum(["L", "M", "Q", "H"])
      .optional()
      .describe("error correction: L ~7%, M ~15% (default), Q ~25%, H ~30%"),
    version: z.number().int().min(1).max(MAX_VERSION).optional().describe("force a symbol version"),
    mask: z
      .number()
      .int()
      .min(0)
      .max(7)
      .optional()
      .describe("force a mask; default is the lowest-penalty one"),
    scale: z.number().int().min(1).max(40).optional().describe("pixels per module; default 8"),
    quietZone: z
      .number()
      .int()
      .min(0)
      .max(16)
      .optional()
      .describe("modules of margin; default 4, which is the minimum the standard requires"),
    dark: z.string().optional().describe("module colour; default black"),
    light: z.string().optional().describe("background colour; default white"),
    overwrite: overwriteField,
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const ecc = (input.ecc ?? "M") as EccLevel;
      const symbol = encodeQr(input.text, {
        ecc,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.mask !== undefined ? { mask: input.mask } : {}),
      });
      const quietZone = input.quietZone ?? 4;
      const common = {
        version: symbol.version,
        ecc: symbol.ecc,
        mask: symbol.mask,
        modules: symbol.size,
        quietZone,
        mode: "byte (UTF-8)",
        payloadBytes: new TextEncoder().encode(input.text).length,
        capacityBytes: byteCapacity(symbol.version, ecc),
      };
      if ((input.format ?? "png") === "text") {
        return json({
          ...common,
          matrix: symbolToText(symbol, "██", "  ", quietZone),
          legend: "two characters per module so the code is square in a monospace font",
        });
      }
      if (input.path === undefined) {
        throw new ToolInputError("format `png` needs a `path` to write to");
      }
      const image = renderModuleGrid(
        symbol.modules,
        input.scale ?? 8,
        quietZone,
        parseColor(input.dark ?? "#000000"),
        parseColor(input.light ?? "#ffffff"),
      );
      const bytes = encodePng(image);
      const out = writeSafe("QrEncode", input.path, bytes, input.overwrite === true);
      return json({
        ...common,
        path: out.rel,
        width: image.width,
        height: image.height,
        scale: input.scale ?? 8,
        bytes: bytes.length,
      });
    }),
});

export const barcodeEncode: RegisteredTool = buildTool({
  name: "BarcodeEncode",
  description:
    "Generate a Code 128 or EAN-13 barcode, as a PNG file or as the raw module pattern, computing the check digit. Use for a label, a product code or an asset tag; EAN-13 accepts twelve digits and computes the thirteenth, or thirteen and verifies it.",
  inputSchema: z.object({
    symbology: z.enum(["code128", "ean13"]),
    value: z.string().min(1).describe("Code 128: ASCII 32-126. EAN-13: 12 or 13 digits."),
    format: z
      .enum(["png", "modules"])
      .optional()
      .describe("`png` (default, needs `path`) or `modules` for the bar/space string"),
    path: pathField.optional().describe("where to write the PNG; required when format is png"),
    scale: z.number().int().min(1).max(20).optional().describe("pixels per module; default 3"),
    height: z
      .number()
      .int()
      .min(8)
      .max(1000)
      .optional()
      .describe("bar height in pixels; default 80"),
    quietZone: z
      .number()
      .int()
      .min(0)
      .max(40)
      .optional()
      .describe(
        "modules of margin; default 10 for Code 128 and 11 for EAN-13, the standards' minimums",
      ),
    overwrite: overwriteField,
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const isEan = input.symbology === "ean13";
      const encoded = isEan ? encodeEan13(input.value) : encodeCode128(input.value);
      const quietZone = input.quietZone ?? (isEan ? 11 : 10);
      const common = {
        symbology: input.symbology,
        moduleCount: encoded.modules.length,
        quietZone,
        ...(isEan
          ? {
              digits: (encoded as { digits: string }).digits,
              checkDigit: (encoded as { checkDigit: number }).checkDigit,
            }
          : {
              value: input.value,
              codeSet: (encoded as { values: number[] }).values[0] === 105 ? "C" : "B",
              checkCharacter: (encoded as { values: number[] }).values.at(-2) ?? null,
            }),
      };
      if ((input.format ?? "png") === "modules") {
        return json({ ...common, modules: encoded.modules });
      }
      if (input.path === undefined) {
        throw new ToolInputError("format `png` needs a `path` to write to");
      }
      const scale = input.scale ?? 3;
      const height = input.height ?? 80;
      const image = renderModuleStrip(
        encoded.modules,
        scale,
        height,
        quietZone,
        parseColor("#000000"),
        parseColor("#ffffff"),
      );
      const bytes = encodePng(image);
      const out = writeSafe("BarcodeEncode", input.path, bytes, input.overwrite === true);
      return json({
        ...common,
        path: out.rel,
        width: image.width,
        height: image.height,
        scale,
        bytes: bytes.length,
        note: "bars only; no human-readable digits are drawn, because that would need a font",
      });
    }),
});

// ---------------------------------------------------------------------------
// Drawing

const seriesField = z
  .array(
    z.object({
      name: z.string(),
      values: z.array(z.number()).optional().describe("bar charts: one value per category"),
      points: z
        .array(z.tuple([z.number(), z.number()]))
        .optional()
        .describe("line and scatter charts: [x, y] pairs"),
    }),
  )
  .optional();

/** Write an SVG to `path`, or hand it back inline when there is no path. */
function emitSvg(
  toolName: string,
  svg: string,
  rel: string | undefined,
  overwrite: boolean,
  extra: Record<string, unknown>,
): string {
  if (rel === undefined) return json({ ...extra, format: "svg", svg });
  const out = writeSafe(toolName, rel, svg, overwrite);
  return json({ ...extra, format: "svg", path: out.rel, bytes: Buffer.byteLength(svg, "utf8") });
}

export const chartRender: RegisteredTool = buildTool({
  name: "ChartRender",
  description:
    "Render bar, line, scatter or pie data as an SVG chart with axes, ticks, labels and a legend. Use to turn a query result or a metric series into a picture for a report; the layout is fixed arithmetic, so the same data always produces the same bytes.",
  inputSchema: z.object({
    type: z.enum(["bar", "line", "scatter", "pie"]),
    title: z.string().optional(),
    width: z.number().int().min(120).max(4000).optional().describe("default 640"),
    height: z.number().int().min(80).max(4000).optional().describe("default 400"),
    categories: z.array(z.string()).optional().describe("bar charts: the x-axis labels"),
    series: seriesField,
    slices: z
      .array(z.object({ label: z.string(), value: z.number().min(0) }))
      .optional()
      .describe("pie charts: the slices"),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    colors: z.array(z.string()).optional().describe("series colours; defaults to a fixed palette"),
    background: z.string().optional().describe("`none` for a transparent chart; default white"),
    legend: z.boolean().optional().describe("default: shown when there is more than one series"),
    stacked: z
      .boolean()
      .optional()
      .describe("bar charts: stack the series instead of grouping them"),
    path: pathField.optional().describe("write the SVG here; omit to get it back inline"),
    overwrite: overwriteField,
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const spec: ChartSpec = {
        type: input.type,
        width: input.width ?? 640,
        height: input.height ?? 400,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.categories !== undefined ? { categories: input.categories } : {}),
        ...(input.series !== undefined ? { series: input.series } : {}),
        ...(input.slices !== undefined ? { slices: input.slices } : {}),
        ...(input.xLabel !== undefined ? { xLabel: input.xLabel } : {}),
        ...(input.yLabel !== undefined ? { yLabel: input.yLabel } : {}),
        ...(input.colors !== undefined ? { colors: input.colors } : {}),
        ...(input.background !== undefined ? { background: input.background } : {}),
        ...(input.legend !== undefined ? { legend: input.legend } : {}),
        ...(input.stacked !== undefined ? { stacked: input.stacked } : {}),
      };
      const svg = renderChart(spec);
      return emitSvg("ChartRender", svg, input.path, input.overwrite === true, {
        type: input.type,
        width: spec.width,
        height: spec.height,
        note: "SVG only: rasterising the axis labels would need a font, and this package ships none",
      });
    }),
});

export const sparklineRender: RegisteredTool = buildTool({
  name: "SparklineRender",
  description:
    "Render a series as a one-line sparkline, either as a small SVG or as Unicode block characters. Use to put a trend into a digest line, a status table or a commit message, where a full chart would not fit.",
  inputSchema: z.object({
    values: z.array(z.number()).min(1).max(2000),
    format: z.enum(["svg", "blocks"]).optional().describe("`blocks` (default) or `svg`"),
    min: z.number().optional().describe("force the low end of the range; values below it clip"),
    max: z.number().optional().describe("force the high end of the range; values above it clip"),
    width: z.number().int().min(8).max(2000).optional().describe("svg only; default 120"),
    height: z.number().int().min(4).max(400).optional().describe("svg only; default 24"),
    stroke: z.string().optional().describe("svg only; the line colour"),
    fill: z.string().optional().describe("svg only; fill the area under the line"),
    markLast: z.boolean().optional().describe("svg only; put a dot on the final point"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const range = {
        ...(input.min !== undefined ? { min: input.min } : {}),
        ...(input.max !== undefined ? { max: input.max } : {}),
      };
      const summary = {
        count: input.values.length,
        first: input.values[0] as number,
        last: input.values.at(-1) as number,
        min: Math.min(...input.values),
        max: Math.max(...input.values),
      };
      if ((input.format ?? "blocks") === "blocks") {
        return json({
          ...summary,
          format: "blocks",
          sparkline: sparklineBlocks(input.values, range),
        });
      }
      const svg = sparklineSvg(
        input.values,
        {
          ...(input.width !== undefined ? { width: input.width } : {}),
          ...(input.height !== undefined ? { height: input.height } : {}),
          ...(input.stroke !== undefined ? { stroke: input.stroke } : {}),
          ...(input.fill !== undefined ? { fill: input.fill } : {}),
          ...(input.markLast !== undefined ? { markLast: input.markLast } : {}),
        },
        range,
      );
      return json({ ...summary, format: "svg", svg });
    }),
});

export const diagramRender: RegisteredTool = buildTool({
  name: "DiagramRender",
  description:
    "Render a node and edge list as a box-and-arrow SVG diagram with a layered layout. Use for a pipeline, a state machine or a service sketch; nodes are placed by layer and declaration order, so the same graph always draws the same, and edges that close a cycle are drawn dashed and reported.",
  inputSchema: z.object({
    nodes: z
      .array(z.object({ id: z.string().min(1), label: z.string().optional() }))
      .min(1)
      .max(200),
    edges: z
      .array(
        z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().optional() }),
      )
      .max(600),
    direction: z
      .enum(["TB", "LR"])
      .optional()
      .describe("`TB` top to bottom (default) or `LR` left to right"),
    title: z.string().optional(),
    background: z.string().optional(),
    nodeFill: z.string().optional(),
    nodeStroke: z.string().optional(),
    path: pathField.optional().describe("write the SVG here; omit to get it back inline"),
    overwrite: overwriteField,
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const result = renderDiagram({
        nodes: input.nodes,
        edges: input.edges,
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.background !== undefined ? { background: input.background } : {}),
        ...(input.nodeFill !== undefined ? { nodeFill: input.nodeFill } : {}),
        ...(input.nodeStroke !== undefined ? { nodeStroke: input.nodeStroke } : {}),
      });
      return emitSvg("DiagramRender", result.svg, input.path, input.overwrite === true, {
        width: result.width,
        height: result.height,
        nodes: input.nodes.length,
        edges: input.edges.length,
        layerCount: Math.max(...result.layers.map((l) => l.layer)) + 1,
        layers: result.layers,
        backEdges: result.backEdges,
      });
    }),
});

// ---------------------------------------------------------------------------
// Colour

export const colorConvert: RegisteredTool = buildTool({
  name: "ColorConvert",
  description:
    "Convert colours between hex, RGB and HSL, reporting each form plus the relative luminance. Use to move a palette between a stylesheet and a design token file, or to normalise colours written in three different notations.",
  inputSchema: z.object({
    colors: z
      .array(z.string().min(1))
      .min(1)
      .max(256)
      .describe(
        "hex (#rgb, #rgba, #rrggbb, #rrggbbaa), rgb()/rgba(), hsl()/hsla(), or a basic keyword",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const results = input.colors.map((text) => {
        try {
          const rgb = parseColor(text);
          const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
          return {
            input: text,
            hex: toHexString(rgb),
            rgb: { r: rgb.r, g: rgb.g, b: rgb.b },
            alpha: Math.round((rgb.a / 255) * 1000) / 1000,
            rgbCss:
              rgb.a === 255
                ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
                : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.round((rgb.a / 255) * 1000) / 1000})`,
            hsl,
            hslCss: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
            relativeLuminance: Math.round(relativeLuminance(rgb.r, rgb.g, rgb.b) * 10000) / 10000,
          };
        } catch (err) {
          return { input: text, error: (err as Error).message };
        }
      });
      return json({ count: results.length, keywords: colorKeywords(), colors: results });
    }),
});

export const colorContrast: RegisteredTool = buildTool({
  name: "ColorContrast",
  description:
    "Compute the WCAG contrast ratio between foreground and background colours and report which conformance levels each pair clears. Use as the accessibility check before shipping a palette: it names AA and AAA for normal text, large text and UI components separately.",
  inputSchema: z.object({
    pairs: z
      .array(
        z.object({
          foreground: z.string().min(1),
          background: z.string().min(1),
          label: z.string().optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const results = input.pairs.map((pair) => {
        try {
          const report = contrastReport(parseColor(pair.foreground), parseColor(pair.background));
          return {
            ...(pair.label !== undefined ? { label: pair.label } : {}),
            input: { foreground: pair.foreground, background: pair.background },
            ...report,
          };
        } catch (err) {
          return {
            ...(pair.label !== undefined ? { label: pair.label } : {}),
            input: { foreground: pair.foreground, background: pair.background },
            error: (err as Error).message,
          };
        }
      });
      const failing = results.filter((r) => "verdict" in r && r.verdict === "fail").length;
      return json({
        standard:
          "WCAG 2.x; AA is 4.5:1 for normal text and 3:1 for large text and UI components, AAA is 7:1 and 4.5:1",
        count: results.length,
        failingNormalText: results.filter((r) => "normalTextAA" in r && !r.normalTextAA).length,
        failingEverything: failing,
        pairs: results,
      });
    }),
});

// ---------------------------------------------------------------------------
// Subtitles and probing

export const subtitleParse: RegisteredTool = buildTool({
  name: "SubtitleParse",
  description:
    "Parse an SRT or WebVTT subtitle file into cues with start and end times in milliseconds. Use to search a transcript, count speaking time, or pull the text of a video without watching it; the format is detected from the file when not given.",
  inputSchema: z.object({
    path: pathField.describe("a .srt or .vtt file inside the workspace"),
    format: z.enum(["srt", "vtt"]).optional().describe("override the detected format"),
    maxCues: z.number().int().positive().max(20_000).optional().describe("default 2000"),
    textOnly: z.boolean().optional().describe("return just the concatenated text, without timings"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const { path, bytes } = readWhole("SubtitleParse", input.path, 32 * 1024 * 1024);
      const result = parseSubtitles(
        new TextDecoder("utf-8").decode(bytes),
        input.format as SubtitleFormat | undefined,
      );
      const limit = input.maxCues ?? 2000;
      const cues = result.cues.slice(0, limit);
      const totalMs = result.cues.reduce((sum, c) => sum + (c.endMs - c.startMs), 0);
      const summary = {
        path: path.rel,
        format: result.format,
        cueCount: result.cues.length,
        returned: cues.length,
        truncated: result.cues.length > cues.length,
        totalCueDurationMs: totalMs,
        skipped: result.skipped,
      };
      if (input.textOnly === true) {
        return json({ ...summary, text: cues.map((c) => c.text).join("\n") });
      }
      return json({ ...summary, cues });
    }),
});

export const subtitleWrite: RegisteredTool = buildTool({
  name: "SubtitleWrite",
  description:
    "Write cues out as SRT or WebVTT, optionally shifting every time and re-wrapping the text. Use to fix a track that runs early or late, to convert between the two formats, or to re-wrap long lines to a readable width.",
  inputSchema: z.object({
    cues: z
      .array(
        z.object({
          startMs: z.number().int().min(0),
          endMs: z.number().int().min(0),
          text: z.string(),
          id: z.string().optional(),
          settings: z.string().optional().describe("WebVTT cue settings, kept verbatim"),
        }),
      )
      .min(1)
      .max(20_000),
    format: z.enum(["srt", "vtt"]),
    path: pathField.optional().describe("write here; omit to get the document back inline"),
    shiftMs: z
      .number()
      .int()
      .optional()
      .describe("added to every cue; a cue pushed before zero is dropped and counted"),
    wrapColumns: z.number().int().min(10).max(200).optional().describe("re-wrap each cue's text"),
    header: z.string().optional().describe("WebVTT only: text appended to the WEBVTT line"),
    overwrite: overwriteField,
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const cues: Cue[] = input.cues.map((cue, i) => ({
        index: i + 1,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
        ...(cue.id !== undefined ? { id: cue.id } : {}),
        ...(cue.settings !== undefined ? { settings: cue.settings } : {}),
      }));
      for (const cue of cues) {
        if (cue.endMs < cue.startMs) {
          throw new ToolInputError(
            `cue ${cue.index} ends at ${cue.endMs}ms, before its start at ${cue.startMs}ms`,
          );
        }
      }
      const result = writeSubtitles(cues, input.format, {
        ...(input.shiftMs !== undefined ? { shiftMs: input.shiftMs } : {}),
        ...(input.wrapColumns !== undefined ? { wrapColumns: input.wrapColumns } : {}),
        ...(input.header !== undefined ? { header: input.header } : {}),
      });
      const summary = {
        format: input.format,
        cueCount: result.cueCount,
        droppedBeforeZero: result.dropped,
        shiftMs: input.shiftMs ?? 0,
      };
      if (input.path === undefined) return json({ ...summary, text: result.text });
      const out = writeSafe("SubtitleWrite", input.path, result.text, input.overwrite === true);
      return json({ ...summary, path: out.rel, bytes: Buffer.byteLength(result.text, "utf8") });
    }),
});

export const mediaProbe: RegisteredTool = buildTool({
  name: "MediaProbe",
  description:
    "Probe an audio or video file with ffprobe and return its duration, streams, codecs, resolution and bitrate as structured data. Use to learn what a media file actually contains before transcoding or embedding it; ffprobe must be installed, and the tool says so plainly when it is not.",
  inputSchema: z.object({
    path: pathField.describe("an audio or video file inside the workspace"),
    timeout: z
      .number()
      .int()
      .min(1000)
      .max(MAX_PROCESS_TIMEOUT_MS)
      .optional()
      .describe(`milliseconds before ffprobe is killed; default ${DEFAULT_PROCESS_TIMEOUT_MS}`),
  }),
  // NOT `readOnly`. ffprobe only reads, but `readOnly` is what the
  // permission engine auto-allows in `plan` mode, and a plan must not spawn
  // anything: every other process-spawning tool in this repo (tool-bash,
  // tool-proc) makes the same call. `destructive` stays false, because
  // nothing this runs can change a file.
  // Spawning a process crosses a boundary the runtime cannot re-classify
  // afterwards, so this declares both the policy and the capability.
  scope: "external",
  ioCapability: "process",
  execute: async (input, ctx) =>
    attempt(async () => {
      const path = resolveSafe("MediaProbe", input.path);
      const stats = statSync(path.real);
      if (stats.isDirectory())
        throw new ToolInputError(`"${input.path}" is a directory, not a file`);
      const argv = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        // `--` then the path: a file name starting with a dash is a file
        // name, never an option.
        "--",
        path.real,
      ];
      const result = await runProcess(argv, {
        cwd: process.cwd(),
        timeoutMs: input.timeout ?? DEFAULT_PROCESS_TIMEOUT_MS,
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (result.missing || result.code === 127) {
        return `ffprobe is not installed on this machine, so ${path.rel} cannot be probed here. Install ffmpeg, or use ImageInfo if this is a still image.`;
      }
      if (result.code !== 0 || result.timedOut) return describeFailure(argv, result);
      const probe = parseProbeJson(result.stdout);
      return json({
        path: path.rel,
        fileBytes: stats.size,
        ...probe,
        note: "reported by the ffprobe on this machine; a different ffprobe build may name codecs differently",
      });
    }),
});

/** Every tool this package registers, in the order a catalog should list them. */
export const MEDIA_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  barcodeEncode,
  chartRender,
  colorContrast,
  colorConvert,
  diagramRender,
  exifRead,
  exifStrip,
  imageCrop,
  imageDiff,
  imageInfo,
  imageKind,
  imageResize,
  mediaProbe,
  pngRead,
  pngWrite,
  qrEncode,
  sparklineRender,
  subtitleParse,
  subtitleWrite,
]);

export { HEADER_FORMATS, ECC_LEVELS, knownKinds };
