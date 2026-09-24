import { type Stats, closeSync, lstatSync, opendirSync, readdirSync, readlinkSync } from "node:fs";
import * as path from "node:path";
import { type FileKind, fileKind } from "../streams/file";
import { type SafeFsFailure, fail, quote, requireLimit } from "./failure";
import { isWithin, physicalPath, prepareRoot, resolveIn } from "./resolve";

/**
 * The one directory walk tools use.
 *
 * It never follows a symlink: every entry is `lstat`ed, a link is reported
 * as a link (with whether its target stays inside the root), and a FIFO,
 * socket or device is reported as what it is, so no caller can mistake one
 * for a file and open it. Walked directories are re-checked after they are
 * listed: one swapped for a link while it was being read is reported as
 * unreadable, not listed.
 *
 * Order is deterministic: depth-first, children sorted with plain `<` on
 * the raw name (no `localeCompare`, whose answer depends on the machine).
 */

export type WalkEntry = {
  /** Slash-separated path relative to the walk's start. */
  readonly rel: string;
  /** Slash-separated path relative to the ROOT, for messages and results. */
  readonly path: string;
  /** Physical absolute path, inside the root. */
  readonly real: string;
  /** What `lstat` says: a link is `symlink`, never what it leads to. */
  readonly kind: FileKind;
  /** 1 for a child of the start, 2 for a grandchild, and so on. */
  readonly depth: number;
  /** Bytes, for regular files; 0 otherwise. */
  readonly size: number;
  readonly mtimeMs: number;
  /** For a symlink: its target text and where it physically leads. */
  readonly link?: {
    readonly text: string;
    /** The target resolves inside the root (it may still not exist). */
    readonly inside: boolean;
    /** Nothing exists at the target, or the chain loops. */
    readonly dangling: boolean;
  };
};

export type WalkDecision = "keep" | "skip" | "prune";

export type WalkOptions = {
  /** Most entries returned. More makes the result `truncated`, never an error. */
  readonly maxEntries: number;
  /** Levels listed, as `tree -L` counts them: 1 is the start's own children. */
  readonly maxDepth: number;
  /** Links are never followed. The option exists so a call site can say so. */
  readonly followSymlinks?: false;
  /**
   * Called for every entry before it is counted. `skip` leaves it out but
   * still descends into a directory; `prune` leaves it out and does not.
   */
  readonly filter?: (entry: WalkEntry) => WalkDecision;
  /**
   * Most entries EXAMINED, kept or not (default ten times `maxEntries`, at
   * least 10 000), so a filter that skips nearly everything cannot make one
   * call walk an entire disk.
   */
  readonly maxVisited?: number;
};

export type WalkTruncation = "max-entries" | "max-depth" | "max-visited";

export type Unreadable = {
  /** Relative to the start. */
  readonly rel: string;
  readonly reason: "permission-denied" | "changed" | "io-error";
};

export type WalkResult =
  | {
      readonly ok: true;
      /** Physical path of the start directory. */
      readonly real: string;
      /** Entries in depth-first sorted order; the start itself is not one. */
      readonly entries: readonly WalkEntry[];
      readonly truncated: boolean;
      readonly truncatedBy?: WalkTruncation;
      /** Directories that could not be listed; their contents are missing. */
      readonly unreadable: readonly Unreadable[];
    }
  | SafeFsFailure;

/** One walked entry with its `lstat`, for the copy planner. */
export type WalkedStat = { readonly entry: WalkEntry; readonly stats: Stats };

type State = {
  readonly rootPhysical: string;
  readonly givenBase: string;
  readonly options: WalkOptions;
  readonly maxVisited: number;
  readonly out: WalkedStat[];
  readonly unreadable: Unreadable[];
  visited: number;
  stopped: boolean;
  truncatedBy: WalkTruncation | undefined;
};

function joinRel(a: string, b: string): string {
  return a === "" ? b : `${a}/${b}`;
}

function describeLink(state: State, real: string): WalkEntry["link"] {
  let text: string;
  try {
    text = readlinkSync(real);
  } catch {
    return { text: "", inside: false, dangling: true };
  }
  try {
    const target = physicalPath(real);
    let dangling = false;
    try {
      lstatSync(target);
    } catch {
      dangling = true;
    }
    return { text, inside: isWithin(state.rootPhysical, target), dangling };
  } catch {
    return { text, inside: false, dangling: true };
  }
}

function hasChildren(dir: string): boolean {
  try {
    const handle = opendirSync(dir);
    try {
      return handle.readSync() !== null;
    } finally {
      handle.closeSync();
    }
  } catch {
    return false;
  }
}

function errnoReason(err: unknown): Unreadable["reason"] {
  const code = (err as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM" ? "permission-denied" : "io-error";
}

function descend(state: State, dir: string, dirStats: Stats, rel: string, depth: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    state.unreadable.push({ rel, reason: errnoReason(err) });
    return;
  }
  // The directory listed must be the directory that was checked: a swap for
  // a link during the read would have listed somewhere else.
  try {
    const after = lstatSync(dir);
    if (!after.isDirectory() || after.dev !== dirStats.dev || after.ino !== dirStats.ino) {
      state.unreadable.push({ rel, reason: "changed" });
      return;
    }
  } catch {
    state.unreadable.push({ rel, reason: "changed" });
    return;
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    if (state.stopped) return;
    state.visited += 1;
    if (state.visited > state.maxVisited) {
      state.truncatedBy = "max-visited";
      state.stopped = true;
      return;
    }
    const real = path.join(dir, name);
    let stats: Stats;
    try {
      stats = lstatSync(real);
    } catch (err) {
      // Deleted since the listing: not there, so not listed.
      if ((err as { code?: unknown }).code === "ENOENT") continue;
      state.unreadable.push({ rel: joinRel(rel, name), reason: errnoReason(err) });
      continue;
    }
    const kind = fileKind(stats);
    const childRel = joinRel(rel, name);
    const base = {
      rel: childRel,
      path: joinRel(state.givenBase, childRel),
      real,
      kind,
      depth,
      size: kind === "file" ? stats.size : 0,
      mtimeMs: Math.floor(stats.mtimeMs),
    };
    const entry: WalkEntry =
      kind === "symlink" ? { ...base, link: describeLink(state, real) } : base;
    const decision = state.options.filter?.(entry) ?? "keep";
    if (decision === "keep") {
      if (state.out.length >= state.options.maxEntries) {
        state.truncatedBy = "max-entries";
        state.stopped = true;
        return;
      }
      state.out.push({ entry, stats });
    }
    if (kind !== "directory" || decision === "prune") continue;
    if (depth < state.options.maxDepth) {
      descend(state, real, stats, childRel, depth + 1);
    } else if (state.truncatedBy === undefined && hasChildren(real)) {
      state.truncatedBy = "max-depth";
    }
  }
}

/**
 * Walk from an already-contained physical directory. Internal: the copy
 * planner uses it with its own budget.
 */
export function walkPhysical(
  rootPhysical: string,
  startReal: string,
  startStats: Stats,
  givenBase: string,
  options: WalkOptions,
): { entries: WalkedStat[]; truncatedBy: WalkTruncation | undefined; unreadable: Unreadable[] } {
  const state: State = {
    rootPhysical,
    givenBase,
    options,
    maxVisited: options.maxVisited ?? Math.max(options.maxEntries * 10, 10_000),
    out: [],
    unreadable: [],
    visited: 0,
    stopped: false,
    truncatedBy: undefined,
  };
  if (options.maxDepth >= 1) {
    descend(state, startReal, startStats, "", 1);
  } else if (hasChildren(startReal)) {
    state.truncatedBy = "max-depth";
  }
  return { entries: state.out, truncatedBy: state.truncatedBy, unreadable: state.unreadable };
}

/**
 * Walk directory `start` (relative to `root`, or absolute inside it). The
 * start may be reached through links that stay inside the root; nothing
 * below it is followed.
 */
export function walkContained(root: string, start: string, options: WalkOptions): WalkResult {
  requireLimit("maxEntries", options.maxEntries, true);
  requireLimit("maxDepth", options.maxDepth, true);
  requireLimit("maxVisited", options.maxVisited, false);
  if (options.followSymlinks !== undefined && options.followSymlinks !== false) {
    throw new RangeError(
      "walkContained never follows symbolic links; followSymlinks must be false",
    );
  }
  const prepared = prepareRoot(root, start);
  if ("ok" in prepared) return prepared;
  const at = resolveIn(prepared, start);
  if (!at.ok) return at;
  let stats: Stats;
  try {
    stats = lstatSync(at.real);
  } catch {
    return fail("not-found", start, `${quote(start)} does not exist`);
  }
  if (!stats.isDirectory()) {
    const kind = fileKind(stats);
    return fail("not-directory", start, `${quote(start)} is a ${kind}, not a directory`, { kind });
  }
  const walked = walkPhysical(prepared.physical, at.real, stats, at.rel, options);
  return {
    ok: true,
    real: at.real,
    entries: walked.entries.map((w) => w.entry),
    truncated: walked.truncatedBy !== undefined,
    ...(walked.truncatedBy === undefined ? {} : { truncatedBy: walked.truncatedBy }),
    unreadable: walked.unreadable,
  };
}
