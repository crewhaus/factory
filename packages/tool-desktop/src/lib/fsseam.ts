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
import {
  type Stats,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** What this package needs to know about a path, and nothing else. */
export type PathFacts = {
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  /** POSIX mode bits. 0 on a platform that has none worth reading. */
  readonly mode: number;
  readonly sizeBytes: number;
};

export type HostFs = {
  stat(absolutePath: string): PathFacts | undefined;
  readText(absolutePath: string): string | undefined;
  /** Write via a temporary file and a rename, so a crash cannot leave half a
   *  state file behind for the next call to parse. */
  writeTextAtomic(absolutePath: string, text: string): void;
  remove(absolutePath: string): void;
};

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
    try {
      return readFileSync(absolutePath, "utf-8");
    } catch {
      return undefined;
    }
  },
  writeTextAtomic(absolutePath, text) {
    mkdirSync(dirname(absolutePath), { recursive: true });
    const temp = `${absolutePath}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, absolutePath);
  },
  remove(absolutePath) {
    rmSync(absolutePath, { force: true });
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
