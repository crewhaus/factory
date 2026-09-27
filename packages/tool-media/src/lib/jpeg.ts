/**
 * JPEG at the segment level: walking the marker segments, reading the EXIF
 * that hides in one of them, and writing a copy without the metadata.
 *
 * ## What this reads
 *
 * The TIFF structure inside an `APP1` segment whose payload begins
 * `Exif\0\0`: IFD0, the Exif sub-IFD it points at, and the GPS sub-IFD.
 * Both byte orders. Rationals, ASCII, shorts and longs. That covers the
 * capture time, camera, lens, exposure and — the one that matters most for
 * anything about to be published — the location.
 *
 * ## What this does not read
 *
 * MakerNotes (vendor-private, undocumented, and different per camera),
 * IFD1 thumbnails, and EXIF carried in a TIFF or HEIC rather than a JPEG.
 * Each would be a separate parser; none is approximated. XMP and Photoshop
 * resource blocks are searched for a location (see `otherMetadataOf`), not
 * parsed, and any other APPn segment is reported as not read.
 */
import { ByteReader, MediaFormatError, asciiAt, startsWith } from "./bytes";

/** One marker segment, located in the original file. */
export type JpegSegment = {
  /** The marker byte after the `0xFF`, e.g. `0xE1` for `APP1`. */
  readonly marker: number;
  /** Conventional name: `"APP1"`, `"SOF0"`, `"DQT"`, … */
  readonly name: string;
  /** Offset of the `0xFF` that starts the segment. */
  readonly offset: number;
  /** Total bytes including the marker and the two length bytes. */
  readonly length: number;
  /** The payload, excluding the marker and the length field. */
  readonly payload: Uint8Array;
};

function markerName(marker: number): string {
  if (marker >= 0xe0 && marker <= 0xef) return `APP${marker - 0xe0}`;
  if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
    return `SOF${marker - 0xc0}`;
  }
  switch (marker) {
    case 0xc4:
      return "DHT";
    case 0xcc:
      return "DAC";
    case 0xd8:
      return "SOI";
    case 0xd9:
      return "EOI";
    case 0xda:
      return "SOS";
    case 0xdb:
      return "DQT";
    case 0xdd:
      return "DRI";
    case 0xfe:
      return "COM";
    default:
      return `FF${marker.toString(16).toUpperCase().padStart(2, "0")}`;
  }
}

/**
 * Every marker segment from `SOI` up to and including `SOS`, plus the
 * offset at which the entropy-coded scan data begins. Everything from that
 * offset to the end of the file is opaque and is copied verbatim by
 * `stripJpegMetadata` rather than parsed.
 */
export function readJpegSegments(bytes: Uint8Array): {
  segments: JpegSegment[];
  scanStart: number;
} {
  if (!startsWith(bytes, [0xff, 0xd8])) {
    throw new MediaFormatError("not a JPEG: the file does not start with FFD8 (SOI)");
  }
  const segments: JpegSegment[] = [];
  const reader = new ByteReader(bytes);
  reader.seek(2);
  while (reader.remaining >= 2) {
    const start = reader.offset;
    let marker = reader.u8();
    if (marker !== 0xff) {
      throw new MediaFormatError(
        `expected a marker at offset ${start}, found 0x${marker.toString(16)}`,
      );
    }
    marker = reader.u8();
    while (marker === 0xff && reader.remaining > 0) marker = reader.u8(); // fill bytes
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({
        marker,
        name: markerName(marker),
        offset: start,
        length: reader.offset - start,
        payload: new Uint8Array(0),
      });
      continue;
    }
    if (marker === 0xd9) {
      segments.push({ marker, name: "EOI", offset: start, length: 2, payload: new Uint8Array(0) });
      return { segments, scanStart: reader.offset };
    }
    const length = reader.u16be();
    if (length < 2) {
      throw new MediaFormatError(`segment ${markerName(marker)} declares a length of ${length}`);
    }
    const payload = reader.take(length - 2);
    segments.push({
      marker,
      name: markerName(marker),
      offset: start,
      length: reader.offset - start,
      payload,
    });
    if (marker === 0xda) return { segments, scanStart: reader.offset };
  }
  throw new MediaFormatError("the file ends before the start-of-scan marker");
}

// --- The whole codestream --------------------------------------------------

/** One piece of a JPEG, in file order: a marker segment, or a scan's entropy-coded bytes. */
export type JpegPart =
  | { readonly type: "segment"; readonly segment: JpegSegment }
  | { readonly type: "scan"; readonly start: number; readonly end: number };

export type JpegWalk = {
  /** Every piece after SOI, in order, up to and including EOI. */
  readonly parts: ReadonlyArray<JpegPart>;
  /** The marker segments alone, in order. */
  readonly segments: ReadonlyArray<JpegSegment>;
  /** Offset just past EOI, or null when the file ends without one. */
  readonly eoiEnd: number | null;
  /** Bytes after EOI: where an appended image or video lives. 0 when EOI is missing. */
  readonly trailing: number;
  /**
   * Where the walk stopped short of EOI after the first scan, and why: a
   * segment the end of the file cuts off, or bytes where a marker should
   * be. Null when it reached EOI or the file's end in scan data. The bytes
   * from here on were not walked.
   */
  readonly stopped: { readonly offset: number; readonly reason: string } | null;
};

/** More marker segments than any real JPEG has; past it the file is refused. */
const MAX_JPEG_SEGMENTS = 65_536;

/**
 * Walk the WHOLE codestream: every marker segment, including those between
 * the scans of a progressive or multi-scan file, to EOI.
 *
 * `readJpegSegments` stops at the first start-of-scan, which is all a header
 * reader needs, and 0.7.0's ExifStrip copied everything after that point
 * verbatim. But an APPn or COM segment may sit between scans, and a camera
 * appends whole images after EOI (MPF previews, HDR gain maps, stereo pairs)
 * and phones append motion-photo video; each can carry its own EXIF and GPS.
 *
 * Inside a scan, `0xFF` followed by `0x00` (stuffing), `0xD0`–`0xD7` (restart
 * markers) or another `0xFF` (fill) belongs to the scan; any other `0xFF xx`
 * is the next marker. The walk is linear: the scan search is a native
 * `indexOf` from where the last one stopped.
 *
 * A broken header (before the first scan) is refused. Past the first scan
 * the picture is already there, and a file cut short there — a partial
 * download, a truncated progressive JPEG — is still a photo: the walk stops
 * at the break and says where (`stopped`), rather than refusing a file
 * 0.7.0 read, which only ever looked as far as the first scan.
 */
export function walkJpeg(bytes: Uint8Array): JpegWalk {
  if (!startsWith(bytes, [0xff, 0xd8])) {
    throw new MediaFormatError("not a JPEG: the file does not start with FFD8 (SOI)");
  }
  const parts: JpegPart[] = [];
  const segments: JpegSegment[] = [];
  const push = (segment: JpegSegment): void => {
    if (segments.length >= MAX_JPEG_SEGMENTS) {
      throw new MediaFormatError(`the file has more than ${MAX_JPEG_SEGMENTS} marker segments`);
    }
    segments.push(segment);
    parts.push({ type: "segment", segment });
  };
  let pos = 2;
  let sawScan = false;
  // Past the first scan a framing error ends the walk; before it, the file.
  const broken = (offset: number, reason: string): JpegWalk => {
    if (!sawScan) throw new MediaFormatError(reason);
    return { parts, segments, eoiEnd: null, trailing: 0, stopped: { offset, reason } };
  };
  while (pos < bytes.length) {
    const start = pos;
    if (bytes[pos] !== 0xff) {
      return broken(
        start,
        `expected a marker at offset ${start}, found 0x${(bytes[pos] as number).toString(16)}`,
      );
    }
    pos++;
    while (pos < bytes.length && bytes[pos] === 0xff) pos++; // fill bytes
    if (pos >= bytes.length) break; // a lone trailing 0xFF: nothing follows
    const marker = bytes[pos] as number;
    pos++;
    if (marker === 0xd9) {
      push({ marker, name: "EOI", offset: start, length: pos - start, payload: new Uint8Array(0) });
      return { parts, segments, eoiEnd: pos, trailing: bytes.length - pos, stopped: null };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      push({
        marker,
        name: markerName(marker),
        offset: start,
        length: pos - start,
        payload: new Uint8Array(0),
      });
      continue;
    }
    if (marker === 0xd8) {
      return broken(start, `a second start-of-image marker at offset ${start}`);
    }
    if (pos + 2 > bytes.length) {
      return broken(start, `segment ${markerName(marker)} at ${start} is cut off`);
    }
    const length = ((bytes[pos] as number) << 8) | (bytes[pos + 1] as number);
    if (length < 2) {
      return broken(start, `segment ${markerName(marker)} declares a length of ${length}`);
    }
    if (pos + length > bytes.length) {
      return broken(
        start,
        `segment ${markerName(marker)} at ${start} runs ${pos + length - bytes.length} bytes past the end of the file`,
      );
    }
    push({
      marker,
      name: markerName(marker),
      offset: start,
      length: pos + length - start,
      payload: bytes.subarray(pos + 2, pos + length),
    });
    pos += length;
    if (marker !== 0xda) continue;
    sawScan = true;
    // Entropy-coded data, up to the next real marker.
    const dataStart = pos;
    for (;;) {
      const ff = bytes.indexOf(0xff, pos);
      if (ff === -1 || ff + 1 >= bytes.length) {
        pos = bytes.length;
        break;
      }
      const next = bytes[ff + 1] as number;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        pos = ff + 2;
        continue;
      }
      if (next === 0xff) {
        pos = ff + 1;
        continue;
      }
      pos = ff;
      break;
    }
    parts.push({ type: "scan", start: dataStart, end: pos });
  }
  return { parts, segments, eoiEnd: null, trailing: 0, stopped: null };
}

/** Whether `marker` opens a segment ExifStrip treats as metadata by default (APPn, COM). */
function isMetadataMarker(marker: number | undefined): boolean {
  return marker !== undefined && ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe);
}

const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

/** Offsets in `bytes[from, to)` where an `Exif\0\0` block starts, at most `max` of them. */
function exifSignatures(bytes: Uint8Array, from: number, to: number, max: number): number[] {
  const out: number[] = [];
  for (let i = bytes.indexOf(0x45, from); i !== -1 && i + 6 <= to; i = bytes.indexOf(0x45, i + 1)) {
    if (EXIF_SIGNATURE.every((b, k) => bytes[i + k] === b)) {
      out.push(i);
      if (out.length >= max) break;
    }
  }
  return out;
}

/**
 * The first offset in `bytes` that looks like metadata — an APPn or COM
 * marker, or an `Exif\0\0` block — or -1. For bytes a walk could not frame.
 */
function metadataHint(bytes: Uint8Array): number {
  for (
    let i = bytes.indexOf(0xff);
    i !== -1 && i + 1 < bytes.length;
    i = bytes.indexOf(0xff, i + 1)
  ) {
    if (isMetadataMarker(bytes[i + 1])) return i;
  }
  return exifSignatures(bytes, 0, bytes.length, 1)[0] ?? -1;
}

/** A hint at what the bytes after EOI are, for a person reading the result. */
export function describeTrailer(trailer: Uint8Array): string {
  if (trailer.length === 0) return "nothing";
  for (
    let i = trailer.indexOf(0xff);
    i !== -1 && i + 2 < trailer.length;
    i = trailer.indexOf(0xff, i + 1)
  ) {
    if (trailer[i + 1] === 0xd8 && trailer[i + 2] === 0xff) {
      return "an appended JPEG (an MPF preview, a second view or an HDR gain map)";
    }
  }
  for (
    let i = trailer.indexOf(0x66);
    i !== -1 && i + 3 < trailer.length;
    i = trailer.indexOf(0x66, i + 1)
  ) {
    if (asciiAt(trailer, i, "ftyp")) return "an appended video (a motion photo)";
  }
  return "unrecognised data";
}

// --- EXIF ----------------------------------------------------------------

const TYPE_SIZES: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

/** Cap on entries per IFD, so a corrupt count cannot drive a long loop. */
const MAX_IFD_ENTRIES = 512;

type TiffValue = number | string | number[];

class TiffReader {
  readonly view: DataView;
  readonly little: boolean;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, little: boolean) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.little = little;
  }

  u16(at: number): number {
    if (at + 2 > this.bytes.length) throw new MediaFormatError(`TIFF read past the end at ${at}`);
    return this.view.getUint16(at, this.little);
  }

  u32(at: number): number {
    if (at + 4 > this.bytes.length) throw new MediaFormatError(`TIFF read past the end at ${at}`);
    return this.view.getUint32(at, this.little);
  }

  i32(at: number): number {
    if (at + 4 > this.bytes.length) throw new MediaFormatError(`TIFF read past the end at ${at}`);
    return this.view.getInt32(at, this.little);
  }
}

function readTagValue(tiff: TiffReader, type: number, count: number, valueAt: number): TiffValue {
  const size = TYPE_SIZES[type];
  if (size === undefined) throw new MediaFormatError(`TIFF type ${type} is not defined`);
  const total = size * count;
  const at = total <= 4 ? valueAt : tiff.u32(valueAt);
  if (at + total > tiff.bytes.length) {
    throw new MediaFormatError(`tag value of ${total} bytes at ${at} runs past the EXIF block`);
  }
  if (type === 2) {
    let out = "";
    for (let i = 0; i < count; i++) {
      const byte = tiff.bytes[at + i] as number;
      if (byte === 0) break;
      out += String.fromCharCode(byte);
    }
    return out.trim();
  }
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = at + i * size;
    switch (type) {
      case 1:
      case 7:
        values.push(tiff.bytes[p] as number);
        break;
      case 3:
        values.push(tiff.u16(p));
        break;
      case 4:
        values.push(tiff.u32(p));
        break;
      case 5: {
        const denominator = tiff.u32(p + 4);
        values.push(denominator === 0 ? 0 : tiff.u32(p) / denominator);
        break;
      }
      case 9:
        values.push(tiff.i32(p));
        break;
      case 10: {
        const denominator = tiff.i32(p + 4);
        values.push(denominator === 0 ? 0 : tiff.i32(p) / denominator);
        break;
      }
      case 6:
        values.push(tiff.view.getInt8(p));
        break;
      case 8:
        values.push(tiff.view.getInt16(p, tiff.little));
        break;
      case 11:
        values.push(tiff.view.getFloat32(p, tiff.little));
        break;
      case 12:
        values.push(tiff.view.getFloat64(p, tiff.little));
        break;
      default:
        break;
    }
  }
  return values.length === 1 ? (values[0] as number) : values;
}

function readIfd(tiff: TiffReader, at: number): Map<number, TiffValue> {
  const out = new Map<number, TiffValue>();
  const count = tiff.u16(at);
  if (count > MAX_IFD_ENTRIES) {
    throw new MediaFormatError(`an IFD claims ${count} entries, over the ${MAX_IFD_ENTRIES} cap`);
  }
  for (let i = 0; i < count; i++) {
    const entry = at + 2 + i * 12;
    if (entry + 12 > tiff.bytes.length) break;
    const tag = tiff.u16(entry);
    const type = tiff.u16(entry + 2);
    const length = tiff.u32(entry + 4);
    if (length > 1_000_000) continue; // a count this large is corruption
    try {
      out.set(tag, readTagValue(tiff, type, length, entry + 8));
    } catch {
      // One unreadable tag should not lose the rest of the block.
    }
  }
  return out;
}

const ORIENTATIONS: Record<number, string> = {
  1: "normal",
  2: "mirrored horizontally",
  3: "rotated 180 degrees",
  4: "mirrored vertically",
  5: "mirrored horizontally then rotated 90 degrees counter-clockwise",
  6: "rotated 90 degrees clockwise",
  7: "mirrored horizontally then rotated 90 degrees clockwise",
  8: "rotated 90 degrees counter-clockwise",
};

export type GpsFix = {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitudeMeters?: number;
  /** `YYYY:MM:DD HH:MM:SS` as the tags record it, if both parts are present. */
  readonly timestampUtc?: string;
};

export type ExifData = {
  readonly byteOrder: "little-endian" | "big-endian";
  readonly make?: string;
  readonly model?: string;
  readonly lens?: string;
  readonly software?: string;
  readonly orientation?: number;
  readonly orientationDescription?: string;
  readonly dateTimeOriginal?: string;
  readonly dateTimeDigitized?: string;
  readonly dateTime?: string;
  readonly exposureTimeSeconds?: number;
  readonly fNumber?: number;
  readonly isoSpeed?: number;
  readonly focalLengthMm?: number;
  readonly focalLength35mm?: number;
  readonly pixelWidth?: number;
  readonly pixelHeight?: number;
  readonly hasGps: boolean;
  readonly gps?: GpsFix;
  /** Tags present that this reader recognises but did not fit above. */
  readonly otherTagCount: number;
};

function dms(value: TiffValue): number | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const [d, m, s] = value as number[];
  if (d === undefined || m === undefined || s === undefined) return undefined;
  return d + m / 60 + s / 3600;
}

function str(value: TiffValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value === "" ? undefined : value;
}

function n(value: TiffValue | undefined): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isFinite(value) ? value : undefined;
}

/** Parse an `APP1` payload that begins `Exif\0\0`. */
export function parseExif(payload: Uint8Array): ExifData {
  if (!asciiAt(payload, 0, "Exif") || payload[4] !== 0x00 || payload[5] !== 0x00) {
    throw new MediaFormatError('the APP1 payload does not begin with the "Exif\\0\\0" identifier');
  }
  const tiffBytes = payload.subarray(6);
  const order = ((tiffBytes[0] as number) << 8) | (tiffBytes[1] as number);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) {
    throw new MediaFormatError("the TIFF header carries neither the II nor the MM byte-order mark");
  }
  const tiff = new TiffReader(tiffBytes, little);
  if (tiff.u16(2) !== 42)
    throw new MediaFormatError("the TIFF header is missing its 42 magic number");
  const ifd0 = readIfd(tiff, tiff.u32(4));

  const exifOffset = ifd0.get(0x8769);
  const exif =
    typeof exifOffset === "number" ? readIfd(tiff, exifOffset) : new Map<number, TiffValue>();
  const gpsOffset = ifd0.get(0x8825);
  const gpsIfd =
    typeof gpsOffset === "number" ? readIfd(tiff, gpsOffset) : new Map<number, TiffValue>();

  let gps: GpsFix | undefined;
  const latitude = dms(gpsIfd.get(0x0002) as TiffValue);
  const longitude = dms(gpsIfd.get(0x0004) as TiffValue);
  if (latitude !== undefined && longitude !== undefined) {
    const latRef = str(gpsIfd.get(0x0001)) ?? "N";
    const lonRef = str(gpsIfd.get(0x0003)) ?? "E";
    const altitude = n(gpsIfd.get(0x0006));
    const altitudeRef = n(gpsIfd.get(0x0005)) ?? 0;
    const time = gpsIfd.get(0x0007);
    const date = str(gpsIfd.get(0x001d));
    let timestampUtc: string | undefined;
    if (date !== undefined && Array.isArray(time) && time.length >= 3) {
      const pad = (v: number): string => String(Math.floor(v)).padStart(2, "0");
      timestampUtc = `${date} ${pad(time[0] as number)}:${pad(time[1] as number)}:${pad(time[2] as number)}`;
    }
    gps = {
      latitude:
        Math.round((latRef.toUpperCase().startsWith("S") ? -latitude : latitude) * 1e6) / 1e6,
      longitude:
        Math.round((lonRef.toUpperCase().startsWith("W") ? -longitude : longitude) * 1e6) / 1e6,
      ...(altitude !== undefined
        ? { altitudeMeters: Math.round((altitudeRef === 1 ? -altitude : altitude) * 100) / 100 }
        : {}),
      ...(timestampUtc !== undefined ? { timestampUtc } : {}),
    };
  }

  const orientation = n(ifd0.get(0x0112));
  const known = new Set([0x010f, 0x0110, 0x0112, 0x0131, 0x0132, 0x8769, 0x8825]);
  const otherTagCount =
    [...ifd0.keys()].filter((t) => !known.has(t)).length + exif.size + gpsIfd.size;

  return {
    byteOrder: little ? "little-endian" : "big-endian",
    ...(str(ifd0.get(0x010f)) !== undefined ? { make: str(ifd0.get(0x010f)) as string } : {}),
    ...(str(ifd0.get(0x0110)) !== undefined ? { model: str(ifd0.get(0x0110)) as string } : {}),
    ...(str(exif.get(0xa434)) !== undefined ? { lens: str(exif.get(0xa434)) as string } : {}),
    ...(str(ifd0.get(0x0131)) !== undefined ? { software: str(ifd0.get(0x0131)) as string } : {}),
    ...(orientation !== undefined
      ? {
          orientation,
          orientationDescription: ORIENTATIONS[orientation] ?? `unknown (${orientation})`,
        }
      : {}),
    ...(str(exif.get(0x9003)) !== undefined
      ? { dateTimeOriginal: str(exif.get(0x9003)) as string }
      : {}),
    ...(str(exif.get(0x9004)) !== undefined
      ? { dateTimeDigitized: str(exif.get(0x9004)) as string }
      : {}),
    ...(str(ifd0.get(0x0132)) !== undefined ? { dateTime: str(ifd0.get(0x0132)) as string } : {}),
    ...(n(exif.get(0x829a)) !== undefined
      ? { exposureTimeSeconds: n(exif.get(0x829a)) as number }
      : {}),
    ...(n(exif.get(0x829d)) !== undefined ? { fNumber: n(exif.get(0x829d)) as number } : {}),
    ...(n(exif.get(0x8827)) !== undefined ? { isoSpeed: n(exif.get(0x8827)) as number } : {}),
    ...(n(exif.get(0x920a)) !== undefined ? { focalLengthMm: n(exif.get(0x920a)) as number } : {}),
    ...(n(exif.get(0xa405)) !== undefined
      ? { focalLength35mm: n(exif.get(0xa405)) as number }
      : {}),
    ...(n(exif.get(0xa002)) !== undefined ? { pixelWidth: n(exif.get(0xa002)) as number } : {}),
    ...(n(exif.get(0xa003)) !== undefined ? { pixelHeight: n(exif.get(0xa003)) as number } : {}),
    hasGps: gps !== undefined,
    ...(gps !== undefined ? { gps } : {}),
    otherTagCount,
  };
}

/** Find the `APP1` segment carrying EXIF, if there is one. */
export function findExifSegment(segments: ReadonlyArray<JpegSegment>): JpegSegment | undefined {
  return segments.find((s) => s.marker === 0xe1 && asciiAt(s.payload, 0, "Exif"));
}

export type StripOptions = {
  /**
   * Keep the `APP2` ICC colour profile. On by default: a profile is not
   * metadata about the photographer, it is what tells a display how to
   * interpret the colours, and dropping it visibly shifts the image.
   */
  readonly keepIccProfile?: boolean;
  /** Keep the `APP0` JFIF header. On by default; it carries no identity. */
  readonly keepJfif?: boolean;
};

/** A segment name that `stripJpegMetadata` removes, given these options. */
function isMetadata(segment: JpegSegment, options: StripOptions): boolean {
  const { marker, payload } = segment;
  if (marker === 0xfe) return true; // COM
  if (marker === 0xe0) return options.keepJfif === false;
  if (marker === 0xe2) {
    // APP2 is the ICC profile in practice; anything else there is metadata.
    const isIcc = asciiAt(payload, 0, "ICC_PROFILE");
    return isIcc ? options.keepIccProfile === false : true;
  }
  // Every other APPn: EXIF and XMP (APP1), Meta (APP3), IPTC/Photoshop
  // (APP13), Ducky (APP12), and the rest.
  return marker >= 0xe1 && marker <= 0xef;
}

export type StripResult = {
  readonly bytes: Uint8Array;
  readonly removed: ReadonlyArray<{ name: string; bytes: number }>;
  readonly bytesRemoved: number;
  /** Bytes after EOI that were dropped: an appended image or video, and its metadata. */
  readonly trailingBytesRemoved: number;
  /** What those bytes looked like, when there were any. */
  readonly trailingKind?: string;
  /** The file ends without EOI; everything up to its end was walked and kept. */
  readonly eoiMissing: boolean;
  /**
   * Where the file breaks off after the first scan, when it does: the walk
   * stopped there, and the bytes after it were kept verbatim (or, when they
   * begin a metadata segment, dropped).
   */
  readonly breaksOffAt?: { readonly offset: number; readonly reason: string };
};

/**
 * A JPEG with its metadata dropped: every APPn and COM segment the options
 * do not keep, wherever it sits (before the first scan or between scans),
 * and everything after EOI. The scans' entropy-coded bytes are copied
 * verbatim — nothing is re-encoded, so the primary image is bit-for-bit the
 * same picture, without the record of who took it and where.
 *
 * Dropping the trailer loses an appended preview, gain map or motion-photo
 * video, and the metadata inside each. Nothing in the stripped file points
 * at them any more: the MPF index (APP2) and the XMP (APP1) that did are
 * metadata segments and are removed.
 */
export function stripJpegMetadata(bytes: Uint8Array, options: StripOptions = {}): StripResult {
  const walk = walkJpeg(bytes);
  const kept: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  const removed: Array<{ name: string; bytes: number }> = [];
  for (const part of walk.parts) {
    if (part.type === "scan") {
      kept.push(bytes.subarray(part.start, part.end));
      continue;
    }
    const segment = part.segment;
    if (isMetadata(segment, options)) {
      removed.push({ name: segment.name, bytes: segment.length });
      continue;
    }
    kept.push(bytes.subarray(segment.offset, segment.offset + segment.length));
  }
  if (walk.stopped !== null) {
    // The file breaks off after the first scan. What follows the break is a
    // cut-off segment or unframed bytes: a cut metadata segment is dropped;
    // anything else is kept as 0.7.0 kept everything after the first scan,
    // unless it holds what may be metadata, which is refused rather than
    // written into a file that claims to be stripped.
    const tail = bytes.subarray(walk.stopped.offset);
    if (tail[0] === 0xff && isMetadataMarker(tail[1])) {
      removed.push({ name: `${markerName(tail[1] as number)} (cut off)`, bytes: tail.length });
    } else {
      const hint = metadataHint(tail);
      if (hint !== -1) {
        throw new MediaFormatError(
          `the file breaks off at offset ${walk.stopped.offset} (${walk.stopped.reason}), and the part after it that could not be walked holds what may be metadata at offset ${walk.stopped.offset + hint}; nothing was written — re-export the file and strip that`,
        );
      }
      kept.push(tail);
    }
  }
  const trailerStart = walk.eoiEnd ?? bytes.length;
  let total = 0;
  for (const part of kept) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of kept) {
    out.set(part, at);
    at += part.length;
  }
  const trailing = bytes.length - trailerStart;
  return {
    bytes: out,
    removed,
    bytesRemoved: bytes.length - out.length,
    trailingBytesRemoved: trailing,
    ...(trailing > 0 ? { trailingKind: describeTrailer(bytes.subarray(trailerStart)) } : {}),
    eoiMissing: walk.eoiEnd === null,
    ...(walk.stopped === null ? {} : { breaksOffAt: walk.stopped }),
  };
}

/** One EXIF block found anywhere in a file, with where it was. */
export type ExifLocation = {
  readonly where:
    | "before the first scan"
    | "between scans"
    | "in an appended image"
    | "in bytes no walk accounts for";
  readonly offset: number;
  readonly exif: ExifData | null;
  /** Why `exif` is null: the block is there but could not be parsed. */
  readonly unreadable?: string;
};

export type JpegMetadataReport = {
  /** Every EXIF block in the file, the primary one first. */
  readonly exifBlocks: ReadonlyArray<ExifLocation>;
  /** APPn and COM segments that sit between or after the scans of the main image. */
  readonly interScanMetadataSegments: ReadonlyArray<string>;
  /** APPn segments before the first scan, by name. */
  readonly metadataSegments: ReadonlyArray<string>;
  readonly trailingBytes: number;
  readonly trailingKind?: string;
  /** JPEGs found in the trailer and walked for EXIF. */
  readonly embeddedImages: number;
  /** JPEG starts in the trailer beyond the ones walked; their metadata is unknown. */
  readonly embeddedImagesNotInspected: number;
  readonly eoiMissing: boolean;
  /** Where the main image breaks off after its first scan, when it does. */
  readonly breaksOffAt?: { readonly offset: number; readonly reason: string };
  /**
   * Bytes no walk accounts for and that are not padding: after a break,
   * after EOI outside every appended image walked (a video, data this does
   * not recognise, an image that would not walk), or past the end of what
   * was read. They were searched for EXIF blocks, not parsed, so they may
   * hold a location this report does not see.
   */
  readonly unaccountedBytes: number;
  /** EXIF signatures in those bytes beyond the ones parsed. */
  readonly exifSignaturesNotParsed: number;
  /** Every APPn segment other than EXIF, in the main image and the appended ones walked. */
  readonly otherMetadata: ReadonlyArray<OtherMetadata>;
};

/** How many appended images one call walks. */
const MAX_EMBEDDED_IMAGES = 16;
/** How many EXIF blocks found in unwalked bytes one call parses. */
const MAX_LOOSE_EXIF_BLOCKS = 16;

function exifBlocksOf(
  walk: JpegWalk,
  base: number,
  where: (sawScan: boolean) => ExifLocation["where"],
): ExifLocation[] {
  const out: ExifLocation[] = [];
  let sawScan = false;
  for (const part of walk.parts) {
    if (part.type === "scan") {
      sawScan = true;
      continue;
    }
    const s = part.segment;
    if (s.marker !== 0xe1 || !asciiAt(s.payload, 0, "Exif")) continue;
    let exif: ExifData | null = null;
    let unreadable: string | undefined;
    try {
      exif = parseExif(s.payload);
    } catch (err) {
      unreadable = (err as Error).message;
    }
    out.push({
      where: where(sawScan),
      offset: base + s.offset,
      exif,
      ...(unreadable === undefined ? {} : { unreadable }),
    });
  }
  return out;
}

/**
 * A metadata segment other than EXIF, and whether it names a location.
 * `location` is true when it does, false when it was read (or its format
 * has no place for one) and it does not, and null when this reader does
 * not parse it, so it may.
 */
export type OtherMetadata = {
  /** `"APP1 XMP"`, `"APP13 Photoshop"`, or the marker and its identifier. */
  readonly segment: string;
  readonly where: ExifLocation["where"];
  readonly offset: number;
  readonly location: boolean | null;
};

const XMP_ID = "http://ns.adobe.com/xap/1.0/\0";
const XMP_EXTENSION_ID = "http://ns.adobe.com/xmp/extension/\0";
/** Extended XMP: the identifier, a 32-byte GUID, the full length and this chunk's offset. */
const XMP_EXTENSION_HEADER = XMP_EXTENSION_ID.length + 32 + 4 + 4;

/**
 * Does an XMP packet name a location? The GPS properties are
 * `exif:GPSLatitude` and `exif:GPSLongitude`, written as attributes or
 * elements under whatever prefix the packet binds (IPTC's LocationCreated
 * nests the same two; DJI writes `drone-dji:GpsLatitude`), so the property
 * names are searched for, ignoring case. A packet that has either is taken
 * to carry a location: for a file about to be published, a false "yes" costs
 * a strip, and a false "no" publishes where it was taken.
 */
function xmpNamesLocation(bytes: Uint8Array): boolean {
  let text = "";
  // Latin-1 keeps one character per byte, and the property names are ASCII.
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const lower = text.toLowerCase();
  return lower.includes("gpslatitude") || lower.includes("gpslongitude");
}

/**
 * Walk a Photoshop Image Resource Block (APP13 `Photoshop 3.0`) and say
 * whether it names a location: the EXIF (0x0422, 0x0423) and XMP (0x0424)
 * resources Photoshop can keep there are read like their APP1 twins; the
 * IPTC-IIM record (0x0404) has place names but no coordinates. A block that
 * does not walk is not read.
 */
function photoshopNamesLocation(payload: Uint8Array): boolean | null {
  const header = "Photoshop 3.0\0";
  let at = header.length;
  let unread = false;
  while (at + 12 <= payload.length) {
    if (!asciiAt(payload, at, "8BIM")) return null;
    const id = ((payload[at + 4] as number) << 8) | (payload[at + 5] as number);
    const nameLength = payload[at + 6] as number;
    // The Pascal-string name, its length byte included, is padded to even.
    const nameEnd = at + 6 + ((nameLength + 2) & ~1);
    if (nameEnd + 4 > payload.length) return null;
    const size =
      (((payload[nameEnd] as number) << 24) >>> 0) +
      ((payload[nameEnd + 1] as number) << 16) +
      ((payload[nameEnd + 2] as number) << 8) +
      (payload[nameEnd + 3] as number);
    const dataStart = nameEnd + 4;
    if (dataStart + size > payload.length) return null;
    const data = payload.subarray(dataStart, dataStart + size);
    if (id === 0x0424 && xmpNamesLocation(data)) return true;
    if (id === 0x0422 || id === 0x0423) {
      const framed = new Uint8Array(6 + data.length);
      framed.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
      framed.set(data, 6);
      try {
        if (parseExif(framed).hasGps) return true;
      } catch {
        unread = true;
      }
    }
    at = dataStart + size + (size & 1);
  }
  return unread ? null : false;
}

/** The first bytes of an identifier, for naming a segment this does not read. */
function identifierOf(payload: Uint8Array): string {
  let id = "";
  for (let i = 0; i < Math.min(payload.length, 24); i++) {
    const b = payload[i] as number;
    if (b === 0) break;
    if (b < 0x20 || b > 0x7e) return id;
    id += String.fromCharCode(b);
  }
  return id;
}

/**
 * The APPn segments of one walk other than EXIF, each with whether it names
 * a location. XMP split across Extended XMP chunks is put back together
 * (per GUID, by offset) before it is searched, so a property cut in two by a
 * chunk boundary is still seen.
 */
function otherMetadataOf(
  walk: JpegWalk,
  base: number,
  where: (sawScan: boolean) => ExifLocation["where"],
): OtherMetadata[] {
  const out: OtherMetadata[] = [];
  const extended = new Map<
    string,
    { where: ExifLocation["where"]; offset: number; chunks: Array<[number, Uint8Array]> }
  >();
  let sawScan = false;
  for (const part of walk.parts) {
    if (part.type === "scan") {
      sawScan = true;
      continue;
    }
    const s = part.segment;
    if (s.marker < 0xe0 || s.marker > 0xef) continue;
    const p = s.payload;
    const at = { where: where(sawScan), offset: base + s.offset };
    if (s.marker === 0xe1 && asciiAt(p, 0, "Exif")) continue; // parsed as EXIF
    if (s.marker === 0xe1 && asciiAt(p, 0, XMP_ID)) {
      out.push({ segment: "APP1 XMP", ...at, location: xmpNamesLocation(p) });
      continue;
    }
    if (s.marker === 0xe1 && asciiAt(p, 0, XMP_EXTENSION_ID)) {
      if (p.length < XMP_EXTENSION_HEADER) {
        out.push({ segment: "APP1 extended XMP", ...at, location: null });
        continue;
      }
      const guid = String.fromCharCode(
        ...p.subarray(XMP_EXTENSION_ID.length, XMP_EXTENSION_ID.length + 32),
      );
      const o = XMP_EXTENSION_ID.length + 36;
      const chunkOffset =
        (((p[o] as number) << 24) >>> 0) +
        ((p[o + 1] as number) << 16) +
        ((p[o + 2] as number) << 8) +
        (p[o + 3] as number);
      const entry = extended.get(guid) ?? { ...at, chunks: [] };
      entry.chunks.push([chunkOffset, p.subarray(XMP_EXTENSION_HEADER)]);
      extended.set(guid, entry);
      continue;
    }
    let location: boolean | null = null;
    let segment = `${s.name} ${identifierOf(p)}`.trim();
    if (s.marker === 0xe0 && asciiAt(p, 0, "JFIF\0")) location = false;
    // JFXX carries a thumbnail; one coded as a JPEG (0x10) could carry EXIF.
    else if (s.marker === 0xe0 && asciiAt(p, 0, "JFXX\0")) location = p[5] === 0x10 ? null : false;
    else if (s.marker === 0xe2 && asciiAt(p, 0, "ICC_PROFILE\0")) location = false;
    // MPF indexes the appended images, which are walked for themselves.
    else if (s.marker === 0xe2 && asciiAt(p, 0, "MPF\0")) location = false;
    else if (s.marker === 0xec && asciiAt(p, 0, "Ducky")) location = false;
    else if (s.marker === 0xee && asciiAt(p, 0, "Adobe")) location = false;
    else if (s.marker === 0xed && asciiAt(p, 0, "Photoshop 3.0\0")) {
      segment = "APP13 Photoshop";
      location = photoshopNamesLocation(p);
    }
    out.push({ segment, ...at, location });
  }
  for (const entry of extended.values()) {
    entry.chunks.sort((a, b) => a[0] - b[0]);
    let total = 0;
    for (const [, chunk] of entry.chunks) total += chunk.length;
    const joined = new Uint8Array(total);
    let at = 0;
    for (const [, chunk] of entry.chunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    out.push({
      segment: "APP1 extended XMP",
      where: entry.where,
      offset: entry.offset,
      location: xmpNamesLocation(joined),
    });
  }
  return out;
}

/**
 * Every place in a JPEG that can carry metadata: EXIF before and between
 * scans, other APPn/COM segments, and the JPEGs appended after EOI (walked
 * once each, not their own trailers again). Bytes no walk accounts for —
 * after a break, a video, unrecognised data, an appended image that would
 * not walk — are counted and searched for EXIF blocks, which are parsed
 * where found. What this reports is what ExifRead answers from, so it
 * cannot call a file clean on the strength of bytes it never read.
 */
export function inspectJpegMetadata(bytes: Uint8Array): JpegMetadataReport {
  const walk = walkJpeg(bytes);
  const mainWhere = (sawScan: boolean): ExifLocation["where"] =>
    sawScan ? "between scans" : "before the first scan";
  const exifBlocks = exifBlocksOf(walk, 0, mainWhere);
  const otherMetadata = otherMetadataOf(walk, 0, mainWhere);
  const interScan: string[] = [];
  const before: string[] = [];
  let sawScan = false;
  for (const part of walk.parts) {
    if (part.type === "scan") {
      sawScan = true;
      continue;
    }
    const m = part.segment.marker;
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      (sawScan ? interScan : before).push(part.segment.name);
    }
  }
  let embeddedImages = 0;
  let attempts = 0;
  let notInspected = 0;
  // Everything from here to the end is outside the main image's walk.
  const outsideFrom = walk.eoiEnd ?? walk.stopped?.offset ?? bytes.length;
  // Ranges an appended image's walk accounts for, in order.
  const covered: Array<[number, number]> = [];
  if (walk.eoiEnd !== null && walk.trailing > 0) {
    // Each appended JPEG is walked from its SOI; a candidate inside one
    // already walked (its thumbnail, say) is skipped rather than walked
    // again. Every attempt counts against the cap, a failed one too, so a
    // trailer of false starts cannot make this quadratic.
    let coveredTo = outsideFrom;
    for (
      let i = bytes.indexOf(0xff, outsideFrom);
      i !== -1 && i + 2 < bytes.length;
      i = bytes.indexOf(0xff, i + 1)
    ) {
      if (bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 0xff || i < coveredTo) continue;
      if (attempts >= MAX_EMBEDDED_IMAGES) {
        notInspected++;
        continue;
      }
      attempts++;
      try {
        const inner = walkJpeg(bytes.subarray(i));
        embeddedImages++;
        exifBlocks.push(...exifBlocksOf(inner, i, () => "in an appended image"));
        otherMetadata.push(...otherMetadataOf(inner, i, () => "in an appended image"));
        const end = i + (inner.eoiEnd ?? inner.stopped?.offset ?? bytes.length - i);
        covered.push([i, end]);
        coveredTo = end;
      } catch {
        // Not a walkable JPEG after all (FF D8 FF inside other data, or an
        // image whose header is broken): its bytes stay unaccounted for.
      }
    }
  }
  // The rest: counted, and searched for EXIF blocks, unless it is padding.
  let unaccounted = 0;
  let signatures = 0;
  let parsedLoose = 0;
  let at = outsideFrom;
  for (const [from, to] of [...covered, [bytes.length, bytes.length] as [number, number]]) {
    if (from > at) {
      let padding = true;
      for (let k = at; k < from; k++) {
        const b = bytes[k];
        if (b !== 0x00 && b !== 0xff) {
          padding = false;
          break;
        }
      }
      if (!padding) {
        unaccounted += from - at;
        for (const offset of exifSignatures(bytes, at, from, Number.POSITIVE_INFINITY)) {
          signatures++;
          if (parsedLoose >= MAX_LOOSE_EXIF_BLOCKS) continue;
          parsedLoose++;
          let exif: ExifData | null = null;
          let unreadable: string | undefined;
          try {
            exif = parseExif(bytes.subarray(offset, from));
          } catch (err) {
            unreadable = (err as Error).message;
          }
          exifBlocks.push({
            where: "in bytes no walk accounts for",
            offset,
            exif,
            ...(unreadable === undefined ? {} : { unreadable }),
          });
        }
      }
    }
    at = Math.max(at, to);
  }
  const trailerStart = walk.eoiEnd ?? bytes.length;
  return {
    exifBlocks,
    interScanMetadataSegments: interScan,
    metadataSegments: before.filter((n) => n !== "COM").sort(),
    trailingBytes: walk.trailing,
    ...(walk.trailing > 0 ? { trailingKind: describeTrailer(bytes.subarray(trailerStart)) } : {}),
    embeddedImages,
    embeddedImagesNotInspected: notInspected,
    eoiMissing: walk.eoiEnd === null,
    ...(walk.stopped === null ? {} : { breaksOffAt: walk.stopped }),
    unaccountedBytes: unaccounted,
    exifSignaturesNotParsed: signatures - parsedLoose,
    otherMetadata,
  };
}
