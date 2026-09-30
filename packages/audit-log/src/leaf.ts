/**
 * The audit writer's own file I/O: a FIXED name directly in the operator's
 * audit directory (`<day>.jsonl`, `_chain-tail.json`), read, appended to and
 * rewritten IN PLACE, never through a link and never opened when it is a
 * FIFO or device.
 *
 * Why not `@crewhaus/tool-safety/fs`: its writes contain a CALLER-NAMED path
 * under a root (realpath the root, walk every component, re-check the
 * directory after the create) and replace a file by temp + rename. Here the
 * name is fixed and its directory IS the root, so the walk buys nothing,
 * and it cost about five times 0.7.0's per-record time on a path every
 * gateway request, model call and policy decision takes. The rename also
 * broke an append-only audit directory (`chflags uappnd`, `chattr +a`),
 * where entries can be added but never replaced: every append after the
 * first threw, after its record was already written. What is kept is what
 * protects the leaf: `lstat` first (a link or special file is refused
 * without being opened), `O_NOFOLLOW` on the open (a link planted since is
 * refused too), `O_NONBLOCK` (a FIFO swapped in never blocks), and `fstat`
 * on the descriptor matching what `lstat` saw.
 */
import {
  constants,
  type Stats,
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { type FileKind, fileKind } from "@crewhaus/tool-safety/fs";

const O_NOFOLLOW = (constants as Record<string, number | undefined>)["O_NOFOLLOW"] ?? 0;
const O_NONBLOCK = (constants as Record<string, number | undefined>)["O_NONBLOCK"] ?? 0;

/** Why a leaf was refused: what is at the name, as `lstat` or `fstat` saw it. */
export type LeafRefusal =
  | { readonly code: "not-regular"; readonly kind: FileKind }
  | { readonly code: "too-large"; readonly bytes: number }
  | { readonly code: "io"; readonly error: unknown };

export class LeafError extends Error {
  readonly refusal: LeafRefusal;
  constructor(refusal: LeafRefusal) {
    super(refusal.code);
    this.refusal = refusal;
  }
}

/**
 * Test seams: how many opens this module has made, and a hook run between
 * the `lstat` and the open (to swap what is at the name, as a racing
 * attacker would). Never set outside tests.
 */
const seams: { opens: number; afterLstat?: ((file: string) => void) | undefined } = { opens: 0 };
export function _leafSeamsForTest(): {
  opens: number;
  afterLstat?: ((file: string) => void) | undefined;
} {
  return seams;
}

function lstatOrAbsent(file: string): Stats | undefined {
  try {
    return lstatSync(file);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return undefined;
    throw new LeafError({ code: "io", error: err });
  }
}

/**
 * Open `file` with `flags` + `O_NOFOLLOW | O_NONBLOCK` and check the
 * descriptor is a regular file — the one `lstat` saw, when `seen` is given.
 * A link at the name fails the open (`ELOOP`) and is reported as a link.
 */
function openRegular(file: string, flags: number, seen: Stats | undefined, mode?: number): number {
  let fd: number;
  seams.afterLstat?.(file);
  seams.opens += 1;
  try {
    fd = openSync(file, flags | O_NOFOLLOW | O_NONBLOCK, mode);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new LeafError({ code: "not-regular", kind: "symlink" });
    }
    // A FIFO with no reader refuses a non-blocking write open.
    if (code === "ENXIO") throw new LeafError({ code: "not-regular", kind: "fifo" });
    throw new LeafError({ code: "io", error: err });
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new LeafError({ code: "not-regular", kind: fileKind(st) });
    if (seen !== undefined && (st.dev !== seen.dev || st.ino !== seen.ino)) {
      // Replaced between the lstat and the open: judge what is there now.
      throw new LeafError({ code: "not-regular", kind: "symlink" });
    }
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** `lstat` says a regular file, or nothing; anything else is refused unopened. */
function regularOrAbsent(file: string): Stats | undefined {
  const st = lstatOrAbsent(file);
  if (st !== undefined && !st.isFile()) {
    throw new LeafError({ code: "not-regular", kind: fileKind(st) });
  }
  return st;
}

/** The text of `name`, or undefined when there is none. At most `maxBytes`. */
export function readLeaf(rootDir: string, name: string, maxBytes: number): string | undefined {
  const file = join(rootDir, name);
  const seen = regularOrAbsent(file);
  if (seen === undefined) return undefined;
  const fd = openRegular(file, constants.O_RDONLY, seen);
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    let got = 0;
    for (;;) {
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
      if (got > maxBytes) throw new LeafError({ code: "too-large", bytes: maxBytes });
    }
    return buf.toString("utf8", 0, got);
  } catch (err) {
    if (err instanceof LeafError) throw err;
    throw new LeafError({ code: "io", error: err });
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, data: Buffer, position: number | null): void {
  let off = 0;
  while (off < data.length) {
    off += writeSync(fd, data, off, data.length - off, position === null ? null : position + off);
  }
}

/**
 * Append `text` to `name` with one `O_APPEND` write, creating it (`mode`)
 * when absent. The name is never followed if it is a link, even a dangling
 * one: `O_CREAT | O_NOFOLLOW` fails on a link rather than creating its target.
 */
export function appendLeaf(rootDir: string, name: string, text: string, mode: number): void {
  const file = join(rootDir, name);
  const seen = regularOrAbsent(file);
  const fd = openRegular(
    file,
    constants.O_WRONLY | constants.O_APPEND | (seen === undefined ? constants.O_CREAT : 0),
    seen,
    mode,
  );
  try {
    writeAll(fd, Buffer.from(text, "utf8"), null);
  } catch (err) {
    throw new LeafError({ code: "io", error: err });
  } finally {
    closeSync(fd);
  }
}

/**
 * Replace the contents of `name` with `text`, IN PLACE: an existing regular
 * file is written from offset 0 and cut to the new length (no temp file, no
 * rename, so an append-only directory is no obstacle), and an absent one is
 * created exclusively (`O_EXCL`). The anchor this writes only grows or keeps
 * its length (the `seq` digits), so the cut is a no-op in practice and a
 * crash leaves at worst a torn anchor, which `verify` reports.
 */
export function overwriteLeaf(rootDir: string, name: string, text: string, mode: number): void {
  const file = join(rootDir, name);
  const seen = regularOrAbsent(file);
  const fd =
    seen === undefined
      ? openRegular(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, undefined, mode)
      : openRegular(file, constants.O_WRONLY, seen);
  try {
    const data = Buffer.from(text, "utf8");
    writeAll(fd, data, 0);
    ftruncateSync(fd, data.length);
  } catch (err) {
    throw new LeafError({ code: "io", error: err });
  } finally {
    closeSync(fd);
  }
}
