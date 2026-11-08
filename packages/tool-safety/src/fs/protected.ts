/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 1, §5.2) — the
 * runtime-state roots a run hands its tools on the bridge
 * (`RuntimeBridge.protectedRoots`, runtime-core's `runtimeStateRoots`): the
 * session logs, the spilled tool results and the proof bundles, which the
 * provability gate and `continuity.proof` read as evidence, and the files
 * that control the run, which decide what the agent may do next — the
 * harness's run files (`.crewhaus/run`), settings file
 * (`.crewhaus/settings.json`), gate records, environment files, compiled bundle
 * and dependencies, and Hangar's directory. Evidence is checked only while the agent cannot write it, and the
 * files that control the run are not its tools' to write. A root is a
 * directory, holding everything under it, or an exact file, holding only
 * itself.
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
 *
 * A repository's git directory is held by name, not by root: it may lie
 * anywhere in the workspace. {@link namesGitDirectory} reads a path's names,
 * and {@link landsInGitDirectory} also reads where its links lead.
 */
import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

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

/** One list of roots on a tool call's bridge, or none when the run declares none. */
function bridgeRoots(ctx: unknown, field: "protectedRoots" | "credentialRoots"): readonly string[] {
  if (typeof ctx !== "object" || ctx === null) return [];
  const bridge = (ctx as { readonly bridge?: unknown }).bridge;
  if (typeof bridge !== "object" || bridge === null) return [];
  const roots = (bridge as Readonly<Record<string, unknown>>)[field];
  return Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string" && root.trim() !== "")
    : [];
}

/** The roots on a tool call's bridge, or none when the run declares none. */
export function protectedRootsOf(ctx: unknown): readonly string[] {
  return bridgeRoots(ctx, "protectedRoots");
}

/** The credential roots on a tool call's bridge, or none when the run declares none. */
export function credentialRootsOf(ctx: unknown): readonly string[] {
  return bridgeRoots(ctx, "credentialRoots");
}

const CREDENTIAL_FILE_NAME = /^(?:\.env(?:\.(?!(?:example|sample|template)$)[^/\\]+)?|\.npmrc)$/i;

/** A file name that holds credentials wherever it sits: a dotenv file, an npm config. */
export function isCredentialFileName(name: string): boolean {
  return CREDENTIAL_FILE_NAME.test(name);
}

/** Is this name, as a volume that folds names reads it, one {@link isCredentialFileName} matches? */
function foldsToCredentialName(path: string): boolean {
  return isCredentialFileName(foldedName(basename(path)));
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
 * Whether `path` is a file a run keeps from its tools: by its last name, written
 * or where its links lead, or inside one of `held` (`credentialRootsOf`).
 */
export function isHeldFile(
  path: string,
  held: readonly string[],
  cwd: string = process.cwd(),
): boolean {
  const abs = resolve(cwd, path);
  return (
    foldsToCredentialName(abs) ||
    foldsToCredentialName(followed(abs)) ||
    protectedRootHolding(abs, held, cwd) !== undefined
  );
}

/**
 * For a tool reading the tree at `dir` without following a link: whether a file
 * at this path relative to `dir` is one a run keeps from its tools. Where `held`
 * stands against `dir` is worked out once, so the check costs no file system call
 * per file. No `held` holds nothing.
 */
export function heldInTree(
  dir: string,
  held: readonly string[],
  cwd: string = process.cwd(),
): (rel: string) => boolean {
  if (held.length === 0) return () => false;
  if (protectedRootHolding(dir, held, cwd) !== undefined) return () => true;
  const folded = (rel: string): string => normalize(rel).split(sep).map(foldedName).join(sep);
  const below = protectedRootsBeneath(dir, held, cwd).map(({ rel }) => folded(rel));
  return (rel) => {
    const key = folded(rel);
    return (
      foldsToCredentialName(key) || below.some((root) => key === root || key.startsWith(root + sep))
    );
  };
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

/**
 * `roots` without `store`'s own spellings, for a tool that keeps its store in a
 * root and adds to it through a format of its own: every other root still
 * holds. `store` keeps its place by name, and with the directories above it
 * followed, so an operator's link at `.crewhaus` changes nothing. A link at the
 * store itself leaves where it leads among the roots, so that link cannot make
 * another root the tool's store.
 */
export function rootsBesideStore(
  store: string,
  roots: readonly string[],
  cwd: string = process.cwd(),
): string[] {
  const named = resolve(cwd, store);
  const landsAt = join(followed(dirname(named)), basename(named));
  return roots.filter((root) => {
    const abs = resolve(cwd, root);
    return abs !== named && abs !== landsAt && followed(abs) !== landsAt;
  });
}

/**
 * Does `path` have a name git treats as its own directory? Each name is compared
 * by {@link foldedName} on every volume, so `.GIT`, `.git.`, `.git ` and
 * `.git::$INDEX_ALLOCATION` count, as does the short name `git~1`; `.gitignore`,
 * `.github` and `foo.git` do not. Give a workspace-relative path: a workspace
 * that itself sits under such a name is not inside a git directory of its own.
 */
export function namesGitDirectory(path: string): boolean {
  return path.split(/[\\/]/).some((name) => {
    const folded = foldedName(name);
    return folded === ".git" || folded === "git~1";
  });
}

/**
 * Does `path` lie under a name git treats as its own directory, read from the
 * workspace `cwd` both as resolved and with every link on its existing part
 * followed?
 */
export function landsInGitDirectory(path: string, cwd: string = process.cwd()): boolean {
  const root = resolve(cwd);
  const abs = resolve(root, path);
  return (
    namesGitDirectory(relative(root, abs)) ||
    namesGitDirectory(relative(followed(root), followed(abs)))
  );
}

/** The refusal a tool returns for a write into a repository's git directory. */
export function gitDirectoryWriteRefusal(tool: string, what: string): string {
  return `${tool}: refused — ${what} would write inside a repository's git directory, which belongs to git and to the person running it. Nothing was written.`;
}

/** The refusal a tool returns for a write into a protected root. */
export function protectedWriteRefusal(tool: string, what: string): string {
  return `${tool}: refused — ${what} would write where the runtime keeps its own record of the run (session logs, spilled tool results, proof bundles) or the files that control it (the harness's run files, settings, gate records, environment files, compiled bundle and dependencies, Hangar's directory), which no tool may change. Nothing was written.`;
}

/** The refusal a tool returns for an input that names a file a run keeps from its tools. */
export function heldFileRefusal(tool: string, what: string): string {
  return `${tool}: refused — ${what} names a credential file this run keeps from its tools. Nothing was written.`;
}
