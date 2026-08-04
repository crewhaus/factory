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
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bundle } from "@crewhaus/ir";
import { cliVersion } from "./version";

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
 * Digest of a spec's SOURCE TEXT, the thing an operator actually edits.
 *
 * Line endings are normalized (CRLF/CR → LF) and a single trailing newline is
 * ignored, so the same spec checked out on Windows — or re-saved by an editor
 * that adds a final newline — is not reported as a spec change. Nothing else
 * is normalized: whitespace and comments inside a spec CAN change behavior
 * (block scalars carry indentation into instructions), so treating them as
 * insignificant would under-report real drift.
 */
export function hashSpecSource(specYaml: string): string {
  const normalized = specYaml.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

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
  writeFileSync(path, buildBundlePackageJson(collectCrewhausDeps(files), version, stamp));
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
