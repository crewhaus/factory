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
 * The default is held to the same rule as an override. The answer's `contained`
 * says whether the root it names lies inside the harness directory once every link
 * is followed; a root that does not is unreachable for approvals, and
 * `containedSessionRoot` answers it only when it is contained, so a reader of
 * approvals cannot skip the check.
 *
 * It reads no `.env` file and no process environment. It does read the filesystem,
 * because containment is a realpath check: the harness directory and the deepest
 * ancestor of the candidate that is present (a link counts, whether or not its
 * target exists) are resolved, the part that is absent is re-appended, and the
 * result must lie inside. A directory that does not exist yet is honoured; a link
 * inside the harness that points out of it, or that cannot be resolved, is not.
 * Nor is a place inside another harness nested in this one: walking up from the
 * root's real place, the nearest directory that holds a `.crewhaus` folder must
 * be the harness itself.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
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
  /**
   * `root` lies inside the harness directory once every link is followed, checked
   * at the time of the call. A root that is not contained is unreachable for
   * approvals: nothing is read from it and nothing is decided there.
   */
  readonly contained: boolean;
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

/** Something is at `path` itself: a link counts, whether or not its target exists. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** `dir` holds a `.crewhaus` folder: it is a harness's directory. */
function holdsHarnessFolder(dir: string): boolean {
  try {
    return statSync(join(dir, ".crewhaus")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walking up from `real` to `realRoot`, the first directory that holds a `.crewhaus`
 * folder is `realRoot` itself (or there is none before it): `real` is not another
 * harness nested in this one, nor inside one.
 */
function notInNestedHarness(realRoot: string, real: string): boolean {
  let at = real;
  while (inside(realRoot, at)) {
    if (at === realRoot) return true;
    if (holdsHarnessFolder(at)) return false;
    const parent = dirname(at);
    if (parent === at) return true;
    at = parent;
  }
  return true;
}

/**
 * `candidate` (absolute, or relative to `rootDir`) when it realpath-contains inside
 * `rootDir`, and not inside another harness nested in it, as given (not resolved
 * through links); `undefined` when the root cannot be read, the candidate escapes
 * it or lies in a nested harness, or a present part of it (a dangling link, say)
 * cannot be resolved.
 */
function containedTarget(rootDir: string, candidate: string): string | undefined {
  const realRoot = realOf(rootDir);
  if (realRoot === undefined) return undefined;
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(rootDir, candidate);
  let existing = target;
  while (!present(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return undefined;
    existing = parent;
  }
  const realExisting = realOf(existing);
  if (realExisting === undefined) return undefined;
  const mapped = realExisting + target.slice(existing.length);
  return inside(realRoot, mapped) && notInNestedHarness(realRoot, mapped) ? target : undefined;
}

/**
 * The session root of the harness at `harnessDir`, given the variables its
 * environment files set. The override is trimmed, an empty one is no override,
 * and a relative one is resolved against the harness directory. The default
 * keeps its joined path whatever the check answers; `contained` carries the answer.
 */
export function resolveHarnessSessionRoot(
  harnessDir: string,
  vars: Readonly<Record<string, string | undefined>>,
): HarnessSessionRoot {
  const fallback = join(harnessDir, ".crewhaus", "sessions");
  const defaultContained = (): boolean =>
    containedTarget(harnessDir, join(".crewhaus", "sessions")) !== undefined;
  const override = vars[SESSION_DIR_ENV]?.trim();
  if (override === undefined || override === "") {
    return {
      root: fallback,
      overrideActive: false,
      overrideIgnored: false,
      contained: defaultContained(),
    };
  }
  const resolved = containedTarget(harnessDir, override);
  if (resolved === undefined) {
    return {
      root: fallback,
      overrideActive: false,
      overrideIgnored: true,
      contained: defaultContained(),
    };
  }
  return { root: resolved, overrideActive: true, overrideIgnored: false, contained: true };
}

/**
 * The harness's session root when it lies inside the harness directory once every
 * link is followed, else `undefined`: the one root a reader or writer of approvals
 * uses, so an unreachable root is never opened.
 */
export function containedSessionRoot(
  harnessDir: string,
  vars: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const answer = resolveHarnessSessionRoot(harnessDir, vars);
  return answer.contained ? answer.root : undefined;
}
