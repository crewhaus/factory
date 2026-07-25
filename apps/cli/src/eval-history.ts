/**
 * Post-eval run-history orchestration for `crewhaus eval` — append the run
 * to the index, diff against the pinned (spec, dataset) baseline, gate, and
 * promote. Kept in a side-effect-free module so it is unit-testable (this
 * package's entry file runs an argv switch on import).
 *
 * Policy (AUTOMATION-OPPORTUNITIES.md item 3):
 * - Every run is appended to `.crewhaus/evals/index.jsonl`.
 * - First run for a (spec, dataset) key pins the baseline.
 * - A keyset mismatch from `diffReports` (sample ids changed) means the
 *   dataset itself changed — start a new baseline lineage instead of
 *   failing the run.
 * - A gradersHash/judgeModel mismatch vs the pinned baseline means the
 *   *measurement instrument* changed — the two runs' scores are not
 *   comparable, so warn loudly and start a new baseline lineage the same
 *   way. Baselines pinned before the fields existed gate exactly as before.
 * - The regression gate is strict by default: ANY pass-rate drop fails, and
 *   any sample-level pass→fail flip fails even when a recovery elsewhere
 *   cancels it out in the aggregates.
 * - Gate pass → auto-promote the new run to baseline (opt out with
 *   `--no-promote`); gate fail → never promote. `--gate` only controls
 *   whether a failing verdict maps to a non-zero exit.
 */
import { resolve } from "node:path";
import {
  type BaselineEntry,
  type LoadedRun,
  type ReportDiff,
  ReportError,
  type RunIndexEntry,
  diffReports,
  getBaseline,
  loadRun,
  recordEvalRun,
  setBaseline,
} from "@crewhaus/eval-report";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { type GateThresholds, type GateVerdict, gate } from "@crewhaus/regression-runner";

export type FinishEvalOptions = {
  readonly summary: EvalRunSummary;
  readonly specName: string;
  /**
   * Stable spec identity — the resolved source path of the evaluated spec.
   * Recorded on the index entry + baseline pin and used to warn when this
   * run's (specName, datasetName) baseline was pinned by a *different* spec
   * file (a name collision). Optional: absent → collision detection is
   * simply skipped for this run (back-compat with callers that don't pass it).
   */
  readonly specSource?: string;
  /** sha256 hex of the dataset file bytes. */
  readonly datasetHash: string;
  /** Absolute path to the new run's output directory. */
  readonly outDir: string;
  /** `--gate`: map a failing gate verdict to a non-zero exit. */
  readonly gateRequested: boolean;
  /** `!--no-promote`: allow baseline writes (initial pin + promotion). */
  readonly promote: boolean;
  /** Override `.crewhaus/evals` (tests, tenant scopes). */
  readonly evalsDir?: string;
  /** Line sink; defaults to stdout. */
  readonly write?: (line: string) => void;
  /** Warning sink; defaults to stderr. */
  readonly warn?: (line: string) => void;
};

export type FinishEvalResult = {
  /** True only when `gateRequested` and the regression gate failed. */
  readonly gateFailed: boolean;
  readonly gateReason?: string;
};

/**
 * `eval-report history|baseline show --dataset <filter>` matching. Unioned
 * runs are recorded under `<primary>+regressions@vX`, so the filter matches
 * a stored datasetName that equals it exactly OR continues it with a `+`
 * suffix segment — `--dataset smoke` finds `smoke` and
 * `smoke+regressions@v1`, but not `smoke2`.
 */
export function datasetFilterMatches(filter: string, datasetName: string): boolean {
  return datasetName === filter || datasetName.startsWith(`${filter}+`);
}

/**
 * Strict gate between a baseline run and a new run. Wraps
 * `regression-runner`'s `gate()` with `regressionThreshold: 0` (any
 * pass-rate drop fails) and additionally fails on sample-level regressions
 * that net out to a flat pass rate. The latency criterion is DISABLED by
 * default (threshold Infinity): the documented gate is pass-rate/flip-only,
 * and regression-runner's +5000ms p95 default would fail runs the docs say
 * pass. Latency gating arrives with explicit CLI flags later — callers can
 * already opt in via `thresholds.latencyThreshold`.
 */
export function gateRuns(
  prev: EvalRunSummary,
  next: EvalRunSummary,
  thresholds: GateThresholds = {},
): GateVerdict {
  const verdict = gate(prev, next, {
    regressionThreshold: 0,
    latencyThreshold: Number.POSITIVE_INFINITY,
    ...thresholds,
  });
  if (verdict.verdict === "pass" && verdict.report.regressions.length > 0) {
    const ids = verdict.report.regressions.map((r) => r.sampleId).join(", ");
    return {
      verdict: "fail",
      reason: `sample regressions despite a flat pass rate: [${ids}]`,
      report: verdict.report,
    };
  }
  return verdict;
}

/**
 * Record a completed eval run in the history index, then resolve/diff/gate
 * against the pinned baseline for its (spec, dataset) key. Returns whether
 * the caller should exit non-zero (gate requested + failed).
 */
export async function finishEvalRun(opts: FinishEvalOptions): Promise<FinishEvalResult> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { summary, specName, specSource } = opts;
  const datasetName = summary.config.datasetName;
  // Measurement-instrument identity, straight off the summary the runner
  // recorded (the eval path computes gradersHash once for the sentinel and
  // threads it into the run; judgeModel is present only when a run pinned
  // one). Recorded on the index entry + baseline pin so a later run can
  // detect that the instrument — not the agent — changed.
  const gradersHash = summary.config.gradersHash;
  const judgeModel = summary.config.judgeModel;
  const absOut = resolve(opts.outDir);

  // Build + append the index entry through eval-report's shared recorder —
  // the same call the standalone `target: eval` bundle makes, so one eval has
  // ONE history whichever way it was launched. It also carries the belt (the
  // runner already refuses to run zero samples): a 0-sample run has no signal,
  // and a passRate-0 "clean" entry would poison the index and could pin an
  // empty baseline, so it throws before anything is written.
  const entry: RunIndexEntry = recordEvalRun(summary, {
    specName,
    ...(specSource !== undefined ? { specSource } : {}),
    datasetHash: opts.datasetHash,
    outDir: absOut,
    ...(opts.evalsDir !== undefined ? { evalsDir: opts.evalsDir } : {}),
  });

  const pinCurrentRun = (label: string): void => {
    if (!opts.promote) {
      write(`[eval] baseline not set (${label}; --no-promote)`);
      return;
    }
    const pin: BaselineEntry = {
      specName,
      datasetName,
      runId: summary.runId,
      ...(specSource !== undefined ? { specSource } : {}),
      outDir: absOut,
      datasetHash: opts.datasetHash,
      ...(gradersHash !== undefined ? { gradersHash } : {}),
      ...(judgeModel !== undefined ? { judgeModel } : {}),
      ts: entry.ts,
    };
    setBaseline(pin, opts.evalsDir);
    write(`[eval] baseline set: ${summary.runId} (${label})`);
  };

  const baseline = getBaseline(specName, datasetName, opts.evalsDir);
  if (baseline === undefined) {
    pinCurrentRun(`first run for ${specName}/${datasetName}`);
    return { gateFailed: false };
  }

  // Lineage-collision guard: baselines key on (specName, datasetName), which
  // deliberately keeps ONE lineage across instruction edits (a re-run of an
  // EDITED spec must gate against its pre-edit baseline — that is the whole
  // point of the gate). But two *different* spec files that merely share a
  // `name:` also collapse onto the same key, silently gating one spec against
  // the other's baseline. specSource (the spec's source PATH, which survives
  // edits) tells the two apart: same path → an edit (expected, no warning);
  // different path → a genuine collision. We only WARN (never re-key or
  // refuse) — the name-keyed lineage stays intact and the gate still runs.
  if (
    specSource !== undefined &&
    baseline.specSource !== undefined &&
    baseline.specSource !== specSource
  ) {
    warn(
      `[eval] warning: the baseline for ${specName}/${datasetName} was pinned by a different spec file:`,
    );
    warn(`[eval]   baseline spec: ${baseline.specSource}`);
    warn(`[eval]   this run's spec: ${specSource}`);
    warn(
      `[eval]   two specs sharing name "${specName}" share one baseline lineage — give them distinct \`name:\` values (or a separate evals dir) so their histories don't gate against each other. Gating this run against the other spec's baseline anyway.`,
    );
  }

  // Instrument guard: the gate compares SCORES, and scores are comparable
  // only when both runs graded with the same measurement instrument — the
  // same graders config (gradersHash) bound to the same judge (judgeModel).
  // When the pinned baseline recorded either and this run's differs, gating
  // would blame the agent for a rubric/judge change, so warn loudly and
  // start a new baseline lineage exactly like the dataset-changed path.
  // A side missing the field (old history, or no pinned judge) never trips
  // the guard — hash-less entries gate exactly as before.
  const gradersChanged =
    gradersHash !== undefined &&
    baseline.gradersHash !== undefined &&
    baseline.gradersHash !== gradersHash;
  const judgeChanged =
    judgeModel !== undefined &&
    baseline.judgeModel !== undefined &&
    baseline.judgeModel !== judgeModel;
  if (gradersChanged || judgeChanged) {
    warn(
      `[eval] warning: the measurement instrument changed since baseline ${baseline.runId} was pinned:`,
    );
    if (gradersChanged) {
      warn(`[eval]   gradersHash: ${baseline.gradersHash} → ${gradersHash}`);
    }
    if (judgeChanged) {
      warn(`[eval]   judgeModel: ${baseline.judgeModel} → ${judgeModel}`);
    }
    warn(
      "[eval]   scores graded by different graders configs or judge models are not comparable — not gating this run against that baseline.",
    );
    write("[eval] graders/judge changed — starting new baseline lineage");
    pinCurrentRun("new lineage");
    return { gateFailed: false };
  }

  let prevLoaded: LoadedRun;
  try {
    prevLoaded = await loadRun(baseline.outDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    write(
      `[eval] baseline run ${baseline.runId} unreadable (${msg}) — starting new baseline lineage`,
    );
    pinCurrentRun("new lineage");
    return { gateFailed: false };
  }
  const nextLoaded = await loadRun(absOut);

  let diff: ReportDiff;
  try {
    diff = diffReports(prevLoaded, nextLoaded).diff;
  } catch (err) {
    if (err instanceof ReportError) {
      write("[eval] dataset changed — starting new baseline lineage");
      pinCurrentRun("new lineage");
      return { gateFailed: false };
    }
    throw err;
  }

  write(
    `[eval] vs baseline ${baseline.runId}: regressions=${diff.regressions.length} ` +
      `recoveries=${diff.recoveries.length} score_shifts=${diff.scoreShifts.length} ` +
      `unchanged=${diff.unchanged}`,
  );
  for (const r of diff.regressions) {
    write(
      `[eval]   regression: ${r.sampleId} (score ${r.prev.score.toFixed(2)} → ${r.next.score.toFixed(2)})`,
    );
  }
  for (const r of diff.recoveries) {
    write(
      `[eval]   recovery: ${r.sampleId} (score ${r.prev.score.toFixed(2)} → ${r.next.score.toFixed(2)})`,
    );
  }

  const verdict = gateRuns(prevLoaded.summary, nextLoaded.summary);
  if (verdict.verdict === "fail") {
    const reason = verdict.reason ?? "regression gate failed";
    write(`[eval] gate: FAIL — ${reason}`);
    write(`[eval] baseline kept: ${baseline.runId}`);
    return opts.gateRequested ? { gateFailed: true, gateReason: reason } : { gateFailed: false };
  }

  write("[eval] gate: PASS");
  if (opts.promote) {
    pinCurrentRun("promoted");
  } else {
    write(`[eval] baseline kept: ${baseline.runId} (--no-promote)`);
  }
  return { gateFailed: false };
}
