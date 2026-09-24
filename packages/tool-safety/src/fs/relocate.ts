import { type Dirent, type Stats, lstatSync, readdirSync, readlinkSync } from "node:fs";
import * as path from "node:path";
import {
  type SafeFsFailure,
  escapes,
  fail,
  fromErrno,
  quote,
  requireLimit,
  unresolvable,
} from "./failure";
import {
  type Overlay,
  type PlannedEntry,
  isWithin,
  physicalFrom,
  physicalPath,
  prepareRoot,
  toPosix,
} from "./resolve";
import { lexicalIn } from "./write";

/**
 * Before a rename moves a tree: would every symlink in it still lead inside
 * the destination root from where the rename puts it?
 *
 * A rename moves links to a new depth, and a relative link means something
 * else there: `a/b/up -> ../..` inside the workspace leads outside it once
 * `a/b` is moved one level up (security-11#2). Running `copyTreeSafe` with
 * `dryRun` answers that, but it plans every entry and applies a copy's
 * budgets: on a 60 600-entry tree it refused MovePath's default of 50 000
 * entries after 915 ms, and with the cap raised it walked for 2.5 s, where
 * the rename itself took 0.6 ms. A move has no content to budget.
 *
 * So this walks with the directory listing's own file types, descends into
 * directories only to reach links, and reads nothing but link text. Each
 * link is resolved from its new place the way the kernel will: through the
 * moved tree as it will stand (the source seen at the destination), `..`
 * after each hop.
 *
 * Where the destination already exists and the rename replaces it, what is
 * there now is consulted for paths the moved tree does not have; that can
 * only refuse more.
 */

export type RelocateOptions = {
  /** Most links checked; more refuses the move as `too-large`. Default 100 000. */
  readonly maxLinks?: number;
  /** Most entries listed, of every kind; more refuses as `too-large`. Default 1 000 000. */
  readonly maxVisited?: number;
};

export type RelocateResult =
  | {
      readonly ok: true;
      /** Links checked. */
      readonly links: number;
      /** Entries listed. */
      readonly visited: number;
    }
  | SafeFsFailure;

export const RELOCATE_DEFAULTS = { maxLinks: 100_000, maxVisited: 1_000_000 } as const;

/**
 * The moved tree, seen at its destination: what is at `dstTop/rel` after
 * the rename is what is at `srcTop/rel` now. Looked up lazily, one `lstat`
 * per path the resolution asks about.
 */
function movedTree(srcTop: string, dstTop: string): Overlay {
  const memo = new Map<string, PlannedEntry | undefined>();
  const get = (p: string): PlannedEntry | undefined => {
    if (!isWithin(dstTop, p)) return undefined;
    if (memo.has(p)) return memo.get(p);
    const from = path.join(srcTop, path.relative(dstTop, p));
    let entry: PlannedEntry | undefined;
    try {
      const st = lstatSync(from);
      entry = st.isSymbolicLink()
        ? { kind: "symlink", text: readlinkSync(from) }
        : st.isDirectory()
          ? { kind: "directory" }
          : { kind: "file" };
    } catch {
      entry = undefined;
    }
    memo.set(p, entry);
    return entry;
  };
  // `walk` in resolve.ts asks only `get` and `has`.
  return { get, has: (p: string) => get(p) !== undefined } as unknown as Overlay;
}

/**
 * Check that moving `src` (inside `srcRoot`) to `dst` (inside `dstRoot`)
 * leaves every symlink under it leading inside `dstRoot`. `src` itself may
 * be a link, and is judged at `dst`. Writes nothing.
 */
export function checkRelocatedLinks(
  srcRoot: string,
  src: string,
  dstRoot: string,
  dst: string,
  options: RelocateOptions = {},
): RelocateResult {
  requireLimit("maxLinks", options.maxLinks, false);
  requireLimit("maxVisited", options.maxVisited, false);
  const maxLinks = options.maxLinks ?? RELOCATE_DEFAULTS.maxLinks;
  const maxVisited = options.maxVisited ?? RELOCATE_DEFAULTS.maxVisited;

  const sRoot = prepareRoot(srcRoot, src);
  if ("ok" in sRoot) return sRoot;
  const sLex = lexicalIn(sRoot, src);
  if ("ok" in sLex) return sLex;
  if (sLex.abs === sLex.base) {
    return fail(
      "invalid-path",
      src,
      `${quote(src)} names the workspace root, which cannot be moved`,
    );
  }
  let srcTop: string;
  try {
    srcTop = path.join(
      physicalPath(path.dirname(sLex.abs), { known: sLex.known }),
      path.basename(sLex.abs),
    );
  } catch (err) {
    return unresolvable(src, err);
  }
  if (!isWithin(sRoot.physical, srcTop)) return escapes(src);
  let top: Stats;
  try {
    top = lstatSync(srcTop);
  } catch (err) {
    return fromErrno(src, err, "moved");
  }

  const dRoot = prepareRoot(dstRoot, dst);
  if ("ok" in dRoot) return dRoot;
  const dLex = lexicalIn(dRoot, dst);
  if ("ok" in dLex) return dLex;
  if (dLex.abs === dLex.base) {
    return fail(
      "invalid-path",
      dst,
      `${quote(dst)} names the workspace root; move to a path below it`,
    );
  }
  let dstTop: string;
  try {
    dstTop = path.join(
      physicalPath(path.dirname(dLex.abs), { known: dLex.known }),
      path.basename(dLex.abs),
    );
  } catch (err) {
    return unresolvable(dst, err);
  }
  if (!isWithin(dRoot.physical, dstTop)) return escapes(dst, "its directory");
  if (isWithin(srcTop, dstTop)) {
    return fail(
      "overlaps-source",
      dst,
      `${quote(dst)} is inside ${quote(src)}; a tree cannot be moved into itself`,
    );
  }

  const overlay = movedTree(srcTop, dstTop);
  const srcRel = toPosix(path.relative(sLex.base, sLex.abs));
  const dstRel = toPosix(path.relative(dLex.base, dLex.abs));
  const join = (a: string, b: string): string => (b === "" ? a : a === "" ? b : `${a}/${b}`);
  let links = 0;
  let visited = 0;

  const judge = (rel: string, srcReal: string): SafeFsFailure | undefined => {
    links += 1;
    if (links > maxLinks) {
      return fail(
        "too-large",
        src,
        `${quote(src)} holds more than ${maxLinks} links; they were not all checked`,
      );
    }
    let text: string;
    try {
      text = readlinkSync(srcReal);
    } catch (err) {
      return fromErrno(join(srcRel, rel), err, "read");
    }
    const placed = rel === "" ? dstTop : path.join(dstTop, ...rel.split("/"));
    let target: string;
    try {
      target = physicalFrom(path.dirname(placed), text, { overlay });
    } catch (err) {
      return unresolvable(join(srcRel, rel), err);
    }
    if (isWithin(dRoot.physical, target)) return undefined;
    const at = join(srcRel, rel);
    return fail(
      "escapes-root",
      at,
      `${quote(at)} is a symbolic link that would lead outside the workspace once moved to ${quote(join(dstRel, rel))}`,
    );
  };

  if (top.isSymbolicLink()) {
    const refused = judge("", srcTop);
    return refused ?? { ok: true, links, visited };
  }
  if (!top.isDirectory()) return { ok: true, links, visited };

  const stack: Array<{ real: string; rel: string; stats: Stats }> = [
    { real: srcTop, rel: "", stats: top },
  ];
  while (stack.length > 0) {
    const dir = stack.pop() as { real: string; rel: string; stats: Stats };
    let entries: Dirent[];
    try {
      entries = readdirSync(dir.real, { withFileTypes: true });
      // The directory listed must be the one checked, not a link swapped in.
      const after = lstatSync(dir.real);
      if (!after.isDirectory() || after.dev !== dir.stats.dev || after.ino !== dir.stats.ino) {
        const at = join(srcRel, dir.rel);
        return fail("changed", at, `${quote(at)} changed while it was being checked`);
      }
    } catch (err) {
      return fromErrno(join(srcRel, dir.rel), err, "listed");
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxVisited) {
        return fail(
          "too-large",
          src,
          `${quote(src)} has more than ${maxVisited} entries; its links were not all checked`,
        );
      }
      const rel = join(dir.rel, entry.name);
      const real = path.join(dir.real, entry.name);
      if (entry.isSymbolicLink()) {
        const refused = judge(rel, real);
        if (refused !== undefined) return refused;
      } else if (entry.isDirectory()) {
        let stats: Stats;
        try {
          stats = lstatSync(real);
        } catch (err) {
          return fromErrno(join(srcRel, rel), err, "listed");
        }
        if (stats.isDirectory()) stack.push({ real, rel, stats });
        else if (stats.isSymbolicLink()) {
          // Swapped for a link since the listing: judged as one.
          const refused = judge(rel, real);
          if (refused !== undefined) return refused;
        }
      }
    }
  }
  return { ok: true, links, visited };
}
