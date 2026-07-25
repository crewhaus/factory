/**
 * NEW-graders-2 — categorical judge rubrics: schema validation
 * (`loadCategoricalRubric`), the categorical prompt, `judgeCategorical`'s
 * forced `submit_label` call, and `createJudgeGrader`'s label→grade
 * mapping. All stubbed — no network.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import type { Sample } from "@crewhaus/eval-dataset";
import type { RunResult } from "@crewhaus/eval-grader";
import { makeLabelStubClient, makeNaiveStubClient } from "./__test__/stub-client";
import {
  JudgeError,
  buildCategoricalJudgePrompt,
  createJudgeGrader,
  isCategoricalRubric,
  judgeCategorical,
  loadCategoricalRubric,
  loadRubric,
} from "./index";
import type { CategoricalRubric } from "./index";

const CATEGORICAL_YAML = `
kind: categorical
labels:
  - name: correct
    score: 1
    description: factually correct and complete
  - name: partial
    score: 0.5
    description: partially correct
  - name: wrong
    score: 0
    description: contains a factual error
passing_labels: [correct, partial]
`;

const RUBRIC: CategoricalRubric = loadCategoricalRubric(CATEGORICAL_YAML);

const SAMPLE: Sample = { id: "s1", input: "what is 2+2?", expected_output: "4" };

function runResult(agentOutput: string): RunResult {
  return { agentOutput, events: [], transcript: [], toolCalls: [], turns: 1, latencyMs: 5 };
}

describe("loadCategoricalRubric (NEW-graders-2)", () => {
  test("parses YAML: labels + passing_labels", () => {
    expect(RUBRIC.kind).toBe("categorical");
    expect(RUBRIC.labels).toHaveLength(3);
    expect(RUBRIC.passing_labels).toEqual(["correct", "partial"]);
  });

  test("accepts a pre-parsed object", () => {
    const r = loadCategoricalRubric({
      kind: "categorical",
      labels: [
        { name: "a", score: 1, description: "x" },
        { name: "b", score: 0, description: "y" },
      ],
      passing_labels: ["a"],
    });
    expect(r.labels.map((l) => l.name)).toEqual(["a", "b"]);
  });

  test("rejects fewer than two labels", () => {
    expect(() =>
      loadCategoricalRubric({
        kind: "categorical",
        labels: [{ name: "only", score: 1, description: "x" }],
        passing_labels: ["only"],
      }),
    ).toThrow(JudgeError);
  });

  test("rejects duplicate label names", () => {
    expect(() =>
      loadCategoricalRubric({
        kind: "categorical",
        labels: [
          { name: "dup", score: 1, description: "x" },
          { name: "dup", score: 0, description: "y" },
        ],
        passing_labels: ["dup"],
      }),
    ).toThrow(/duplicate label name/);
  });

  test("rejects a passing label that is not declared", () => {
    expect(() =>
      loadCategoricalRubric({
        kind: "categorical",
        labels: [
          { name: "a", score: 1, description: "x" },
          { name: "b", score: 0, description: "y" },
        ],
        passing_labels: ["nope"],
      }),
    ).toThrow(/not a declared label/);
  });

  test("rejects duplicate passing labels", () => {
    expect(() =>
      loadCategoricalRubric({
        kind: "categorical",
        labels: [
          { name: "a", score: 1, description: "x" },
          { name: "b", score: 0, description: "y" },
        ],
        passing_labels: ["a", "a"],
      }),
    ).toThrow(/duplicate passing label/);
  });

  test("rejects out-of-range label scores", () => {
    expect(() =>
      loadCategoricalRubric({
        kind: "categorical",
        labels: [
          { name: "a", score: 2, description: "x" },
          { name: "b", score: 0, description: "y" },
        ],
        passing_labels: ["a"],
      }),
    ).toThrow(JudgeError);
  });

  test("strict: a stray key (leftover scalar criteria) fails loudly", () => {
    expect(() =>
      loadCategoricalRubric({
        kind: "categorical",
        labels: [
          { name: "a", score: 1, description: "x" },
          { name: "b", score: 0, description: "y" },
        ],
        passing_labels: ["a"],
        criteria: [],
      }),
    ).toThrow(JudgeError);
  });

  test("loadRubric rejects a categorical rubric with a pointed error", () => {
    expect(() => loadRubric(CATEGORICAL_YAML)).toThrow(/categorical/);
  });

  test("loadRubric rejects a half-migrated rubric (criteria + labels, NO kind) pointedly", () => {
    // The non-strict scalar schema must never silently strip the labels and
    // judge scalar while the user believes they declared a categorical rubric.
    const halfMigrated = {
      criteria: [
        {
          name: "c1",
          description: "x",
          anchors: { "1": "a", "2": "b", "3": "c", "4": "d", "5": "e" },
        },
      ],
      labels: [
        { name: "a", score: 1, description: "x" },
        { name: "b", score: 0, description: "y" },
      ],
      passing_labels: ["a"],
    };
    expect(() => loadRubric(halfMigrated)).toThrow(JudgeError);
    expect(() => loadRubric(halfMigrated)).toThrow(/did you mean `kind: categorical`/);
  });

  test("isCategoricalRubric narrows the union", () => {
    expect(isCategoricalRubric(RUBRIC)).toBe(true);
    expect(
      isCategoricalRubric(
        loadRubric(`
criteria:
  - name: c1
    description: x
    anchors: { "1": a, "2": b, "3": c, "4": d, "5": e }
`),
      ),
    ).toBe(false);
  });
});

describe("buildCategoricalJudgePrompt (NEW-graders-2)", () => {
  test("wraps untrusted blocks with per-call sentinel and lists labels", () => {
    const { system, user, sentinel } = buildCategoricalJudgePrompt({
      rubric: RUBRIC,
      input: "INJECTED INPUT",
      expectedOutput: "GOLD",
      agentOutput: "AGENT SAYS",
    });
    const open = `<<<UNTRUSTED_${sentinel}>>>`;
    const close = `<<<END_${sentinel}>>>`;
    expect(user).toContain(`${open}\nINJECTED INPUT\n${close}`);
    expect(user).toContain(`${open}\nGOLD\n${close}`);
    expect(user).toContain(`${open}\nAGENT SAYS\n${close}`);
    expect(user).toContain("Label: correct");
    expect(user).toContain("Label: partial");
    expect(user).toContain("Label: wrong");
    expect(system).toContain("submit_label");
    expect(system).toContain("DATA");
  });

  test("label scores and the passing set are NOT shown to the judge", () => {
    const { user } = buildCategoricalJudgePrompt({
      rubric: RUBRIC,
      input: "i",
      expectedOutput: undefined,
      agentOutput: "o",
    });
    expect(user).not.toContain("passing_labels");
    expect(user).not.toContain("score");
  });

  test("target: transcript relabels the judged block and frames trajectory", () => {
    const { system, user } = buildCategoricalJudgePrompt({
      rubric: RUBRIC,
      input: "i",
      expectedOutput: undefined,
      agentOutput: "[assistant] digest",
      target: "transcript",
    });
    expect(user).toContain("Agent transcript <<<UNTRUSTED_");
    expect(user).not.toContain("Agent output <<<UNTRUSTED_");
    expect(system).toContain("RUN TRANSCRIPT");
  });
});

describe("judgeCategorical (NEW-graders-2)", () => {
  test("returns the chosen label with its DECLARED score", async () => {
    const adapter = makeLabelStubClient(() => ({ label: "partial", rationale: "half right" }));
    const result = await judgeCategorical({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "2+2 is about 4",
      adapter,
      model: "stub",
    });
    expect(result.label).toBe("partial");
    expect(result.score).toBe(0.5);
    expect(result.abstain).toBe(false);
    expect(result.rationale).toBe("half right");
  });

  test("surfaces abstain + confidence", async () => {
    const adapter = makeLabelStubClient(() => ({
      label: "wrong",
      rationale: "no evidence",
      abstain: true,
      confidence: 0.2,
    }));
    const result = await judgeCategorical({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "",
      adapter,
      model: "stub",
    });
    expect(result.abstain).toBe(true);
    expect(result.confidence).toBe(0.2);
  });

  test("rejects an undeclared label (closed enum)", async () => {
    const adapter = makeLabelStubClient(() => ({ label: "excellent", rationale: "made up" }));
    await expect(
      judgeCategorical({
        rubric: RUBRIC,
        sample: SAMPLE,
        agentOutput: "x",
        adapter,
        model: "stub",
      }),
    ).rejects.toThrow(JudgeError);
  });

  test("rejects when the judge skips submit_label", async () => {
    // The scalar stub answers with submit_score — the categorical judge must
    // treat that as a missing submit_label call.
    const adapter = makeNaiveStubClient(() => ({
      score: 5,
      rationale: "wrong tool",
      criterion_scores: {},
    }));
    await expect(
      judgeCategorical({
        rubric: RUBRIC,
        sample: SAMPLE,
        agentOutput: "x",
        adapter,
        model: "stub",
      }),
    ).rejects.toThrow(/did not call submit_label/);
  });

  test("pins temperature 0 by default and honors an override", async () => {
    const captured: ProviderRequest[] = [];
    const inner = makeLabelStubClient(() => ({ label: "correct", rationale: "ok" }));
    const adapter: ProviderAdapter = {
      ...inner,
      stream(req) {
        captured.push(req);
        return inner.stream(req);
      },
    };
    await judgeCategorical({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "4",
      adapter,
      model: "stub",
    });
    await judgeCategorical({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "4",
      adapter,
      model: "stub",
      temperature: 0.7,
    });
    expect(captured[0]?.temperature).toBe(0);
    expect(captured[1]?.temperature).toBe(0.7);
    expect(captured[0]?.toolChoice).toEqual({ type: "tool", name: "submit_label" });
  });
});

describe("createJudgeGrader with a categorical rubric (NEW-graders-2)", () => {
  test("passed = chosen label in passing_labels; score = label score", async () => {
    const adapter = makeLabelStubClient((userText) =>
      userText.includes("TOKEN_RIGHT")
        ? { label: "correct", rationale: "yes" }
        : { label: "wrong", rationale: "no" },
    );
    const grader = createJudgeGrader(RUBRIC, { adapter, model: "stub" });

    const pass = await grader(SAMPLE, runResult("the answer is TOKEN_RIGHT"));
    expect(pass.passed).toBe(true);
    expect(pass.score).toBe(1);
    expect(pass.rationale).toContain('judge label="correct"');
    expect(pass.rationale).toContain("passing: correct|partial");

    const fail = await grader(SAMPLE, runResult("the answer is five"));
    expect(fail.passed).toBe(false);
    expect(fail.score).toBe(0);
    expect(fail.rationale).toContain('judge label="wrong"');
  });

  test("a passing label with fractional score keeps its declared score", async () => {
    const adapter = makeLabelStubClient(() => ({ label: "partial", rationale: "half" }));
    const grader = createJudgeGrader(RUBRIC, { adapter, model: "stub" });
    const grade = await grader(SAMPLE, runResult("2+2 is around 4"));
    expect(grade.passed).toBe(true);
    expect(grade.score).toBe(0.5);
  });

  test("an abstaining categorical judge yields an abstained grade", async () => {
    const adapter = makeLabelStubClient(() => ({
      label: "wrong",
      rationale: "output empty",
      abstain: true,
      confidence: 0.1,
    }));
    const grader = createJudgeGrader(RUBRIC, { adapter, model: "stub" });
    const grade = await grader(SAMPLE, runResult(""));
    expect(grade.abstained).toBe(true);
    expect(grade.passed).toBe(false);
    expect(grade.score).toBe(0);
    expect(grade.confidence).toBe(0.1);
    expect(grade.rationale).toContain("judge abstained");
  });

  test("a normal categorical verdict has NO abstained/detail keys", async () => {
    const adapter = makeLabelStubClient(() => ({ label: "correct", rationale: "ok" }));
    const grader = createJudgeGrader(RUBRIC, { adapter, model: "stub" });
    const grade = await grader(SAMPLE, runResult("4"));
    expect("abstained" in grade).toBe(false);
    expect("detail" in grade).toBe(false);
  });

  test("rejects repeats and judges panels with a categorical rubric", () => {
    expect(() => createJudgeGrader(RUBRIC, { repeats: 3 })).toThrow(JudgeError);
    expect(() => createJudgeGrader(RUBRIC, { judges: ["m1", "m2"] })).toThrow(JudgeError);
    expect(() => createJudgeGrader(RUBRIC, { repeats: 3 })).toThrow(/categorical/);
  });
});
