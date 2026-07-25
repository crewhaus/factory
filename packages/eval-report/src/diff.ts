import type { SampleResult } from "@crewhaus/eval-runner";
import { ReportError } from "./errors";
import type { LoadedRun } from "./load";
import { renderDiffHtml } from "./render";

export type ReportDiff = {
  readonly prevRunId: string;
  readonly newRunId: string;
  readonly regressions: ReadonlyArray<DiffEntry>; // pass → fail
  readonly recoveries: ReadonlyArray<DiffEntry>; // fail → pass
  readonly scoreShifts: ReadonlyArray<DiffEntry>; // |Δscore| > ε
  readonly unchanged: number;
};

export type DiffEntry = {
  readonly sampleId: string;
  readonly prev: { passed: boolean; score: number; rationale: string; passRate?: number };
  readonly next: { passed: boolean; score: number; rationale: string; passRate?: number };
};

const SCORE_EPSILON = 0.1;

/**
 * Measurement-instrument mismatch check for a run diff. Scores are only
 * comparable when both runs graded with the same instrument — the same
 * graders config and the same judge model. When both runs recorded a
 * `gradersHash` (or `judgeModel`) and the values differ, a score delta may
 * reflect the rubric/judge change rather than the agent, so the caller
 * should surface these lines as warnings alongside the diff. Fields absent
 * on either side (runs recorded before the fields existed, or runs that
 * never pinned a judge) produce no warning — old records stay diffable
 * exactly as before.
 */
export function diffInstrumentWarnings(prev: LoadedRun, next: LoadedRun): string[] {
  const p = prev.summary.config;
  const n = next.summary.config;
  const warnings: string[] = [];
  if (
    p.gradersHash !== undefined &&
    n.gradersHash !== undefined &&
    p.gradersHash !== n.gradersHash
  ) {
    warnings.push(
      `runs graded with different graders configs (gradersHash ${p.gradersHash} vs ${n.gradersHash}) — score deltas may reflect the rubric change, not the agent`,
    );
  }
  if (p.judgeModel !== undefined && n.judgeModel !== undefined && p.judgeModel !== n.judgeModel) {
    warnings.push(
      `runs graded with different judge models (${p.judgeModel} vs ${n.judgeModel}) — score deltas may reflect the judge change, not the agent`,
    );
  }
  return warnings;
}

/**
 * Compare two eval runs by `sampleId`. Throws if the keysets don't match
 * (no silent alignment by index — that would mask schema drift).
 *
 * G15 — flips compare per-sample pass-RATES when either run carried repeat
 * trials (`SampleResult.trialPassRate`), mirroring regression-runner: a
 * 4/4 → 1/4 reliability drop is a regression even though the canonical
 * verdict still passes. Single-trial runs reduce to the boolean semantics.
 */
export function diffReports(
  prev: LoadedRun,
  next: LoadedRun,
): { html: string; json: string; diff: ReportDiff } {
  const prevById = new Map(prev.summary.samples.map((s) => [s.sampleId, s]));
  const nextById = new Map(next.summary.samples.map((s) => [s.sampleId, s]));

  const prevKeys = new Set(prevById.keys());
  const nextKeys = new Set(nextById.keys());
  const missing = [...prevKeys].filter((k) => !nextKeys.has(k));
  const added = [...nextKeys].filter((k) => !prevKeys.has(k));
  if (missing.length > 0 || added.length > 0) {
    throw new ReportError(
      `dataset shape mismatch — missing in new run: [${missing.join(", ") || "<none>"}], ` +
        `added in new run: [${added.join(", ") || "<none>"}]. Reject mismatched dataset shapes.`,
    );
  }

  const regressions: DiffEntry[] = [];
  const recoveries: DiffEntry[] = [];
  const scoreShifts: DiffEntry[] = [];
  let unchanged = 0;

  for (const sampleId of prevKeys) {
    const p = prevById.get(sampleId) as SampleResult;
    const n = nextById.get(sampleId) as SampleResult;
    const hasTrialData = p.trialPassRate !== undefined || n.trialPassRate !== undefined;
    const prevRate = p.trialPassRate ?? (p.grades.overall.passed ? 1 : 0);
    const nextRate = n.trialPassRate ?? (n.grades.overall.passed ? 1 : 0);
    const entry: DiffEntry = {
      sampleId,
      prev: {
        passed: p.grades.overall.passed,
        score: p.grades.overall.score,
        rationale: p.grades.overall.rationale,
        ...(hasTrialData ? { passRate: prevRate } : {}),
      },
      next: {
        passed: n.grades.overall.passed,
        score: n.grades.overall.score,
        rationale: n.grades.overall.rationale,
        ...(hasTrialData ? { passRate: nextRate } : {}),
      },
    };
    if (nextRate < prevRate) regressions.push(entry);
    else if (nextRate > prevRate) recoveries.push(entry);
    else if (Math.abs(n.grades.overall.score - p.grades.overall.score) > SCORE_EPSILON)
      scoreShifts.push(entry);
    else unchanged += 1;
  }

  const diff: ReportDiff = {
    prevRunId: prev.summary.runId,
    newRunId: next.summary.runId,
    regressions,
    recoveries,
    scoreShifts,
    unchanged,
  };
  return {
    html: renderDiffHtml(diff, prev.summary, next.summary),
    json: JSON.stringify(diff, null, 2),
    diff,
  };
}
