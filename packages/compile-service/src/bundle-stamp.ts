/**
 * The pure half of a local bundle's dependency manifest: what `crewhaus
 * compile` writes beside a bundle whose emitter ships no package.json, and the
 * provenance stamp it carries. Writing the file (and never writing over one a
 * person wrote) stays with the caller; `crewhaus compile` does it in
 * `apps/cli/src/bundle-manifest.ts`.
 *
 * A local bundle's emitted entrypoint carries bare `@crewhaus/*` imports and
 * nothing that declares them, so outside a checkout that already has the
 * runtime packages installed, `bun agent.ts` dies on the first import. The
 * manifest built here lists every `@crewhaus/*` package the bundle imports,
 * pinned to one version.
 *
 * Build identity is not computed here: `specRevision`, `bundleManifestText`
 * and `bundleDigest` are `@crewhaus/ir/policy`'s, re-exported, so a compile,
 * an activation and every later check compare like with like.
 */
import type { Bundle } from "@crewhaus/ir";
import { bundleDigest, bundleManifestText, specRevision } from "@crewhaus/ir/policy";

export { bundleDigest, bundleManifestText, specRevision };

/** The `name` stamped into synthesized manifests — the "ours" marker that
 * lets a recompile refresh its own manifest while never clobbering a
 * user-authored package.json (mirrors GENERATED_README_MARKER semantics). */
export const BUNDLE_MANIFEST_NAME = "crewhaus-compiled-bundle";

/**
 * Provenance the compile stamps into the emitted manifest so a manager can
 * answer "is this bundle stale against crewhaus.yaml?" EXACTLY instead of
 * guessing from mtimes.
 *
 * Before this, the only signal was file mtimes — and mtimes lie: a `git
 * checkout` rewrites them, a copy resets them, clock skew inverts them. A
 * fresh bundle read as stale means a needless recompile; a stale one read as
 * fresh means a daemon quietly serving yesterday's spec, which is the failure
 * that matters.
 *
 * Deliberately NOT recorded: a compile timestamp. Two compiles of the same
 * spec with the same CLI must produce byte-identical output, and a clock
 * reading would make every recompile a diff.
 */
export type BundleSpecStamp = {
  /** `sha256:<64 hex>` over the normalized spec source. */
  readonly specHash: string;
  /** The crewhaus version whose emitters produced the bundle. */
  readonly compiledWith?: string;
};

/** Key the stamp lives under in the synthesized package.json. */
export const BUNDLE_STAMP_KEY = "crewhaus";

/**
 * Digest of a spec's SOURCE TEXT, the thing an operator actually edits: the one revision
 * function every check shares (`@crewhaus/ir/policy`'s `specRevision`).
 */
export const hashSpecSource: (specYaml: string) => string = specRevision;

/**
 * Collect the @crewhaus/* packages the emitted bundle imports (sorted,
 * deduped). A SUBPATH import (`@crewhaus/target-eval-bundle/runtime`, which
 * the bridged eval bundle uses to avoid loading the codegen tree at boot)
 * resolves to its PACKAGE — the dependency is the package, not the subpath,
 * and missing that would leave the emitted manifest unable to install.
 */
export function collectCrewhausDeps(files: Bundle["files"]): readonly string[] {
  const deps = new Set<string>();
  const re = /["'](@crewhaus\/[a-z0-9-]+)(?:\/[a-zA-Z0-9._-]+)*["']/g;
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
export function buildBundlePackageJson(
  deps: readonly string[],
  version?: string,
  stamp?: BundleSpecStamp,
): string {
  const pin = version ?? "latest";
  const dependencies: Record<string, string> = {};
  for (const dep of deps) dependencies[dep] = pin;
  return `${JSON.stringify(
    {
      name: BUNDLE_MANIFEST_NAME,
      private: true,
      type: "module",
      // Sits between the identity fields and `dependencies` so a human reading
      // the manifest sees the provenance before the pin list. Omitted entirely
      // when no spec source was supplied, keeping older call paths' output
      // byte-identical.
      ...(stamp !== undefined ? { [BUNDLE_STAMP_KEY]: stamp } : {}),
      dependencies,
    },
    null,
    2,
  )}\n`;
}
