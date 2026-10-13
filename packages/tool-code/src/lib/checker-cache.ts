/**
 * Where a checker's incremental cache goes: outside the project (C150).
 *
 * `tsc --noEmit` still writes `.tsbuildinfo` for an incremental or composite
 * project — next to the tsconfig, into a `dist/` it creates, or to wherever a
 * committed `tsBuildInfoFile` points, which can be a file OUTSIDE the
 * workspace that Typecheck, run unasked in auto mode, would overwrite. So
 * Typecheck and Diagnostics pass tsc `--incremental --tsBuildInfoFile` with a
 * file here (the command line overrides the tsconfig), keyed by the project,
 * so a repeat run stays incremental and nothing lands in the project. mypy
 * gets `--cache-dir=` a directory here, keyed the same way, for the same
 * reason (its config's `cache_dir` can point anywhere too).
 *
 * The directory is per user, mode 0700, and must be a real directory this
 * user owns: in a shared /tmp another user could otherwise plant a link at
 * the name. When it is not, each call gets a fresh private directory from
 * mkdtemp instead (a cold cache, never a borrowed one).
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const PREFIX = "crewhaus-checker-cache-";

/** How the cache path is shown in a result: stable across machines. */
export const CHECKER_CACHE_PLACEHOLDER = "<tmp>/crewhaus-typecheck.tsbuildinfo";
/** How mypy's cache directory is shown in a result. */
export const MYPY_CACHE_PLACEHOLDER = "<tmp>/crewhaus-mypy-cache";

function userTag(): string {
  return typeof process.getuid === "function" ? String(process.getuid()) : "user";
}

function privateDir(): string {
  const base = path.join(tmpdir(), `${PREFIX}${userTag()}`);
  try {
    mkdirSync(base, { mode: 0o700 });
  } catch {
    // Already there, or not creatable: judged below.
  }
  try {
    const st = lstatSync(base);
    const owned = typeof process.getuid !== "function" || st.uid === process.getuid();
    const privateMode = typeof process.getuid !== "function" || (st.mode & 0o077) === 0;
    if (st.isDirectory() && !st.isSymbolicLink() && owned && privateMode) return base;
  } catch {
    // Fall through to a fresh one.
  }
  return mkdtempSync(path.join(tmpdir(), PREFIX));
}

/** A short, stable key for a project path: its real path, hashed. */
function projectKey(abs: string): string {
  let key = abs;
  try {
    key = realpathSync(abs);
  } catch {
    // The lexical path still identifies the project.
  }
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** The build-info file tsc uses for the project whose config is `tsconfigAbs`. */
export function typecheckBuildInfoFile(tsconfigAbs: string): string {
  return path.join(privateDir(), `${projectKey(tsconfigAbs)}.tsbuildinfo`);
}

/**
 * The cache directory mypy uses for the project at `projectDirAbs`: kept
 * between runs, so a repeat check is incremental as it was on 0.7.0 with the
 * project's own `.mypy_cache`, but outside the project. mypy creates it.
 */
export function mypyCacheDir(projectDirAbs: string): string {
  return path.join(privateDir(), `${projectKey(projectDirAbs)}.mypy`);
}

/** True for a path `typecheckBuildInfoFile` handed out. */
export function isCheckerCachePath(arg: string): boolean {
  return arg.endsWith(".tsbuildinfo") && path.basename(path.dirname(arg)).startsWith(PREFIX);
}

/** A `--cache-dir=` argument `mypyCacheDir` handed out, shown machine-free, or undefined. */
export function displayMypyCacheArg(arg: string): string | undefined {
  const flag = "--cache-dir=";
  if (!arg.startsWith(flag)) return undefined;
  const dir = arg.slice(flag.length);
  return dir.endsWith(".mypy") && path.basename(path.dirname(dir)).startsWith(PREFIX)
    ? `${flag}${MYPY_CACHE_PLACEHOLDER}`
    : undefined;
}
