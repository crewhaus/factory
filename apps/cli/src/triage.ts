/**
 * Item 7 — wire the Track B failure arbiter (eval-optimizer-orchestrator/
 * src/failure-arbiter.ts) into `crewhaus eval` and `crewhaus optimize`.
 *
 * Post-eval (`finishEvalTriage`): every failing sample is classified into
 * bug / spec-gap / noise / contract-ambiguity via `arbitrate()`, the run
 * roll-up comes from `aggregate()`, and the verdicts persist ADDITIVELY as
 * `verdicts.json` NEXT TO `results.json` (a sibling file, not a section
 * inside it: results.json is eval-runner's single-writer artifact, parsed
 * as a typed `EvalRunSummary` by eval-report's loadRun/diffReports —
 * rewriting it post-hoc from the CLI would make it double-writer and let
 * foreign keys drift into the runner's snapshot). Bug-class verdicts carry
 * `ArbiterAction.promoteRegression: true` ("fix impl; promote regression"),
 * so those samples are pinned into the per-spec `<specName>-regressions`
 * suite via regression-pin's `pinRecoveredSamples` — the consumer its
 * header comment reserved for this feature — with `source:
 * "failure-arbiter"` provenance.
 *
 * Optimize (`triageFitnessSamples`): the same classification runs after
 * each candidate's fitness eval, and noise (flaky infra) +
 * contract-ambiguity (bad gold) samples are withheld from the failure
 * signal the mutator sees (`OptimizerState.bestGrades`) — mutating the
 * prompt against them wastes budget. Contract-ambiguity ids are sticky
 * across iterations and surface in a printed "dataset-fix queue" at the
 * end of the run.
 *
 * Field mapping caveat, faithful to the arbiter's source: the arbiter
 * reads `sample.reference` (via cast — not part of the dataset schema) as
 * "the unique correct answer, when present"; the dataset schema spells
 * that field `expected_output`, so {@link toFailingSample} surfaces it AS
 * `reference`. The rules keyed on `graderOutput` (`acceptable`,
 * `multipleAcceptable`, `addressedByImpl`/`inContract`) cannot fire today
 * because `GradeResult` carries no structured output — the field is left
 * undefined rather than fabricated, and those rules light up as soon as a
 * grader supplies structured output.
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv
 * switch on import) mirroring `eval-history.ts` / `regression-pin.ts`:
 * placement here (not in eval-optimizer-orchestrator) is deliberate — the
 * orchestrator is intentionally decoupled from eval-runner, while this
 * wiring joins eval-runner artifacts, dataset Samples, and the CLI-owned
 * pinning helper. `finishEvalTriage` is best-effort BY CONSTRUCTION: every
 * stage warns and continues instead of throwing, so a triage failure can
 * never break an otherwise successful eval.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatasetRegistry } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  type ArbiterAction,
  type FailingSample,
  type FailureClass,
  aggregate as aggregateVerdicts,
  arbitrate,
} from "@crewhaus/eval-optimizer-orchestrator";
import type { SampleResult } from "@crewhaus/eval-runner";
import { type PinRegressionsResult, pinRecoveredSamples } from "./regression-pin";

/** Fixed class order for every printed/rendered counts line. */
export const FAILURE_CLASS_ORDER: ReadonlyArray<FailureClass> = [
  "bug",
  "spec-gap",
  "noise",
  "contract-ambiguity",
];

/** One failing sample's arbiter verdict, joined back to its sample id. */
export type SampleVerdict = {
  readonly sampleId: string;
  readonly class: FailureClass;
  readonly action: ArbiterAction;
  readonly reason: string;
};

/** The persisted shape of `<runDir>/verdicts.json`. */
export type RunVerdicts = {
  readonly source: "failure-arbiter";
  readonly runId: string;
  readonly arbitratedAt: string;
  /** Number of failing samples arbitrated. */
  readonly total: number;
  readonly counts: Readonly<Record<FailureClass, number>>;
  readonly dominantClass: FailureClass;
  readonly recommendedAction: ArbiterAction;
  readonly verdicts: ReadonlyArray<SampleVerdict>;
};

/** A failing result: errored, or graded and not passed (errors also grade
 *  `passed: false`, but the explicit disjunction keeps the intent legible). */
export function isFailing(result: SampleResult): boolean {
  return result.error !== undefined || !result.grades.overall.passed;
}

/**
 * Join one failing `SampleResult` back to its dataset `Sample` and shape
 * the pair into the arbiter's `FailingSample` input. See the module doc
 * for the `expected_output` → `reference` mapping and the (deliberately)
 * absent `graderOutput`. A missing dataset sample (should not happen — the
 * CLI tees every sample the runner sees) degrades to a minimal stand-in
 * with no reference rather than skipping the sample.
 */
export function toFailingSample(result: SampleResult, sample: Sample | undefined): FailingSample {
  const base: Sample = sample ?? {
    id: result.sampleId,
    input: "(sample not found in dataset)",
  };
  const arbSample =
    base.expected_output !== undefined ? { ...base, reference: base.expected_output } : base;
  return {
    sample: arbSample,
    actual: result.agentOutput,
    score: result.grades.overall.score,
    ...(result.error !== undefined ? { errorMessage: result.error } : {}),
  };
}

/**
 * Classify every failing sample of a completed eval run. Returns undefined
 * when nothing failed — there is nothing to arbitrate, and persisting
 * `aggregate([])`'s degenerate roll-up (dominant contract-ambiguity over
 * zero samples) would mislead.
 */
export function triageEvalRun(opts: {
  readonly samples: ReadonlyArray<SampleResult>;
  readonly samplesById: ReadonlyMap<string, Sample>;
  readonly runId: string;
  readonly now?: () => Date;
}): RunVerdicts | undefined {
  const failing = opts.samples.filter(isFailing);
  if (failing.length === 0) return undefined;
  const inputs = failing.map((r) => toFailingSample(r, opts.samplesById.get(r.sampleId)));
  const verdicts: SampleVerdict[] = failing.map((r, i) => {
    const v = arbitrate(inputs[i] as FailingSample);
    return { sampleId: r.sampleId, class: v.class, action: v.action, reason: v.reason };
  });
  const agg = aggregateVerdicts(inputs);
  return {
    source: "failure-arbiter",
    runId: opts.runId,
    arbitratedAt: (opts.now?.() ?? new Date()).toISOString(),
    total: agg.total,
    counts: agg.counts,
    dominantClass: agg.dominantClass,
    recommendedAction: agg.recommendedAction,
    verdicts,
  };
}

/** `triage: 2 bug, 1 spec-gap, 3 noise, 1 contract-ambiguity` — all four
 *  classes always print (stable shape for log scrapers), in fixed order. */
export function formatTriageSummary(counts: Readonly<Record<FailureClass, number>>): string {
  return `triage: ${FAILURE_CLASS_ORDER.map((c) => `${counts[c]} ${c}`).join(", ")}`;
}

/** Persist verdicts as `<outDir>/verdicts.json`; returns the path. */
export function writeRunVerdicts(outDir: string, verdicts: RunVerdicts): string {
  const path = join(outDir, "verdicts.json");
  writeFileSync(path, JSON.stringify(verdicts, null, 2));
  return path;
}

export type EvalTriageOptions = {
  readonly samples: ReadonlyArray<SampleResult>;
  /** The dataset samples the runner actually saw (see {@link tapSamples}). */
  readonly samplesById: ReadonlyMap<string, Sample>;
  readonly runId: string;
  /** Run directory that already holds results.json; verdicts.json lands here. */
  readonly outDir: string;
  readonly specName: string;
  /** Dataset name for pin provenance (post-union name when a suite was unioned). */
  readonly sourceDataset: string;
  /** Registry for the promoteRegression pin; omit to skip pinning entirely. */
  readonly registry?: DatasetRegistry;
  /** `!--no-regressions` — false skips the promoteRegression pin (the user
   *  opted out of regression-suite integration); triage itself still runs. */
  readonly pin?: boolean;
  /** Line sink; defaults to stdout. */
  readonly write?: (line: string) => void;
  /** Warning sink; defaults to stderr. */
  readonly warn?: (line: string) => void;
  /** Clock override for deterministic tests. */
  readonly now?: () => Date;
};

/**
 * The post-eval triage flow: arbitrate → persist verdicts.json → print the
 * one-line summary → pin the promoteRegression (bug-class) samples. Never
 * throws — each stage is isolated so e.g. an unwritable run dir still
 * leaves the verdicts available for the HTML report, and a broken registry
 * only skips the pin. Returns the verdicts (for the report renderer), or
 * undefined when nothing failed or classification itself broke.
 */
export async function finishEvalTriage(opts: EvalTriageOptions): Promise<RunVerdicts | undefined> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));

  let verdicts: RunVerdicts | undefined;
  try {
    verdicts = triageEvalRun({
      samples: opts.samples,
      samplesById: opts.samplesById,
      runId: opts.runId,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  } catch (err) {
    warn(`[eval] triage skipped: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (verdicts === undefined) return undefined;

  write(`[eval] ${formatTriageSummary(verdicts.counts)}`);
  try {
    write(`[eval] triage verdicts: ${writeRunVerdicts(opts.outDir, verdicts)}`);
  } catch (err) {
    warn(
      `[eval] triage: verdicts.json not written (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // promoteRegression wiring: the arbiter's bug verdicts carry
  // `{ kind: "fix-impl", promoteRegression: true }` — "fix the impl and
  // promote this sample to the regression suite". Promote exactly the
  // samples whose action carries the flag (checked structurally, so a
  // future arbiter attaching it to another class is honored too).
  if (opts.pin !== false && opts.registry !== undefined) {
    try {
      const pin = await promoteArbiterSamples({
        registry: opts.registry,
        specName: opts.specName,
        verdicts,
        samplesById: opts.samplesById,
        sourceDataset: opts.sourceDataset,
        runId: opts.runId,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
      if (pin.pinned > 0) {
        write(
          `[eval] triage: pinned ${pin.pinned} bug sample(s) → ${pin.suiteName}@${pin.version} (failure-arbiter)`,
        );
      }
    } catch (err) {
      warn(
        `[eval] triage: regression pinning skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return verdicts;
}

/** True when an arbiter action asks for regression promotion. */
export function actionPromotesRegression(action: ArbiterAction): boolean {
  return "promoteRegression" in action && action.promoteRegression === true;
}

/**
 * Pin every sample whose verdict action carries `promoteRegression: true`
 * into the per-spec regression suite, tagging the pin's provenance with
 * `source: "failure-arbiter"` (see regression-pin's metadata.regression_pin).
 * Samples the dataset tee somehow missed are skipped — a pin must append
 * the sample as it lives in the source dataset, or not at all.
 */
export async function promoteArbiterSamples(opts: {
  readonly registry: DatasetRegistry;
  readonly specName: string;
  readonly verdicts: RunVerdicts;
  readonly samplesById: ReadonlyMap<string, Sample>;
  readonly sourceDataset: string;
  readonly runId: string;
  readonly now?: () => Date;
}): Promise<PinRegressionsResult> {
  const promoted: Sample[] = [];
  for (const v of opts.verdicts.verdicts) {
    if (!actionPromotesRegression(v.action)) continue;
    const sample = opts.samplesById.get(v.sampleId);
    if (sample !== undefined) promoted.push(sample);
  }
  return pinRecoveredSamples({
    registry: opts.registry,
    specName: opts.specName,
    samples: promoted,
    sourceDataset: opts.sourceDataset,
    optimizeRunId: opts.runId,
    source: "failure-arbiter",
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

// -------- optimize pre-filter --------

/** The exclusion policy for the mutator's failure signal: noise (flaky
 *  infra) and contract-ambiguity (bad gold) waste mutation budget; bug and
 *  spec-gap are real prompt-fixable signal and stay. */
export function isExcludedClass(cls: FailureClass): boolean {
  return cls === "noise" || cls === "contract-ambiguity";
}

export type FitnessTriage = {
  /** Sample ids to withhold from the mutator's failure signal this call
   *  (freshly classified noise + contract-ambiguity, plus every previously
   *  queued contract-ambiguity id seen in this result set). */
  readonly excluded: ReadonlySet<string>;
  /** This call's fresh arbitration counts (queued ids are not re-counted). */
  readonly counts: Readonly<Record<FailureClass, number>>;
  /** Newly classified contract-ambiguity samples (id + arbiter reason) —
   *  the caller appends these to its cross-iteration dataset-fix queue. */
  readonly ambiguous: ReadonlyArray<{ readonly sampleId: string; readonly reason: string }>;
  /** Previously queued ids excluded again without re-arbitration. */
  readonly carried: number;
};

/**
 * Arbitrate one fitness call's results for the optimize loop. Ids already
 * in `alreadyAmbiguous` are excluded WITHOUT re-arbitration ("exclude them
 * from mutation targets across iterations"): a different candidate's
 * output could flip the class, but the underlying dataset/contract problem
 * is unchanged, so the exclusion is sticky.
 */
export function triageFitnessSamples(opts: {
  readonly samples: ReadonlyArray<SampleResult>;
  readonly samplesById: ReadonlyMap<string, Sample>;
  readonly alreadyAmbiguous: ReadonlySet<string>;
}): FitnessTriage {
  const counts: Record<FailureClass, number> = {
    bug: 0,
    "spec-gap": 0,
    noise: 0,
    "contract-ambiguity": 0,
  };
  const excluded = new Set<string>();
  const ambiguous: Array<{ sampleId: string; reason: string }> = [];
  let carried = 0;
  for (const r of opts.samples) {
    if (opts.alreadyAmbiguous.has(r.sampleId)) {
      excluded.add(r.sampleId);
      carried += 1;
      continue;
    }
    if (!isFailing(r)) continue;
    const v = arbitrate(toFailingSample(r, opts.samplesById.get(r.sampleId)));
    counts[v.class] += 1;
    if (!isExcludedClass(v.class)) continue;
    excluded.add(r.sampleId);
    if (v.class === "contract-ambiguity") {
      ambiguous.push({ sampleId: r.sampleId, reason: v.reason });
    }
  }
  return { excluded, counts, ambiguous, carried };
}

/** One observable log line per fitness call that excluded anything;
 *  undefined when the triage was a no-op (keep the optimize log quiet). */
export function formatFitnessTriageLine(t: FitnessTriage): string | undefined {
  if (t.excluded.size === 0) return undefined;
  const queued = t.carried > 0 ? ` (+${t.carried} queued)` : "";
  return (
    `triage: excluded ${t.counts.noise} noise, ${t.counts["contract-ambiguity"]} contract-ambiguity${queued} ` +
    `from mutation signal; kept ${t.counts.bug} bug, ${t.counts["spec-gap"]} spec-gap`
  );
}

/** Render the end-of-optimize dataset-fix queue (contract-ambiguity ids +
 *  arbiter rationale). Empty queue → no lines (print nothing). */
export function formatDatasetFixQueue(queue: ReadonlyMap<string, string>): string[] {
  if (queue.size === 0) return [];
  const lines = [
    `dataset-fix queue: ${queue.size} contract-ambiguity sample(s) — fix the dataset/contract, not the prompt:`,
  ];
  for (const [sampleId, reason] of queue) {
    lines.push(`  - ${sampleId}: ${reason}`);
  }
  return lines;
}

// -------- sample tee --------

/**
 * Tee an async sample stream into `sink` (first occurrence of each id
 * wins, matching the union's primary-wins dedupe) while passing every
 * sample through unchanged. Lets the eval flow hand the runner a stream
 * AND retain the Sample objects triage/pinning need afterwards — the
 * runner materializes the stream anyway, so this adds no memory ceiling.
 */
export function tapSamples(
  source: AsyncIterable<Sample>,
  sink: Map<string, Sample>,
): AsyncIterable<Sample> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const s of source) {
        if (!sink.has(s.id)) sink.set(s.id, s);
        yield s;
      }
    },
  };
}
