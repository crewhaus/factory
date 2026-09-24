import {
  constants,
  type Stats,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { type FileHandle, lstat, open, stat } from "node:fs/promises";
import { decodeHead } from "./utf8";

/**
 * Reading at most N bytes of a file, and only if it is a regular file.
 *
 * Two defects this closes:
 *   - `maxBytes` applied after reading the whole file (a 300 MiB log read
 *     with maxBytes 1000 cost 1.5 GiB);
 *   - a path that names a FIFO, a device or a socket. Opening a FIFO for
 *     reading blocks until a writer appears — forever, and on the event loop
 *     when the open is synchronous; `/dev/zero` never ends; `/dev/tty` waits
 *     for a keypress.
 *
 * The type is checked BEFORE the file is opened (opening some devices has
 * side effects, and opening a FIFO unblocks whoever is waiting to write it),
 * then checked again on the open descriptor, which is what is actually read:
 * a path swapped for a FIFO between the two is caught there. The open itself
 * uses `O_NONBLOCK`, so even that swap cannot block the open.
 */

export type FileKind =
  | "file"
  | "directory"
  | "symlink"
  | "fifo"
  | "socket"
  | "character-device"
  | "block-device"
  | "unknown";

export type FileReadOptions = {
  /** Most bytes read. The file is never read past this (plus one byte, to tell if there is more). */
  readonly maxBytes: number;
  /**
   * Follow a symlink at the final path component (default true). When
   * false, a symlink is refused with `symlink-refused`, and the open uses
   * `O_NOFOLLOW` so a link swapped in afterwards is refused too.
   */
  readonly followSymlinks?: boolean;
};

export type FileReadResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      /** `bytes` as UTF-8; an incomplete final character is dropped when truncated. */
      readonly text: string;
      /** The file has more than `maxBytes` bytes. */
      readonly truncated: boolean;
      /** The size the open descriptor reported. Zero for some virtual files that still have content. */
      readonly size: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "not-found"
        | "not-regular-file"
        | "symlink-refused"
        | "changed-while-opening"
        | "permission-denied"
        | "read-error";
      readonly reason: string;
      /** For `not-regular-file`: what the path turned out to be. */
      readonly kind?: FileKind;
    };

export function fileKind(st: Stats): FileKind {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "directory";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isCharacterDevice()) return "character-device";
  if (st.isBlockDevice()) return "block-device";
  return "unknown";
}

const O_NONBLOCK = (constants as Record<string, number | undefined>)["O_NONBLOCK"] ?? 0;
const O_NOFOLLOW = (constants as Record<string, number | undefined>)["O_NOFOLLOW"] ?? 0;

type Failure = Extract<FileReadResult, { ok: false }>;

function errorResult(path: string, err: unknown): Failure {
  const code = (err as { code?: string }).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { ok: false, code: "not-found", reason: `${path} does not exist` };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { ok: false, code: "permission-denied", reason: `${path} cannot be read: ${code}` };
  }
  if (code === "ELOOP" || code === "EMLINK") {
    return {
      ok: false,
      code: "symlink-refused",
      reason: `${path} is a symbolic link, and links are not followed here`,
    };
  }
  return {
    ok: false,
    code: "read-error",
    reason: `${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
  };
}

function notRegular(path: string, kind: FileKind, when: "before" | "after"): Failure {
  return {
    ok: false,
    code: "not-regular-file",
    kind,
    reason:
      when === "before"
        ? `${path} is a ${kind}, not a regular file; it was not opened`
        : `${path} became a ${kind} while it was being opened; it was not read`,
  };
}

/** The pre-open check. Exported for the regression test of the post-open one. */
export function checkBeforeOpen(
  path: string,
  st: Stats,
  followSymlinks: boolean,
): Failure | undefined {
  const kind = fileKind(st);
  if (kind === "symlink" && !followSymlinks) {
    return {
      ok: false,
      code: "symlink-refused",
      reason: `${path} is a symbolic link, and links are not followed here`,
    };
  }
  return kind === "file" ? undefined : notRegular(path, kind, "before");
}

function checkAfterOpen(path: string, pre: Stats, post: Stats): Failure | undefined {
  const kind = fileKind(post);
  if (kind !== "file") return notRegular(path, kind, "after");
  if (pre.dev !== post.dev || pre.ino !== post.ino) {
    return {
      ok: false,
      code: "changed-while-opening",
      reason: `${path} was replaced between being checked and being opened; it was not read`,
    };
  }
  return undefined;
}

function openFlags(followSymlinks: boolean): number {
  return constants.O_RDONLY | O_NONBLOCK | (followSymlinks ? 0 : O_NOFOLLOW);
}

function finish(
  buffer: Uint8Array,
  filled: number,
  maxBytes: number,
  size: number,
): FileReadResult {
  const truncated = filled > maxBytes;
  const bytes = buffer.slice(0, Math.min(filled, maxBytes));
  return { ok: true, bytes, text: decodeHead(bytes, !truncated), truncated, size };
}

/** Initial buffer: what the size claims, but never more than the cap allows. */
function initialCapacity(size: number, limit: number): number {
  return Math.max(1, Math.min(limit, size > 0 ? size + 1 : 64 * 1024));
}

/**
 * Open an already-checked path and read it. Split out so the post-open
 * check can be tested on its own with a stale pre-open `Stats`.
 */
export async function openCheckedAndRead(
  path: string,
  pre: Stats,
  options: FileReadOptions,
): Promise<FileReadResult> {
  const followSymlinks = options.followSymlinks ?? true;
  const maxBytes = Math.max(0, Math.floor(options.maxBytes));
  let handle: FileHandle;
  try {
    handle = await open(path, openFlags(followSymlinks));
  } catch (err) {
    return errorResult(path, err);
  }
  try {
    const post = await handle.stat();
    const changed = checkAfterOpen(path, pre, post);
    if (changed !== undefined) return changed;
    const limit = maxBytes + 1;
    let buffer = new Uint8Array(initialCapacity(post.size, limit));
    let filled = 0;
    while (filled < limit) {
      if (filled === buffer.length) {
        const grown = new Uint8Array(Math.min(limit, buffer.length * 2));
        grown.set(buffer);
        buffer = grown;
      }
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return finish(buffer, filled, maxBytes, post.size);
  } catch (err) {
    return errorResult(path, err);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readFileBounded(
  path: string,
  options: FileReadOptions,
): Promise<FileReadResult> {
  const followSymlinks = options.followSymlinks ?? true;
  let pre: Stats;
  try {
    pre = followSymlinks ? await stat(path) : await lstat(path);
  } catch (err) {
    return errorResult(path, err);
  }
  const refused = checkBeforeOpen(path, pre, followSymlinks);
  if (refused !== undefined) return refused;
  return openCheckedAndRead(path, pre, options);
}

/** {@link readFileBounded}, synchronously, for code paths that cannot await. */
export function readFileBoundedSync(path: string, options: FileReadOptions): FileReadResult {
  const followSymlinks = options.followSymlinks ?? true;
  const maxBytes = Math.max(0, Math.floor(options.maxBytes));
  let pre: Stats;
  try {
    pre = followSymlinks ? statSync(path) : lstatSync(path);
  } catch (err) {
    return errorResult(path, err);
  }
  const refused = checkBeforeOpen(path, pre, followSymlinks);
  if (refused !== undefined) return refused;
  let fd: number;
  try {
    fd = openSync(path, openFlags(followSymlinks));
  } catch (err) {
    return errorResult(path, err);
  }
  try {
    const post = fstatSync(fd);
    const changed = checkAfterOpen(path, pre, post);
    if (changed !== undefined) return changed;
    const limit = maxBytes + 1;
    let buffer = new Uint8Array(initialCapacity(post.size, limit));
    let filled = 0;
    while (filled < limit) {
      if (filled === buffer.length) {
        const grown = new Uint8Array(Math.min(limit, buffer.length * 2));
        grown.set(buffer);
        buffer = grown;
      }
      const read = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return finish(buffer, filled, maxBytes, post.size);
  } catch (err) {
    return errorResult(path, err);
  } finally {
    closeSync(fd);
  }
}
