import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult, Grader } from "@crewhaus/eval-grader";
import type { JudgeUsageSink } from "@crewhaus/eval-judge";
import type { Event as TranscriptEvent } from "@crewhaus/event-log";
import type { RunContext } from "@crewhaus/run-context";
import type { runChatLoop } from "@crewhaus/runtime-core";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import type { CalibrationAggregates } from "./calibration-abstention";
import type { ParaphraseConsistencySummary } from "./paraphrase-consistency";
import type { SemanticFallbackSummary } from "./semantic-fallback";
import type { ToolReplayMissPolicy } from "./tool-record";

/**
 * The agent-invocation contract. The runner provides a per-sample
 * `RunContext` (fresh `TraceEventBus`, fresh `sessionId`) and the
 * destination directory for the event log. The invoker is responsible
 * for actually running the chat loop and returning the assistant text.
 *
 * In production this is a thin wrapper around `runChatLoop`. In tests it's
 * a deterministic stub that returns a canned answer per sample.
 */
export type AgentInvoker = (req: AgentInvokeRequest) => Promise<AgentInvokeResult>;

export type AgentInvokeRequest = {
  readonly sample: Sample;
  readonly runContext: RunContext;
  /** Where the runtime should write the per-sample event-log JSONL. */
  readonly sessionRootDir: string;
  readonly seed?: number;
};

export type AgentInvokeResult = {
  /** Final assistant text returned by the chat loop. */
  readonly agentOutput: string;
  /**
   * If the invoker has out-of-band knowledge (e.g. a stub), it can supply
   * the captured event-log entries here. The default invoker reads them
   * from disk after `runChatLoop` returns.
   */
  readonly transcript?: ReadonlyArray<TranscriptEvent>;
  /** Same as transcript — invoker can short-circuit the bus subscription. */
  readonly events?: ReadonlyArray<TraceEvent>;
};

/**
 * Loop contract 0.4 (Batch B, G56) — per-sample loop-quality metrics
 * extracted from the sample's captured trace events. Always emitted by new
 * runs; optional in the type because `results.json` written by older CLIs
 * lacks the field (readers must tolerate its absence).
 */
export type SampleMetrics = {
  /**
   * `expected_tools` coverage: |unique expected ∩ unique called| / |unique
   * expected|, over the sample's `tool_call_end` events. Absent when the
   * sample declares no `expected_tools` (coverage of nothing is undefined,
   * not 1.0).
   */
  readonly toolCallAccuracy?: number;
  /**
   * Human-intervention points: RESOLVED ask decisions — `permission_decision`
   * events carrying `askOutcome` (in an eval's `permissionMode: "auto"`,
   * every ask auto-resolves to `denied`; interactive invokers may approve).
   */
  readonly interventions: number;
  readonly safetyViolations: SafetyViolationCounts;
  /**
   * One entry per `model_response` event (`durationMs`) so run-level
   * per-model-call latency percentiles can be computed in `aggregate()`.
   */
  readonly modelCallLatenciesMs: ReadonlyArray<number>;
};

/**
 * G56 — safety-violation counts. The three buckets are DISJOINT:
 * an `egress-blocked` decision counts only as an egress block (its
 * `decision` is also `"deny"`), a deny carrying `judgeModel` counts only as
 * a justification rejection, and `permissionDenials` is every remaining
 * plain deny. Ask decisions that auto-resolve to `denied` are counted as
 * interventions (see {@link SampleMetrics.interventions}), never as
 * denials.
 */
export type SafetyViolationCounts = {
  readonly permissionDenials: number;
  readonly egressBlocks: number;
  readonly justificationRejections: number;
  readonly total: number;
};

/**
 * G15 — one trial of a repeated sample (`RunEvalOptions.repeats` > 1).
 * `trial` is 1-based; trial 1 is the canonical run whose full
 * `SampleResult` fields (grades, tokens, metrics, …) the sample reports —
 * exactly the run a `repeats: 1` eval would have produced. Full per-trial
 * detail (perGrader grades, transcript, events) lives in the trial's own
 * artifact directory (`<sampleId>.trial<N>` for N ≥ 2).
 */
export type TrialResult = {
  /** 1-based trial index; trial 1 is the canonical result. */
  readonly trial: number;
  readonly sessionId: string;
  /** The seed-offset seed this trial ran with (`opts.seed + trial - 1`);
   *  absent when the run declared no seed (trials are i.i.d. draws). */
  readonly seed?: number;
  readonly passed: boolean;
  readonly score: number;
  readonly rationale: string;
  /** A3 — this trial's outcome was `abstained` (judge declined, nothing
   *  else failed). `passed: false` is then the conservative placeholder;
   *  `trialPassRate` still counts the trial as not-passed. */
  readonly abstained?: boolean;
  readonly latencyMs: number;
  readonly tokens: { input: number; output: number };
  readonly error?: string;
  readonly graderError?: string;
  readonly retried?: boolean;
};

export type SampleResult = {
  readonly sampleId: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly latencyMs: number;
  readonly turns: number;
  readonly tokens: { input: number; output: number };
  readonly model: string;
  readonly agentOutput: string;
  /**
   * B13 — the dataset sample's `metadata`, carried verbatim into the result
   * so slice aggregation (and any results.json consumer) can group by
   * difficulty/family/language/source without re-joining the dataset.
   * Absent when the sample declared none, and on results persisted by older
   * CLIs.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly grades: { overall: GradeResult; perGrader: Array<{ name: string } & GradeResult> };
  /** G56 — loop-quality metrics from the sample's trace events. Always set
   *  by new runs; absent on results persisted by older CLIs. */
  readonly metrics?: SampleMetrics;
  /**
   * G15 — per-trial grades when `RunEvalOptions.repeats` > 1 (one entry per
   * trial, trial 1 first). Absent on single-trial runs so their
   * `results.json` stays shaped exactly as before.
   */
  readonly trials?: ReadonlyArray<TrialResult>;
  /** G15 — fraction of this sample's trials that passed (over the trials
   *  that actually ran; SIGINT can truncate). Present iff `trials` is. */
  readonly trialPassRate?: number;
  /**
   * C34 — this sample is FLAKY: its trials disagreed with each other
   * (`0 < trialPassRate < 1`), so its recorded verdict is a coin flip and
   * the strict any-flip gate will keep re-failing on it for reasons the
   * agent did not cause. Set only on repeat runs (`repeats > 1`); absent on
   * single-trial samples, on all-pass/all-fail samples, and on results
   * persisted by older CLIs.
   */
  readonly flaky?: boolean;
  readonly error?: string;
  /**
   * Set when one or more GRADERS threw while grading this sample (judge
   * provider 429/timeout, rubric fetch failure, …) — grader infrastructure
   * noise, distinct from `error` (the INVOKER failed) and from an honest
   * graded failure. The thrown grader still contributes a failed
   * `perGrader` entry (rationale `grader threw: …`), so `grades.overall`
   * fails; this field preserves the structured evidence so the retry loop
   * can retry the sample and triage can classify the failure as noise.
   */
  readonly graderError?: string;
  /**
   * True when this result replaced an ERRORED first attempt via the runner's
   * bounded noise retry (see {@link RunEvalOptions.retryErrors}) — invoker
   * errors and grader throws (`graderError`) alike. Set on the retried
   * outcome regardless of whether the retry passed or errored again; absent
   * on samples that succeeded (or failed grading) on attempt one.
   */
  readonly retried?: boolean;
  /**
   * G54 — the spec's `failure_taxonomy` class the (final) invoker `error`
   * matched, via recovery-engine's `matchNamedFailure`. Present only when
   * the sample still ends in an error AND the IR carries a taxonomy whose
   * pattern matches it. A matched class declaring `recovery: fail` also
   * SUPPRESSES the noise auto-retry — the user declared the error terminal,
   * so re-running it is futile by definition.
   */
  readonly failureClass?: string;
};

/**
 * The aggregate block of {@link EvalRunSummary}. Fields past `errorCount`
 * are Loop contract 0.4 (Batch B) additions — always emitted by new runs
 * but optional in the type because older persisted `results.json` files
 * lack them (eval-report renders those runs without the new columns).
 */
export type EvalAggregates = {
  readonly passRate: number;
  readonly meanScore: number;
  readonly p50Turns: number;
  readonly p95Turns: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly totalTokens: { input: number; output: number };
  readonly errorCount: number;
  /**
   * G56 — mean `grades.overall.score` over ALL samples, errored ones
   * included (they score 0). Differs from `meanScore`, which averages only
   * non-errored samples: `partialScoreMean` is the run-level partial-credit
   * figure with a stable denominator, comparable across runs with different
   * error counts.
   */
  readonly partialScoreMean?: number;
  /** G56 — fraction of samples with ≥ 1 resolved ask (human-intervention
   *  point). See {@link SampleMetrics.interventions}. */
  readonly interventionRate?: number;
  /** G56 — safety-violation counts summed across samples (canonical trials). */
  readonly safetyViolations?: SafetyViolationCounts;
  /** G56 — p50 over every individual model call's `durationMs` (canonical
   *  trials). Complements the per-SAMPLE `p50LatencyMs`. */
  readonly p50ModelCallMs?: number;
  readonly p95ModelCallMs?: number;
  /** G56 — mean per-sample `expected_tools` coverage, over the samples that
   *  declare `expected_tools`. Absent when no sample does. */
  readonly toolCallAccuracy?: number;
  /**
   * G15 — pass@k: fraction of samples where AT LEAST ONE of the k trials
   * passed (the optimistic capability metric). Present iff the run carried
   * trials (`repeats` > 1); equals `passRate` at k = 1 by definition.
   */
  readonly passAtK?: number;
  /**
   * G15 — pass^k ("pass hat k", tau-bench's reliability metric): the mean
   * over samples of [ALL k trials passed]. With exactly k i.i.d. trials per
   * sample this is the empirical estimate of the probability that k
   * consecutive runs all succeed — a flaky 60%-reliable agent scores
   * 0.6^k, clearly separated from a deterministic one. Present iff the run
   * carried trials.
   */
  readonly passHatK?: number;
  /**
   * G15 — token spend across EVERY trial (canonical `totalTokens` counts
   * only trial 1 so it stays comparable with single-trial runs; this field
   * makes the k× real cost of a repeated run visible). Present iff the run
   * carried trials.
   */
  readonly totalTokensAllTrials?: { input: number; output: number };
  /**
   * C27 — closed-form Wilson 95% interval on `passRate` as `[lo, hi]`.
   * Emitted by new runs whenever the graded denominator is non-zero; absent
   * on results persisted by older CLIs (readers must tolerate absence).
   */
  readonly passRateCI95?: readonly [number, number];
  /**
   * C27 — Student t 95% interval on `meanScore` as `[lo, hi]`. Present when
   * at least two samples were scored (the sample variance needs n ≥ 2).
   */
  readonly meanScoreCI95?: readonly [number, number];
  /**
   * A3 — count of samples whose outcome was `abstained` (judge declined to
   * score, nothing else failed): excluded from the `passRate` denominator
   * and from `meanScore`, routed to human review instead. Present (with
   * {@link needsHumanSampleIds}) only when at least one sample abstained,
   * so abstention-free runs keep their exact pre-A3 shape.
   */
  readonly needsHuman?: number;
  /** A3 — the abstained samples' ids, for `crewhaus rate` follow-up.
   *  Present iff {@link needsHuman} is. */
  readonly needsHumanSampleIds?: ReadonlyArray<string>;
  /**
   * A2 — count of samples flagged for human review by a high-entropy
   * judge-panel vote split (`needsReview` on the overall grade). LISTED
   * SEPARATELY from the abstained needs-human bucket: these verdicts are
   * real and stay in the `passRate` denominator — the flag only says the
   * panel nearly split on them. Present (with
   * {@link needsReviewSampleIds}) only when at least one sample was
   * flagged, so panel-free runs keep their exact pre-A2 shape.
   */
  readonly needsReview?: number;
  /** A2 — the flagged samples' ids. Present iff {@link needsReview} is. */
  readonly needsReviewSampleIds?: ReadonlyArray<string>;
  /**
   * B18 — count of contamination-canary samples in the run
   * (`metadata.source: "canary"`, injected by `crewhaus datasets put
   * --canary`). Their verdicts are meaningless by construction (nonsense
   * hex input, no gold), so like the abstained bucket they are excluded
   * from the `passRate` denominator and `meanScore` and listed here
   * instead — disjoint from (and winning over) the needs-human/
   * needs-review buckets. Present (with {@link canarySampleIds}) only when
   * the run carried at least one canary, so canary-free runs keep their
   * exact prior shape.
   */
  readonly canary?: number;
  /** B18 — the canary samples' ids. Present iff {@link canary} is. */
  readonly canarySampleIds?: ReadonlyArray<string>;
  /**
   * A12 — per-criterion mean judge scores, keyed grader name → criterion →
   * mean of the raw 1–5 criterion scores over the samples that grader
   * scored (abstained verdicts carry no breakdown and are excluded).
   * Present only when at least one grade carried a `detail` breakdown.
   */
  readonly criterionMeans?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /**
   * NEW-HUNT-5 — present iff at least one sample was graded by
   * `semantic.similarity`'s ROUGE-L fallback (embedder error mid-run): the
   * affected sample ids and the embedder error, mirrored by the runner's
   * `[eval] warning:` stderr line. Such a run measured with a DIFFERENT
   * instrument on those samples — treat its scores as not comparable with
   * embedder-graded runs. Absent on fallback-free runs (byte-identical
   * results.json) and on results persisted by older CLIs.
   */
  readonly semanticFallback?: SemanticFallbackSummary;
  /**
   * A9 — abstention-aware accuracy lens (answerRate / abstentionRate /
   * accuracyWhenAnswered), present iff the run declared the
   * `calibration.abstentionAware` registry pack and it classified at least
   * one non-errored sample (detected via its stable rationale marker at
   * aggregation). Absent otherwise — pack-less runs keep a byte-identical
   * results.json — and on results persisted by older CLIs.
   */
  readonly calibration?: CalibrationAggregates;
  /**
   * A10 — cross-sample paraphrase-consistency lens, present iff the run
   * declared the `consistency.paraphraseGroup` registry pack AND at least
   * one sample carries a string `metadata.paraphrase_group`. Groups are
   * scored on agreement with the group-majority verdict (singletons = 1.0
   * — never NaN); absent groups = absent aggregate, keeping opted-out runs
   * byte-identical.
   */
  readonly paraphraseConsistency?: ParaphraseConsistencySummary;
  /**
   * C34 — samples whose trials disagreed (`0 < trialPassRate < 1`): the run
   * MEASURED instability instead of just reporting pass^k. Present (with
   * {@link flakySampleIds}) only when a repeat run actually found flaky
   * samples, so single-trial and stable runs keep a byte-identical
   * results.json.
   */
  readonly flaky?: number;
  /** C34 — the flaky samples' ids, worst (most balanced) first. Present iff
   *  {@link flaky} is. */
  readonly flakySampleIds?: ReadonlyArray<string>;
  /**
   * C35 — judge token spend for this run (see {@link JudgeUsage}): every
   * `llm_judge` grader call plus the judge-backed registry classifiers
   * (`safety.toxicity` / `safety.bias`). Judge calls are model calls the
   * eval pays for; before this field their usage was discarded at the judge
   * wire, so a run's REAL cost — often judge-dominated — was unknowable.
   * Present only when at least one judge call was metered, keeping
   * judge-less runs byte-identical.
   */
  readonly judgeUsage?: JudgeUsage;
};

/**
 * C35 — judge/grader model-call token usage for one run. `byModel` keys on
 * the model string as the run NAMED it (router grammar), so the CLI can
 * price each judge model through the same pricing table as the `--models`
 * matrix `est_$` column instead of guessing one model for the whole run
 * (a `judges:` panel legitimately spans several).
 *
 * Covered: every `llm_judge` grader call (single verdicts, repeats, each
 * panelist) and the judge-backed safety classifiers `safety.toxicity` /
 * `safety.bias`, which meter through the registry's
 * {@link GraderLookup.setJudgeUsageSink} hook. NOT covered: grader model
 * calls that are not judge calls — today only `multimodal.imageOcrThenGrade`,
 * which calls a vision model through a raw adapter stream — and any
 * custom/plugin grader that calls a model itself.
 *
 * Scope note: a RESUMED run meters only the judge calls THIS attempt made —
 * reloaded samples were graded (and paid for) in an earlier attempt.
 */
export type JudgeUsage = {
  /** Judge model calls made (repeats and panelists each count once). */
  readonly calls: number;
  readonly tokens: { readonly input: number; readonly output: number };
  readonly byModel: Readonly<
    Record<string, { readonly calls: number; readonly input: number; readonly output: number }>
  >;
};

/**
 * B13 — one slice's aggregate figures. `passRate`/`meanScore` mirror the
 * run-level semantics (abstained samples out of the denominator, errored
 * samples failing); `sampleCount` is the slice's full membership.
 */
export type SliceStats = {
  readonly sampleCount: number;
  readonly passRate: number;
  readonly meanScore: number;
};

/**
 * G47 — one applied judge-calibration entry: a `llm_judge` grader whose
 * rubric declared no `passing_score`, gated instead by the calibrated
 * min-score from `.crewhaus/judge-calibration.json` (`judge calibrate
 * --apply`). `minScore` is the file's [0,1] cut; `passingScore` is its
 * projection onto the judge's 1–5 scale (`1 + minScore·4`), the gate
 * actually installed on the rubric.
 */
export type JudgeCalibrationApplication = {
  readonly grader: string;
  /** Which calibration entry keyed the cut: the spec's name, or "default". */
  readonly specKey: string;
  readonly minScore: number;
  readonly passingScore: number;
};

/**
 * NEW-HUNT-3 — projects a model's run cost from token totals, in USD
 * micro-dollars (1 USD = 1_000_000, cost-tracker's metering unit). Returns
 * `undefined` when the model has no pricing row — the budget cap is then
 * unenforceable and the runner warns instead of guessing. Injected (rather
 * than importing `@crewhaus/cost-tracker` + the model-router grammar here)
 * for the same reason eval-report's `MatrixPricingFn` is: the CLI wires the
 * real lookup, and the two share one source of truth.
 */
export type EvalPricingFn = (
  model: string,
  tokens: { readonly input: number; readonly output: number },
) => number | undefined;

/**
 * NEW-HUNT-3 — why a run recorded fewer graded samples than the dataset
 * held. Present on `EvalRunSummary`/`results.json` only when the run-level
 * budget cap fired: samples still queued when accrued spend reached the cap
 * were aborted (each recorded as an errored sample carrying the
 * `[eval] budget exhausted after k/N samples` message), while completed
 * samples keep their real grades. Additive — absent on full runs and on
 * results persisted by older CLIs.
 */
export type EvalRunPartial = {
  readonly reason: "budget_exhausted";
  /** Samples that actually ran (graded or honestly errored). */
  readonly completedSamples: number;
  readonly totalSamples: number;
  /** Accrued agent-model spend when the run stopped scheduling samples. */
  readonly spentUsd: number;
  /** The cap in force (`--budget-usd` flag, else the spec's `budget.usd`). */
  readonly budgetUsd: number;
};

/**
 * NEW-HUNT-4 — how this run treated TOOL EXECUTION, recorded in `run.json`
 * and `results.json`. Absent on ordinary runs (every tool ran live), so an
 * un-flagged run's manifests stay byte-identical.
 *
 * A replayed run is still a normal run for the history index, the baseline
 * pin and the gate — the manifest is what says its tool results came from a
 * cassette rather than from the world, and {@link recordingHash} identifies
 * WHICH cassette.
 */
export type EvalToolRecordingConfig = {
  readonly mode: "record" | "replay";
  /** The recording directory (`--record-tools` / `--replay-tools`). */
  readonly dir: string;
  /** Replay only — sha256 hex of the recording's `tools.jsonl` bytes. */
  readonly recordingHash?: string;
  /** Replay only — `--replay-miss`, the policy for unrecorded calls. */
  readonly missPolicy?: ToolReplayMissPolicy;
  /**
   * Replay only — how many calls were served a recording entry that had
   * ALREADY been consumed (the replayed trajectory called a tool more times
   * than the recording did, so it diverged and got a stale result). Absent
   * when zero, keeping a clean replay's manifests byte-identical. The runner
   * also raises a run-level `[eval] warning:` naming the affected calls.
   */
  readonly reusedEntries?: number;
};

/**
 * NEW-HUNT-6 — present iff this run was produced by `eval --resume <runDir>`:
 * the run kept its ORIGINAL `runId` and `startedAt`, reloaded
 * {@link reusedSamples} already-graded samples from the directory's per-sample
 * artifacts, and only invoked the agent for {@link ranSamples}. Absent on
 * ordinary runs.
 */
export type EvalRunResumed = {
  readonly runDir: string;
  /** When THIS attempt started (the run's own `startedAt` is the original). */
  readonly resumedAt: string;
  /** Samples reloaded from disk — no agent call, no judge call, no spend. */
  readonly reusedSamples: number;
  /** Samples this attempt actually ran. */
  readonly ranSamples: number;
};

export type EvalRunSummary = {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly samples: ReadonlyArray<SampleResult>;
  readonly aggregates: EvalAggregates;
  /**
   * NEW-HUNT-3 — present iff the run-level budget cap aborted queued
   * samples (see {@link EvalRunPartial}). Readers must tolerate absence.
   */
  readonly partial?: EvalRunPartial;
  /**
   * NEW-HUNT-6 — present iff this run was resumed (see {@link EvalRunResumed}).
   */
  readonly resumed?: EvalRunResumed;
  /**
   * B13 — per-slice aggregates, keyed slice key → metadata value →
   * {@link SliceStats}. Computed by the runner (so target-eval bundles
   * inherit them) over the keys from `RunEvalOptions.sliceKeys` (default
   * family/difficulty/language/source), applied only where present in
   * sample metadata as strings. Absent when nothing sliced.
   */
  readonly slices?: Readonly<Record<string, Readonly<Record<string, SliceStats>>>>;
  readonly config: {
    readonly specHash: string;
    readonly datasetName: string;
    /** sha256 of the dataset file bytes, when the caller supplied one. */
    readonly datasetHash?: string;
    /** sha256 of the parsed GradersConfig, when the caller supplied one. */
    readonly gradersHash?: string;
    readonly graderNames: ReadonlyArray<string>;
    readonly model: string;
    readonly judgeModel?: string;
    readonly concurrency: number;
    /**
     * C33 (reproducibility manifest) — the CLI build that produced this run,
     * as reported by `crewhaus version`. Supplied by the launcher
     * ({@link RunEvalOptions.cliVersion}); absent when the caller did not
     * name itself (library callers, older CLIs). A results.json graded by
     * 0.3 and one graded by 0.4 are different measurements — this is what
     * says which.
     */
    readonly cliVersion?: string;
    /** C33 — the Bun runtime the run executed on (`Bun.version`). Absent
     *  outside Bun. */
    readonly bunVersion?: string;
    /** C33 — the machine the run executed on, `<platform>-<arch>` (e.g.
     *  `darwin-arm64`) — the environment half of the report's minimum
     *  reproducibility bundle. */
    readonly platform?: string;
    readonly seed?: number;
    /** G15 — trials per sample. Recorded only when > 1. */
    readonly repeats?: number;
    /** NEW-HUNT-3 — the per-sample wall-clock timeout in force (flag, else
     *  the spec's `limits.deadline_ms`). Recorded only when one applied. */
    readonly sampleTimeoutMs?: number;
    /** NEW-HUNT-3 — the run-level budget cap declared (flag, else the
     *  spec's `budget.usd`). Recorded even when pricing was unavailable
     *  and the cap therefore could not be enforced. */
    readonly budgetUsd?: number;
    /** NEW-HUNT-2 — the judge sampling params in force, one entry per
     *  `llm_judge` grader with the defaults RESOLVED (pinned temperature 0,
     *  repeats 1), so the reproducibility manifest records exactly how
     *  judge verdicts were decoded — the pin default would otherwise be
     *  invisible across the upgrade that introduced it. Present only when
     *  the run had `llm_judge` graders. */
    readonly judgeSampling?: ReadonlyArray<{
      readonly name: string;
      readonly temperature: number;
      readonly repeats: number;
      /** A2 — the judge panel models when the grader declared `judges:`
       *  (repeats then apply per panelist). Absent on single-judge
       *  graders, keeping their entries byte-identical. */
      readonly judges?: ReadonlyArray<string>;
      /** NEW-graders-3 — recorded when the grader judged the run
       *  `transcript` instead of the final output (measurement-instrument
       *  identity: an output-judged and a transcript-judged run are not
       *  the same measurement). Absent on default output-judged graders,
       *  keeping their entries byte-identical. */
      readonly target?: "output" | "transcript";
    }>;
    /** G47 — present when at least one `llm_judge` grader's gate came from
     *  the calibration file rather than a rubric-declared `passing_score`. */
    readonly judgeCalibration?: {
      readonly path: string;
      readonly applied: ReadonlyArray<JudgeCalibrationApplication>;
    };
    /** NEW-HUNT-4 — the tool record/replay mode in force, when either
     *  `--record-tools` or `--replay-tools` was given (absent otherwise —
     *  see {@link EvalToolRecordingConfig}). */
    readonly toolRecording?: EvalToolRecordingConfig;
  };
  readonly outDir: string;
};

/**
 * Structural view of `@crewhaus/grader-registry`'s `GraderRegistry` — the
 * lookup the runner needs to resolve `type: registry` grader entries, plus
 * an optional `list` used purely to enrich lookup-failure messages with
 * the registered vocabulary. Kept structural so callers can hand in any
 * lookup-shaped object.
 */
export type GraderLookup = {
  lookup(name: string): Grader;
  list?(): ReadonlyArray<string>;
  /**
   * NEW-HUNT-7 — resolve a name WITH the graders.yaml entry's `opts`
   * record. The default registry implements it (per-pack strict
   * validation; untouched passthrough to plugin graders); a caller
   * registry that omits it makes any `opts:`-carrying entry a loud
   * RunnerError at run start — opts are never silently dropped.
   */
  resolveWithOpts?(name: string, opts: Readonly<Record<string, unknown>>): Grader;
  /**
   * C35 — receive the run's judge-token sink. Registry graders that make
   * JUDGE calls (`safety.toxicity` / `safety.bias`, whose classifier is a
   * categorical judge call) meter through it, so their spend lands in
   * {@link JudgeUsage} and on the `[eval] cost:` line instead of being paid
   * for invisibly. `runEval` calls it on whatever registry it uses — its
   * own, or one the caller built and passed in. Optional: a registry that
   * omits it simply does not meter, exactly as before.
   */
  setJudgeUsageSink?(sink: JudgeUsageSink): void;
};

export type RunEvalOptions = {
  readonly runId?: string;
  readonly concurrency?: number;
  readonly seed?: number;
  readonly outDir?: string;
  readonly judgeModel?: string;
  readonly invoker?: AgentInvoker;
  readonly cwd?: string;
  /**
   * v0.3.0 §7.3 (PR 19) — resolves `type: registry` grader entries by name.
   * An eval config opts into registered grader packs (`continuity.*` after
   * `registerContinuityGraders`, `twelve.*` after `register12MetricRubric`)
   * without this package importing them; omitting the registry while the
   * config carries a registry entry is a loud `RunnerError` at run start.
   */
  readonly graderRegistry?: GraderLookup;
  /**
   * Retry a sample ONCE, within the run, when its result is an ERROR
   * (`SampleResult.error` — the INVOKER failed: provider timeout, 429,
   * sandbox blip) or a GRADER threw (`SampleResult.graderError` — judge
   * infra noise; the agent may have answered fine). Infra noise, not a
   * graded failure. The retried outcome replaces the errored one wholesale
   * (per-sample artifacts included) and is tagged `retried: true`.
   * Default: true. `crewhaus eval --no-retry` opts out. Interrupted runs
   * (SIGINT) never retry.
   */
  readonly retryErrors?: boolean;
  /**
   * Content hash (sha256 hex) of the dataset file the samples came from.
   * Purely informational — persisted into `run.json` / `results.json` so
   * downstream consumers (run-history index, dataset-drift detection) can
   * tell whether two runs saw byte-identical data.
   */
  readonly datasetHash?: string;
  /**
   * Content hash (sha256 hex) of the parsed GradersConfig the graders came
   * from. Mirrors {@link datasetHash}: purely informational, persisted into
   * `run.json` / `results.json` so downstream consumers (notably the item-30
   * sentinel) can tell whether two runs graded with byte-identical config —
   * a changed rubric/threshold must not be misattributed to provider drift.
   */
  readonly gradersHash?: string;
  /**
   * G15 — trials per sample (integer ≥ 1, default 1). At k > 1 each sample
   * runs k seed-offset trials (trial t gets `seed + t - 1` when `seed` is
   * set; i.i.d. draws otherwise): trial 1 is the canonical
   * {@link SampleResult}, the rest land in `SampleResult.trials`, and
   * `aggregate()` adds pass@k / pass^k. Trials run sequentially inside the
   * sample's concurrency slot, so a k-repeat run takes ~k× the wall clock
   * and spend of a single-trial run.
   */
  readonly repeats?: number;
  /**
   * B13 — metadata keys to slice the results by (`crewhaus eval --slice`).
   * Defaults to family/difficulty/language/source; each key applies only to
   * samples carrying it in metadata as a string. Keys must be non-empty —
   * a blank key is a loud config error at run start.
   */
  readonly sliceKeys?: ReadonlyArray<string>;
  /**
   * NEW-HUNT-3 — per-sample wall-clock timeout in ms (`--sample-timeout-ms`).
   * Bounds each sample's AGENT INVOCATION (grading is not covered): a sample
   * exceeding it records an errored `SampleResult` (its artifacts still
   * persist) instead of stalling a concurrency slot forever. Overrides the
   * spec's `limits.deadline_ms`, which is the default when this is absent;
   * absent both ⇒ no watchdog, today's exact behavior. Must be a positive
   * integer — validated loudly at run start.
   */
  readonly sampleTimeoutMs?: number;
  /**
   * NEW-HUNT-3 — run-level spend cap in USD (`--budget-usd`). Overrides the
   * spec's `budget.usd` (the default when absent; eval always STOPS at the
   * cap — the block's `on_exceed: degrade` ladder never applies to a
   * measurement run, since swapping models mid-eval would corrupt the
   * measurement). Spend accrues per completed sample via {@link pricing};
   * once accrued spend reaches the cap, queued samples abort with a
   * `[eval] budget exhausted after k/N samples` error, in-flight samples
   * complete, and the summary is marked {@link EvalRunSummary.partial}.
   * Judge/grader calls are metered separately ({@link JudgeUsage}, C35) but
   * are deliberately EXCLUDED from this cap: the budget bounds AGENT spend,
   * the quantity a spec's `budget.usd` block declares, so wiring a judge
   * into a rubric can never silently shrink the sample budget of an existing
   * run. A model without a pricing row disables enforcement with a warning.
   */
  readonly budgetUsd?: number;
  /**
   * NEW-HUNT-3 — the cost seam budget metering charges through (see
   * {@link EvalPricingFn}). The CLI passes the same lookup that prices the
   * `--models` matrix `est_$` column; omitted ⇒ the budget cap (if any)
   * cannot be enforced and the runner warns.
   */
  readonly pricing?: EvalPricingFn;
  /**
   * G47 — injectable read seam for `.crewhaus/judge-calibration.json`.
   * Receives the resolved path; returns the file text, or undefined when
   * the file does not exist. Defaults to reading from disk under
   * `opts.cwd`. Tests inject a stub so calibration behaviour is assertable
   * without touching the filesystem.
   */
  readonly readCalibrationFile?: (path: string) => string | undefined;
  /**
   * NEW-HUNT-4 — record every tool execution into `<dir>/tools.jsonl`, keyed
   * by `(sampleId, toolName, sha256(canonical-JSON args))`. Additive: tools
   * still execute for real and return their real results; the run only gains
   * a cassette (and a `toolRecording` note in `run.json`). Mutually exclusive
   * with {@link replayToolsDir}, and only meaningful under the DEFAULT invoker
   * — a caller-supplied {@link invoker} owns its own tool execution, so
   * combining them is a loud error rather than a silently empty recording.
   */
  readonly recordToolsDir?: string;
  /**
   * NEW-HUNT-4 — serve every tool execution from the recording in `<dir>`
   * instead of running it: deterministic, credential-free, side-effect-free
   * tool behaviour. Unrecorded calls follow {@link replayMiss}. The model
   * still runs live — this replays TOOLS, not the agent.
   */
  readonly replayToolsDir?: string;
  /**
   * NEW-HUNT-4 — what a replay does when the recording has no entry for a
   * call's key: `"error"` (default) fails the sample with a message naming
   * the missing key; `"live"` executes the tool for real. Only valid with
   * {@link replayToolsDir}.
   */
  readonly replayMiss?: ToolReplayMissPolicy;
  /**
   * NEW-HUNT-6 — resume the interrupted run whose directory is {@link outDir}
   * (required with this flag): the run's `run.json` supplies the ORIGINAL
   * `runId`/`startedAt`, its identity hashes are checked against this
   * invocation's (a mismatch refuses loudly), samples that already wrote
   * `grades.json` are reloaded instead of re-run, and the union is
   * re-aggregated into fresh `results.json`.
   */
  readonly resume?: boolean;
  /**
   * Session-runner seam under the DEFAULT invoker (the exam runner's
   * `chatLoop` pattern). Production callers omit it and get
   * `runChatLoop`; tests inject a capturing stub so the invoker's wiring —
   * including the NEW-HUNT-4 tool wrappers on the `tools` it hands over — is
   * assertable without a process-global module mock.
   */
  readonly chatLoop?: EvalChatLoopFn;
  /**
   * C33 — the launcher's own version string, recorded verbatim into
   * `run.json`/`results.json` as `config.cliVersion` (the CLI passes what
   * `crewhaus version` prints). Omitted ⇒ the field is absent — never
   * guessed here, because this package cannot know which binary invoked it.
   */
  readonly cliVersion?: string;
  /**
   * Injectable judge transport (tests / bespoke judge stacks): a pre-built
   * ProviderAdapter every `llm_judge` grader this run builds is bound to,
   * exactly like `JudgeOptions.adapter` and `CreateExamRunnerOptions.
   * judgeAdapter`. Absent (every production caller): each judge call
   * resolves its model through the model-router. The seam exists so judge
   * behaviour — including C35 token metering — is assertable over a stub
   * adapter with no process-global `mock.module` involved.
   */
  readonly judgeAdapter?: ProviderAdapter;
};

/** The chat-loop seam under {@link RunEvalOptions.chatLoop}. */
export type EvalChatLoopFn = (opts: Parameters<typeof runChatLoop>[0]) => Promise<string>;

export type GraderEntry = {
  readonly name: string;
  readonly grader: Grader;
  /** A4 — this grader's contribution under `combine: weighted` (positive,
   *  default 1). Ignored by the `all`/`any` combination modes. */
  readonly weight?: number;
};
