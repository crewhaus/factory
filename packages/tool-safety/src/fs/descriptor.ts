import {
  constants,
  type Stats,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import * as path from "node:path";
import { isWithin } from "./resolve";

/**
 * Where an open descriptor really is, according to the kernel.
 *
 * Node has no `openat`, so opening a checked path walks every directory of
 * it again, and a directory swapped for a link to outside in between is
 * followed: the open lands outside, and the pre-open `lstat` and the
 * post-open `fstat` agree, because both went through the same swap. The
 * review reproduced this with a second process renaming a directory back
 * and forth: 262 of 52 230 reads returned the outside file.
 *
 * The descriptor itself cannot be fooled that way. `realpath` of
 * `/dev/fd/<fd>` answers with the path of the file the descriptor holds:
 * macOS resolves it through the vnode, and on Linux `/dev/fd` leads to
 * `/proc/self/fd`, whose links name the file. Measured on macOS 15 with Bun
 * 1.3.14; Linux is how CI runs. Checking that path against the root after
 * the open closes the race for reads, whatever the directories did.
 *
 * Where the descriptor cannot be asked (Windows, a Linux without `/proc`),
 * the fallback re-checks the identity of every directory on the path after
 * the open. That narrows the window but cannot close it; the README says so.
 */

/** The path the kernel holds for `fd`, or undefined when it cannot be asked. */
export function descriptorPath(fd: number): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    return realpathSync.native(`/dev/fd/${fd}`);
  } catch {
    return undefined;
  }
}

let supported: boolean | undefined;

/** Test seam: pretend the descriptor cannot be asked. Pass `undefined` to restore. */
export function _setDescriptorPathSupportForTest(value: boolean | undefined): void {
  supported = value;
}

/** Whether {@link descriptorPath} works here, probed once on a directory we know. */
export function descriptorPathSupported(knownDir: string): boolean {
  if (supported !== undefined) return supported;
  let fd: number | undefined;
  try {
    fd = openSync(knownDir, constants.O_RDONLY);
    const held = descriptorPath(fd);
    supported = held !== undefined && sameFile(held, fd);
  } catch {
    supported = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return supported;
}

function sameFile(p: string, fd: number): boolean {
  try {
    const a = statSync(p);
    const b = fstatSync(fd);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** Identity of each directory from the root down to `dir`, as the path leads now. */
export type DirChain = ReadonlyArray<{
  readonly real: string;
  readonly dev: number;
  readonly ino: number;
}>;

/**
 * Record the directories from `rootPhysical` down to `dir`: every one must
 * be a real directory, not a link. Undefined when one is not.
 */
export function recordChain(rootPhysical: string, dir: string): DirChain | undefined {
  if (!isWithin(rootPhysical, dir)) return undefined;
  const out: Array<{ real: string; dev: number; ino: number }> = [];
  let cur = rootPhysical;
  const rest = path
    .relative(rootPhysical, dir)
    .split(path.sep)
    .filter((c) => c !== "");
  for (let i = 0; i <= rest.length; i++) {
    if (i > 0) cur = path.join(cur, rest[i - 1] as string);
    try {
      const st = lstatSync(cur);
      if (!st.isDirectory()) return undefined;
      out.push({ real: cur, dev: st.dev, ino: st.ino });
    } catch {
      return undefined;
    }
  }
  return out;
}

/** Every directory of `chain` is still the same real directory. */
export function chainUnchanged(chain: DirChain): boolean {
  for (const dir of chain) {
    try {
      const st = lstatSync(dir.real);
      if (!st.isDirectory() || st.dev !== dir.dev || st.ino !== dir.ino) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Whether the file open on `fd` is inside `rootPhysical`. With the
 * descriptor's own path this is exact. Without it, `fallback` (a chain
 * recorded before the open) and the leaf's identity are checked again.
 */
export function openedInside(
  fd: number,
  opened: Stats,
  rootPhysical: string,
  leafReal: string,
  fallback: DirChain | undefined,
): boolean {
  if (descriptorPathSupported(rootPhysical)) {
    const held = descriptorPath(fd);
    return held !== undefined && isWithin(rootPhysical, held);
  }
  if (fallback === undefined || !chainUnchanged(fallback)) return false;
  try {
    const now = lstatSync(leafReal);
    return now.dev === opened.dev && now.ino === opened.ino;
  } catch {
    return false;
  }
}
