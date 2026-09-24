/**
 * Where a bare program name resolves on PATH — the question CommandExists
 * answers — by the platform's own rule (C125).
 *
 * POSIX: each PATH directory in order, the first regular file with the name
 * that is executable. Windows: an installed program is `git.exe` or
 * `npm.cmd`, and the shell and Bun.spawn both find it by its bare name
 * through PATHEXT. 0.7.0 probed only the bare name, so on Windows every
 * program was "not found" while RunCommand could run it. Here, on win32,
 * PATH is split on `;` (a quoted entry unquoted), and each directory is
 * tried in order for the name as given when its extension is already one of
 * PATHEXT's, then for the name plus each PATHEXT extension in PATHEXT's
 * order. Existence and being a regular file is enough there: Windows has no
 * execute bit to check.
 *
 * The platform is a parameter, read through `hostPlatform()` (with a test
 * seam) so the Windows rule is exercised on a Linux or macOS CI runner.
 */
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import * as path from "node:path";

let platformOverride: NodeJS.Platform | undefined;

/** The platform CommandExists resolves for. */
export function hostPlatform(): NodeJS.Platform {
  return platformOverride ?? process.platform;
}

/** Test seam: pretend to be another platform; `undefined` restores the real one. */
export function _setPlatform(platform: NodeJS.Platform | undefined): void {
  platformOverride = platform;
}

/** Windows' default when PATHEXT is unset. */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export type PathSearch = {
  /** The first match, or null. */
  readonly path: string | null;
  /** How many PATH entries were searched. */
  readonly searchedDirs: number;
};

export function searchPath(
  name: string,
  options: {
    readonly pathValue: string;
    readonly platform: NodeJS.Platform;
    readonly pathext?: string | undefined;
  },
): PathSearch {
  const windows = options.platform === "win32";
  const dirs = options.pathValue
    .split(windows ? ";" : ":")
    .map((d) => (windows ? d.trim().replace(/^"(.*)"$/, "$1") : d))
    .filter((d) => d !== "");
  const candidates = windows ? windowsCandidates(name, options.pathext) : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      // The HOST join: on a real Windows host this is path.win32 already.
      const full = path.join(dir, candidate);
      if (isProgram(full, windows)) return { path: full, searchedDirs: dirs.length };
    }
  }
  return { path: null, searchedDirs: dirs.length };
}

/** The spellings Windows would try for `name`, in order. */
function windowsCandidates(name: string, pathext: string | undefined): string[] {
  const exts = (pathext === undefined || pathext.trim() === "" ? DEFAULT_PATHEXT : pathext)
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.startsWith(".") && e.length > 1);
  const lowered = exts.map((e) => e.toLowerCase());
  const out: string[] = [];
  const own = path.extname(name).toLowerCase();
  if (own !== "" && lowered.includes(own)) out.push(name);
  for (const [i, ext] of exts.entries()) {
    // Both spellings: Windows matches case-insensitively, a case-sensitive
    // filesystem (a test on Linux, a WSL mount) does not.
    out.push(`${name}${lowered[i] as string}`);
    if (ext !== lowered[i]) out.push(`${name}${ext}`);
  }
  return [...new Set(out)];
}

function isProgram(full: string, windows: boolean): boolean {
  try {
    if (!statSync(full).isFile()) return false;
    if (!windows) accessSync(full, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
