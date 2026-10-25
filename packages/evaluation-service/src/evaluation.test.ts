/**
 * The `evaluation:` gate — parity with the four copies it replaced (the three
 * `renderEvaluation` emitters and `apps/cli`'s `buildRunEvaluation`): the same
 * verdicts for the same inputs, every knob the emitters rendered honoured.
 */
import { describe, expect, test } from "bun:test";
import type { IrEvaluation } from "@crewhaus/ir";
import type { EvaluationTurn } from "@crewhaus/runtime-core";
import { recordingBus, scriptedJudge } from "./__fixtures__/helpers";
import { buildRunEvaluation } from "./evaluation";
import { wireEvaluation } from "./wire";

const turn = (finalText: string, bus = recordingBus().bus): EvaluationTurn => ({
  finalText,
  messages: [],
  usage: { input: 0, output: 0 },
  bus,
});

const SCORE_4 = () => ({ score: 4, rationale: "good enough", criterion_scores: { criteria: 4 } });

describe("contains", () => {
  const ev: IrEvaluation = {
    grader: { type: "contains", value: 'say "DONE"' },
    onFail: "halt",
    maxRetries: 2,
  };

  test("pure grader, threshold 1, resolved onFail / maxRetries threaded verbatim", async () => {
    const gate = buildRunEvaluation(ev, "m");
    expect(gate.graderType).toBe("contains");
    expect(gate.threshold).toBe(1);
    expect(gate.onFail).toBe("halt");
    expect(gate.maxRetries).toBe(2);
    expect("judgeModel" in gate).toBe(false);
    expect("escalateTo" in gate).toBe(false);
  });

  test("the verdicts and rationales are the ones the emitted closure returned", async () => {
    const gate = buildRunEvaluation(ev, "m");
    expect(await gate.evaluate(turn('ok, say "DONE" now'))).toEqual({
      score: 1,
      rationale: 'output contains "say "DONE""',
    });
    expect(await gate.evaluate(turn("nope"))).toEqual({
      score: 0,
      rationale: 'output missing "say "DONE""',
    });
  });
});

describe("regex", () => {
  test("lastIndex is reset per call, so a global flag cannot flip verdicts", async () => {
    const gate = buildRunEvaluation(
      { grader: { type: "regex", value: "\\d{3}-\\d{4}" }, onFail: "note", maxRetries: 1 },
      "m",
    );
    expect(gate.graderType).toBe("regex");
    expect(gate.threshold).toBe(1);
    expect(await gate.evaluate(turn("call 555-1234"))).toEqual({
      score: 1,
      rationale: "output matches /\\d{3}-\\d{4}/",
    });
    expect((await gate.evaluate(turn("call 555-1234"))).score).toBe(1);
    expect(await gate.evaluate(turn("no number"))).toEqual({
      score: 0,
      rationale: "output does not match /\\d{3}-\\d{4}/",
    });
  });
});

describe("llm_judge", () => {
  test("graderType, the resolved threshold and the judge instrument mirror the bundle", () => {
    const gate = buildRunEvaluation(
      {
        grader: { type: "llm_judge", criteria: "is it correct?" },
        threshold: 0.8,
        onFail: "retry",
        maxRetries: 1,
      },
      "claude-haiku-4-5",
    );
    expect(gate.graderType).toBe("llm_judge");
    expect(gate.threshold).toBe(0.8);
    // The judge defaults to the shape's primary model.
    expect(gate.judgeModel).toBe("claude-haiku-4-5");
    const defaulted = buildRunEvaluation(
      {
        grader: { type: "llm_judge", criteria: "c", model: "claude-sonnet-4-6" },
        onFail: "retry",
        maxRetries: 1,
      },
      "m",
    );
    // The lower-time default the emitters also fell back to.
    expect(defaulted.threshold).toBe(0.7);
    expect(defaulted.judgeModel).toBe("claude-sonnet-4-6");
  });

  test("a single judge: one call on the run bus (role judge), the verdict and its attribution returned", async () => {
    const { adapter, requests } = scriptedJudge(SCORE_4);
    const { bus, events } = recordingBus();
    const gate = buildRunEvaluation(
      {
        grader: { type: "llm_judge", criteria: "answers cite a source" },
        threshold: 0.7,
        onFail: "retry",
        maxRetries: 1,
      },
      "claude-haiku-4-5",
      { judgeAdapter: adapter },
    );
    const result = await gate.evaluate(turn("The refund window is 14 days.", bus));
    expect(result.score).toBe(0.75);
    expect(result.rationale).toContain("good enough");
    expect(result.judge?.model).toBe("claude-haiku-4-5");
    expect(typeof result.judge?.costUsdMicros).toBe("number");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe("claude-haiku-4-5");
    // The judge's own pin: temperature 0 unless the spec says otherwise.
    expect(requests[0]?.temperature).toBe(0);
    expect(requests[0]?.user).toContain("answers cite a source");
    expect(requests[0]?.user).toContain("The refund window is 14 days.");
    const requested = events.filter((e) => e.kind === "model_request");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ role: "judge", model: "claude-haiku-4-5" });
    expect(events.filter((e) => e.kind === "model_response")).toHaveLength(1);
  });

  test("every panel knob the emitters rendered is honoured: judges × repeats, temperature, target, params", async () => {
    const { adapter, requests } = scriptedJudge(SCORE_4);
    const { bus, events } = recordingBus();
    const gate = buildRunEvaluation(
      {
        grader: {
          type: "llm_judge",
          criteria: "is it correct?",
          judges: ["claude-sonnet-4-6", "claude-opus-4-8"],
          repeats: 3,
          temperature: 0.2,
          target: "transcript",
          params: { maxTokens: 512 },
        },
        threshold: 0.8,
        onFail: "escalate",
        maxRetries: 1,
        escalateTo: "strong",
      },
      "claude-haiku-4-5",
      { judgeAdapter: adapter },
    );
    // Two panels are two instruments: named by their members, joined with +.
    expect(gate.judgeModel).toBe("claude-sonnet-4-6+claude-opus-4-8");
    expect(gate.onFail).toBe("escalate");
    expect(gate.escalateTo).toBe("strong");
    const result = await gate.evaluate({
      ...turn("final answer", bus),
      messages: [{ role: "user", content: "what is 2+2?" }],
    });
    expect(result.judge?.model).toBe("claude-sonnet-4-6+claude-opus-4-8");
    expect(requests).toHaveLength(6);
    expect(new Set(requests.map((r) => r.model))).toEqual(
      new Set(["claude-sonnet-4-6", "claude-opus-4-8"]),
    );
    for (const request of requests) {
      expect(request.temperature).toBe(0.2);
      expect(request.maxTokens).toBe(512);
      // target: transcript — the judge reads the run, not only the answer.
      expect(request.system).toContain("RUN TRANSCRIPT");
      expect(request.user).toContain("what is 2+2?");
    }
    expect(events.filter((e) => e.kind === "model_request" && e.role === "judge")).toHaveLength(6);
  });

  test("an abstaining judge scores 0 — never a passing guess", async () => {
    const { adapter } = scriptedJudge(() => ({
      score: 5,
      rationale: "cannot tell",
      criterion_scores: { criteria: 5 },
      abstain: true,
    }));
    const gate = buildRunEvaluation(
      {
        grader: { type: "llm_judge", criteria: "c" },
        threshold: 0.7,
        onFail: "retry",
        maxRetries: 1,
      },
      "claude-haiku-4-5",
      { judgeAdapter: adapter },
    );
    const result = await gate.evaluate(turn("x"));
    expect(result.score).toBe(0);
    expect(result.rationale).toContain("abstain");
  });
});

describe("escalateTo is carried only under on_fail: escalate", () => {
  for (const type of ["llm_judge", "contains", "regex"] as const) {
    test(type, () => {
      const grader =
        type === "llm_judge"
          ? ({ type, criteria: "c" } as const)
          : ({ type, value: "ok" } as const);
      const escalated = buildRunEvaluation(
        { grader, onFail: "escalate", maxRetries: 1, escalateTo: "strong" },
        "m",
      );
      expect(escalated.escalateTo).toBe("strong");
      const plain = buildRunEvaluation({ grader, onFail: "retry", maxRetries: 1 }, "m");
      expect("escalateTo" in plain).toBe(false);
    });
  }
});

describe("through wireEvaluation", () => {
  test("an evaluation-only fragment wires the judge and no provability, no tools", async () => {
    const gates = await wireEvaluation(
      {
        specName: "bot",
        primaryModel: "m",
        evaluation: { grader: { type: "contains", value: "DONE" }, onFail: "note", maxRetries: 0 },
      },
      { cwd: "/nonexistent-is-fine-nothing-is-opened" },
    );
    expect(Object.keys(gates).sort()).toEqual(["evaluation", "proofTools", "tools"]);
    expect(gates.tools).toEqual([]);
    expect(gates.proofTools).toEqual([]);
    expect((await gates.evaluation?.evaluate(turn("DONE")))?.score).toBe(1);
  });

  test("a spec name provability would refuse is fine without provability (nothing is filed)", async () => {
    const gates = await wireEvaluation(
      {
        specName: "my bot: v2",
        primaryModel: "m",
        evaluation: { grader: { type: "regex", value: "x" }, onFail: "note", maxRetries: 0 },
      },
      { cwd: "/tmp" },
    );
    expect(gates.evaluation?.graderType).toBe("regex");
  });
});
