/**
 * The filesystem seam.
 *
 * Two tools need one. `OpenExternal` has to know whether the thing it is
 * about to hand to the operating system is a directory and whether it is
 * EXECUTABLE, because "open this" and "run this" are the same gesture to a
 * desktop and only one of them is what a caller meant. `PowerAssertion` has
 * to remember a held inhibitor across tool calls, which means a file.
 *
 * Both go through here for the same reason the commands go through `./run`:
 * a test that made a real file with a real mode bit would be asserting the
 * umask of whoever ran it, and a test that wrote a real state file would be
 * racing every other test in the same process.
 */
import { type Stats, chmodSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { openForReadSync, writeFileSafe } from "@crewhaus/tool-safety/fs";

/** What this package needs to know about a path, and nothing else. */
export type PathFacts = {
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  /** POSIX mode bits. 0 on a platform that has none worth reading. */
  readonly mode: number;
  readonly sizeBytes: number;
};

/**
 * The three state-file operations are for a PRIVATE file: one in a directory
 * only this user can write (see `powerStateFile` in ../index.ts). The real
 * implementation refuses the directory when another user owns it or can write
 * it, and refuses a symlink, FIFO or other non-regular file at the leaf —
 * throwing a {@link StateFileError} that names the path and the reason.
 */
export type HostFs = {
  stat(absolutePath: string): PathFacts | undefined;
  /** The file's text, or undefined when there is no file. */
  readText(absolutePath: string): string | undefined;
  /** Write via a temporary file and a rename, so a crash cannot leave half a
   *  state file behind for the next call to parse. */
  writeTextAtomic(absolutePath: string, text: string): void;
  remove(absolutePath: string): void;
};

/** A private state file, or its directory, that cannot be trusted. Never carries the file's content. */
export class StateFileError extends Error {
  override readonly name = "StateFileError";
}

/** A state record is a few hundred bytes; anything past this is not one. */
const STATE_MAX_BYTES = 64 * 1024;

/**
 * Is `dir` a real directory that only this user can write? With `create`,
 * make it (mode 0700) when it is missing, and tighten the mode of one this
 * user owns. A directory someone else owns — another user pre-creating
 * `/tmp/crewhaus-<uid>` to plant a record — is refused, because the record
 * names the pid `release` signals.
 */
function checkPrivateDir(dir: string, create: boolean): "ok" | "absent" {
  let stats: Stats | undefined;
  try {
    stats = lstatSync(dir, { throwIfNoEntry: false });
  } catch (err) {
    throw new StateFileError(
      `the state directory ${dir} cannot be read: ${(err as Error).message}`,
    );
  }
  if (stats === undefined) {
    if (!create) return "absent";
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    stats = lstatSync(dir);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new StateFileError(
      `the state directory ${dir} is not a directory (a symlink or file is there), so it is not trusted`,
    );
  }
  if (process.platform === "win32") return "ok";
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    throw new StateFileError(
      `the state directory ${dir} belongs to another user, so a record in it is not trusted`,
    );
  }
  // Group or other WRITE is what lets someone else plant a record; read is
  // only the pid and the deadline. A directory this call creates is 0700.
  if ((stats.mode & 0o022) !== 0) {
    if (!create) {
      throw new StateFileError(
        `the state directory ${dir} can be written by other users (mode ${(stats.mode & 0o777).toString(8)}), so a record in it is not trusted`,
      );
    }
    chmodSync(dir, 0o700);
  }
  return "ok";
}

const nodeFs: HostFs = {
  stat(absolutePath) {
    let stats: Stats | undefined;
    try {
      // `statSync`, not `lstatSync`: the question is what the OS would OPEN,
      // and a symlink to a shell script is as executable as the script. The
      // containment check in ./paths.ts has already resolved the link and
      // proved the destination is inside the workspace.
      stats = statSync(absolutePath, { throwIfNoEntry: false });
    } catch {
      // A path whose parent is unreadable throws EACCES rather than returning
      // undefined. An unprobeable path is treated as absent, which every
      // caller here turns into a refusal rather than a guess.
      return undefined;
    }
    if (stats === undefined) return undefined;
    return {
      exists: true,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      mode: stats.mode,
      sizeBytes: stats.size,
    };
  },
  readText(absolutePath) {
    const dir = dirname(absolutePath);
    if (checkPrivateDir(dir, false) === "absent") return undefined;
    // Contained to the directory, never through a link at the leaf, and a
    // FIFO is refused before it is opened (a blocking open would freeze
    // every session in the process).
    const read = openForReadSync(dir, basename(absolutePath), {
      maxBytes: STATE_MAX_BYTES,
      followLeafSymlink: false,
    });
    if (!read.ok) {
      if (read.code === "not-found") return undefined;
      throw new StateFileError(`the state file ${absolutePath} is not trusted: ${read.reason}`);
    }
    if (read.truncated) {
      throw new StateFileError(
        `the state file ${absolutePath} is larger than ${STATE_MAX_BYTES} bytes, so it is not a record this package wrote`,
      );
    }
    return read.text;
  },
  writeTextAtomic(absolutePath, text) {
    const dir = dirname(absolutePath);
    checkPrivateDir(dir, true);
    // A random O_EXCL|O_NOFOLLOW temp, renamed into place: the old
    // `<path>.<pid>.tmp` was a predictable name opened through any link.
    const written = writeFileSafe(dir, basename(absolutePath), text, {
      overwrite: true,
      mode: 0o600,
    });
    if (!written.ok) {
      throw new StateFileError(`the state file ${absolutePath} was not written: ${written.reason}`);
    }
  },
  remove(absolutePath) {
    // unlink removes a link itself, never what it points at.
    try {
      unlinkSync(absolutePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new StateFileError(
        `the state file ${absolutePath} could not be removed: ${(err as Error).message}`,
      );
    }
  },
};

let fsOverride: HostFs | undefined;

export function fs(): HostFs {
  return fsOverride ?? nodeFs;
}

export function _setFs(replacement: HostFs | undefined): void {
  fsOverride = replacement;
}

/** The owner/group/other execute bits. */
export const EXEC_BITS = 0o111;

/** True when the OS would treat this file as something to RUN. */
export function isExecutable(facts: PathFacts): boolean {
  return (facts.mode & EXEC_BITS) !== 0;
}
