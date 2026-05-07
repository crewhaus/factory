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
  readonly prev: { passed: boolean; score: number; rationale: string };
  readonly next: { passed: boolean; score: number; rationale: string };
};

const SCORE_EPSILON = 0.1;

/**
 * Compare two eval runs by `sampleId`. Throws if the keysets don't match
 * (no silent alignment by index — that would mask schema drift).
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
    const entry: DiffEntry = {
      sampleId,
      prev: {
        passed: p.grades.overall.passed,
        score: p.grades.overall.score,
        rationale: p.grades.overall.rationale,
      },
      next: {
        passed: n.grades.overall.passed,
        score: n.grades.overall.score,
        rationale: n.grades.overall.rationale,
      },
    };
    if (p.grades.overall.passed && !n.grades.overall.passed) regressions.push(entry);
    else if (!p.grades.overall.passed && n.grades.overall.passed) recoveries.push(entry);
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
