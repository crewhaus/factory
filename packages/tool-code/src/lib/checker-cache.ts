/**
 * Where a checker's incremental cache goes: outside the project (C150).
 *
 * `tsc --noEmit` still writes `.tsbuildinfo` for an incremental or composite
 * project — next to the tsconfig, into a `dist/` it creates, or to wherever a
 * committed `tsBuildInfoFile` points, which can be a file OUTSIDE the
 * workspace that Typecheck, run unasked in auto mode, would overwrite. So
 * Typecheck and Diagnostics pass tsc `--incremental --tsBuildInfoFile` with a
 * file here (the command line overrides the tsconfig), keyed by the project,
 * so a repeat run stays incremental and nothing lands in the project.
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

/** The build-info file tsc uses for the project whose config is `tsconfigAbs`. */
export function typecheckBuildInfoFile(tsconfigAbs: string): string {
  let key = tsconfigAbs;
  try {
    key = realpathSync(tsconfigAbs);
  } catch {
    // The lexical path still identifies the project.
  }
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(privateDir(), `${hash}.tsbuildinfo`);
}

/** True for a path `typecheckBuildInfoFile` handed out. */
export function isCheckerCachePath(arg: string): boolean {
  return arg.endsWith(".tsbuildinfo") && path.basename(path.dirname(arg)).startsWith(PREFIX);
}
