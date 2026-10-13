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
 * The work is linear in the archive's names and link targets. The archive
 * is untrusted and its names are not short: a zip name runs to 64 KiB and a
 * tar long name has no limit, so a few hundred bytes of .tar.gz can hold a
 * name thousands of directories deep. 0.7.1's first version kept every
 * prefix of every name as its own string, which is the square of the depth
 * (a 206-byte archive held 64 million characters), and walked by rebuilding
 * the joined path at each step. The tree below keeps each name once, and
 * each link's target is walked once, however many members lead through it.
 *
 * Pure: entries in, verdicts out.
 */
import type { ArchiveEntry } from "./archive-format";

/** Symlink hops before the walk gives up, as the kernel does (ELOOP). */
const MAX_HOPS = 40;

const SLASH = 47;

const CHAIN = "links chain too deeply to resolve";

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

/**
 * A node of the archive's tree, compressed: there is one only where a
 * member's path ends or two paths part. Its edge from the parent is a run of
 * whole components, `src.slice(start, end)`, held as offsets into the member
 * path it was cut from, so splitting an edge copies nothing.
 */
type TreeNode = {
  readonly src: string;
  start: number;
  readonly end: number;
  parent: TreeNode | undefined;
  /** Children by the first component of their edge; absent when there are none. */
  children: Map<string, TreeNode> | undefined;
  /** The member of exactly this path: the last one of that name, as extraction leaves it. */
  member: { readonly kind: ArchiveEntry["kind"]; readonly linkTarget?: string } | undefined;
  /** Some member of exactly this path is a directory. */
  dirMember: boolean;
  /** {@link ascend}'s answers from places on this edge, by `at`, kept once asked. */
  above: Map<number, Place> | undefined;
};

/**
 * A place in the tree: at `node` when `at` is its edge's length, otherwise
 * part-way down its edge, just before the `/` at offset `at`. Every path the
 * tree holds has exactly one such place.
 */
type Place = { readonly node: TreeNode; readonly at: number };

/** Where a walk ends: a place, or past a name the archive does not hold. */
type Outcome =
  | {
      readonly ok: true;
      readonly node: TreeNode;
      readonly at: number;
      readonly missing: boolean;
      readonly hops: number;
    }
  | { readonly ok: false; readonly why: string; readonly hops: number };

type Tree = {
  readonly root: TreeNode;
  /**
   * Each link member's target, walked once from the directory holding the
   * link with the hop count starting at zero; `null` while that walk is under
   * way. A link met again inside its own walk is a loop.
   */
  readonly resolved: Map<TreeNode, Outcome | null>;
};

function makeNode(src: string, start: number, end: number, parent: TreeNode | undefined): TreeNode {
  return {
    src,
    start,
    end,
    parent,
    children: undefined,
    member: undefined,
    dirMember: false,
    above: undefined,
  };
}

function edgeLength(node: TreeNode): number {
  return node.end - node.start;
}

/** Where the component starting at `from` ends: its `/`, or `end`. */
function componentEnd(src: string, from: number, end: number): number {
  const slash = src.indexOf("/", from);
  return slash === -1 || slash > end ? end : slash;
}

/** The node for `key` (components joined by `/`, at least one), made if it is new. */
function insert(root: TreeNode, key: string): TreeNode {
  let node = root;
  let p = 0;
  for (;;) {
    const firstEnd = componentEnd(key, p, key.length);
    const first = key.slice(p, firstEnd);
    const child = node.children?.get(first);
    if (child === undefined) {
      const leaf = makeNode(key, p, key.length, node);
      if (node.children === undefined) node.children = new Map();
      node.children.set(first, leaf);
      return leaf;
    }
    // The child's edge starts with `first`; see how much more of it matches.
    const length = edgeLength(child);
    let i = firstEnd - p;
    while (
      i < length &&
      p + i < key.length &&
      child.src.charCodeAt(child.start + i) === key.charCodeAt(p + i)
    ) {
      i += 1;
    }
    const edgeBreaks = i === length || child.src.charCodeAt(child.start + i) === SLASH;
    const keyBreaks = p + i === key.length || key.charCodeAt(p + i) === SLASH;
    // The match ends on a whole component: `i` if both break there, else the
    // last `/` before it (there is one: both break after `first`).
    const shared =
      edgeBreaks && keyBreaks ? i : child.src.lastIndexOf("/", child.start + i - 1) - child.start;
    let reached = child;
    if (shared < length) {
      const mid = makeNode(child.src, child.start, child.start + shared, node);
      child.start += shared + 1;
      child.parent = mid;
      const rest = child.src.slice(child.start, componentEnd(child.src, child.start, child.end));
      mid.children = new Map([[rest, child]]);
      node.children?.set(first, mid);
      reached = mid;
    }
    p += shared;
    if (p === key.length) return reached;
    p += 1;
    node = reached;
  }
}

function buildTree(entries: ReadonlyArray<ArchiveEntry>): Tree {
  const root = makeNode("", 0, 0, undefined);
  for (const entry of entries) {
    const parts = memberComponents(entry.name);
    if (parts.length === 0) continue;
    const node = insert(root, parts.join("/"));
    // A later member of the same name replaces an earlier one, as it does on
    // extraction. Every proper prefix of a member is a directory the
    // extractor makes, which the tree's shape already says.
    node.member = {
      kind: entry.kind,
      ...(entry.linkTarget !== undefined ? { linkTarget: entry.linkTarget } : {}),
    };
    if (entry.kind === "dir") node.dirMember = true;
  }
  return { root, resolved: new Map() };
}

/** The place one component below `node`/`at`, or undefined when the archive holds no such path. */
function descend(node: TreeNode, at: number, comp: string): Place | undefined {
  const length = edgeLength(node);
  if (at === length) {
    const child = node.children?.get(comp);
    return child === undefined ? undefined : { node: child, at: comp.length };
  }
  // Part-way down an edge, before a `/`: the edge must go on with `comp`.
  // `comp` holds no `/`, so it cannot match past the edge's end.
  const after = at + 1 + comp.length;
  if (!node.src.startsWith(comp, node.start + at + 1)) return undefined;
  if (after !== length && node.src.charCodeAt(node.start + after) !== SLASH) return undefined;
  return { node, at: after };
}

/**
 * The place one component above, or undefined at the root.
 *
 * Finding it reads back over the component being left, which the walk need
 * not have read: a walk that a memoized link placed (`resume`) never read the
 * names it was placed in, so n links that each went through one link and
 * climbed back out read its long name n times. So each place's answer is
 * kept the first time it is asked. A place ends one component of one edge,
 * so all the reading back together is at most the tree's edges, which are at
 * most the archive's names. The tree is complete before any walk, so no edge
 * is split under a kept answer.
 */
function ascend(node: TreeNode, at: number): Place | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  const known = node.above?.get(at);
  if (known !== undefined) return known;
  // An edge starts just after a `/` of its source (or at its start), so this
  // scan stops within the edge's last component.
  const slash = node.src.lastIndexOf("/", node.start + at - 1);
  const place: Place =
    slash >= node.start
      ? { node, at: slash - node.start }
      : { node: parent, at: edgeLength(parent) };
  node.above ??= new Map();
  node.above.set(at, place);
  return place;
}

function isAbsoluteTarget(target: string): boolean {
  return target.startsWith("/") || target.startsWith("\\") || /^[A-Za-z]:/.test(target);
}

type Walk = { ok: true; hops: number } | { ok: false; why: string; hops: number };

/** One target being walked: the main one (`link` undefined) or a link member's. */
type Frame = {
  readonly link: TreeNode | undefined;
  readonly comps: ReadonlyArray<string>;
  next: number;
  node: TreeNode;
  at: number;
  missing: boolean;
  /** Hops since this frame began. */
  hops: number;
};

/**
 * Go on with `caller` after a link it just stepped through resolved to
 * `inner`, whose hops count from that link. The caller's own outcome when
 * this ends it, else undefined.
 *
 * `inner` was walked with the count at zero, and the walk differs from one
 * started at the caller's count only by the hop limit: if that limit falls
 * inside `inner`'s hops it is met there, before whatever else `inner` ends
 * on; otherwise `inner` happens exactly as it did, its hops added on.
 */
function resume(caller: Frame, inner: Outcome): Outcome | undefined {
  if (caller.hops + inner.hops > MAX_HOPS) return { ok: false, why: CHAIN, hops: MAX_HOPS + 1 };
  if (!inner.ok) return { ok: false, why: inner.why, hops: caller.hops + inner.hops };
  caller.node = inner.node;
  caller.at = inner.at;
  caller.missing = inner.missing;
  caller.hops += inner.hops;
  return undefined;
}

/**
 * Walk `initial` from the destination root over the archive's tree.
 * Fails when a `..` would climb above the root, when an absolute target is
 * met, when a `..` follows a name the archive does not contain (the kernel
 * would stop there, but what is on disk under that name is not the
 * archive's to vouch for), or when links chain past the hop limit.
 *
 * A link member's target is relative to the directory holding the link,
 * which is the same directory however the walk got there, so it is walked
 * once and the outcome reused (`Tree.resolved`). The targets being walked
 * are kept on an explicit stack, not the call stack, since links may chain
 * through as many members as the archive has.
 */
function walk(tree: Tree, initial: ReadonlyArray<string>): Walk {
  const frames: Frame[] = [
    { link: undefined, comps: initial, next: 0, node: tree.root, at: 0, missing: false, hops: 0 },
  ];
  let done: Outcome | undefined;
  for (;;) {
    if (done !== undefined) {
      const finished = frames.pop() as Frame;
      if (finished.link !== undefined) tree.resolved.set(finished.link, done);
      const caller = frames[frames.length - 1];
      if (caller === undefined) {
        return done.ok
          ? { ok: true, hops: done.hops }
          : { ok: false, why: done.why, hops: done.hops };
      }
      done = resume(caller, done);
      continue;
    }
    const f = frames[frames.length - 1] as Frame;
    if (f.next >= f.comps.length) {
      done = { ok: true, node: f.node, at: f.at, missing: f.missing, hops: f.hops };
      continue;
    }
    const comp = f.comps[f.next] as string;
    f.next += 1;
    if (comp === "." || comp === "") continue;
    if (comp === "..") {
      if (f.missing) {
        done = {
          ok: false,
          why: "a '..' follows a name this archive does not contain",
          hops: f.hops,
        };
        continue;
      }
      const up = ascend(f.node, f.at);
      if (up === undefined) {
        done = { ok: false, why: "outside", hops: f.hops };
        continue;
      }
      f.node = up.node;
      f.at = up.at;
      continue;
    }
    // Past a name the archive does not hold, nothing below is the archive's.
    if (f.missing) continue;
    const place = descend(f.node, f.at, comp);
    const atNode = place !== undefined && place.at === edgeLength(place.node);
    const member = atNode ? place.node.member : undefined;
    if (place !== undefined && member?.kind === "symlink") {
      f.hops += 1;
      if (f.hops > MAX_HOPS) {
        done = { ok: false, why: CHAIN, hops: f.hops };
        continue;
      }
      const target = member.linkTarget ?? "";
      if (target === "") {
        done = { ok: false, why: "it passes through a link with no target", hops: f.hops };
        continue;
      }
      if (isAbsoluteTarget(target)) {
        done = { ok: false, why: "outside", hops: f.hops };
        continue;
      }
      const known = tree.resolved.get(place.node);
      if (known === null) {
        // Met inside its own walk: the walk would come round to it again and
        // again until the hop limit stops it.
        done = { ok: false, why: CHAIN, hops: MAX_HOPS + 1 };
        continue;
      }
      if (known !== undefined) {
        done = resume(f, known);
        continue;
      }
      // Relative to the directory holding the link, which is where `f` is.
      tree.resolved.set(place.node, null);
      frames.push({
        link: place.node,
        comps: target.replace(/\\/g, "/").split("/"),
        next: 0,
        node: f.node,
        at: f.at,
        missing: false,
        hops: 0,
      });
      continue;
    }
    if (place === undefined) {
      f.missing = true;
      continue;
    }
    f.node = place.node;
    f.at = place.at;
    // Past a name the archive does not make a directory of, nothing below
    // is the archive's: a file (ENOTDIR on the way through) or a name it
    // does not contain at all. Part-way down an edge is a directory, since
    // a longer member path goes on from there.
    if (atNode && place.node.children === undefined && !place.node.dirMember) f.missing = true;
  }
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
  // Only link members are judged, so an archive with none needs no tree.
  if (!entries.some((entry) => entry.kind === "symlink" || entry.kind === "hardlink")) return [];
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
