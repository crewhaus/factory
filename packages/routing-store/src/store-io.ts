/**
 * 0.7.1 — every routing-store write goes through @crewhaus/tool-safety/fs,
 * rooted at the store's own directory (`<rootDir>`, usually `.crewhaus`).
 *
 * The rewrites (`compact()`, `promoteLanes()`, `freezeRoutes()`) used to write
 * the fixed name `<file>.tmp` with link following and rename it into place,
 * and the observation appends followed a link at `arms.jsonl`. A model that
 * could plant a symlink under `.crewhaus/routing/` (GitApplyPatch creates one
 * from a patch) had the runtime write the scoreboard to a file of its choosing.
 * Now a rewrite uses a random O_EXCL|O_NOFOLLOW temp and refuses a link or
 * special file at the name, and an append refuses one too.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendContained, writeFileSafe } from "@crewhaus/tool-safety/fs";

/** A store write tool-safety refused, naming the store file and the reason. */
export class RoutingStoreWriteError extends Error {
  override readonly name = "RoutingStoreWriteError";
}

/** The store's directories are owner-only, as they were before 0.7.1. */
function ensureParent(rootDir: string, rel: string): void {
  mkdirSync(join(rootDir, dirname(rel)), { recursive: true, mode: 0o700 });
}

/** Atomically replace `<rootDir>/<rel>` (mode 0600 for a new file). */
export function writeStoreFile(rootDir: string, rel: string, data: string): void {
  ensureParent(rootDir, rel);
  const written = writeFileSafe(rootDir, rel, data, {
    overwrite: true,
    createParents: true,
    mode: 0o600,
  });
  if (!written.ok) {
    throw new RoutingStoreWriteError(
      `routing-store: refusing to write ${rel} under ${rootDir}: ${written.reason} (code ${written.code})`,
    );
  }
}

/** Append one line to `<rootDir>/<rel>` in place (mode 0600 for a new file). */
export function appendStoreFile(rootDir: string, rel: string, data: string): void {
  ensureParent(rootDir, rel);
  const appended = appendContained(rootDir, rel, data, { createParents: true, mode: 0o600 });
  if (!appended.ok) {
    throw new RoutingStoreWriteError(
      `routing-store: refusing to append to ${rel} under ${rootDir}: ${appended.reason} (code ${appended.code})`,
    );
  }
}
