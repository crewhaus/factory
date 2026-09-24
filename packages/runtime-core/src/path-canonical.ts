/**
 * Where a path-kind operative value really lands, for the permission gate.
 *
 * The matcher (`@crewhaus/tool-permission-matcher`) and the subject builder
 * (`preparePermissionSubject` in `@crewhaus/tool-executor`) are pure — the
 * worker runtime runs them on a Cloudflare Worker, where there is no
 * filesystem to ask. Following symlinks needs one, so it lives here, in the
 * Node runtime that owns the workspace, and is handed to the subject builder
 * as its `canonicalizePath`.
 *
 * A path is resolved against the workspace root, `..` collapsed, and its
 * directories followed through symlinks (the deepest one that exists is
 * realpath'd) — so it names the place the tool will actually touch — then
 * written relative to the workspace. When the last component exists, it is
 * written the way the directory stores it: on a filesystem that ignores case
 * or Unicode normal form (macOS, Windows), `.ENV` opens `.env`, and a rule
 * about `.env` must see that. When the last component is itself a symlink,
 * its target is a second value. A path that ends up outside the workspace,
 * or whose destination cannot be worked out, is flagged; the matcher never
 * lets it satisfy an allow rule and always lets it satisfy a deny or ask.
 * A path on a filesystem that ignores case (or where that cannot be told) is
 * marked `caseInsensitive`, so a deny or ask compares it ignoring case — the
 * name a tool is about to CREATE has no stored spelling to read.
 */
import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { PathCanonicalizer } from "@crewhaus/tool-executor";

type OperativeValue = ReturnType<PathCanonicalizer>[number];

function toPosix(p: string): string {
  return path.sep === "\\" ? p.split(path.sep).join("/") : p;
}

/** A relative path that leaves its base: `..`, `../x`, or another drive. */
function climbsOut(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** True when the NAME exists, whether or not a symlink there leads anywhere. */
function nameExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Where `target` would land with every symlink on the way followed — the
 * deepest ancestor that exists is resolved, a dangling link is followed a hop
 * by hand (a missing target is still a door), and the parts that do not exist
 * yet are appended. Mirrors `resolveLocation` in `@crewhaus/tool-fs`, which is
 * what the file tools check containment against. Throws when the chain
 * cannot be resolved; the caller treats that as "cannot tell where it lands".
 */
function resolveLocation(target: string, depth = 0): string {
  if (depth > 40) throw new Error(`symlink chain at "${target}" is too long to resolve`);
  let probe = target;
  const tail: string[] = [];
  while (!nameExists(probe)) {
    tail.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const link = readlinkSync(probe);
    real = resolveLocation(path.resolve(realpathSync(path.dirname(probe)), link), depth + 1);
  }
  return tail.length > 0 ? path.join(real, ...tail) : real;
}

/** Two paths that are the same directory entry: same device, same inode. */
function sameEntry(a: string, b: string): boolean {
  try {
    const x = lstatSync(a);
    const y = lstatSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** Case and Unicode normal form folded away — how a folding filesystem compares names. */
function foldName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * How the directory `dir` stores the existing entry the caller named `name`:
 * `[name]` when that is an entry as spelled, otherwise the entry (or, for a
 * name with several hard links there, the entries) the filesystem resolved it
 * to — `.env` for `.ENV` on a case-insensitive volume. `undefined` when the
 * directory cannot be listed or no entry is that file: the caller cannot tell
 * which name a rule should see.
 */
function storedNames(dir: string, name: string): string[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  if (entries.includes(name)) return [name];
  const at = path.join(dir, name);
  // A folding filesystem resolves `name` to an entry that folds the same way;
  // look at those first, and at every entry only if its folding is not ours.
  const folded = foldName(name);
  const likely = entries.filter((e) => foldName(e) === folded && sameEntry(path.join(dir, e), at));
  if (likely.length > 0) return likely;
  const any = entries.filter((e) => sameEntry(path.join(dir, e), at));
  return any.length > 0 ? any : undefined;
}

/**
 * Does the filesystem at `dir` treat names that differ only in letter case as
 * the same? Asked of the nearest existing directory whose own name has a
 * letter: its name with the case swapped either finds the same directory
 * (yes) or nothing (no). `undefined` when no such directory answers.
 */
function ignoresCase(dir: string): boolean | undefined {
  let probe = dir;
  for (;;) {
    const base = path.basename(probe);
    const swapped = [...base]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join("");
    if (swapped !== base && nameExists(probe)) {
      const other = path.join(path.dirname(probe), swapped);
      if (!nameExists(other)) return false;
      return sameEntry(probe, other);
    }
    const parent = path.dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
}

/**
 * The value(s) `raw` names inside the workspace at `root`. Parent
 * directories are followed through symlinks — `build/link/app.ts` with
 * `build/link → ../src` IS `src/app.ts` for every tool. The last component is
 * not followed, because a tool that replaces or deletes it acts on the link
 * itself; but it is written the way its directory stores it when it exists
 * (`.ENV` is `.env` on macOS), and when it is a symlink, a tool that opens it
 * acts on the target instead, so the target is a second value. An allow then
 * has to cover both, and a deny fires on either. The name as written stays a
 * spelling a deny also fires on.
 */
export function canonicalWorkspacePath(raw: string, root: string): OperativeValue[] {
  const rootAbs = path.resolve(root);
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    rootReal = rootAbs;
  }
  // Lexical: `..` collapsed, symlinks untouched.
  const lexicalAbs = path.resolve(rootAbs, raw);
  const lexicalRel = path.relative(rootAbs, lexicalAbs);
  const spellings = [raw, toPosix(lexicalRel === "" ? "." : lexicalRel), toPosix(lexicalAbs)];
  const outside: OperativeValue = {
    kind: "path",
    canonical: [],
    spellings,
    outsideWorkspace: true,
  };
  let caseInsensitive = true;
  const located = (real: string): OperativeValue => {
    const rel = path.relative(rootReal, real);
    if (climbsOut(rel)) return outside;
    const relPosix = rel === "" ? "." : toPosix(rel);
    return {
      kind: "path",
      canonical:
        relPosix === "." ? [".", toPosix(real)] : [relPosix, `./${relPosix}`, toPosix(real)],
      spellings,
      ...(caseInsensitive ? { caseInsensitive: true } : {}),
    };
  };
  if (climbsOut(lexicalRel)) return [outside];
  if (lexicalAbs === rootAbs) {
    caseInsensitive = ignoresCase(rootReal) !== false;
    return [located(rootReal)];
  }
  let parent: string;
  try {
    parent = resolveLocation(path.dirname(lexicalAbs));
  } catch {
    // Where it lands cannot be worked out: an allow must not guess.
    return [outside];
  }
  // Unknown counts as "ignores case": that only widens what a deny or an ask
  // catches, never what an allow grants.
  caseInsensitive = ignoresCase(parent) !== false;
  const leaf = path.basename(lexicalAbs);
  let names = [leaf];
  if (nameExists(path.join(parent, leaf))) {
    // It exists, so the tool will open the entry the filesystem resolves the
    // name to — which, on a filesystem that folds case or Unicode form, may
    // be stored under another spelling. A rule sees that spelling.
    const stored = storedNames(parent, leaf);
    if (stored === undefined) return [outside];
    names = stored;
  }
  const values: OperativeValue[] = [];
  for (const name of names) {
    const at = path.join(parent, name);
    values.push(located(at));
    if (isSymlink(at)) {
      let target: string;
      try {
        target = resolveLocation(at);
      } catch {
        values.push(outside);
        continue;
      }
      if (target !== at) values.push(located(target));
    }
  }
  return values;
}

/**
 * The canonicaliser the permission gate hands `preparePermissionSubject`:
 * paths resolved against `root` — by default the current working directory,
 * which is the root every workspace tool resolves against at call time.
 */
export function workspacePathCanonicalizer(root: string = process.cwd()): PathCanonicalizer {
  return (raw) => canonicalWorkspacePath(raw, root);
}
