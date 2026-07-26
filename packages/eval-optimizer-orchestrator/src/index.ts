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
import { join, resolve } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  type Candidate,
  type FitnessFn,
  type KnobDial,
  type KnobValue,
  type MutationProvider,
  type OptimizerState,
  type ProviderMutation,
  formatKnobPath,
  optimize,
} from "@crewhaus/prompt-optimizer";
import { type Spec, parseSpec } from "@crewhaus/spec";
import {
  type SpecPatch,
  applySpecPatch,
  formatWriteBackHeader,
  validatePatch,
} from "@crewhaus/spec-patch";
import type { CostAccrualEvent, ProviderId, TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  BudgetMeter,
  type SpendSummary,
  type StoppedReason,
  actualCallMicros,
} from "./budget-gate";
import { formatStageNames, listOptimizableStages } from "./stages";

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
  /**
   * FR-003 — dollar ceiling for a model-driven run. When set, the
   * orchestrator threads a `cost-tracker`-priced running total through
   * the search and stops BEFORE issuing a mutation call that would push
   * tracked spend over this budget, returning the best-so-far with
   * `stoppedReason: "budget-reached"`. Composes with `iterations`
   * (whichever bound is hit first ends the run). Omit → today's
   * behaviour (iterations cap only). Rule-based runs make no model
   * calls and report `$0` regardless of this flag.
   */
  readonly budgetUsd?: number;
  /**
   * FR-003 — optional trace bus to publish spend onto the standard
   * observability bus. When provided, one `cost_accrual` event is published
   * per recorded model call, PLUS one terminal aggregate `cost_accrual`
   * (`summary: true`) carrying the run total at the end of the run. The
   * shipped `crewhaus optimize` CLI path constructs a bus and passes it
   * here, so spend reaches the bus on the real user-facing path, not only
   * in unit tests.
   */
  readonly traceBus?: TraceEventBus;
  /**
   * D43 — declared numeric dials the search may step alongside the
   * instruction rewrite. Each `path` must be in this target's
   * `OPTIMIZABLE_PATHS` (validated here before anything is spent, and again
   * by `validatePatch` per emitted patch). Omitted (the default) keeps the
   * search instructions-only, exactly as before.
   *
   * REQUIRES a knob-aware `fitness` — see {@link OptimizeSpecOptions.fitness}
   * and the arity check in {@link optimizeSpec}.
   */
  readonly knobs?: ReadonlyArray<KnobDial>;
  /**
   * D36 (Wave 5, cluster O) — the spec path the search rewrites. Omitted (the
   * default) keeps the historical behaviour EXACTLY: the base prompt comes
   * from {@link extractCurrentPrompt} and the emitted patch targets
   * `["agent","instructions"]`.
   *
   * Set it to optimise ONE stage of a multi-stage spec — a workflow step
   * (`["steps","0","instructions"]`), a graph node
   * (`["nodes","plan","instructions"]`) or a crew role
   * (`["roles","writer","instructions"]`). Use
   * {@link listOptimizableStages} to enumerate the legal paths; every one it
   * returns is already inside `spec-patch`'s `OPTIMIZABLE_PATHS`, and
   * `validatePatch` runs on the emitted patch either way, so a hand-built
   * path outside the whitelist is refused before anything is written.
   *
   * The value at the path must be a string (an instructions block) — the
   * search rewrites prose, not structure.
   */
  readonly promptPath?: ReadonlyArray<string>;
};

export type OptimizeSpecResult = {
  readonly runId: string;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly improvement: number;
  /** True when improvement >= threshold. */
  readonly applied: boolean;
  /** The structured patch the optimizer chose (the instruction rewrite; the
   *  D43 knob patches, when any, ride in {@link patches} alongside it). */
  readonly patch: SpecPatch;
  /**
   * D43 — EVERY patch applied, in application order: the instruction rewrite
   * first, then one patch per dial the search actually moved. Always present
   * and always starts with {@link patch}; a knob-less run's `patches` is
   * exactly `[patch]`, so existing readers of `patch` are unaffected.
   */
  readonly patches: ReadonlyArray<SpecPatch>;
  /** The patched YAML — written back to disk only when `writeBack` is true. */
  readonly patchedYaml: string;
  /** Set when `writeBack: true` and the source was rewritten. */
  readonly writtenTo?: string;
  /** Output directory where patch.json + trajectory.json land. */
  readonly outDir: string;
  /** Full trajectory of every iteration's candidate. */
  readonly trajectory: ReadonlyArray<Candidate>;
  /**
   * FR-003 — the run's spend summary. Always present: for a rule-based
   * run (or any run with no model usage) it is total `$0.0000` with
   * `stopped: "iterations-cap"`.
   */
  readonly spend: SpendSummary;
  /**
   * FR-003 — which bound ended the run, mirrored from `spend.stopped`
   * for ergonomics. `"budget-reached"` only when `--budget-usd` was set
   * AND the gate tripped before the iterations cap.
   */
  readonly stoppedReason: StoppedReason;
  /**
   * Item 9 — persisted eval-run directory of the BASELINE (candidate-0)
   * fitness measurement. Present only when the caller's fitness fn
   * reports it via `FitnessResult.runDir` — the CLI's does (it persists
   * one eval-runner run per candidate under
   * `.crewhaus/optimize/<runId>/evals/`). The CLI's post-accept
   * regression pinning diffs this run against {@link bestEvalDir} to
   * extract the fail→pass recoveries the accepted patch bought.
   */
  readonly baselineEvalDir?: string;
  /** Item 9 — persisted eval-run directory of the winning candidate's
   *  measurement (see {@link baselineEvalDir}). */
  readonly bestEvalDir?: string;
};

/**
 * Read the agent's current `instructions` block from a Spec — the base prompt
 * for a search that did NOT declare {@link OptimizeSpecOptions.promptPath}.
 *
 * Multi-prompt shapes (workflow / graph / crew) have no single
 * `agent.instructions` field, so they are refused here: a caller optimising
 * one of those must name the stage explicitly (D36 — `crewhaus optimize
 * --stage <name>`, or `promptPath` on the library seam), because "the prompt"
 * is ambiguous when there are several.
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
    case "crew": {
      const stages = listOptimizableStages(spec);
      const vocabulary =
        stages.length > 0 ? ` Stages in this spec: ${formatStageNames(stages)}.` : "";
      throw new OptimizeSpecError(
        `target "${spec.target}" has one prompt per ${stages[0]?.kind ?? "stage"} — name the one to optimise (\`crewhaus optimize --stage <name>\`, or pass \`promptPath\` on the library seam).${vocabulary}`,
      );
    }
  }
}

/**
 * D36 — read the string living at `path` in an already-parsed spec. Throws
 * `OptimizeSpecError` (not a TypeError) when the path is absent or does not
 * hold a string, so a mis-declared `promptPath` fails before any spend.
 */
function readPromptAtPath(spec: Spec, path: ReadonlyArray<string>): string {
  let cursor: unknown = spec;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") {
      cursor = undefined;
      break;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor !== "string") {
    throw new OptimizeSpecError(
      `promptPath ${path.join(".")} does not name a string instructions block in this ${spec.target} spec — use \`listOptimizableStages(spec)\` to enumerate the legal paths`,
    );
  }
  return cursor;
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
  // D36 — an explicit `promptPath` names ONE stage of a multi-stage spec;
  // omitted, the historical single-agent path runs verbatim.
  const promptPath: ReadonlyArray<string> = opts.promptPath ?? ["agent", "instructions"];
  const basePrompt =
    opts.promptPath === undefined ? extractCurrentPrompt(spec) : readPromptAtPath(spec, promptPath);
  // D43 — a knob search is only meaningful if the caller's `fitness` APPLIES
  // the dials it is handed. A knob-blind fitness makes every knob candidate an
  // A/A comparison against the incumbent prompt; `optimize()` accepts on
  // `score > best.score`, so a noisy (judge-backed) fitness "wins" on pure
  // variance and this function then writes a validated spec patch whose
  // rationale claims the change was eval-gated. Refuse the run instead:
  // declared arity >= 2 is the cheapest honest signal that the seam is wired
  // (a fitness that truly ignores dials must not declare `knobs`).
  if ((opts.knobs ?? []).length > 0 && opts.fitness.length < 2) {
    throw new OptimizeSpecError(
      "knobs were declared but `fitness` takes a single parameter — a knob-blind fitness " +
        "measures the SAME candidate for every dial value, so any 'win' is noise and the " +
        "emitted patch would claim an eval gate that never ran. Accept the dial values as " +
        "the second argument (`(prompt, knobs) => …`) and apply them to the candidate spec " +
        "before measuring, or drop `knobs`.",
    );
  }
  // D43 — fail FAST on an undeclared dial: every knob path is whitelist-
  // checked (and its bounds sanity-checked) before a single paid iteration
  // runs, rather than after the search has spent its budget.
  for (const dial of opts.knobs ?? []) {
    if (!(dial.step > 0) || !Number.isFinite(dial.step)) {
      throw new OptimizeSpecError(
        `knob ${formatKnobPath(dial.path)} declares a non-positive step (${dial.step})`,
      );
    }
    if (!(dial.min <= dial.max)) {
      throw new OptimizeSpecError(
        `knob ${formatKnobPath(dial.path)} declares min ${dial.min} > max ${dial.max}`,
      );
    }
    try {
      validatePatch(spec, {
        target: spec.target,
        path: [...dial.path],
        op: "replace",
        value: dial.value,
      });
    } catch (err) {
      throw new OptimizeSpecError(
        `knob ${formatKnobPath(dial.path)} is not an optimizable path for target "${spec.target}"`,
        err,
      );
    }
  }
  const runId = opts.runId ?? `opt_${Date.now().toString(16)}`;
  const outDir = opts.outDir ?? join(".crewhaus", "optimize", runId);
  mkdirSync(outDir, { recursive: true });

  // FR-003 — cost budget gate. Build a meter priced against the mutator's
  // model (feature-detected; the rule-based provider exposes no model so
  // the meter never accumulates and never trips). The gate wraps the
  // supplied mutator: it checks the budget BEFORE each call and records
  // the call's actual usage AFTER. Once tripped, every subsequent call is
  // a cheap no-op (best unchanged) so `optimize()` completes normally with
  // the full trajectory + best-so-far — we never throw out of the loop,
  // which would discard the trajectory.
  const budgetMicros =
    opts.budgetUsd !== undefined ? Math.round(opts.budgetUsd * 1_000_000) : undefined;
  const modelInfo = resolveMutatorModel(opts.mutator);
  const meter = new BudgetMeter(
    budgetMicros,
    modelInfo.provider,
    modelInfo.modelId,
    modelInfo.maxOutputTokens,
  );
  let stoppedEarly = false;
  const gatedMutator: MutationProvider | undefined =
    opts.mutator !== undefined
      ? wrapWithBudgetGate(opts.mutator, meter, opts.traceBus, modelInfo, runId, () => {
          stoppedEarly = true;
        })
      : undefined;

  const result = await optimize(basePrompt, {
    trainSet: opts.trainSet,
    devSet: opts.devSet,
    fitness: opts.fitness,
    iterations: opts.iterations ?? 10,
    ...(opts.improvementThreshold !== undefined
      ? { improvementThreshold: opts.improvementThreshold }
      : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(gatedMutator !== undefined ? { mutator: gatedMutator } : {}),
    ...(opts.knobs !== undefined && opts.knobs.length > 0 ? { knobs: opts.knobs } : {}),
    runId,
    outDir,
  });

  const stoppedReason: StoppedReason = stoppedEarly ? "budget-reached" : "iterations-cap";
  const spend = meter.summary(stoppedReason);

  // FR-003 — publish the AGGREGATE spend summary onto the trace bus (in
  // addition to the per-call `cost_accrual` events). This is the "...plus
  // the total" the budgetUsd doc + walkthrough promise: without it the
  // total lived only on the result/report.json, never on the bus. We reuse
  // the `cost_accrual` kind (additive — no new event kind) with the
  // `summary: true` discriminator so subscribers can tell the run total
  // apart from a single call; `cost-tracker` ignores externally-published
  // accruals, so this never double-counts. Published even when zero calls
  // were recorded so the bus always carries a terminal total for the run.
  if (opts.traceBus !== undefined) {
    const totalInput = spend.perIteration.reduce((a, s) => a + s.inputTokens, 0);
    const totalOutput = spend.perIteration.reduce((a, s) => a + s.outputTokens, 0);
    const totalAccrual: CostAccrualEvent = {
      ...opts.traceBus.envelope(),
      runId,
      kind: "cost_accrual",
      provider: modelInfo.provider,
      modelId: modelInfo.modelId,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedReadTokens: 0,
      costUsdMicros: spend.totalUsdMicros,
      summary: true,
    };
    opts.traceBus.publish(totalAccrual);
  }

  const improvementThreshold = opts.improvementThreshold ?? 0.01;
  const applied = result.improvement >= improvementThreshold;

  const patch: SpecPatch = {
    target: spec.target,
    path: [...promptPath],
    op: "replace",
    value: result.best.prompt,
    rationale: `${opts.mutator?.name ?? "rule-based"} mutator improved fitness by ${result.improvement.toFixed(3)} over ${opts.iterations ?? 10} iterations${opts.promptPath !== undefined ? ` (stage ${promptPath.join(".")})` : ""}`,
  };
  validatePatch(spec, patch);
  // D43 — one patch per dial the search actually MOVED (a dial that came back
  // at its source value emits nothing, so a knob-declaring run that found no
  // knob win produces exactly the pre-D43 single-patch output). Each is
  // whitelist-validated and applied through the same CST round-trip, so
  // comments/key order survive and an out-of-bounds value fails the strict
  // re-parse instead of landing.
  const knobPatches: SpecPatch[] = [];
  for (const knob of result.knobs ?? []) {
    const source = (opts.knobs ?? []).find(
      (d) => formatKnobPath(d.path) === formatKnobPath(knob.path),
    );
    if (source === undefined || source.value === knob.value) continue;
    knobPatches.push({
      target: spec.target,
      path: [...knob.path],
      op: "replace",
      value: knob.value,
      rationale: `${opts.mutator?.name ?? "rule-based"} knob search moved ${formatKnobPath(knob.path)} from ${source.value} to ${knob.value} (eval-gated)`,
    });
  }
  const patches: SpecPatch[] = [patch, ...knobPatches];
  let applyResult = applySpecPatch(yamlText, patch);
  for (const knobPatch of knobPatches) {
    validatePatch(spec, knobPatch);
    applyResult = applySpecPatch(applyResult.yaml, knobPatch);
  }

  // Always persist the patch JSON + report (whether or not we apply).
  // `patch.json` keeps its historical single-patch shape; the full ordered
  // list lands beside it so nothing about the existing artifact changes.
  writeFileSync(join(outDir, "patch.json"), JSON.stringify(patch, null, 2), {
    mode: 0o600,
  });
  if (knobPatches.length > 0) {
    writeFileSync(join(outDir, "patches.json"), JSON.stringify(patches, null, 2), {
      mode: 0o600,
    });
  }
  writeFileSync(
    join(outDir, "report.json"),
    JSON.stringify(
      {
        runId,
        specPath: specAbs,
        target: spec.target,
        mutator: opts.mutator?.name ?? "rule-based",
        // D36 — recorded ONLY for a stage-scoped run, so a single-agent
        // report.json stays byte-identical to every one written before.
        ...(opts.promptPath !== undefined ? { promptPath: [...promptPath] } : {}),
        iterations: opts.iterations ?? 10,
        scoreBefore: result.best.score - result.improvement,
        scoreAfter: result.best.score,
        improvement: result.improvement,
        improvementThreshold,
        applied,
        // FR-003 — spend accounting + stop reason persisted for audit.
        ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
        stoppedReason,
        spend,
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
    patches,
    patchedYaml: applyResult.yaml,
    ...(writtenTo !== undefined ? { writtenTo } : {}),
    outDir,
    trajectory: result.trajectory,
    spend,
    stoppedReason,
    // Item 9 — surface the baseline/winner eval-run dirs (when the fitness
    // fn reported them) for post-accept regression pinning.
    ...(result.baseRunDir !== undefined ? { baselineEvalDir: result.baseRunDir } : {}),
    ...(result.bestRunDir !== undefined ? { bestEvalDir: result.bestRunDir } : {}),
  };
}

/**
 * FR-003 — feature-detect the mutator's pricing inputs. The
 * `MutationProvider` interface only guarantees `name` + `next()`; a
 * model-backed provider (`ClaudeMutationProvider`) additionally exposes
 * read-only `modelId` + `maxOutputTokens` getters. When present we price
 * calls against `("anthropic", modelId)`; otherwise (rule-based, or any
 * provider that doesn't expose the getters) we return a placeholder model
 * id that prices to $0, so the meter never accumulates and the gate never
 * trips — the run is bounded by the iterations cap alone.
 */
const KNOWN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "gemini",
  "bedrock",
]);

function resolveMutatorModel(mutator: MutationProvider | undefined): {
  provider: ProviderId;
  modelId: string;
  maxOutputTokens: number;
} {
  if (
    mutator !== undefined &&
    "modelId" in mutator &&
    typeof (mutator as { modelId: unknown }).modelId === "string"
  ) {
    const modelId = (mutator as { modelId: string }).modelId;
    const maxOutputTokens =
      "maxOutputTokens" in mutator &&
      typeof (mutator as { maxOutputTokens: unknown }).maxOutputTokens === "number"
        ? (mutator as { maxOutputTokens: number }).maxOutputTokens
        : 2048;
    // Feature-detect the provider id the same way as modelId: a
    // model-backed provider built on a non-Anthropic adapter (the CLI's
    // `--mutator claude` on an openai/gemini/bedrock spec) exposes its
    // adapter's providerId, so the budget gate prices against the REAL
    // provider's table. Providers without the getter price as Anthropic
    // (the historical behaviour — non-breaking).
    const rawProvider =
      "providerId" in mutator && typeof (mutator as { providerId: unknown }).providerId === "string"
        ? (mutator as { providerId: string }).providerId
        : "anthropic";
    const provider: ProviderId = KNOWN_PROVIDER_IDS.has(rawProvider)
      ? (rawProvider as ProviderId)
      : "anthropic";
    return { provider, modelId, maxOutputTokens };
  }
  // No model exposed → an unpriceable placeholder id (resolvePricing miss
  // ⇒ $0). 2048 is the conventional default ceiling; unused when $0.
  return { provider: "anthropic", modelId: "__rule-based__", maxOutputTokens: 2048 };
}

/**
 * FR-003 — feature-detect a provider's exact serialized-input length for
 * the upcoming call. A model-backed provider (`ClaudeMutationProvider`)
 * exposes `estimateInputChars(state)` returning the system-block + rendered
 * failure-block char count it will transmit, so the cost-gate prices the
 * real meta-prompt instead of just `best.prompt.length`. Returns undefined
 * for providers without the hook (the caller falls back to prompt length).
 */
function estimateInputChars(mutator: MutationProvider, state: OptimizerState): number | undefined {
  if (
    "estimateInputChars" in mutator &&
    typeof (mutator as { estimateInputChars: unknown }).estimateInputChars === "function"
  ) {
    const n = (mutator as { estimateInputChars: (s: OptimizerState) => number }).estimateInputChars(
      state,
    );
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * FR-003 — wrap a `MutationProvider` so the orchestrator can gate on cost.
 * Before each delegated call we ask the meter whether the upcoming call
 * would exceed the budget; if so we DO NOT delegate (the model call is
 * never issued) and instead return a no-op mutation (best unchanged),
 * flagging `onStop()` so the orchestrator records `budget-reached`. Once
 * tripped the wrapper stays in no-op mode for the remaining iterations so
 * the search converges cheaply on the best-so-far without throwing — which
 * keeps `optimize()` untouched and preserves the full trajectory. After a
 * delegated call we record its actual usage and (optionally) publish a
 * `cost_accrual` event onto the trace bus.
 */
function wrapWithBudgetGate(
  base: MutationProvider,
  meter: BudgetMeter,
  traceBus: TraceEventBus | undefined,
  modelInfo: { provider: ProviderId; modelId: string },
  runId: string,
  onStop: () => void,
): MutationProvider {
  let tripped = false;
  return {
    name: base.name,
    async next(state: OptimizerState): Promise<ProviderMutation> {
      // FR-003 — price the FULL serialized input the provider will send
      // (system block + rendered dev-set failure block), not just the
      // candidate prompt, when the provider exposes the exact-length hook.
      // This closes the input under-count that could otherwise let a
      // gate-passing call exceed budget after the fact for large dev
      // windows. Providers without the hook fall back to prompt length;
      // the meter adds its own `metaOverheadChars` margin in both cases.
      const inputChars = estimateInputChars(base, state) ?? state.best.prompt.length;
      if (tripped || meter.wouldExceed(inputChars)) {
        if (!tripped) {
          tripped = true;
          onStop();
        }
        // No-op: return the current best unchanged. The model call is
        // never issued, so no spend is incurred for this iteration.
        return { prompt: state.best.prompt, mutations: [] };
      }
      const mutation = await base.next(state);
      if (mutation.usage !== undefined) {
        meter.record(state.iteration, mutation.usage);
        if (traceBus !== undefined) {
          const accrual: CostAccrualEvent = {
            ...traceBus.envelope(),
            runId,
            kind: "cost_accrual",
            provider: modelInfo.provider,
            modelId: modelInfo.modelId,
            inputTokens: mutation.usage.input,
            outputTokens: mutation.usage.output,
            cachedReadTokens: mutation.usage.cacheRead ?? 0,
            costUsdMicros: actualCallMicrosFor(mutation.usage, modelInfo),
          };
          traceBus.publish(accrual);
        }
      }
      return mutation;
    },
  };
}

/** Price one call's usage for the trace-bus event (mirrors the meter's math). */
function actualCallMicrosFor(
  usage: { input: number; output: number; cacheRead?: number },
  modelInfo: { provider: ProviderId; modelId: string },
): number {
  return actualCallMicros(usage, modelInfo.provider, modelInfo.modelId);
}

// Re-export the spec-patch types so callers don't need a second import.
export type { SpecPatch } from "@crewhaus/spec-patch";
export { applySpecPatch, validatePatch } from "@crewhaus/spec-patch";

// Track B — four-way failure arbiter (Section 55, from Meta-Engineering
// Harnesses arxiv 2605.25665). See ./failure-arbiter.ts for the
// rule-based classifier.
export type {
  AggregateVerdict,
  ArbiterAction,
  ArbiterVerdict,
  FailingSample,
  FailureClass,
} from "./failure-arbiter";
export { aggregate, arbitrate } from "./failure-arbiter";

// FR-003 — cost budget gate (`--budget-usd`). See ./budget-gate.ts for the
// estimate-before/record-after meter built on cost-tracker's pure pricing
// exports. The budget loop itself lives in `optimizeSpec` (above) because
// it owns the cost-tracker dependency and the iteration accounting.
export type { CallUsage, IterationSpend, SpendSummary, StoppedReason } from "./budget-gate";
export { BudgetMeter, actualCallMicros, estimateCallMicros } from "./budget-gate";

// D36 (Wave 5, cluster O) — per-stage prompt enumeration for multi-stage
// specs. See ./stages.ts; every path it returns is already inside spec-patch's
// OPTIMIZABLE_PATHS whitelist.
export type { OptimizableStage, StageKind } from "./stages";
export {
  MULTI_PROMPT_TARGETS,
  findStage,
  formatStageNames,
  listOptimizableStages,
  stagePathIsWhitelisted,
} from "./stages";
