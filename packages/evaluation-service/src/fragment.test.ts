import { describe, expect, test } from "bun:test";
import type { IrEvaluation } from "@crewhaus/ir";
import { config } from "./__fixtures__/helpers";
import { evaluationFragmentFromIr } from "./fragment";

const EVALUATION: IrEvaluation = {
  grader: { type: "contains", value: "DONE" },
  onFail: "retry",
  maxRetries: 1,
};

const ir = (extra: Record<string, unknown> = {}) => ({
  name: "support-bot",
  agent: { model: "claude-sonnet-4-6", instructions: "be helpful" },
  ...extra,
});

describe("evaluationFragmentFromIr", () => {
  test("neither block → undefined (the emitters' render-nothing signal)", () => {
    expect(evaluationFragmentFromIr(ir())).toBeUndefined();
  });

  test("evaluation only", () => {
    expect(evaluationFragmentFromIr(ir({ evaluation: EVALUATION }))).toEqual({
      specName: "support-bot",
      primaryModel: "claude-sonnet-4-6",
      evaluation: EVALUATION,
    });
  });

  test("provability only", () => {
    const provability = config("grounded");
    const fragment = evaluationFragmentFromIr(ir({ provability }));
    expect(fragment).toEqual({
      specName: "support-bot",
      primaryModel: "claude-sonnet-4-6",
      provability,
    });
    expect(fragment !== undefined && "evaluation" in fragment).toBe(false);
  });

  test("both, in a fixed key order — so the serialized boot line is deterministic", () => {
    const provability = config("checked");
    const fragment = evaluationFragmentFromIr(ir({ provability, evaluation: EVALUATION }));
    expect(Object.keys(fragment ?? {})).toEqual([
      "specName",
      "primaryModel",
      "evaluation",
      "provability",
    ]);
    // Only the slice is read: unrelated IR keys never ride the fragment.
    expect(JSON.stringify(fragment)).not.toContain("instructions");
  });

  test("an explicitly undefined block reads as absent", () => {
    expect(evaluationFragmentFromIr(ir({ evaluation: undefined, provability: undefined }))).toBe(
      undefined,
    );
  });
});
