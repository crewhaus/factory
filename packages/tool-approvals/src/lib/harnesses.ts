/**
 * Finding the harnesses under a root, for the fleet inbox.
 *
 * The model is the one `crewhaus fleet` and `@crewhaus/tool-crewhaus`'s
 * `discoverHarnesses` use, so the three agree about what a harness is: a
 * directory carrying a `crewhaus.yaml`. Neither of those is a dependency of this
 * package (see the README), so the walk is re-stated here — bounded in depth and
 * in count, never descending into a harness's own `.crewhaus/` state directory
 * or into `node_modules` (a template spec vendored under `node_modules` is not a
 * fleet member), and never following a directory symlink, which would walk
 * straight past the containment boundary `resolveSafe` exists to hold.
 *
 * PARTIAL FAILURE IS THE POINT. A directory that cannot be listed is recorded,
 * not thrown: one bad mount must not blind an operator to the rest of the fleet.
 * But it is also never silently skipped — a walk that could not see everything
 * says so in `truncated` / `unreadable`, and the caller turns that into an
 * explicit unknown rather than reporting a short list as a complete one.
 */
import { type Dirent, readdirSync } from "node:fs";
import * as path from "node:path";
import { toPosix } from "../paths";
import { compareStrings } from "./unknown";

/** The file that roots a standalone harness. */
export const HARNESS_SPEC_FILENAME = "crewhaus.yaml";

/** Never descended into. Mirrors `@crewhaus/harness-inventory`'s skip set. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".crewhaus",
  ".git",
  ".worktrees",
  "dist",
  "node_modules",
]);

export type DiscoveredHarness = {
  /** Absolute path of the harness directory. */
  readonly dir: string;
  /** Path relative to the root the walk started from, `/`-separated. */
  readonly rel: string;
};

export type DiscoveryResult = {
  readonly harnesses: readonly DiscoveredHarness[];
  /** True when the count cap stopped the walk before the tree was exhausted. */
  readonly truncated: boolean;
  /** True when the DEPTH cap stopped a descent — a deeper harness may exist. */
  readonly depthLimited: boolean;
  /** Directories the walk could not read (permissions, races), root-relative. */
  readonly unreadable: readonly string[];
};

/**
 * Walk `rootReal` for harness directories. `rootReal` must already be a
 * validated, contained, real path — this function does no containment checking
 * of its own beyond refusing to follow symlinks.
 */
export function discoverHarnesses(
  rootReal: string,
  maxDepth = 6,
  maxHarnesses = 200,
): DiscoveryResult {
  const harnesses: DiscoveredHarness[] = [];
  const unreadable: string[] = [];
  let truncated = false;
  let depthLimited = false;

  const relOf = (dir: string): string => toPosix(path.relative(rootReal, dir)) || ".";

  const walk = (dir: string, depth: number): void => {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(relOf(dir));
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === HARNESS_SPEC_FILENAME)) {
      if (harnesses.length >= maxHarnesses) {
        truncated = true;
        return;
      }
      harnesses.push({ dir, rel: relOf(dir) });
      // A harness's subdirectories are its own business: a nested
      // `crewhaus.yaml` under one is a fixture or a template, not a peer.
      return;
    }
    // Sorted before the descent so the SAME tree is walked in the same order on
    // every host — `readdir` order is filesystem-defined and differs between
    // ext4, APFS and a CI overlay.
    const dirs = [...entries]
      // `isDirectory()` is false for a symlink, which is exactly the refusal we
      // want: a link could point outside the contained root.
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .sort((a, b) => compareStrings(a.name, b.name));
    if (dirs.length > 0 && depth >= maxDepth) {
      depthLimited = true;
      return;
    }
    for (const entry of dirs) {
      walk(path.join(dir, entry.name), depth + 1);
      if (truncated) return;
    }
  };

  walk(rootReal, 0);
  harnesses.sort((a, b) => compareStrings(a.rel, b.rel));
  return { harnesses, truncated, depthLimited, unreadable: [...unreadable].sort(compareStrings) };
}
