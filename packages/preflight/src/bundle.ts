/**
 * Bundle freshness: is the compiled bundle (`dist/`) at least as new as
 * `crewhaus.yaml`?
 *
 * Today this is an MTIME HEURISTIC and is labelled approximate — mtimes lie
 * across `git checkout`, file copies, and clock skew. The seam is the
 * {@link FreshnessComparator} type: when the compiled bundle manifest
 * records a spec hash, drop in a comparator that hashes `crewhaus.yaml`
 * and compares it to the manifest instead, and every caller of
 * `runPreflight({ freshness })` gets exact answers without an API change.
 *
 * Freshness findings are WARN, never blocking: a stale bundle runs — it
 * just runs yesterday's spec — and start flows are expected to offer
 * compile-if-stale rather than refuse.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PreflightItem } from "./types";

export type BundleFreshness = {
  /**
   * `unreadable`: `crewhaus.yaml` or something under `dist/` exists but could
   * not be examined (a permission error, an I/O error), so whether the bundle
   * is current is UNKNOWN — see `reason`. It is never reported as
   * `missing-bundle`: "I could not look" is not "there is nothing there", and
   * the remedy is not a recompile.
   */
  readonly state: "missing-spec" | "missing-bundle" | "stale" | "fresh" | "unreadable";
  readonly specMtimeMs?: number;
  readonly bundleMtimeMs?: number;
  /** `unreadable` only: the errno and the harness-relative path that failed. */
  readonly reason?: string;
};

/** The comparator seam. `runPreflight` defaults to the mtime heuristic;
 *  swap in a spec-hash comparator once bundles record one. */
export type FreshnessComparator = (
  harnessDir: string,
) => BundleFreshness | Promise<BundleFreshness>;

type Newest =
  /** `dist/` is not there (or is not a directory). */
  | { readonly kind: "absent" }
  /** Something under `dist/` could not be read: the answer is unknown. */
  | { readonly kind: "unreadable"; readonly reason: string }
  /** Walked in full; `newest` is undefined for a `dist/` holding no file. */
  | { readonly kind: "walked"; readonly newest?: number };

/** The errno, never the message: node puts the absolute path in it. */
function errnoOf(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? "an unidentified error";
}

/**
 * The newest mtime under `dir`. `rel` is the same path relative to the
 * harness directory, for the reason.
 *
 * Only ENOENT is a skip, and only where it means a raced deletion (an entry
 * listed and gone before it was examined). Any other failure — EACCES on a
 * subdirectory, EIO on a file — ends the walk as `unreadable`: skipping it
 * could hide the one file newer than the spec and turn `stale` into `fresh`.
 */
function newestMtimeMs(dir: string, rel: string, top: boolean): Newest {
  let newest: number | undefined;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = errnoOf(err);
    if (top && (code === "ENOENT" || code === "ENOTDIR")) return { kind: "absent" };
    if (!top && code === "ENOENT") return { kind: "walked" };
    return { kind: "unreadable", reason: `${code} listing ${rel}/` };
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const entryRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      const sub = newestMtimeMs(path, entryRel, false);
      if (sub.kind === "unreadable") return sub;
      if (sub.kind === "walked" && sub.newest !== undefined) {
        if (newest === undefined || sub.newest > newest) newest = sub.newest;
      }
      continue;
    }
    try {
      const mtime = statSync(path).mtimeMs;
      if (newest === undefined || mtime > newest) newest = mtime;
    } catch (err) {
      const code = errnoOf(err);
      if (code === "ENOENT") continue; // raced deletion (or a link to nothing)
      return { kind: "unreadable", reason: `${code} examining ${entryRel}` };
    }
  }
  return newest === undefined ? { kind: "walked" } : { kind: "walked", newest };
}

/** The default comparator: `crewhaus.yaml` mtime vs the newest file under
 *  `dist/`, both relative to `harnessDir`. */
export function compareBundleFreshnessByMtime(harnessDir: string): BundleFreshness {
  let specMtimeMs: number;
  try {
    specMtimeMs = statSync(join(harnessDir, "crewhaus.yaml")).mtimeMs;
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing-spec" };
    return { state: "unreadable", reason: `${code} examining crewhaus.yaml` };
  }
  const walk = newestMtimeMs(join(harnessDir, "dist"), "dist", true);
  if (walk.kind === "unreadable") return { state: "unreadable", reason: walk.reason, specMtimeMs };
  if (walk.kind === "absent" || walk.newest === undefined) {
    return { state: "missing-bundle", specMtimeMs };
  }
  const bundleMtimeMs = walk.newest;
  return {
    state: specMtimeMs > bundleMtimeMs ? "stale" : "fresh",
    specMtimeMs,
    bundleMtimeMs,
  };
}

/** Render a freshness result as a report item. `missing-spec` returns
 *  undefined — the spec area already reports an unreadable spec. */
export function bundleFreshnessItem(freshness: BundleFreshness): PreflightItem | undefined {
  switch (freshness.state) {
    case "missing-spec":
      return undefined;
    case "missing-bundle":
      return {
        id: "bundle.missing",
        area: "bundle",
        level: "warn",
        message:
          "no compiled bundle found (no dist/ output) — compile before spawning a daemon; start flows should offer compile-now instead of failing",
        remediation: "run `crewhaus compile crewhaus.yaml`",
      };
    case "stale":
      return {
        id: "bundle.stale",
        area: "bundle",
        level: "warn",
        message:
          "crewhaus.yaml is newer than the newest dist/ artifact (approximate mtime heuristic) — the compiled bundle may be running an older spec",
        remediation: "recompile: `crewhaus compile crewhaus.yaml`",
      };
    case "unreadable":
      return {
        id: "bundle.unreadable",
        area: "bundle",
        level: "warn",
        message: `could not determine whether the compiled bundle is current: ${freshness.reason ?? "a file could not be examined"}`,
        remediation: "check the permissions on dist/ and crewhaus.yaml",
      };
    case "fresh":
      return {
        id: "bundle.fresh",
        area: "bundle",
        level: "info",
        message:
          "compiled bundle is at least as new as crewhaus.yaml (approximate mtime heuristic)",
      };
  }
}
