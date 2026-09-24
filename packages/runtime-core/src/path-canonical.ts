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
 * written relative to the workspace. When the last component is itself a
 * symlink, its target is a second value. A path that ends up outside the
 * workspace, or whose destination cannot be worked out, is flagged; the
 * matcher never lets it satisfy an allow rule and always lets it satisfy a
 * deny or ask.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
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

/**
 * The value(s) `raw` names inside the workspace at `root`. Parent
 * directories are followed through symlinks — `build/link/app.ts` with
 * `build/link → ../src` IS `src/app.ts` for every tool. The last component is
 * kept as written, because a tool that replaces or deletes it acts on the link
 * itself; but when that last component is a symlink, a tool that opens it acts
 * on the target instead, so the target is a second value. An allow then has to
 * cover both, and a deny fires on either.
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
  const located = (real: string): OperativeValue => {
    const rel = path.relative(rootReal, real);
    if (climbsOut(rel)) return outside;
    const relPosix = rel === "" ? "." : toPosix(rel);
    return {
      kind: "path",
      canonical:
        relPosix === "." ? [".", toPosix(real)] : [relPosix, `./${relPosix}`, toPosix(real)],
      spellings,
    };
  };
  if (climbsOut(lexicalRel)) return [outside];
  let at: string;
  try {
    at =
      lexicalAbs === rootAbs
        ? rootReal
        : path.join(resolveLocation(path.dirname(lexicalAbs)), path.basename(lexicalAbs));
  } catch {
    // Where it lands cannot be worked out: an allow must not guess.
    return [outside];
  }
  const values = [located(at)];
  if (isSymlink(at)) {
    let target: string;
    try {
      target = resolveLocation(at);
    } catch {
      return [...values, outside];
    }
    if (target !== at) values.push(located(target));
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
