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

export type ArchiveEntryKind = "file" | "dir" | "symlink" | "hardlink" | "other";

export type ArchiveEntry = {
  readonly name: string;
  readonly size: number;
  readonly kind: ArchiveEntryKind;
  /** For a symlink or hard link member, the target recorded in the archive. */
  readonly linkTarget?: string;
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

function kindFromTypeflag(flag: string): ArchiveEntryKind {
  if (flag === "5") return "dir";
  if (flag === "2") return "symlink";
  if (flag === "1") return "hardlink";
  if (flag === "0" || flag === "\0" || flag === "") return "file";
  return "other";
}

/** Pull `path` / `linkpath` out of a pax extended header's record stream. */
function parsePaxRecords(data: Uint8Array): { path?: string; linkpath?: string } {
  const text = TEXT.decode(data);
  const out: { path?: string; linkpath?: string } = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      if (key === "path") out.path = value;
      if (key === "linkpath") out.linkpath = value;
    }
    offset += length;
  }
  return out;
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
      entries.push({
        name,
        size: kind === "dir" ? 0 : size,
        kind,
        ...(linkTarget !== "" ? { linkTarget } : {}),
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
): string | undefined {
  if (localOffset + 30 > data.length) return undefined;
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) return undefined;
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (compressedSize < 0 || end > data.length) return undefined;
  const stored = data.subarray(start, end);
  try {
    if (method === 0) {
      if (stored.length > MAX_LINK_TARGET_BYTES) return undefined;
      return TEXT.decode(stored);
    }
    if (method === 8) {
      const inflated = Bun.inflateSync(stored as Uint8Array<ArrayBuffer>);
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
      ? readZipLinkTarget(data, view, localOffset, compressedSize, method)
      : undefined;
    entries.push({
      name,
      size: kind === "dir" ? 0 : size,
      kind,
      ...(linkTarget !== undefined ? { linkTarget } : {}),
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
  // The cast narrows ArrayBufferLike to ArrayBuffer for Bun's signature; the
  // bytes come from a file read, never from a SharedArrayBuffer.
  const tarBytes = Bun.gunzipSync(data as Uint8Array<ArrayBuffer>);
  if (tarBytes.length > maxDecompressedBytes) {
    throw new ArchiveFormatError(
      `this .tar.gz expands to ${tarBytes.length} bytes, over the ${maxDecompressedBytes}-byte limit for reading one in memory`,
    );
  }
  return readTarEntries(tarBytes);
}
