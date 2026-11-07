/**
 * The one way a run becomes a baseline.
 *
 * A pin says "future runs are held to this one", so a run that measured
 * nothing cannot be one. Every path that pins — `crewhaus eval`'s automatic
 * pin, `eval-report baseline set`, Hangar and the `EvalBaselinePin` tool — goes
 * through {@link pinRun}, so they refuse the same runs for the same reasons.
 * `setBaseline` stays the file writer underneath and has no opinion.
 *
 * Refusing returns a value; the writer's own failures (`HistoryWriteError`,
 * `ReportError`) still throw, because a caller answers those differently.
 *
 * A row written before `errorCount`/`measuredCount` existed cannot be told
 * from a clean one, so an old row is refused only for `partial` or for having
 * no samples.
 */
import {
  type BaselineEntry,
  DEFAULT_EVALS_DIR,
  type RunIndexEntry,
  baselineKeyFor,
  lineageOfEntry,
  setBaseline,
} from "./history";

/** Why a run says nothing about the spec it ran. */
export type MeasurementProblem = "partial" | "all_errored" | "nothing_measured";

export type PinRefusal = {
  readonly code: MeasurementProblem | "lineage_mismatch";
  readonly reason: string;
};

export type PinOptions = {
  /** The lineage the caller means to pin. A run from another one is refused. */
  readonly lineageKey?: string;
};

export type PinOutcome =
  | { readonly ok: true; readonly pin: BaselineEntry }
  | { readonly ok: false; readonly refusal: PinRefusal };

/** What is wrong with this run as a measurement, if anything. */
export function measurementProblem(entry: RunIndexEntry): MeasurementProblem | undefined {
  if (entry.partial === true) return "partial";
  if (entry.errorCount !== undefined && entry.errorCount === entry.sampleCount) {
    return "all_errored";
  }
  if (entry.measuredCount === 0 || entry.sampleCount === 0) return "nothing_measured";
  return undefined;
}

/** Why this run cannot be pinned, or `undefined` when it can. */
export function pinRefusal(entry: RunIndexEntry, opts: PinOptions = {}): PinRefusal | undefined {
  const problem = measurementProblem(entry);
  if (problem === "partial") {
    return {
      code: problem,
      reason: `run ${entry.runId} is a partial (budget-aborted) run — its unexecuted samples were recorded as failures, so a baseline seeded from it would make every later regression read as a recovery.`,
    };
  }
  if (opts.lineageKey !== undefined) {
    const rowKey = baselineKeyFor(lineageOfEntry(entry));
    if (rowKey !== opts.lineageKey) {
      return {
        code: "lineage_mismatch",
        reason: `run ${entry.runId} belongs to lineage ${rowKey}, not ${opts.lineageKey} — pinning it here would overwrite a different lineage's baseline with a run that did not measure it`,
      };
    }
  }
  if (problem === "all_errored") {
    return {
      code: problem,
      reason: `in run ${entry.runId} every case errored, so it says nothing about the spec — a baseline seeded from it would make every later run read as a recovery.`,
    };
  }
  if (problem === "nothing_measured") {
    return {
      code: problem,
      reason: `run ${entry.runId} measured nothing — no case produced a verdict about the spec, so a baseline seeded from it would hold later runs to nothing.`,
    };
  }
  return undefined;
}

/**
 * The pin this run would get, built from the run's own recorded columns, or
 * the refusal. Writes nothing. `ts` is the caller's: the automatic pin and the
 * tool use the run's own time, a person's pin uses the clock.
 */
export function pinFromIndexEntry(
  entry: RunIndexEntry,
  ts: string,
  opts: PinOptions = {},
): PinOutcome {
  const refusal = pinRefusal(entry, opts);
  if (refusal !== undefined) return { ok: false, refusal };
  return {
    ok: true,
    pin: {
      specName: entry.specName,
      datasetName: entry.datasetName,
      runId: entry.runId,
      ...(entry.specSource !== undefined ? { specSource: entry.specSource } : {}),
      outDir: entry.outDir,
      datasetHash: entry.datasetHash,
      ...(entry.gradersHash !== undefined ? { gradersHash: entry.gradersHash } : {}),
      ...(entry.judgeModel !== undefined ? { judgeModel: entry.judgeModel } : {}),
      ...(entry.p95LatencyMs !== undefined ? { p95LatencyMs: entry.p95LatencyMs } : {}),
      ...(entry.costUsd !== undefined ? { costUsd: entry.costUsd } : {}),
      ...(entry.armId !== undefined ? { armId: entry.armId } : {}),
      ...(entry.routing !== undefined ? { routing: entry.routing } : {}),
      ...(entry.policyVersion !== undefined ? { policyVersion: entry.policyVersion } : {}),
      ...(entry.armsDigest !== undefined ? { armsDigest: entry.armsDigest } : {}),
      ts,
    },
  };
}

/**
 * Pin this run, or refuse before touching the file. The only path to
 * `setBaseline` outside tests.
 */
export function pinRun(
  entry: RunIndexEntry,
  ts: string,
  evalsDir: string = DEFAULT_EVALS_DIR,
  opts: PinOptions = {},
): PinOutcome {
  const outcome = pinFromIndexEntry(entry, ts, opts);
  if (outcome.ok) setBaseline(outcome.pin, evalsDir);
  return outcome;
}
