/**
 * A9 — `calibration.abstentionAware`: the classification matrix
 * (answered-correct / answered-wrong / not-attempted), the loud-gold rule,
 * and the cross-sample aggregation lens (`detectCalibrationAggregates` +
 * `aggregate()` integration).
 */
import { describe, expect, test } from "bun:test";
import { GraderError } from "@crewhaus/eval-grader";
import type { RunResult, Sample } from "@crewhaus/eval-grader";
import { aggregate } from "./aggregate";
import {
  CALIBRATION_RATIONALE_PREFIX,
  CalibrationAbstentionOptsSchema,
  calibrationAbstentionAware,
  detectCalibrationAggregates,
  isExplicitDecline,
} from "./calibration-abstention";
import type { SampleResult } from "./types";

function runWith(agentOutput: string): RunResult {
  return { agentOutput, events: [], transcript: [], toolCalls: [], turns: 1, latencyMs: 5 };
}

const GOLD_SAMPLE: Sample = { id: "q1", input: "capital of France?", expected_output: "Paris" };
const GOLDLESS_SAMPLE: Sample = { id: "q2", input: "capital of France?" };

function sampleResult(
  overrides: Partial<SampleResult> & { sampleId: string; rationales?: string[] },
): SampleResult {
  const { rationales, ...rest } = overrides;
  return {
    sessionId: "sess",
    startedAt: "t0",
    endedAt: "t1",
    latencyMs: 1,
    turns: 1,
    tokens: { input: 1, output: 1 },
    model: "m",
    agentOutput: "out",
    grades: {
      overall: { passed: true, score: 1, rationale: "ok" },
      perGrader: (rationales ?? []).map((rationale, i) => ({
        name: `g${i}`,
        passed: true,
        score: 1,
        rationale,
      })),
    },
    ...rest,
  };
}

describe("isExplicitDecline (A9 heuristics)", () => {
  test("matches curated decline openers", () => {
    for (const text of [
      "I don't know.",
      "I do not know the answer to that.",
      "I can't answer that question.",
      "I cannot determine this from the given data.",
      "I am unable to answer that.",
      "I'm unable to determine the result.",
      "I don't have enough information to answer.",
      "I'm not sure.",
      "unknown",
      "No answer",
      "not attempted",
    ]) {
      expect(isExplicitDecline(text)).toBe(true);
    }
  });

  test("strips apology prefixes and normalizes curly apostrophes", () => {
    expect(isExplicitDecline("I'm sorry, I don't know.")).toBe(true);
    expect(isExplicitDecline("Sorry, I can't answer that.")).toBe(true);
    expect(isExplicitDecline("Unfortunately, I don't know.")).toBe(true);
    expect(isExplicitDecline("I don’t know.")).toBe(true);
  });

  test("a long output that merely OPENS with a hedge is an attempt", () => {
    const hedged = `I don't know exactly, but based on the data ${"x".repeat(300)}`;
    expect(isExplicitDecline(hedged)).toBe(false);
  });

  test("a SHORT hedge with a contrastive continuation is an attempt, not a decline", () => {
    // The decline must be terminal — an answer following the hedge is an
    // answer even under the length cap.
    expect(isExplicitDecline("I'm not sure, but it's Paris.")).toBe(false);
    expect(isExplicitDecline("I don't know exactly, but around 5%.")).toBe(false);
    expect(isExplicitDecline("I'm not sure; however, my best guess is Paris.")).toBe(false);
    expect(isExplicitDecline("I can't say for sure — but likely Paris.")).toBe(false);
    // Terminal declines (no contrastive continuation) still classify.
    expect(isExplicitDecline("I'm not sure.")).toBe(true);
    expect(isExplicitDecline("I'm not sure what you mean.")).toBe(true);
    expect(isExplicitDecline("I don't know exactly.")).toBe(true);
  });

  test("substantive answers and empty strings are not declines", () => {
    expect(isExplicitDecline("Paris is the capital of France.")).toBe(false);
    expect(isExplicitDecline("The answer is unknown territory mapping.")).toBe(false);
    expect(isExplicitDecline("")).toBe(false);
    expect(isExplicitDecline("   ")).toBe(false);
  });
});

describe("calibrationAbstentionAware — classification matrix (A9)", () => {
  const grader = calibrationAbstentionAware();

  test("empty and whitespace-only outputs classify not-attempted", async () => {
    for (const out of ["", "   \n\t "]) {
      const grade = await grader(GOLDLESS_SAMPLE, runWith(out));
      expect(grade.passed).toBe(false);
      expect(grade.score).toBe(0);
      expect(grade.rationale).toStartWith(`${CALIBRATION_RATIONALE_PREFIX}not-attempted]`);
    }
  });

  test("an explicit decline classifies not-attempted — no gold needed", async () => {
    const grade = await grader(GOLDLESS_SAMPLE, runWith("I don't know."));
    expect(grade.passed).toBe(false);
    expect(grade.rationale).toStartWith(`${CALIBRATION_RATIONALE_PREFIX}not-attempted]`);
  });

  test("exact mode (default): trimmed equality decides correct vs wrong", async () => {
    const correct = await grader(GOLD_SAMPLE, runWith("  Paris \n"));
    expect(correct.passed).toBe(true);
    expect(correct.score).toBe(1);
    expect(correct.rationale).toStartWith(`${CALIBRATION_RATIONALE_PREFIX}answered-correct]`);

    const wrong = await grader(GOLD_SAMPLE, runWith("Lyon"));
    expect(wrong.passed).toBe(false);
    expect(wrong.score).toBe(0);
    expect(wrong.rationale).toStartWith(`${CALIBRATION_RATIONALE_PREFIX}answered-wrong]`);

    // exact means EXACT: containing the gold is not enough.
    const contains = await grader(GOLD_SAMPLE, runWith("The capital is Paris."));
    expect(contains.rationale).toStartWith(`${CALIBRATION_RATIONALE_PREFIX}answered-wrong]`);
  });

  test("contains mode: the answer may embed the gold", async () => {
    const g = calibrationAbstentionAware({ mode: "contains" });
    const grade = await g(GOLD_SAMPLE, runWith("The capital of France is Paris."));
    expect(grade.passed).toBe(true);
    expect(grade.rationale).toContain("mode: contains");
  });

  test("a short hedged-but-substantive answer is ANSWERED — never an abstention", async () => {
    // "I'm not sure, but it's Paris." must reach correctness grading (and
    // pass under contains), not inflate abstentionRate as not-attempted.
    const g = calibrationAbstentionAware({ mode: "contains" });
    const grade = await g(GOLD_SAMPLE, runWith("I'm not sure, but it's Paris."));
    expect(grade.passed).toBe(true);
    expect(grade.rationale).toStartWith(`${CALIBRATION_RATIONALE_PREFIX}answered-correct]`);
  });

  test("caseInsensitive folds both sides", async () => {
    const g = calibrationAbstentionAware({ caseInsensitive: true });
    const grade = await g(GOLD_SAMPLE, runWith("paris"));
    expect(grade.passed).toBe(true);
  });

  test("LOUD-GOLD rule: an answered sample without expected_output throws", async () => {
    await expect(grader(GOLDLESS_SAMPLE, runWith("Paris"))).rejects.toThrow(GraderError);
    await expect(grader(GOLDLESS_SAMPLE, runWith("Paris"))).rejects.toThrow(/expected_output/);
  });

  test("opts schema is strict: unknown keys and bad modes fail loudly", () => {
    expect(CalibrationAbstentionOptsSchema.safeParse({ mode: "fuzzy" }).success).toBe(false);
    expect(CalibrationAbstentionOptsSchema.safeParse({ treshold: 0.5 }).success).toBe(false);
    expect(CalibrationAbstentionOptsSchema.safeParse({ mode: "contains" }).success).toBe(true);
    expect(CalibrationAbstentionOptsSchema.safeParse({}).success).toBe(true);
  });
});

describe("detectCalibrationAggregates + aggregate() (A9)", () => {
  const mark = (cls: string): string => `${CALIBRATION_RATIONALE_PREFIX}${cls}] evidence`;

  test("computes answerRate / abstentionRate / accuracyWhenAnswered", () => {
    const samples = [
      sampleResult({ sampleId: "a", rationales: [mark("answered-correct")] }),
      sampleResult({ sampleId: "b", rationales: [mark("answered-correct")] }),
      sampleResult({ sampleId: "c", rationales: [mark("answered-wrong")] }),
      sampleResult({ sampleId: "d", rationales: [mark("not-attempted")] }),
    ];
    const agg = detectCalibrationAggregates(samples);
    expect(agg).toEqual({
      classifiedSamples: 4,
      answerRate: 0.75,
      abstentionRate: 0.25,
      accuracyWhenAnswered: 2 / 3,
    });
  });

  test("accuracyWhenAnswered is ABSENT — never NaN — when nothing was answered", () => {
    const agg = detectCalibrationAggregates([
      sampleResult({ sampleId: "a", rationales: [mark("not-attempted")] }),
    ]);
    expect(agg).toEqual({ classifiedSamples: 1, answerRate: 0, abstentionRate: 1 });
    expect(agg !== undefined && "accuracyWhenAnswered" in agg).toBe(false);
  });

  test("errored samples are skipped (infra noise must not read as abstention)", () => {
    const agg = detectCalibrationAggregates([
      sampleResult({ sampleId: "a", rationales: [mark("answered-correct")] }),
      sampleResult({
        sampleId: "boom",
        rationales: [mark("not-attempted")],
        error: "invoker died",
      }),
    ]);
    expect(agg?.classifiedSamples).toBe(1);
    expect(agg?.abstentionRate).toBe(0);
  });

  test("returns undefined when no sample carries the marker", () => {
    expect(
      detectCalibrationAggregates([sampleResult({ sampleId: "a", rationales: ["plain pass"] })]),
    ).toBeUndefined();
    expect(detectCalibrationAggregates([])).toBeUndefined();
  });

  test("aggregate() carries the block additively — and omits it pack-less", () => {
    const withPack = aggregate([
      sampleResult({ sampleId: "a", rationales: [mark("answered-correct")] }),
      sampleResult({ sampleId: "b", rationales: [mark("not-attempted")] }),
    ]);
    expect(withPack.calibration).toEqual({
      classifiedSamples: 2,
      answerRate: 0.5,
      abstentionRate: 0.5,
      accuracyWhenAnswered: 1,
    });

    const without = aggregate([sampleResult({ sampleId: "a", rationales: ["ordinary"] })]);
    expect("calibration" in without).toBe(false);
  });
});
