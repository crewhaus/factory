/**
 * What a compile records: a `prepared` deployment for the bundle it just wrote, so the
 * harness knows what it built and a person can activate it. Taken after everything compile
 * writes into the output directory (the bundle, its manifest, the eval bridge) and before
 * the `--check` smoke, which records too.
 *
 * Only a local bundle written to one of the harness's own bundle directories (`dist`,
 * `build` or the harness root, relative to the spec's directory) is recorded. A compile to
 * any other directory, `--emit-ir`, `--emit-loop` and `--emit-as cf-worker` record
 * nothing. Compile never writes `harness.json`; activation fills the harness in.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { lower } from "@crewhaus/compiler";
import { mintId } from "@crewhaus/control-contract";
import { casAppend, deploymentsLedger, readHarnessIdentity } from "@crewhaus/control-records";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import {
  BUNDLE_DIR_CANDIDATES,
  bootInputsOf,
  buildDigest,
  entryFileFor,
} from "@crewhaus/harness-supervisor";
import { intentDigest, policyRevision, specRevision } from "@crewhaus/ir/policy";
import { parseSpec } from "@crewhaus/spec";

function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The harness a compile's output directory belongs to, when it is one of that harness's
 * bundle directories: `dist`, `build` or `.` relative to the spec's directory.
 */
export function harnessBundleOf(
  specPath: string,
  outDir: string,
): { readonly harnessDir: string; readonly bundleRel: string } | undefined {
  const harnessDir = physical(dirname(resolve(specPath)));
  // The output directory's own name is taken as written (a link there is still the
  // harness's bundle directory, and is refused by the writer); its parent is resolved.
  const absOut = resolve(outDir);
  const out =
    absOut === resolve(dirname(resolve(specPath)))
      ? harnessDir
      : join(physical(dirname(absOut)), basename(absOut));
  const rel = relative(harnessDir, out).split("\\").join("/");
  const bundleRel = rel === "" ? "." : rel;
  return (BUNDLE_DIR_CANDIDATES as readonly string[]).includes(bundleRel)
    ? { harnessDir, bundleRel }
    : undefined;
}

export type CompileRecordInput = {
  readonly specPath: string;
  readonly outDir: string;
  readonly yamlText: string;
  /** Paths compile wrote, relative to the output directory (a root bundle records them). */
  readonly written: readonly string[];
  readonly compiledWith?: string;
  /** The registry row's id for a directory, when it is registered. */
  readonly registryIdOf?: (dir: string) => string | undefined;
  readonly now?: () => number;
};

function defaultRegistryIdOf(dir: string): string | undefined {
  try {
    return openHangarRegistry()
      .list()
      .find((entry) => entry.dir === dir)?.id;
  } catch {
    return undefined;
  }
}

export type CompileRecordAnswer =
  | { readonly recorded: true; readonly id: string; readonly digest: string }
  | { readonly recorded: false; readonly reason: string };

/**
 * Append the `prepared` row for what compile just wrote. A failure to record is reported,
 * never thrown: the bundle on disk is still the compile's answer.
 *
 * First consumer: `crewhaus compile` (`runCompile`).
 */
export async function recordCompiledBundle(
  input: CompileRecordInput,
): Promise<CompileRecordAnswer> {
  const owner = harnessBundleOf(input.specPath, input.outDir);
  if (owner === undefined) {
    return { recorded: false, reason: "not one of the harness's bundle directories" };
  }
  const { harnessDir, bundleRel } = owner;
  let ir: ReturnType<typeof lower>;
  let spec: ReturnType<typeof parseSpec>;
  try {
    spec = parseSpec(input.yamlText);
    ir = lower(spec);
  } catch (err) {
    return { recorded: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const entryName = entryFileFor(ir.target);
  const entry = bundleRel === "." ? entryName : `${bundleRel}/${entryName}`;
  const files =
    bundleRel === "."
      ? [...new Set(input.written.map((f) => f.split("\\").join("/")))].sort()
      : undefined;
  const bootInputs = bootInputsOf(harnessDir, ir);
  const artifactFiles = {
    entry,
    ...(files !== undefined ? { files } : {}),
    bootInputs,
  };
  const taken = buildDigest(harnessDir, artifactFiles);
  if ("unreadable" in taken) return { recorded: false, reason: taken.unreadable };

  const registryId = (input.registryIdOf ?? defaultRegistryIdOf)(harnessDir);
  const identity = readHarnessIdentity(harnessDir);
  const harness = registryId ?? (identity.state === "present" ? identity.identity.id : undefined);
  const intent = intentDigest((spec as unknown as { intent?: unknown }).intent);
  const now = input.now ?? (() => Date.now());
  const id = mintId("dep", { now: now() });
  const answer = await casAppend(deploymentsLedger(harnessDir), id, null, {
    id,
    state: "prepared",
    ...(harness !== undefined ? { harness } : {}),
    artifact: {
      digest: taken.digest,
      specHash: specRevision(input.yamlText),
      ...(input.compiledWith !== undefined ? { compiledWith: input.compiledWith } : {}),
      shape: ir.target,
      ...artifactFiles,
    },
    policyRevision: policyRevision(ir),
    ...(intent !== undefined ? { intentDigest: intent } : {}),
    preparedAt: new Date(now()).toISOString(),
  });
  if (!answer.ok) return { recorded: false, reason: answer.reason };
  if (!answer.applied) return { recorded: false, reason: "the deployment could not be recorded" };
  return { recorded: true, id, digest: taken.digest };
}
