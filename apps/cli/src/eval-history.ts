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
  appendRunIndex,
  diffReports,
  getBaseline,
  loadRun,
  setBaseline,
} from "@crewhaus/eval-report";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { type GateThresholds, type GateVerdict, gate } from "@crewhaus/regression-runner";

export type FinishEvalOptions = {
  readonly summary: EvalRunSummary;
  readonly specName: string;
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
};

export type FinishEvalResult = {
  /** True only when `gateRequested` and the regression gate failed. */
  readonly gateFailed: boolean;
  readonly gateReason?: string;
};

/**
 * Strict gate between a baseline run and a new run. Wraps
 * `regression-runner`'s `gate()` with `regressionThreshold: 0` (any
 * pass-rate drop fails) and additionally fails on sample-level regressions
 * that net out to a flat pass rate. regression-runner's p95-latency default
 * (+5000ms) is kept as-is.
 */
export function gateRuns(
  prev: EvalRunSummary,
  next: EvalRunSummary,
  thresholds: GateThresholds = {},
): GateVerdict {
  const verdict = gate(prev, next, { regressionThreshold: 0, ...thresholds });
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
  const { summary, specName } = opts;
  const datasetName = summary.config.datasetName;
  const absOut = resolve(opts.outDir);

  const entry: RunIndexEntry = {
    runId: summary.runId,
    specName,
    specHash: summary.config.specHash,
    datasetName,
    datasetHash: opts.datasetHash,
    passRate: summary.aggregates.passRate,
    meanScore: summary.aggregates.meanScore,
    sampleCount: summary.samples.length,
    ts: summary.endedAt,
    outDir: absOut,
  };
  appendRunIndex(entry, opts.evalsDir);

  const pinCurrentRun = (label: string): void => {
    if (!opts.promote) {
      write(`[eval] baseline not set (${label}; --no-promote)`);
      return;
    }
    const pin: BaselineEntry = {
      specName,
      datasetName,
      runId: summary.runId,
      outDir: absOut,
      datasetHash: opts.datasetHash,
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
