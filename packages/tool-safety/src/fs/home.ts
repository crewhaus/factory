import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

function followed(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function accountHome(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

/**
 * The home directory `dir` holds (is equal to or an ancestor of), or
 * `undefined` when it holds none. Symlinks are followed on both sides. The
 * account's home is always a candidate, and `env`'s `HOME` and `USERPROFILE`
 * are candidates beside it. A value that is not an absolute path names nothing.
 */
export function homeHeldBy(
  dir: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const root = followed(dir);
  for (const home of [accountHome(), env["HOME"], env["USERPROFILE"]]) {
    if (home === undefined || !isAbsolute(home)) continue;
    const rel = relative(root, followed(home));
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      return home;
    }
  }
  return undefined;
}
