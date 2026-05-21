/**
 * Pillar 2 — `spec-patch`. The structured mutation primitive that the
 * active eval optimizer uses to translate "the prompt that scored higher"
 * back into a YAML edit the user can review, commit, and re-run.
 *
 * Why patch the SPEC (not the IR)?
 *
 * The compiler does destructive normalisation in `lower()`: sub-agent
 * maps become arrays, role names get alphabetically sorted, secrets get
 * rewritten to env-var refs via `lowerSecret`, permission rules get
 * de-duped and re-ordered. The IR is intentionally lossy and ordering-
 * canonical because its job is to feed codegen, not round-trip to YAML.
 *
 * A patch at the IR layer therefore can't write back to YAML — there's
 * no path from a frozen sorted array back to the source-author's map
 * with their comments and field ordering. Patching at the SPEC layer
 * (i.e. the YAML AST) keeps the round-trip honest: a `crewhaus optimize
 * --write-back` rewrites the user's file with their comments preserved
 * and only the touched values changed.
 *
 * The `yaml` package's `parseDocument` gives us the CST we need. The
 * Document API has `setIn(path, value)`, `getIn(path)`, `deleteIn(path)`
 * that operate on the live AST; `toString()` renders back with comment
 * and key-order fidelity.
 *
 * IR-passes (in `@crewhaus/ir-passes`) stay what they are — codegen-
 * time optimisations that run AFTER lowering. They don't get conflated
 * with eval-driven mutation. The two systems share nothing; that's
 * intentional.
 *
 * Catalog layer: F2 (compiler periphery). Brief: 278.
 */
import { CrewhausError } from "@crewhaus/errors";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { parseDocument } from "yaml";
import { z } from "zod";

export class SpecPatchError extends CrewhausError {
  override readonly name = "SpecPatchError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

export type SpecPatchOp = "replace" | "add" | "remove";

/**
 * A structured edit to a spec. `path` is a property-key chain (no array
 * indices today — the spec's mutation surface is all object fields). The
 * `target` discriminator must match the spec being patched; the validator
 * refuses cross-target patches so an optimizer can't pass an `IrCli`
 * patch to a `pipeline` spec.
 */
export type SpecPatch = {
  readonly target: Spec["target"];
  readonly path: ReadonlyArray<string>;
  readonly op: SpecPatchOp;
  /** Required for `"replace"` and `"add"`; ignored for `"remove"`. */
  readonly value?: unknown;
  /**
   * Optional rationale string for audit / write-back commit messages.
   * The optimizer fills this with the mutation kind + observed delta.
   */
  readonly rationale?: string;
};

const specPatchSchema = z.object({
  target: z.string().min(1),
  path: z.array(z.string().min(1)).min(1),
  op: z.enum(["replace", "add", "remove"]),
  value: z.unknown().optional(),
  rationale: z.string().optional(),
});

export type ApplySpecPatchResult = {
  /** The mutated YAML text, with comments and key order preserved. */
  readonly yaml: string;
  /** The re-parsed Spec after the patch. */
  readonly spec: Spec;
};

/**
 * Apply a structured patch to a YAML spec source. Uses the `yaml`
 * package's CST so comments and key order survive the round-trip; the
 * only bytes that change are the ones the patch targets.
 *
 * Validates the resulting document against the Spec schema; throws
 * `SpecPatchError` if the mutation produces invalid spec.
 */
export function applySpecPatch(yamlText: string, patch: SpecPatch): ApplySpecPatchResult {
  const parsed = specPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new SpecPatchError(`patch shape is invalid: ${parsed.error.message}`);
  }
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText);
  } catch (err) {
    throw new SpecPatchError("input YAML is not parseable", err);
  }
  // Verify the patch matches the spec's target. Cheap pre-check so we
  // fail with a useful message before the Zod validation later.
  const docTarget = doc.getIn(["target"]);
  if (typeof docTarget === "string" && docTarget !== patch.target) {
    throw new SpecPatchError(
      `patch target "${patch.target}" does not match spec target "${docTarget}"`,
    );
  }

  const path = [...patch.path];
  switch (patch.op) {
    case "replace": {
      if (!doc.hasIn(path)) {
        throw new SpecPatchError(`cannot replace ${formatPath(path)}: path does not exist`);
      }
      doc.setIn(path, patch.value);
      break;
    }
    case "add": {
      if (doc.hasIn(path)) {
        throw new SpecPatchError(
          `cannot add ${formatPath(path)}: path already exists (use "replace")`,
        );
      }
      doc.setIn(path, patch.value);
      break;
    }
    case "remove": {
      if (!doc.hasIn(path)) {
        throw new SpecPatchError(`cannot remove ${formatPath(path)}: path does not exist`);
      }
      doc.deleteIn(path);
      break;
    }
  }

  const newYaml = doc.toString();
  let spec: Spec;
  try {
    spec = parseSpec(newYaml);
  } catch (err) {
    throw new SpecPatchError(`patched YAML failed spec validation: ${(err as Error).message}`, err);
  }
  return { yaml: newYaml, spec };
}

/**
 * Type-check a patch against a parsed Spec WITHOUT applying it. Used
 * by the optimizer to refuse cross-target patches and patches that
 * reference paths outside the optimisation surface.
 *
 * The path-validity check is the "soft" version: it verifies the path
 * is structurally reachable (each segment names a defined field). It
 * does NOT instantiate the patched value — `applySpecPatch` does that
 * via `parseSpec`.
 */
export function validatePatch(spec: Spec, patch: SpecPatch): void {
  const parsed = specPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new SpecPatchError(`patch shape is invalid: ${parsed.error.message}`);
  }
  if (patch.target !== spec.target) {
    throw new SpecPatchError(
      `patch target "${patch.target}" does not match spec target "${spec.target}"`,
    );
  }
  if (!isOptimizable(spec.target, patch.path)) {
    throw new SpecPatchError(
      `path ${formatPath(patch.path)} is not listed in OPTIMIZABLE_PATHS for target "${spec.target}"; add it to packages/spec-patch/src/index.ts if it's intended to be tunable`,
    );
  }
}

function formatPath(path: ReadonlyArray<string>): string {
  return path.join(".");
}

/**
 * Per-target whitelist of mutation paths the active optimizer is
 * allowed to touch. Adding a new field here is the explicit signal that
 * it's safe to autotune. Skipping this list means the optimizer can
 * only mutate prompts (the default), preserving the "spec safety floor"
 * that an optimizer can't accidentally rewrite security-critical fields
 * like `permissions.mode` or `model_router` rules.
 */
export const OPTIMIZABLE_PATHS: Readonly<
  Record<Spec["target"], ReadonlyArray<ReadonlyArray<string>>>
> = Object.freeze({
  cli: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["compaction", "threshold"]),
    // Pillar 2 active context curation — eval-optimizer can flip the
    // semantic-dedupe + relevance-reorder pass on/off and tune its
    // similarity threshold, which dominates input-token cost on long runs.
    Object.freeze(["compaction", "curate"]),
    Object.freeze(["compaction", "dedupeThreshold"]),
    Object.freeze(["compaction", "relevanceTopK"]),
    // Pillar 3 sink-side fabric — egress policy + intent-gate thresholds
    // are tunable so the eval-optimizer can find the sweet spot between
    // false-positive denials and false-negative exfil bypasses.
    Object.freeze(["security", "egressPolicy"]),
    Object.freeze(["security", "justification"]),
    // §47 blockchain subsystem (slice 0). Whole-block replacement so the
    // optimizer can tune `chains[*].finality.count`, `chains[*].rpcPolicy`,
    // `transaction_policy.maxValueUsd`, and `transaction_policy.simulationRequired`
    // by patching their parent block.
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]),
  workflow: Object.freeze([
    Object.freeze(["steps"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]) /* whole-step replacement allowed */,
  channel: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]),
  graph: Object.freeze([
    Object.freeze(["nodes"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]),
  managed: Object.freeze([Object.freeze(["agent", "instructions"])]),
  pipeline: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["indexing", "chunkSize"]),
    Object.freeze(["indexing", "chunkOverlap"]),
    Object.freeze(["retrieve", "defaultK"]),
  ]),
  crew: Object.freeze([
    Object.freeze(["roles"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]) /* whole-role replacement */,
  research: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["retrieve", "maxDepth"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]),
  batch: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]),
  voice: Object.freeze([Object.freeze(["agent", "instructions"])]),
  browser: Object.freeze([Object.freeze(["agent", "instructions"])]),
  eval: Object.freeze([Object.freeze(["agent", "instructions"])]),
  // §47 onchain daemon: full cross-cutting blocks are optimizable.
  onchain: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["chains"]),
    Object.freeze(["triggers"]),
    Object.freeze(["transaction_policy"]),
    Object.freeze(["idempotencyWindowMs"]),
  ]),
  // §47 onchain-game: instructions, game.objective, and the policy are
  // the productive knobs; move-timeout-ms is the realtime quality knob.
  "onchain-game": Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["game"]),
    Object.freeze(["transaction_policy"]),
  ]),
});

function isOptimizable(target: Spec["target"], path: ReadonlyArray<string>): boolean {
  const allowed = OPTIMIZABLE_PATHS[target];
  for (const ok of allowed) {
    if (ok.length !== path.length) continue;
    let match = true;
    for (let i = 0; i < ok.length; i++) {
      if (ok[i] !== path[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  // Allow patches with a prefix that matches an optimizable path
  // (e.g. `["nodes", "0", "instructions"]` if `["nodes"]` is whitelisted)
  // so the optimizer can do fine-grained updates without listing every
  // sub-path.
  for (const ok of allowed) {
    if (path.length < ok.length) continue;
    let match = true;
    for (let i = 0; i < ok.length; i++) {
      if (ok[i] !== path[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Format a YAML header comment to prepend to a written-back file. The
 * orchestrator's `--write-back` writes this above the original spec so
 * a human reviewer can see when and by what an optimisation pass ran.
 */
export function formatWriteBackHeader(opts: {
  readonly runId: string;
  readonly mutator: string;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly iterations: number;
  readonly timestamp?: string;
}): string {
  const ts = opts.timestamp ?? new Date().toISOString();
  const delta = (opts.scoreAfter - opts.scoreBefore).toFixed(3);
  return [
    `# crewhaus optimize: runId ${opts.runId}`,
    `# - mutator: ${opts.mutator}`,
    `# - iterations: ${opts.iterations}`,
    `# - score: ${opts.scoreBefore.toFixed(3)} → ${opts.scoreAfter.toFixed(3)} (Δ ${delta})`,
    `# - generated: ${ts}`,
    "",
  ].join("\n");
}
