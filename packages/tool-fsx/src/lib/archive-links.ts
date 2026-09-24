/**
 * Where an archive's link members lead once it is extracted, worked out over
 * the archive's OWN tree, before anything is written.
 *
 * A link's target cannot be judged as text. `path.resolve("a/b/y/..")`
 * folds to `a/b`, but when `a/b/y` is itself a link member `-> ../..`, the
 * kernel follows `y` first and `..` then climbs from where `y` led: two
 * levels above `a/b`, the destination root, and the next `..` leaves it
 * (security-11#5). So each target is walked one component at a time, the
 * way the kernel will walk it, substituting every link member it passes
 * through.
 *
 * This is the pre-extraction gate, so `dryRun` gives the verdict the real
 * call will. The post-extraction scan (`walkContained` over the staging
 * tree) remains the authoritative one: it asks the filesystem, not the
 * archive's index.
 *
 * Pure: entries in, verdicts out.
 */
import type { ArchiveEntry } from "./archive-format";

/** Symlink hops before the walk gives up, as the kernel does (ELOOP). */
const MAX_HOPS = 40;

export type UnsafeLink = {
  readonly name: string;
  readonly linkTarget: string;
  /** Why the member is refused, for the caller. */
  readonly why: string;
};

/** A member name as a list of components: `./a//b/` is `["a", "b"]`. */
export function memberComponents(name: string): string[] {
  return name
    .replace(/\\/g, "/")
    .split("/")
    .filter((c) => c !== "" && c !== ".");
}

type Node = { kind: ArchiveEntry["kind"]; linkTarget?: string };

function buildTree(entries: ReadonlyArray<ArchiveEntry>): {
  members: Map<string, Node>;
  dirs: Set<string>;
} {
  const members = new Map<string, Node>();
  const dirs = new Set<string>([""]);
  for (const entry of entries) {
    const parts = memberComponents(entry.name);
    if (parts.length === 0) continue;
    // Every proper prefix of a member is a directory the extractor makes.
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    const key = parts.join("/");
    // A later member of the same name replaces an earlier one, as it does on
    // extraction.
    members.set(key, {
      kind: entry.kind,
      ...(entry.linkTarget !== undefined ? { linkTarget: entry.linkTarget } : {}),
    });
    if (entry.kind === "dir") dirs.add(key);
  }
  return { members, dirs };
}

function isAbsoluteTarget(target: string): boolean {
  return target.startsWith("/") || target.startsWith("\\") || /^[A-Za-z]:/.test(target);
}

type Walk = { ok: true; hops: number } | { ok: false; why: string; hops: number };

/**
 * Walk `pending` from the destination root over the archive's tree.
 * Fails when a `..` would climb above the root, when an absolute target is
 * met, when a `..` follows a name the archive does not contain (the kernel
 * would stop there, but what is on disk under that name is not the
 * archive's to vouch for), or when links chain past the hop limit.
 */
function walk(tree: ReturnType<typeof buildTree>, initial: string[]): Walk {
  const stack: string[] = [];
  let pending = initial;
  let hops = 0;
  let missing = false;
  while (pending.length > 0) {
    const comp = pending.shift() as string;
    if (comp === "." || comp === "") continue;
    if (comp === "..") {
      if (missing) {
        return { ok: false, why: "a '..' follows a name this archive does not contain", hops };
      }
      if (stack.length === 0) return { ok: false, why: "outside", hops };
      stack.pop();
      continue;
    }
    if (missing) {
      stack.push(comp);
      continue;
    }
    const key = [...stack, comp].join("/");
    const node = tree.members.get(key);
    if (node?.kind === "symlink") {
      hops += 1;
      if (hops > MAX_HOPS) return { ok: false, why: "links chain too deeply to resolve", hops };
      const target = node.linkTarget ?? "";
      if (target === "") return { ok: false, why: "it passes through a link with no target", hops };
      if (isAbsoluteTarget(target)) return { ok: false, why: "outside", hops };
      // Relative to the directory holding the link, which is `stack`.
      pending = [...target.replace(/\\/g, "/").split("/"), ...pending];
      continue;
    }
    stack.push(comp);
    // Past a name the archive does not make a directory of, nothing below
    // is the archive's: a file (ENOTDIR on the way through) or a name it
    // does not contain at all.
    if (!tree.dirs.has(key)) missing = true;
  }
  return { ok: true, hops };
}

/**
 * Every link member that would lead outside the destination once the
 * archive is extracted into it, with the reason. A symlink's target is
 * relative to the directory holding it; a tar hard link's target is a path
 * from the archive's root, and a hard link through any symlink is refused
 * outright (an extractor that followed it could link a file from anywhere
 * on the same filesystem into the workspace).
 */
export function unsafeArchiveLinks(entries: ReadonlyArray<ArchiveEntry>): UnsafeLink[] {
  const tree = buildTree(entries);
  const unsafe: UnsafeLink[] = [];
  for (const entry of entries) {
    if (entry.kind !== "symlink" && entry.kind !== "hardlink") continue;
    const target = entry.linkTarget ?? "";
    const refuse = (why: string): void => {
      unsafe.push({ name: entry.name, linkTarget: target, why });
    };
    if (target === "") {
      // An unreadable target is refused rather than waved through: a link
      // this gate cannot evaluate is precisely what a crafted archive would
      // present to get past it.
      refuse("a link whose target this archive does not state");
      continue;
    }
    if (isAbsoluteTarget(target)) {
      refuse("link points outside");
      continue;
    }
    const targetParts = target.replace(/\\/g, "/").split("/");
    if (entry.kind === "hardlink") {
      const walked = walk(tree, targetParts);
      if (!walked.ok) {
        refuse(walked.why === "outside" ? "link points outside" : `hard link: ${walked.why}`);
      } else if (walked.hops > 0) {
        refuse("hard link through a symlink");
      }
      continue;
    }
    // A symlink: start where it sits. Its own directory is walked too, since
    // that directory may itself be reached through another link member.
    const where = memberComponents(entry.name).slice(0, -1);
    const walked = walk(tree, [...where, ...targetParts]);
    if (walked.ok) continue;
    if (walked.why !== "outside") refuse(`link target unresolvable: ${walked.why}`);
    else
      refuse(walked.hops > 0 ? "link points outside, through another link" : "link points outside");
  }
  return unsafe;
}
