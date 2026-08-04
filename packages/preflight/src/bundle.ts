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
  readonly state: "missing-spec" | "missing-bundle" | "stale" | "fresh";
  readonly specMtimeMs?: number;
  readonly bundleMtimeMs?: number;
};

/** The comparator seam. `runPreflight` defaults to the mtime heuristic;
 *  swap in a spec-hash comparator once bundles record one. */
export type FreshnessComparator = (
  harnessDir: string,
) => BundleFreshness | Promise<BundleFreshness>;

function newestMtimeMs(dir: string): number | undefined {
  let newest: number | undefined;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeMs(path);
      if (sub !== undefined && (newest === undefined || sub > newest)) newest = sub;
      continue;
    }
    try {
      const mtime = statSync(path).mtimeMs;
      if (newest === undefined || mtime > newest) newest = mtime;
    } catch {
      // Raced deletion — skip.
    }
  }
  return newest;
}

/** The default comparator: `crewhaus.yaml` mtime vs the newest file under
 *  `dist/`, both relative to `harnessDir`. */
export function compareBundleFreshnessByMtime(harnessDir: string): BundleFreshness {
  let specMtimeMs: number;
  try {
    specMtimeMs = statSync(join(harnessDir, "crewhaus.yaml")).mtimeMs;
  } catch {
    return { state: "missing-spec" };
  }
  const bundleMtimeMs = newestMtimeMs(join(harnessDir, "dist"));
  if (bundleMtimeMs === undefined) return { state: "missing-bundle", specMtimeMs };
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
