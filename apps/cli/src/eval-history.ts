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
 * - C30 — pre-declared ops thresholds join the gate verdict when the caller
 *   declares them: `--max-p95-latency-ms` fails the gate when p95 latency
 *   rose more than N ms vs the baseline (regression-runner's latency
 *   criterion, un-disabled), and `--max-cost-usd` fails it when this run's
 *   estimated cost exceeds the ceiling. Absent flags = pass-rate/flip-only,
 *   byte-identical to before. p95 latency + estimated cost are also
 *   recorded on every index entry/baseline pin (additive fields).
 * - Gate pass → auto-promote the new run to baseline (opt out with
 *   `--no-promote`); gate fail → never promote. `--gate` only controls
 *   whether a failing verdict maps to a non-zero exit.
 * - NEW-HUNT-6 — a resumed run rewrites its own `results.json` under its
 *   ORIGINAL runId, so when the pinned baseline IS the run being resumed both
 *   sides of the diff would read the same file. That comparison is refused
 *   loudly (no gate verdict, no promotion) instead of reporting a vacuous
 *   `regressions=0 … gate: PASS`.
 * - NEW-HUNT-3 — a budget-aborted PARTIAL run is still appended to the
 *   index (marked `partial: true` so readers can tell its deflated
 *   passRate from a real one), but it is NEVER pinned or promoted as a
 *   baseline on ANY path (first run, new lineage, gate-pass promotion):
 *   its aborted samples are synthetic errors (passed: false, score 0),
 *   not measurements, and a baseline seeded from them would make real
 *   regressions read as recoveries forever after. Against an existing
 *   baseline the gate verdict fails outright — an incomplete measurement
 *   cannot honestly pass a pre-declared gate.
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
  /**
   * C30 × C35 — this run's TOTAL estimated cost in USD (agent + judge),
   * priced through the same seam as the `--models` matrix `est_$` column and
   * by the same helper that builds the printed `[eval] cost:` line, so the
   * figure the user sees and the figure this gate enforces are one number.
   * Recorded on the index entry/baseline pin and compared against
   * {@link maxCostUsd}. Absent when ANY model in the run has no pricing row
   * — the cost gate then warns instead of failing on an undercount.
   */
  readonly costUsd?: number;
  /** C35 — the agent half of {@link costUsd}, recorded on the index entry. */
  readonly agentCostUsd?: number;
  /** C35 — the judge/grader half of {@link costUsd}. */
  readonly judgeCostUsd?: number;
  /**
   * C30 — `--max-p95-latency-ms`: fail the baseline gate when p95
   * per-sample latency rose more than this many ms vs the pinned baseline
   * (threads into regression-runner's `latencyThreshold`, whose default
   * here stays Infinity). Absent = latency not gated, today's behavior.
   */
  readonly maxP95LatencyMs?: number;
  /**
   * C30 — `--max-cost-usd`: fail the baseline gate when {@link costUsd}
   * exceeds this ceiling. Absent = cost not gated, today's behavior.
   */
  readonly maxCostUsd?: number;
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
 * A3 — sample ids whose outcome was `abstained` in EITHER run (judge
 * declined to score, nothing else failed). Such a sample's pass/fail is a
 * placeholder awaiting a human verdict, so the flip comparison must not
 * treat it as a real regression/recovery. Old records (no `abstained`
 * field) contribute nothing — the set is empty and the gate is unchanged.
 */
export function abstainedSampleIds(prev: EvalRunSummary, next: EvalRunSummary): Set<string> {
  const ids = new Set<string>();
  for (const s of [...prev.samples, ...next.samples]) {
    if (s.error === undefined && s.grades.overall.abstained === true) ids.add(s.sampleId);
  }
  return ids;
}

/**
 * Strict gate between a baseline run and a new run. Wraps
 * `regression-runner`'s `gate()` with `regressionThreshold: 0` (any
 * pass-rate drop fails) and additionally fails on sample-level regressions
 * that net out to a flat pass rate. The latency criterion is DISABLED by
 * default (threshold Infinity): the documented gate is pass-rate/flip-only,
 * and regression-runner's +5000ms p95 default would fail runs the docs say
 * pass. C30 — `crewhaus eval --max-p95-latency-ms N` is the explicit
 * opt-in: `finishEvalRun` threads it in as `thresholds.latencyThreshold`,
 * so the gate fails when p95 latency rose more than N ms vs the baseline.
 *
 * A3 — samples abstained in either run are excluded from the per-sample
 * flip comparison (their verdict is UNKNOWN, not a fail — see
 * {@link abstainedSampleIds}). The pass-RATE criterion still compares the
 * runs' recorded aggregates, whose denominators already exclude each run's
 * own abstained samples.
 */
export function gateRuns(
  prev: EvalRunSummary,
  next: EvalRunSummary,
  thresholds: GateThresholds = {},
): GateVerdict {
  const abstained = abstainedSampleIds(prev, next);
  const stripAbstained = (run: EvalRunSummary): EvalRunSummary =>
    abstained.size === 0
      ? run
      : { ...run, samples: run.samples.filter((s) => !abstained.has(s.sampleId)) };
  const verdict = gate(stripAbstained(prev), stripAbstained(next), {
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
 * C30 — the cost half of the pre-declared threshold gate: the failure
 * reason when the run's estimated cost exceeds the declared ceiling,
 * `undefined` when no ceiling was declared or it holds. A declared ceiling
 * with an UNKNOWN run cost (no pricing row for the model) is NOT enforced —
 * `finishEvalRun` warns instead, because failing a gate on a number nobody
 * computed would be a guess.
 */
export function costGateReason(
  costUsd: number | undefined,
  maxCostUsd: number | undefined,
): string | undefined {
  if (maxCostUsd === undefined || costUsd === undefined || costUsd <= maxCostUsd) {
    return undefined;
  }
  return `run cost $${costUsd.toFixed(4)} exceeded --max-cost-usd $${maxCostUsd.toFixed(4)}`;
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
    // C30 — the one column the shared recorder cannot derive: pricing needs
    // the model catalogue, which the summary does not carry.
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    ...(opts.agentCostUsd !== undefined ? { agentCostUsd: opts.agentCostUsd } : {}),
    ...(opts.judgeCostUsd !== undefined ? { judgeCostUsd: opts.judgeCostUsd } : {}),
    outDir: absOut,
    ...(opts.evalsDir !== undefined ? { evalsDir: opts.evalsDir } : {}),
  });

  const pinCurrentRun = (label: string): void => {
    // NEW-HUNT-3 — a budget-aborted run records its unexecuted samples as
    // synthetic errors, so it is not an honest measurement of the spec:
    // pinning it would seed every later gate with garbage (real
    // regressions would read as recoveries against the deflated pin).
    // Guarded HERE so every pin path — first run, new lineage, gate-pass
    // promotion — refuses the same way.
    if (summary.partial !== undefined) {
      write(`[eval] partial run (budget exhausted) — baseline not pinned (${label})`);
      return;
    }
    if (!opts.promote) {
      write(`[eval] baseline not set (${label}; --no-promote)`);
      return;
    }
    // NEW-HUNT-4 — a cassette-replayed run IS pinnable (it is a real,
    // reproducible measurement of the agent's reasoning), but pinning it
    // silently would gate every future LIVE run against frozen tool results.
    // Warn at the moment the pin happens, where it is actionable.
    if (summary.config.toolRecording?.mode === "replay") {
      warn(
        `[eval] warning: pinning a REPLAYED run (--replay-tools ${summary.config.toolRecording.dir}) as the baseline for ${specName}/${datasetName} — every tool result came from the cassette, so later LIVE runs will be gated against frozen tool output.`,
      );
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
      // C30 — additive ops fields, mirroring the index entry.
      p95LatencyMs: summary.aggregates.p95LatencyMs,
      ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
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

  // NEW-HUNT-6 — self-comparison guard. `--resume` is the first feature that
  // makes an already-recorded run directory MUTABLE: a resumed run keeps its
  // ORIGINAL runId and REWRITES `<runDir>/results.json` with the union. If the
  // pinned baseline IS that run (it was the first run for the pair, got
  // interrupted, and pinned), then `loadRun(baseline.outDir)` and
  // `loadRun(absOut)` below read the very same just-rewritten file: the diff
  // is vacuous by construction (regressions=0, forever), the gate prints PASS
  // without measuring anything, and the run promotes itself. A fabricated
  // green is worse than no gate, so refuse the comparison loudly and touch
  // neither the verdict nor the pin. The index entry above is still recorded.
  if (baseline.runId === summary.runId || resolve(baseline.outDir) === absOut) {
    warn(
      `[eval] warning: the pinned baseline for ${specName}/${datasetName} IS this run (${baseline.runId}) — nothing to gate against.`,
    );
    warn(
      "[eval]   a resumed run rewrites the very results.json the baseline points at, so the comparison would be the run against itself (it can never detect a regression).",
    );
    warn(
      "[eval]   re-pin an earlier run as the baseline, or start a fresh run to re-gate this spec.",
    );
    write(`[eval] baseline kept: ${baseline.runId} (self-comparison — not gated, not promoted)`);
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

  // A3 — say when the flip comparison is running on fewer samples than the
  // diff above showed: abstained-in-either-run samples await a human
  // verdict, so the gate must not count their placeholder fails as flips.
  const abstained = abstainedSampleIds(prevLoaded.summary, nextLoaded.summary);
  if (abstained.size > 0) {
    write(
      `[eval] gate: excluding ${abstained.size} abstained sample(s) from the flip comparison: ` +
        `[${[...abstained].join(", ")}]`,
    );
  }

  // C30 — pre-declared ops thresholds join the strict gate: the latency
  // ceiling threads into regression-runner's (otherwise-Infinity) latency
  // criterion, and the absolute cost ceiling is checked here (cost is not
  // part of the run summaries regression-runner compares). A declared cost
  // ceiling that cannot be checked (pricing miss → costUsd absent) warns
  // loudly rather than failing on a number nobody computed.
  const verdict = gateRuns(prevLoaded.summary, nextLoaded.summary, {
    ...(opts.maxP95LatencyMs !== undefined ? { latencyThreshold: opts.maxP95LatencyMs } : {}),
  });
  if (opts.maxCostUsd !== undefined && opts.costUsd === undefined) {
    warn(
      "[eval] warning: --max-cost-usd declared but this run's cost is unknown (no pricing row for the model) — cost gate not applied",
    );
  }
  const costReason = costGateReason(opts.costUsd, opts.maxCostUsd);
  const failReasons: string[] = [];
  // NEW-HUNT-3 — an incomplete measurement cannot honestly pass a
  // pre-declared gate: the budget-aborted samples never ran, so "no
  // regression" is unknowable. Without this a partial run whose aborted
  // samples were ALREADY failing in the baseline flips nothing (fail→fail)
  // and reads gate-PASS — a false green (and, pre-guard, a promotion).
  if (summary.partial !== undefined) {
    failReasons.push(
      `run is partial (budget exhausted after ${summary.partial.completedSamples}/${summary.partial.totalSamples} samples) — an incomplete run cannot pass the gate`,
    );
  }
  if (verdict.verdict === "fail") failReasons.push(verdict.reason ?? "regression gate failed");
  if (costReason !== undefined) failReasons.push(costReason);
  if (failReasons.length > 0) {
    const reason = failReasons.join("; ");
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
