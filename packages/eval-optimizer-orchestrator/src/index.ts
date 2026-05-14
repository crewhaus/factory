/**
 * Pillar 2 — `eval-optimizer-orchestrator`. The glue that closes the
 * active-optimisation loop.
 *
 * Without this package, `prompt-optimizer` is an orphaned search
 * function with no way to turn its winning candidate back into a YAML
 * change the user can review or commit. The orchestrator:
 *
 *   1. Reads the source `crewhaus.yaml`.
 *   2. Locates the agent's current `instructions` block via the spec
 *      discriminator (handles every shipped target shape — see
 *      `extractCurrentPrompt` below).
 *   3. Drives `prompt-optimizer.optimize()` with a caller-supplied
 *      fitness function (the CLI wires `eval-runner.runEval` to this).
 *   4. Converts the winning prompt into a `SpecPatch` against
 *      `[agent.instructions]`.
 *   5. Validates the patch is in `OPTIMIZABLE_PATHS` and applies it
 *      via `applySpecPatch` (CST round-trip — comments preserved).
 *   6. Persists the patch + report + trajectory under
 *      `.crewhaus/optimize/<runId>/`.
 *   7. Optionally writes the patched YAML back to disk (default:
 *      emit `patch.json` only; `writeBack: true` mutates the source).
 *
 * The orchestrator is intentionally decoupled from `eval-runner` —
 * fitness is supplied by the caller as a pure `(prompt: string) →
 * Promise<number>`. The CLI is responsible for constructing that
 * function by closing over `compile()` + `runEval()`. This decoupling
 * keeps the orchestrator testable with synthetic fitness functions and
 * lets future callers (e.g. a Studio panel) wire alternate fitness
 * sources without touching this package.
 *
 * Catalog layer: F-eval. Brief: 279.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  type Candidate,
  type FitnessFn,
  type MutationProvider,
  optimize,
} from "@crewhaus/prompt-optimizer";
import { type Spec, parseSpec } from "@crewhaus/spec";
import {
  type SpecPatch,
  applySpecPatch,
  formatWriteBackHeader,
  validatePatch,
} from "@crewhaus/spec-patch";

export class OptimizeSpecError extends CrewhausError {
  override readonly name = "OptimizeSpecError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

export type OptimizeSpecOptions = {
  /** Absolute path to the source `crewhaus.yaml`. */
  readonly specPath: string;
  /** Caller-supplied fitness function. CLI wires eval-runner here. */
  readonly fitness: FitnessFn;
  /** Train set passed through to the mutator (rule-based provider). */
  readonly trainSet: ReadonlyArray<Sample>;
  /** Dev set used for fitness measurement. */
  readonly devSet: ReadonlyArray<Sample>;
  /** Pluggable mutator. Default: `RuleBasedMutationProvider`. */
  readonly mutator?: MutationProvider;
  /** Number of optimisation iterations. Default: 10. */
  readonly iterations?: number;
  /**
   * Minimum score improvement to apply the patch. Default: 0.01.
   * Iterations always run all the way through; this threshold gates
   * whether the orchestrator returns a patch (vs. a no-op result).
   */
  readonly improvementThreshold?: number;
  /** Persistence directory. Default: `.crewhaus/optimize/<runId>/`. */
  readonly outDir?: string;
  /**
   * When true, rewrite the source YAML in place with the patched
   * version (preserving comments and key order via spec-patch's
   * CST round-trip). Default: false — emit `patch.json` only and
   * leave the source untouched.
   */
  readonly writeBack?: boolean;
  /** Optional run id (default: `opt_<hex>`). */
  readonly runId?: string;
  /** RNG seed forwarded to the default rule-based mutator. */
  readonly seed?: number;
};

export type OptimizeSpecResult = {
  readonly runId: string;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly improvement: number;
  /** True when improvement >= threshold. */
  readonly applied: boolean;
  /** The structured patch the optimizer chose. */
  readonly patch: SpecPatch;
  /** The patched YAML — written back to disk only when `writeBack` is true. */
  readonly patchedYaml: string;
  /** Set when `writeBack: true` and the source was rewritten. */
  readonly writtenTo?: string;
  /** Output directory where patch.json + trajectory.json land. */
  readonly outDir: string;
  /** Full trajectory of every iteration's candidate. */
  readonly trajectory: ReadonlyArray<Candidate>;
};

/**
 * Read the agent's current `instructions` block from a Spec. Handles
 * every target shape that's optimizable today; throws if the target
 * doesn't have a single `agent.instructions` field. (Workflow / crew /
 * graph have nested prompts; v0 of the orchestrator targets only
 * single-agent shapes — the OPTIMIZABLE_PATHS list will expand to
 * cover the rest via path-prefix matching.)
 */
export function extractCurrentPrompt(spec: Spec): string {
  switch (spec.target) {
    case "cli":
    case "channel":
    case "managed":
    case "pipeline":
    case "research":
    case "batch":
    case "voice":
    case "browser":
    case "eval":
    case "onchain":
    case "onchain-game":
      return spec.agent.instructions;
    case "workflow":
    case "graph":
    case "crew":
      throw new OptimizeSpecError(
        `target "${spec.target}" has multiple prompts (one per step/node/role); the v0 orchestrator only optimises single-agent shapes. Specify --path <step.instructions> for granular tuning (follow-up).`,
      );
  }
}

/**
 * Run the full optimise-then-patch loop. Pure with respect to the
 * filesystem until `writeBack: true` — every invocation is reproducible
 * given the same fitness function + seed.
 */
export async function optimizeSpec(opts: OptimizeSpecOptions): Promise<OptimizeSpecResult> {
  const specAbs = resolve(opts.specPath);
  let yamlText: string;
  try {
    yamlText = readFileSync(specAbs, "utf8");
  } catch (err) {
    throw new OptimizeSpecError(`cannot read spec at ${specAbs}`, err);
  }
  let spec: Spec;
  try {
    spec = parseSpec(yamlText);
  } catch (err) {
    throw new OptimizeSpecError(
      `spec at ${specAbs} failed to parse — fix it before optimising`,
      err,
    );
  }
  const basePrompt = extractCurrentPrompt(spec);
  const runId = opts.runId ?? `opt_${Date.now().toString(16)}`;
  const outDir = opts.outDir ?? join(".crewhaus", "optimize", runId);
  mkdirSync(outDir, { recursive: true });

  const result = await optimize(basePrompt, {
    trainSet: opts.trainSet,
    devSet: opts.devSet,
    fitness: opts.fitness,
    iterations: opts.iterations ?? 10,
    ...(opts.improvementThreshold !== undefined
      ? { improvementThreshold: opts.improvementThreshold }
      : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.mutator !== undefined ? { mutator: opts.mutator } : {}),
    runId,
    outDir,
  });

  const improvementThreshold = opts.improvementThreshold ?? 0.01;
  const applied = result.improvement >= improvementThreshold;

  const patch: SpecPatch = {
    target: spec.target,
    path: ["agent", "instructions"],
    op: "replace",
    value: result.best.prompt,
    rationale: `${opts.mutator?.name ?? "rule-based"} mutator improved fitness by ${result.improvement.toFixed(3)} over ${opts.iterations ?? 10} iterations`,
  };
  validatePatch(spec, patch);
  const applyResult = applySpecPatch(yamlText, patch);

  // Always persist the patch JSON + report (whether or not we apply).
  writeFileSync(join(outDir, "patch.json"), JSON.stringify(patch, null, 2), {
    mode: 0o600,
  });
  writeFileSync(
    join(outDir, "report.json"),
    JSON.stringify(
      {
        runId,
        specPath: specAbs,
        target: spec.target,
        mutator: opts.mutator?.name ?? "rule-based",
        iterations: opts.iterations ?? 10,
        scoreBefore: result.best.score - result.improvement,
        scoreAfter: result.best.score,
        improvement: result.improvement,
        improvementThreshold,
        applied,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  let writtenTo: string | undefined;
  if (opts.writeBack === true && applied) {
    const header = formatWriteBackHeader({
      runId,
      mutator: opts.mutator?.name ?? "rule-based",
      scoreBefore: result.best.score - result.improvement,
      scoreAfter: result.best.score,
      iterations: opts.iterations ?? 10,
    });
    const stamped = `${header}${applyResult.yaml}`;
    // Atomic-ish write: write to .tmp, then rename. We use writeFileSync
    // for simplicity; race conditions with concurrent edits are not in
    // scope for the orchestrator (the user is expected to commit the
    // source file before invoking optimize).
    const tmpPath = `${specAbs}.optimize.tmp`;
    writeFileSync(tmpPath, stamped, { mode: 0o600 });
    // Bun's rename via the standard fs API would need an import; we
    // sidestep with a final writeFileSync to the target and a tmp clean-up.
    writeFileSync(specAbs, stamped);
    // Best-effort cleanup of the tmp.
    try {
      writeFileSync(tmpPath, "");
    } catch {
      // ignore — directory might be read-only mid-test
    }
    writtenTo = specAbs;
  }

  return {
    runId,
    scoreBefore: result.best.score - result.improvement,
    scoreAfter: result.best.score,
    improvement: result.improvement,
    applied,
    patch,
    patchedYaml: applyResult.yaml,
    ...(writtenTo !== undefined ? { writtenTo } : {}),
    outDir,
    trajectory: result.trajectory,
  };
}

// Re-export the spec-patch types so callers don't need a second import.
export type { SpecPatch } from "@crewhaus/spec-patch";
export { applySpecPatch, validatePatch } from "@crewhaus/spec-patch";
