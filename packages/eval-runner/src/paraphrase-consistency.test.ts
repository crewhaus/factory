/**
 * A10 — `consistency.paraphraseGroup`: the vacuous per-sample pass, the
 * cross-sample group math (singletons 1.0 — never NaN; even splits 0.5),
 * the opt-in gating (pack marker AND groups present), and the `aggregate()`
 * integration.
 */
import { describe, expect, test } from "bun:test";
import type { RunResult, Sample } from "@crewhaus/eval-grader";
import { aggregate } from "./aggregate";
import {
  PARAPHRASE_GROUP_METADATA_KEY,
  PARAPHRASE_RATIONALE_PREFIX,
  detectParaphraseConsistency,
  paraphraseGroupConsistency,
} from "./paraphrase-consistency";
import type { SampleResult } from "./types";

const RUN: RunResult = {
  agentOutput: "x",
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 1,
};

function member(opts: {
  id: string;
  group?: string;
  passed: boolean;
  packDeclared?: boolean;
  error?: string;
  abstained?: boolean;
}): SampleResult {
  const perGrader = [
    {
      name: "verdict",
      passed: opts.passed,
      score: opts.passed ? 1 : 0,
      rationale: "graded",
    },
    ...(opts.packDeclared !== false
      ? [
          {
            name: "robustness",
            passed: true,
            score: 1,
            rationale: `${PARAPHRASE_RATIONALE_PREFIX} vacuous per-sample pass`,
          },
        ]
      : []),
  ];
  return {
    sampleId: opts.id,
    sessionId: "sess",
    startedAt: "t0",
    endedAt: "t1",
    latencyMs: 1,
    turns: 1,
    tokens: { input: 1, output: 1 },
    model: "m",
    agentOutput: "x",
    ...(opts.group !== undefined
      ? { metadata: { [PARAPHRASE_GROUP_METADATA_KEY]: opts.group } }
      : {}),
    grades: {
      overall: {
        passed: opts.passed,
        score: opts.passed ? 1 : 0,
        rationale: "overall",
        ...(opts.abstained === true ? { abstained: true } : {}),
      },
      perGrader,
    },
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

describe("paraphraseGroupConsistency — per-sample grader (A10)", () => {
  test("vacuously passes and names the sample's group in the marker rationale", async () => {
    const grader = paraphraseGroupConsistency();
    const sample: Sample = {
      id: "s1",
      input: "q",
      metadata: { [PARAPHRASE_GROUP_METADATA_KEY]: "g-42" },
    };
    const grade = await grader(sample, RUN);
    expect(grade.passed).toBe(true);
    expect(grade.score).toBe(1);
    expect(grade.rationale).toStartWith(PARAPHRASE_RATIONALE_PREFIX);
    expect(grade.rationale).toContain('group "g-42"');
  });

  test("group-less samples still vacuously pass, flagged as joining no group", async () => {
    const grader = paraphraseGroupConsistency();
    const grade = await grader({ id: "s1", input: "q" }, RUN);
    expect(grade.passed).toBe(true);
    expect(grade.rationale).toContain("joins no group");
  });
});

describe("detectParaphraseConsistency — group math (A10)", () => {
  test("fraction agreeing with the group majority; keys sorted; mean over groups", () => {
    const summary = detectParaphraseConsistency([
      member({ id: "a1", group: "gB", passed: true }),
      member({ id: "a2", group: "gB", passed: true }),
      member({ id: "a3", group: "gB", passed: false }),
      member({ id: "b1", group: "gA", passed: false }),
      member({ id: "b2", group: "gA", passed: false }),
    ]);
    expect(summary).toBeDefined();
    expect(summary?.groupCount).toBe(2);
    expect(Object.keys(summary?.consistencyByGroup ?? {})).toEqual(["gA", "gB"]);
    expect(summary?.consistencyByGroup["gA"]).toBe(1);
    expect(summary?.consistencyByGroup["gB"]).toBeCloseTo(2 / 3);
    expect(summary?.meanConsistency).toBeCloseTo((1 + 2 / 3) / 2);
  });

  test("a singleton group reads 1.0 — never NaN", () => {
    const summary = detectParaphraseConsistency([
      member({ id: "solo", group: "g", passed: false }),
    ]);
    expect(summary?.consistencyByGroup["g"]).toBe(1);
    expect(summary?.meanConsistency).toBe(1);
    expect(Number.isNaN(summary?.meanConsistency)).toBe(false);
  });

  test("an even split reads 0.5", () => {
    const summary = detectParaphraseConsistency([
      member({ id: "a", group: "g", passed: true }),
      member({ id: "b", group: "g", passed: false }),
    ]);
    expect(summary?.consistencyByGroup["g"]).toBe(0.5);
  });

  test("errored and abstained members are excluded (not verdicts)", () => {
    const summary = detectParaphraseConsistency([
      member({ id: "a", group: "g", passed: true }),
      member({ id: "b", group: "g", passed: false, error: "invoker died" }),
      member({ id: "c", group: "g", passed: false, abstained: true }),
    ]);
    // Only the one usable verdict remains — a singleton, perfectly consistent.
    expect(summary?.consistencyByGroup["g"]).toBe(1);
  });

  test("pack declared but NO groups → undefined (absent groups = absent aggregate)", () => {
    expect(detectParaphraseConsistency([member({ id: "a", passed: true })])).toBeUndefined();
  });

  test("groups present but pack NOT declared → undefined (grading stays opt-in)", () => {
    expect(
      detectParaphraseConsistency([
        member({ id: "a", group: "g", passed: true, packDeclared: false }),
      ]),
    ).toBeUndefined();
  });

  test("a group whose members are all unusable drops out entirely", () => {
    const summary = detectParaphraseConsistency([
      member({ id: "a", group: "dead", passed: true, error: "x" }),
      member({ id: "b", group: "live", passed: true }),
    ]);
    expect(summary?.groupCount).toBe(1);
    expect(summary?.consistencyByGroup["dead"]).toBeUndefined();
  });

  test("non-string group values are provenance, not group labels", () => {
    const bad = member({ id: "a", passed: true });
    const withNumeric: SampleResult = {
      ...bad,
      metadata: { [PARAPHRASE_GROUP_METADATA_KEY]: 7 },
    };
    expect(detectParaphraseConsistency([withNumeric])).toBeUndefined();
  });
});

describe("aggregate() integration (A10)", () => {
  test("carries paraphraseConsistency additively — and omits it when opted out", () => {
    const withPack = aggregate([
      member({ id: "a", group: "g", passed: true }),
      member({ id: "b", group: "g", passed: true }),
    ]);
    expect(withPack.paraphraseConsistency).toEqual({
      groupCount: 1,
      consistencyByGroup: { g: 1 },
      meanConsistency: 1,
    });

    const noPack = aggregate([member({ id: "a", group: "g", passed: true, packDeclared: false })]);
    expect("paraphraseConsistency" in noPack).toBe(false);
    // And the A9 sibling stays absent too — no cross-contamination.
    expect("calibration" in noPack).toBe(false);
  });
});
