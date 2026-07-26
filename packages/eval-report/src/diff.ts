import { DEFAULT_SCORE_EPSILON } from "@crewhaus/eval-runner";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { ReportError } from "./errors";
import type { LoadedRun } from "./load";
import type { PairwiseDiff } from "./pairwise";
import { renderDiffHtml } from "./render";
import { type DiffSignificance, computeDiffSignificance } from "./significance";

export type ReportDiff = {
  readonly prevRunId: string;
  readonly newRunId: string;
  readonly regressions: ReadonlyArray<DiffEntry>; // pass → fail
  readonly recoveries: ReadonlyArray<DiffEntry>; // fail → pass
  readonly scoreShifts: ReadonlyArray<DiffEntry>; // |Δscore| > ε
  readonly unchanged: number;
  /**
   * B13 — per-slice deltas over the slice (key, value) pairs BOTH runs
   * recorded (a slice present on only one side has no delta to show).
   * Absent when neither run carried `slices`, or none are shared — old
   * diff.json readers see exactly the pre-B13 shape.
   */
  readonly sliceDeltas?: ReadonlyArray<SliceDelta>;
  /**
   * C29 — paired sign-flip permutation test on the per-sample pass-rate
   * deltas: decision support riding beside the strict gate, never part of
   * it. Absent when no comparable pairs exist (every shared sample abstained
   * on a side) and on diff.json written by older CLIs.
   */
  readonly significance?: DiffSignificance;
  /**
   * A1 — head-to-head pairwise judging of the two runs' outputs
   * (`eval-report diff --pairwise`): per-sample order-swapped verdicts,
   * win/loss/tie tallies, win-rate, and order-consistency. Purely
   * additive — absent on offline diffs (the default), so diff.json is
   * byte-identical without the flag.
   */
  readonly pairwise?: PairwiseDiff;
};

export type DiffEntry = {
  readonly sampleId: string;
  readonly prev: DiffEntrySide;
  readonly next: DiffEntrySide;
};

export type DiffEntrySide = {
  passed: boolean;
  score: number;
  rationale: string;
  passRate?: number;
  /** A3 — this side's outcome was `abstained` (judge declined, nothing else
   *  failed); `passed: false` is then a placeholder, not a verdict. */
  abstained?: boolean;
};

/** B13 — one shared slice's before/after figures. */
export type SliceDelta = {
  readonly key: string;
  readonly value: string;
  readonly prev: { passRate: number; meanScore: number; sampleCount: number };
  readonly next: { passRate: number; meanScore: number; sampleCount: number };
};

/**
 * NEW-stats-1 — the score-shift sensitivity: how far a sample's score may
 * move, with its pass/fail verdict unchanged, before the diff calls it a
 * SHIFT. A knob (`eval-report diff --epsilon`) rather than a constant,
 * because a 1–5 rubric and a 0/1 grader do not deserve the same tolerance.
 *
 * The default is re-exported from `@crewhaus/eval-runner` — ONE literal
 * shared with `regression-runner`'s gate classifier, so the diff a human
 * READS and the gate that BLOCKS can never drift apart. Unchanged in value
 * (0.1), so every existing diff classifies byte-identically.
 */
export { DEFAULT_SCORE_EPSILON };

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
 *
 * C29 — `opts.seed` pins the significance test's Monte Carlo draw and
 * bootstrap CI (defaults to a fixed seed, so identical inputs give
 * byte-identical diff.json across runs).
 *
 * A1 — `opts.pairwise` attaches a pre-computed pairwise-judging block (the
 * CLI's `--pairwise` runs the judge calls BEFORE this pure fold) to
 * diff.json and the rendered report. Omitted ⇒ byte-identical output.
 *
 * NEW-stats-1 — `opts.epsilon` sets the score-shift tolerance (default
 * {@link DEFAULT_SCORE_EPSILON}): only |Δscore| STRICTLY above it counts as
 * a shift. Flips (pass↔fail, or a trial pass-rate move) are never subject to
 * it — a verdict change is a verdict change at any epsilon.
 */
export function diffReports(
  prev: LoadedRun,
  next: LoadedRun,
  opts: {
    readonly seed?: number;
    readonly pairwise?: PairwiseDiff;
    readonly epsilon?: number;
  } = {},
): { html: string; json: string; diff: ReportDiff } {
  const epsilon = opts.epsilon ?? DEFAULT_SCORE_EPSILON;
  if (!Number.isFinite(epsilon) || epsilon < 0) {
    throw new ReportError(
      `invalid score-shift epsilon ${JSON.stringify(opts.epsilon)} — must be a non-negative number`,
    );
  }
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
  // C29 — per-sample rate deltas over the comparable pairs, for the paired
  // significance test. Abstained-on-either-side pairs are excluded: their
  // FAIL is a placeholder, not a verdict (the same exclusion the
  // run-history gate applies to its flip comparison).
  const pairedDeltas: number[] = [];
  let unchanged = 0;

  for (const sampleId of prevKeys) {
    const p = prevById.get(sampleId) as SampleResult;
    const n = nextById.get(sampleId) as SampleResult;
    const hasTrialData = p.trialPassRate !== undefined || n.trialPassRate !== undefined;
    const prevRate = p.trialPassRate ?? (p.grades.overall.passed ? 1 : 0);
    const nextRate = n.trialPassRate ?? (n.grades.overall.passed ? 1 : 0);
    // A3 — surface abstention on the entry sides (an abstained "fail" is a
    // placeholder, not a verdict; the report renders it ABSTAINED and the
    // run-history gate excludes such samples from the flip comparison).
    const prevAbstained = p.error === undefined && p.grades.overall.abstained === true;
    const nextAbstained = n.error === undefined && n.grades.overall.abstained === true;
    const entry: DiffEntry = {
      sampleId,
      prev: {
        passed: p.grades.overall.passed,
        score: p.grades.overall.score,
        rationale: p.grades.overall.rationale,
        ...(hasTrialData ? { passRate: prevRate } : {}),
        ...(prevAbstained ? { abstained: true } : {}),
      },
      next: {
        passed: n.grades.overall.passed,
        score: n.grades.overall.score,
        rationale: n.grades.overall.rationale,
        ...(hasTrialData ? { passRate: nextRate } : {}),
        ...(nextAbstained ? { abstained: true } : {}),
      },
    };
    if (nextRate < prevRate) regressions.push(entry);
    else if (nextRate > prevRate) recoveries.push(entry);
    else if (Math.abs(n.grades.overall.score - p.grades.overall.score) > epsilon)
      scoreShifts.push(entry);
    else unchanged += 1;
    if (!prevAbstained && !nextAbstained) pairedDeltas.push(nextRate - prevRate);
  }

  // B13 — per-slice deltas over the (key, value) pairs both runs recorded.
  const sliceDeltas = computeSliceDeltas(prev.summary, next.summary);
  // C29 — paired significance over the comparable deltas (decision support;
  // the strict classification above is untouched by it).
  const significance = computeDiffSignificance(pairedDeltas, { seed: opts.seed });

  const diff: ReportDiff = {
    prevRunId: prev.summary.runId,
    newRunId: next.summary.runId,
    regressions,
    recoveries,
    scoreShifts,
    unchanged,
    ...(sliceDeltas.length > 0 ? { sliceDeltas } : {}),
    ...(significance !== undefined ? { significance } : {}),
    ...(opts.pairwise !== undefined ? { pairwise: opts.pairwise } : {}),
  };
  return {
    html: renderDiffHtml(diff, prev.summary, next.summary),
    json: JSON.stringify(diff, null, 2),
    diff,
  };
}

/**
 * B13 — the compact stdout per-slice delta block: one line per slice key,
 * each shared value's pass-rate move plus before/after figures (the CLI
 * prepends its `[eval-report] ` prefix). Empty when nothing is shared, so
 * pre-B13 runs add no output.
 */
export function formatSliceDeltaLines(deltas: ReadonlyArray<SliceDelta>): string[] {
  const byKey = new Map<string, SliceDelta[]>();
  for (const d of deltas) {
    const group = byKey.get(d.key);
    if (group !== undefined) group.push(d);
    else byKey.set(d.key, [d]);
  }
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  return [...byKey.entries()].map(([key, group]) => {
    const parts = group.map((d) => {
      const move = d.next.passRate - d.prev.passRate;
      return (
        `${d.value} ${move >= 0 ? "+" : ""}${pct(move)} ` +
        `(${pct(d.prev.passRate)}→${pct(d.next.passRate)}, n=${d.next.sampleCount})`
      );
    });
    return `slice ${key}: ${parts.join(" · ")}`;
  });
}

/**
 * B13 — pair up the two runs' `slices` blocks on shared (key, value) and
 * emit before/after figures for each. Slices only one run recorded are
 * skipped (nothing to compare); runs without `slices` (older CLIs,
 * metadata-less datasets) yield an empty list.
 */
function computeSliceDeltas(prev: EvalRunSummary, next: EvalRunSummary): SliceDelta[] {
  if (prev.slices === undefined || next.slices === undefined) return [];
  const deltas: SliceDelta[] = [];
  for (const key of Object.keys(prev.slices).sort()) {
    const prevByValue = prev.slices[key];
    const nextByValue = next.slices[key];
    if (prevByValue === undefined || nextByValue === undefined) continue;
    for (const value of Object.keys(prevByValue).sort()) {
      const p = prevByValue[value];
      const n = nextByValue[value];
      if (p === undefined || n === undefined) continue;
      deltas.push({
        key,
        value,
        prev: { passRate: p.passRate, meanScore: p.meanScore, sampleCount: p.sampleCount },
        next: { passRate: n.passRate, meanScore: n.meanScore, sampleCount: n.sampleCount },
      });
    }
  }
  return deltas;
}
