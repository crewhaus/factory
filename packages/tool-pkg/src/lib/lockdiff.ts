/**
 * Compare two lockfiles and classify what changed.
 *
 * Reviewing a dependency bump is the case this exists for. The diff a
 * version-control tool produces is thousands of lines of integrity hashes
 * and resolved URLs; the question is always the same short one — what was
 * added, what was removed, what moved, and was any of it a major. Putting a
 * lockfile through a context window to answer that is the exact waste this
 * package is meant to remove.
 *
 * Parsing comes from `@crewhaus/tool-code`, which already reads the four
 * lockfile formats for `DependencyList`.
 */
import { compareSemver, parseSemver } from "@crewhaus/tool-code";

/** How a version moved. `unknown` when either side would not parse. */
export const BUMP_KINDS = [
  "major",
  "minor",
  "patch",
  "prerelease",
  "downgrade",
  "same",
  "unknown",
] as const;
export type BumpKind = (typeof BUMP_KINDS)[number];

export type LockedEntry = { readonly name: string; readonly version: string };

export type LockChange = {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly bump: BumpKind;
};

export type LockDiff = {
  readonly added: ReadonlyArray<LockedEntry>;
  readonly removed: ReadonlyArray<LockedEntry>;
  readonly changed: ReadonlyArray<LockChange>;
  readonly unchanged: number;
  readonly counts: Readonly<Record<BumpKind, number>> & {
    readonly added: number;
    readonly removed: number;
  };
};

/**
 * Classify a version move.
 *
 * A downgrade is called out separately rather than folded into its
 * magnitude: "major" and "went backwards by a major" need different
 * attention, and a reviewer scanning counts would otherwise miss it.
 */
export function classifyBump(from: string, to: string): BumpKind {
  if (from === to) return "same";
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (a === undefined || b === undefined) return "unknown";
  const direction = compareSemver(a, b);
  if (direction === 0) return "same";
  if (direction > 0) return "downgrade";
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return "minor";
  if (a.patch !== b.patch) return "patch";
  return "prerelease";
}

/**
 * Index entries by name.
 *
 * A lockfile can hold one package at several versions — that is what a
 * lockfile is for. Keeping only one would silently drop the others, so the
 * versions are collected and compared as a set; a package that went from one
 * version to two shows up as a change, not as nothing.
 */
function index(entries: ReadonlyArray<LockedEntry>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of entries) {
    const list = out.get(entry.name);
    if (list) list.push(entry.version);
    else out.set(entry.name, [entry.version]);
  }
  for (const list of out.values()) list.sort();
  return out;
}

export function diffLocks(
  before: ReadonlyArray<LockedEntry>,
  after: ReadonlyArray<LockedEntry>,
): LockDiff {
  const a = index(before);
  const b = index(after);

  const added: LockedEntry[] = [];
  const removed: LockedEntry[] = [];
  const changed: LockChange[] = [];
  let unchanged = 0;

  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const from = a.get(name);
    const to = b.get(name);
    if (from === undefined) {
      for (const version of to ?? []) added.push({ name, version });
      continue;
    }
    if (to === undefined) {
      for (const version of from) removed.push({ name, version });
      continue;
    }
    if (from.join() === to.join()) {
      unchanged += 1;
      continue;
    }
    // Compare the sorted lists pairwise, and report leftovers on either side
    // as additions or removals of that package at that version.
    const width = Math.max(from.length, to.length);
    for (let i = 0; i < width; i++) {
      const left = from[i];
      const right = to[i];
      if (left === undefined && right !== undefined) added.push({ name, version: right });
      else if (right === undefined && left !== undefined) removed.push({ name, version: left });
      else if (left !== undefined && right !== undefined && left !== right) {
        changed.push({ name, from: left, to: right, bump: classifyBump(left, right) });
      }
    }
  }

  const counts = {
    added: added.length,
    removed: removed.length,
  } as Record<string, number>;
  for (const kind of BUMP_KINDS) counts[kind] = 0;
  for (const change of changed) counts[change.bump] = (counts[change.bump] ?? 0) + 1;

  return {
    added,
    removed,
    changed,
    unchanged,
    counts: counts as LockDiff["counts"],
  };
}
