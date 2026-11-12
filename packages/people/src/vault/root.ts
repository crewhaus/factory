/**
 * Where a vault may live. Never inside a git work tree, where it could be committed, and
 * never at or under a harness's directory, where that harness's own tools could read it.
 * Checked before anything is created, on the name as given and on its physical path.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { within } from "./files";

export type RootRefusal = {
  readonly ok: false;
  readonly code: "in-git-work-tree" | "in-harness";
  readonly reason: string;
};

const FIX = "Set CREWHAUS_HANGAR_ROOT to a directory outside it.";

/** The physical path of `path`: its nearest existing ancestor resolved, the rest appended. */
function physical(path: string): string {
  const rest: string[] = [];
  let at = path;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(at);
    } catch {
      const up = dirname(at);
      if (up === at) return path;
      rest.push(basename(at));
      at = up;
      continue;
    }
    // One join per name: a spread of a list this long is cut short on some runtimes.
    return rest.reverse().reduce((joined, name) => join(joined, name), real);
  }
}

function gitAncestor(path: string): string | undefined {
  let at = path;
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/** Why `root` cannot hold a vault, or `undefined` when it can. Reads; creates nothing. */
export function rootRefusal(
  root: string,
  harnessDirs: readonly string[] = [],
): RootRefusal | undefined {
  const named = resolve(root);
  const spellings = [...new Set([named, physical(named)])];
  for (const path of spellings) {
    const repo = gitAncestor(path);
    if (repo !== undefined) {
      return {
        ok: false,
        code: "in-git-work-tree",
        reason: `Profiles can't be kept inside a git work tree (${repo}), where they could be committed. ${FIX}`,
      };
    }
  }
  for (const dir of harnessDirs) {
    const harness = resolve(dir);
    const harnessSpellings = [...new Set([harness, physical(harness)])];
    if (spellings.some((path) => harnessSpellings.some((h) => within(h, path)))) {
      return {
        ok: false,
        code: "in-harness",
        reason: `Profiles can't be kept inside a harness's directory (${dir}), where its own tools could read them. ${FIX}`,
      };
    }
  }
  return undefined;
}
