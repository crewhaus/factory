/**
 * The eval regression gate: two `results.json` documents in, one verdict out.
 *
 * This is the decision `crewhaus eval` makes after a run — did the candidate
 * hold the line against its baseline — computed here as a PURE function of
 * the two documents, so a manager harness can gate a rollout with no model
 * call and no eval runner.
 *
 * The reader is deliberately tolerant. A `results.json` gains fields every
 * release, and a gate that refuses to read last month's run is a gate nobody
 * can use: anything it does not recognise is ignored, and the two figures it
 * cannot do without (a per-sample verdict and a pass rate) are recovered from
 * the samples when the aggregate block is missing.
 *
 * Verdict semantics mirror `@crewhaus/eval-report`'s diff — regressions are
 * pass → fail on a SHARED sample id, recoveries are fail → pass, and a score
 * shift is a verdict-preserving move larger than epsilon. The thresholds are
 * the caller's: this module applies them, it does not invent them.
 */

import { compareStrings } from "./spec-view";

/** Matches `@crewhaus/eval-runner`'s own default score sensitivity. */
export const DEFAULT_SCORE_EPSILON = 0.1;

export type EvalSampleView = {
  readonly sampleId: string;
  readonly passed: boolean;
  readonly score: number;
  /** The judge declined to score; `passed: false` is a placeholder, not a verdict. */
  readonly abstained?: boolean;
  /** The invoker failed, so the sample never produced an answer to grade. */
  readonly errored?: boolean;
};

export type EvalRunView = {
  readonly runId?: string;
  readonly datasetName?: string;
  readonly model?: string;
  readonly passRate: number;
  readonly meanScore?: number;
  readonly sampleCount: number;
  readonly samples: readonly EvalSampleView[];
  /** True when `passRate` was recomputed from samples rather than read. */
  readonly passRateDerived: boolean;
  /**
   * Sample ids that appear more than once. They are matched by id, so a
   * repeat silently shadows its earlier twin — a duplicate can hide a
   * regression, which makes it a fact the gate has to state.
   */
  readonly duplicateSampleIds: readonly string[];
  /**
   * Set when the document DECLARED a pass rate that its own samples do not
   * support. The declared figure is still used (it is what the runner
   * published) but a gate reading it should know the two disagree.
   */
  readonly declaredPassRateMismatch?: { readonly declared: number; readonly derived: number };
  /** A declared pass rate that was refused for being outside 0..1. */
  readonly declaredPassRateRejected?: number;
};

export type ReadEvalRunResult =
  | { readonly ok: true; readonly run: EvalRunView }
  | { readonly ok: false; readonly error: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Project an eval run document into the view the gate needs.
 *
 * Accepted shapes: the runner's `results.json` (`samples[]` +
 * `aggregates.passRate` + `config`), and any document with the same two
 * essentials under those names.
 */
export function readEvalRun(doc: unknown, label: string): ReadEvalRunResult {
  const root = asRecord(doc);
  if (root === undefined) {
    return { ok: false, error: `${label} is not a JSON object` };
  }
  const rawSamples = root["samples"];
  if (!Array.isArray(rawSamples)) {
    return { ok: false, error: `${label} has no "samples" array — is it an eval results.json?` };
  }
  const samples: EvalSampleView[] = [];
  for (const [i, raw] of rawSamples.entries()) {
    const sample = asRecord(raw);
    if (sample === undefined) continue;
    const sampleId = asString(sample["sampleId"]) ?? `<sample ${i}>`;
    const overall = asRecord(asRecord(sample["grades"])?.["overall"]);
    const passed = overall?.["passed"] === true;
    const score = asNumber(overall?.["score"]) ?? 0;
    samples.push({
      sampleId,
      passed,
      score,
      ...(overall?.["abstained"] === true ? { abstained: true } : {}),
      ...(asString(sample["error"]) !== undefined ? { errored: true } : {}),
    });
  }
  if (samples.length === 0) {
    return { ok: false, error: `${label} contains no samples` };
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const sample of samples) {
    if (seen.has(sample.sampleId)) duplicates.add(sample.sampleId);
    seen.add(sample.sampleId);
  }

  const aggregates = asRecord(root["aggregates"]);
  const rawPassRate = asNumber(aggregates?.["passRate"]);
  // A pass rate outside 0..1 is not a pass rate. Taking it on trust would
  // let a document declare `passRate: 99` and walk through `minPassRate`, so
  // an out-of-range figure is discarded and the samples answer instead.
  const declaredPassRate =
    rawPassRate !== undefined && rawPassRate >= 0 && rawPassRate <= 1 ? rawPassRate : undefined;
  const derivedPassRate = samples.filter((s) => s.passed).length / samples.length;
  // Only meaningful when nothing was dropped: with duplicate ids or a
  // sampled/partial aggregate the two are expected to differ.
  const mismatch =
    declaredPassRate !== undefined && Math.abs(declaredPassRate - derivedPassRate) > 1e-9
      ? { declared: declaredPassRate, derived: derivedPassRate }
      : undefined;
  const config = asRecord(root["config"]);
  return {
    ok: true,
    run: {
      ...(asString(root["runId"]) !== undefined
        ? { runId: asString(root["runId"]) as string }
        : {}),
      ...(asString(config?.["datasetName"]) !== undefined
        ? { datasetName: asString(config?.["datasetName"]) as string }
        : {}),
      ...(asString(config?.["model"]) !== undefined
        ? { model: asString(config?.["model"]) as string }
        : {}),
      passRate: declaredPassRate ?? derivedPassRate,
      ...(asNumber(aggregates?.["meanScore"]) !== undefined
        ? { meanScore: asNumber(aggregates?.["meanScore"]) as number }
        : {}),
      sampleCount: samples.length,
      samples,
      passRateDerived: declaredPassRate === undefined,
      duplicateSampleIds: [...duplicates].sort(compareStrings),
      ...(mismatch !== undefined ? { declaredPassRateMismatch: mismatch } : {}),
      ...(rawPassRate !== undefined && declaredPassRate === undefined
        ? { declaredPassRateRejected: rawPassRate }
        : {}),
    },
  };
}

export type SampleDelta = {
  readonly sampleId: string;
  readonly baseline: { readonly passed: boolean; readonly score: number };
  readonly candidate: { readonly passed: boolean; readonly score: number };
};

export type EvalGateThresholds = {
  /** Candidate pass rate must be at least this (0..1). */
  readonly minPassRate?: number;
  /** Candidate may fall at most this far below the baseline (0..1). Default 0. */
  readonly maxPassRateDrop?: number;
  /** How many shared samples may go pass → fail. Default 0. */
  readonly maxRegressions?: number;
  /** Verdict-preserving score moves smaller than this are not reported. */
  readonly scoreEpsilon?: number;
};

export type EvalGateResult = {
  readonly verdict: "pass" | "fail";
  readonly reasons: readonly string[];
  readonly passRate: {
    readonly baseline: number;
    readonly candidate: number;
    readonly delta: number;
  };
  readonly meanScore?: {
    readonly baseline: number;
    readonly candidate: number;
    readonly delta: number;
  };
  readonly samples: {
    readonly shared: number;
    readonly baselineOnly: readonly string[];
    readonly candidateOnly: readonly string[];
  };
  readonly regressions: readonly SampleDelta[];
  readonly recoveries: readonly SampleDelta[];
  readonly scoreShifts: readonly SampleDelta[];
  /** Shared samples whose candidate side abstained or errored — not verdicts. */
  readonly inconclusive: readonly string[];
  readonly thresholds: {
    readonly minPassRate?: number;
    readonly maxPassRateDrop: number;
    readonly maxRegressions: number;
    readonly scoreEpsilon: number;
  };
  /** Set when either side's pass rate had to be recomputed from samples. */
  readonly notes: readonly string[];
};

/** Round to 6 decimals so a float artefact never shows up as a "change". */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Compare a candidate run against a baseline run and apply the caller's
 * thresholds.
 *
 * Samples are matched by `sampleId`; a sample present on only one side is
 * reported but never counted as a regression, because there is nothing to
 * compare it to. An abstained or errored candidate sample is listed as
 * INCONCLUSIVE and still counted in the pass rate (that is what the runner's
 * own aggregate does) — the list exists so a gate failure caused by judge
 * noise is visible as such.
 */
export function compareEvalRuns(
  baseline: EvalRunView,
  candidate: EvalRunView,
  thresholds: EvalGateThresholds = {},
): EvalGateResult {
  const maxPassRateDrop = thresholds.maxPassRateDrop ?? 0;
  const maxRegressions = thresholds.maxRegressions ?? 0;
  const scoreEpsilon = thresholds.scoreEpsilon ?? DEFAULT_SCORE_EPSILON;

  const baseById = new Map(baseline.samples.map((s) => [s.sampleId, s]));
  const candById = new Map(candidate.samples.map((s) => [s.sampleId, s]));

  const regressions: SampleDelta[] = [];
  const recoveries: SampleDelta[] = [];
  const scoreShifts: SampleDelta[] = [];
  const inconclusive: string[] = [];
  let shared = 0;

  for (const id of [...baseById.keys()].sort(compareStrings)) {
    const before = baseById.get(id);
    const after = candById.get(id);
    if (before === undefined || after === undefined) continue;
    shared += 1;
    const delta: SampleDelta = {
      sampleId: id,
      baseline: { passed: before.passed, score: round(before.score) },
      candidate: { passed: after.passed, score: round(after.score) },
    };
    if (after.abstained === true || after.errored === true) inconclusive.push(id);
    if (before.passed && !after.passed) regressions.push(delta);
    else if (!before.passed && after.passed) recoveries.push(delta);
    else if (Math.abs(after.score - before.score) > scoreEpsilon) scoreShifts.push(delta);
  }

  const baselineOnly = [...baseById.keys()].filter((id) => !candById.has(id)).sort(compareStrings);
  const candidateOnly = [...candById.keys()].filter((id) => !baseById.has(id)).sort(compareStrings);

  const passRateDelta = round(candidate.passRate - baseline.passRate);
  const reasons: string[] = [];
  if (regressions.length > maxRegressions) {
    reasons.push(
      `${regressions.length} sample${regressions.length === 1 ? "" : "s"} went pass → fail (limit ${maxRegressions}): ${regressions
        .map((r) => r.sampleId)
        .join(", ")}`,
    );
  }
  if (passRateDelta < -maxPassRateDrop) {
    reasons.push(
      `pass rate fell by ${round(-passRateDelta)} (limit ${maxPassRateDrop}): ${round(baseline.passRate)} → ${round(candidate.passRate)}`,
    );
  }
  if (thresholds.minPassRate !== undefined && candidate.passRate < thresholds.minPassRate) {
    reasons.push(
      `pass rate ${round(candidate.passRate)} is below the declared floor ${thresholds.minPassRate}`,
    );
  }

  const notes: string[] = [];
  for (const [label, run] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    if (run.duplicateSampleIds.length > 0) {
      notes.push(
        `the ${label} repeats ${run.duplicateSampleIds.length} sample id${run.duplicateSampleIds.length === 1 ? "" : "s"} (${run.duplicateSampleIds.join(", ")}) — samples are matched by id, so only the last of each was compared`,
      );
    }
    const mismatch = run.declaredPassRateMismatch;
    if (mismatch !== undefined) {
      notes.push(
        `the ${label} declares a pass rate of ${round(mismatch.declared)} but its own samples give ${round(mismatch.derived)} — the declared figure was used`,
      );
    }
    if (run.declaredPassRateRejected !== undefined) {
      notes.push(
        `the ${label} declared a pass rate of ${run.declaredPassRateRejected}, which is outside 0..1 — it was discarded in favour of its samples`,
      );
    }
  }
  if (baseline.passRateDerived || candidate.passRateDerived) {
    notes.push(
      "a pass rate was recomputed from per-sample verdicts because the document carried no aggregates.passRate",
    );
  }
  if (baseline.datasetName !== candidate.datasetName) {
    notes.push(
      `the two runs name different datasets (${baseline.datasetName ?? "unknown"} vs ${candidate.datasetName ?? "unknown"}) — scores from different datasets are not comparable`,
    );
  }
  if (shared === 0) {
    notes.push("the two runs share no sample ids, so no per-sample comparison was possible");
  }

  return {
    verdict: reasons.length === 0 ? "pass" : "fail",
    reasons,
    passRate: {
      baseline: round(baseline.passRate),
      candidate: round(candidate.passRate),
      delta: passRateDelta,
    },
    ...(baseline.meanScore !== undefined && candidate.meanScore !== undefined
      ? {
          meanScore: {
            baseline: round(baseline.meanScore),
            candidate: round(candidate.meanScore),
            delta: round(candidate.meanScore - baseline.meanScore),
          },
        }
      : {}),
    samples: { shared, baselineOnly, candidateOnly },
    regressions,
    recoveries,
    scoreShifts,
    inconclusive,
    thresholds: {
      ...(thresholds.minPassRate !== undefined ? { minPassRate: thresholds.minPassRate } : {}),
      maxPassRateDrop,
      maxRegressions,
      scoreEpsilon,
    },
    notes,
  };
}
