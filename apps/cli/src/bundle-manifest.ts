/**
 * Synthesized package.json for emitted LOCAL bundles, in its own tiny module
 * so the compile path can import it statically (compile-check pulls in the
 * whole smoke-harness and stays a lazy `--check`-only import).
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bundle } from "@crewhaus/ir";
import { cliVersion } from "./version";

/** The `name` stamped into synthesized manifests — the "ours" marker that
 * lets a recompile refresh its own manifest while never clobbering a
 * user-authored package.json (mirrors GENERATED_README_MARKER semantics). */
export const BUNDLE_MANIFEST_NAME = "crewhaus-compiled-bundle";

/** Collect the @crewhaus/* packages the emitted bundle imports (sorted, deduped). */
export function collectCrewhausDeps(files: Bundle["files"]): readonly string[] {
  const deps = new Set<string>();
  const re = /["'](@crewhaus\/[a-z0-9-]+)["']/g;
  for (const file of files) {
    if (!file.path.endsWith(".ts") && !file.path.endsWith(".js")) continue;
    for (const m of file.content.matchAll(re)) {
      const dep = m[1];
      if (dep !== undefined) deps.add(dep);
    }
  }
  return [...deps].sort();
}

/**
 * Minimal manifest for bundles whose emitter ships no package.json.
 * Versions pin to the CLI's OWN version: the @crewhaus/* packages publish in
 * lockstep (scripts/publish-workspace.ts stamps them all with one version),
 * so `<cliVersion>` is exactly the published contract this CLI's emitters
 * were released against — where "latest" would silently install whatever
 * shipped since, making the bundle's behavior depend on the day it first
 * ran. "latest" remains only as the fallback when no version is resolvable
 * (a broken installation). (In a dev checkout the pinned publish can lag
 * unreleased emitter features; the first boot then reports the mismatch,
 * which is a real signal, not a false positive.)
 */
export function buildBundlePackageJson(deps: readonly string[], version?: string): string {
  const pin = version ?? "latest";
  const dependencies: Record<string, string> = {};
  for (const dep of deps) dependencies[dep] = pin;
  return `${JSON.stringify(
    { name: BUNDLE_MANIFEST_NAME, private: true, type: "module", dependencies },
    null,
    2,
  )}\n`;
}

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
export function ensureBundleManifest(files: Bundle["files"], outDir: string): ManifestResult {
  const path = join(outDir, "package.json");
  if (files.some((f) => f.path === "package.json")) return { path, action: "skipped" };
  if (existsSync(path)) {
    let ours = false;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      ours =
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { name?: unknown }).name === BUNDLE_MANIFEST_NAME;
    } catch {
      ours = false;
    }
    if (!ours) return { path, action: "kept" };
  }
  writeFileSync(path, buildBundlePackageJson(collectCrewhausDeps(files), cliVersion()));
  return { path, action: "wrote" };
}
