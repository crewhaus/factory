/**
 * Protected bars only tighten: `protectedBarChange` over two documents, the
 * refused `protected` keys at a leaf and inside a whole `steps` value, the
 * escalation a loosening raises, and the judge leaves a whole value may not
 * change.
 */
import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import { parse } from "yaml";
import {
  SpecPatchError,
  applySpecEdits,
  escalationFor,
  protectedBarChange,
  validatePatch,
} from "./index";

const WORKFLOW = (judge: string) => `name: w
target: workflow
model: base-model
steps:
  - name: draft
    instructions: Draft it.
  - name: gate
    kind: judge
    judge:
${judge
  .trim()
  .split("\n")
  .map((l) => `      ${l}`)
  .join("\n")}
`;

const GATE = "criteria: is it right\nthreshold: 0.7";
const PROTECTED_GATE = `${GATE}\nprotected: true`;

/** The steps value of a workflow with its gate's judge replaced by `judge`. */
function stepsWith(judge: Record<string, unknown>): unknown[] {
  const doc = parse(WORKFLOW(GATE)) as { steps: Array<Record<string, unknown>> };
  return doc.steps.map((s) => (s["name"] === "gate" ? { ...s, judge } : s));
}

const refusedBoth = (yaml: string, value: unknown, pattern: RegExp): void => {
  const spec = parseSpec(yaml);
  expect(() =>
    validatePatch(spec, { target: "workflow", path: ["steps"], op: "replace", value }),
  ).toThrow(pattern);
  expect(() =>
    applySpecEdits(yaml, [{ path: ["steps"], value }], { restrictToOptimizable: true }),
  ).toThrow(pattern);
};

const admittedBoth = (yaml: string, value: unknown): void => {
  const spec = parseSpec(yaml);
  expect(() =>
    validatePatch(spec, { target: "workflow", path: ["steps"], op: "replace", value }),
  ).not.toThrow();
  expect(() =>
    applySpecEdits(yaml, [{ path: ["steps"], value }], { restrictToOptimizable: true }),
  ).not.toThrow();
};

describe("a whole steps value never changes a judge gate's criteria or identity", () => {
  test("each judge leaf but the three dials is refused at both entry points", () => {
    const base = { criteria: "is it right", threshold: 0.7 };
    for (const [leaf, value] of [
      ["criteria", "anything goes"],
      ["model", "other-model"],
      ["judges", ["a", "b", "c"]],
      ["temperature", 0.5],
      ["target", "transcript"],
      ["on_fail", "continue"],
      ["escalate_to", "strong"],
    ] as const) {
      // `escalate_to` names a pool candidate this spec does not have, so the
      // restricted apply refuses it at validation before it judges the leaf.
      refusedBoth(
        WORKFLOW(GATE),
        stepsWith({ ...base, [leaf]: value }),
        leaf === "escalate_to" ? /may not change|declares no model_pool/ : /may not change/,
      );
      expect(() =>
        validatePatch(parseSpec(WORKFLOW(GATE)), {
          target: "workflow",
          path: ["steps"],
          op: "replace",
          value: stepsWith({ ...base, [leaf]: value }),
        }),
      ).toThrow(new RegExp(`steps\\.1\\.judge\\.${leaf}.*may not change`));
    }
    // The dials stay tunable inside a whole value.
    admittedBoth(WORKFLOW(GATE), stepsWith({ ...base, threshold: 0.6, max_retries: 2 }));
  });
});

describe("the protected keys are the owner's", () => {
  test("adding judge.protected inside a whole steps value is refused", () => {
    refusedBoth(
      WORKFLOW(GATE),
      stepsWith({ criteria: "is it right", threshold: 0.7, protected: true }),
      /steps\.1\.judge\.protected.*owner's decision/,
    );
  });

  test("each protected key at its own leaf is refused", () => {
    const cli = parseSpec(`name: c
target: cli
agent: { model: m, instructions: hi }
evaluation:
  grader: { type: llm_judge, criteria: be good }
provability:
  level: cited
`);
    for (const path of [
      ["evaluation", "protected"],
      ["provability", "protected"],
    ]) {
      expect(() => validatePatch(cli, { target: "cli", path, op: "replace", value: true })).toThrow(
        SpecPatchError,
      );
    }
    expect(() =>
      validatePatch(parseSpec(WORKFLOW(GATE)), {
        target: "workflow",
        path: ["steps", "1", "judge", "protected"],
        op: "replace",
        value: true,
      }),
    ).toThrow(SpecPatchError);
  });

  test("with judge.protected set, a lowered threshold is refused; a raise or another field passes", () => {
    const yaml = WORKFLOW(PROTECTED_GATE);
    refusedBoth(
      yaml,
      stepsWith({ criteria: "is it right", threshold: 0.5, protected: true }),
      /would loosen "steps\.gate\.judge\.threshold"/,
    );
    admittedBoth(yaml, stepsWith({ criteria: "is it right", threshold: 0.9, protected: true }));
    const doc = parse(yaml) as { steps: Array<Record<string, unknown>> };
    const instructions = doc.steps.map((s) =>
      s["name"] === "draft" ? { ...s, instructions: "Draft it well." } : s,
    );
    admittedBoth(yaml, instructions);
    // The dial on its own leaf is judged the same way.
    expect(() =>
      validatePatch(parseSpec(yaml), {
        target: "workflow",
        path: ["steps", "1", "judge", "threshold"],
        op: "replace",
        value: 0.6,
      }),
    ).toThrow(/would loosen/);
  });
});

describe("protectedBarChange", () => {
  const evalDoc = (extra: Record<string, unknown>) => ({
    evaluation: { grader: { type: "llm_judge", criteria: "x" }, ...extra },
  });

  test("evaluation.threshold only rises; absent reads 0.7", () => {
    const before = evalDoc({ protected: true });
    expect(protectedBarChange(before, evalDoc({ protected: true, threshold: 0.6 }))?.key).toBe(
      "evaluation.threshold",
    );
    expect(
      protectedBarChange(before, evalDoc({ protected: true, threshold: 0.8 })),
    ).toBeUndefined();
    expect(
      protectedBarChange(before, evalDoc({ protected: true, threshold: 0.7 })),
    ).toBeUndefined();
    expect(
      protectedBarChange(evalDoc({ protected: true, threshold: 0.9 }), evalDoc({ protected: true }))
        ?.reason,
    ).toContain("(0.9 → 0.7)");
  });

  test("removing the block or its protection is a change", () => {
    const before = evalDoc({ protected: true });
    expect(protectedBarChange(before, {})?.key).toBe("evaluation");
    expect(protectedBarChange(before, evalDoc({}))?.key).toBe("evaluation.protected");
  });

  test("provability: threshold and coverage only rise, window_tokens only falls; absent reads its default", () => {
    const p = (extra: Record<string, unknown>) => ({
      provability: { level: "grounded", protected: true, ...extra },
    });
    expect(protectedBarChange(p({}), p({ threshold: 0.9 }))?.key).toBe("provability.threshold");
    expect(protectedBarChange(p({}), p({ grounded: { coverage: 0.7 } }))?.key).toBe(
      "provability.grounded.coverage",
    );
    expect(protectedBarChange(p({}), p({ grounded: { coverage: 0.9 } }))).toBeUndefined();
    expect(protectedBarChange(p({}), p({ grounded: { window_tokens: 80 } }))?.key).toBe(
      "provability.grounded.window_tokens",
    );
    expect(protectedBarChange(p({}), p({ grounded: { window_tokens: 40 } }))).toBeUndefined();
    // A rung shorthand carries no protection.
    expect(protectedBarChange(p({}), { provability: "grounded" })?.key).toBe(
      "provability.protected",
    );
  });

  test("graph nodes are matched by key", () => {
    const g = (threshold?: number) => ({
      nodes: {
        check: {
          judge: {
            criteria: "x",
            protected: true,
            ...(threshold !== undefined ? { threshold } : {}),
          },
        },
      },
    });
    expect(protectedBarChange(g(), g(0.5))?.key).toBe("nodes.check.judge.threshold");
    expect(protectedBarChange(g(), g(0.75))).toBeUndefined();
    expect(protectedBarChange(g(), { nodes: {} })?.key).toBe("nodes.check.judge");
  });

  test("an unprotected bar stays tunable both ways", () => {
    expect(
      protectedBarChange(evalDoc({ threshold: 0.8 }), evalDoc({ threshold: 0.2 })),
    ).toBeUndefined();
    expect(
      protectedBarChange(evalDoc({ threshold: 0.2 }), evalDoc({ threshold: 0.8 })),
    ).toBeUndefined();
    const open = { provability: { level: "grounded", grounded: { window_tokens: 10 } } };
    expect(
      protectedBarChange(open, {
        provability: { level: "grounded", grounded: { window_tokens: 90 } },
      }),
    ).toBeUndefined();
  });
});

describe("escalationFor names a loosening", () => {
  test("a lowered protected threshold needs the security edit permission; a raise needs nothing", () => {
    const before = parse(WORKFLOW(PROTECTED_GATE));
    const lowered = parse(WORKFLOW(PROTECTED_GATE.replace("threshold: 0.7", "threshold: 0.4")));
    const raised = parse(WORKFLOW(PROTECTED_GATE.replace("threshold: 0.7", "threshold: 0.9")));
    expect(escalationFor(before, lowered)).toEqual([
      {
        needs: "h.spec.edit.security",
        reason: expect.stringContaining("only the owner can make it"),
        paths: ["steps.gate.judge.threshold"],
      },
    ]);
    expect(escalationFor(before, raised)).toEqual([]);
  });
});
