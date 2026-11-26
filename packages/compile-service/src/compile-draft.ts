/**
 * `compileDraft`: the files a build of a draft spec would hold, in memory.
 *
 * It compiles as `crewhaus compile` does (`compile()`, or with
 * `emitAs: "cf-worker"` the Worker build `crewhaus compile --emit-as
 * cf-worker` makes) and adds the pinned `package.json` `crewhaus compile`
 * writes beside a local bundle whose emitter ships none. It writes nothing and
 * registers nothing: `crewhaus compile` still records and registers its own
 * builds, so a draft and a build stay told apart.
 *
 * `digest` is `bundleDigest` over the returned files: the bundle's own
 * content. A deployment record's digest is taken over the files on disk plus
 * the build's boot inputs (`apps/cli/src/compile-record.ts`), so the two are
 * not the same number by design.
 *
 * The warnings are the compiler's (or the Worker build's). The permission-rule
 * notices `crewhaus compile` adds by reading its live tools are not among
 * them; `crewhaus lint` and `crewhaus compile` still print those.
 */
import { createHash } from "node:crypto";
import {
  type Bundle,
  type CompileWarning,
  collectCompileWarnings,
  compile,
  lowerWithWarnings,
} from "@crewhaus/compiler";
import { parseSpec } from "@crewhaus/spec";
import {
  type BundleSpecStamp,
  buildBundlePackageJson,
  bundleDigest,
  collectCrewhausDeps,
  specRevision,
} from "./bundle-stamp";
import { emitCfWorkerBundle } from "./cf-worker-emit";

export type CompileDraftOptions = {
  /** The crewhaus version the pinned manifest and the stamp name. */
  readonly compiledWith: string;
  /** Build for a Cloudflare Worker, as `--emit-as cf-worker` does. */
  readonly emitAs?: "cf-worker";
  /** Emit the generated README.md. Default true. */
  readonly readme?: boolean;
  /** Pins the date the model-sunset checks read (`YYYY-MM-DD`). */
  readonly today?: string;
};

export type CompileDraftResult = {
  readonly files: Bundle["files"];
  readonly warnings: ReadonlyArray<CompileWarning>;
  /** `bundleDigest` over `files`. */
  readonly digest: string;
  /** The provenance the pinned manifest carries. */
  readonly stamp: BundleSpecStamp;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Compile `yamlText` in memory. Throws what the compiler throws (a
 * `CrewhausError`: the spec does not parse, does not lower, or names a tool
 * or a setting the build refuses); writes and registers nothing.
 */
export async function compileDraft(
  yamlText: string,
  opts: CompileDraftOptions,
): Promise<CompileDraftResult> {
  let files: Bundle["files"];
  let warnings: ReadonlyArray<CompileWarning>;
  if (opts.emitAs === "cf-worker") {
    // As `crewhaus compile --emit-as cf-worker` builds it: lowered with its
    // warnings, then the Worker emitters behind the edge gates.
    const spec = parseSpec(yamlText);
    const lowered = lowerWithWarnings(spec, opts.today !== undefined ? { today: opts.today } : {});
    const emitted = emitCfWorkerBundle(
      spec,
      lowered.ir,
      opts.readme !== undefined ? { readme: opts.readme } : {},
    );
    files = emitted.files;
    warnings = [...collectCompileWarnings(spec), ...lowered.warnings, ...emitted.warnings];
  } else {
    const result = compile(yamlText, {
      ...(opts.readme !== undefined ? { readme: opts.readme } : {}),
      ...(opts.today !== undefined ? { today: opts.today } : {}),
    });
    files = result.files;
    warnings = result.warnings;
  }
  const stamp: BundleSpecStamp = {
    specHash: specRevision(yamlText),
    compiledWith: opts.compiledWith,
  };
  if (!files.some((f) => f.path === "package.json")) {
    files = [
      ...files,
      {
        path: "package.json",
        content: buildBundlePackageJson(collectCrewhausDeps(files), opts.compiledWith, stamp),
      },
    ];
  }
  const digest = bundleDigest(files.map((f) => ({ path: f.path, sha256: sha256Hex(f.content) })));
  return { files, warnings, digest, stamp };
}
