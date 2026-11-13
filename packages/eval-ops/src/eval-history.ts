/**
 * Post-eval run-history orchestration for `crewhaus eval` — append the run
 * to the index, diff against the pinned (spec, dataset) baseline, gate, and
 * promote. Kept in a side-effect-free module so it is unit-testable (this
 * package's entry file runs an argv switch on import).
 *
 * Policy (AUTOMATION-OPPORTUNITIES.md item 3):
 * - Every run is appended to `.crewhaus/evals/index.jsonl`.
 * - First run for a (spec, dataset) key pins the baseline. A regression-union
 *   run (`<primary>+regressions@vN`) with no baseline of its own gates
 *   against the most recent pin of its primary (or of a lower union) on the
 *   cases both share, and pins its own lineage on a pass.
 * - A run is gated only when it is comparable with its baseline
 *   (`comparability` in `@crewhaus/eval-report`): it is not partial, it
 *   measured something, the baseline run can be read, the measuring
 *   instrument is the same (graders config, judge, judge calibration, plugin
 *   graders, arm snapshot and policy), no baseline case is missing, and a
 *   changed dataset left the shared cases unchanged. A run that is not
 *   comparable says why and which cases, fails under `--gate`, and pins
 *   nothing. Cases added since the baseline are listed and the gate compares
 *   the shared ones; a shared case the baseline measured that this run did
 *   not measure fails the gate. `--rebaseline --reason <code>` re-anchors the
 *   lineage on this run instead, and the pin records it.
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
 * - 0.6.0 §6.1 — ROUTED runs key their own lineage. `baselineKeyV2 =
 *   spec::dataset::<armId | routed>` sits BESIDE the legacy `spec::dataset`
 *   key (which `routing: static` keeps, so every baselines.json on disk stays
 *   readable and gates exactly as before), and `policyVersion` / `armsDigest`
 *   join the instrument guard rather than the key — a policy flip must
 *   RE-BASELINE a lineage, never orphan it. One rule is specific to V2: when
 *   the V2 key is absent but the legacy key is pinned, the run that CREATES
 *   the lineage is neither gated nor pinned, because auto-pinning it as a
 *   "first run" would let that very run satisfy `route promote --gate`. The
 *   lineage's SECOND run pins (its first run is already a row in the index,
 *   so the pin is no longer self-certifying) and is still ungated, flagged
 *   `lineageSeeded` for the promote path — otherwise the condition could
 *   never change and a per-arm lineage would be unestablishable on every
 *   harness that ever ran a plain eval.
 * - NEW-HUNT-3 — a budget-aborted PARTIAL run is still appended to the
 *   index (marked `partial: true` so readers can tell its deflated
 *   passRate from a real one), but it is NEVER pinned or promoted as a
 *   baseline on ANY path (first run, gate-pass promotion, re-anchor):
 *   its aborted samples are synthetic errors (passed: false, score 0),
 *   not measurements, and a baseline seeded from them would make real
 *   regressions read as recoveries forever after. Its gate verdict fails
 *   outright, on a first run too — an incomplete measurement cannot
 *   honestly pass a pre-declared gate.
 * - A run in which every case errored, or that produced no verdict at all,
 *   is recorded, never pinned on any path, and fails the gate, for the same
 *   reason.
 */
import { resolve } from "node:path";
import {
  type BaselineEntry,
  type BaselineLineage,
  type CaseDigests,
  type ComparabilityRule,
  HistoryWriteError,
  type LoadedRun,
  type MeasuredOptions,
  type PinOutcome,
  type RebaselineReason,
  type RecordEvalRunOptions,
  type ReportDiff,
  ReportError,
  type RunIndexEntry,
  baselineKeyFor,
  comparability,
  diffReports,
  formatInstrumentChange,
  instrumentChanges,
  isLegacyLineage,
  lineageOfEntry,
  loadRun,
  lostMeasurement,
  measuredInBaseline,
  pinRefusal,
  pinRun,
  protectedChanges,
  readBaselines,
  readCaseDigests,
  readRunIndexLatest,
  recordEvalRun,
  resolveBaseline,
  runIndexEntryFromSummary,
  unmeasurableRun,
} from "@crewhaus/eval-report";
import {
  type EvalRoutingMode,
  type EvalRunSummary,
  aggregate,
  sampleNotMeasured,
  sampleWithoutVerdict,
} from "@crewhaus/eval-runner";
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
  /**
   * 0.6.0 §6.1 — the ARM this run measured, when the caller knows it and the
   * run's own manifest does not (a `--models` matrix cell pins its model by
   * patching `agent.model`, so the runner routes `static`). Supplied fields
   * win over `summary.config.routing`; absent ⇒ the run's own manifest
   * decides, and an unrouted run keeps the legacy lineage.
   */
  readonly armId?: string;
  readonly routing?: EvalRoutingMode;
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
  /**
   * `--rebaseline --reason <code>`: skip the comparison and re-anchor the
   * lineage on this run, recording why and with which command. A run that
   * cannot be pinned is refused.
   */
  readonly rebaseline?: { readonly reason: RebaselineReason; readonly cmd: string };
  /**
   * This run's case digests. Absent, they are read from `<outDir>/cases.json`;
   * a test passes them in.
   */
  readonly cases?: CaseDigests;
  /**
   * Names of the `perGrader` entries this run's graders file records through a
   * provability grader under a name of its own (a `type: registry` entry),
   * beside the canonical six. Reading which cases the baseline measured reads
   * a status-less proof check's grade by its pinned prefix, and no other.
   */
  readonly provabilityGraderNames?: ReadonlySet<string>;
  /**
   * `--regrade-baseline`: when the baseline was measured with another
   * instrument, regrade the baseline's recorded answers with this run's graders
   * (the caller records that run) and gate this run against it on the cases
   * both hold. On a pass this run is pinned, marked as a re-anchor.
   */
  readonly regradeBaseline?: (baseline: BaselineEntry) => Promise<LoadedRun>;
  /**
   * Whether the harness's owner allows a re-anchor that changes a protected
   * criterion. Absent: such a re-anchor is refused.
   */
  readonly ownerCheck?: () =>
    | { readonly ok: true; readonly principal?: string }
    | { readonly ok: false; readonly reason: string };
  /**
   * Run a re-anchor (`rebaseline`, `regradeBaseline`) under a command receipt: called
   * with the pin, which takes the receipt's id for the mark it records. Absent, the pin
   * runs with no receipt. A hook that cannot write its receipt answers a `receipt`
   * refusal, and the baseline is kept.
   */
  readonly reanchorCommand?: (pin: (receipt?: string) => PinOutcome) => Promise<PinOutcome>;
};

export type FinishEvalResult = {
  /** True only when `gateRequested` and the regression gate failed. */
  readonly gateFailed: boolean;
  readonly gateReason?: string;
  /** Why the run could not be gated against its baseline, when it could not. */
  readonly notComparable?: ComparabilityRule;
  /** This run re-anchored its lineage (`--rebaseline`, `--regrade-baseline`). */
  readonly rebaselined?: true;
  /**
   * A re-anchor the caller asked for was refused before anything was pinned,
   * with why (a protected criterion changed and the owner check did not pass).
   */
  readonly refused?: string;
  /** The run `--regrade-baseline` recorded: the baseline's answers, regraded. */
  readonly regradedBaseline?: string;
  /**
   * 0.6.0 §6.1 — this run PINNED a per-arm lineage that had no baseline of
   * its own (it is the lineage's second run, beside an older legacy pin). The
   * lineage now exists and later runs gate against it normally, but nothing
   * has yet been gated: `route promote --gate` must refuse a lineage whose
   * baseline is its own only comparison.
   */
  readonly lineageSeeded?: boolean;
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
 * Sample ids with no verdict in EITHER run: not measured, skipped or only
 * observed. Like an abstained sample, such a sample's pass/fail is a
 * placeholder, so the flip comparison leaves it out. A sample the baseline
 * measured and this run did not fails {@link gateRuns} on its own rule
 * (`lostMeasurement`), not as a flip.
 */
export function unverdictedSampleIds(prev: EvalRunSummary, next: EvalRunSummary): Set<string> {
  const ids = new Set<string>();
  for (const s of [...prev.samples, ...next.samples]) {
    if (sampleWithoutVerdict(s)) ids.add(s.sampleId);
  }
  return ids;
}

/**
 * 0.6.0 §6.1 — the ROUTED instrument guard: the reason two runs cannot be
 * compared because they routed off DIFFERENT arm snapshots (or under
 * different pool policies), `undefined` when they are comparable.
 *
 * A side that carries no routing block never trips the guard — an unrouted
 * history compares exactly as it did. Both halves are deliberately
 * conservative: a missing digest on either side is "unknown", not "differs".
 */
export function routedInstrumentMismatch(
  prev: EvalRunSummary,
  next: EvalRunSummary,
): string | undefined {
  const a = prev.config.routing;
  const b = next.config.routing;
  if (a === undefined || b === undefined) return undefined;
  if (a.armsDigest !== undefined && b.armsDigest !== undefined && a.armsDigest !== b.armsDigest) {
    return `routed runs read different arm snapshots (armsDigest ${a.armsDigest} vs ${b.armsDigest}) — two arm snapshots are two different instruments, so these scores are not comparable`;
  }
  if (
    a.policyVersion !== undefined &&
    b.policyVersion !== undefined &&
    a.policyVersion !== b.policyVersion
  ) {
    return `routed runs used different routing policies (policyVersion ${a.policyVersion} vs ${b.policyVersion}) — re-baseline the lineage instead of gating across the flip`;
  }
  return undefined;
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
 * {@link abstainedSampleIds}), and so are samples not measured, skipped or
 * only observed in either run ({@link unverdictedSampleIds}). The pass-RATE
 * criterion still compares the runs' recorded aggregates, whose denominators
 * already exclude each run's own such samples. A sample the baseline measured
 * that `next` did not measure fails the gate (`cases the baseline measured
 * were not measured: <ids>`), for every caller: a pass means every case the
 * baseline measured was measured again. A baseline case counts as measured
 * unless a grade's status says otherwise or a proof check recorded it as not
 * measured; `measured.provabilityGraderNames` names a graders file's own
 * entries for the provability graders, beside the canonical six.
 */
export function gateRuns(
  prev: EvalRunSummary,
  next: EvalRunSummary,
  thresholds: GateThresholds = {},
  measured: MeasuredOptions = {},
): GateVerdict {
  // 0.6.0 §6.1 — two ROUTED runs that read different arm snapshots are two
  // different instruments: the learned policy served different arms on
  // different statistics, so a score delta between them says nothing about
  // the agent. Refuse the comparison outright rather than reporting a verdict
  // nobody can act on. `finishEvalRun`'s instrument guard normally catches
  // this first and starts a new lineage; this is the belt for every other
  // caller of the gate.
  const digestMismatch = routedInstrumentMismatch(prev, next);
  if (digestMismatch !== undefined) {
    return {
      verdict: "fail",
      reason: digestMismatch,
      report: {
        passRateDelta: 0,
        meanScoreDelta: 0,
        p50LatencyDeltaMs: 0,
        p95LatencyDeltaMs: 0,
        regressions: [],
        recoveries: [],
        scoreShifts: [],
        unchanged: 0,
      },
    };
  }
  const stripped = new Set([
    ...abstainedSampleIds(prev, next),
    ...unverdictedSampleIds(prev, next),
  ]);
  const stripAbstained = (run: EvalRunSummary): EvalRunSummary =>
    stripped.size === 0
      ? run
      : { ...run, samples: run.samples.filter((s) => !stripped.has(s.sampleId)) };
  const verdict = gate(stripAbstained(prev), stripAbstained(next), {
    regressionThreshold: 0,
    latencyThreshold: Number.POSITIVE_INFINITY,
    ...thresholds,
  });
  const reasons: string[] = [];
  if (verdict.verdict === "fail") reasons.push(verdict.reason ?? "regression gate failed");
  else if (verdict.report.regressions.length > 0) {
    const ids = verdict.report.regressions.map((r) => r.sampleId).join(", ");
    reasons.push(`sample regressions despite a flat pass rate: [${ids}]`);
  }
  const lost = lostMeasurement(prev, next, measured);
  if (lost.length > 0) {
    reasons.push(`cases the baseline measured were not measured: ${lost.join(", ")}`);
  }
  if (reasons.length === 0) return verdict;
  return { verdict: "fail", reason: reasons.join("; "), report: verdict.report };
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
 * Record a completed eval run in the history index, then resolve the pinned
 * baseline for its lineage, check the two are comparable, and diff/gate on
 * the cases they share. Returns whether the caller should exit non-zero
 * (gate requested + failed) and, when the run could not be compared, why.
 */
export async function finishEvalRun(opts: FinishEvalOptions): Promise<FinishEvalResult> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { summary, specName, specSource } = opts;
  const datasetName = summary.config.datasetName;
  const absOut = resolve(opts.outDir);
  const measured: MeasuredOptions =
    opts.provabilityGraderNames !== undefined
      ? { provabilityGraderNames: opts.provabilityGraderNames }
      : {};

  /**
   * A re-anchor over `base` that changes a protected criterion needs the
   * owner: the refusal's reason when the check does not pass, else the
   * `protectedChange` mark (or nothing when no protected criterion moved).
   */
  // The owner is asked at most once per run, whichever check needs it first.
  let ownerAnswer: ReturnType<NonNullable<FinishEvalOptions["ownerCheck"]>> | undefined;
  const askOwner = (): ReturnType<NonNullable<FinishEvalOptions["ownerCheck"]>> => {
    ownerAnswer ??= opts.ownerCheck?.() ?? {
      ok: false as const,
      reason: "no owner check was supplied",
    };
    return ownerAnswer;
  };
  const protectedGate = (
    base: EvalRunSummary,
    flag: string,
  ): { readonly refused: string } | { readonly mark?: { readonly protectedChange: true } } => {
    const changes = protectedChanges(base, summary);
    if (changes.length === 0) return {};
    const check = askOwner();
    if (!check.ok) {
      return {
        refused: `${flag}: ${changes.join("; ")} — re-anchoring over a protected criterion needs this harness's owner (${check.reason})`,
      };
    }
    return { mark: { protectedChange: true } };
  };

  // Build + append the index entry through eval-report's shared recorder —
  // the same call the standalone `target: eval` bundle makes, so one eval has
  // ONE history whichever way it was launched. It also carries the belt (the
  // runner already refuses to run zero samples): a 0-sample run has no signal,
  // and a passRate-0 "clean" entry would poison the index and could pin an
  // empty baseline, so it throws before anything is written.
  const recordOpts: RecordEvalRunOptions = {
    specName,
    ...(specSource !== undefined ? { specSource } : {}),
    datasetHash: opts.datasetHash,
    // C30 — the one column the shared recorder cannot derive: pricing needs
    // the model catalogue, which the summary does not carry.
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    ...(opts.agentCostUsd !== undefined ? { agentCostUsd: opts.agentCostUsd } : {}),
    ...(opts.judgeCostUsd !== undefined ? { judgeCostUsd: opts.judgeCostUsd } : {}),
    // 0.6.0 §6.1 — the caller's lineage claim (a matrix cell's pinned arm),
    // winning over whatever the run's own routing manifest says.
    ...(opts.armId !== undefined ? { armId: opts.armId } : {}),
    ...(opts.routing !== undefined ? { routing: opts.routing } : {}),
    outDir: absOut,
    ...(opts.evalsDir !== undefined ? { evalsDir: opts.evalsDir } : {}),
  };
  // eval-report refuses a history write through a link (a linked
  // `baselines.json`, or a `.crewhaus` / `.crewhaus/evals` that leads out of
  // the project). By now the run has been paid for and scored, so the
  // refusal is a warning with its remedy, never an exception that loses the
  // verdict: the gate below still runs, against the history as it stands.
  const historyRefused = (what: string, err: HistoryWriteError): void => {
    warn(
      `[eval] warning: ${what} — ${err.message}. The run itself is complete (results in ${absOut}). To keep an eval history, make .crewhaus and .crewhaus/evals real directories inside the project, and baselines.json and index.jsonl regular files, not links.`,
    );
  };
  let entry: RunIndexEntry;
  try {
    entry = recordEvalRun(summary, recordOpts);
  } catch (err) {
    if (!(err instanceof HistoryWriteError)) throw err;
    historyRefused("this run was not recorded in the eval history", err);
    entry = runIndexEntryFromSummary(summary, recordOpts);
  }

  /** Warn, at the moment a pin happens, that the run replayed its tools. */
  const warnReplayedPin = (): void => {
    // NEW-HUNT-4 — a cassette-replayed run IS pinnable (it is a real,
    // reproducible measurement of the agent's reasoning), but pinning it
    // silently would gate every future LIVE run against frozen tool results.
    if (summary.config.toolRecording?.mode === "replay") {
      warn(
        `[eval] warning: pinning a REPLAYED run (--replay-tools ${summary.config.toolRecording.dir}) as the baseline for ${specName}/${datasetName} — every tool result came from the cassette, so later LIVE runs will be gated against frozen tool output.`,
      );
    }
  };

  const pinCurrentRun = (label: string): void => {
    // NEW-HUNT-3 — a budget-aborted run records its unexecuted samples as
    // synthetic errors, and a run in which every case errored or none produced
    // a verdict has measured nothing: pinning either would seed every later
    // gate with garbage (real regressions would read as recoveries against the
    // deflated pin). Asked HERE, before anything is printed about promoting, so
    // every pin path refuses the same way.
    const refusal = pinRefusal(entry);
    if (refusal !== undefined) {
      write(
        refusal.code === "partial"
          ? `[eval] partial run (budget exhausted) — baseline not pinned (${label})`
          : refusal.code === "regrade"
            ? `[eval] run graded recorded answers — baseline not pinned (${label})`
            : `[eval] run measured nothing — baseline not pinned (${label})`,
      );
      return;
    }
    if (!opts.promote) {
      write(`[eval] baseline not set (${label}; --no-promote)`);
      return;
    }
    warnReplayedPin();
    // `entry` is this run's index row, so the pin and the row can never
    // disagree about which arm they are.
    try {
      const pinned = pinRun(entry, entry.ts, opts.evalsDir, {
        cmd: "crewhaus eval",
        ownerCheck: askOwner,
      });
      if (!pinned.ok) {
        write(`[eval] baseline not set (${label}): ${pinned.refusal.reason}`);
        return;
      }
    } catch (err) {
      if (!(err instanceof HistoryWriteError)) throw err;
      historyRefused(`baseline not set (${label})`, err);
      return;
    }
    write(`[eval] baseline set: ${summary.runId} (${label})`);
  };

  // 0.6.0 §6.1 — resolve the baseline for THIS RUN'S lineage. An unrouted run
  // resolves the legacy `spec::dataset` key exactly as before; a routed or
  // arm-pinned run resolves `spec::dataset::<armId | routed>`, so a cheap
  // candidate can never pin over the primary's baseline.
  const lineage: BaselineLineage = {
    specName,
    datasetName,
    ...(entry.armId !== undefined ? { armId: entry.armId } : {}),
    ...(entry.routing !== undefined ? { routing: entry.routing } : {}),
  };
  const lineageLabel = isLegacyLineage(lineage)
    ? `${specName}/${datasetName}`
    : `${specName}/${datasetName}#${entry.armId ?? "routed"}`;
  const lookup = resolveBaseline(lineage, opts.evalsDir);
  const own = lookup.entry;

  // A partial run, or one that measured nothing, is held to no baseline and
  // can be none: under --gate it fails, on a first run too.
  const unmeasurable = unmeasurableRun(summary);
  if (unmeasurable !== undefined) {
    if (opts.rebaseline !== undefined) {
      write(`[eval] --rebaseline: ${pinRefusal(entry)?.reason ?? unmeasurable.reason}`);
    }
    if (own !== undefined || opts.gateRequested || opts.rebaseline !== undefined) {
      if (own === undefined && opts.rebaseline === undefined) {
        pinCurrentRun(`first run for ${lineageLabel}`);
      }
      write(`[eval] gate: FAIL — ${unmeasurable.reason}`);
      if (own !== undefined) write(`[eval] baseline kept: ${own.runId}`);
      return opts.gateRequested
        ? { gateFailed: true, gateReason: unmeasurable.reason, notComparable: unmeasurable.rule }
        : { gateFailed: false };
    }
  }

  if (own === undefined && lookup.legacyPresent) {
    // The one V2-specific rule (§6.1): a per-arm lineage that does not exist
    // yet, alongside a legacy baseline that does, is NOT a "first run". Pinning
    // the FIRST such run would let the very run that creates the lineage
    // satisfy `route promote --gate`, and gating it against the unrouted pin
    // would compare two different instruments.
    //
    // "Not a first run" is not "never a lineage", though: the rule refuses the
    // run that CREATES the lineage, not the lineage itself. So the second run
    // of the lineage pins — the index already holds the first run's row, so
    // the pin is no longer self-certifying — while still returning
    // `gateFailed: false` and flagging `lineageSeeded`, which the promote path
    // reads to refuse a lineage whose baseline is its own only comparison.
    // Without this the condition never changes (nothing else writes a V2 key),
    // so `--gate` under `--record` would be a permanent no-op on every harness
    // that ever ran a plain eval, and the "re-run" guidance would be false.
    if (opts.rebaseline !== undefined) {
      write(
        `[eval] --rebaseline: ${lineageLabel} has no baseline of its own yet, so there is nothing to re-anchor — this run follows the per-arm lineage rule below.`,
      );
    }
    const priorRuns = readRunIndexLatest(opts.evalsDir).filter(
      (e) =>
        e.runId !== summary.runId &&
        e.purpose === undefined &&
        baselineKeyFor(lineageOfEntry(e)) === lookup.key,
    );
    if (priorRuns.length === 0) {
      write(
        `[eval] new per-arm lineage ${lineageLabel} — recorded, not gated and not promotable (the legacy ${specName}/${datasetName} baseline measures a different instrument). Re-run to establish this arm's own baseline.`,
      );
      return { gateFailed: false };
    }
    pinCurrentRun(
      `establishing ${lineageLabel} — run ${priorRuns.length + 1} of this lineage, not gated (the legacy ${specName}/${datasetName} baseline measures a different instrument)`,
    );
    return { gateFailed: false, lineageSeeded: true };
  }

  // A regression-union run with no baseline of its own is gated against its
  // primary's (or a lower union's) most recent pin, on the cases both share.
  const predecessor = own === undefined ? unionPredecessor(lineage, opts.evalsDir) : undefined;
  const baseline = own ?? predecessor;
  const firstRunLabel =
    predecessor !== undefined
      ? `first run for ${lineageLabel}, gated against ${predecessor.runId} (${specName}/${predecessor.datasetName})`
      : `first run for ${lineageLabel}`;

  if (opts.rebaseline !== undefined) {
    return rebaselineOnto(baseline, opts.rebaseline);
  }

  if (baseline === undefined) {
    pinCurrentRun(firstRunLabel);
    return { gateFailed: false };
  }
  if (predecessor !== undefined) {
    write(
      `[eval] no baseline for ${lineageLabel} yet — gating against ${predecessor.runId}, pinned for ${specName}/${predecessor.datasetName}, on the cases both runs share`,
    );
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

  // Comparability: the same instrument, the same cases, a readable baseline.
  // Scores from runs that are not comparable say nothing about the agent, so
  // the run is not gated and nothing is pinned.
  let prevLoaded: LoadedRun | undefined;
  try {
    prevLoaded = await loadRun(baseline.outDir);
  } catch {
    prevLoaded = undefined;
  }
  const nextLoaded = await loadRun(absOut);
  const runCases = opts.cases ?? readCaseDigests(absOut);
  const baseCases = readCaseDigests(baseline.outDir);
  const comparable = comparability(
    {
      pin: baseline,
      ...(prevLoaded !== undefined ? { summary: prevLoaded.summary } : {}),
      ...(baseCases !== undefined ? { cases: baseCases } : {}),
    },
    { entry, summary: nextLoaded.summary, ...(runCases !== undefined ? { cases: runCases } : {}) },
    measured,
  );
  // `--regrade-baseline`: the instrument changed, so grade the baseline's own
  // answers with this run's graders and gate against that.
  // Only what a regrade measures again can be regraded away: the graders,
  // the judge, its calibration and the plugin graders. A routing change
  // (another arm snapshot or policy) stays not comparable.
  const notRegradable =
    !comparable.comparable && comparable.rule === "instrument"
      ? (comparable.changes ?? []).filter(
          (c) => c.unverified !== true && !REGRADE_REMEASURES.has(c.field),
        )
      : [];
  if (
    !comparable.comparable &&
    comparable.rule === "instrument" &&
    notRegradable.length === 0 &&
    prevLoaded !== undefined &&
    opts.regradeBaseline !== undefined
  ) {
    return gateAgainstRegraded(baseline, prevLoaded, nextLoaded, runCases, baseCases);
  }
  if (opts.regradeBaseline !== undefined) {
    write(
      comparable.comparable
        ? "[eval] --regrade-baseline: the baseline measured with the same instrument — gating against it as it is"
        : notRegradable.length > 0
          ? `[eval] --regrade-baseline: a regrade cannot measure again what changed (${notRegradable.map((c) => c.field).join(", ")}: routing) — the baseline stays as it is`
          : "[eval] --regrade-baseline: only a changed instrument is regraded — the baseline stays as it is",
    );
  }
  if (!comparable.comparable || prevLoaded === undefined) {
    const rule: ComparabilityRule = comparable.comparable ? "baseline_unreadable" : comparable.rule;
    const reason = comparable.comparable
      ? `the baseline run ${baseline.runId} could not be read`
      : comparable.reason;
    write(`[eval] not comparable with baseline ${baseline.runId}: ${reason}`);
    if (!comparable.comparable) {
      for (const change of comparable.changes ?? []) {
        write(`[eval]   ${formatInstrumentChange(change)}`);
      }
      if (comparable.ids !== undefined) write(`[eval]   cases: ${comparable.ids.join(", ")}`);
    }
    const gateReason = `not comparable with baseline ${baseline.runId}: ${reason}`;
    if (predecessor !== undefined && !opts.gateRequested) {
      // A union run that cannot be compared with its predecessor starts its
      // own lineage, as a first run does.
      pinCurrentRun(`first run for ${lineageLabel}`);
      return { gateFailed: false, notComparable: rule };
    }
    write(`[eval] baseline kept: ${baseline.runId}`);
    return opts.gateRequested
      ? { gateFailed: true, gateReason, notComparable: rule }
      : { gateFailed: false, notComparable: rule };
  }

  // The gate compares the cases both runs hold. Cases added since the baseline
  // have no baseline yet; they are listed and promote with the run.
  if (comparable.added.length > 0) {
    write(`[eval] new cases, no baseline yet: ${comparable.added.join(", ")}`);
  }
  const nextForGate =
    comparable.added.length === 0 ? nextLoaded : restrictTo(nextLoaded, comparable.shared);

  let diff: ReportDiff;
  try {
    diff = diffReports(prevLoaded, nextForGate).diff;
  } catch (err) {
    if (!(err instanceof ReportError)) throw err;
    const reason = `the two runs' cases could not be matched (${err.message})`;
    write(`[eval] not comparable with baseline ${baseline.runId}: ${reason}`);
    write(`[eval] baseline kept: ${baseline.runId}`);
    return opts.gateRequested
      ? {
          gateFailed: true,
          gateReason: `not comparable with baseline ${baseline.runId}: ${reason}`,
          notComparable: "cases_changed",
        }
      : { gateFailed: false, notComparable: "cases_changed" };
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
  const abstained = abstainedSampleIds(prevLoaded.summary, nextForGate.summary);
  if (abstained.size > 0) {
    write(
      `[eval] gate: excluding ${abstained.size} abstained sample(s) from the flip comparison: ` +
        `[${[...abstained].join(", ")}]`,
    );
  }
  const unverdicted = [...unverdictedSampleIds(prevLoaded.summary, nextForGate.summary)].filter(
    (id) => !abstained.has(id),
  );
  if (unverdicted.length > 0) {
    write(
      `[eval] gate: excluding ${unverdicted.length} sample(s) without a verdict (not measured, skipped or observing) from the flip comparison: [${unverdicted.join(", ")}]`,
    );
  }

  // C30 — pre-declared ops thresholds join the strict gate: the latency
  // ceiling threads into regression-runner's (otherwise-Infinity) latency
  // criterion, and the absolute cost ceiling is checked here (cost is not
  // part of the run summaries regression-runner compares). A declared cost
  // ceiling that cannot be checked (pricing miss → costUsd absent) warns
  // loudly rather than failing on a number nobody computed.
  const verdict = gateRuns(
    prevLoaded.summary,
    nextForGate.summary,
    {
      ...(opts.maxP95LatencyMs !== undefined ? { latencyThreshold: opts.maxP95LatencyMs } : {}),
    },
    measured,
  );
  if (opts.maxCostUsd !== undefined && opts.costUsd === undefined) {
    warn(
      "[eval] warning: --max-cost-usd declared but this run's cost is unknown (no pricing row for the model) — cost gate not applied",
    );
  }
  const costReason = costGateReason(opts.costUsd, opts.maxCostUsd);
  const failReasons: string[] = [];
  if (verdict.verdict === "fail") failReasons.push(verdict.reason ?? "regression gate failed");
  if (costReason !== undefined) failReasons.push(costReason);
  if (failReasons.length > 0) {
    const reason = failReasons.join("; ");
    write(`[eval] gate: FAIL — ${reason}`);
    write(`[eval] baseline kept: ${baseline.runId}`);
    return opts.gateRequested ? { gateFailed: true, gateReason: reason } : { gateFailed: false };
  }

  write("[eval] gate: PASS");
  if (predecessor !== undefined) {
    pinCurrentRun(firstRunLabel);
  } else if (opts.promote) {
    pinCurrentRun("promoted");
  } else {
    write(`[eval] baseline kept: ${baseline.runId} (--no-promote)`);
  }
  return { gateFailed: false };

  /**
   * `--regrade-baseline`: the baseline's answers regraded with this run's
   * graders, restricted to the cases the baseline held, then the same
   * comparability and gate as any run (removed or changed cases stay not
   * comparable). A pass pins this run, marked as a re-anchor; a protected
   * criterion changed needs the owner first.
   */
  async function gateAgainstRegraded(
    replaced: BaselineEntry,
    prev: LoadedRun,
    next: LoadedRun,
    runCases: CaseDigests | undefined,
    baseCases: CaseDigests | undefined,
  ): Promise<FinishEvalResult> {
    const owner = protectedGate(prev.summary, "--regrade-baseline");
    if ("refused" in owner) {
      write(`[eval] ${owner.refused}`);
      write(`[eval] baseline kept: ${replaced.runId}`);
      return { gateFailed: true, gateReason: owner.refused, refused: owner.refused };
    }
    // Cases the baseline held that this run does not cannot be compared on
    // any grading of the baseline's answers: refused before anything is spent.
    const runIds = new Set(next.summary.samples.map((x) => x.sampleId));
    const removed = prev.summary.samples.map((x) => x.sampleId).filter((id) => !runIds.has(id));
    if (removed.length > 0) {
      const reason = `${removed.length} case(s) of the baseline are not in this run — re-anchor the baseline with \`crewhaus eval --rebaseline --reason cases-changed\``;
      write(`[eval] not comparable with baseline ${replaced.runId}: ${reason}`);
      write(`[eval]   cases: ${removed.join(", ")}`);
      write(`[eval] baseline kept: ${replaced.runId}`);
      const gateReason = `not comparable with baseline ${replaced.runId}: ${reason}`;
      return opts.gateRequested
        ? { gateFailed: true, gateReason, notComparable: "cases_removed" }
        : { gateFailed: false, notComparable: "cases_removed" };
    }
    write(
      `[eval] --regrade-baseline: the instrument changed since ${replaced.runId} — regrading its answers with this run's graders`,
    );
    let regraded: LoadedRun;
    try {
      regraded = await (opts.regradeBaseline as (b: BaselineEntry) => Promise<LoadedRun>)(replaced);
    } catch (err) {
      const reason = `--regrade-baseline: the baseline ${replaced.runId} could not be regraded (${err instanceof Error ? err.message : String(err)})`;
      write(`[eval] ${reason}`);
      write(`[eval] baseline kept: ${replaced.runId}`);
      return opts.gateRequested
        ? { gateFailed: true, gateReason: reason, notComparable: "instrument" }
        : { gateFailed: false, notComparable: "instrument" };
    }
    const regradedId = regraded.summary.runId;
    write(`[eval] --regrade-baseline: regraded ${replaced.runId} as ${regradedId}`);
    const baseIds = prev.summary.samples.map((s) => s.sampleId);
    const base = restrictTo(regraded, baseIds);
    // A regrade stands in for the baseline only where it measured what the
    // baseline measured: a case the baseline measured that the regrade could
    // not (its answers missing, a grader that cannot grade recorded answers)
    // leaves the gate nothing to hold this run to, so nothing is gated or
    // pinned. A case the new graders skip or only observe is theirs to set
    // aside, on this run too.
    const regradedById = new Map(base.summary.samples.map((s) => [s.sampleId, s]));
    const unregraded = prev.summary.samples
      .filter((s) => {
        if (!measuredInBaseline(s, measured)) return false;
        const again = regradedById.get(s.sampleId);
        return again === undefined || again.error !== undefined || sampleNotMeasured(again);
      })
      .map((s) => s.sampleId);
    const nothingRegraded = unmeasurableRun(base.summary);
    if (unregraded.length > 0 || nothingRegraded !== undefined) {
      const reason =
        unregraded.length > 0
          ? `${unregraded.length} case(s) of the baseline could not be regraded: ${unregraded.join(", ")}`
          : `the regraded baseline ${regradedId} measured nothing (${nothingRegraded?.reason})`;
      write(`[eval] not comparable with the regraded baseline ${regradedId}: ${reason}`);
      write(`[eval] baseline kept: ${replaced.runId}`);
      const gateReason = `not comparable with the regraded baseline ${regradedId}: ${reason}`;
      return opts.gateRequested
        ? {
            gateFailed: true,
            gateReason,
            notComparable: "instrument",
            regradedBaseline: regradedId,
          }
        : { gateFailed: false, notComparable: "instrument", regradedBaseline: regradedId };
    }
    const result = comparability(
      {
        pin: replaced,
        summary: base.summary,
        ...(baseCases !== undefined ? { cases: baseCases } : {}),
      },
      { entry, summary: next.summary, ...(runCases !== undefined ? { cases: runCases } : {}) },
      measured,
    );
    const fail = (reason: string, rule?: ComparabilityRule): FinishEvalResult => {
      write(`[eval] baseline kept: ${replaced.runId}`);
      return opts.gateRequested
        ? {
            gateFailed: true,
            gateReason: reason,
            regradedBaseline: regradedId,
            ...(rule !== undefined ? { notComparable: rule } : {}),
          }
        : {
            gateFailed: false,
            regradedBaseline: regradedId,
            ...(rule !== undefined ? { notComparable: rule } : {}),
          };
    };
    if (!result.comparable) {
      write(`[eval] not comparable with the regraded baseline ${regradedId}: ${result.reason}`);
      if (result.ids !== undefined) write(`[eval]   cases: ${result.ids.join(", ")}`);
      return fail(
        `not comparable with the regraded baseline ${regradedId}: ${result.reason}`,
        result.rule,
      );
    }
    if (result.added.length > 0) {
      write(`[eval] new cases, no baseline yet: ${result.added.join(", ")}`);
    }
    const nextForGate = result.added.length === 0 ? next : restrictTo(next, result.shared);
    const verdict = gateRuns(
      base.summary,
      nextForGate.summary,
      {
        ...(opts.maxP95LatencyMs !== undefined ? { latencyThreshold: opts.maxP95LatencyMs } : {}),
      },
      measured,
    );
    const costReason = costGateReason(opts.costUsd, opts.maxCostUsd);
    const reasons = [
      ...(verdict.verdict === "fail" ? [verdict.reason ?? "regression gate failed"] : []),
      ...(costReason !== undefined ? [costReason] : []),
    ];
    if (reasons.length > 0) {
      const reason = reasons.join("; ");
      write(`[eval] gate: FAIL — ${reason}`);
      return fail(reason);
    }
    write(`[eval] gate: PASS (against the regraded baseline ${regradedId})`);
    if (!opts.promote) {
      write(`[eval] baseline kept: ${replaced.runId} (--no-promote)`);
      return { gateFailed: false, regradedBaseline: regradedId };
    }
    warnReplayedPin();
    let outcome: ReturnType<typeof pinRun>;
    try {
      const pinWith = (receipt?: string): PinOutcome =>
        pinRun(entry, entry.ts, opts.evalsDir, {
          rebaselined: {
            from: replaced.runId,
            reason: "instrument-changed",
            cmd: "crewhaus eval --regrade-baseline",
            ...(owner.mark ?? {}),
            ...(receipt !== undefined ? { receipt } : {}),
          },
          ownerCheck: askOwner,
        });
      outcome =
        opts.reanchorCommand !== undefined
          ? await opts.reanchorCommand(pinWith)
          : pinWith(undefined);
    } catch (err) {
      if (!(err instanceof HistoryWriteError)) throw err;
      historyRefused("baseline not re-anchored", err);
      return opts.gateRequested
        ? {
            gateFailed: true,
            gateReason: `--regrade-baseline: baseline not re-anchored (${err.message})`,
            regradedBaseline: regradedId,
          }
        : { gateFailed: false, regradedBaseline: regradedId };
    }
    if (!outcome.ok) {
      write(`[eval] --regrade-baseline: ${outcome.refusal.reason}`);
      if (outcome.refusal.code === "receipt") write(`[eval] baseline kept: ${replaced.runId}`);
      return fail(`--regrade-baseline: ${outcome.refusal.reason}`);
    }
    write(`[eval] baseline re-anchored: ${summary.runId} (instrument-changed, regraded)`);
    return { gateFailed: false, rebaselined: true, regradedBaseline: regradedId };
  }

  /**
   * `--rebaseline`: re-anchor the lineage on this run. Prints what changed
   * against the replaced baseline when it can be read, then pins with the
   * mark. The run is already known to be measurable.
   */
  async function rebaselineOnto(
    replaced: BaselineEntry | undefined,
    rebaseline: { readonly reason: RebaselineReason; readonly cmd: string },
  ): Promise<FinishEvalResult> {
    let replacedSummary: EvalRunSummary | undefined;
    if (replaced !== undefined) {
      write(`[eval] --rebaseline: re-anchoring ${lineageLabel} (was ${replaced.runId})`);
      let prev: EvalRunSummary | undefined;
      try {
        prev = (await loadRun(replaced.outDir)).summary;
      } catch {
        prev = undefined;
      }
      replacedSummary = prev;
      if (prev === undefined) {
        write(`[eval]   the baseline run ${replaced.runId} could not be read`);
      } else {
        for (const change of instrumentChanges(prev, summary)) {
          if (change.unverified !== true) write(`[eval]   ${formatInstrumentChange(change)}`);
        }
        const before = new Set(prev.samples.map((x) => x.sampleId));
        const now = new Set(summary.samples.map((x) => x.sampleId));
        const removed = [...before].filter((id) => !now.has(id));
        const added = [...now].filter((id) => !before.has(id));
        const baseCases = readCaseDigests(replaced.outDir);
        const runCases = opts.cases ?? readCaseDigests(absOut);
        const changed =
          baseCases !== undefined && runCases !== undefined
            ? [...now].filter(
                (id) =>
                  before.has(id) &&
                  baseCases.digests[id] !== undefined &&
                  runCases.digests[id] !== undefined &&
                  baseCases.digests[id] !== runCases.digests[id],
              )
            : [];
        if (removed.length > 0) write(`[eval]   cases removed: ${removed.join(", ")}`);
        if (changed.length > 0) write(`[eval]   cases changed: ${changed.join(", ")}`);
        if (added.length > 0) write(`[eval]   cases added: ${added.join(", ")}`);
      }
    }
    let protectedMark: { readonly protectedChange: true } | undefined;
    if (replacedSummary !== undefined) {
      const owner = protectedGate(replacedSummary, "--rebaseline");
      if ("refused" in owner) {
        write(`[eval] ${owner.refused}`);
        write(`[eval] baseline kept: ${replaced?.runId ?? "(none)"}`);
        return { gateFailed: true, gateReason: owner.refused, refused: owner.refused };
      }
      protectedMark = owner.mark;
    } else if (
      replaced !== undefined &&
      (summary.config.criteria ?? []).some((c) => c.protected === true)
    ) {
      // The replaced baseline cannot be read, so nothing shows which of this
      // run's protected criteria it was measured with: the owner decides.
      const check = askOwner();
      if (!check.ok) {
        const refused = `--rebaseline: the baseline run ${replaced.runId} could not be read to check its protected criteria — re-anchoring over a protected criterion needs this harness's owner (${check.reason})`;
        write(`[eval] ${refused}`);
        write(`[eval] baseline kept: ${replaced.runId}`);
        return { gateFailed: true, gateReason: refused, refused };
      }
      protectedMark = { protectedChange: true };
    }
    warnReplayedPin();
    let outcome: ReturnType<typeof pinRun>;
    try {
      const pinWith = (receipt?: string): PinOutcome =>
        pinRun(entry, entry.ts, opts.evalsDir, {
          rebaselined: {
            ...(replaced !== undefined ? { from: replaced.runId } : {}),
            reason: rebaseline.reason,
            cmd: rebaseline.cmd,
            ...(protectedMark ?? {}),
            ...(receipt !== undefined ? { receipt } : {}),
          },
          ownerCheck: askOwner,
        });
      outcome =
        opts.reanchorCommand !== undefined
          ? await opts.reanchorCommand(pinWith)
          : pinWith(undefined);
    } catch (err) {
      if (!(err instanceof HistoryWriteError)) throw err;
      historyRefused("baseline not re-anchored", err);
      return opts.gateRequested
        ? {
            gateFailed: true,
            gateReason: `--rebaseline: baseline not re-anchored (${err.message})`,
          }
        : { gateFailed: false };
    }
    if (!outcome.ok) {
      write(`[eval] --rebaseline: ${outcome.refusal.reason}`);
      if (outcome.refusal.code === "receipt") {
        write(`[eval] baseline kept: ${replaced?.runId ?? "(none)"}`);
        return {
          gateFailed: true,
          gateReason: `--rebaseline: ${outcome.refusal.reason}`,
          refused: outcome.refusal.reason,
        };
      }
      return opts.gateRequested
        ? { gateFailed: true, gateReason: `--rebaseline: ${outcome.refusal.reason}` }
        : { gateFailed: false };
    }
    write(`[eval] baseline re-anchored: ${summary.runId} (${rebaseline.reason})`);
    return { gateFailed: false, rebaselined: true };
  }
}

/**
 * The instrument fields a regrade measures again: it grades the baseline's
 * recorded answers with this run's graders, judge, calibration and plugin
 * graders. A routing change (`armsDigest`, `policyVersion`) is in the answers
 * themselves, so no regrade can stand in for it.
 */
const REGRADE_REMEASURES: ReadonlySet<string> = new Set([
  "gradersHash",
  "judgeModel",
  "calibrationDigest",
  "pluginsDigest",
]);

/** The regression-union suffix a run's datasetName carries. */
const UNION_SUFFIX = /^(.*)\+regressions@v(\d+)$/;

/**
 * For a regression-union lineage (`<primary>+regressions@vN`) with no pin of
 * its own: the most recently pinned baseline of the same spec and arm whose
 * dataset is the primary or a lower union (`+regressions@vM`, M < N).
 * `undefined` for any other lineage, and when none is pinned.
 */
export function unionPredecessor(
  lineage: BaselineLineage,
  evalsDir?: string,
): BaselineEntry | undefined {
  const m = UNION_SUFFIX.exec(lineage.datasetName);
  if (m === null) return undefined;
  const primary = m[1] as string;
  const version = Number(m[2]);
  let pins: BaselineEntry[];
  try {
    pins = Object.values(readBaselines(evalsDir));
  } catch {
    return undefined;
  }
  const sameArm = (pin: BaselineEntry): boolean =>
    baselineKeyFor(lineageOfEntry({ ...pin, datasetName: lineage.datasetName })) ===
    baselineKeyFor(lineage);
  const lower = (datasetName: string): boolean => {
    if (datasetName === primary) return true;
    const own = UNION_SUFFIX.exec(datasetName);
    return own !== null && own[1] === primary && Number(own[2]) < version;
  };
  const tsOf = (pin: BaselineEntry): number => {
    const t = Date.parse(pin.ts);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  let best: BaselineEntry | undefined;
  for (const pin of pins) {
    if (typeof pin !== "object" || pin === null) continue;
    if (pin.specName !== lineage.specName || typeof pin.datasetName !== "string") continue;
    if (!lower(pin.datasetName) || !sameArm(pin)) continue;
    if (best === undefined || tsOf(pin) >= tsOf(best)) best = pin;
  }
  return best;
}

/** A loaded run cut to `ids`, its aggregates recomputed over them. */
function restrictTo(run: LoadedRun, ids: ReadonlyArray<string>): LoadedRun {
  const keep = new Set(ids);
  const samples = run.summary.samples.filter((s) => keep.has(s.sampleId));
  return { ...run, summary: { ...run.summary, samples, aggregates: aggregate(samples) } };
}
