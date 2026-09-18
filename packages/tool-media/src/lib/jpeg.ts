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
 * IFD1 thumbnails, XMP, IPTC, and EXIF carried in a TIFF or HEIC rather
 * than a JPEG. Each would be a separate parser; none is approximated.
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
};

/**
 * A JPEG with its metadata segments dropped. The scan data is copied
 * verbatim — nothing is re-encoded, so the image is bit-for-bit the same
 * picture, just without the record of who took it and where.
 */
export function stripJpegMetadata(bytes: Uint8Array, options: StripOptions = {}): StripResult {
  const { segments, scanStart } = readJpegSegments(bytes);
  const kept: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  const removed: Array<{ name: string; bytes: number }> = [];
  for (const segment of segments) {
    if (segment.marker === 0xd8) continue;
    if (isMetadata(segment, options)) {
      removed.push({ name: segment.name, bytes: segment.length });
      continue;
    }
    kept.push(bytes.subarray(segment.offset, segment.offset + segment.length));
  }
  kept.push(bytes.subarray(scanStart));
  let total = 0;
  for (const part of kept) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of kept) {
    out.set(part, at);
    at += part.length;
  }
  return { bytes: out, removed, bytesRemoved: bytes.length - out.length };
}
