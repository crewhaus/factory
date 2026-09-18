/**
 * Finding the harnesses under a root.
 *
 * The discovery model is the one `crewhaus fleet` uses, so the two agree
 * about what a harness is: a directory carrying a `crewhaus.yaml`. The walk
 * is depth-bounded, never descends into a harness's own `.crewhaus/` state
 * directory or into `node_modules` (a template spec vendored under
 * `node_modules` is not a fleet member), and never follows a directory
 * symlink — a link out of the workspace would walk straight past the
 * containment boundary this package spends `resolveSafe` on.
 *
 * Results are sorted by workspace-relative path, so the same tree always
 * produces the same bytes.
 */

import { type Dirent, readdirSync } from "node:fs";
import * as path from "node:path";
import { compareStrings } from "./lib/spec-view";
import { toPosix } from "./paths";

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
  /** True when the cap stopped the walk before the tree was exhausted. */
  readonly truncated: boolean;
  /** Directories the walk could not read (permissions, races). */
  readonly unreadable: readonly string[];
};

/**
 * Walk `rootReal` for harness directories. `rootReal` must already be a
 * validated, contained, real path — this function does no containment
 * checking of its own beyond refusing to follow symlinks.
 */
export function discoverHarnesses(
  rootReal: string,
  maxDepth = 6,
  maxHarnesses = 500,
): DiscoveryResult {
  const harnesses: DiscoveredHarness[] = [];
  const unreadable: string[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(toPosix(path.relative(rootReal, dir)) || ".");
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === HARNESS_SPEC_FILENAME)) {
      if (harnesses.length >= maxHarnesses) {
        truncated = true;
        return;
      }
      harnesses.push({ dir, rel: toPosix(path.relative(rootReal, dir)) || "." });
      // A harness's subdirectories are its own business: a nested
      // `crewhaus.yaml` under one is a fixture or a template, not a peer.
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of [...entries].sort((a, b) => compareStrings(a.name, b.name))) {
      // `isDirectory()` is false for a symlink, which is exactly the refusal
      // we want: a link could point outside the contained root.
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
      if (truncated) return;
    }
  };

  walk(rootReal, 0);
  harnesses.sort((a, b) => compareStrings(a.rel, b.rel));
  return { harnesses, truncated, unreadable: [...unreadable].sort(compareStrings) };
}
