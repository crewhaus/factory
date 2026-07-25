import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult, Grader } from "@crewhaus/eval-grader";
import type { Event as TranscriptEvent } from "@crewhaus/event-log";
import type { RunContext } from "@crewhaus/run-context";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

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
   * A12 — per-criterion mean judge scores, keyed grader name → criterion →
   * mean of the raw 1–5 criterion scores over the samples that grader
   * scored (abstained verdicts carry no breakdown and are excluded).
   * Present only when at least one grade carried a `detail` breakdown.
   */
  readonly criterionMeans?: Readonly<Record<string, Readonly<Record<string, number>>>>;
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
    }>;
    /** G47 — present when at least one `llm_judge` grader's gate came from
     *  the calibration file rather than a rubric-declared `passing_score`. */
    readonly judgeCalibration?: {
      readonly path: string;
      readonly applied: ReadonlyArray<JudgeCalibrationApplication>;
    };
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
   * Judge/grader calls are NOT metered (their usage is not yet captured);
   * a model without a pricing row disables enforcement with a warning.
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
};

export type GraderEntry = {
  readonly name: string;
  readonly grader: Grader;
  /** A4 — this grader's contribution under `combine: weighted` (positive,
   *  default 1). Ignored by the `all`/`any` combination modes. */
  readonly weight?: number;
};
