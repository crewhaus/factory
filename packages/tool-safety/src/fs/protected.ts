/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 1, §5.2) — the
 * runtime-state roots a run hands its tools on the bridge
 * (`RuntimeBridge.protectedRoots`, runtime-core's `runtimeStateRoots`): the
 * session logs, the spilled tool results and the proof bundles, which the
 * provability gate and `continuity.proof` read as evidence. Evidence is
 * checked only while the agent cannot write it.
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
 * neither hides a root nor invents one.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/** Is `inner` `outer` or inside it (both absolute)? */
function within(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
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
        if (rel === undefined && within(r, d)) rel = relative(d, r);
      }
    }
    if (rel !== undefined) out.push({ root, rel });
  }
  return out;
}

/** The refusal a tool returns for a write into a protected root. */
export function protectedWriteRefusal(tool: string, what: string): string {
  return `${tool}: refused — ${what} would write where the runtime keeps its own record of the run (session logs, spilled tool results, proof bundles), which no tool may change. Nothing was written.`;
}
