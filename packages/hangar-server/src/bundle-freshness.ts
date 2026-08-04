/**
 * "Is this bundle stale against crewhaus.yaml?" — answered EXACTLY when the
 * bundle carries a spec-hash stamp (F-5), and honestly approximated when it
 * does not.
 *
 * The stamp is written by the compile path (`apps/cli/src/bundle-manifest.ts`
 * — `BUNDLE_MANIFEST_NAME` / `BUNDLE_STAMP_KEY` / `hashSpecSource`), into the
 * synthesized `dist/package.json`. This module is the READER; the shapes are
 * mirrored rather than imported because a package cannot depend on the CLI
 * app, and `bundle-freshness.test.ts` pins the exact on-disk shape so a
 * change on either side fails a test rather than silently degrading every
 * fleet row to "unknown".
 *
 * Why `unstamped` is its own answer: a bundle compiled by an older crewhaus
 * carries no hash, and reporting that as STALE would nag every operator who
 * has not recompiled since upgrading. Those fall back to the mtime heuristic
 * — which is genuinely approximate (a `git checkout` rewrites mtimes, a copy
 * resets them, clock skew inverts them) — and the verdict says so, because a
 * caller gating a daemon spawn needs to know which of the two answers it got.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The `name` the compile stamps into manifests it owns. */
export const BUNDLE_MANIFEST_NAME = "crewhaus-compiled-bundle";

/** Key the provenance stamp lives under in the synthesized package.json. */
export const BUNDLE_STAMP_KEY = "crewhaus";

/**
 * Digest of a spec's SOURCE TEXT. Line endings are normalized (CRLF/CR → LF)
 * and a single trailing newline is ignored, so the same spec checked out on
 * Windows is not reported as changed. Nothing else is normalized: whitespace
 * inside a spec CAN change behavior (block scalars carry indentation into
 * `instructions`), so ignoring it would under-report real drift.
 */
export function hashSpecSource(specYaml: string): string {
  const normalized = specYaml.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

export type BundleFreshness = {
  /** `fresh`/`stale` are EXACT (hash-compared); `approximate-*` come from
   *  mtimes; `unknown` means neither answer was available. */
  readonly state:
    | "fresh"
    | "stale"
    | "approximate-fresh"
    | "approximate-stale"
    | "unstamped"
    | "unknown";
  /** True only for the two hash-compared verdicts. */
  readonly exact: boolean;
  /** One sentence, ready to render under a Start button. */
  readonly label: string;
  /** The crewhaus version whose emitters produced the bundle, when stamped. */
  readonly compiledWith?: string;
};

function readStamp(
  outDir: string,
): { readonly specHash: string; readonly compiledWith?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const manifest = parsed as Record<string, unknown>;
  if (manifest["name"] !== BUNDLE_MANIFEST_NAME) return undefined;
  const raw = manifest[BUNDLE_STAMP_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const stamp = raw as { specHash?: unknown; compiledWith?: unknown };
  if (typeof stamp.specHash !== "string") return undefined;
  return {
    specHash: stamp.specHash,
    ...(typeof stamp.compiledWith === "string" ? { compiledWith: stamp.compiledWith } : {}),
  };
}

function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Compare a compiled bundle against the spec that should have produced it.
 * `specPath` and `entryPath` are used only for the mtime fallback.
 */
export function bundleFreshness(args: {
  readonly specYaml: string;
  readonly specPath: string;
  readonly outDir: string;
  readonly entryPath: string;
}): BundleFreshness {
  const stamp = readStamp(args.outDir);
  if (stamp !== undefined) {
    const compiledWith =
      stamp.compiledWith !== undefined ? { compiledWith: stamp.compiledWith } : {};
    if (stamp.specHash === hashSpecSource(args.specYaml)) {
      return {
        state: "fresh",
        exact: true,
        label: "bundle matches crewhaus.yaml (spec-hash stamped)",
        ...compiledWith,
      };
    }
    return {
      state: "stale",
      exact: true,
      label: "bundle was compiled from a DIFFERENT crewhaus.yaml — recompile before starting",
      ...compiledWith,
    };
  }
  const specAt = mtimeMs(args.specPath);
  const entryAt = mtimeMs(args.entryPath);
  if (specAt === undefined || entryAt === undefined) {
    return {
      state: entryAt === undefined ? "unknown" : "unstamped",
      exact: false,
      label:
        entryAt === undefined
          ? "no compiled bundle found"
          : "bundle carries no spec-hash stamp (compiled by an older crewhaus) — recompile for an exact answer",
    };
  }
  return entryAt >= specAt
    ? {
        state: "approximate-fresh",
        exact: false,
        label: "bundle is newer than crewhaus.yaml (approximate — mtimes only, no spec-hash stamp)",
      }
    : {
        state: "approximate-stale",
        exact: false,
        label:
          "crewhaus.yaml is newer than the bundle (approximate — mtimes only, no spec-hash stamp)",
      };
}
