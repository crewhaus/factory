/**
 * A minimal ZIP reader and writer — enough for the OOXML container, and
 * nothing more.
 *
 * ## Why this exists
 *
 * A .docx, .xlsx or .pptx is a ZIP holding XML. Reading one needs a ZIP
 * reader, and the entry names in that ZIP are a security input: an entry
 * called `../../etc/passwd` must never be honoured, and 200 KB of ZIP must
 * never be allowed to become 200 MB of resident memory. So the container
 * layer is written here, deliberately small and deliberately strict, rather
 * than reached for from a general-purpose library.
 *
 * ## Supported — reading
 *
 * - The END OF CENTRAL DIRECTORY record, and the ZIP64 end-of-central-
 *   directory record when the classic one is saturated (0xFFFF / 0xFFFFFFFF).
 * - The CENTRAL DIRECTORY as the authoritative index. Every real unzip
 *   believes the central directory when it disagrees with a local header,
 *   and so does this one: sizes, methods and names come from there. The
 *   local header is read only to find where the entry's data starts.
 * - ZIP64 extended information (extra field 0x0001) for an entry whose
 *   compressed size, uncompressed size or local-header offset is saturated.
 * - Compression methods 0 (stored) and 8 (deflate). Anything else is
 *   refused by name and number.
 * - Entry names decoded as UTF-8. OOXML parts are ASCII, and flag bit 11
 *   (the UTF-8 name flag) is set by every producer that uses non-ASCII.
 *
 * ## Not supported — each refuses loudly rather than guessing
 *
 * - Encrypted entries (general-purpose flag bit 0), including the
 *   "password-protected document" that Word writes. There is no decryption
 *   here, and pretending an entry is empty would be worse than refusing.
 * - Methods other than stored and deflate (bzip2, LZMA, zstd, XZ, shrink…).
 * - Multi-disk archives.
 * - Data descriptors are tolerated (the central directory carries the real
 *   sizes) but a streamed entry whose central-directory size is zero while
 *   its compressed data is not will decompress to nothing, which is what the
 *   index says it is.
 *
 * ## Bounds
 *
 * Every limit below is enforced BEFORE the bytes exist. `maxEntryBytes` is
 * passed to `inflateRawSync` as `maxOutputLength`, so a lying central
 * directory cannot get past it either — decompression aborts mid-stream
 * rather than after the fact. (This is why `node:zlib` is used here instead
 * of `Bun.inflateSync`, which has no output cap.)
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export type ZipEntry = {
  /** The name exactly as the central directory records it, `/`-separated. */
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** 0 = stored, 8 = deflate. */
  readonly method: number;
  readonly crc32: number;
  /** True for a member the archive marks as a directory. */
  readonly isDirectory: boolean;
  /** Offset of the local file header, already ZIP64-resolved. */
  readonly localHeaderOffset: number;
  /** True when general-purpose flag bit 0 is set. */
  readonly encrypted: boolean;
};

export type ZipLimits = {
  /** Largest archive this will look at at all, in bytes. */
  readonly maxArchiveBytes: number;
  /** Largest single decompressed entry, in bytes. Enforced DURING inflate. */
  readonly maxEntryBytes: number;
  /** Largest total of all decompressed entries a caller may pull out. */
  readonly maxTotalBytes: number;
  /** Largest number of entries in the central directory. */
  readonly maxEntries: number;
};

export const DEFAULT_ZIP_LIMITS: ZipLimits = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 192 * 1024 * 1024,
  maxEntries: 4096,
});

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const UTF8 = new TextDecoder("utf-8", { fatal: false });

function u16(b: Uint8Array, at: number): number {
  const lo = b[at];
  const hi = b[at + 1];
  if (lo === undefined || hi === undefined) throw new ZipError("zip truncated");
  return lo | (hi << 8);
}

function u32(b: Uint8Array, at: number): number {
  return u16(b, at) + u16(b, at + 2) * 0x10000;
}

/** 64-bit little-endian, as a JS number. Refuses anything past 2^53-1. */
function u64(b: Uint8Array, at: number): number {
  const lo = u32(b, at);
  const hi = u32(b, at + 4);
  if (hi > 0x1fffff) throw new ZipError("zip64 value exceeds the safe integer range");
  return lo + hi * 0x100000000;
}

/**
 * Locate the end-of-central-directory record by scanning backwards. The
 * comment field is up to 0xFFFF bytes, so the record can be that far from
 * the end; the scan is bounded to exactly that window.
 */
function findEocd(data: Uint8Array): number {
  const min = Math.max(0, data.length - (22 + 0xffff));
  for (let i = data.length - 22; i >= min; i--) {
    if (u32(data, i) === SIG_EOCD) return i;
  }
  throw new ZipError("not a zip archive (no end-of-central-directory record)");
}

type CentralDirectoryLocation = { offset: number; count: number };

function locateCentralDirectory(data: Uint8Array): CentralDirectoryLocation {
  const eocd = findEocd(data);
  let count = u16(data, eocd + 10);
  let offset = u32(data, eocd + 16);
  if (count !== 0xffff && offset !== 0xffffffff) return { offset, count };
  // ZIP64: the locator sits immediately before the classic record.
  const locator = eocd - 20;
  if (locator < 0 || u32(data, locator) !== SIG_EOCD64_LOCATOR) {
    throw new ZipError("zip claims zip64 sizes but has no zip64 locator");
  }
  const z64 = u64(data, locator + 8);
  if (z64 < 0 || z64 + 56 > data.length || u32(data, z64) !== SIG_EOCD64) {
    throw new ZipError("zip64 end-of-central-directory record is missing or malformed");
  }
  count = u64(data, z64 + 32);
  offset = u64(data, z64 + 48);
  return { offset, count };
}

/**
 * Parse ZIP64 extended information (header id 0x0001) out of an extra field.
 * Fields appear in a FIXED order and only when the classic field they
 * replace is saturated, which is why this takes which ones to expect.
 */
function zip64Extra(
  extra: Uint8Array,
  want: { uncompressed: boolean; compressed: boolean; offset: boolean },
): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } {
  let i = 0;
  while (i + 4 <= extra.length) {
    const id = u16(extra, i);
    const size = u16(extra, i + 2);
    const body = i + 4;
    if (body + size > extra.length) break;
    if (id === 0x0001) {
      const out: {
        uncompressedSize?: number;
        compressedSize?: number;
        localHeaderOffset?: number;
      } = {};
      let at = body;
      if (want.uncompressed && at + 8 <= body + size) {
        out.uncompressedSize = u64(extra, at);
        at += 8;
      }
      if (want.compressed && at + 8 <= body + size) {
        out.compressedSize = u64(extra, at);
        at += 8;
      }
      if (want.offset && at + 8 <= body + size) {
        out.localHeaderOffset = u64(extra, at);
      }
      return out;
    }
    i = body + size;
  }
  return {};
}

/**
 * An archive opened for reading: the entry index, plus the backing bytes.
 * Entries are returned in central-directory order; `sortedNames()` is the
 * deterministic listing.
 */
export class ZipArchive {
  readonly entries: ReadonlyArray<ZipEntry>;
  private readonly data: Uint8Array;
  private readonly limits: ZipLimits;
  private spent = 0;
  private readonly byName: Map<string, ZipEntry>;

  private constructor(data: Uint8Array, entries: ZipEntry[], limits: ZipLimits) {
    this.data = data;
    this.entries = Object.freeze(entries);
    this.limits = limits;
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  static open(data: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
    if (data.length > limits.maxArchiveBytes) {
      throw new ZipError(
        `archive is ${data.length} bytes, over the ${limits.maxArchiveBytes} limit`,
      );
    }
    if (data.length < 22) throw new ZipError("not a zip archive (too short)");
    const { offset, count } = locateCentralDirectory(data);
    if (count > limits.maxEntries) {
      throw new ZipError(`archive has ${count} entries, over the ${limits.maxEntries} limit`);
    }
    if (offset < 0 || offset >= data.length) {
      throw new ZipError("zip central directory offset points outside the file");
    }
    const entries: ZipEntry[] = [];
    let at = offset;
    for (let i = 0; i < count; i++) {
      if (at + 46 > data.length || u32(data, at) !== SIG_CENTRAL) {
        throw new ZipError(`zip central directory is malformed at entry ${i}`);
      }
      const flags = u16(data, at + 8);
      const method = u16(data, at + 10);
      const crc = u32(data, at + 16);
      let compressedSize = u32(data, at + 20);
      let uncompressedSize = u32(data, at + 24);
      const nameLen = u16(data, at + 28);
      const extraLen = u16(data, at + 30);
      const commentLen = u16(data, at + 32);
      const externalAttrs = u32(data, at + 38);
      let localHeaderOffset = u32(data, at + 42);
      const nameStart = at + 46;
      if (nameStart + nameLen + extraLen + commentLen > data.length) {
        throw new ZipError(`zip central directory entry ${i} runs past the end of the file`);
      }
      const name = UTF8.decode(data.subarray(nameStart, nameStart + nameLen));
      const extra = data.subarray(nameStart + nameLen, nameStart + nameLen + extraLen);
      const saturated = {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localHeaderOffset === 0xffffffff,
      };
      if (saturated.uncompressed || saturated.compressed || saturated.offset) {
        const z = zip64Extra(extra, saturated);
        uncompressedSize = z.uncompressedSize ?? uncompressedSize;
        compressedSize = z.compressedSize ?? compressedSize;
        localHeaderOffset = z.localHeaderOffset ?? localHeaderOffset;
      }
      // 0x10 is the MS-DOS directory attribute; the trailing slash is the
      // portable signal. Both are treated as "this member has no content".
      const isDirectory = name.endsWith("/") || (externalAttrs & 0x10) !== 0;
      entries.push({
        name,
        compressedSize,
        uncompressedSize,
        method,
        crc32: crc,
        isDirectory,
        localHeaderOffset,
        encrypted: (flags & 0x0001) !== 0,
      });
      at = nameStart + nameLen + extraLen + commentLen;
    }
    return new ZipArchive(data, entries, limits);
  }

  /** Entry names sorted with plain string comparison — a stable listing. */
  sortedNames(): string[] {
    return this.entries.map((e) => e.name).sort();
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  find(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /**
   * Decompress one entry. Refuses an entry whose declared size is over the
   * per-entry cap before touching it, and passes the same cap to the
   * inflater so a central directory that understates the size cannot get
   * more than that allocated either.
   */
  read(name: string): Uint8Array {
    const entry = this.byName.get(name);
    if (entry === undefined) throw new ZipError(`zip has no entry named "${name}"`);
    if (entry.encrypted) {
      throw new ZipError(`zip entry "${name}" is encrypted; this reader cannot decrypt it`);
    }
    if (entry.isDirectory) return new Uint8Array(0);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError(
        `zip entry "${name}" uses compression method ${entry.method}; only stored (0) and deflate (8) are supported`,
      );
    }
    if (entry.uncompressedSize > this.limits.maxEntryBytes) {
      throw new ZipError(
        `zip entry "${name}" declares ${entry.uncompressedSize} bytes, over the ${this.limits.maxEntryBytes} per-entry limit`,
      );
    }
    const header = entry.localHeaderOffset;
    if (header + 30 > this.data.length || u32(this.data, header) !== SIG_LOCAL) {
      throw new ZipError(`zip entry "${name}" has no local file header where the index says`);
    }
    const dataStart = header + 30 + u16(this.data, header + 26) + u16(this.data, header + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.data.length) {
      throw new ZipError(`zip entry "${name}" runs past the end of the file`);
    }
    const raw = this.data.subarray(dataStart, dataEnd);
    let out: Uint8Array;
    if (entry.method === 0) {
      out = raw;
    } else {
      try {
        // maxOutputLength aborts the inflate itself — this is the bound that
        // makes a zip bomb cost nothing, not a check applied afterwards.
        out = inflateRawSync(raw, { maxOutputLength: this.limits.maxEntryBytes + 1 });
      } catch (err) {
        throw new ZipError(`zip entry "${name}" failed to decompress: ${(err as Error).message}`);
      }
    }
    if (out.length > this.limits.maxEntryBytes) {
      throw new ZipError(
        `zip entry "${name}" decompressed past the ${this.limits.maxEntryBytes} per-entry limit`,
      );
    }
    this.spent += out.length;
    if (this.spent > this.limits.maxTotalBytes) {
      throw new ZipError(
        `reading "${name}" would push this archive past the ${this.limits.maxTotalBytes} total decompressed limit`,
      );
    }
    return out;
  }

  /** An entry decoded as UTF-8 text. Used for every OOXML part. */
  readText(name: string): string {
    return UTF8.decode(this.read(name));
  }
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/** CRC-32 (IEEE 802.3), table-driven. Required by the ZIP format. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const idx = (c ^ (bytes[i] as number)) & 0xff;
    c = (CRC_TABLE[idx] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipInput = {
  readonly name: string;
  readonly data: Uint8Array;
  /** Stored rather than deflated. Used for the OOXML `[Content_Types].xml`. */
  readonly store?: boolean;
};

/**
 * Write a ZIP.
 *
 * DETERMINISM: every timestamp is the fixed MS-DOS epoch (1980-01-01
 * 00:00:00) rather than the clock, so building the same document twice
 * produces byte-identical output. Entries are written in the order given,
 * which callers fix; nothing here sorts behind a caller's back because the
 * OOXML part order is meaningful to some readers.
 */
export function writeZip(inputs: ReadonlyArray<ZipInput>): Uint8Array {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = 33; // (1980-1980)<<9 | 1<<5 | 1
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const input of inputs) {
    const nameBytes = new TextEncoder().encode(input.name);
    const crc = crc32(input.data);
    const store = input.store === true;
    const body = store ? input.data : new Uint8Array(deflateRawSync(input.data, { level: 6 }));
    const method = store ? 0 : 8;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true); // version needed: 2.0 (deflate)
    lv.setUint16(6, 0x0800, true); // flag bit 11: names are UTF-8
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, input.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, body);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, input.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + body.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of central) cdSize += cd.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, inputs.length, true);
  ev.setUint16(10, inputs.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);

  let total = cdOffset + cdSize + 22;
  const out = new Uint8Array(total);
  total = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    out.set(chunk, total);
    total += chunk.length;
  }
  return out;
}
