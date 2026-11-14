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
 * no samples. A regrade or a preview of another run is never a baseline.
 *
 * A pin that replaces one measured with a different instrument records the
 * re-anchor (`rebaselined`): the caller's reason when it gives one, otherwise
 * `manual`, with the run the replaced pin named and the command that pinned.
 *
 * A pin that replaces one measured with a protected criterion this run
 * changes (its digest moved, or it is gone or unprotected; the index row
 * carries the digests, see `./protected-criteria`) needs the harness's owner:
 * the caller's `ownerCheck`, refused (`protected`) when it is absent or says
 * no, and marked `protectedChange` when it allows it.
 */
import {
  type BaselineEntry,
  DEFAULT_EVALS_DIR,
  type RebaselineReason,
  type RunIndexEntry,
  baselineKeyFor,
  lineageOfEntry,
  pinnedUnder,
  setBaseline,
} from "./history";
import { instrumentChanges } from "./instrument";
import { protectedDigestChanges } from "./protected-criteria";

/** Why a run says nothing about the spec it ran. */
export type MeasurementProblem = "partial" | "all_errored" | "nothing_measured";

export type PinRefusal = {
  /**
   * `regrade`: the run graded another run's recorded answers (a regrade or a
   * preview). `protected`: the pin it would replace was measured with a
   * protected criterion this run changes, and the harness's owner did not
   * allow it. `receipt`: the command receipt a re-anchor is made under could
   * not be written, so the pin was not either. `reanchor`: the caller pins only
   * a run measured like the pin it replaces, and this one was measured
   * differently.
   */
  readonly code:
    | MeasurementProblem
    | "lineage_mismatch"
    | "regrade"
    | "protected"
    | "receipt"
    | "reanchor";
  readonly reason: string;
};

/** The owner's answer to a pin that changes a protected criterion. */
export type PinOwnerCheck = () =>
  | { readonly ok: true; readonly principal?: string }
  | { readonly ok: false; readonly reason: string };

export type PinOptions = {
  /** The lineage the caller means to pin. A run from another one is refused. */
  readonly lineageKey?: string;
  /** The re-anchor this pin records, when the caller re-anchors on purpose. */
  readonly rebaselined?: BaselineEntry["rebaselined"];
  /**
   * What is pinning (`crewhaus eval`, `EvalBaselinePin`, …), recorded on a
   * `manual` re-anchor mark.
   */
  readonly cmd?: string;
  /** The command receipt this pin is made under, recorded on a `manual` re-anchor mark. */
  readonly receipt?: string;
  /**
   * Pin only a run measured verifiably like the pin it replaces: an instrument
   * field that differs, or is recorded on one side only, refuses the pin
   * (`reanchor`, {@link sameInstrumentRefusal}), and the file is untouched.
   */
  readonly sameInstrumentOnly?: boolean;
  /**
   * The pin this one would replace. {@link pinRun} reads it from the file;
   * a caller of {@link pinFromIndexEntry} passes the one it read.
   */
  readonly replaced?: BaselineEntry;
  /**
   * Asked only when the pin would replace one measured with a protected
   * criterion this run changes (its digest moved, or it is gone or
   * unprotected). Absent, or answering no, refuses the pin (`protected`).
   */
  readonly ownerCheck?: PinOwnerCheck;
};

export type { RebaselineReason };

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
  if (entry.purpose !== undefined) {
    return {
      code: "regrade",
      reason: `run ${entry.runId} is a ${entry.purpose} of run ${entry.regradeOf ?? "(unknown)"} — it graded recorded answers, so it measured no run of the agent and cannot be a baseline.`,
    };
  }
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
  // A protected criterion the replaced pin was measured with, changed here,
  // is the owner's to re-anchor over, whichever path pins.
  const replaced = opts.replaced;
  const moved =
    replaced !== undefined && replaced.runId !== entry.runId
      ? protectedDigestChanges(replaced.protectedCriteria, entry.protectedCriteria)
      : [];
  let rebaselined = opts.rebaselined;
  if (moved.length > 0) {
    const check = opts.ownerCheck?.() ?? {
      ok: false as const,
      reason: "no owner check was made for this pin",
    };
    if (!check.ok) {
      return {
        ok: false,
        refusal: {
          code: "protected",
          reason: `run ${entry.runId} changes what the pinned run ${replaced?.runId} was measured with: ${moved.join("; ")} — re-anchoring over a protected criterion needs this harness's owner (${check.reason}); the owner re-anchors with \`crewhaus eval --rebaseline --reason <code>\``,
        },
      };
    }
    rebaselined = {
      ...(rebaselined ?? { from: replaced?.runId, reason: "manual", cmd: opts.cmd ?? "unknown" }),
      protectedChange: true,
    };
  }
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
      ...(entry.calibrationDigest !== undefined
        ? { calibrationDigest: entry.calibrationDigest }
        : {}),
      ...(entry.pluginsDigest !== undefined ? { pluginsDigest: entry.pluginsDigest } : {}),
      ...(entry.protectedCriteria !== undefined
        ? { protectedCriteria: entry.protectedCriteria }
        : {}),
      ...(rebaselined !== undefined ? { rebaselined } : {}),
      ts,
    },
  };
}

/**
 * The re-anchor mark for pinning `entry` over `replaced`: `manual`, naming the
 * replaced run, when the two were measured with different instruments
 * ({@link instrumentChanges}, unverified fields left out), else `undefined`.
 */
export function manualRebaseline(
  replaced: BaselineEntry | undefined,
  entry: RunIndexEntry,
  cmd: string,
): BaselineEntry["rebaselined"] {
  if (replaced === undefined || replaced.runId === entry.runId) return undefined;
  const changed = instrumentChanges(replaced, entry).filter((c) => c.unverified !== true);
  return changed.length > 0 ? { from: replaced.runId, reason: "manual", cmd } : undefined;
}

/**
 * Why a caller that pins only same-instrument runs refuses this one: every field
 * {@link instrumentChanges} reports, a field recorded on one side only named as such.
 */
export function reanchorRefusal(
  entry: RunIndexEntry,
  replaced: BaselineEntry | undefined,
): PinRefusal {
  const changed = replaced === undefined ? [] : instrumentChanges(replaced, entry);
  const named = changed.map((c) =>
    c.unverified === true ? `${c.field}, recorded on one side only` : c.field,
  );
  return {
    code: "reanchor",
    reason: `run ${entry.runId} was measured differently from the pinned run ${replaced?.runId ?? "(none)"}${named.length > 0 ? ` (${named.join("; ")})` : ""} — moving the baseline onto it is a re-anchor, which a person makes: \`crewhaus eval --rebaseline --reason <code>\``,
  };
}

/**
 * The refusal for pinning `entry` over `replaced` when only a run measured
 * verifiably like the pinned one may replace it: `undefined` when nothing is
 * replaced or it is the same run, else a `reanchor` refusal when any instrument
 * field differs or is recorded on one side only ({@link instrumentChanges},
 * unverified fields included).
 */
export function sameInstrumentRefusal(
  entry: RunIndexEntry,
  replaced: BaselineEntry | undefined,
): PinRefusal | undefined {
  if (replaced === undefined || replaced.runId === entry.runId) return undefined;
  return instrumentChanges(replaced, entry).length > 0
    ? reanchorRefusal(entry, replaced)
    : undefined;
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
  const refusal = pinRefusal(entry, opts);
  if (refusal !== undefined) return { ok: false, refusal };
  // The pin this one replaces, read as the write below reads the file. A
  // file it refuses is the writer's to refuse, so it marks nothing here.
  let replaced: BaselineEntry | undefined;
  try {
    replaced = pinnedUnder(baselineKeyFor(lineageOfEntry(entry)), evalsDir);
  } catch {
    replaced = undefined;
  }
  let pinOpts: PinOptions = replaced !== undefined ? { ...opts, replaced } : opts;
  if (opts.rebaselined === undefined) {
    if (opts.sameInstrumentOnly === true) {
      const refused = sameInstrumentRefusal(entry, replaced);
      if (refused !== undefined) return { ok: false, refusal: refused };
    }
    const mark = manualRebaseline(replaced, entry, opts.cmd ?? "unknown");
    if (mark !== undefined) {
      pinOpts = {
        ...pinOpts,
        rebaselined: { ...mark, ...(opts.receipt !== undefined ? { receipt: opts.receipt } : {}) },
      };
    }
  }
  const outcome = pinFromIndexEntry(entry, ts, pinOpts);
  if (outcome.ok) setBaseline(outcome.pin, evalsDir);
  return outcome;
}
