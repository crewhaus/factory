/**
 * M3 · EVALS — the quality lab: the typed launcher, matrix runs, CI suites,
 * trends, the sample-size planner, judge calibration, grader tooling,
 * redteam, coverage, the drift sentinel, voice replays, the optimizer, the
 * flywheel, experiments, and the annotation → distill join.
 *
 * STUBS. Owned by the Evals+Data implementer together with `data-ops.ts` and
 * `feedback-ops.ts`. The M1/M2 read side (`evals.ts`, `actions.ts`'s
 * baseline pin) stays where it is.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN EVAL CONSOLE GETS WRONG IF IT IS NOT CAREFUL
 * ---------------------------------------------------------------------------
 *   - PARTIAL RUNS ARE NOT REGRESSIONS. A run that ended early renders
 *     deflated and must never be charted as a score drop. Replayed runs are
 *     badged not-live. `readRunIndexLatest` collapses resumed runs — read
 *     through it, not the raw index.
 *   - DATASET FILTERS ARE UNION-AWARE. `datasetFilterMatches` makes `smoke`
 *     match `smoke+regressions@vX`; a naive equality filter silently hides
 *     every regression-unioned run.
 *   - MATRIX CELLS LIVE OUTSIDE RUN HISTORY. They are `<out>/<slug>/` dirs,
 *     not index rows. `cellCrashReason` classes are ACTIONABLE states:
 *     billing ("add credits" — a real out-of-funds 429 is NOT retryable),
 *     systemic ("check model + credentials"), transient (offer Retry).
 *   - JUDGE SPEND OFTEN DOMINATES. Trends must separate `agentCostUsd` from
 *     `judgeCostUsd`; one blended number hides where the money went.
 *   - THE BASELINE'S LINEAGE WARNINGS ARE UI STATES. specSource name
 *     collision, gradersHash/judgeModel instrument change, and dataset
 *     keyset change are first-class banners, not buried stderr.
 *   - THE TEST SPLIT IS LOCKED. `--allow-test-split` is a visibly gated
 *     release-flow gesture with a burn count, never a convenience flag.
 *   - SENTINEL ATTRIBUTION IS CONDITIONAL. A flip is provider drift ONLY
 *     when specHash + datasetHash + gradersHash + judgeModel all match the
 *     frozen baseline. Otherwise say what changed instead.
 *   - THE FLYWHEEL'S DATASET PRECEDENCE IS A TRAP: a conventional
 *     `eval/dataset.jsonl` SHADOWS `registry:<spec>-ratings`. Warn on it.
 *
 * Every run here is WORK, so every run goes through the job queue with argv
 * built from this module's closed vocabulary (`jobArg` per interpolated
 * value). Live progress is the `[eval]` stdout block streamed through the
 * existing run feed — M3 adds no second streaming mechanism.
 *
 * Implementation reuses `@crewhaus/eval-report` (already a dependency);
 * suites/optimizer/redteam/coverage artifacts are read from their out-dirs
 * with the same caps and containment checks as every other reader here.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `POST /api/h/:id/evals/run` — the typed eval launcher.
 *
 * Body: `{ dataset?, graders?, gate?, repeats?, seed?, models?, slice?,
 * budgetUsd?, maxCostUsd?, allowTestSplit?, resume? }`. Conventional paths
 * default from the harness dir (`crewhaus.yaml`, `eval/dataset.jsonl`,
 * `eval/graders.yaml`). Offer RESUME when a run dir has `run.json` but
 * incomplete grades. `allowTestSplit` must be refused unless the request
 * also carries the release-flow confirmation.
 */
export const evalLaunch: M3Handler = () => notImplemented("eval launcher");

/**
 * `GET /api/h/:id/evals/matrix` — matrix runs.
 *
 * Scans the matrix out-dirs (`<out>/<slug>/`), not the run index. Each cell:
 * model, verdict, est_$, and a classified `cellCrashReason` (billing /
 * systemic / transient) with the remedy the UI turns into a button.
 */
export const evalMatrix: M3Handler = () => notImplemented("eval matrix");

/** `GET /api/h/:id/evals/matrix/:cell` — one cell's detail, for the
 *  cell-vs-cell diff the matrix view offers. */
export const evalMatrixCell: M3Handler = () => notImplemented("eval matrix cell");

/**
 * `GET /api/h/:id/evals/suites` — CI suite results.
 *
 * From `.crewhaus/evals/suite_<tier>_<ts>/{<entry>/, suite.json}`: the suite
 * verdict, each entry's floors (`min_pass_rate` / `min_mean_score`), and the
 * rule that a PARTIAL entry always fails.
 */
export const evalSuites: M3Handler = () => notImplemented("eval suites");

/**
 * `POST /api/h/:id/evals/suites` — run a suite.
 *
 * Body: `{ suite, tier: "fast"|"nightly"|"release", gate? }` through the job
 * queue. `suite` is a harness-relative path — shape-check it with `jobArg`.
 */
export const evalSuiteRun: M3Handler = () => notImplemented("eval suite run");

/**
 * `GET /api/h/:id/evals/trends` — per-(spec, dataset) trends.
 *
 * `buildTrends` over the evals index: pass rate, mean score, and cost over
 * time with agent vs judge spend SEPARATED. Partial runs excluded from the
 * regression signal, not silently averaged in.
 */
export const evalTrends: M3Handler = () => notImplemented("eval trends");

/**
 * `POST /api/h/:id/evals/plan` — the sample-size planner.
 *
 * Body: `{ targetDelta, baseRate?, power? }`. Pure offline arithmetic
 * ("how many samples to detect a 5-point delta") — no run, no job, no
 * filesystem write.
 */
export const evalPlan: M3Handler = () => notImplemented("sample-size planner");

/**
 * `GET /api/h/:id/evals/judge` — judge calibration state.
 *
 * `.crewhaus/judge-calibration.json`: the current cut, the ROC data behind
 * it, and when it was last calibrated against which judge model.
 */
export const judgeCalibration: M3Handler = () => notImplemented("judge calibration");

/**
 * `POST /api/h/:id/evals/judge` — run `judge calibrate`.
 *
 * Body: `{ apply?, confirm? }`. Without `apply` this is a PREVIEW (the ROC
 * cut it would choose); `apply: true` writes the calibration file and is
 * confirm-gated, because it changes how every later run is scored.
 */
export const judgeCalibrate: M3Handler = () => notImplemented("judge calibrate");

/**
 * `GET /api/h/:id/evals/graders` — grader quality.
 *
 * The `graders card` per `gradersHash` (what scored a given run) plus the
 * state of `.crewhaus/graders/`. This is how an operator validates that the
 * graders themselves grade correctly.
 */
export const graderCards: M3Handler = () => notImplemented("grader cards");

/** `POST /api/h/:id/evals/graders/suggest` — `graders suggest`: propose
 *  graders from the spec. ADVISORY — the proposal is written only when the
 *  operator accepts it through the grader builder. */
export const gradersSuggest: M3Handler = () => notImplemented("graders suggest");

/** `POST /api/h/:id/evals/graders/test` — `graders test --golden`: meta-eval
 *  the graders against golden verdicts. Job-queued; results are a report,
 *  not a spec change. */
export const gradersTest: M3Handler = () => notImplemented("graders test");

/**
 * `GET /api/h/:id/evals/redteam` — attack-dataset status + the
 * `redteam report --runs` attack-success-rate trend.
 */
export const redteam: M3Handler = () => notImplemented("redteam status");

/**
 * `POST /api/h/:id/evals/redteam` — `redteam generate`.
 *
 * Creates the `<spec>-redteam` attack dataset plus refusal graders through
 * the job queue. The generated dataset lands in the registry with its
 * provenance, exactly like any other dataset.
 */
export const redteamGenerate: M3Handler = () => notImplemented("redteam generate");

/**
 * `GET /api/h/:id/evals/coverage` — `eval coverage` gaps.
 *
 * Production behaviours no sample exercises, each with the sessions that
 * demonstrate the gap so "draft samples from these sessions" can hand off to
 * `dataset mine` (`data-ops.ts`).
 */
export const evalCoverage: M3Handler = () => notImplemented("eval coverage");

/**
 * `GET /api/h/:id/evals/sentinel` — provider-drift sentinel status.
 *
 * The frozen baseline run dir (`eval/sentinel-baseline`) managed as an
 * artifact, plus the last sentinel run. Attribution to provider drift is
 * conditional on the four hashes matching — say which one differs otherwise.
 */
export const sentinel: M3Handler = () => notImplemented("sentinel status");

/** `POST /api/h/:id/evals/sentinel` — run `eval --sentinel --baseline
 *  <runDir>` through the job queue. */
export const sentinelRun: M3Handler = () => notImplemented("sentinel run");

/**
 * `GET /api/h/:id/evals/voice` — voice-replay eval results.
 *
 * `.crewhaus/evals/voice/voice-eval.json` from `eval --voice` replaying
 * `.crewhaus/voice-replays` through the latency/barge-in graders. Shape-
 * gated: only the voice target renders this panel.
 */
export const voiceEvals: M3Handler = () => notImplemented("voice evals");

/**
 * `GET /api/h/:id/evals/optimize` — optimizer runs + artifacts.
 *
 * `.crewhaus/optimize/<runId>/` browsing, including
 * `<out>/advice/decisions.json` and `patched.yaml`. Accepted patches appear
 * in the Spec version history with their `parseWriteBackHeader` provenance
 * (score before → after) — link across rather than duplicating the story.
 */
export const optimizer: M3Handler = () => notImplemented("optimizer runs");

/**
 * `POST /api/h/:id/evals/optimize` — launch `optimize`.
 *
 * Body: `{ mutator: "rule-based"|"claude"|"meta-harness", budgetUsd?,
 * fromAdvice?, concurrency? }`. Explain strict acceptance in the response:
 * a proposal that does not beat the baseline is REJECTED, and that is the
 * feature.
 */
export const optimizerRun: M3Handler = () => notImplemented("optimizer run");

/** `GET /api/h/:id/evals/optimize/:optRunId` — one optimizer run's artifact
 *  tree, containment-checked per file and masked. */
export const optimizerArtifacts: M3Handler = () => notImplemented("optimizer artifacts");

/**
 * `GET /api/h/:id/evals/flywheel` — flywheel / eval-gate scaffolding status.
 *
 * Detects `.crewhaus/flywheel/` + the scaffolded workflows, surfaces the
 * dirty-spec refusal, and WARNS about the dataset-precedence trap: a
 * conventional `eval/dataset.jsonl` silently shadows
 * `registry:<spec>-ratings`.
 */
export const flywheel: M3Handler = () => notImplemented("flywheel status");

/** `POST /api/h/:id/evals/flywheel` — `crewhaus flywheel run|init` through
 *  the job queue. `init` is scaffolding (print/PR-first), `run` is work. */
export const flywheelRun: M3Handler = () => notImplemented("flywheel run");

/**
 * `GET /api/h/:id/evals/experiments` — `experiment status`.
 *
 * `.crewhaus/experiments/`: deterministic A/B version assignment and
 * Wilson-CI outcome deltas. State the honest distinction from
 * `deploy canary`, which is an eval gate plus a pin flip — NOT a traffic
 * splitter.
 */
export const experiments: M3Handler = () => notImplemented("experiments panel");

/** `POST /api/h/:id/evals/experiments` — `experiment record|assign`.
 *  Body: `{ action: "record"|"assign", name, variant?, outcome? }`. */
export const experimentRecord: M3Handler = () => notImplemented("experiment record");

/**
 * `POST /api/h/:id/evals/:runId/:sampleId/annotate` — annotate one sample.
 *
 * Body: `{ verdict, note?, correction? }` written through the SAME
 * `FeedbackRecord` path as `crewhaus rate --adjudicate` (see
 * `feedback-ops.ts`) so the annotation is distill-eligible by construction.
 */
export const annotateSample: M3Handler = () => notImplemented("annotate eval sample");

/**
 * `GET /api/h/:id/evals/annotations` — the annotation → distill join (F-7).
 *
 * Eval-sample annotations cannot currently become training data: a sample's
 * session log lives under the RUN DIR, and distill's `(sessionId,
 * turnNumber)` join never resolves against it. The upstream fix is
 * run-dir-scoped annotation resolution; until it lands this route must
 * report the join state HONESTLY — how many annotations exist, how many
 * resolve, and why the rest do not. Do not fake the join client-side.
 */
export const annotations: M3Handler = () => notImplemented("annotation→distill join");
