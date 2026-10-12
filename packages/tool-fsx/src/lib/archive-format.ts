/**
 * Reading the entry list out of a tar or zip archive, in this process.
 *
 * WHY THIS IS NOT `tar -t` / `unzip -Z1`: the entry names are a security
 * input. `ArchiveExtract` refuses a member whose path escapes the
 * destination (zip-slip), so the list it checks has to be the authoritative
 * one. A line-based reading of another program's listing is not: a member
 * name may contain a newline, and the two tars in the wild (GNU and bsd)
 * quote control characters differently, so `../evil` could be smuggled past
 * a line-oriented check. The on-disk structures — tar's 512-byte headers and
 * zip's central directory — say exactly what the extractor will do, with no
 * quoting layer in between, so those are what this module reads.
 *
 * Both parsers are pure: bytes in, entries out. Nothing here touches the
 * filesystem or spawns anything.
 */
import { gunzipSync, inflateRawSync } from "node:zlib";

export type ArchiveEntryKind = "file" | "dir" | "symlink" | "hardlink" | "other";

/** A member an extractor would create as something other than a file, directory or link. */
export type ArchiveSpecialKind = "fifo" | "character-device" | "block-device" | "socket";

export type ArchiveEntry = {
  readonly name: string;
  readonly size: number;
  readonly kind: ArchiveEntryKind;
  /** For a symlink or hard link member, the target recorded in the archive. */
  readonly linkTarget?: string;
  /**
   * Set when the member is a FIFO, device or socket. `tar` makes a FIFO
   * member as a real FIFO (no privilege needed), and opening one blocks
   * until a writer appears: a planted `data.csv` FIFO freezes the next tool
   * that reads it.
   */
  readonly special?: ArchiveSpecialKind;
};

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveFormatError";
  }
}

const TEXT = new TextDecoder("utf-8");

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

const BLOCK = 512;

function cString(bytes: Uint8Array): string {
  let end = bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      end = i;
      break;
    }
  }
  return TEXT.decode(bytes.subarray(0, end));
}

/** tar numbers are octal ASCII, except GNU's base-256 form for large values. */
function tarNumber(bytes: Uint8Array): number {
  const first = bytes[0] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let i = 1; i < bytes.length; i++) value = value * 256 + (bytes[i] as number);
    return value;
  }
  const text = cString(bytes).trim();
  if (text === "") return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function specialFromTypeflag(flag: string): ArchiveSpecialKind | undefined {
  if (flag === "6") return "fifo";
  if (flag === "3") return "character-device";
  if (flag === "4") return "block-device";
  return undefined;
}

/** The special kind a zip member's unix mode (the high half of its external attributes) names. */
function specialFromUnixMode(mode: number): ArchiveSpecialKind | undefined {
  const type = mode & 0xf000;
  if (type === 0x1000) return "fifo";
  if (type === 0x2000) return "character-device";
  if (type === 0x6000) return "block-device";
  if (type === 0xc000) return "socket";
  return undefined;
}

function kindFromTypeflag(flag: string): ArchiveEntryKind {
  if (flag === "5") return "dir";
  if (flag === "2") return "symlink";
  if (flag === "1") return "hardlink";
  if (flag === "0" || flag === "\0" || flag === "") return "file";
  return "other";
}

/**
 * Pull `path` / `linkpath` out of a pax extended header's record stream.
 *
 * `GNU.sparse.name` names the member too, and wins over `path`: GNU's sparse
 * format stores a placeholder in `path` and the real name there, and both
 * GNU tar and libarchive (bsdtar) extract under it. A listing that ignored it
 * showed `decoy.txt` while bsdtar wrote `evil.txt` (or `.git`), past every
 * check made on the name.
 */
function parsePaxRecords(data: Uint8Array): { path?: string; linkpath?: string } {
  const text = TEXT.decode(data);
  const out: { path?: string; linkpath?: string } = {};
  let sparseName: string | undefined;
  let offset = 0;
  const fields = lengthFields(text);
  while (offset < text.length) {
    const space = fields.spaceFrom(offset);
    if (space === -1) break;
    const length = fields.parse(offset, space);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      if (key === "path") out.path = value;
      if (key === "linkpath") out.linkpath = value;
      if (key === "GNU.sparse.name") sparseName = value;
    }
    offset += length;
  }
  if (sparseName !== undefined) out.path = sparseName;
  return out;
}

/** Whether `parseInt` skips this code unit as leading white space. */
function parseIntSkips(code: number): boolean {
  if (code > 32 && code < 127) return false;
  // Asked of parseInt itself, so the set is exactly the one it trims.
  return Number.parseInt(`${String.fromCharCode(code)}1`, 10) === 1;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * The record loop's two reads, `text.indexOf(" ", offset)` and
 * `Number.parseInt(text.slice(offset, space), 10)`, without reading any
 * character twice.
 *
 * Each length field is read from where the previous record ended. A length
 * shorter than its own field puts the next read inside the same field, and
 * reading the field from there again each time made a header of a million
 * zeros before `1 ` cost half a million million character reads: a tiny
 * .tar.gz that hung ArchiveList. Offsets only grow, so the first space at or
 * after one is the first after the next until the offset passes it, and the
 * white space, sign, leading zeros and digits `parseInt` reads are each
 * scanned once, from where the last read stopped.
 */
function lengthFields(text: string): {
  spaceFrom(offset: number): number;
  parse(offset: number, space: number): number;
} {
  // Forward-only positions. Each scan stops at the field's space, which the
  // next field's offset is past, so a position left from an earlier field is
  // behind the offset and is moved up to it before it is used.
  const at = { space: -1, white: 0, zeros: 0, digits: 0 };
  return {
    spaceFrom(offset) {
      if (at.space < offset) at.space = text.indexOf(" ", offset);
      return at.space;
    },
    parse(offset, space) {
      if (at.white < offset) at.white = offset;
      while (at.white < space && parseIntSkips(text.charCodeAt(at.white))) at.white += 1;
      if (at.white === space) return Number.NaN;
      const sign = text.charCodeAt(at.white);
      const first = sign === 43 || sign === 45 ? at.white + 1 : at.white;
      if (at.zeros < first) at.zeros = first;
      while (at.zeros < space && text.charCodeAt(at.zeros) === 48) at.zeros += 1;
      if (at.digits < at.zeros) at.digits = at.zeros;
      while (at.digits < space && isDigit(text.charCodeAt(at.digits))) at.digits += 1;
      if (at.digits === first) return Number.NaN;
      // Past 15 significant digits the value is beyond any offset in the text,
      // so this read ends the loop: parseInt itself gives it, rounding and all.
      if (at.digits - at.zeros > 15) return Number.parseInt(text.slice(offset, space), 10);
      const magnitude = at.digits === at.zeros ? 0 : Number(text.slice(at.zeros, at.digits));
      return sign === 45 ? -magnitude : magnitude;
    },
  };
}

/**
 * Parse an uncompressed tar stream. Handles ustar `prefix`, GNU `L`/`K` long
 * names and pax `x` extended headers — the three ways a name longer than 100
 * bytes is stored, and precisely the ones a hand-rolled 100-byte read would
 * get wrong.
 */
export function readTarEntries(data: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let pendingName: string | undefined;
  let pendingLink: string | undefined;
  let zeroBlocks = 0;

  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += BLOCK;
      if (zeroBlocks >= 2) break; // the archive's end-of-file marker
      continue;
    }
    zeroBlocks = 0;

    // The magic field is six bytes. POSIX ustar writes "ustar\0"; the GNU
    // format — which is what GNU tar produces BY DEFAULT, so most tars made
    // on Linux — writes "ustar " with a trailing space and " \0" for the
    // version. A v7 tar leaves the field empty. Comparing the trimmed value
    // accepts all three; an exact match against "ustar" alone rejects every
    // archive GNU tar has ever written.
    const magic = cString(header.subarray(257, 263));
    const magicKind: "posix" | "gnu" | "v7" =
      magic === "ustar" ? "posix" : magic.trim() === "ustar" ? "gnu" : "v7";
    if (magicKind === "v7" && magic.trim() !== "") {
      throw new ArchiveFormatError(`not a tar archive (bad magic "${magic}" at byte ${offset})`);
    }
    const size = tarNumber(header.subarray(124, 136));
    if (size < 0 || !Number.isFinite(size)) {
      throw new ArchiveFormatError(`tar member at byte ${offset} declares an impossible size`);
    }
    const typeflag = cString(header.subarray(156, 157));
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > data.length) {
      throw new ArchiveFormatError("tar archive is truncated");
    }

    if (typeflag === "L" || typeflag === "K") {
      const value = cString(data.subarray(dataStart, dataEnd));
      if (typeflag === "L") pendingName = value;
      else pendingLink = value;
    } else if (typeflag === "x" || typeflag === "g") {
      const records = parsePaxRecords(data.subarray(dataStart, dataEnd));
      if (records.path !== undefined) pendingName = records.path;
      if (records.linkpath !== undefined) pendingLink = records.linkpath;
    } else {
      const shortName = cString(header.subarray(0, 100));
      // Bytes 345–500 are the ustar `prefix` field only in the POSIX format.
      // The GNU format reuses that region for atime/ctime and sparse-file
      // records, so reading it as a path there would invent a name.
      const prefix = magicKind === "posix" ? cString(header.subarray(345, 500)) : "";
      const name = pendingName ?? (prefix === "" ? shortName : `${prefix}/${shortName}`);
      const linkTarget = pendingLink ?? cString(header.subarray(157, 257));
      const kind = kindFromTypeflag(typeflag);
      const special = specialFromTypeflag(typeflag);
      entries.push({
        name,
        size: kind === "dir" ? 0 : size,
        kind,
        ...(linkTarget !== "" ? { linkTarget } : {}),
        ...(special !== undefined ? { special } : {}),
      });
      pendingName = undefined;
      pendingLink = undefined;
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** End-of-central-directory record plus the largest possible zip comment. */
const MAX_EOCD_SEARCH = 22 + 0xffff;

const LOCAL_SIGNATURE = 0x04034b50;
/** A symlink target longer than this is not a path anyone meant to store. */
const MAX_LINK_TARGET_BYTES = 8192;
/**
 * The most compressed bytes a deflated link target may take. Deflate adds at
 * most a few percent to data it cannot compress (zlib's worst for 8,192
 * bytes is 8,655), so a target within the limit always fits in twice it.
 */
const MAX_DEFLATED_LINK_TARGET_BYTES = 2 * MAX_LINK_TARGET_BYTES;

/** What a deflated link target is inflated with. */
const inflater = { raw: inflateRawSync };

/**
 * Test seam: stand in for the inflater, so a test can count the bytes it is
 * handed and returns. Pass `undefined` to restore.
 */
export function _setInflateRawForTest(fn: typeof inflateRawSync | undefined): void {
  inflater.raw = fn ?? inflateRawSync;
}

/**
 * What one listing has read of its link targets.
 *
 * Many central-directory entries may name the same member data; a zip
 * writer never does that, a crafted archive can. Each target is read once
 * and kept, by where its data starts, how long it is and how it is stored,
 * which is everything the answer depends on. And the data read for distinct
 * targets may come to no more than the archive's own size, which members
 * that each have their own data never exceed, since theirs do not overlap.
 * Past that a target reads as unstated, which the link check refuses: a
 * crafted archive is stopped, not believed.
 *
 * What this bounds is the data handed to the inflater. Each distinct target
 * may still inflate to its own limit, so a crafted archive that names short
 * blocks at several lengths gets more inflated output for its size than one
 * whose links each have their own data. That output is still linear in the
 * archive's size, and a target that inflates past its limit is refused.
 */
type LinkReads = {
  readonly known: Map<string, string | undefined>;
  /** Bytes of member data read for targets so far. */
  spent: number;
};

/**
 * Read a symlink member's target, which a zip stores as the member's own
 * FILE DATA. The central directory records where that data starts, so the
 * local header is consulted for this one purpose (and only for the name and
 * extra-field lengths, which are the sole way to find the data offset).
 *
 * Returns undefined when the target cannot be recovered. `ArchiveExtract`
 * treats that as a refusal rather than as "no target", because an
 * unverifiable symlink is exactly what a crafted archive would present.
 */
function readZipLinkTarget(
  data: Uint8Array,
  view: DataView,
  localOffset: number,
  compressedSize: number,
  method: number,
  reads: LinkReads,
): string | undefined {
  if (localOffset + 30 > data.length) return undefined;
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) return undefined;
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (compressedSize < 0 || end > data.length) return undefined;
  const key = `${start}:${compressedSize}:${method}`;
  if (reads.known.has(key)) return reads.known.get(key);
  if (reads.spent + compressedSize > data.length) return undefined;
  const target = decodeZipLinkTarget(data.subarray(start, end), method, reads);
  reads.known.set(key, target);
  return target;
}

/** A link target from its stored bytes, or undefined; `reads.spent` counts what is read. */
function decodeZipLinkTarget(
  stored: Uint8Array,
  method: number,
  reads: LinkReads,
): string | undefined {
  try {
    if (method === 0) {
      if (stored.length > MAX_LINK_TARGET_BYTES) return undefined;
      reads.spent += stored.length;
      return TEXT.decode(stored);
    }
    if (method === 8) {
      // Bounded before and during inflation. Every member's target was
      // inflated whole and only then measured, and many members can name the
      // same data: a 102 KB zip made the listing inflate 2 GB. Compressed
      // data past the bound is refused unread (a stream of empty blocks
      // reads all of it and writes nothing); output past the limit throws.
      if (stored.length > MAX_DEFLATED_LINK_TARGET_BYTES) return undefined;
      reads.spent += stored.length;
      const inflated = inflater.raw(stored, { maxOutputLength: MAX_LINK_TARGET_BYTES });
      if (inflated.length > MAX_LINK_TARGET_BYTES) return undefined;
      return TEXT.decode(inflated);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Parse a zip's CENTRAL DIRECTORY — the index the extractor itself trusts.
 * The per-file local headers are not read for names or sizes: a crafted
 * archive can disagree between the two, and every real unzip resolves that
 * by believing the central directory. The one exception is a symlink
 * member's target, which lives nowhere but the member's data.
 */
export function readZipEntries(data: Uint8Array): ArchiveEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const searchFrom = Math.max(0, data.length - MAX_EOCD_SEARCH);
  let eocd = -1;
  for (let i = data.length - 22; i >= searchFrom; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new ArchiveFormatError("not a zip archive (no end-of-central-directory record)");
  }
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new ArchiveFormatError(
      "this is a ZIP64 archive; reading its entry list is not supported, so it is refused rather than partly trusted",
    );
  }

  const entries: ArchiveEntry[] = [];
  const reads: LinkReads = { known: new Map(), spent: 0 };
  let offset = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > data.length || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new ArchiveFormatError(`zip central directory is malformed at entry ${i}`);
    }
    const method = view.getUint16(offset + 10, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const name = TEXT.decode(data.subarray(nameStart, nameStart + nameLength));
    // The high 16 bits hold the unix mode when the archive was made on unix;
    // 0xA000 is S_IFLNK, which is how a zip stores a symlink.
    const unixMode = externalAttributes >>> 16;
    const isSymlink = (unixMode & 0xf000) === 0xa000;
    const kind: ArchiveEntryKind = isSymlink ? "symlink" : name.endsWith("/") ? "dir" : "file";
    const linkTarget = isSymlink
      ? readZipLinkTarget(data, view, localOffset, compressedSize, method, reads)
      : undefined;
    const special = specialFromUnixMode(unixMode);
    entries.push({
      name,
      size: kind === "dir" ? 0 : size,
      kind,
      ...(linkTarget !== undefined ? { linkTarget } : {}),
      ...(special !== undefined ? { special } : {}),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// format detection
// ---------------------------------------------------------------------------

export type ArchiveFormat = "tar" | "tar.gz" | "zip";

/** Detect the format from the leading bytes, falling back to the extension. */
export function detectArchiveFormat(data: Uint8Array, fileName: string): ArchiveFormat | undefined {
  if (data[0] === 0x50 && data[1] === 0x4b) return "zip";
  if (data[0] === 0x1f && data[1] === 0x8b) return "tar.gz";
  // A plain tar has no leading magic; its ustar marker sits at byte 257.
  if (data.length >= 263) {
    const magic = TEXT.decode(data.subarray(257, 262));
    if (magic === "ustar") return "tar";
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  return undefined;
}

/**
 * The uncompressed size a gzip member declares, from the ISIZE field in its
 * last four bytes. It is only the true size modulo 2^32, which is why the
 * caller treats it as a floor to refuse on rather than as a fact to trust.
 */
export function gzipDeclaredSize(data: Uint8Array): number | undefined {
  if (data.length < 18) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getUint32(data.length - 4, true);
}

/**
 * Entries of an archive already read into memory, whatever its format.
 *
 * `maxDecompressedBytes` bounds the gzip path. A gzip of a few hundred
 * kilobytes expands to hundreds of megabytes of zeros, so capping the file
 * on disk caps nothing: without this the tool allocates whatever the archive
 * asks it to, and a 100 MiB bomb is enough to take the process down.
 *
 * The listing has to be the one the extractor will act on. `tar -xz` decodes
 * EVERY gzip member of a concatenated file, while `Bun.gunzipSync` stops
 * after the first, so a second member could carry entries no gate had seen
 * (a hidden `.git/config`, a top-level name that replaces an existing
 * directory). `node:zlib`'s `gunzipSync` decodes them all, as gzip(1) does,
 * and `maxOutputLength` makes it throw before it allocates past the cap —
 * the ISIZE trailer is only a fast path, since an archive can forge it.
 */
export function readArchiveEntries(
  data: Uint8Array,
  format: ArchiveFormat,
  maxDecompressedBytes = Number.POSITIVE_INFINITY,
): ArchiveEntry[] {
  if (format === "zip") return readZipEntries(data);
  if (format !== "tar.gz") return readTarEntries(data);
  const declared = gzipDeclaredSize(data);
  if (declared !== undefined && declared > maxDecompressedBytes) {
    throw new ArchiveFormatError(
      `this .tar.gz declares ${declared} bytes of content, over the ${maxDecompressedBytes}-byte limit for reading one in memory`,
    );
  }
  let tarBytes: Uint8Array;
  try {
    tarBytes = gunzipSync(data, {
      ...(Number.isFinite(maxDecompressedBytes) ? { maxOutputLength: maxDecompressedBytes } : {}),
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
      throw new ArchiveFormatError(
        `this .tar.gz expands to more than ${maxDecompressedBytes} bytes, over the limit for reading one in memory`,
      );
    }
    throw new ArchiveFormatError(
      `this .tar.gz could not be decompressed (${typeof code === "string" ? code : (err as Error).message})`,
    );
  }
  return readTarEntries(tarBytes);
}
