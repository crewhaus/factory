/**
 * Catalog R-eval `eval-runner` — run an agent against a dataset.
 *
 * Per-sample isolation: fresh `RunContext` (and therefore fresh
 * `TraceEventBus` + `sessionId`) so concurrent samples don't see each
 * other's events. Concurrency is enforced by a tiny in-package semaphore
 * (default 4). Per-sample artifacts persist to
 * `.crewhaus/evals/<runId>/<sampleId>/{transcript.jsonl, events.jsonl,
 * grades.json, meta.json}`. Run-level: `run.json` (config snapshot)
 * + `results.json` (aggregates).
 *
 * `--seed` is honored only for providers that surface temperature
 * reproducibility (Anthropic does not). Document divergence; do not
 * promise byte-identical reruns.
 *
 * `permissionMode` is forced to `"auto"` so `alwaysAsk` rules auto-deny
 * rather than blocking on stdin in a non-interactive eval run.
 *
 * MCP servers are shared across samples (read-mostly assumption). An
 * `isolateMcpPerSample` escape hatch is reserved for future use.
 *
 * Loop contract 0.4 (Batch B):
 *   G15 `repeats` — k seed-offset trials per sample; pass@k / pass^k
 *       (tau-bench) in the aggregates, per-trial grades on the sample.
 *   G14 — a `type: registry` graders file without a caller registry gets
 *       the default one (the specialty packs + `.crewhaus/graders`
 *       plugins; see `defaultGraderRegistry`).
 *   G56 — per-sample loop-quality metrics (tool-call accuracy,
 *       interventions, disjoint safety-violation buckets, per-model-call
 *       latencies) + their run aggregates.
 *   G54 — the spec's `failure_taxonomy` reaches BOTH the in-loop recovery
 *       engine (via defaultInvoker) and the runner's noise auto-retry
 *       (classified retry; `recovery: fail` classes are terminal).
 *   G47 — `llm_judge` rubrics without a `passing_score` gate on the
 *       calibrated cut from `.crewhaus/judge-calibration.json`.
 *
 * Evals Wave 1 (measurement literacy):
 *   B13 `sliceKeys` — per-slice aggregates over sample metadata string
 *       values (`summary.slices`; default keys family/difficulty/language/
 *       source), computed here so target-eval bundles inherit them.
 *   C27 — closed-form 95% CIs on the aggregates (`passRateCI95` Wilson,
 *       `meanScoreCI95` Student t; see `stats.ts`).
 *   A12 — per-criterion judge means per grader (`criterionMeans`), from
 *       the `detail` breakdown judge grades now carry.
 *   A3  — an abstained judge verdict (nothing else failing) makes the
 *       sample outcome `abstained`: out of the pass-rate denominator, into
 *       the `needsHuman` bucket for human review.
 *   NEW-HUNT-3 — the spec's `limits:` and `budget:` blocks are honored by
 *       eval runs: `limits.deadline_ms` (or `--sample-timeout-ms`) bounds
 *       each sample's agent invocation with a wall-clock watchdog, the
 *       remaining `limits:` ceilings thread into the default invoker's
 *       chat loop exactly as `crewhaus run` threads them, and `budget.usd`
 *       (or `--budget-usd`) caps the RUN's accrued agent-model spend —
 *       queued samples abort at the cap and the summary is marked partial.
 *
 * Evals Wave 2 (judge quality, cluster K):
 *   NEW-HUNT-7 — `type: registry` graders.yaml entries may carry `opts:`,
 *       resolved through `resolveRegistryGrader` (shared with the exam):
 *       the default registry validates them against the named pack's own
 *       strict schema and threads them into the pack constructor; plugin
 *       graders receive the record untouched as a third argument.
 *   NEW-HUNT-5 — semantic.similarity's silent ROUGE-L fallback becomes a
 *       run-level signal: `aggregates.semanticFallback` in results.json
 *       plus an `[eval] warning:` stderr line from the runner itself, so
 *       CLI evals and compiled bundles surface it identically.
 *
 * Evals Wave 2 (judge quality, cluster P):
 *   A2  — `llm_judge` panels (`judges: [model, ...]`) thread through to
 *       `createJudgeGrader`; a high-entropy panel vote flags the sample
 *       `needsReview`, listed in the aggregates SEPARATELY from the
 *       abstained needs-human bucket (the verdict still counts — see
 *       `run-sample.ts` / `aggregate.ts`), and the panel roster rides in
 *       the `judgeSampling` reproducibility manifest.
 *
 * Evals Wave 2 (judge quality, cluster C):
 *   NEW-graders-2 — `llm_judge` rubrics may be CATEGORICAL
 *       (`kind: categorical` + labels/passing_labels): the runner
 *       dispatches on `kind` at resolution (`loadCategoricalRubric` →
 *       `createJudgeGrader`); categorical rubrics never join the G47
 *       calibrated-cut path (their gate is label membership, not a scalar
 *       cut).
 *   NEW-graders-3 — `llm_judge` `target: transcript` threads through to
 *       the judge grader (the judge reads a bounded transcript digest) and
 *       is recorded per grader in the `judgeSampling` manifest — a
 *       transcript-judged run is a different measurement instrument.
 *   A9/A10 — the `calibration.abstentionAware` and
 *       `consistency.paraphraseGroup` registry packs live in this package
 *       (calibration-abstention.ts / paraphrase-consistency.ts) and their
 *       cross-sample lenses ride `aggregate()`'s post-run seam into
 *       results.json (`aggregates.calibration` /
 *       `aggregates.paraphraseConsistency`).
 *
 * Evals Wave 4 (reach & robustness, cluster R):
 *   NEW-HUNT-4 — tool record/replay. `recordToolsDir` wraps every wired tool
 *       so each execution's result is appended to `<dir>/tools.jsonl` keyed by
 *       (sampleId, toolName, sha256(canonical-JSON args)); `replayToolsDir`
 *       serves those results from the cassette instead of executing (miss
 *       policy `error` by default, `live` to fall through). Tools only — the
 *       model still runs live. See `tool-record.ts`.
 *   NEW-HUNT-6 — `resume`: re-open an interrupted run directory (`outDir`),
 *       verify its recorded specHash/datasetHash/gradersHash still match,
 *       reload every sample that already wrote `grades.json`, run only the
 *       missing ones, and re-aggregate the UNION under the ORIGINAL runId.
 *       See `resume.ts`.
 *
 * Evals Wave 4 (reach & robustness, cluster T):
 *   C33 — the reproducibility manifest completes: `run.json`/`results.json`
 *       record `cliVersion` (supplied by the launcher), `bunVersion` and
 *       `platform`, so a results.json says which build on which runtime
 *       produced it.
 *   C34 — flake DETECTION: a repeat run's samples whose trials disagreed
 *       (`0 < trialPassRate < 1`) are flagged `flaky` per sample and listed
 *       in `aggregates.flaky`/`flakySampleIds`. Verdicts are untouched —
 *       quarantine is a human decision made against the dataset.
 *   C35 — judge token METERING: every `llm_judge` call reports its provider
 *       usage through a sink threaded into the graders this runner builds,
 *       accumulating into `aggregates.judgeUsage` (per judge model, so the
 *       CLI can price a panel, and — 0.6.0 §6.2 — per (judge model, agent
 *       arm) on a routed run, so a hybrid setup can see what grading the
 *       cheap arm cost). Previously the judge wire discarded usage
 *       entirely and `llm_judge` spend was invisible.
 *
 * 0.6.0 §6.2 — PER-MODEL GRADERS, THRESHOLDS AND JUDGES:
 *   `graders.yaml` gains `per_model:` (per grader and file-wide) binding a
 *       served ARM to its own judge, passing cut and weight, so a cheap
 *       draft is checked by a strong model. Grader resolution is therefore a
 *       function of the arm that served each SAMPLE (attributed in PR 12),
 *       not a run-level constant; `gradersHash` covers `per_model`, so
 *       introducing a map starts a new lineage by design.
 *   Judge calibration is keyed by the (agent arm, judge model) PAIR
 *       (`judge calibrate --by-model`), the loader falling back
 *       pair → spec → default. The Youden cut per pair is the shipped
 *       calibration; a false-accept-rate calibrator waits for 0.6.x, once
 *       per-arm lineage has accumulated.
 *
 * Evals Wave 3 (data lifecycle, cluster A):
 *   B14 — multi-turn samples: a sample's optional `history` seeds the
 *       default invoker's chat-loop transcript verbatim (no model calls run
 *       for history turns) before the graded final `input`. Seeded turns
 *       appear in the transcript — Wave-2 transcript-target judges see the
 *       whole conversation — but publish no trace events, so tool/token/
 *       latency metrics measure only the final turn's work, and `turns`
 *       excludes the seeded assistant messages (run-sample.ts).
 *
 * Reference: build-roadmap.md §16; AGENT-LOOPS-PLAN.md.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import type { CompiledGrader, Grader, PerModelJudgeOverride } from "@crewhaus/eval-grader";
import { perModelArmKey, perModelOverrideFor } from "@crewhaus/eval-grader";
import {
  type JudgeUsageSink,
  createJudgeGrader,
  loadCategoricalRubric,
  loadRubric,
} from "@crewhaus/eval-judge";
import type { IrV0 } from "@crewhaus/ir";
import { createLogger } from "@crewhaus/logging";
import { memoryFragmentFromIr, wireMemory } from "@crewhaus/memory-service";
import { wireModels } from "@crewhaus/model-service";
import { matchNamedFailure } from "@crewhaus/recovery-engine";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createSkillTool } from "@crewhaus/skills-registry";
import { currentTenantContext } from "@crewhaus/tenancy";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { aggregate } from "./aggregate";
import { warnUnconsumedCombinePolicy } from "./combine-warnings";
import { defaultGraderRegistry, resolveRegistryGrader } from "./default-registry";
import { RunnerError } from "./errors";
import {
  type ResumeRouting,
  assertResumeCompatible,
  loadCompletedSample,
  readRunManifest,
} from "./resume";
import {
  type EvalRoutingMode,
  type FrozenScoreboard,
  type ResolvedEvalRouting,
  armsDigest,
  freezeArmsSnapshot,
  isStaticRouting,
  parseEvalRoutingMode,
  poolArmIds,
  readLiveArms,
  resolveEvalRouting,
  resolveJudgeModelRef,
  rosterRefs,
  sampleArmId,
} from "./routing";
import { runSample } from "./run-sample";
import { createSampleOutputWriter } from "./sample-output";
import { formatSemanticFallbackWarning } from "./semantic-fallback";
import { Semaphore } from "./semaphore";
import {
  DEFAULT_SLICE_KEYS,
  computeSlices,
  sampleAbstained,
  sampleIsCanary,
  sampleNeedsReview,
} from "./slices";
import { DEFAULT_SCORE_EPSILON, meanCI95, tCritical975, wilsonCI95 } from "./stats";
import {
  TOOL_REPLAY_MISS_MARKER,
  ToolRecorder,
  type ToolReplayMissPolicy,
  ToolReplayer,
  formatReusedRecordingWarning,
  loadToolRecording,
  recordingTools,
  replayingTools,
} from "./tool-record";
import type {
  AgentInvoker,
  EvalAggregates,
  EvalChatLoopFn,
  EvalPricingFn,
  EvalRouteDecision,
  EvalRoutingConfig,
  EvalRunPartial,
  EvalRunResumed,
  EvalRunSummary,
  EvalToolRecordingConfig,
  GraderEntry,
  GraderLookup,
  JudgeCalibrationApplication,
  JudgeUsage,
  RunEvalOptions,
  SafetyViolationCounts,
  SampleMetrics,
  SampleResult,
  ServedModel,
  SliceStats,
  TrialResult,
} from "./types";
import { type SharedAgentDeps, wireRunOnce } from "./wire-once";

export type {
  AgentInvoker,
  EvalAggregates,
  EvalChatLoopFn,
  EvalPricingFn,
  EvalRouteDecision,
  EvalRoutingConfig,
  EvalRunPartial,
  EvalRunResumed,
  EvalRunSummary,
  EvalToolRecordingConfig,
  GraderEntry,
  GraderLookup,
  JudgeCalibrationApplication,
  JudgeUsage,
  RunEvalOptions,
  SafetyViolationCounts,
  SampleMetrics,
  SampleResult,
  ServedModel,
  SliceStats,
  TrialResult,
};
// 0.6.0 §6.1 (PR 12) — routed evals: the `routing` vocabulary, the frozen
// arm snapshot behind runtime-core's `_scoreboard` seam and its instrument
// digest, and the served-model / route-decision folds `run-sample` and
// `aggregate` share. See `routing.ts`.
export type { EvalRoutingMode, FrozenScoreboard, ResolvedEvalRouting };
export {
  DEFAULT_EVAL_LEARNING_SEED,
  EVAL_ROUTING_CANDIDATE_PREFIX,
  ROUTED_ARM_SEGMENT,
  armsDigest,
  candidateArmId,
  evalRoutingCandidateRef,
  foldRouteDecisions,
  foldServedModels,
  freezeArmsSnapshot,
  isStaticRouting,
  mergeServedModels,
  parseEvalRoutingMode,
  poolArmIds,
  readLiveArms,
  resolveEvalRouting,
  resolveJudgeModelRef,
  rosterRefs,
  sampleArmId,
} from "./routing";
export type { SharedAgentDeps };
export { wireRunOnce };
// B13 — metadata slice aggregation (runner-computed so bundles inherit it)
// and the A3 abstained-outcome predicate downstream consumers share.
// A2 — sampleNeedsReview is its needs-review sibling (verdict still counts).
// B18 — sampleIsCanary marks contamination tripwires (excluded like abstained).
export { DEFAULT_SLICE_KEYS, computeSlices, sampleAbstained, sampleIsCanary, sampleNeedsReview };
// A4/A5 — the shared "you declared config nothing will consume" warning.
// Every surface that PARSES the graders.yaml grammar must call it (runEval,
// createExamRunner, and the CLI's `eval --voice --graders` path), so a
// declared weight / passing_threshold is never silently dropped.
export { warnUnconsumedCombinePolicy };
// C27 — the closed-form CI helpers behind passRateCI95 / meanScoreCI95.
// NEW-stats-1 — the ONE score-shift epsilon `eval-report diff` (and its
// `--epsilon` flag) and `regression-runner`'s gate classifier both default to.
export { DEFAULT_SCORE_EPSILON, meanCI95, tCritical975, wilsonCI95 };
// Loop contract 0.4 (Batch B, G14) — the default grader registry: the six
// specialty packs + `.crewhaus/graders` plugins, shared by `runEval`'s
// fallback and the CLI/optimizer/flywheel wiring. NEW-HUNT-7 adds the
// `opts:` resolution surface (per-pack strict validation, plugin
// passthrough) and the shared `resolveRegistryGrader` substitution helper.
export {
  DefaultGraderRegistry,
  EVAL_EMBEDDER_ENV,
  defaultGraderRegistry,
  resolveRegistryGrader,
  type DefaultGraderRegistryOptions,
  type PluginGraderWithOpts,
} from "./default-registry";
// A7 — judge-backed safety classifier (env/opts-selected model, fixed
// severity rubric); A8 — vision-model OCR for imageOcrThenGrade.
export {
  EVAL_CLASSIFIER_ENV,
  judgeBackedClassifier,
  type JudgeClassifierKind,
} from "./judge-classifier";
export { EVAL_VISION_MODEL_ENV, sniffImageMediaType, visionOcr } from "./vision-ocr";
// NEW-HUNT-5 — run-level surfacing of the semantic.similarity ROUGE-L
// fallback (detection contract + the `[eval] warning:` line formatter).
export {
  SEMANTIC_FALLBACK_RATIONALE_PREFIX,
  detectSemanticFallback,
  formatSemanticFallbackWarning,
  type SemanticFallbackSummary,
} from "./semantic-fallback";
// A9 — the `calibration.abstentionAware` pack (abstention-aware
// correctness) + its cross-sample aggregation lens.
export {
  CALIBRATION_ABSTENTION_GRADER,
  CALIBRATION_RATIONALE_PREFIX,
  CalibrationAbstentionOptsSchema,
  calibrationAbstentionAware,
  detectCalibrationAggregates,
  isExplicitDecline,
  type CalibrationAbstentionOpts,
  type CalibrationAggregates,
  type CalibrationClassification,
} from "./calibration-abstention";
// A10 — the `consistency.paraphraseGroup` pack (cross-sample verdict
// consistency over `metadata.paraphrase_group`) + its aggregation lens.
export {
  PARAPHRASE_GROUP_GRADER,
  PARAPHRASE_GROUP_METADATA_KEY,
  PARAPHRASE_RATIONALE_PREFIX,
  detectParaphraseConsistency,
  paraphraseGroupConsistency,
  type ParaphraseConsistencySummary,
} from "./paraphrase-consistency";
// v0.3.0 Goal 2 (§3.3, PR 17) — the first-class competency exam: the
// reference implementation of memory-service's injected `ExamRunner` seam.
export {
  EXAM_SESSION_PREAMBLE,
  createExamRunner,
  type CreateExamRunnerOptions,
  type ExamChatLoopFn,
  type ExamChatLoopOptions,
} from "./exam";
// NEW-HUNT-4 — the tool record/replay layer (`--record-tools` /
// `--replay-tools`): the cassette format, its canonical args hashing, and the
// `RegisteredTool.execute` wrappers the default invoker installs per sample.
export {
  TOOL_RECORDING_FILENAME,
  TOOL_REPLAY_MISS_MARKER,
  ToolRecorder,
  ToolReplayer,
  canonicalJson,
  formatReusedRecordingWarning,
  hashToolArgs,
  loadToolRecording,
  recordingTools,
  replayingTools,
  toolRecordKey,
  toolReplayMissError,
  type LoadedToolRecording,
  type ReusedRecordingEntry,
  type ToolRecord,
  type ToolRecorderOptions,
  type ToolReplayMissPolicy,
} from "./tool-record";
// NEW-HUNT-6 — `--resume`: the run-manifest reader, the identity guard, and
// the per-sample reload built from artifacts a completed sample already wrote.
export {
  RUN_MANIFEST_FILENAME,
  assertResumeCompatible,
  loadCompletedSample,
  readRunManifest,
  resumeMismatches,
  sampleArtifactDirName,
  type LoadCompletedSampleArgs,
  type ResumeIdentity,
  type ResumeManifest,
  type ResumeRouting,
} from "./resume";
export { Semaphore };
// Item 20 — the per-sample, line-buffered stdout writer concurrent runs use
// so N samples never splice their tokens into one unreadable stream.
export {
  createSampleOutputWriter,
  type SampleOutputWriter,
  type SampleOutputWriterOptions,
} from "./sample-output";
export { aggregate };
export { RunnerError };
export { runSample };

const DEFAULT_CONCURRENCY = 4;

const logger = createLogger({ bindings: { module: "eval-runner" } });

/** G47 — relative location of `judge calibrate --apply`'s output. */
export const JUDGE_CALIBRATION_RELPATH = join(".crewhaus", "judge-calibration.json");

/**
 * 0.6.0 §6.2 — the key a calibration entry is filed under inside a spec's
 * `byPair` map: the AGENT ARM the samples were served by and the JUDGE MODEL
 * that graded them. One writer (`judge calibrate --by-model`) and one reader
 * (this runner) share this function so a pair written on Monday is found on
 * Tuesday; `::` is the separator because an arm id is a profile name or a
 * model string, and neither contains one.
 */
export function judgeCalibrationPairKey(arm: string, judgeModel: string): string {
  return `${arm}::${judgeModel}`;
}

/** The (judge model, agent arm) key {@link JudgeUsage.byPair} accumulates on. */
function judgeUsagePairKey(judgeModel: string, arm: string): string {
  return `${judgeModel}::${arm}`;
}

/**
 * The parsed `.crewhaus/judge-calibration.json` entry in force for a run:
 * the spec (or `default`) entry's own cut plus every (arm, judge) pair cut
 * it carries. Resolution per grader happens in {@link calibrationForPair}.
 */
type LoadedJudgeCalibration = {
  readonly specKey: string;
  /** The spec-level cut ([0,1]); absent when the entry carries pairs only. */
  readonly minScore?: number;
  /** {@link judgeCalibrationPairKey} → that pair's cut ([0,1]). */
  readonly pairs: ReadonlyMap<string, number>;
};

export type RunEvalArgs = {
  /** Lowered agent IR (target: cli). Caller is responsible for narrowing. */
  readonly ir: IrV0;
  readonly dataset: { name: string; samples: AsyncIterable<Sample> };
  readonly compiledGraders: ReadonlyArray<CompiledGrader>;
  readonly opts?: RunEvalOptions;
};

/**
 * Resolve the eval output directory. When an eval runs inside a tenant scope
 * (e.g. a cloud/managed eval), the tenant's rebased `evalRoot` is used so one
 * tenant's eval artifacts never share a directory with another's; the global
 * default is only used outside any tenant scope (#150). An explicit
 * `optsOutDir` always wins for trusted callers.
 */
export function resolveEvalOutDir(runId: string, optsOutDir?: string): string {
  if (optsOutDir !== undefined) return optsOutDir;
  const tenant = currentTenantContext()?.tenant;
  if (tenant !== undefined) return join(tenant.evalRoot, runId);
  return join(".crewhaus", "evals", runId);
}

/**
 * Execute an evaluation. Returns a summary; per-sample artifacts and
 * the summary itself are also persisted under `outDir`.
 */
export async function runEval(args: RunEvalArgs): Promise<EvalRunSummary> {
  const { ir, dataset, compiledGraders } = args;
  const opts = args.opts ?? {};

  // NEW-HUNT-4 — record and replay are two directions of one seam; asking for
  // both at once has no coherent meaning, so refuse before any spend.
  if (opts.recordToolsDir !== undefined && opts.replayToolsDir !== undefined) {
    throw new RunnerError(
      "recordToolsDir and replayToolsDir are mutually exclusive — record a run first, then replay it",
    );
  }
  if (opts.replayMiss !== undefined && opts.replayToolsDir === undefined) {
    throw new RunnerError("replayMiss is only meaningful with replayToolsDir");
  }
  // The wrappers live in the DEFAULT invoker (they wrap the tool list it
  // wires). A caller-supplied invoker owns its own tool execution, so the
  // flags would record nothing and replay nothing — say so instead.
  if (
    opts.invoker !== undefined &&
    (opts.recordToolsDir !== undefined || opts.replayToolsDir !== undefined)
  ) {
    throw new RunnerError(
      "tool record/replay requires the default invoker — a caller-supplied `invoker` executes its own tools, so the recording would be empty",
    );
  }

  // NEW-HUNT-6 — a resumed run re-opens an EXISTING run directory: the id and
  // the original start time come from its `run.json`, and the identity hashes
  // recorded there must still match this invocation's.
  const resumeDir = opts.resume === true ? opts.outDir : undefined;
  if (opts.resume === true && resumeDir === undefined) {
    throw new RunnerError("resume requires outDir — the run directory to resume into");
  }
  const resumeManifest = resumeDir !== undefined ? readRunManifest(resumeDir) : undefined;
  const resumedAt = resumeManifest !== undefined ? new Date().toISOString() : undefined;
  // The run.json resume LEDGER: every attempt that re-opened this directory,
  // oldest first. Append rather than overwrite — a scalar "last resume" loses
  // the fact that a run was resumed three times, which is exactly the thing a
  // reader of a spliced-looking run directory needs to know.
  const resumeLedger =
    resumedAt !== undefined ? [...(resumeManifest?.resumedAt ?? []), resumedAt] : undefined;
  // A resumed run keeps its ORIGINAL id — a caller pinning a DIFFERENT one is
  // asking for two contradictory things, so say so rather than quietly
  // re-labelling the directory (and orphaning its history entry).
  if (
    resumeManifest !== undefined &&
    opts.runId !== undefined &&
    opts.runId !== resumeManifest.runId
  ) {
    throw new RunnerError(
      `resume keeps the original runId ${resumeManifest.runId}, but runId ${opts.runId} was requested — drop one of the two`,
    );
  }

  const runId = resumeManifest?.runId ?? opts.runId ?? generateRunId();
  const outDir = resolveEvalOutDir(runId, opts.outDir);
  mkdirSync(outDir, { recursive: true });

  // G14 — when a graders file opts into `type: registry` and the caller
  // supplied no registry, construct the default one (six specialty packs +
  // `.crewhaus/graders` plugins) instead of refusing. An explicit
  // `opts.graderRegistry` still wins wholesale.
  let graderRegistry: GraderLookup | undefined = opts.graderRegistry;
  if (graderRegistry === undefined && compiledGraders.some((g) => g.registrySpec !== undefined)) {
    graderRegistry = await defaultGraderRegistry(opts.cwd !== undefined ? { cwd: opts.cwd } : {});
  }

  // G47 — judge calibration: load lazily, only when some `llm_judge` grader
  // actually left its gate unspecified (rubrics that declare a
  // `passing_score` are never overridden).
  const calibrationPath = join(opts.cwd ?? process.cwd(), JUDGE_CALIBRATION_RELPATH);
  // NEW-graders-2 — categorical rubrics never join the calibrated-cut path:
  // their gate is label membership, not a scalar passing_score.
  const needsCalibration = compiledGraders.some(
    (g) =>
      g.judgeSpec !== undefined &&
      g.judgeSpec.rubric.kind !== "categorical" &&
      g.judgeSpec.rubric.passing_score === undefined,
  );
  const calibration = needsCalibration
    ? loadJudgeCalibration(calibrationPath, ir.name, opts.readCalibrationFile)
    : undefined;
  const calibrationApplied: JudgeCalibrationApplication[] = [];

  // C35 — judge token metering. Every `llm_judge` grader this run builds gets
  // the same sink, and every judge model call (single verdict, each repeat,
  // each panelist) reports its provider usage through it. Accumulated per
  // model string as the run NAMED it, so the CLI can price each judge model
  // through the same table as the matrix `est_$` column. Judge-less runs
  // never allocate an entry and their results.json stays byte-identical.
  //
  // 0.6.0 §6.2 — and, on a routed run, ALSO per (judge model, agent arm):
  // "the judge cost $4" is the wrong unit once a cheap arm and a strong arm
  // are graded by different judges — the question a hybrid setup asks is what
  // the CHEAP arm's grading cost. `byModel` is unchanged (it is what the cost
  // line prices with); the pair split is additive and absent when no metered
  // call had a known arm.
  const judgeUsageByModel = new Map<string, { calls: number; input: number; output: number }>();
  const judgeUsageByPair = new Map<string, { calls: number; input: number; output: number }>();
  const meterJudgeUsageFor =
    (arm: string | undefined): JudgeUsageSink =>
    ({ model, input, output }) => {
      const acc = judgeUsageByModel.get(model) ?? { calls: 0, input: 0, output: 0 };
      judgeUsageByModel.set(model, {
        calls: acc.calls + 1,
        input: acc.input + input,
        output: acc.output + output,
      });
      if (arm === undefined) return;
      const key = judgeUsagePairKey(model, arm);
      const pair = judgeUsageByPair.get(key) ?? { calls: 0, input: 0, output: 0 };
      judgeUsageByPair.set(key, {
        calls: pair.calls + 1,
        input: pair.input + input,
        output: pair.output + output,
      });
    };
  // The arm-less sink: the registry's judge-backed classifiers and every
  // grader built for the base (no served arm) set meter through it.
  const meterJudgeUsage = meterJudgeUsageFor(undefined);
  // C35 — registry graders can make judge calls too (`safety.toxicity` /
  // `safety.bias` classify through a categorical judge). Install the SAME
  // sink on the registry — whether this run built it or the caller passed
  // one in — so their spend is metered instead of paid for invisibly.
  // Registries without the optional hook are unaffected.
  graderRegistry?.setJudgeUsageSink?.(meterJudgeUsage);

  // 0.6.0 §6.2 — resolve every `per_model.judge` reference ONCE, at run
  // start, against the spec's roster. A `$profile` ref that names nothing is
  // a loud error here rather than a silent fallback to the default judge:
  // "the cheap arm was graded by the model it was supposed to be checked
  // against" is precisely the failure per-model judging exists to prevent.
  const resolvedJudgeRefs = new Map<string, string>();
  // Every arm any `per_model:` block names (already normalized at parse), for
  // the roster cross-check below.
  const declaredPerModelArms = new Set<string>();
  for (const g of compiledGraders) {
    for (const [armKey, override] of Object.entries(g.judgeSpec?.perModel ?? {})) {
      declaredPerModelArms.add(armKey);
      if (override.judge === undefined) continue;
      const resolved = resolveJudgeModelRef(ir, override.judge);
      if (resolved === undefined) {
        const known = rosterRefs(ir);
        throw new RunnerError(
          `graders per_model "${armKey}" names judge "${override.judge}", which is no roster member of spec "${ir.name}"${
            known.length > 0
              ? ` (declared: ${known.join(", ")})`
              : " (it declares no models: registry and no model_pool)"
          } — name a models: profile, a pool candidate, or a plain model string`,
        );
      }
      resolvedJudgeRefs.set(override.judge, resolved);
    }
  }
  /** The judge model an override names, with its `$profile` ref resolved. */
  const resolvedPerModelJudge = (
    override: PerModelJudgeOverride | undefined,
  ): string | undefined =>
    override?.judge !== undefined ? resolvedJudgeRefs.get(override.judge) : undefined;

  // 0.6.0 §6.2 — the base cut each judge grader was built with, so an
  // arm-specific build only RECORDS a calibration application when the pair
  // actually moved the gate (otherwise every arm would repeat the run-level
  // entry in `run.json`).
  const baseCutByGrader = new Map<string, number>();

  // Resolve graders. Replace any `llm_judge` placeholder with a real judge
  // grader bound to the runner's judgeModel (or the per-grader override),
  // and any `registry` placeholder with the named grader from the grader
  // registry (PR 19 — loud at run start, not per-sample).
  //
  // 0.6.0 §6.2 — the resolution is now a FUNCTION of the served arm. `arm`
  // is `undefined` for the base set (every unrouted run, and any sample whose
  // arm could not be attributed), in which case this resolves exactly as it
  // did before: same judge, same cut, same weight, same arm-less usage sink.
  // With an arm it applies that arm's `per_model:` override (judge / cut /
  // weight) and the calibration entry pinned for the (arm, judge) pair.
  const buildGraders = (arm: string | undefined): GraderEntry[] =>
    compiledGraders.map((g) => {
      if (g.judgeSpec) {
        // 0.6.0 §6.2 — this arm's override, already merged (file-level under
        // grader-level) at parse time. `undefined` for every arm the map does
        // not name, and for an arm-less build.
        // (never set on a categorical entry — those reject `per_model` at
        // parse and are excluded from the file-level merge.)
        const override = perModelOverrideFor(g.judgeSpec.perModel, arm);
        const weight = override?.weight ?? g.weight;
        // NEW-graders-2 — categorical dispatch: validate through
        // `loadCategoricalRubric` (same belt-and-braces re-validation the
        // scalar path gets from `loadRubric`) and bind the label grader.
        // No G47 calibration (no scalar cut), no repeats/judges (rejected at
        // parse); temperature and target thread exactly like scalar.
        if (g.judgeSpec.rubric.kind === "categorical") {
          const categoricalRubric = loadCategoricalRubric(g.judgeSpec.rubric);
          const categoricalModel = g.judgeSpec.model ?? opts.judgeModel;
          const grader = createJudgeGrader(categoricalRubric, {
            ...(categoricalModel !== undefined ? { model: categoricalModel } : {}),
            ...(g.judgeSpec.temperature !== undefined
              ? { temperature: g.judgeSpec.temperature }
              : {}),
            ...(g.judgeSpec.target !== undefined ? { target: g.judgeSpec.target } : {}),
            ...(opts.judgeAdapter !== undefined ? { adapter: opts.judgeAdapter } : {}),
            // C35 — meter this grader's judge calls.
            onUsage: meterJudgeUsageFor(arm),
          });
          return { name: g.name, grader, weight };
        }
        let rubric = loadRubric(g.judgeSpec.rubric);
        // 0.6.0 §6.2 — the judge for THIS arm: the `per_model` override
        // (a `$profile` ref already resolved against the roster) wins over
        // the grader's own `model`, which wins over `--judge-model`.
        const model = resolvedPerModelJudge(override) ?? g.judgeSpec.model ?? opts.judgeModel;
        // G47 — an unspecified `passing_score` gates on the calibrated
        // min-score instead of the schema default (3/5). The file's [0,1] cut
        // projects onto the judge's 1–5 scale: gate = 1 + minScore·4 (the
        // judge grader compares `score >= passing` where score is 1–5 and
        // reports (score-1)/4, so this is exactly `(score-1)/4 >= minScore`).
        //
        // 0.6.0 §6.2 — the cut is now looked up for the (arm, judge) PAIR,
        // falling back pair → spec → default inside the loader. An explicit
        // per-arm `passing_score` outranks any calibration: a declared gate
        // is a decision, not a default.
        const pairCalibration =
          calibration !== undefined ? calibrationForPair(calibration, arm, model) : undefined;
        if (override?.passingScore !== undefined) {
          rubric = { ...rubric, passing_score: override.passingScore };
        } else if (
          g.judgeSpec.rubric.passing_score === undefined &&
          pairCalibration !== undefined
        ) {
          const passingScore = 1 + pairCalibration.minScore * 4;
          rubric = { ...rubric, passing_score: passingScore };
          const applied: JudgeCalibrationApplication = {
            grader: g.name,
            specKey: pairCalibration.specKey,
            minScore: pairCalibration.minScore,
            passingScore,
            ...(pairCalibration.pairKey !== undefined ? { pairKey: pairCalibration.pairKey } : {}),
            ...(arm !== undefined && pairCalibration.pairKey !== undefined ? { arm } : {}),
          };
          // Record the base build always; an arm build only when its pair cut
          // differs from the base one.
          if (arm === undefined) {
            baseCutByGrader.set(g.name, passingScore);
            calibrationApplied.push(applied);
            logger.info("judge_calibration.applied", {
              grader: g.name,
              specKey: pairCalibration.specKey,
              minScore: pairCalibration.minScore,
              passingScore,
              path: calibrationPath,
            });
          } else if (baseCutByGrader.get(g.name) !== passingScore) {
            calibrationApplied.push(applied);
            logger.info("judge_calibration.applied", {
              grader: g.name,
              arm,
              specKey: pairCalibration.specKey,
              minScore: pairCalibration.minScore,
              passingScore,
              path: calibrationPath,
            });
          }
        }
        // NEW-HUNT-2 — thread the rubric-level decoding controls through
        // (temperature defaults to the pinned 0 inside `judge`; repeats
        // defaults to a single call). A2 — a declared `judges` panel
        // overrides the single model (and --judge-model) inside the grader.
        // NEW-graders-3 — `target: transcript` makes every judge call read
        // the bounded transcript digest instead of the final output.
        const grader = createJudgeGrader(rubric, {
          ...(model !== undefined ? { model } : {}),
          ...(g.judgeSpec.judges !== undefined ? { judges: g.judgeSpec.judges } : {}),
          ...(g.judgeSpec.target !== undefined ? { target: g.judgeSpec.target } : {}),
          ...(g.judgeSpec.temperature !== undefined
            ? { temperature: g.judgeSpec.temperature }
            : {}),
          ...(g.judgeSpec.repeats !== undefined ? { repeats: g.judgeSpec.repeats } : {}),
          ...(opts.judgeAdapter !== undefined ? { adapter: opts.judgeAdapter } : {}),
          // C35 — meter this grader's judge calls (repeats and panelists each
          // report their own call, with their own model string), attributed to
          // the arm this set grades.
          onUsage: meterJudgeUsageFor(arm),
        });
        return { name: g.name, grader, weight };
      }
      if (g.registrySpec) {
        if (graderRegistry === undefined) {
          // Unreachable through the public entrypoint (the default registry
          // is constructed above) — kept for direct/partial callers.
          throw new RunnerError(
            `grader "${g.name}" resolves by registry name "${g.registrySpec.grader}" but no graderRegistry was supplied — pass RunEvalOptions.graderRegistry (and register the pack, e.g. registerContinuityGraders(registry))`,
          );
        }
        // NEW-HUNT-7 — shared with `createExamRunner` (A11): entry `opts:`
        // validate per pack / pass through to plugins; loud at run start.
        return {
          name: g.name,
          grader: resolveRegistryGrader(graderRegistry, g.name, g.registrySpec),
          weight: g.weight,
        };
      }
      return { name: g.name, grader: g.grader, weight: g.weight };
    });
  const graders: GraderEntry[] = buildGraders(undefined);

  // A4/A5 — the graders config's top-level `combine:` policy rides on the
  // compiled entries (identical on each; absent = the pre-policy `all`).
  // Warn LOUDLY at run start when `weight`/`passing_threshold` are declared
  // without `combine: weighted` (shared with the exam surface).
  const combine = compiledGraders.find((g) => g.combine !== undefined)?.combine;
  warnUnconsumedCombinePolicy(compiledGraders);

  // NEW-HUNT-3 — per-sample wall-clock timeout: `--sample-timeout-ms` wins,
  // else the spec's own `limits.deadline_ms` (in eval each sample IS one
  // agent run, so the run-deadline ceiling maps per sample). Validated
  // loudly at run start, matching the repeats guard below.
  if (
    opts.sampleTimeoutMs !== undefined &&
    (!Number.isInteger(opts.sampleTimeoutMs) || opts.sampleTimeoutMs < 1)
  ) {
    throw new RunnerError(
      `invalid sampleTimeoutMs ${JSON.stringify(opts.sampleTimeoutMs)} — must be an integer >= 1`,
    );
  }
  const sampleTimeoutMs = opts.sampleTimeoutMs ?? ir.limits?.deadlineMs;

  // NEW-HUNT-3 — run-level budget cap: `--budget-usd` wins, else the spec's
  // `budget.usd`. Eval always STOPS at the cap (never `degrade` — swapping
  // models mid-run would corrupt the measurement). Enforcement needs the
  // injected pricing seam AND a priced model; otherwise warn loudly once
  // and run un-metered rather than guessing spend.
  if (opts.budgetUsd !== undefined && (!Number.isFinite(opts.budgetUsd) || opts.budgetUsd <= 0)) {
    throw new RunnerError(
      `invalid budgetUsd ${JSON.stringify(opts.budgetUsd)} — must be a positive dollar amount`,
    );
  }
  const budgetUsd =
    opts.budgetUsd ?? (ir.budget !== undefined ? ir.budget.usdMicros / 1_000_000 : undefined);
  let budgetMicros: number | undefined;
  if (budgetUsd !== undefined) {
    const probe = opts.pricing?.(ir.agent.model, { input: 0, output: 0 });
    if (probe === undefined) {
      logger.warn("eval_budget.unpriced", {
        model: ir.agent.model,
        budgetUsd,
        reason:
          opts.pricing === undefined
            ? "no pricing seam supplied"
            : "model has no pricing row — budget cap not enforced",
      });
    } else {
      budgetMicros = Math.round(budgetUsd * 1_000_000);
    }
  }

  // NEW-HUNT-3 × NEW-HUNT-6 — the budget meter starts at ZERO on every
  // attempt, so resuming a run RE-ARMS the whole `--budget-usd` cap: a
  // $10-capped run that aborted at $10 may spend $10 more. That is a
  // defensible default (the operator asked for another attempt), but it must
  // be a STATED decision, not an accident — so every metered attempt amends
  // its cumulative spend onto `run.json` (see `amendRunManifest` below) and a
  // resume that finds earlier spend says so before it spends anything.
  const priorSpentUsd = resumeManifest?.spentUsd ?? 0;
  if (priorSpentUsd > 0 && budgetUsd !== undefined) {
    process.stderr.write(
      `[eval] warning: run ${runId} already metered $${priorSpentUsd.toFixed(4)} in earlier attempt(s); the --budget-usd $${budgetUsd.toFixed(4)} cap is re-armed for THIS attempt, so cumulative spend on this run may reach $${(priorSpentUsd + budgetUsd).toFixed(4)}. run.json's spentUsd carries the running total.\n`,
    );
  }

  // NEW-HUNT-4 — construct the cassette side ONCE per run: a recorder appends
  // to `<dir>/tools.jsonl`; a replayer indexes it (a directory with no
  // recording fails the run LOUDLY here rather than replaying all-misses).
  // The per-sample wrapping happens inside the default invoker, where the
  // sample id is known.
  let toolRecorder: ToolRecorder | undefined;
  let toolReplayer: ToolReplayer | undefined;
  let toolRecording: EvalToolRecordingConfig | undefined;
  if (opts.recordToolsDir !== undefined) {
    toolRecorder = new ToolRecorder({ dir: opts.recordToolsDir });
    toolRecording = { mode: "record", dir: opts.recordToolsDir };
  } else if (opts.replayToolsDir !== undefined) {
    const recording = loadToolRecording(opts.replayToolsDir);
    toolReplayer = new ToolReplayer(recording);
    toolRecording = {
      mode: "replay",
      dir: opts.replayToolsDir,
      recordingHash: recording.hash,
      missPolicy: opts.replayMiss ?? "error",
    };
  }
  const toolRecordingConfig = toolRecording !== undefined ? { toolRecording } : {};

  // The default invoker calls runChatLoop with the per-sample fresh
  // runContext; the watchdog wraps WHICHEVER invoker runs (default or
  // caller-supplied) so a hung provider/tool loop can't stall a slot.
  // 0.6.0 §6.1 — ROUTED EVALS. `static` (the default) resolves to nothing at
  // all, so an un-flagged run is byte-identical: no wiring, no scoreboard, no
  // `routing` block on the manifest. A routed run resolves the spec's own
  // routing (or the pinned candidate), pins `learning.seed`, and freezes an
  // arm snapshot the whole run reads from — see `routing.ts`.
  const routingMode: EvalRoutingMode = isStaticRouting(opts.routing)
    ? "static"
    : parseEvalRoutingMode(opts.routing as string);
  const routed = isStaticRouting(routingMode)
    ? undefined
    : resolveEvalRouting(ir, routingMode, opts.seed !== undefined ? { seed: opts.seed } : {});
  const routingRootDir = opts.routingRootDir ?? join(opts.cwd ?? process.cwd(), ".crewhaus");
  const warmArms = routed !== undefined && opts.warmArms === true;
  const frozenScoreboard: FrozenScoreboard | undefined =
    routed !== undefined
      ? freezeArmsSnapshot(warmArms ? readLiveArms(routingRootDir) : [])
      : undefined;
  // The routing half of the run's INSTRUMENT identity, spread into `run.json`
  // and into the resume guard. Absent on a static run, so an unrouted
  // `run.json` stays byte-identical (and reads back as `static`).
  const resumeRoutingIdentity: { routing?: ResumeRouting } =
    routed !== undefined
      ? {
          routing: {
            mode: routingMode,
            ...(routed.armId !== undefined ? { armId: routed.armId } : {}),
            ...(frozenScoreboard !== undefined ? { armsDigest: frozenScoreboard.armsDigest } : {}),
          },
        }
      : {};
  if (routed !== undefined) {
    process.stdout.write(
      `[eval] routing: ${routingMode}${routed.armId !== undefined ? ` (arm ${routed.armId})` : ""}` +
        `${routed.learningSeed !== undefined ? ` seed=${routed.learningSeed}` : ""}` +
        ` arms=${frozenScoreboard?.armsDigest ?? "-"}${warmArms ? " (warm)" : " (cold)"}\n`,
    );
  }

  // 0.6.0 §6.2 — PER-MODEL GRADING. The graders a sample is scored by are
  // resolved against the arm that SERVED it, so a cheap draft can be checked
  // by a strong judge at its own cut. The per-arm sets are built EAGERLY,
  // here, for every arm the run can route to (the pinned candidate, or the
  // pool's roster) — so `run.json`'s calibration manifest is complete before
  // the first sample runs, and so an unresolvable judge ref fails at run
  // start rather than on whichever sample happens to route to that arm.
  //
  // The whole mechanism is skipped on an unrouted run — there is no arm to
  // resolve against — so `gradersForSample` stays `undefined` and `runSample`
  // grades with the one shared set, exactly as before.
  const perModelDeclared = compiledGraders.some((g) => g.judgeSpec?.perModel !== undefined);
  if (perModelDeclared && routed === undefined) {
    process.stderr.write(
      "[eval] warning: graders.yaml declares `per_model:` judge overrides, but this run is `--routing static` — a static run has no served arm to resolve them against, so every sample is graded by the base judge. Run with `--routing as-declared` (or `--routing candidate:<arm>`) to measure per-arm judging.\n",
    );
  }
  // 0.6.0 §6.2 — a `per_model:` key naming an arm this run's roster does not
  // declare is INERT: every sample keeps the base judge at the base cut while
  // the operator believes the cheap arm is being checked by the strong one —
  // exactly the failure per-arm judging exists to prevent, and the one the
  // judge-ref resolution above is loud about. A warning rather than a throw:
  // grader sets are built lazily for arms the roster did not predict (a
  // failover-chain member, a hand-wired invoker), so an unlisted key can still
  // be legitimate.
  if (declaredPerModelArms.size > 0) {
    const knownArmIds = [
      ...(routed?.armId !== undefined ? [routed.armId] : []),
      ...(ir.agent.modelPool !== undefined ? poolArmIds(ir.agent.modelPool) : []),
    ];
    const knownKeys = new Set(knownArmIds.map(perModelArmKey));
    const unknown = [...declaredPerModelArms].filter((a) => !knownKeys.has(a)).sort();
    if (unknown.length > 0) {
      process.stderr.write(
        `[eval] warning: graders.yaml \`per_model:\` names arm(s) ${unknown.join(", ")}, which this spec's roster does not declare${
          knownArmIds.length > 0
            ? ` (known arms: ${knownArmIds.join(", ")})`
            : " (it declares no model_pool and pins no candidate)"
        } — a typo or a renamed profile grades every sample with the base judge at the base cut. Unlisted arms still grade if one actually serves (a failover-chain member, a hand-wired invoker).\n`,
      );
    }
  }
  const gradersByArm = new Map<string, ReadonlyArray<GraderEntry>>();
  // Only a ROUTED run has arms: a static one attributes nothing, so it must
  // not pay for per-arm grader sets it can never select (and must not record
  // their calibration applications in `run.json`).
  const armAwareGrading = routed !== undefined;
  if (armAwareGrading) {
    const knownArms =
      routed?.armId !== undefined
        ? [routed.armId]
        : ir.agent.modelPool !== undefined
          ? poolArmIds(ir.agent.modelPool)
          : [];
    for (const arm of knownArms) gradersByArm.set(arm, buildGraders(arm));
  }
  /**
   * The grader set for one sample: its served arm's, else the base set. Built
   * on demand for an arm the roster did not predict (a failover chain member,
   * a hand-wired invoker) so an unexpected arm still grades.
   */
  const gradersForSample = armAwareGrading
    ? (sampleRouting: {
        readonly routes?: ReadonlyArray<EvalRouteDecision>;
        readonly servedModels?: ReadonlyArray<ServedModel>;
      }): ReadonlyArray<GraderEntry> => {
        // The PIN wins over the events: a `candidate:` run routes nothing
        // (`resolveEvalRouting` builds a fragment from fallbacks/circuit
        // breaker only), so `planAttribution` stamps no `profile` and the
        // sample's served models can only name a model string — never the
        // profile the `per_model:` map is keyed on. `routed.armId` is
        // undefined under `as-declared`, so the pool path is unchanged.
        const arm = routed?.armId ?? sampleArmId(sampleRouting);
        if (arm === undefined) return graders;
        const known = gradersByArm.get(arm);
        if (known !== undefined) return known;
        const built = buildGraders(arm);
        gradersByArm.set(arm, built);
        return built;
      }
    : undefined;

  const baseInvoker =
    opts.invoker ??
    (await defaultInvoker(
      ir,
      opts,
      {
        ...(toolRecorder !== undefined ? { recorder: toolRecorder } : {}),
        ...(toolReplayer !== undefined ? { replayer: toolReplayer } : {}),
        missPolicy: opts.replayMiss ?? "error",
      },
      routed !== undefined && frozenScoreboard !== undefined
        ? { routed, scoreboard: frozenScoreboard, specName: ir.name }
        : undefined,
    ));
  const invoker =
    sampleTimeoutMs !== undefined ? withSampleTimeout(baseInvoker, sampleTimeoutMs) : baseInvoker;

  // G15 — trials per sample. Validated here so a bad flag value is a loud
  // config error at run start, never a silently-clamped surprise.
  const repeats = opts.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new RunnerError(
      `invalid repeats ${JSON.stringify(opts.repeats)} — must be an integer >= 1`,
    );
  }

  // B13 — slice keys. Same posture as repeats: a blank key is a loud config
  // error at run start, never a silently-empty slice.
  const sliceKeys = opts.sliceKeys ?? DEFAULT_SLICE_KEYS;
  if (sliceKeys.some((k) => k.trim() === "")) {
    throw new RunnerError(
      `invalid sliceKeys ${JSON.stringify(opts.sliceKeys)} — keys must be non-empty strings`,
    );
  }

  // NEW-HUNT-6 — a resumed run keeps the ORIGINAL start time (the reloaded
  // samples were graded then); `resumed.resumedAt` records this attempt's.
  const startedAt = resumeManifest?.startedAt ?? new Date().toISOString();
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const sem = new Semaphore(concurrency);

  const judgeCalibrationConfig =
    calibrationApplied.length > 0
      ? { judgeCalibration: { path: calibrationPath, applied: calibrationApplied } }
      : {};

  // NEW-HUNT-2 — record the judge sampling params (defaults resolved:
  // pinned temperature 0, single call) in the reproducibility manifest.
  // Without this the pinned-0 default is invisible: pre- and post-pin
  // run.json are indistinguishable while judge verdicts shift. Present
  // only when the run has `llm_judge` graders, so judge-less run.json /
  // results.json stay byte-identical.
  const judgeSampling = compiledGraders.flatMap((g) =>
    g.judgeSpec !== undefined
      ? [
          {
            name: g.name,
            temperature: g.judgeSpec.temperature ?? 0,
            repeats: g.judgeSpec.repeats ?? 1,
            // A2 — record the panel roster when one was declared (absent
            // otherwise, keeping single-judge entries byte-identical).
            ...(g.judgeSpec.judges !== undefined ? { judges: g.judgeSpec.judges } : {}),
            // NEW-graders-3 — record a non-default judge target (a
            // transcript-judged run is a different instrument; absent for
            // default output judging, keeping entries byte-identical).
            ...(g.judgeSpec.target !== undefined ? { target: g.judgeSpec.target } : {}),
            // 0.6.0 §6.2 — record the per-arm judge map (already merged,
            // file-level under grader-level) with its `$profile` judge refs
            // RESOLVED: a run.json that says which model actually graded
            // which arm is the point of the manifest. Absent without a
            // `per_model:` block, so existing entries stay byte-identical.
            ...(g.judgeSpec.perModel !== undefined
              ? {
                  perModel: Object.fromEntries(
                    Object.entries(g.judgeSpec.perModel)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([arm, override]) => [
                        arm,
                        {
                          ...(resolvedPerModelJudge(override) !== undefined
                            ? { judge: resolvedPerModelJudge(override) }
                            : {}),
                          ...(override.passingScore !== undefined
                            ? { passingScore: override.passingScore }
                            : {}),
                          ...(override.weight !== undefined ? { weight: override.weight } : {}),
                        },
                      ]),
                  ),
                }
              : {}),
          },
        ]
      : [],
  );
  const judgeSamplingConfig = judgeSampling.length > 0 ? { judgeSampling } : {};

  // Persist run-level config snapshot up front so SIGINT mid-run still leaves
  // a usable directory.
  const specHash = await hashSpec(ir);
  // NEW-HUNT-6 — the resume identity guard, checked BEFORE the manifest is
  // rewritten (and before any sample runs): resuming into a directory whose
  // spec, dataset or graders moved would splice two measurements together.
  if (resumeManifest !== undefined && resumeDir !== undefined) {
    assertResumeCompatible(resumeDir, resumeManifest, {
      specHash,
      ...(opts.datasetHash !== undefined ? { datasetHash: opts.datasetHash } : {}),
      ...(opts.gradersHash !== undefined ? { gradersHash: opts.gradersHash } : {}),
      // The rest of the measurement instrument: run-level overrides that live
      // in no hash (`--judge-model`, `--seed`), the trial count, and whether
      // tools faced the world or a cassette. See `resumeMismatches`.
      ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
      ...(repeats > 1 ? { repeats } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...toolRecordingConfig,
      // 0.6.0 §6.1 — routing is part of the instrument: a static run resumed
      // under `--routing as-declared` would finish its unpaid samples through
      // a pool, and a routed run resumed against a different arm or a
      // different frozen snapshot is measuring something else again.
      ...resumeRoutingIdentity,
    });
  }
  await Bun.write(
    join(outDir, "run.json"),
    JSON.stringify(
      {
        runId,
        startedAt,
        specHash,
        datasetName: dataset.name,
        ...(opts.datasetHash !== undefined ? { datasetHash: opts.datasetHash } : {}),
        ...(opts.gradersHash !== undefined ? { gradersHash: opts.gradersHash } : {}),
        graderNames: graders.map((g) => g.name),
        model: ir.agent.model,
        ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
        concurrency,
        // C33 — reproducibility manifest: which build graded this, on which
        // runtime, on what machine. `cliVersion` only when the launcher named
        // itself (see RunEvalOptions.cliVersion).
        ...(opts.cliVersion !== undefined ? { cliVersion: opts.cliVersion } : {}),
        ...runtimeManifest(),
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        ...(repeats > 1 ? { repeats } : {}),
        ...(sampleTimeoutMs !== undefined ? { sampleTimeoutMs } : {}),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...judgeSamplingConfig,
        ...judgeCalibrationConfig,
        // NEW-HUNT-4 — how tool execution was treated (absent = live tools).
        ...toolRecordingConfig,
        // 0.6.0 §6.1 — how the run was ROUTED (absent = static), so the resume
        // identity guard can refuse a static→routed (or cross-arm) resume.
        ...resumeRoutingIdentity,
        // NEW-HUNT-6 — this directory was resumed; `runId`/`startedAt` above
        // are the ORIGINAL run's. One ISO stamp per attempt, appended (the
        // typed round-trip lives in `ResumeManifest.resumedAt`), so a run
        // resumed twice still shows both attempts.
        ...(resumeLedger !== undefined ? { resumedAt: resumeLedger } : {}),
      },
      null,
      2,
    ),
  );

  // Materialize the dataset into a list so we can run samples concurrently.
  // For very large datasets the streaming loaders still avoid loading the
  // whole file into memory — but eventually all sample objects sit in RAM.
  const samples: Sample[] = [];
  for await (const s of dataset.samples) samples.push(s);
  if (samples.length === 0) {
    throw new RunnerError(`dataset "${dataset.name}" yielded zero samples`);
  }

  // NEW-HUNT-6 — resolve which samples this attempt does NOT have to pay for
  // again: every sample whose per-sample artifacts already carry a full grade
  // (all trials, under `repeats`) is reloaded from disk verbatim. Resolved
  // BEFORE the run so the reused/ran split is reportable, and so a resume of
  // an already-complete run costs exactly nothing.
  const reusedResults = new Map<string, SampleResult>();
  if (resumeManifest !== undefined) {
    for (const sample of samples) {
      const prior = loadCompletedSample({
        runDir: outDir,
        sample,
        model: ir.agent.model,
        repeats,
      });
      if (prior !== undefined) reusedResults.set(sample.id, prior);
    }
    logger.info("eval_resume.reused", {
      runId,
      runDir: outDir,
      reusedSamples: reusedResults.size,
      ranSamples: samples.length - reusedResults.size,
    });
  }

  let interrupted = false;
  const abortHandler = () => {
    interrupted = true;
  };
  process.once("SIGINT", abortHandler);

  // G54 — the spec's `failure_taxonomy`, threaded into the runner's own
  // noise auto-retry so the retry decision is CLASSIFIED: a matched entry
  // declaring `recovery: fail` is terminal by the user's own definition
  // (retrying it is futile), and any final error that matches a named
  // class carries it as `SampleResult.failureClass` for triage. The same
  // taxonomy also reaches the in-loop recovery engine via defaultInvoker.
  const taxonomy = ir.failureTaxonomy ?? [];
  const classifyFailure = (r: SampleResult): SampleResult => {
    if (r.error === undefined || taxonomy.length === 0) return r;
    const named = matchNamedFailure({ message: r.error }, taxonomy);
    return named !== undefined ? { ...r, failureClass: named.class } : r;
  };

  // NEW-HUNT-3 — budget metering state: spend accrues (via the injected
  // pricing seam) after every completed trial, and the pre-sample check
  // below aborts queued samples once accrued spend reaches the cap.
  // In-flight samples always complete — the same pre-unit posture as the
  // run path's PRE-TURN budget check.
  let spentMicros = 0;
  // NEW-HUNT-6 — reloaded samples are completed samples (they just cost this
  // attempt nothing), so the budget message's k/N counts them.
  let completedCount = reusedResults.size;
  const budgetAbortedIds = new Set<string>();

  const settled = await Promise.allSettled(
    samples.map(async (sample) => {
      // NEW-HUNT-6 — already graded in this run directory: reuse it wholesale
      // (no slot, no invoker, no judge, no spend) and let it join the union.
      // G54 — but run it back through `classifyFailure`: the taxonomy class is
      // attached AFTER `runSample` (so meta.json never carried it) and
      // `--resume` documents errored samples as reused as-is — exactly the
      // samples the taxonomy exists to triage. Without this the resumed run's
      // "[eval] failure classes:" tally silently under-reports by every reused
      // errored sample. Classification is a pure function of the recorded
      // error message, so re-deriving it costs nothing and cannot drift.
      const reused = reusedResults.get(sample.id);
      if (reused !== undefined) return classifyFailure(reused);
      const release = await sem.acquire();
      // Check *after* acquiring the slot: every callback's synchronous prefix
      // runs during `.map()` (before any SIGINT can fire), so a pre-acquire
      // check would never observe a mid-run interrupt. Samples still queued on
      // the semaphore when SIGINT arrives are skipped here as their turn comes.
      if (interrupted) {
        release();
        throw new RunnerError(`run interrupted before sample "${sample.id}"`);
      }
      // NEW-HUNT-3 — budget gate, same posture as the interrupt check: a
      // sample whose turn comes after the cap is reached aborts with the
      // documented message and lands as an errored result; the summary is
      // then marked partial (see below).
      if (budgetMicros !== undefined && spentMicros >= budgetMicros) {
        budgetAbortedIds.add(sample.id);
        release();
        throw new RunnerError(
          `[eval] budget exhausted after ${completedCount}/${samples.length} samples — ` +
            `$${(spentMicros / 1_000_000).toFixed(4)} spent >= $${(budgetMicros / 1_000_000).toFixed(4)} cap; ` +
            `sample "${sample.id}" not run`,
        );
      }
      try {
        // One trial: run the sample, then apply the bounded noise auto-retry
        // (failure-arbiter item 7): an errored SampleResult means the INVOKER
        // failed (provider timeout, 429, sandbox blip), and a graderError
        // means a GRADER threw (judge infra blip) — both are infra noise, not
        // graded failures. Retry exactly once within the run; the retried
        // outcome replaces the errored one wholesale (the second runSample
        // rewrites the same per-trial artifact dir) and is tagged
        // `retried: true` so reports and triage can tell. Skipped on SIGINT,
        // when the caller opted out (`--no-retry`), or when the error matches
        // a `failure_taxonomy` entry that declares the class terminal (G54).
        const runTrial = async (trial: number): Promise<SampleResult> => {
          const seed = opts.seed !== undefined ? opts.seed + (trial - 1) : undefined;
          const runOnce = async () => {
            const r = await runSample({
              sample,
              invoker,
              graders,
              ...(gradersForSample !== undefined ? { gradersForSample } : {}),
              outDir,
              model: ir.agent.model,
              specName: ir.name,
              ...(combine !== undefined ? { combine } : {}),
              ...(seed !== undefined ? { seed } : {}),
              ...(trial > 1 ? { trial } : {}),
              // 0.6.0 §6.1 — served-model attribution is a ROUTED-run field.
              ...(routed !== undefined ? { routed: true } : {}),
            });
            // NEW-HUNT-3 — accrue this attempt's agent-model spend toward
            // the budget cap (noise-retry attempts included — those tokens
            // were really spent even though the result is replaced).
            if (budgetMicros !== undefined) {
              spentMicros += opts.pricing?.(ir.agent.model, r.tokens) ?? 0;
            }
            return r;
          };
          const first = await runOnce();
          const infraNoise = first.error !== undefined || first.graderError !== undefined;
          if (!infraNoise || opts.retryErrors === false || interrupted) {
            return classifyFailure(first);
          }
          // NEW-HUNT-4 — a replay MISS is deterministic by construction (same
          // key, same cassette), so the one blunt noise retry would only buy a
          // second identical failure at a second model call's price. Terminal
          // for exactly the reason a `recovery: fail` taxonomy class is.
          if (first.error?.includes(TOOL_REPLAY_MISS_MARKER) === true) {
            return classifyFailure(first);
          }
          if (first.error !== undefined && taxonomy.length > 0) {
            const named = matchNamedFailure({ message: first.error }, taxonomy);
            if (named !== undefined && named.recovery === "fail") {
              return { ...first, failureClass: named.class };
            }
          }
          return classifyFailure({ ...(await runOnce()), retried: true });
        };

        // G15 — k seed-offset trials, sequential inside this sample's
        // concurrency slot. Trial 1 is the canonical SampleResult; the rest
        // contribute per-trial grades + the sample's trial pass-rate. SIGINT
        // stops scheduling further trials (the rate is over completed ones).
        const first = await runTrial(1);
        if (repeats === 1) {
          completedCount += 1;
          return first;
        }
        const results: SampleResult[] = [first];
        for (let trial = 2; trial <= repeats && !interrupted; trial++) {
          results.push(await runTrial(trial));
        }
        const trials: TrialResult[] = results.map((r, i) => ({
          trial: i + 1,
          sessionId: r.sessionId,
          ...(opts.seed !== undefined ? { seed: opts.seed + i } : {}),
          passed: r.grades.overall.passed,
          score: r.grades.overall.score,
          rationale: r.grades.overall.rationale,
          // A3 — surface per-trial abstention; the trial still counts as
          // not-passed in trialPassRate (conservative, like errored trials).
          ...(r.grades.overall.abstained === true ? { abstained: true } : {}),
          latencyMs: r.latencyMs,
          tokens: r.tokens,
          ...(r.error !== undefined ? { error: r.error } : {}),
          ...(r.graderError !== undefined ? { graderError: r.graderError } : {}),
          ...(r.retried !== undefined ? { retried: r.retried } : {}),
        }));
        const passCount = trials.filter((t) => t.passed).length;
        completedCount += 1;
        const trialPassRate = passCount / trials.length;
        // C34 — trials that disagreed = a flaky sample. Flagged on the
        // sample itself (results.json per-sample visibility) as well as
        // listed in the aggregates, which derive the same set from
        // `trialPassRate` so resumed/older results classify identically.
        return {
          ...first,
          trials,
          trialPassRate,
          ...(trialPassRate > 0 && trialPassRate < 1 ? { flaky: true } : {}),
        };
      } finally {
        release();
      }
    }),
  );

  process.removeListener("SIGINT", abortHandler);

  const results: SampleResult[] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const sample = samples[i];
    return {
      sampleId: sample?.id ?? `unknown-${i}`,
      sessionId: "(unset)",
      startedAt,
      endedAt: new Date().toISOString(),
      latencyMs: 0,
      turns: 0,
      tokens: { input: 0, output: 0 },
      model: ir.agent.model,
      agentOutput: "",
      grades: {
        overall: { passed: false, score: 0, rationale: "sample failed entirely" },
        perGrader: [],
      },
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });

  const endedAt = new Date().toISOString();
  // C35 — fold the metered judge spend onto the aggregates. Derived here (not
  // in `aggregate()`) because it is RUN-ambient rather than per-sample: judge
  // graders are built once and shared across concurrently-running samples, so
  // the honest unit of attribution is the run.
  const judgeUsage = summarizeJudgeUsage(judgeUsageByModel, judgeUsageByPair);
  const aggregates: EvalAggregates = {
    ...aggregate(results),
    ...(judgeUsage !== undefined ? { judgeUsage } : {}),
  };
  // NEW-HUNT-5 — the semantic.similarity ROUGE-L fallback fired: the run
  // graded some samples with a DIFFERENT instrument. Warn at RUN level on
  // stderr (the literal `[eval] warning:` grammar, not logger diagnostics)
  // right here in the runner, so `crewhaus eval`, compiled target-eval
  // bundles, and every other runEval caller inherit it without per-surface
  // wiring. The per-sample rationale prefix stays untouched.
  if (aggregates.semanticFallback !== undefined) {
    process.stderr.write(`${formatSemanticFallbackWarning(aggregates.semanticFallback)}\n`);
  }
  // NEW-HUNT-4 — a replay served an ALREADY-CONSUMED recording entry: the
  // replayed trajectory called a tool more times than the recording did, so
  // it diverged and was fed a stale result. Same posture as the NEW-HUNT-5
  // fallback above — a run-level `[eval] warning:` naming the affected calls,
  // inherited by every runEval caller — plus a `reusedEntries` count on the
  // manifest's `toolRecording` block, so the divergence is on the record and
  // not just on the console.
  const reusedRecordingEntries = toolReplayer?.reusedEntries ?? [];
  if (toolReplayer !== undefined) {
    const reusedWarning = formatReusedRecordingWarning(
      reusedRecordingEntries,
      toolReplayer.recording.path,
    );
    if (reusedWarning !== undefined) process.stderr.write(`${reusedWarning}\n`);
  }
  const finalToolRecording: EvalToolRecordingConfig | undefined =
    toolRecording !== undefined
      ? {
          ...toolRecording,
          ...(reusedRecordingEntries.length > 0
            ? { reusedEntries: reusedRecordingEntries.length }
            : {}),
        }
      : undefined;
  const finalToolRecordingConfig =
    finalToolRecording !== undefined ? { toolRecording: finalToolRecording } : {};

  // B13 — per-slice aggregates over the samples' string metadata values.
  // Absent when nothing sliced, keeping metadata-less runs byte-identical.
  const slices = computeSlices(results, sliceKeys);

  // NEW-HUNT-3 — mark the summary partial when the budget cap aborted
  // queued samples: completed samples keep their real grades, aborted ones
  // are the errored results carrying the budget message above.
  const partial: EvalRunPartial | undefined =
    budgetAbortedIds.size > 0 && budgetUsd !== undefined
      ? {
          reason: "budget_exhausted",
          completedSamples: samples.length - budgetAbortedIds.size,
          totalSamples: samples.length,
          spentUsd: spentMicros / 1_000_000,
          budgetUsd,
        }
      : undefined;

  // NEW-HUNT-6 — the resume ledger: what this attempt reloaded vs ran.
  const resumed: EvalRunResumed | undefined =
    resumedAt !== undefined
      ? {
          runDir: outDir,
          resumedAt,
          reusedSamples: reusedResults.size,
          ranSamples: samples.length - reusedResults.size,
        }
      : undefined;

  // 0.6.0 §6.1 — the routing manifest. `armsDigest` is the run's INSTRUMENT
  // identity (two different arm snapshots are two different instruments); the
  // live arms are re-read HERE so a concurrent harness mutating `arms.jsonl`
  // mid-run is reported instead of silently changing what the digest names.
  // The measurement itself is unaffected — the snapshot was frozen at start.
  let routingConfig: { routing: EvalRoutingConfig } | Record<string, never> = {};
  if (routed !== undefined && frozenScoreboard !== undefined) {
    let armsMutated = false;
    if (warmArms) {
      try {
        armsMutated = armsDigest(readLiveArms(routingRootDir)) !== frozenScoreboard.armsDigest;
      } catch {
        armsMutated = false; // an unreadable store is not evidence of a mutation
      }
      if (armsMutated) {
        process.stderr.write(
          `[eval] warning: ${join(routingRootDir, "routing", "arms.jsonl")} changed while this run was in flight — the run itself routed off the frozen snapshot (${frozenScoreboard.armsDigest}), but that digest no longer describes the harness on disk.\n`,
        );
      }
    }
    const policyVersions = new Set(
      results
        .flatMap((r) => (r.routes ?? []).map((d) => d.policyVersion))
        .filter((v): v is string => v !== undefined),
    );
    // §6.1 — the frozen board's captured WRITES. `record()` is a no-op sink,
    // but what it was handed is the run's per-arm reward/quality signal, and
    // discarding it would throw away the only observation the routed run
    // produced. Recorded on the manifest (the run-level home for a run-level
    // capture) rather than per-sample `meta.json`, which carries the sample's
    // own `routes` lines.
    const observations = frozenScoreboard.observations();
    const ungradedArms = frozenScoreboard.ungradedArms();
    // §6.1 — DEGENERACY. A cold snapshot answers n=0 for every arm, so a
    // `learned` policy keeps the first under-sampled candidate for every
    // sample, and a warm one draws on `(seed, turnIndex, band, arm)` — the
    // same tuple for every single-turn sample. Either way an `as-declared`
    // run can route the WHOLE dataset to one arm, which does not measure what
    // production serves. Say so, loudly and on the artifact, instead of
    // shipping the number as if it were a routed measurement.
    const decisions = results.flatMap((r) => r.routes ?? []);
    const armsRouted = new Set(decisions.map((d) => d.arm));
    const routableArms =
      ir.agent.modelPool !== undefined ? poolArmIds(ir.agent.modelPool).length : 0;
    const degenerateArm =
      routingMode === "as-declared" &&
      decisions.length > 0 &&
      armsRouted.size === 1 &&
      routableArms > 1
        ? ([...armsRouted][0] as string)
        : undefined;
    if (degenerateArm !== undefined) {
      process.stderr.write(
        `[eval] warning: the frozen arm snapshot routed all ${decisions.length} decision(s) to "${degenerateArm}" — this run measured ONE arm, not the ${routableArms}-arm roster. Pass --warm-arms so the board has statistics to choose on, or measure each arm on its own with \`eval --models pool --record\`.\n`,
      );
    }
    routingConfig = {
      routing: {
        mode: routingMode,
        ...(routed.armId !== undefined ? { armId: routed.armId } : {}),
        armsDigest: frozenScoreboard.armsDigest,
        ...(warmArms ? { warmArms: true } : {}),
        ...(armsMutated ? { armsMutated: true } : {}),
        ...(routed.learningSeed !== undefined ? { learningSeed: routed.learningSeed } : {}),
        ...(policyVersions.size === 1 ? { policyVersion: [...policyVersions][0] as string } : {}),
        ...(degenerateArm !== undefined ? { degenerate: true, degenerateArm } : {}),
        ...(observations.length > 0 ? { observations } : {}),
        ...(ungradedArms.length > 0 ? { ungraded: ungradedArms } : {}),
      },
    };
  }

  const summary: EvalRunSummary = {
    runId,
    startedAt,
    endedAt,
    samples: results,
    aggregates,
    ...(slices !== undefined ? { slices } : {}),
    ...(partial !== undefined ? { partial } : {}),
    ...(resumed !== undefined ? { resumed } : {}),
    config: {
      specHash,
      datasetName: dataset.name,
      ...(opts.datasetHash !== undefined ? { datasetHash: opts.datasetHash } : {}),
      ...(opts.gradersHash !== undefined ? { gradersHash: opts.gradersHash } : {}),
      graderNames: graders.map((g) => g.name),
      model: ir.agent.model,
      ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
      concurrency,
      // C33 — mirrors run.json: the manifest rides results.json too, so a run
      // directory read on its own still says which build/runtime produced it.
      ...(opts.cliVersion !== undefined ? { cliVersion: opts.cliVersion } : {}),
      ...runtimeManifest(),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(repeats > 1 ? { repeats } : {}),
      ...(sampleTimeoutMs !== undefined ? { sampleTimeoutMs } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      ...judgeSamplingConfig,
      ...judgeCalibrationConfig,
      // NEW-HUNT-4 — mirrors run.json: a replayed run is gated and pinned
      // like any other, and this is where it says its tools came from a
      // cassette (and which one), plus how often the replay had to reuse an
      // exhausted entry.
      ...finalToolRecordingConfig,
      ...routingConfig,
    },
    outDir,
  };

  await Bun.write(join(outDir, "results.json"), JSON.stringify(summary, null, 2));
  // The two figures only knowable once the run FINISHED, merged into the
  // run.json written before the first sample: cumulative metered spend
  // (so a resume can say the cap is being re-armed) and the replay's
  // reused-entry count. Read-modify-write, so a run killed before this point
  // still leaves the pre-run manifest exactly as it was.
  await amendRunManifest(outDir, {
    ...(priorSpentUsd + spentMicros / 1_000_000 > 0
      ? { spentUsd: priorSpentUsd + spentMicros / 1_000_000 }
      : {}),
    ...finalToolRecordingConfig,
  });

  return summary;
}

/**
 * Merge post-run figures into `<outDir>/run.json`. Best-effort by design: a
 * missing or torn manifest is left alone (results.json already carries every
 * field), because failing a completed, paid-for run over a bookkeeping write
 * would be the worse outcome.
 */
async function amendRunManifest(
  outDir: string,
  patch: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const path = join(outDir, "run.json");
  let base: Record<string, unknown>;
  try {
    base = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
  } catch {
    return;
  }
  if (base === null || typeof base !== "object") return;
  await Bun.write(path, JSON.stringify({ ...base, ...patch }, null, 2));
}

/**
 * C35 — fold the per-model judge metering into the run-level
 * {@link JudgeUsage} block, or `undefined` when the run made no judge calls
 * (keeping judge-less results.json byte-identical). Model keys are sorted so
 * two runs with the same spend produce byte-identical JSON.
 */
function summarizeJudgeUsage(
  byModel: ReadonlyMap<string, { calls: number; input: number; output: number }>,
  byPair: ReadonlyMap<string, { calls: number; input: number; output: number }> = new Map(),
): JudgeUsage | undefined {
  if (byModel.size === 0) return undefined;
  let calls = 0;
  let input = 0;
  let output = 0;
  const sorted: Record<string, { calls: number; input: number; output: number }> = {};
  for (const model of [...byModel.keys()].sort()) {
    const m = byModel.get(model) as { calls: number; input: number; output: number };
    sorted[model] = m;
    calls += m.calls;
    input += m.input;
    output += m.output;
  }
  // 0.6.0 §6.2 — the (judge model, agent arm) split, sorted so two runs with
  // the same spend produce byte-identical JSON, and ABSENT when no metered
  // call carried an arm (every unrouted run).
  const pairs = [...byPair.keys()].sort().map((key) => {
    const [judgeModel = "", arm = ""] = key.split("::");
    const u = byPair.get(key) as { calls: number; input: number; output: number };
    return { judgeModel, arm, calls: u.calls, input: u.input, output: u.output };
  });
  return {
    calls,
    tokens: { input, output },
    byModel: sorted,
    ...(pairs.length > 0 ? { byPair: pairs } : {}),
  };
}

/**
 * C33 — the environment half of the reproducibility manifest: the Bun build
 * and machine the run executed on. `Bun.version` is guarded because this
 * package is importable from a plain-Node consumer, where the global is
 * absent (the field is then simply omitted, never faked).
 */
function runtimeManifest(): { bunVersion?: string; platform: string } {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  return {
    ...(typeof bun?.version === "string" ? { bunVersion: bun.version } : {}),
    platform: `${process.platform}-${process.arch}`,
  };
}

/**
 * G47 — read `.crewhaus/judge-calibration.json` (written by `judge
 * calibrate --apply`) and pick the entry for this spec's name, falling
 * back to the file's `"default"` entry. A missing file is a normal
 * no-calibration state; a malformed file or entry is a logged warning and
 * a no-calibration state — a stale calibration artifact must never abort
 * an eval run, but it must not fail silently either.
 */
function loadJudgeCalibration(
  path: string,
  specName: string,
  read?: (path: string) => string | undefined,
): LoadedJudgeCalibration | undefined {
  const readFile = read ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : undefined));
  const text = readFile(path);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn("judge_calibration.malformed", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const calibrations = (parsed as { calibrations?: unknown } | null)?.calibrations;
  if (calibrations === null || typeof calibrations !== "object") {
    logger.warn("judge_calibration.malformed", { path, error: "missing calibrations record" });
    return undefined;
  }
  const record = calibrations as Record<
    string,
    { minScore?: unknown; byPair?: unknown } | undefined
  >;
  const specKey = record[specName] !== undefined ? specName : "default";
  const entry = record[specKey];
  if (entry === undefined) return undefined;
  // 0.6.0 §6.2 — the per-(arm, judge) cuts `judge calibrate --by-model`
  // writes. Each is validated on its own: one malformed pair is skipped with
  // a warning rather than discarding a whole file's calibration.
  const pairs = new Map<string, number>();
  const byPair = entry.byPair;
  if (byPair !== null && typeof byPair === "object") {
    for (const [pairKey, value] of Object.entries(byPair as Record<string, unknown>)) {
      const pairMin = (value as { minScore?: unknown } | null)?.minScore;
      if (!isCalibrationCut(pairMin)) {
        logger.warn("judge_calibration.malformed", {
          path,
          specKey,
          pairKey,
          error: `minScore must be a number in [0,1], got ${JSON.stringify(pairMin)}`,
        });
        continue;
      }
      pairs.set(pairKey, pairMin);
    }
  }
  const minScore = entry.minScore;
  if (!isCalibrationCut(minScore)) {
    // A spec-level cut that is present-but-broken (or missing with no pairs
    // to fall back on) is the pre-0.6.0 no-calibration state, warned about.
    if (pairs.size === 0) {
      logger.warn("judge_calibration.malformed", {
        path,
        specKey,
        error: `minScore must be a number in [0,1], got ${JSON.stringify(minScore)}`,
      });
      return undefined;
    }
    return { specKey, pairs };
  }
  return { specKey, minScore, pairs };
}

/** A calibration cut is a finite number in [0,1] — the file's own units. */
function isCalibrationCut(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * 0.6.0 §6.2 — the cut in force for one (agent arm, judge model) pair,
 * falling back **pair → spec → default**: the pair entry under the selected
 * spec (or `default`) entry wins, then that entry's own spec-level cut. An
 * arm-less build (every unrouted run) never matches a pair, so it resolves
 * exactly as it did before this key existed.
 */
function calibrationForPair(
  calibration: LoadedJudgeCalibration,
  arm: string | undefined,
  judgeModel: string | undefined,
): { minScore: number; specKey: string; pairKey?: string } | undefined {
  if (arm !== undefined && judgeModel !== undefined) {
    const pairKey = judgeCalibrationPairKey(arm, judgeModel);
    const pairMin = calibration.pairs.get(pairKey);
    if (pairMin !== undefined) {
      return { minScore: pairMin, specKey: calibration.specKey, pairKey };
    }
  }
  if (calibration.minScore === undefined) return undefined;
  return { minScore: calibration.minScore, specKey: calibration.specKey };
}

/**
 * NEW-HUNT-3 — per-sample wall-clock watchdog around the agent invocation.
 * Invoker-agnostic (default runChatLoop wrapper, target-eval bundles, test
 * stubs alike): when the invocation outlives `timeoutMs` the wrapped call
 * rejects with a clear timed-out error — which `runSample` records as a
 * normal errored result with full artifacts — instead of stalling its
 * concurrency slot forever. The losing invocation keeps running detached;
 * its eventual settlement lands on an already-settled promise (a no-op).
 */
function withSampleTimeout(invoker: AgentInvoker, timeoutMs: number): AgentInvoker {
  return (req) =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(
          new RunnerError(
            `sample "${req.sample.id}" timed out after ${timeoutMs}ms (per-sample timeout — --sample-timeout-ms, or the spec's limits.deadline_ms)`,
          ),
        );
      }, timeoutMs);
      invoker(req).then(
        (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
}

/**
 * NEW-HUNT-4 — the tool-execution interception the default invoker installs
 * per sample. Exactly one of `recorder` / `replayer` is ever set (runEval
 * refuses both); absent both ⇒ the tool list is handed to the chat loop
 * untouched, byte-identical to a pre-NEW-HUNT-4 run.
 */
type ToolCassette = {
  readonly recorder?: ToolRecorder;
  readonly replayer?: ToolReplayer;
  readonly missPolicy: ToolReplayMissPolicy;
};

/**
 * 0.6.0 §6.1 — the routed half of the default invoker's wiring: the resolved
 * routing plus the FROZEN scoreboard every sample reads from. Absent ⇒ the
 * pre-0.6.0 single-model path, byte-identical.
 */
type EvalRoutingWiring = {
  readonly routed: ResolvedEvalRouting;
  readonly scoreboard: FrozenScoreboard;
  readonly specName: string;
};

async function defaultInvoker(
  ir: IrV0,
  opts: RunEvalOptions,
  cassette: ToolCassette = { missPolicy: "error" },
  routing?: EvalRoutingWiring,
): Promise<AgentInvoker> {
  const wired: SharedAgentDeps = await wireRunOnce(
    ir,
    opts.cwd !== undefined ? { cwd: opts.cwd } : {},
  );
  // The session runner: `runChatLoop` in production, an injected stub under
  // `RunEvalOptions.chatLoop` (tests pin the options — including the wrapped
  // tools below — without a process-global module mock).
  const chatLoop: EvalChatLoopFn = opts.chatLoop ?? runChatLoop;
  // v0.3.0 §7.2 — eval/optimizer state ISOLATION. When the IR carries the
  // memory fabric (an enabled `memory` block and/or `continuity`, which is
  // DEFAULT-ON on the cli shape since 0.3.0), each sample gets its OWN
  // ephemeral stores rooted under its per-sample artifact directory
  // (`.crewhaus/evals/<runId>/<sampleId>/.crewhaus/…`): plan/focus/handoff/
  // facts written by sample N must never leak into sample N+1 — Pillar 2
  // assumes spec patches are the only cross-run channel. The per-sample
  // `sessionRootDir` doubles as the fabric's session-log root so proof
  // evidence resolves against the sample's own transcript, and `homeDir`
  // is pinned inside the sample dir so the operator's `~/.crewhaus` skills
  // can never bleed into a measurement.
  const fabricOn =
    (ir.memory !== undefined && ir.memory.enabled !== false) || ir.continuity !== undefined;
  // Item 20 — concurrent samples all drive `runChatLoop`, which streams the
  // model's token deltas to stdout. Unprefixed, N of them on one file
  // descriptor splice mid-word ("TheThe capital of Brazil is …capital of
  // Japan is…"). Above 1 sample in flight, each run gets its OWN
  // line-buffered, sample-tagged sink; a sequential run keeps raw stdout so
  // its output stays byte-identical to `crewhaus run`.
  const fanOut = (opts.concurrency ?? DEFAULT_CONCURRENCY) > 1;
  // NEW-HUNT-3 — the per-sample deadline the chat loop arms in-loop:
  // flag > spec `limits.deadline_ms` (the same precedence as the runner's
  // outer watchdog, so the two timers agree on the ceiling).
  const sampleDeadlineMs = opts.sampleTimeoutMs ?? ir.limits?.deadlineMs;
  // 0.6.0 §6.1 — the routing options the chat loop receives. `wireModels` is
  // the SAME composition root `crewhaus run` and every emitter go through, so
  // a routed eval measures the routing production serves rather than a
  // hand-mirrored copy of it. The frozen scoreboard rides the `_scoreboard`
  // seam (whose doc comment now names the eval runner as a production
  // consumer) so the router reads statistics but records nothing.
  const routingOptions: Partial<Parameters<typeof runChatLoop>[0]> =
    routing === undefined
      ? {}
      : {
          ...(routing.routed.fragment !== undefined
            ? wireModels(routing.routed.fragment, { sessionName: routing.specName })
            : {}),
          ...(routing.routed.params?.thinking !== undefined
            ? { thinking: routing.routed.params.thinking }
            : {}),
          ...(routing.routed.params?.maxTokens !== undefined
            ? { maxTokens: routing.routed.params.maxTokens }
            : {}),
          ...(routing.routed.params?.temperature !== undefined
            ? { temperature: routing.routed.params.temperature }
            : {}),
          _scoreboard: routing.scoreboard,
        };
  // A pinned candidate is measured on ITS model and ITS `instructions`
  // overlay — the same expansion a `model: $<profile>` slot gets at lower
  // time, applied here because the eval pins the slot after lowering.
  const routedModel = routing?.routed.model ?? wired.model;
  const routedInstructions =
    routing?.routed.overlay !== undefined
      ? `${routing.routed.overlay}\n\n${wired.instructions}`
      : wired.instructions;
  return async (req) => {
    let tools: RegisteredTool[] = [...wired.tools];
    let skills = wired.skills;
    let slashCommands = wired.slashCommands;
    let memoryOpt: Parameters<typeof runChatLoop>[0]["memory"];
    let continuityOpt: Parameters<typeof runChatLoop>[0]["continuity"];
    if (fabricOn) {
      const memWired = await wireMemory(memoryFragmentFromIr(ir), {
        catalog: {
          register: (tool) => {
            tools.push(tool);
          },
        },
        cwd: req.sessionRootDir,
        sessionRootDir: req.sessionRootDir,
        homeDir: req.sessionRootDir,
      });
      memoryOpt = memWired.options.memory;
      continuityOpt = memWired.options.continuity;
      if (memWired.options.skills !== undefined) {
        // The fabric owns the skill surface (builtin `continuity` skill at
        // lowest precedence): replace any Skill tool wireRunOnce registered
        // so the tool list never advertises two.
        skills = memWired.options.skills;
        tools = tools.filter((t) => t.name !== "Skill");
        if (skills.length > 0) tools.push(createSkillTool(skills));
      }
      if (memWired.options.slashCommands !== undefined) {
        slashCommands = memWired.options.slashCommands;
      }
    }
    // NEW-HUNT-4 — install the cassette on THIS sample's final tool list (the
    // wired stack plus whatever the memory fabric registered), so the key's
    // sampleId is the sample actually calling. Absent a cassette the array is
    // handed over untouched.
    if (cassette.recorder !== undefined) {
      tools = recordingTools(tools, req.sample.id, cassette.recorder);
    } else if (cassette.replayer !== undefined) {
      tools = replayingTools(tools, req.sample.id, cassette.replayer, cassette.missPolicy);
    }
    const sampleOut = fanOut ? createSampleOutputWriter({ label: req.sample.id }) : undefined;
    try {
      const agentOutput = await chatLoop({
        ...routingOptions,
        model: routedModel,
        instructions: routedInstructions,
        tools,
        hooks: wired.hooks,
        skills,
        slashCommands,
        ...(wired.subAgents !== undefined && wired.spawnSubAgent !== undefined
          ? { subAgents: wired.subAgents, spawnSubAgent: wired.spawnSubAgent }
          : {}),
        ...(memoryOpt !== undefined ? { memory: memoryOpt } : {}),
        ...(continuityOpt !== undefined ? { continuity: continuityOpt } : {}),
        permissionRules: wired.permissionRules,
        permissionMode: "auto",
        // G54 — the spec's `failure_taxonomy` reaches the IN-LOOP recovery
        // engine (recovery-engine's matcher runs before its built-in
        // classify+recover flow), exactly as `crewhaus run` wires it: a
        // user-named transient class gets its declared classified recovery
        // inside the loop instead of dying and burning the runner's one
        // blunt noise retry. IrFailureTaxonomyEntry is structurally the
        // engine's NamedFailureClass, so it threads verbatim.
        ...(ir.failureTaxonomy !== undefined && ir.failureTaxonomy.length > 0
          ? { failureTaxonomy: ir.failureTaxonomy }
          : {}),
        // Item 20 — this sample's own stdout sink while others run beside it.
        ...(sampleOut !== undefined ? { stdout: (chunk: string) => sampleOut.write(chunk) } : {}),
        // NEW-HUNT-3 — the spec's `limits:` ceilings reach the IN-LOOP
        // runtime exactly as `crewhaus run` threads them (the loop-contract
        // option-name mapping): max_tool_iterations / max_concurrent_tools /
        // context_limit / turn_timeout_ms / model_call_timeout_ms /
        // loop_detection, plus deadline_ms as the per-sample run deadline
        // (`--sample-timeout-ms` overrides it — same value the runner's
        // outer watchdog enforces). Absent block ⇒ nothing spread, runtime
        // defaults stay authoritative (byte-identical behavior).
        ...(ir.limits?.maxToolIterations !== undefined
          ? { maxToolIterations: ir.limits.maxToolIterations }
          : {}),
        ...(ir.limits?.maxConcurrentTools !== undefined
          ? { maxConcurrentTools: ir.limits.maxConcurrentTools }
          : {}),
        ...(ir.limits?.contextLimit !== undefined ? { contextLimit: ir.limits.contextLimit } : {}),
        ...(sampleDeadlineMs !== undefined ? { deadlineMs: sampleDeadlineMs } : {}),
        ...(ir.limits?.turnTimeoutMs !== undefined
          ? { turnTimeoutMs: ir.limits.turnTimeoutMs }
          : {}),
        ...(ir.limits?.modelCallTimeoutMs !== undefined
          ? { modelCallTimeoutMs: ir.limits.modelCallTimeoutMs }
          : {}),
        ...(ir.limits?.loopDetection !== undefined
          ? { loopDetection: ir.limits.loopDetection }
          : {}),
        sessionName: `${wired.sessionName}_${req.sample.id}`,
        sessionTarget: wired.sessionTarget,
        runContext: req.runContext,
        sessionRootDir: req.sessionRootDir,
        singleTurn: true,
        // B14 — a multi-turn sample's `history` seeds the conversation
        // VERBATIM: the chat loop logs each seeded message straight into the
        // session transcript (transcript-target judges see them) and makes
        // NO model calls for history turns — the required `input` is the one
        // graded final user message, MT-Bench style. History-less samples
        // keep the exact single-message seed as before.
        seedMessages: [...(req.sample.history ?? []), { role: "user", content: req.sample.input }],
      });
      return { agentOutput };
    } finally {
      // A sample that ended mid-line (or threw) still surfaces its tail.
      sampleOut?.end();
    }
  };
}

function generateRunId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `run_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function hashSpec(ir: IrV0): Promise<string> {
  const text = JSON.stringify({
    name: ir.name,
    target: ir.target,
    model: ir.agent.model,
    instructions: ir.agent.instructions,
    tools: ir.tools,
  });
  return Bun.hash(text).toString(16);
}
