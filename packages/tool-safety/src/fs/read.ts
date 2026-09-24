import { type Stats, closeSync } from "node:fs";
import * as path from "node:path";
import {
  type FileFailure,
  type FileReadResult,
  openRegularFile,
  openRegularFileAsync,
  readOpenedFile,
  readOpenedFileSync,
} from "../streams/file";
import { type DirChain, descriptorPathSupported, openedInside, recordChain } from "./descriptor";
import { type SafeFsFailure, fail, isSymlink, notRegular, quote, requireLimit } from "./failure";
import { type Contained, type Root, prepareRoot, resolveIn } from "./resolve";

/**
 * Reading a caller-named file inside a root: the leaf contained, not just
 * the directory it was joined onto.
 *
 * The recurring defect: a tool contains `dir` and then reads
 * `join(dir.real, "package.json")`. A planted `package.json -> ~/.aws/credentials`
 * is followed, and the parse error or the parsed fields carry the outside
 * file into the transcript (security-9#2, security-7#1, security-7#12,
 * security-5#2, flag-truth-3#6). Here the WHOLE path is resolved physically,
 * links included, and must land inside the root; then the file is opened
 * with `O_NOFOLLOW` and `O_NONBLOCK`, so a FIFO or device is refused before
 * it is opened and a link swapped in at the leaf is refused on the
 * descriptor.
 *
 * A DIRECTORY on the path swapped for a link after the resolution is the
 * one thing the open cannot see, since Node has no `openat`. So the open
 * descriptor is checked afterwards: where the kernel says it is (see
 * `descriptor.ts`) must be inside the root, or nothing is read.
 */

export type OpenForReadOptions = {
  /** Most bytes returned: a finite number >= 0. The file is never read past this plus one byte. */
  readonly maxBytes: number;
  /**
   * Follow a symlink at the final component when it stays inside the root
   * (default true: an in-workspace `README.md -> docs/README.md` reads
   * normally). False refuses any link at the leaf. A link that leaves the
   * root is refused either way.
   */
  readonly followLeafSymlink?: boolean;
  /** Byte offset to start reading at. Default 0. */
  readonly position?: number;
};

export type ContainedRead =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      /** UTF-8; an incomplete final character is dropped when truncated. */
      readonly text: string;
      readonly truncated: boolean;
      /** The size the open descriptor reported. */
      readonly size: number;
      /** Physical path that was read (inside the root). */
      readonly real: string;
      /** Slash-separated path relative to the root, as the caller named it. */
      readonly rel: string;
    }
  | SafeFsFailure;

/** A contained regular file, open for reading. The caller must `closeSync(fd)`. */
export type ContainedFd =
  | {
      readonly ok: true;
      readonly fd: number;
      /** `fstat` of the descriptor. */
      readonly stats: Stats;
      readonly real: string;
      readonly rel: string;
    }
  | SafeFsFailure;

function mapFailure(given: string, r: FileFailure): SafeFsFailure {
  // The stream reader's reasons name the physical path it opened; only its
  // code and kind are carried over, under the caller's spelling.
  switch (r.code) {
    case "not-found":
      return fail("not-found", given, `${quote(given)} does not exist`);
    case "not-regular-file":
      return notRegular(given, r.kind ?? "unknown");
    case "symlink-refused":
      return isSymlink(given, "links are not followed at the leaf here, so it was not read");
    case "changed-while-opening":
      return fail(
        "changed",
        given,
        `${quote(given)} was replaced while it was being opened; it was not read`,
      );
    case "permission-denied":
      return fail("permission-denied", given, `${quote(given)} cannot be read: permission denied`);
    default:
      return fail("io-error", given, `${quote(given)} could not be read`);
  }
}

function mapRead(target: Contained, r: FileReadResult): ContainedRead {
  if (!r.ok) return mapFailure(target.given, r);
  return {
    ok: true,
    bytes: r.bytes,
    text: r.text,
    truncated: r.truncated,
    size: r.size,
    real: target.real,
    rel: target.rel,
  };
}

function swapped(given: string): SafeFsFailure {
  return fail(
    "changed",
    given,
    `a directory on the path of ${quote(given)} changed while it was being opened; it was not read`,
  );
}

type Located = {
  readonly root: Root;
  readonly at: Contained;
  readonly chain: DirChain | undefined;
};

function locate(root: string, given: string, followLeaf: boolean): Located | SafeFsFailure {
  const prepared = prepareRoot(root, given);
  if ("ok" in prepared) return prepared;
  const at = resolveIn(prepared, given, { followLeaf });
  if (!at.ok) return at;
  // The fallback check needs the directories as they were before the open.
  const chain = descriptorPathSupported(prepared.physical)
    ? undefined
    : recordChain(prepared.physical, path.dirname(at.real));
  return { root: prepared, at, chain };
}

type OpenHooks = { beforeOpen?: (real: string) => void; afterOpen?: (real: string) => void };
let hooks: OpenHooks = {};

/**
 * Test seam: run code between the resolution and the open, and between the
 * open and the check, to swap a directory exactly there. Pass `{}` to restore.
 */
export function _setOpenHooksForTest(next: OpenHooks): void {
  hooks = next;
}

/**
 * Open `given` (relative to `root`, or absolute inside it) for reading, with
 * every check {@link openForRead} makes, and hand over the descriptor: for
 * a reader that streams (`ReadLines` to line N, `TailFile`). The caller must
 * `closeSync(fd)`.
 */
export function openForReadFd(
  root: string,
  given: string,
  options: { readonly followLeafSymlink?: boolean } = {},
): ContainedFd {
  const located = locate(root, given, options.followLeafSymlink ?? true);
  if ("ok" in located) return located;
  const { at } = located;
  hooks.beforeOpen?.(at.real);
  const opened = openRegularFile(at.real, { followSymlinks: false });
  if (!opened.ok) return mapFailure(given, opened);
  hooks.afterOpen?.(at.real);
  if (!openedInside(opened.fd, opened.stats, located.root.physical, at.real, located.chain)) {
    closeSync(opened.fd);
    return swapped(given);
  }
  return { ok: true, fd: opened.fd, stats: opened.stats, real: at.real, rel: at.rel };
}

/**
 * Read at most `maxBytes` of `given` (relative to `root`, or absolute inside
 * it). Refuses a path whose physical location is outside the root, a leaf
 * that is not a regular file, (with `followLeafSymlink: false`) a leaf that
 * is a link, and a file that turns out, once open, to be outside the root.
 */
export async function openForRead(
  root: string,
  given: string,
  options: OpenForReadOptions,
): Promise<ContainedRead> {
  requireLimit("maxBytes", options.maxBytes, true);
  const located = locate(root, given, options.followLeafSymlink ?? true);
  if ("ok" in located) return located;
  const { at } = located;
  hooks.beforeOpen?.(at.real);
  const opened = await openRegularFileAsync(at.real, { followSymlinks: false });
  if (!opened.ok) return mapFailure(given, opened);
  try {
    hooks.afterOpen?.(at.real);
    if (
      !openedInside(opened.handle.fd, opened.stats, located.root.physical, at.real, located.chain)
    ) {
      return swapped(given);
    }
    return mapRead(
      at,
      await readOpenedFile(opened.handle, opened.stats, {
        maxBytes: options.maxBytes,
        ...(options.position === undefined ? {} : { position: options.position }),
      }),
    );
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** {@link openForRead}, synchronously, for code paths that cannot await. */
export function openForReadSync(
  root: string,
  given: string,
  options: OpenForReadOptions,
): ContainedRead {
  requireLimit("maxBytes", options.maxBytes, true);
  const opened = openForReadFd(root, given, options);
  if (!opened.ok) return opened;
  try {
    const r = readOpenedFileSync(
      { ok: true, fd: opened.fd, stats: opened.stats },
      {
        maxBytes: options.maxBytes,
        ...(options.position === undefined ? {} : { position: options.position }),
      },
    );
    if (!r.ok) return mapFailure(given, r);
    return {
      ok: true,
      bytes: r.bytes,
      text: r.text,
      truncated: r.truncated,
      size: r.size,
      real: opened.real,
      rel: opened.rel,
    };
  } finally {
    closeSync(opened.fd);
  }
}
