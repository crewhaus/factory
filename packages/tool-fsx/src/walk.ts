/**
 * The one directory walker the listing tools share, so `Tree`, `FindFiles`
 * and `DiskUsage` agree about what is in a directory.
 *
 * Determinism rules it enforces:
 *   - entries are sorted by name with plain `<` on the raw string. No
 *     `localeCompare`: its result depends on the machine's locale data, so
 *     the same tree could list differently on two hosts.
 *   - the walk is depth-first in that sorted order, so a truncated result is
 *     truncated at the same place every time.
 *   - directory symlinks are reported but never followed. That removes the
 *     cycle problem and, more importantly, stops a link inside the workspace
 *     from walking the tool out of it.
 *   - `.git` is always skipped: it is machine state, not the user's content.
 */
import { type Dirent, lstatSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { type IgnoreLayer, type IgnoreRule, isIgnored, parseGitignore } from "./lib/gitignore";
import { matchGlob } from "./lib/glob";

export type NodeKind = "file" | "dir" | "symlink" | "other";

export type WalkNode = {
  readonly name: string;
  /** Slash-separated path relative to the walk root; "" for the root itself. */
  readonly rel: string;
  readonly abs: string;
  readonly kind: NodeKind;
  /** Apparent size in bytes for files; 0 for directories and links. */
  readonly size: number;
  readonly mtimeMs: number;
  children?: WalkNode[];
  /** Entries dropped from this directory because the entry cap was reached. */
  droppedChildren?: number;
  /** True when this directory has contents that `maxDepth` stopped us listing. */
  depthLimited?: boolean;
};

export type WalkOptions = {
  /** How many levels of entries to list, as `tree -L` counts them: 1 is the
   *  root's own children, 2 adds their children, and so on. */
  readonly maxDepth: number;
  /** Hard cap on listed entries, so one call cannot enumerate a huge tree. */
  readonly maxEntries: number;
  readonly respectGitignore: boolean;
  /** When false, dot-files and dot-directories are skipped. */
  readonly includeHidden: boolean;
  /** Glob patterns; an entry matching one by basename or relative path is skipped. */
  readonly exclude: ReadonlyArray<string>;
};

export type WalkResult = {
  readonly root: WalkNode;
  /** Every node listed, root excluded, in depth-first sorted order. */
  readonly entries: ReadonlyArray<WalkNode>;
  /** True when the entry cap or a depth limit cut the listing short. */
  readonly truncated: boolean;
};

type Statish = { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };

function kindOf(entry: Statish): NodeKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  return "other";
}

/** Plain string comparison — locale-independent by construction. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function excluded(patterns: ReadonlyArray<string>, rel: string, name: string): boolean {
  for (const pattern of patterns) {
    if (matchGlob(pattern, name) || matchGlob(pattern, rel)) return true;
  }
  return false;
}

/** Read and compile one `.gitignore`, or undefined when there is none. */
export function loadIgnoreRules(file: string): IgnoreRule[] | undefined {
  try {
    return parseGitignore(readFileSync(file, "utf8"));
  } catch {
    return undefined; // missing or unreadable: contributes no rules
  }
}

type WalkState = { remaining: number; truncated: boolean };

/**
 * Walk `rootAbs`, which must already have passed the containment check.
 * Returns the tree plus a flat, ordered list of everything in it.
 */
export function walkTree(rootAbs: string, options: WalkOptions): WalkResult {
  const rootStat = lstatSync(rootAbs);
  const root: WalkNode = {
    name: path.basename(rootAbs),
    rel: "",
    abs: rootAbs,
    kind: kindOf(rootStat),
    size: rootStat.isFile() ? rootStat.size : 0,
    mtimeMs: Math.floor(rootStat.mtimeMs),
  };
  const entries: WalkNode[] = [];
  const state: WalkState = { remaining: options.maxEntries, truncated: false };
  if (root.kind === "dir") {
    root.children = [];
    const layers: IgnoreLayer[] = [];
    if (options.respectGitignore) {
      const rules = loadIgnoreRules(path.join(rootAbs, ".gitignore"));
      if (rules !== undefined) layers.push({ base: "", rules });
    }
    descend(root, 0, entries, state, options, layers);
  }
  return { root, entries, truncated: state.truncated };
}

function descend(
  parent: WalkNode,
  depth: number,
  flat: WalkNode[],
  state: WalkState,
  options: WalkOptions,
  layers: ReadonlyArray<IgnoreLayer>,
): void {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(parent.abs, { withFileTypes: true });
  } catch {
    return; // unreadable directory: list nothing rather than fail the whole walk
  }
  const sorted = [...dirents].sort((a, b) => compareStrings(a.name, b.name));
  const children = parent.children as WalkNode[];

  for (const dirent of sorted) {
    const name = dirent.name;
    if (name === ".git") continue;
    if (!options.includeHidden && name.startsWith(".")) continue;

    const rel = parent.rel === "" ? name : `${parent.rel}/${name}`;
    if (excluded(options.exclude, rel, name)) continue;

    const kind = kindOf(dirent);
    const isDir = kind === "dir";
    if (options.respectGitignore && isIgnored(layers, rel, isDir)) continue;

    if (state.remaining <= 0) {
      parent.droppedChildren = (parent.droppedChildren ?? 0) + 1;
      state.truncated = true;
      continue;
    }

    const abs = path.join(parent.abs, name);
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = lstatSync(abs);
      size = stat.isFile() ? stat.size : 0;
      mtimeMs = Math.floor(stat.mtimeMs);
    } catch {
      continue; // raced away between readdir and lstat
    }

    const node: WalkNode = { name, rel, abs, kind, size, mtimeMs };
    state.remaining -= 1;
    children.push(node);
    flat.push(node);

    if (!isDir) continue;
    if (depth + 1 >= options.maxDepth) {
      node.depthLimited = true;
      state.truncated = true;
      continue;
    }
    node.children = [];
    let nextLayers = layers;
    if (options.respectGitignore) {
      const rules = loadIgnoreRules(path.join(abs, ".gitignore"));
      // Deeper files are appended, and `isIgnored` takes the LAST match, so
      // appending is exactly git's "deeper file wins" precedence.
      if (rules !== undefined) nextLayers = [...layers, { base: rel, rules }];
    }
    descend(node, depth + 1, flat, state, options, nextLayers);
  }
}

/**
 * Roll each directory's apparent size up through its parents. Files count
 * their own `size`; symlinks count zero (their target is counted where it
 * lives, if it is in the tree at all).
 */
export function rollUpSizes(root: WalkNode): Map<string, { bytes: number; files: number }> {
  const totals = new Map<string, { bytes: number; files: number }>();
  const visit = (node: WalkNode): { bytes: number; files: number } => {
    if (node.kind !== "dir") {
      return { bytes: node.kind === "file" ? node.size : 0, files: node.kind === "file" ? 1 : 0 };
    }
    let bytes = 0;
    let files = 0;
    for (const child of node.children ?? []) {
      const sub = visit(child);
      bytes += sub.bytes;
      files += sub.files;
    }
    totals.set(node.rel, { bytes, files });
    return { bytes, files };
  };
  visit(root);
  return totals;
}
