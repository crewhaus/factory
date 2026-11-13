/**
 * Whether a run can be gated against its baseline, and on which cases.
 *
 * The gate compares scores, and a score delta says something about the agent
 * only when both runs measured the same cases with the same instrument and
 * this run measured something. The rules, checked in this order:
 *
 * | rule                  | when                                                        |
 * |-----------------------|-------------------------------------------------------------|
 * | `partial`             | this run stopped at its budget                              |
 * | `nothing_measured`    | no case of this run produced a verdict                      |
 * | `baseline_unreadable` | the baseline run's summary could not be read                |
 * | `instrument`          | the instrument changed ({@link instrumentChanges}, read from both summaries) |
 * | `cases_removed`       | cases of the baseline are missing from this run             |
 * | `cases_changed`       | the dataset changed, and a shared case's digest differs or a side recorded no `cases.json` |
 *
 * Otherwise the runs are comparable on the cases they share: cases added
 * since the baseline are listed and have no baseline yet, and a shared case
 * the baseline measured that this run did not (not measured, skipped or only
 * observed) is listed as lost measurement. With the same dataset hash and the
 * same case ids, comparability adds nothing to the gate.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CASES_FILENAME,
  CASES_VERSION,
  type EvalRunSummary,
  PROVABILITY_GRADER_NAMES,
  type SampleResult,
  gradeStatusOf,
  inCriterionScope,
  sampleAbstained,
  sampleIsCanary,
  sampleWithoutVerdict,
} from "@crewhaus/eval-runner";
import type { BaselineEntry, RunIndexEntry } from "./history";
import {
  type InstrumentChange,
  formatInstrumentChange,
  instrumentChanges,
  instrumentOf,
} from "./instrument";
import { criterionMeasureDigest } from "./protected-criteria";
import { runState } from "./run-state";

/** A run directory's `cases.json`: each case id's digest. */
export type CaseDigests = {
  readonly version: number;
  readonly digests: Readonly<Record<string, string>>;
};

/** Most bytes {@link readCaseDigests} reads. */
const CASES_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The case digests a run directory recorded, or `undefined` when it holds no
 * `cases.json`, or one that is not a regular file of this format. Never
 * throws.
 */
export function readCaseDigests(outDir: string): CaseDigests | undefined {
  const path = join(outDir, CASES_FILENAME);
  try {
    if (!existsSync(path)) return undefined;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > CASES_MAX_BYTES) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const { version, digests } = parsed as { version?: unknown; digests?: unknown };
    if (version !== CASES_VERSION) return undefined;
    if (typeof digests !== "object" || digests === null || Array.isArray(digests)) {
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [id, digest] of Object.entries(digests)) {
      if (typeof digest !== "string") return undefined;
      out[id] = digest;
    }
    return { version, digests: out };
  } catch {
    return undefined;
  }
}

export type ComparabilityRule =
  | "partial"
  | "nothing_measured"
  | "baseline_unreadable"
  | "instrument"
  | "cases_removed"
  | "cases_changed";

export type Comparability =
  | {
      readonly comparable: true;
      /** The cases both runs hold, in this run's order: what the gate compares. */
      readonly shared: string[];
      /** Cases this run holds and the baseline does not. */
      readonly added: string[];
      /** Shared cases the baseline measured that this run did not. */
      readonly lostMeasurement: string[];
      /** What differs and changes nothing: a spec edit, another CLI, an unverifiable field. */
      readonly notes: string[];
    }
  | {
      readonly comparable: false;
      readonly rule: ComparabilityRule;
      /** The cases the rule is about, for `cases_removed` and `cases_changed`. */
      readonly ids?: string[];
      /** The instrument changes, for `instrument`. */
      readonly changes?: InstrumentChange[];
      readonly reason: string;
    };

/** The flag that re-anchors a lineage, for a reason code. */
const rebaselineHint = (code: string): string =>
  `re-anchor the baseline with \`crewhaus eval --rebaseline --reason ${code}\``;

/** Options for reading which cases a baseline measured. */
export type MeasuredOptions = {
  /**
   * Names of the `perGrader` entries recorded by a provability grader, beside
   * the canonical six ({@link PROVABILITY_GRADER_NAMES}): a graders file's
   * `type: registry` entry records under its own name.
   */
  readonly provabilityGraderNames?: ReadonlySet<string>;
};

/**
 * A baseline case that produced a verdict, by every grade it recorded. The
 * overall grade is read by its `status`; a per-grader grade too, except that a
 * proof check's grade recorded before `status` existed is read by its pinned
 * prefix. A case counts as measured unless a proof check recorded it as not
 * measured or a grade's status says so; a per-grader grade that is `skipped`
 * or `observing` decided nothing and leaves the case measured.
 */
export function measuredInBaseline(s: SampleResult, opts: MeasuredOptions = {}): boolean {
  if (s.error !== undefined || s.graderError !== undefined) return false;
  if (sampleAbstained(s) || sampleIsCanary(s)) return false;
  if (gradeStatusOf(s.grades.overall) !== undefined) return false;
  const proof = (name: string): boolean =>
    PROVABILITY_GRADER_NAMES.includes(name) || opts.provabilityGraderNames?.has(name) === true;
  // A record too old to carry per-grader grades is read by its overall grade.
  // A grader outside its criterion's scope, or one that only observes, is set
  // aside: the case's verdict came from the graders that enforce.
  return (s.grades.perGrader ?? []).every((g) => {
    const status = gradeStatusOf(g, { legacyProvability: proof(g.name) });
    return status === undefined || status === "skipped" || status === "observing";
  });
}

/**
 * The cases both runs hold that the baseline measured ({@link
 * measuredInBaseline}) and this run did not (not measured, skipped or only
 * observed), in this run's order. The gate fails on any: a measurement the
 * baseline had is not a pass when it goes missing.
 */
export function lostMeasurement(
  base: EvalRunSummary,
  run: EvalRunSummary,
  opts: MeasuredOptions = {},
): string[] {
  const baseById = new Map(base.samples.map((s) => [s.sampleId, s]));
  return run.samples
    .filter((now) => {
      const before = baseById.get(now.sampleId);
      return sampleWithoutVerdict(now) && before !== undefined && measuredInBaseline(before, opts);
    })
    .map((s) => s.sampleId);
}

/**
 * Why a run cannot be gated against any baseline: it stopped at its budget
 * (`partial`), or no case produced a verdict (`nothing_measured`). `undefined`
 * when it measured something.
 */
export function unmeasurableRun(
  summary: EvalRunSummary,
): { readonly rule: "partial" | "nothing_measured"; readonly reason: string } | undefined {
  const state = runState(summary);
  if (state.state === "partial") {
    const partial = summary.partial;
    return {
      rule: "partial",
      reason: `run is partial (budget exhausted after ${partial?.completedSamples ?? state.total}/${partial?.totalSamples ?? state.total} samples) — an incomplete run cannot pass the gate`,
    };
  }
  if (state.state === "not_measured") {
    return {
      rule: "nothing_measured",
      reason: `nothing was measured — none of the ${state.total} case(s) produced a verdict about the spec`,
    };
  }
  return undefined;
}

/** Whether `run` can be gated against `base`, by the rules in the module doc. */
export function comparability(
  base: {
    readonly pin: BaselineEntry;
    /** The baseline run's summary; `undefined` when it could not be read. */
    readonly summary?: EvalRunSummary;
    readonly cases?: CaseDigests;
  },
  run: {
    readonly entry: RunIndexEntry;
    readonly summary: EvalRunSummary;
    readonly cases?: CaseDigests;
  },
  opts: MeasuredOptions = {},
): Comparability {
  const unmeasurable = unmeasurableRun(run.summary);
  if (unmeasurable !== undefined) return { comparable: false, ...unmeasurable };
  if (base.summary === undefined) {
    return {
      comparable: false,
      rule: "baseline_unreadable",
      reason: `the baseline run ${base.pin.runId} could not be read, so nothing shows the two runs measured the same thing — ${rebaselineHint("baseline-unreadable")}`,
    };
  }
  const changes = instrumentChanges(instrumentOf(base.summary), instrumentOf(run.summary));
  const changed = changes.filter((c) => c.unverified !== true);
  if (changed.length > 0) {
    return {
      comparable: false,
      rule: "instrument",
      changes: changed,
      reason: `the measuring instrument changed (${changed.map((c) => c.field).join(", ")}) — scores graded by different graders, judges, calibrations, plugin graders or routing are not comparable; ${rebaselineHint("instrument-changed")}`,
    };
  }

  const baseIds = base.summary.samples.map((s) => s.sampleId);
  const runIds = run.summary.samples.map((s) => s.sampleId);
  const inRun = new Set(runIds);
  const inBase = new Set(baseIds);
  const removed = baseIds.filter((id) => !inRun.has(id));
  if (removed.length > 0) {
    return {
      comparable: false,
      rule: "cases_removed",
      ids: removed,
      reason: `${removed.length} case(s) of the baseline are not in this run — ${rebaselineHint("cases-changed")}`,
    };
  }
  const shared = runIds.filter((id) => inBase.has(id));
  if (base.pin.datasetHash !== run.entry.datasetHash) {
    if (base.cases === undefined || run.cases === undefined) {
      const which =
        base.cases === undefined && run.cases === undefined
          ? "neither run"
          : base.cases === undefined
            ? `the baseline run ${base.pin.runId}`
            : "this run";
      return {
        comparable: false,
        rule: "cases_changed",
        reason: `the dataset changed since the baseline and ${which} recorded no ${CASES_FILENAME}, so nothing shows the shared cases are unchanged — ${rebaselineHint("cases-changed")}`,
      };
    }
    const baseDigests = base.cases.digests;
    const runDigests = run.cases.digests;
    const differ = shared.filter(
      (id) =>
        baseDigests[id] === undefined ||
        runDigests[id] === undefined ||
        baseDigests[id] !== runDigests[id],
    );
    if (differ.length > 0) {
      return {
        comparable: false,
        rule: "cases_changed",
        ids: differ,
        reason: `${differ.length} case(s) changed since the baseline — ${rebaselineHint("cases-changed")}`,
      };
    }
  }

  const added = runIds.filter((id) => !inBase.has(id));
  const lost = lostMeasurement(base.summary, run.summary, opts);
  const notes: string[] = [];
  if (base.summary.config.specHash !== run.summary.config.specHash) {
    notes.push(
      `spec edited since the baseline (specHash ${base.summary.config.specHash} → ${run.summary.config.specHash})`,
    );
  }
  const baseCli = base.summary.config.cliVersion;
  const runCli = run.summary.config.cliVersion;
  if (baseCli !== undefined && runCli !== undefined && baseCli !== runCli) {
    notes.push(`measured by crewhaus ${baseCli}, then ${runCli}`);
  }
  for (const change of changes.filter((c) => c.unverified === true)) {
    notes.push(`${formatInstrumentChange(change)} — cannot be compared`);
  }
  return { comparable: true, shared, added, lostMeasurement: lost, notes };
}

/**
 * How `run` changes the protected criteria `base` recorded
 * (`config.criteria`): a protected criterion whose digest moved, one that is
 * gone, one whose verdict is decided differently (the file's `combine`,
 * `passing_threshold` or `per_model`, or the calibration applied to its
 * judges, {@link criterionMeasureDigest}), and cases inside a protected
 * criterion's scope that `run` no longer holds. Empty when nothing protected changed. A re-anchor over any of these
 * needs the harness's owner.
 */
export function protectedChanges(base: EvalRunSummary, run: EvalRunSummary): string[] {
  const reasons: string[] = [];
  const now = new Map((run.config.criteria ?? []).map((c) => [c.id, c]));
  const runIds = new Set(run.samples.map((s) => s.sampleId));
  for (const c of base.config.criteria ?? []) {
    if (c.protected !== true) continue;
    const current = now.get(c.id);
    if (current === undefined) reasons.push(`protected criterion ${c.id} is gone`);
    else if (current.digest !== c.digest) reasons.push(`protected criterion ${c.id} changed`);
    else if (criterionMeasureDigest(run, c.id) !== criterionMeasureDigest(base, c.id)) {
      reasons.push(
        `protected criterion ${c.id} is measured differently (the graders file's policy or its judge's calibration changed)`,
      );
    }
    const missing = base.samples
      .filter((s) => inCriterionScope(c.scope, s.metadata) && !runIds.has(s.sampleId))
      .map((s) => s.sampleId);
    if (missing.length > 0) {
      reasons.push(
        `cases inside protected criterion ${c.id}'s scope are gone: ${missing.join(", ")}`,
      );
    }
  }
  return reasons;
}
