/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 1, §5.2) — the
 * runtime-state roots a run hands its tools on the bridge
 * (`RuntimeBridge.protectedRoots`, runtime-core's `runtimeStateRoots`): the
 * session logs, the spilled tool results and the proof bundles, which the
 * provability gate and `continuity.proof` read as evidence, and the files
 * that control the run, which decide what the agent may do next — the
 * harness's run files (`.crewhaus/run`) and settings file
 * (`.crewhaus/settings.json`), and Hangar's directory. Evidence is checked only
 * while the agent cannot write it, and the files that control the run are not
 * its tools' to write. A root is a directory, holding everything under it, or
 * an exact file, holding only itself.
 *
 * permission-engine's runtime-state floor denies a call that NAMES a path
 * inside one. A tool that writes BENEATH a directory it names reaches past
 * that: a tree copied or moved onto `.crewhaus`, an archive whose top-level
 * `.crewhaus` replaces the workspace's, a patch whose file lies in the
 * session log directory, the workspace root removed. These let such a tool
 * refuse, before it writes, a write that would land in (or remove) one.
 *
 * Every root is given as the runtime spells it — absolute, absolute with
 * links followed, workspace-relative — and a path is compared as resolved
 * and with links followed as far as it exists, so a link on the way
 * neither hides a root nor invents one. Each name is compared by
 * {@link foldedName} on every volume: a tool is not told how the volume it
 * writes to compares names, and refusing a name that folds to a root's costs
 * nothing.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Code points HFS+ leaves out when it compares two names. */
const IGNORED_BY_HFS = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g;
const NOT_ASCII = /[\u0080-\uFFFF]/;

/**
 * One name as a filesystem that does not tell names apart compares it, so a
 * root is found under the spellings that open it, including a name that does
 * not exist yet (there is no stored spelling to read): Unicode normal form C,
 * the full case fold APFS uses (`ſ` is `s`, `ß` is `ss`, `ﬁ` is `fi`), without
 * the code points HFS+ ignores, the stream Windows reads after a `:` or the
 * dots and spaces it trims from a name's end. A name that is only dots and
 * spaces is kept as written, and so is one that would fold to nothing, `.` or
 * `..`: it is a name, and a path must not climb out of a root through it. This
 * only ever widens what the floor catches. One pass over the string: a name
 * can be model-written and long.
 */
export function foldedName(name: string): string {
  const stream = name.indexOf(":");
  const bare = stream > 0 ? name.slice(0, stream) : name;
  let end = bare.length;
  while (end > 0 && (bare[end - 1] === "." || bare[end - 1] === " ")) end--;
  const trimmed = end === 0 ? name : bare.slice(0, end);
  if (!NOT_ASCII.test(trimmed)) return trimmed.toLowerCase();
  const folded = trimmed
    .replace(IGNORED_BY_HFS, "")
    .normalize("NFC")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .replaceAll("\u03C2", "\u03C3")
    .normalize("NFC");
  return folded === "" || folded === "." || folded === ".." ? name : folded;
}

/** An absolute path with each name folded ({@link foldedName}); its root is kept as it is. */
function foldedPath(path: string): string {
  const { root } = parse(path);
  return `${root}${path.slice(root.length).split(sep).map(foldedName).join(sep)}`;
}

/** The roots on a tool call's bridge, or none when the run declares none. */
export function protectedRootsOf(ctx: unknown): readonly string[] {
  if (typeof ctx !== "object" || ctx === null) return [];
  const bridge = (ctx as { readonly bridge?: unknown }).bridge;
  if (typeof bridge !== "object" || bridge === null) return [];
  const roots = (bridge as { readonly protectedRoots?: unknown }).protectedRoots;
  return Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string" && root.trim() !== "")
    : [];
}

/** `path` with every link on its existing part followed; itself when nothing of it exists. */
function followed(path: string): string {
  const rest: string[] = [];
  let head = path;
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      const real = realpathSync(head);
      return rest.reduceRight((built, name) => join(built, name), real);
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      rest.push(basename(head));
      head = parent;
    }
  }
  return path;
}

/** Is `inner` `outer` or inside it (both absolute, each name compared by {@link foldedName})? */
function within(inner: string, outer: string): boolean {
  const rel = relative(foldedPath(outer), foldedPath(inner));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Each spelling of `path` compared: as resolved, and with its links followed. */
function spellings(path: string, cwd: string): string[] {
  const abs = resolve(cwd, path);
  const real = followed(abs);
  return real === abs ? [abs] : [abs, real];
}

/**
 * The protected root `path` lies in (or is), or `undefined`: a write there
 * writes the run's own record.
 */
export function protectedRootHolding(
  path: string,
  roots: readonly string[],
  cwd: string = process.cwd(),
): string | undefined {
  const mine = spellings(path, cwd);
  for (const root of roots) {
    const theirs = spellings(root, cwd);
    if (mine.some((p) => theirs.some((r) => within(p, r)))) return root;
  }
  return undefined;
}

/**
 * The protected root a link carries `path` into, or `undefined`. `landsAt` is
 * where the path resolves, which a caller's own resolver also knows for a link
 * whose target does not exist yet. A path named inside a root that stays in it
 * has come through no such link, however that root is itself reached: a tool
 * that keeps a store in a root by name goes on working where an operator has
 * linked the directory that holds it.
 */
export function protectedRootLinkedInto(
  path: string,
  landsAt: string,
  roots: readonly string[],
  cwd: string = process.cwd(),
): string | undefined {
  const named = resolve(cwd, path);
  for (const root of roots) {
    const abs = resolve(cwd, root);
    if (within(named, abs) && within(landsAt, followed(abs))) return undefined;
  }
  for (const root of roots) {
    if (spellings(root, cwd).some((r) => within(landsAt, r))) return root;
  }
  return undefined;
}

/**
 * The protected root that lies in `dir` (or is it), or `undefined`: what is
 * written beneath `dir` may land in it, and removing or replacing `dir`
 * removes it.
 */
export function protectedRootBeneath(
  dir: string,
  roots: readonly string[],
  cwd: string = process.cwd(),
): string | undefined {
  const mine = spellings(dir, cwd);
  for (const root of roots) {
    const theirs = spellings(root, cwd);
    if (mine.some((d) => theirs.some((r) => within(r, d)))) return root;
  }
  return undefined;
}

/**
 * Every protected root that lies in `dir` (or is it), each with its path
 * below `dir` (`""` for `dir` itself), measured between spellings that
 * agree — `dir` as resolved against a root as resolved, or both with links
 * followed — so a root reached only through a link is still placed.
 */
export function protectedRootsBeneath(
  dir: string,
  roots: readonly string[],
  cwd: string = process.cwd(),
): Array<{ readonly root: string; readonly rel: string }> {
  const mine = spellings(dir, cwd);
  const out: Array<{ readonly root: string; readonly rel: string }> = [];
  for (const root of roots) {
    const theirs = spellings(root, cwd);
    let rel: string | undefined;
    for (const d of mine) {
      for (const r of theirs) {
        if (rel === undefined && within(r, d)) {
          // The root's own names below `dir`, as `dir` may spell its part another way.
          const below = relative(foldedPath(d), foldedPath(r));
          rel = below === "" ? "" : r.split(sep).slice(-below.split(sep).length).join(sep);
        }
      }
    }
    if (rel !== undefined) out.push({ root, rel });
  }
  return out;
}

/** The refusal a tool returns for a write into a protected root. */
export function protectedWriteRefusal(tool: string, what: string): string {
  return `${tool}: refused — ${what} would write where the runtime keeps its own record of the run (session logs, spilled tool results, proof bundles) or the files that control it (the harness's run files and settings, Hangar's directory), which no tool may change. Nothing was written.`;
}
