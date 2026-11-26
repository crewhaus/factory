/**
 * Synthesized package.json for emitted LOCAL bundles, written beside the
 * bundle by the compile path (compile-check pulls in the whole smoke-harness
 * and stays a lazy `--check`-only import).
 *
 * A local bundle's emitted entrypoint carries bare `@crewhaus/*` imports and
 * nothing that declares them, so outside a checkout that already has the
 * runtime packages installed (factory/demos), `bun agent.ts` dies on the
 * first import (`Cannot find module '@crewhaus/…'`). The manifest written
 * here is what makes the documented standalone flow — `crewhaus compile
 * <spec> -o dist && cd dist && bun install && bun agent.ts` — actually
 * resolve: every `@crewhaus/*` package the bundle imports, pinned to this
 * CLI's own version. `compile --check` verified against exactly this
 * manifest already; now the compile itself ships it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_MANIFEST_NAME,
  BUNDLE_STAMP_KEY,
  type BundleSpecStamp,
  buildBundlePackageJson,
  collectCrewhausDeps,
  hashSpecSource,
} from "@crewhaus/compile-service";
import type { Bundle } from "@crewhaus/ir";
import { probeBundleFile, writeBundleFile } from "./bundle-writer";
import { cliVersion } from "./version";

// The pure half (the manifest text, the stamp, the dependency list) lives in
// `@crewhaus/compile-service`, which checks and compiles a draft without
// writing; it is re-exported here so every existing import keeps working.
export {
  BUNDLE_MANIFEST_NAME,
  BUNDLE_STAMP_KEY,
  type BundleSpecStamp,
  buildBundlePackageJson,
  collectCrewhausDeps,
  hashSpecSource,
};

export type ManifestAction =
  /** Synthesized (or refreshed our own) manifest at `path`. */
  | "wrote"
  /** A package.json this synthesizer did not write exists at `path` — left
   * untouched. NOTE: this includes a cf-worker-flavour manifest from an
   * earlier `--emit-as cf-worker` compile into the same out-dir (those are
   * named after the spec, not BUNDLE_MANIFEST_NAME) — the caller's message
   * must not claim the kept file is foreign, only that the pinned manifest
   * was not written over it. */
  | "kept"
  /** The bundle ships its own package.json (cf-worker flavour) — nothing to add. */
  | "skipped";

export type ManifestResult = { readonly path: string; readonly action: ManifestAction };

/**
 * Ensure the emitted bundle dir carries a dependency manifest. Writes the
 * synthesized pin-to-CLI-version package.json UNLESS the bundle itself ships
 * one (the cf-worker emitters do) or a user-authored one is already on disk
 * (any parse failure or foreign `name` counts as user-authored — when in
 * doubt, never clobber). A manifest with our BUNDLE_MANIFEST_NAME is ours
 * from a previous compile and refreshes like any other bundle file. An
 * empty-deps bundle still gets a manifest: it anchors `bun install` to the
 * out-dir so Bun cannot walk up and resolve against an ancestor project.
 */
export function ensureBundleManifest(
  files: Bundle["files"],
  outDir: string,
  opts: { readonly specYaml?: string } = {},
): ManifestResult {
  const path = join(outDir, "package.json");
  if (files.some((f) => f.path === "package.json")) return { path, action: "skipped" };
  // A link (or any other non-regular file) at the name is never read: it is replaced.
  const existing = probeBundleFile(outDir, "package.json");
  if (existing.kind === "file") {
    let ours = false;
    try {
      const parsed: unknown = JSON.parse(existing.text);
      ours =
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { name?: unknown }).name === BUNDLE_MANIFEST_NAME;
    } catch {
      ours = false;
    }
    if (!ours) return { path, action: "kept" };
  }
  const version = cliVersion();
  // Without a spec source, CARRY FORWARD any stamp already on disk. The
  // compile path writes the stamped manifest and `--check` re-ensures it
  // moments later with no spec in hand; dropping the stamp there would leave
  // every `compile --check` bundle looking pre-F-5 to a manager.
  const stamp: BundleSpecStamp | undefined =
    opts.specYaml !== undefined
      ? {
          specHash: hashSpecSource(opts.specYaml),
          ...(version !== undefined ? { compiledWith: version } : {}),
        }
      : readBundleSpecStamp(outDir);
  writeBundleFile(
    outDir,
    "package.json",
    buildBundlePackageJson(collectCrewhausDeps(files), version, stamp),
  );
  return { path, action: "wrote" };
}

/**
 * Read the provenance stamp back out of an emitted bundle dir. Returns
 * undefined for a missing/unparseable manifest, a manifest this synthesizer
 * did not write (a user-authored one, or a cf-worker emitter's), or one from a
 * pre-F-5 compile — all of which mean "no exact answer available", never "the
 * bundle is stale".
 */
export function readBundleSpecStamp(outDir: string): BundleSpecStamp | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(outDir, "package.json"), "utf-8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const manifest = parsed as Record<string, unknown>;
  if (manifest["name"] !== BUNDLE_MANIFEST_NAME) return undefined;
  const raw = manifest[BUNDLE_STAMP_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const stampish = raw as { specHash?: unknown; compiledWith?: unknown };
  if (typeof stampish.specHash !== "string") return undefined;
  return {
    specHash: stampish.specHash,
    ...(typeof stampish.compiledWith === "string" ? { compiledWith: stampish.compiledWith } : {}),
  };
}

/**
 * Exact bundle-freshness verdict, or an honest admission that no exact answer
 * exists.
 *
 * `"unstamped"` is its own outcome on purpose: a bundle compiled by an older
 * crewhaus carries no hash, and reporting that as `"stale"` would nag every
 * operator who has not recompiled since upgrading. Callers should fall back to
 * the approximate mtime heuristic there and LABEL it approximate — the caller
 * that gates a daemon spawn needs to know which of the two answers it got.
 */
export type BundleSpecFreshness =
  | { readonly state: "fresh"; readonly specHash: string; readonly compiledWith?: string }
  | {
      readonly state: "stale";
      readonly specHash: string;
      readonly bundleSpecHash: string;
      readonly compiledWith?: string;
    }
  | { readonly state: "unstamped" };

export function compareBundleSpecHash(args: {
  readonly specYaml: string;
  readonly outDir: string;
}): BundleSpecFreshness {
  const stamp = readBundleSpecStamp(args.outDir);
  if (stamp === undefined) return { state: "unstamped" };
  const specHash = hashSpecSource(args.specYaml);
  const compiledWith = stamp.compiledWith !== undefined ? { compiledWith: stamp.compiledWith } : {};
  return stamp.specHash === specHash
    ? { state: "fresh", specHash, ...compiledWith }
    : { state: "stale", specHash, bundleSpecHash: stamp.specHash, ...compiledWith };
}
