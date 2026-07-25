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
 *       the default one (six specialty packs + `.crewhaus/graders`
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
 * Reference: build-roadmap.md §16; AGENT-LOOPS-PLAN.md.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import type { CompiledGrader, Grader } from "@crewhaus/eval-grader";
import { createJudgeGrader, loadRubric } from "@crewhaus/eval-judge";
import type { IrV0 } from "@crewhaus/ir";
import { createLogger } from "@crewhaus/logging";
import { memoryFragmentFromIr, wireMemory } from "@crewhaus/memory-service";
import { matchNamedFailure } from "@crewhaus/recovery-engine";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createSkillTool } from "@crewhaus/skills-registry";
import { currentTenantContext } from "@crewhaus/tenancy";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { aggregate } from "./aggregate";
import { warnUnconsumedCombinePolicy } from "./combine-warnings";
import { defaultGraderRegistry } from "./default-registry";
import { RunnerError } from "./errors";
import { runSample } from "./run-sample";
import { createSampleOutputWriter } from "./sample-output";
import { Semaphore } from "./semaphore";
import { DEFAULT_SLICE_KEYS, computeSlices, sampleAbstained } from "./slices";
import { meanCI95, tCritical975, wilsonCI95 } from "./stats";
import type {
  AgentInvoker,
  EvalAggregates,
  EvalPricingFn,
  EvalRunPartial,
  EvalRunSummary,
  GraderEntry,
  GraderLookup,
  JudgeCalibrationApplication,
  RunEvalOptions,
  SafetyViolationCounts,
  SampleMetrics,
  SampleResult,
  SliceStats,
  TrialResult,
} from "./types";
import { type SharedAgentDeps, wireRunOnce } from "./wire-once";

export type {
  AgentInvoker,
  EvalAggregates,
  EvalPricingFn,
  EvalRunPartial,
  EvalRunSummary,
  GraderEntry,
  GraderLookup,
  JudgeCalibrationApplication,
  RunEvalOptions,
  SafetyViolationCounts,
  SampleMetrics,
  SampleResult,
  SliceStats,
  TrialResult,
};
export type { SharedAgentDeps };
export { wireRunOnce };
// B13 — metadata slice aggregation (runner-computed so bundles inherit it)
// and the A3 abstained-outcome predicate downstream consumers share.
export { DEFAULT_SLICE_KEYS, computeSlices, sampleAbstained };
// C27 — the closed-form CI helpers behind passRateCI95 / meanScoreCI95.
export { meanCI95, tCritical975, wilsonCI95 };
// Loop contract 0.4 (Batch B, G14) — the default grader registry: the six
// specialty packs + `.crewhaus/graders` plugins, shared by `runEval`'s
// fallback and the CLI/optimizer/flywheel wiring.
export {
  EVAL_EMBEDDER_ENV,
  defaultGraderRegistry,
  type DefaultGraderRegistryOptions,
} from "./default-registry";
// v0.3.0 Goal 2 (§3.3, PR 17) — the first-class competency exam: the
// reference implementation of memory-service's injected `ExamRunner` seam.
export {
  EXAM_SESSION_PREAMBLE,
  createExamRunner,
  type CreateExamRunnerOptions,
  type ExamChatLoopFn,
  type ExamChatLoopOptions,
} from "./exam";
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

  const runId = opts.runId ?? generateRunId();
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
  const needsCalibration = compiledGraders.some(
    (g) => g.judgeSpec !== undefined && g.judgeSpec.rubric.passing_score === undefined,
  );
  const calibration = needsCalibration
    ? loadJudgeCalibration(calibrationPath, ir.name, opts.readCalibrationFile)
    : undefined;
  const calibrationApplied: JudgeCalibrationApplication[] = [];

  // Resolve graders. Replace any `llm_judge` placeholder with a real judge
  // grader bound to the runner's judgeModel (or the per-grader override),
  // and any `registry` placeholder with the named grader from the grader
  // registry (PR 19 — loud at run start, not per-sample).
  const graders: GraderEntry[] = compiledGraders.map((g) => {
    if (g.judgeSpec) {
      let rubric = loadRubric(g.judgeSpec.rubric);
      // G47 — an unspecified `passing_score` gates on the calibrated
      // min-score instead of the schema default (3/5). The file's [0,1] cut
      // projects onto the judge's 1–5 scale: gate = 1 + minScore·4 (the
      // judge grader compares `score >= passing` where score is 1–5 and
      // reports (score-1)/4, so this is exactly `(score-1)/4 >= minScore`).
      if (g.judgeSpec.rubric.passing_score === undefined && calibration !== undefined) {
        const passingScore = 1 + calibration.minScore * 4;
        rubric = { ...rubric, passing_score: passingScore };
        calibrationApplied.push({
          grader: g.name,
          specKey: calibration.specKey,
          minScore: calibration.minScore,
          passingScore,
        });
        logger.info("judge_calibration.applied", {
          grader: g.name,
          specKey: calibration.specKey,
          minScore: calibration.minScore,
          passingScore,
          path: calibrationPath,
        });
      }
      const model = g.judgeSpec.model ?? opts.judgeModel;
      // NEW-HUNT-2 — thread the rubric-level decoding controls through
      // (temperature defaults to the pinned 0 inside `judge`; repeats
      // defaults to a single call).
      const grader = createJudgeGrader(rubric, {
        ...(model !== undefined ? { model } : {}),
        ...(g.judgeSpec.temperature !== undefined ? { temperature: g.judgeSpec.temperature } : {}),
        ...(g.judgeSpec.repeats !== undefined ? { repeats: g.judgeSpec.repeats } : {}),
      });
      return { name: g.name, grader, weight: g.weight };
    }
    if (g.registrySpec) {
      if (graderRegistry === undefined) {
        // Unreachable through the public entrypoint (the default registry
        // is constructed above) — kept for direct/partial callers.
        throw new RunnerError(
          `grader "${g.name}" resolves by registry name "${g.registrySpec.grader}" but no graderRegistry was supplied — pass RunEvalOptions.graderRegistry (and register the pack, e.g. registerContinuityGraders(registry))`,
        );
      }
      try {
        return {
          name: g.name,
          grader: graderRegistry.lookup(g.registrySpec.grader),
          weight: g.weight,
        };
      } catch (err) {
        const known = graderRegistry.list?.().join(", ");
        throw new RunnerError(
          `grader "${g.name}": ${err instanceof Error ? err.message : String(err)}${
            known !== undefined ? ` — registered graders: ${known}` : ""
          }`,
          err,
        );
      }
    }
    return { name: g.name, grader: g.grader, weight: g.weight };
  });

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

  // The default invoker calls runChatLoop with the per-sample fresh
  // runContext; the watchdog wraps WHICHEVER invoker runs (default or
  // caller-supplied) so a hung provider/tool loop can't stall a slot.
  const baseInvoker = opts.invoker ?? (await defaultInvoker(ir, opts));
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

  const startedAt = new Date().toISOString();
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
          },
        ]
      : [],
  );
  const judgeSamplingConfig = judgeSampling.length > 0 ? { judgeSampling } : {};

  // Persist run-level config snapshot up front so SIGINT mid-run still leaves
  // a usable directory.
  const specHash = await hashSpec(ir);
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
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        ...(repeats > 1 ? { repeats } : {}),
        ...(sampleTimeoutMs !== undefined ? { sampleTimeoutMs } : {}),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...judgeSamplingConfig,
        ...judgeCalibrationConfig,
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
  let completedCount = 0;
  const budgetAbortedIds = new Set<string>();

  const settled = await Promise.allSettled(
    samples.map(async (sample) => {
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
              outDir,
              model: ir.agent.model,
              specName: ir.name,
              ...(combine !== undefined ? { combine } : {}),
              ...(seed !== undefined ? { seed } : {}),
              ...(trial > 1 ? { trial } : {}),
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
        return { ...first, trials, trialPassRate: passCount / trials.length };
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
  const aggregates = aggregate(results);
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

  const summary: EvalRunSummary = {
    runId,
    startedAt,
    endedAt,
    samples: results,
    aggregates,
    ...(slices !== undefined ? { slices } : {}),
    ...(partial !== undefined ? { partial } : {}),
    config: {
      specHash,
      datasetName: dataset.name,
      ...(opts.datasetHash !== undefined ? { datasetHash: opts.datasetHash } : {}),
      ...(opts.gradersHash !== undefined ? { gradersHash: opts.gradersHash } : {}),
      graderNames: graders.map((g) => g.name),
      model: ir.agent.model,
      ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
      concurrency,
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(repeats > 1 ? { repeats } : {}),
      ...(sampleTimeoutMs !== undefined ? { sampleTimeoutMs } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      ...judgeSamplingConfig,
      ...judgeCalibrationConfig,
    },
    outDir,
  };

  await Bun.write(join(outDir, "results.json"), JSON.stringify(summary, null, 2));

  return summary;
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
): { minScore: number; specKey: string } | undefined {
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
  const record = calibrations as Record<string, { minScore?: unknown } | undefined>;
  const specKey = record[specName] !== undefined ? specName : "default";
  const entry = record[specKey];
  if (entry === undefined) return undefined;
  const minScore = entry.minScore;
  if (typeof minScore !== "number" || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    logger.warn("judge_calibration.malformed", {
      path,
      specKey,
      error: `minScore must be a number in [0,1], got ${JSON.stringify(minScore)}`,
    });
    return undefined;
  }
  return { minScore, specKey };
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

async function defaultInvoker(ir: IrV0, opts: RunEvalOptions): Promise<AgentInvoker> {
  const wired: SharedAgentDeps = await wireRunOnce(
    ir,
    opts.cwd !== undefined ? { cwd: opts.cwd } : {},
  );
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
    const sampleOut = fanOut ? createSampleOutputWriter({ label: req.sample.id }) : undefined;
    try {
      const agentOutput = await runChatLoop({
        model: wired.model,
        instructions: wired.instructions,
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
        seedMessages: [{ role: "user", content: req.sample.input }],
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
