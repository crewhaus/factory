/**
 * E48 — unit tests for the `crewhaus graders test` core: strict
 * line-numbered golden parsing, the Sample+RunResult reconstruction,
 * hand-checked Cohen's kappa, FP/FN exemplar bookkeeping (abstain/error
 * exclusion, score MAE), the runEval-mirroring grader resolution with its
 * credential-free/skip gates, the --min-agreement floor, and the rendered
 * report — plus offline CLI integration (dispatch, help, and the gate's
 * exit code with a deterministic grader; no credentials, no network).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { GradeResult, Grader } from "@crewhaus/eval-grader";
import { DEFAULT_JUDGE_MODEL } from "@crewhaus/eval-judge";
import type { GraderLookup } from "@crewhaus/eval-runner";
import {
  type GoldenOutcome,
  type GoldenVerdict,
  GradersTestError,
  MAX_EXEMPLARS,
  belowFloor,
  cohenKappa,
  goldenRunPair,
  parseGoldenVerdicts,
  renderGradersTestReport,
  replayGraderOnGoldens,
  resolveTestGraders,
  summarizeGraderTest,
} from "./graders-test";

function golden(id: string, overrides: Partial<GoldenVerdict> = {}): GoldenVerdict {
  return {
    id,
    input: `input for ${id}`,
    agent_output: `output for ${id}`,
    expected_passed: true,
    ...overrides,
  };
}

function gradeOutcome(
  id: string,
  expected: boolean,
  grade: Partial<GradeResult> & { passed: boolean },
): GoldenOutcome {
  return {
    golden: golden(id, { expected_passed: expected }),
    grade: { score: grade.passed ? 1 : 0, rationale: "r", ...grade },
  };
}

// -------- golden parsing --------

describe("parseGoldenVerdicts (E48)", () => {
  it("parses valid lines, with and without expected_score, skipping blanks", () => {
    const text = [
      JSON.stringify({ id: "q1", input: "a", agent_output: "b", expected_passed: true }),
      "",
      "   ",
      JSON.stringify({
        id: "q2",
        input: "c",
        agent_output: "d",
        expected_passed: false,
        expected_score: 0.25,
      }),
    ].join("\n");
    const got = parseGoldenVerdicts(text);
    expect(got).toHaveLength(2);
    expect(got[0]?.id).toBe("q1");
    expect(got[0]?.expected_score).toBeUndefined();
    expect(got[1]?.expected_passed).toBe(false);
    expect(got[1]?.expected_score).toBe(0.25);
  });

  it("names the line on malformed JSON", () => {
    const text = `${JSON.stringify(golden("q1"))}\nnot json\n`;
    expect(() => parseGoldenVerdicts(text)).toThrow(/golden line 2: malformed JSON/);
  });

  it("names the line and field on a schema violation", () => {
    const text = `${JSON.stringify(golden("q1"))}\n${JSON.stringify({ id: "q2", input: "x", agent_output: "y" })}\n`;
    expect(() => parseGoldenVerdicts(text)).toThrow(/golden line 2: .*expected_passed/);
  });

  it("is strict — a stray key is a loud line-numbered error", () => {
    const line = JSON.stringify({ ...golden("q1"), expected_output: "gold" });
    expect(() => parseGoldenVerdicts(`${line}\n`)).toThrow(/golden line 1/);
  });

  it("rejects an out-of-range expected_score with the line number", () => {
    const line = JSON.stringify({ ...golden("q1"), expected_score: 1.5 });
    expect(() => parseGoldenVerdicts(`${line}\n`)).toThrow(/golden line 1: .*expected_score/);
  });

  it("refuses duplicate ids, naming both lines", () => {
    const text = `${JSON.stringify(golden("q1"))}\n${JSON.stringify(golden("q1"))}\n`;
    expect(() => parseGoldenVerdicts(text)).toThrow(
      /golden line 2: duplicate id "q1" \(first seen on line 1\)/,
    );
  });

  it("refuses an empty set", () => {
    expect(() => parseGoldenVerdicts("\n\n")).toThrow(GradersTestError);
    expect(() => parseGoldenVerdicts("")).toThrow(/no verdicts/);
  });
});

describe("goldenRunPair (E48)", () => {
  it("reconstructs a minimal Sample + RunResult from the recorded output", () => {
    const { sample, run } = goldenRunPair(golden("q1", { agent_output: "the answer" }));
    expect(sample).toEqual({ id: "q1", input: "input for q1" });
    expect(run.agentOutput).toBe("the answer");
    expect(run.toolCalls).toEqual([]);
    expect(run.transcript).toEqual([]);
    expect(run.turns).toBe(1);
  });
});

// -------- kappa --------

describe("cohenKappa (E48)", () => {
  it("hand-checked: 4 both-pass, 4 both-fail, 1 FP, 1 FN ⇒ po=.8, pe=.5, κ=.6", () => {
    const pairs = [
      ...Array.from({ length: 4 }, () => ({ expected: true, actual: true })),
      ...Array.from({ length: 4 }, () => ({ expected: false, actual: false })),
      { expected: false, actual: true }, // FP
      { expected: true, actual: false }, // FN
    ];
    expect(cohenKappa(pairs)).toBeCloseTo(0.6, 10);
  });

  it("is 1 for perfect agreement over a mixed set", () => {
    const pairs = [
      { expected: true, actual: true },
      { expected: false, actual: false },
      { expected: true, actual: true },
    ];
    expect(cohenKappa(pairs)).toBe(1);
  });

  it("is 0 when both raters are constant (agreement fully chance-explainable)", () => {
    const pairs = [
      { expected: true, actual: true },
      { expected: true, actual: true },
    ];
    expect(cohenKappa(pairs)).toBe(0);
  });

  it("is 0 for the empty set", () => {
    expect(cohenKappa([])).toBe(0);
  });

  it("is negative when the grader systematically inverts the human", () => {
    const pairs = [
      { expected: true, actual: false },
      { expected: false, actual: true },
      { expected: true, actual: false },
      { expected: false, actual: true },
    ];
    expect(cohenKappa(pairs)).toBeLessThan(0);
  });
});

// -------- summarize --------

describe("summarizeGraderTest (E48)", () => {
  it("computes agreement, FP/FN exemplars, and kappa", () => {
    const outcomes: GoldenOutcome[] = [
      gradeOutcome("a1", true, { passed: true }),
      gradeOutcome("a2", false, { passed: false }),
      gradeOutcome("fp1", false, { passed: true }),
      gradeOutcome("fn1", true, { passed: false }),
    ];
    const r = summarizeGraderTest("g", "deterministic", outcomes);
    expect(r.total).toBe(4);
    expect(r.graded).toBe(4);
    expect(r.agreements).toBe(2);
    expect(r.agreementRate).toBe(0.5);
    expect(r.falsePositives).toEqual({ count: 1, exemplars: ["fp1"] });
    expect(r.falseNegatives).toEqual({ count: 1, exemplars: ["fn1"] });
    expect(r.kappa).toBeCloseTo(0, 10);
    expect(r.scoreMae).toBeUndefined();
  });

  it(`caps exemplars at ${MAX_EXEMPLARS} while counting all`, () => {
    const outcomes = Array.from({ length: 7 }, (_, i) =>
      gradeOutcome(`fp${i}`, false, { passed: true }),
    );
    const r = summarizeGraderTest("g", "deterministic", outcomes);
    expect(r.falsePositives.count).toBe(7);
    expect(r.falsePositives.exemplars).toHaveLength(MAX_EXEMPLARS);
    expect(r.falsePositives.exemplars[0]).toBe("fp0");
  });

  it("excludes abstained and errored lines from the agreement denominator", () => {
    const outcomes: GoldenOutcome[] = [
      gradeOutcome("a1", true, { passed: true }),
      {
        golden: golden("ab1"),
        grade: { passed: false, score: 0, rationale: "judge abstained", abstained: true },
      },
      { golden: golden("er1"), error: "grader threw: boom" },
    ];
    const r = summarizeGraderTest("j", "llm_judge", outcomes);
    expect(r.total).toBe(3);
    expect(r.graded).toBe(1);
    expect(r.agreementRate).toBe(1);
    expect(r.abstained).toEqual({ count: 1, exemplars: ["ab1"] });
    expect(r.errors).toEqual({ count: 1, exemplars: ["er1"] });
    // The abstained line is NOT a false negative even though passed=false.
    expect(r.falseNegatives.count).toBe(0);
  });

  it("reads agreement 0 when nothing graded (all errors)", () => {
    const outcomes: GoldenOutcome[] = [
      { golden: golden("e1"), error: "x" },
      { golden: golden("e2"), error: "y" },
    ];
    const r = summarizeGraderTest("g", "registry", outcomes);
    expect(r.graded).toBe(0);
    expect(r.agreementRate).toBe(0);
    expect(r.kappa).toBe(0);
  });

  it("hand-checks mean absolute score error over lines carrying expected_score", () => {
    const outcomes: GoldenOutcome[] = [
      {
        golden: golden("s1", { expected_score: 1 }),
        grade: { passed: true, score: 0.75, rationale: "r" }, // |0.75-1| = 0.25
      },
      {
        golden: golden("s2", { expected_passed: false, expected_score: 0 }),
        grade: { passed: false, score: 0.25, rationale: "r" }, // |0.25-0| = 0.25
      },
      gradeOutcome("s3", true, { passed: true }), // no expected_score — excluded
    ];
    const r = summarizeGraderTest("g", "deterministic", outcomes);
    expect(r.scoreMae).toEqual({ mae: 0.25, count: 2 });
  });
});

// -------- replay --------

describe("replayGraderOnGoldens (E48)", () => {
  const goldens = [
    golden("ok1", { agent_output: "all ok here" }),
    golden("bad1", { agent_output: "nothing here", expected_passed: false }),
  ];

  it("replays a deterministic grader over the recorded outputs in order", async () => {
    const grader: Grader = async (_s, run) => ({
      passed: run.agentOutput.includes("ok"),
      score: run.agentOutput.includes("ok") ? 1 : 0,
      rationale: "contains ok",
    });
    const outcomes = await replayGraderOnGoldens(grader, goldens);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.grade?.passed).toBe(true);
    expect(outcomes[1]?.grade?.passed).toBe(false);
    expect(outcomes.map((o) => o.golden.id)).toEqual(["ok1", "bad1"]);
  });

  it("captures a per-line throw as an error outcome instead of aborting", async () => {
    let calls = 0;
    const grader: Grader = async () => {
      calls += 1;
      if (calls === 1) throw new Error("embedder unavailable");
      return { passed: true, score: 1, rationale: "ok" };
    };
    const outcomes = await replayGraderOnGoldens(grader, goldens);
    expect(outcomes[0]?.error).toContain("embedder unavailable");
    expect(outcomes[0]?.grade).toBeUndefined();
    expect(outcomes[1]?.grade?.passed).toBe(true);
  });
});

// -------- resolution --------

const SCALAR_JUDGE_YAML = `graders:
  - name: exact
    type: exact_match
  - name: judge_quality
    type: llm_judge
    rubric:
      criteria:
        - name: quality
          description: overall quality
          anchors:
            "1": bad
            "2": poor
            "3": fine
            "4": good
            "5": great
      passing_score: 3
`;

/** Stub judge adapter: submit_score 5 when the judged output carries the
 *  STELLAR marker, else 1 (a token no rubric/prompt text contains — the
 *  anchors themselves say "good"; mirrors the eval-pairwise stub pattern). */
function makeStubJudgeAdapter(): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req) {
      const userMsg = req.messages.find((m) => m.role === "user");
      const userText =
        typeof userMsg?.content === "string"
          ? userMsg.content
          : (userMsg?.content
              ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n") ?? "");
      const score = userText.includes("STELLAR") ? 5 : 1;
      const verdict = {
        score,
        rationale: score === 5 ? "stellar output" : "bad output",
        criterion_scores: { quality: score },
      };
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start" };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu_score", name: "submit_score", input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(verdict) },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "tool_use" };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/** Shared core of the categorical/panel stubs below: hand `verdictFor` the
 *  exact user text (plus the wire model id, so a panel stub can key each
 *  panelist) and stream the verdict back as one forced `toolName` call. */
function makeStubToolUseAdapter(
  toolName: string,
  verdictFor: (userText: string, model: string) => unknown,
): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req) {
      const userMsg = req.messages.find((m) => m.role === "user");
      const userText =
        typeof userMsg?.content === "string"
          ? userMsg.content
          : (userMsg?.content
              ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n") ?? "");
      const verdict = verdictFor(userText, req.model);
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start" };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: `tu_${toolName}`, name: toolName, input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(verdict) },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "tool_use" };
        yield { kind: "message_stop" };
      })();
    },
  };
}

const CATEGORICAL_JUDGE_YAML = `graders:
  - name: judge_label
    type: llm_judge
    rubric:
      kind: categorical
      labels:
        - name: correct
          score: 1
          description: factually correct
        - name: wrong
          score: 0
          description: contains an error
      passing_labels: [correct]
`;

/** Categorical stub: submit_label "correct" on the STELLAR marker, abstain
 *  (closest pick "wrong") on MURKY, plain "wrong" otherwise. */
function makeStubLabelAdapter(): ProviderAdapter {
  return makeStubToolUseAdapter("submit_label", (userText) => {
    if (userText.includes("MURKY")) {
      return { label: "wrong", rationale: "insufficient evidence", abstain: true };
    }
    if (userText.includes("STELLAR")) return { label: "correct", rationale: "stellar output" };
    return { label: "wrong", rationale: "bad output" };
  });
}

/** Panel stub: on STELLAR outputs panelists m1/m2 pass (5/4) and m3 dissents
 *  (1); on anything else every panelist scores 1. */
function makeStubPanelAdapter(): ProviderAdapter {
  return makeStubToolUseAdapter("submit_score", (userText, model) => {
    const stellar: Record<string, number> = { m1: 5, m2: 4, m3: 1 };
    const score = userText.includes("STELLAR") ? (stellar[model] ?? 1) : 1;
    return {
      score,
      rationale: `${model} scored ${score}`,
      criterion_scores: { quality: score },
    };
  });
}

describe("resolveTestGraders (E48)", () => {
  it("resolves deterministic graders untouched, tagged by kind", () => {
    const { compiled } = parseGradersConfig("graders:\n  - name: exact\n    type: exact_match\n");
    const { graders, skipped } = resolveTestGraders(compiled, { env: {} });
    expect(graders).toHaveLength(1);
    expect(graders[0]?.name).toBe("exact");
    expect(graders[0]?.kind).toBe("deterministic");
    expect(skipped).toHaveLength(0);
  });

  it("skips llm_judge graders without visible credentials, naming the model", () => {
    const { compiled } = parseGradersConfig(SCALAR_JUDGE_YAML);
    const { graders, skipped } = resolveTestGraders(compiled, { env: {} });
    expect(graders.map((g) => g.name)).toEqual(["exact"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.name).toBe("judge_quality");
    expect(skipped[0]?.reason).toContain(DEFAULT_JUDGE_MODEL);
    expect(skipped[0]?.reason).toContain("--judge-model");
    expect(skipped[0]?.reason).toContain("deterministic graders still test");
  });

  it("resolves llm_judge graders when the provider env is satisfied", () => {
    const { compiled } = parseGradersConfig(SCALAR_JUDGE_YAML);
    const { graders, skipped } = resolveTestGraders(compiled, {
      env: { ANTHROPIC_API_KEY: "test-key" },
    });
    expect(graders.map((g) => g.kind)).toEqual(["deterministic", "llm_judge"]);
    expect(skipped).toHaveLength(0);
  });

  it("an injected adapter bypasses the credential gate (test seam)", () => {
    const { compiled } = parseGradersConfig(SCALAR_JUDGE_YAML);
    const { graders, skipped } = resolveTestGraders(compiled, {
      env: {},
      adapter: makeStubJudgeAdapter(),
    });
    expect(graders).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });

  it("always skips target: transcript judges — golden verdicts carry only the final output", () => {
    const yaml = SCALAR_JUDGE_YAML.replace(
      "    type: llm_judge\n",
      "    type: llm_judge\n    target: transcript\n",
    );
    const { compiled } = parseGradersConfig(yaml);
    const { graders, skipped } = resolveTestGraders(compiled, {
      env: { ANTHROPIC_API_KEY: "test-key" },
      adapter: makeStubJudgeAdapter(),
    });
    expect(graders.map((g) => g.name)).toEqual(["exact"]);
    expect(skipped[0]?.reason).toContain("transcript");
  });

  it("a panel skips when ANY panelist's credentials are missing, listing them", () => {
    const yaml = SCALAR_JUDGE_YAML.replace(
      "    type: llm_judge\n",
      "    type: llm_judge\n    judges: [claude-sonnet-4-5, openai/gpt-4o]\n",
    );
    const { compiled } = parseGradersConfig(yaml);
    const { graders, skipped } = resolveTestGraders(compiled, {
      env: { ANTHROPIC_API_KEY: "test-key" }, // no OpenAI key
    });
    expect(graders.map((g) => g.name)).toEqual(["exact"]);
    expect(skipped[0]?.reason).toContain("openai/gpt-4o");
    expect(skipped[0]?.reason).not.toContain('"claude-sonnet-4-5"');
  });

  it("resolves registry graders through the injected registry", async () => {
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: close\n    type: registry\n    grader: fake.alwaysPass\n",
    );
    const fakeGrader: Grader = async () => ({ passed: true, score: 1, rationale: "ok" });
    const registry: GraderLookup = { lookup: () => fakeGrader };
    const { graders } = resolveTestGraders(compiled, { env: {}, graderRegistry: registry });
    expect(graders[0]?.kind).toBe("registry");
    const outcomes = await replayGraderOnGoldens((graders[0] as { grader: Grader }).grader, [
      golden("r1"),
    ]);
    expect(outcomes[0]?.grade?.passed).toBe(true);
  });

  it("throws loudly when a registry grader has no registry to resolve against", () => {
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: close\n    type: registry\n    grader: fake.alwaysPass\n",
    );
    expect(() => resolveTestGraders(compiled, { env: {} })).toThrow(GradersTestError);
  });

  it("end-to-end with the stub adapter: judge agreement over a labeled set", async () => {
    const { compiled } = parseGradersConfig(SCALAR_JUDGE_YAML);
    const { graders } = resolveTestGraders(compiled, { env: {}, adapter: makeStubJudgeAdapter() });
    const judgeGrader = graders.find((g) => g.kind === "llm_judge");
    expect(judgeGrader).toBeDefined();
    const goldens = [
      golden("g1", { agent_output: "a STELLAR answer", expected_passed: true }),
      golden("g2", { agent_output: "a bad answer", expected_passed: false }),
      golden("g3", { agent_output: "another bad one", expected_passed: true }), // judge will FN
    ];
    const outcomes = await replayGraderOnGoldens(
      (judgeGrader as { grader: Grader }).grader,
      goldens,
    );
    const r = summarizeGraderTest("judge_quality", "llm_judge", outcomes);
    expect(r.graded).toBe(3);
    expect(r.agreements).toBe(2);
    expect(r.falseNegatives).toEqual({ count: 1, exemplars: ["g3"] });
    expect(r.falsePositives.count).toBe(0);
  });

  it("end-to-end with a stub label adapter: categorical rubric replay (label pass/fail, abstain excluded)", async () => {
    const { compiled } = parseGradersConfig(CATEGORICAL_JUDGE_YAML);
    const { graders, skipped } = resolveTestGraders(compiled, {
      env: {},
      adapter: makeStubLabelAdapter(),
    });
    expect(skipped).toHaveLength(0);
    const judgeGrader = graders.find((g) => g.kind === "llm_judge");
    expect(judgeGrader).toBeDefined();
    const goldens = [
      golden("c1", { agent_output: "a STELLAR answer", expected_passed: true }),
      golden("c2", { agent_output: "a bad answer", expected_passed: false }),
      golden("c3", { agent_output: "MURKY evidence", expected_passed: true }), // judge abstains
      golden("c4", { agent_output: "confidently bad", expected_passed: true }), // judge will FN
    ];
    const outcomes = await replayGraderOnGoldens(
      (judgeGrader as { grader: Grader }).grader,
      goldens,
    );
    // Label → declared 0..1 score, not a 1–5 projection.
    expect(outcomes[0]?.grade?.passed).toBe(true);
    expect(outcomes[0]?.grade?.score).toBe(1);
    expect(outcomes[0]?.grade?.rationale).toContain('label="correct"');
    expect(outcomes[1]?.grade?.passed).toBe(false);
    expect(outcomes[1]?.grade?.score).toBe(0);
    expect(outcomes[2]?.grade?.abstained).toBe(true);
    const r = summarizeGraderTest("judge_label", "llm_judge", outcomes);
    expect(r.total).toBe(4);
    expect(r.graded).toBe(3); // the abstention is excluded from the denominator
    expect(r.agreements).toBe(2);
    expect(r.abstained).toEqual({ count: 1, exemplars: ["c3"] });
    expect(r.falseNegatives).toEqual({ count: 1, exemplars: ["c4"] });
    expect(r.falsePositives.count).toBe(0);
  });

  it("end-to-end with the stub adapter: a judges panel resolves credential-free and replays", async () => {
    const yaml = SCALAR_JUDGE_YAML.replace(
      "    type: llm_judge\n",
      "    type: llm_judge\n    judges: [m1, m2, m3]\n",
    );
    const { compiled } = parseGradersConfig(yaml);
    // env: {} — no panelist has credentials; the injected adapter bypasses the gate.
    const { graders, skipped } = resolveTestGraders(compiled, {
      env: {},
      adapter: makeStubPanelAdapter(),
    });
    expect(skipped).toHaveLength(0);
    const judgeGrader = graders.find((g) => g.kind === "llm_judge");
    expect(judgeGrader).toBeDefined();
    const goldens = [
      golden("p1", { agent_output: "a STELLAR answer", expected_passed: true }),
      golden("p2", { agent_output: "a bad answer", expected_passed: false }),
    ];
    const outcomes = await replayGraderOnGoldens(
      (judgeGrader as { grader: Grader }).grader,
      goldens,
    );
    // p1: m1=5/m2=4/m3=1 → majority pass (2/3), median 4 → (4−1)/4 = 0.75.
    expect(outcomes[0]?.grade?.passed).toBe(true);
    expect(outcomes[0]?.grade?.score).toBeCloseTo(0.75);
    expect(outcomes[0]?.grade?.panel?.panelists.map((p) => p.model)).toEqual(["m1", "m2", "m3"]);
    // p2: every panelist scores 1 → unanimous fail.
    expect(outcomes[1]?.grade?.passed).toBe(false);
    expect(outcomes[1]?.grade?.score).toBe(0);
    const r = summarizeGraderTest("judge_quality", "llm_judge", outcomes);
    expect(r.graded).toBe(2);
    expect(r.agreements).toBe(2);
  });
});

// -------- gate + render --------

describe("belowFloor (E48 --min-agreement)", () => {
  it("returns only the tested graders under the floor", () => {
    const high = summarizeGraderTest("high", "deterministic", [
      gradeOutcome("a", true, { passed: true }),
    ]);
    const low = summarizeGraderTest("low", "deterministic", [
      gradeOutcome("a", true, { passed: false }),
    ]);
    expect(belowFloor([high, low], 0.9).map((r) => r.name)).toEqual(["low"]);
    expect(belowFloor([high, low], 0)).toHaveLength(0);
  });
});

describe("renderGradersTestReport (E48)", () => {
  it("renders per-grader rows with exemplars, MAE, and skip notices", () => {
    const report = summarizeGraderTest("exact", "deterministic", [
      gradeOutcome("a1", true, { passed: true }),
      gradeOutcome("fp1", false, { passed: true }),
      {
        golden: golden("s1", { expected_score: 0.5 }),
        grade: { passed: true, score: 1, rationale: "r" },
      },
    ]);
    const out = renderGradersTestReport(
      [report],
      [{ name: "judge_x", reason: 'no credentials visible for judge model "m"' }],
      3,
    );
    expect(out).toContain("3 golden verdict(s), 1 grader(s) tested, 1 skipped");
    expect(out).toContain("exact (deterministic)");
    expect(out).toContain("kappa");
    expect(out).toContain("false positives (grader passed, human failed): 1 — fp1");
    expect(out).toContain("score MAE: 0.500 (over 1 with expected_score)");
    expect(out).toContain('skipped llm_judge "judge_x"');
  });

  it("counts hidden exemplars beyond the cap", () => {
    const outcomes = Array.from({ length: 8 }, (_, i) =>
      gradeOutcome(`fn${i}`, true, { passed: false }),
    );
    const out = renderGradersTestReport(
      [summarizeGraderTest("g", "deterministic", outcomes)],
      [],
      8,
    );
    expect(out).toContain("+3 more");
  });
});

// -------- CLI integration (offline — no judge credentials) --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-graders-test-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  cliArgs: ReadonlyArray<string>,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...cliArgs], {
    cwd,
    // No provider creds → llm_judge entries must SKIP, never fabricate.
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const CONTAINS_GRADERS_YAML = `graders:
  - name: mentions_ok
    type: contains
    substring: ok
`;

/** ok-containing outputs labeled pass/fail so `mentions_ok` agrees on 2 of
 *  3 lines (one human-failed output still says ok — a false positive). */
const GOLDEN_JSONL = [
  JSON.stringify({ id: "g1", input: "i1", agent_output: "ok fine", expected_passed: true }),
  JSON.stringify({ id: "g2", input: "i2", agent_output: "nope", expected_passed: false }),
  JSON.stringify({ id: "g3", input: "i3", agent_output: "ok but wrong", expected_passed: false }),
].join("\n");

describe("crewhaus graders test (CLI, offline)", () => {
  it("shows help", async () => {
    const got = await runCli(["graders", "test", "--help"], newTempRoot());
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("usage: crewhaus graders test");
    expect(got.stdout).toContain("--min-agreement");
    expect(got.stdout).toContain("expected_passed");
  });

  it("rejects an unknown graders action naming every verb", async () => {
    const got = await runCli(["graders", "bogus"], newTempRoot());
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("graders action must be one of: suggest, test, card");
  });

  it("dies on missing --graders / --golden", async () => {
    const root = newTempRoot();
    const noGraders = await runCli(["graders", "test"], root);
    expect(noGraders.exitCode).toBe(1);
    expect(noGraders.stderr).toContain("--graders");
    writeFileSync(join(root, "g.yaml"), CONTAINS_GRADERS_YAML);
    const noGolden = await runCli(["graders", "test", "--graders", "g.yaml"], root);
    expect(noGolden.exitCode).toBe(1);
    expect(noGolden.stderr).toContain("--golden");
  });

  it("dies with the line number on a malformed golden line", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "g.yaml"), CONTAINS_GRADERS_YAML);
    writeFileSync(join(root, "golden.jsonl"), `${GOLDEN_JSONL}\nnot json\n`);
    const got = await runCli(
      ["graders", "test", "--graders", "g.yaml", "--golden", "golden.jsonl"],
      root,
    );
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("golden line 4");
  });

  it("replays a deterministic grader credential-free and reports FP exemplars", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "g.yaml"), CONTAINS_GRADERS_YAML);
    writeFileSync(join(root, "golden.jsonl"), `${GOLDEN_JSONL}\n`);
    const got = await runCli(
      ["graders", "test", "--graders", "g.yaml", "--golden", "golden.jsonl"],
      root,
    );
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("3 golden verdict(s), 1 grader(s) tested");
    expect(got.stdout).toContain("mentions_ok (deterministic): agreement 67% (2/3)");
    expect(got.stdout).toContain("false positives (grader passed, human failed): 1 — g3");
  });

  it("skips llm_judge graders with a notice when no credentials are visible", async () => {
    const root = newTempRoot();
    writeFileSync(
      join(root, "g.yaml"),
      `${CONTAINS_GRADERS_YAML}  - name: judge_q
    type: llm_judge
    rubric:
      criteria:
        - name: quality
          description: q
          anchors: {"1": a, "2": b, "3": c, "4": d, "5": e}
      passing_score: 3
`,
    );
    writeFileSync(join(root, "golden.jsonl"), `${GOLDEN_JSONL}\n`);
    const got = await runCli(
      ["graders", "test", "--graders", "g.yaml", "--golden", "golden.jsonl"],
      root,
    );
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toContain("1 grader(s) tested, 1 skipped");
    expect(got.stdout).toContain('skipped llm_judge "judge_q"');
    expect(got.stdout).toContain("mentions_ok (deterministic)");
  });

  it("--min-agreement gates: non-zero under the floor, zero at/above it", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "g.yaml"), CONTAINS_GRADERS_YAML);
    writeFileSync(join(root, "golden.jsonl"), `${GOLDEN_JSONL}\n`);
    const fail = await runCli(
      [
        "graders",
        "test",
        "--graders",
        "g.yaml",
        "--golden",
        "golden.jsonl",
        "--min-agreement",
        "0.9",
      ],
      root,
    );
    expect(fail.exitCode).toBe(1);
    expect(fail.stderr).toContain('FAIL: grader "mentions_ok"');
    const pass = await runCli(
      [
        "graders",
        "test",
        "--graders",
        "g.yaml",
        "--golden",
        "golden.jsonl",
        "--min-agreement",
        "0.5",
      ],
      root,
    );
    expect(pass.exitCode).toBe(0);
    expect(pass.stdout).toContain("gate passed");
  });

  it("rejects an out-of-range --min-agreement", async () => {
    const root = newTempRoot();
    writeFileSync(join(root, "g.yaml"), CONTAINS_GRADERS_YAML);
    writeFileSync(join(root, "golden.jsonl"), `${GOLDEN_JSONL}\n`);
    const got = await runCli(
      [
        "graders",
        "test",
        "--graders",
        "g.yaml",
        "--golden",
        "golden.jsonl",
        "--min-agreement",
        "1.5",
      ],
      root,
    );
    expect(got.exitCode).toBe(1);
    expect(got.stderr).toContain("--min-agreement");
  });

  it("mentions graders test in the top-level usage", async () => {
    const root = newTempRoot();
    mkdirSync(root, { recursive: true });
    const got = await runCli(["--help"], root);
    expect(got.stdout).toContain("graders test --graders <g.yaml>");
    expect(got.stdout).toContain("--min-agreement");
  });
});
