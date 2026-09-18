/**
 * A reader for tar archives, enough of one to inspect a package tarball.
 *
 * This LISTS; it never extracts. That removes the whole class of archive
 * extraction bugs — path traversal through `../`, absolute member names,
 * symlink members pointing outside the destination — because nothing is ever
 * written anywhere. Member names are returned exactly as the archive stores
 * them, including any that look hostile, so a caller can see them.
 */
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

export type TarEntry = {
  /** The member name as stored, with `prefix` joined on when present. */
  readonly name: string;
  readonly size: number;
  readonly mode: number;
  readonly type: "file" | "directory" | "symlink" | "hardlink" | "other";
  /** For symlink and hardlink members. */
  readonly linkname: string;
  /** Seconds since the epoch, as the archive recorded it. */
  readonly mtime: number;
};

export type TarListing = {
  readonly entries: ReadonlyArray<TarEntry>;
  /** True when the archive ended before its terminator. */
  readonly truncated: boolean;
  /** True when the entry cap stopped the walk before the end. */
  readonly capped: boolean;
};

export type TarOptions = {
  /** Stop after this many entries. Default 10,000. */
  readonly maxEntries?: number;
  /**
   * Refuse to decompress past this many bytes. Default 1 GiB.
   *
   * A size limit on the FILE bounds nothing: gzip of a repetitive stream
   * runs to a thousand to one, so a 200 KB archive expands to 200 MB and a
   * few hundred megabytes expands until the process dies. The limit that
   * matters is on the output, and zlib can enforce it while inflating
   * rather than after.
   */
  readonly maxBytes?: number;
};

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

/** Gzip's magic bytes. A tar may or may not be compressed. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function cstring(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end)).trim();
}

/**
 * A numeric header field.
 *
 * Normally octal ASCII. When a value does not fit — a file over 8 GiB, a
 * timestamp past 2242 — GNU sets the high bit of the first byte and stores
 * big-endian binary instead. Reading that as octal yields nonsense, and the
 * nonsense is a byte offset, so the walk would desynchronise and report
 * garbage entries rather than failing.
 */
function numeric(buf: Uint8Array, offset: number, length: number): number {
  const first = buf[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + (buf[offset + i] ?? 0);
    return value;
  }
  const text = cstring(buf, offset, length).replace(/[^0-7]/g, "");
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function typeOf(flag: string): TarEntry["type"] {
  switch (flag) {
    case "0":
    case "\0":
    case "":
      return "file";
    case "1":
      return "hardlink";
    case "2":
      return "symlink";
    case "5":
      return "directory";
    default:
      return "other";
  }
}

/**
 * Whether a header block's stored checksum matches its contents.
 *
 * Without this, any 512 bytes of file data can be mistaken for a header. The
 * checksum is computed with the checksum field itself read as spaces.
 */
function checksumOk(block: Uint8Array): boolean {
  const stored = numeric(block, 148, 8);
  let signed = 0;
  let unsigned = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  // Some historical writers summed the bytes as signed chars.
  return stored === unsigned || stored === signed;
}

export function listTar(input: Uint8Array, options: TarOptions = {}): TarListing {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let bytes: Uint8Array;
  if (isGzip(input)) {
    try {
      bytes = new Uint8Array(gunzipSync(input, { maxOutputLength: maxBytes }));
    } catch (err) {
      const message = (err as Error).message;
      throw new Error(
        /buffer|length|memory/i.test(message)
          ? `the archive expands past the ${maxBytes}-byte limit — it is a decompression bomb, or it is genuinely that large and needs a raised limit`
          : `the archive could not be decompressed: ${message}`,
      );
    }
  } else {
    bytes = input;
  }

  const entries: TarEntry[] = [];
  let offset = 0;
  let truncated = false;
  /**
   * A well-formed archive ends with zero blocks. Running out of input
   * instead means the archive was cut short — and an archive cut exactly on
   * a block boundary would otherwise just end the loop and be reported as
   * complete, which is the worst way to be wrong about a tarball.
   */
  let sawTerminator = false;
  // GNU stores an over-long name or link target in a preceding entry whose
  // body is the real value; it applies to the entry that follows it.
  let pendingName: string | undefined;
  let pendingLink: string | undefined;

  while (offset + BLOCK <= bytes.length) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) {
      sawTerminator = true;
      break;
    }

    if (!checksumOk(block)) {
      truncated = true;
      break;
    }

    const size = numeric(block, 124, 12);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) {
      truncated = true;
      break;
    }

    const flag = cstring(block, 156, 1);
    if (flag === "L" || flag === "K") {
      const value = cstring(bytes, dataStart, size);
      if (flag === "L") pendingName = value;
      else pendingLink = value;
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (flag === "x" || flag === "g") {
      // pax extended headers: `<len> key=value\n` records.
      const text = new TextDecoder().decode(bytes.subarray(dataStart, dataEnd));
      const path = /(?:^|\n)\d+ path=([^\n]*)/.exec(text)?.[1];
      const link = /(?:^|\n)\d+ linkpath=([^\n]*)/.exec(text)?.[1];
      if (path !== undefined) pendingName = path;
      if (link !== undefined) pendingLink = link;
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }

    const prefix = cstring(block, 345, 155);
    const stored = cstring(block, 0, 100);
    const name = pendingName ?? (prefix === "" ? stored : `${prefix}/${stored}`);
    const linkname = pendingLink ?? cstring(block, 157, 100);
    pendingName = undefined;
    pendingLink = undefined;

    entries.push({
      name,
      size,
      mode: numeric(block, 100, 8),
      type: typeOf(flag),
      linkname,
      mtime: numeric(block, 136, 12),
    });

    if (entries.length >= maxEntries) {
      return { entries, truncated: false, capped: true };
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }

  return { entries, truncated: truncated || !sawTerminator, capped: false };
}
