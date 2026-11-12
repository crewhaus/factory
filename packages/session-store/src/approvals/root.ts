/**
 * Where a harness's session root is, for a reader that is handed the harness
 * directory: Home, and anything else that reads a harness it did not start.
 *
 * The default is `<harness>/.crewhaus/sessions`. `CREWHAUS_SESSION_DIR`, from the
 * variables the caller already parsed out of the harness's environment files,
 * moves it, but only to a place inside the harness directory after every link is
 * followed: an override that escapes it is ignored, and the answer says so rather
 * than silently reading the default.
 *
 * It reads no `.env` file and no process environment. It does read the filesystem,
 * because containment is a realpath check: the harness directory and the deepest
 * existing ancestor of the candidate are resolved, the part that does not exist yet
 * is re-appended, and the result must lie inside. A directory that does not exist
 * yet is honoured; a link inside the harness that points out of it is not.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The variable that moves a harness's session root. */
export const SESSION_DIR_ENV = "CREWHAUS_SESSION_DIR";

export type HarnessSessionRoot = {
  /** The directory the session files and the approvals live in. */
  readonly root: string;
  /** An override is in effect. */
  readonly overrideActive: boolean;
  /** An override was set, escaped the harness directory, and was ignored. */
  readonly overrideIgnored: boolean;
};

function realOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** `child` is `parent` or lies inside it. Both are real, absolute paths. */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `candidate` (absolute, or relative to `rootDir`) when it realpath-contains inside
 * `rootDir`, as given (not resolved through links); `undefined` when the root cannot
 * be read or the candidate escapes it.
 */
function containedTarget(rootDir: string, candidate: string): string | undefined {
  const realRoot = realOf(rootDir);
  if (realRoot === undefined) return undefined;
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(rootDir, candidate);
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return undefined;
    existing = parent;
  }
  const realExisting = realOf(existing);
  if (realExisting === undefined) return undefined;
  const mapped = realExisting + target.slice(existing.length);
  return inside(realRoot, mapped) ? target : undefined;
}

/**
 * The session root of the harness at `harnessDir`, given the variables its
 * environment files set. The override is trimmed, an empty one is no override,
 * and a relative one is resolved against the harness directory.
 */
export function resolveHarnessSessionRoot(
  harnessDir: string,
  vars: Readonly<Record<string, string | undefined>>,
): HarnessSessionRoot {
  const fallback = join(harnessDir, ".crewhaus", "sessions");
  const override = vars[SESSION_DIR_ENV]?.trim();
  if (override === undefined || override === "") {
    return { root: fallback, overrideActive: false, overrideIgnored: false };
  }
  const resolved = containedTarget(harnessDir, override);
  if (resolved === undefined) {
    return { root: fallback, overrideActive: false, overrideIgnored: true };
  }
  return { root: resolved, overrideActive: true, overrideIgnored: false };
}
