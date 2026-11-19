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
  protectedBarChanges,
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

describe("protected judge steps pair by name and occurrence", () => {
  const TWO_CHECKS = `name: w
target: workflow
model: base-model
steps:
  - name: draft
    instructions: Draft it.
  - name: check
    kind: judge
    judge:
      criteria: is it right
      threshold: 0.7
      protected: true
  - name: revise
    instructions: Revise it.
  - name: check
    kind: judge
    judge:
      criteria: is it right
      threshold: 0.7
      protected: true
`;

  /** The steps with the k-th `check` (1-based) at `threshold`. */
  function checks(thresholds: readonly [number, number]): Array<Record<string, unknown>> {
    const doc = parse(TWO_CHECKS) as { steps: Array<Record<string, unknown>> };
    let k = 0;
    return doc.steps.map((s) => {
      if (s["name"] !== "check") return s;
      const threshold = thresholds[k++] as number;
      return { ...s, judge: { ...(s["judge"] as Record<string, unknown>), threshold } };
    });
  }

  test("the fixture with two steps of one name parses", () => {
    expect(() => parseSpec(TWO_CHECKS)).not.toThrow();
  });

  test("lowering only the second check names it and is refused at both entry points", () => {
    const before = parse(TWO_CHECKS);
    expect(protectedBarChange(before, { steps: checks([0.7, 0.5]) })?.key).toBe(
      "steps.check#2.judge.threshold",
    );
    refusedBoth(TWO_CHECKS, checks([0.7, 0.5]), /would loosen "steps\.check#2\.judge\.threshold"/);
  });

  test("lowering only the first check names the first occurrence", () => {
    const before = parse(TWO_CHECKS);
    expect(protectedBarChange(before, { steps: checks([0.5, 0.7]) })?.key).toBe(
      "steps.check#1.judge.threshold",
    );
    refusedBoth(TWO_CHECKS, checks([0.5, 0.7]), /would loosen "steps\.check#1\.judge\.threshold"/);
  });

  test("raising either check, or both, passes", () => {
    const before = parse(TWO_CHECKS);
    for (const pair of [
      [0.9, 0.7],
      [0.7, 0.9],
      [0.8, 0.9],
    ] as const) {
      expect(protectedBarChange(before, { steps: checks(pair) })).toBeUndefined();
      admittedBoth(TWO_CHECKS, checks(pair));
    }
  });

  test("an unnamed protected step pairs with the step at its own position", () => {
    const doc = (threshold: number) => ({
      steps: [
        { name: "draft", instructions: "Draft it." },
        { judge: { criteria: "x", threshold, protected: true } },
      ],
    });
    expect(protectedBarChange(doc(0.7), doc(0.5))?.key).toBe("steps.1.judge.threshold");
    expect(protectedBarChange(doc(0.7), doc(0.9))).toBeUndefined();
  });

  describe("a pairing holds only while it gates the same step", () => {
    const step = (name: string, threshold?: number) =>
      threshold === undefined
        ? { name, instructions: `${name} it.` }
        : { name, kind: "judge", judge: { criteria: "is it right", threshold, protected: true } };
    const before = { steps: [step("draft"), step("revise"), step("check", 0.7)] };
    const needsOwner = (after: unknown): void => {
      expect(protectedBarChange(before, after)?.key).toBe("steps.check.judge");
      expect(escalationFor(before, after).map((e) => e.needs)).toContain("h.spec.edit.security");
    };

    test("a second step of the same name, added before or after it, needs the owner", () => {
      needsOwner({
        steps: [step("draft"), step("check", 0.9), step("revise"), step("check", 0.1)],
      });
      needsOwner({
        steps: [step("draft"), step("revise"), step("check", 0.7), step("check", 0.1)],
      });
    });

    test("a renamed gate with its name given to a new step needs the owner", () => {
      needsOwner({
        steps: [step("draft"), step("check", 0.9), step("revise"), step("final", 0.1)],
      });
      needsOwner({
        steps: [step("draft"), step("revise"), step("final", 0.1), step("check", 0.9)],
      });
    });

    test("raising the gate in place, or adding a step after it, passes", () => {
      const raised = { steps: [step("draft"), step("revise"), step("check", 0.9)] };
      expect(protectedBarChange(before, raised)).toBeUndefined();
      expect(escalationFor(before, raised)).toEqual([]);
      const extended = { steps: [...raised.steps, step("publish")] };
      expect(protectedBarChange(before, extended)).toBeUndefined();
    });
  });
});

/** The keys `protectedBarChanges` names for a change. */
const keysOf = (before: unknown, after: unknown): string[] =>
  protectedBarChanges(before, after).map((c) => c.key);

/** The one escalation a loosening of `paths` raises. */
const securityFor = (paths: string[]) => [
  {
    needs: "h.spec.edit.security",
    reason: expect.stringContaining("only the owner can make it"),
    paths,
  },
];

describe("a protected judge gate changes only by its tightenings without the owner", () => {
  const yaml = WORKFLOW(PROTECTED_GATE);
  const base = { criteria: "is it right", threshold: 0.7, protected: true };
  /** The parsed workflow with its gate's judge set to `judge`. */
  const docWith = (judge: Record<string, unknown>): Record<string, unknown> => ({
    ...(parse(yaml) as Record<string, unknown>),
    steps: stepsWith(judge),
  });
  const before = docWith(base);

  test("each owner's field of a protected gate needs the owner, and is named", () => {
    for (const [field, value] of [
      ["criteria", "anything goes"],
      ["model", "other-model"],
      ["judges", ["a", "b", "c"]],
      ["repeats", 3],
      ["temperature", 0.5],
      ["target", "transcript"],
      ["escalate_to", "strong"],
      ["on_fail", "continue"],
      ["max_retries", 2],
    ] as const) {
      const key = `steps.gate.judge.${field}`;
      const judge = { ...base, [field]: value };
      expect(keysOf(before, docWith(judge))).toEqual([key]);
      expect(escalationFor(before, docWith(judge))).toEqual(securityFor([key]));
      refusedBoth(
        yaml,
        stepsWith(judge),
        field === "max_retries" || field === "repeats"
          ? /would loosen "steps\.gate\.judge\.(max_retries|repeats)"/
          : /may not change|declares no model_pool/,
      );
    }
  });

  test("a raised max_retries or repeats on its own leaf needs the owner", () => {
    for (const [field, value] of [
      ["max_retries", 2],
      ["repeats", 3],
    ] as const) {
      expect(() =>
        validatePatch(parseSpec(yaml), {
          target: "workflow",
          path: ["steps", "1", "judge", field],
          op: "replace",
          value,
        }),
      ).toThrow(new RegExp(`would loosen "steps\\.gate\\.judge\\.${field}"`));
    }
  });

  test("on_fail only grows stricter: continue, then retry_previous (the default), then halt", () => {
    const at = (onFail?: string) =>
      docWith(onFail === undefined ? base : { ...base, on_fail: onFail });
    for (const [from, to] of [
      ["halt", "retry_previous"],
      ["retry_previous", "continue"],
      [undefined, "continue"],
    ] as const) {
      expect(keysOf(at(from), at(to))).toEqual(["steps.gate.judge.on_fail"]);
      expect(escalationFor(at(from), at(to))).toEqual(securityFor(["steps.gate.judge.on_fail"]));
    }
    expect(protectedBarChanges(at("halt"), at("retry_previous"))[0]?.reason).toContain(
      "(halt → retry_previous)",
    );
    for (const [from, to] of [
      ["continue", "halt"],
      ["continue", "retry_previous"],
      [undefined, "halt"],
    ] as const) {
      expect(protectedBarChanges(at(from), at(to))).toEqual([]);
      expect(escalationFor(at(from), at(to))).toEqual([]);
    }
    // on_fail is a person's field: the optimizer moves it in neither direction, and a
    // person's stricter on_fail needs no owner.
    refusedBoth(
      WORKFLOW(`${PROTECTED_GATE}\non_fail: continue`),
      stepsWith({ ...base, on_fail: "halt" }),
      /may not change/,
    );
  });

  test("a lowered max_retries needs no owner; absent reads 1", () => {
    const twice = WORKFLOW(`${PROTECTED_GATE}\nmax_retries: 2`);
    expect(
      protectedBarChanges(
        docWith({ ...base, max_retries: 2 }),
        docWith({ ...base, max_retries: 1 }),
      ),
    ).toEqual([]);
    admittedBoth(twice, stepsWith({ ...base, max_retries: 1 }));
    expect(protectedBarChanges(before, docWith({ ...base, max_retries: 1 }))).toEqual([]);
    admittedBoth(yaml, stepsWith({ ...base, max_retries: 1 }));
  });

  test("a raised threshold, or another step's instructions, needs no owner", () => {
    expect(protectedBarChanges(before, docWith({ ...base, threshold: 0.9 }))).toEqual([]);
    const doc = parse(yaml) as { steps: Array<Record<string, unknown>> };
    const drafted = {
      ...doc,
      steps: doc.steps.map((s) => (s["name"] === "draft" ? { ...s, instructions: "Again." } : s)),
    };
    expect(protectedBarChanges(doc, drafted)).toEqual([]);
    expect(escalationFor(doc, drafted)).toEqual([]);
  });

  test("two loosenings in one change are both named, in order, in one escalation", () => {
    const after = docWith({ ...base, on_fail: "continue", criteria: "anything goes" });
    const keys = ["steps.gate.judge.on_fail", "steps.gate.judge.criteria"];
    expect(keysOf(before, after)).toEqual(keys);
    expect(protectedBarChange(before, after)?.key).toBe(keys[0] as string);
    const escalations = escalationFor(before, after);
    expect(escalations).toEqual(securityFor(keys));
    expect(escalations[0]?.reason).toContain("; ");
  });

  test("a gate whose protection is cleared names only that", () => {
    const { protected: _p, ...open } = base;
    expect(keysOf(before, docWith({ ...open, on_fail: "continue" }))).toEqual([
      "steps.gate.judge.protected",
    ]);
  });
});

describe("the wiring around a protected graph judge node is the owner's", () => {
  const GRAPH = `name: g
target: graph
model: base-model
entry: draft
nodes:
  draft:
    instructions: Draft it.
  gate:
    kind: judge
    judge:
      criteria: is it right
      protected: true
  publish:
    instructions: Publish it.
  done:
    instructions: Done.
edges:
  - { from: draft, to: gate }
  - { from: gate, to: publish }
`;
  type Graph = Record<string, unknown> & { edges: Array<Record<string, unknown>> };
  const before = parse(GRAPH) as Graph;
  const KEY = "nodes.gate.judge.edges";
  /** The graph with `change` applied, checked to parse as a spec. */
  const graphWith = (change: Partial<Graph>): Graph => {
    const after = { ...before, ...change } as Graph;
    expect(() => parseSpec(JSON.stringify(after))).not.toThrow();
    return after;
  };
  const ahead = [{ from: "draft", to: "publish" }, ...before.edges];

  test("an edge added ahead of the upstream node's edge into the gate needs the owner", () => {
    const after = graphWith({ edges: ahead });
    expect(keysOf(before, after)).toEqual([KEY]);
    expect(escalationFor(before, after)).toEqual(securityFor([KEY]));
    expect(() =>
      validatePatch(parseSpec(GRAPH), {
        target: "graph",
        path: ["edges"],
        op: "replace",
        value: ahead,
      }),
    ).toThrow();
  });

  test("a moved entry, a parallel group and a condition on the gate's edge need the owner", () => {
    for (const after of [
      graphWith({ entry: "publish" }),
      graphWith({ parallel: [["draft", "publish"]] } as Partial<Graph>),
      graphWith({
        edges: [
          { from: "draft", to: "gate", when: { key: "draft", exists: true } },
          before.edges[1] as Record<string, unknown>,
        ],
      }),
    ]) {
      expect(keysOf(before, after)).toEqual([KEY]);
      expect(escalationFor(before, after)).toEqual(securityFor([KEY]));
    }
  });

  test("an edge between two other nodes needs no owner", () => {
    const after = graphWith({ edges: [...before.edges, { from: "publish", to: "done" }] });
    expect(protectedBarChanges(before, after)).toEqual([]);
    expect(escalationFor(before, after)).toEqual([]);
  });
});

describe("the wiring upstream of a protected graph judge node is the owner's", () => {
  /** A graph `start → draft → gate → publish`, with `done` after it and `nodes` added. */
  const graph = (
    extraNodes = "",
    edges = "  - { from: start, to: draft }\n  - { from: draft, to: gate }\n",
  ) =>
    parse(`name: g
target: graph
model: base-model
entry: start
nodes:
  start:
    instructions: Start.
  draft:
    instructions: Draft it.
${extraNodes}  gate:
    kind: judge
    judge:
      criteria: is it right
      protected: true
  publish:
    instructions: Publish it.
  done:
    instructions: Done.
edges:
${edges}  - { from: gate, to: publish }
`) as Record<string, unknown> & { edges: Array<Record<string, unknown>> };
  const KEY = "nodes.gate.judge.edges";
  const checked = (after: Record<string, unknown>) => {
    expect(() => parseSpec(JSON.stringify(after))).not.toThrow();
    return after;
  };

  test("each change to the edges, entry or parallel groups upstream of the gate needs the owner", () => {
    const before = graph();
    for (const after of [
      { ...before, edges: [{ from: "start", to: "publish" }, ...before.edges] },
      {
        ...before,
        edges: before.edges.map((e) =>
          e["from"] === "start" ? { from: "start", to: "publish" } : e,
        ),
      },
      { ...before, entry: "publish" },
      { ...before, parallel: [["start", "publish"]] },
    ]) {
      expect(keysOf(before, checked(after))).toEqual([KEY]);
      expect(escalationFor(before, after)).toEqual(securityFor([KEY]));
    }
    // Downstream of the gate stays free.
    const after = checked({ ...before, edges: [...before.edges, { from: "publish", to: "done" }] });
    expect(protectedBarChanges(before, after)).toEqual([]);
  });

  test("an edge ahead of a judge node that the protected gate judges needs the owner", () => {
    // start → draft → check (a judge) → gate (protected) → publish.
    const before = graph(
      "  check:\n    kind: judge\n    judge:\n      criteria: is it drafted\n",
      "  - { from: start, to: draft }\n  - { from: draft, to: check }\n  - { from: check, to: gate }\n",
    );
    const after = checked({
      ...before,
      edges: [{ from: "draft", to: "publish" }, ...before.edges],
    });
    expect(keysOf(before, after)).toEqual([KEY]);
    expect(escalationFor(before, after)).toEqual(securityFor([KEY]));
  });
});

describe("a protected judge reads its model profiles only as the owner set them", () => {
  const W = (gate: string) => `name: w
target: workflow
model: base-model
models:
  judge: { model: judge-model, temperature: 0 }
  other: { model: other-model, temperature: 0 }
steps:
  - name: draft
    instructions: Draft it.
  - name: gate
    kind: judge
    judge: { criteria: is it right, ${gate} }
`;
  const dial = (profile: string, field: string, value: unknown) => ({
    target: "workflow" as const,
    path: ["models", profile, field],
    op: "replace" as const,
    value,
  });

  test("a profile dial a protected gate reads needs the owner, at both entry points", () => {
    const yaml = W("model: $judge, protected: true");
    for (const [field, value] of [
      ["temperature", 1.5],
      ["max_tokens", 1],
    ] as const) {
      expect(() => validatePatch(parseSpec(yaml), dial("judge", field, value))).toThrow(
        /would loosen "steps\.gate\.judge\.model"/,
      );
      expect(() =>
        applySpecEdits(yaml, [{ path: ["models", "judge", field], value }], {
          restrictToOptimizable: true,
        }),
      ).toThrow(/would loosen "steps\.gate\.judge\.model"/);
    }
    // A profile the gate does not read stays tunable.
    expect(() => validatePatch(parseSpec(yaml), dial("other", "temperature", 1.5))).not.toThrow();
    // An unprotected gate stays tunable.
    expect(() =>
      validatePatch(parseSpec(W("model: $judge")), dial("judge", "temperature", 1.5)),
    ).not.toThrow();
  });

  test("a protected gate that names no model, or strongest, reads every profile", () => {
    for (const gate of ["protected: true", "model: strongest, protected: true"]) {
      expect(() => validatePatch(parseSpec(W(gate)), dial("other", "temperature", 1.5))).toThrow(
        /would loosen "steps\.gate\.judge\.model"/,
      );
    }
  });

  test("a protected evaluation or provability judge reads its profiles only as the owner set them", () => {
    const CLI = `name: c
target: cli
models:
  strong: { model: claude-opus-4-8, tags: [strong] }
  fast: { model: claude-sonnet-4-8, tags: [cheap] }
agent: { model: $fast, instructions: hi }
evaluation:
  grader: { type: llm_judge, criteria: be good }
  on_fail: halt
  protected: true
`;
    expect(() =>
      validatePatch(parseSpec(CLI), {
        target: "cli",
        path: ["models", "strong", "max_tokens"],
        op: "replace",
        value: 1,
      }),
    ).toThrow(/would loosen "evaluation\.grader\.model"/);
    const models = (temperature: number) => ({
      models: { waiver: { model: "m", temperature }, other: { model: "o", temperature } },
    });
    const p = (temperature: number) => ({
      ...models(temperature),
      provability: { level: "grounded", judge: { model: "$waiver" }, protected: true },
    });
    expect(keysOf(p(0), p(1))).toEqual(["provability.judge"]);
    const onlyOther = {
      ...p(0),
      models: { ...models(0).models, other: { model: "o", temperature: 1 } },
    };
    expect(keysOf(p(0), onlyOther)).toEqual([]);
  });
});

describe("a protected evaluation block changes only by its tightenings without the owner", () => {
  const CLI = `name: c
target: cli
agent: { model: m, instructions: hi }
evaluation:
  grader: { type: llm_judge, criteria: be good }
  protected: true
`;
  const evalDoc = (extra: Record<string, unknown>, grader: Record<string, unknown> = {}) => ({
    evaluation: {
      grader: { type: "llm_judge", criteria: "be good", ...grader },
      protected: true,
      ...extra,
    },
  });

  test("on_fail only tightens: note to retry, escalate or halt, retry or escalate to halt", () => {
    // A cli spec without a model pool or cascade.
    const cli = (extra: Record<string, unknown>) => ({
      name: "t",
      target: "cli",
      agent: { model: "claude-sonnet-4-5", instructions: "help" },
      ...evalDoc(extra),
    });
    const owners: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ on_fail: "retry" }, { on_fail: "escalate" }],
      [{ on_fail: "escalate" }, { on_fail: "retry" }],
      [{}, { on_fail: "escalate" }],
      [{ on_fail: "escalate" }, {}],
      [{ on_fail: "halt" }, { on_fail: "note" }],
      [{}, { on_fail: "note" }],
      [{ on_fail: "halt" }, { on_fail: "escalate" }],
    ];
    for (const [was, now] of owners) {
      expect(keysOf(cli(was), cli(now))).toEqual(["evaluation.on_fail"]);
    }
    const tighter: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ on_fail: "note" }, { on_fail: "escalate" }],
      [{ on_fail: "note" }, { on_fail: "retry" }],
      [{ on_fail: "note" }, { on_fail: "halt" }],
      [{ on_fail: "retry" }, { on_fail: "halt" }],
      [{}, { on_fail: "halt" }],
      [{ on_fail: "escalate" }, { on_fail: "halt" }],
      [{ on_fail: "retry" }, {}],
    ];
    for (const [was, now] of tighter) {
      expect(protectedBarChanges(cli(was), cli(now))).toEqual([]);
    }
    expect(escalationFor(cli({ on_fail: "retry" }), cli({ on_fail: "escalate" }))).toEqual(
      securityFor(["evaluation.on_fail"]),
    );
    expect(escalationFor(cli({ on_fail: "halt" }), cli({ on_fail: "note" }))).toEqual(
      securityFor(["evaluation.on_fail"]),
    );
  });

  test("a protected escalate's escalations only rise; absent reads 1, and none without a pool", () => {
    const pooled = (
      extra: Record<string, unknown>,
      strategy: Record<string, unknown> | undefined,
      pool = true,
    ) => ({
      name: "t",
      target: "cli",
      agent: {
        model: "claude-sonnet-4-5",
        instructions: "help",
        ...(pool
          ? {
              model_pool: {
                candidates: [{ model: "a" }, { model: "b" }],
                ...(strategy !== undefined ? { strategy } : {}),
              },
            }
          : {}),
      },
      ...evalDoc(extra),
    });
    const escalate = { on_fail: "escalate" };
    const KEY = "agent.model_pool.strategy.max_escalations";
    expect(
      keysOf(pooled(escalate, { max_escalations: 1 }), pooled(escalate, { max_escalations: 0 })),
    ).toEqual([KEY]);
    expect(
      protectedBarChange(
        pooled(escalate, { max_escalations: 1 }),
        pooled(escalate, { max_escalations: 0 }),
      )?.reason,
    ).toBe("the escalations a protected evaluation with on_fail: escalate makes only rise (1 → 0)");
    // Absent reads 1; removing the strategy or the pool counts as the change.
    expect(keysOf(pooled(escalate, undefined), pooled(escalate, { max_escalations: 0 }))).toEqual([
      KEY,
    ]);
    expect(keysOf(pooled(escalate, { max_escalations: 3 }), pooled(escalate, undefined))).toEqual([
      KEY,
    ]);
    expect(
      keysOf(pooled(escalate, { max_escalations: 2 }), pooled(escalate, undefined, false)),
    ).toEqual([KEY]);
    // A move to escalate with no escalations left is caught too.
    expect(
      keysOf(
        pooled({ on_fail: "note" }, { max_escalations: 1 }),
        pooled(escalate, { max_escalations: 0 }),
      ),
    ).toEqual([KEY]);
    // Raising them, or keeping them, tightens.
    for (const [was, now] of [
      [{ max_escalations: 1 }, { max_escalations: 2 }],
      [undefined, { max_escalations: 1 }],
      [{ max_escalations: 1 }, undefined],
      [{ max_escalations: 0 }, { max_escalations: 0 }],
    ] as const) {
      expect(protectedBarChanges(pooled(escalate, was), pooled(escalate, now))).toEqual([]);
    }
    // Only a block that escalates after the change reads them.
    expect(
      protectedBarChanges(
        pooled(escalate, { max_escalations: 1 }),
        pooled({ on_fail: "halt" }, { max_escalations: 0 }),
      ),
    ).toEqual([]);
    expect(
      protectedBarChanges(
        pooled({ on_fail: "retry" }, { max_escalations: 1 }),
        pooled({ on_fail: "retry" }, { max_escalations: 0 }),
      ),
    ).toEqual([]);
    // An evaluation block that is not protected stays tunable.
    const open = (cap: number) => {
      const doc = pooled(escalate, { max_escalations: cap });
      return { ...doc, evaluation: { ...doc.evaluation, protected: false } };
    };
    expect(protectedBarChanges(open(1), open(0))).toEqual([]);
    // A protected provability block that escalates reads them the same way.
    const proven = (cap: number) => ({
      ...pooled({}, { max_escalations: cap }),
      evaluation: undefined,
      provability: { level: "cited", on_fail: "escalate", protected: true },
    });
    expect(protectedBarChange(proven(1), proven(0))).toEqual({
      key: KEY,
      reason:
        "the escalations a protected provability with on_fail: escalate makes only rise (1 → 0)",
    });
    expect(
      escalationFor(
        pooled(escalate, { max_escalations: 1 }),
        pooled(escalate, { max_escalations: 0 }),
      ),
    ).toEqual(securityFor([KEY]));
    // validatePatch, the optimizer's boundary, refuses the same patch.
    const spec = parseSpec(`name: t
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: help
  model_pool:
    candidates:
      - model: claude-haiku-4-5
      - model: claude-sonnet-4-5
    strategy:
      max_escalations: 1
evaluation:
  grader:
    type: llm_judge
    criteria: be good
  on_fail: escalate
  protected: true
`);
    const patch = (value: number) => ({
      target: "cli" as const,
      path: ["agent", "model_pool", "strategy", "max_escalations"],
      op: "replace" as const,
      value,
    });
    expect(() => validatePatch(spec, patch(0))).toThrow(
      /would loosen "agent\.model_pool\.strategy\.max_escalations"/,
    );
    expect(() => validatePatch(spec, patch(2))).not.toThrow();
  });

  test("on_fail values outside the ladder move only with the owner", () => {
    expect(keysOf(evalDoc({ on_fail: "note" }), evalDoc({ on_fail: "constructor" }))).toEqual([
      "evaluation.on_fail",
    ]);
    expect(keysOf(evalDoc({ on_fail: "toString" }), evalDoc({ on_fail: "halt" }))).toEqual([
      "evaluation.on_fail",
    ]);
  });

  test("max_retries only falls; absent reads 1", () => {
    expect(keysOf(evalDoc({}), evalDoc({ max_retries: 3 }))).toEqual(["evaluation.max_retries"]);
    expect(protectedBarChanges(evalDoc({ max_retries: 3 }), evalDoc({ max_retries: 1 }))).toEqual(
      [],
    );
    expect(() =>
      validatePatch(parseSpec(CLI), {
        target: "cli",
        path: ["evaluation", "max_retries"],
        op: "replace",
        value: 3,
      }),
    ).toThrow(/would loosen "evaluation\.max_retries"/);
  });

  test("any change to the grader needs the owner, field by field", () => {
    expect(keysOf(evalDoc({}), evalDoc({}, { criteria: "anything" }))).toEqual([
      "evaluation.grader.criteria",
    ]);
    expect(keysOf(evalDoc({}), evalDoc({}, { repeats: 3 }))).toEqual(["evaluation.grader.repeats"]);
    expect(() =>
      validatePatch(parseSpec(CLI), {
        target: "cli",
        path: ["evaluation", "grader", "repeats"],
        op: "replace",
        value: 3,
      }),
    ).toThrow(/would loosen/);
  });

  test("allow_self_judge is set only by the owner", () => {
    expect(keysOf(evalDoc({}), evalDoc({ allow_self_judge: true }))).toEqual([
      "evaluation.allow_self_judge",
    ]);
    expect(protectedBarChanges(evalDoc({ allow_self_judge: true }), evalDoc({}))).toEqual([]);
  });
});

describe("a protected provability block changes only by its tightenings without the owner", () => {
  const p = (extra: Record<string, unknown>) => ({
    provability: { level: "grounded", protected: true, ...extra },
  });
  const CLI = `name: c
target: cli
agent: { model: m, instructions: hi }
provability:
  level: grounded
  protected: true
`;

  test("level only rises along off, cited, grounded, checked, proven", () => {
    expect(keysOf(p({ level: "proven" }), p({ level: "off" }))).toEqual(["provability.level"]);
    expect(keysOf(p({ level: "grounded" }), p({ level: "cited" }))).toEqual(["provability.level"]);
    expect(
      protectedBarChanges(p({ level: "grounded" }), p({ level: "cited" }))[0]?.reason,
    ).toContain("(grounded → cited)");
    expect(protectedBarChanges(p({ level: "cited" }), p({ level: "proven" }))).toEqual([]);
    expect(escalationFor(p({ level: "proven" }), p({ level: "off" }))).toEqual(
      securityFor(["provability.level"]),
    );
  });

  test("every field but the level and the three dials needs the owner", () => {
    for (const [field, value] of [
      ["on_fail", "note"],
      ["max_retries", 0],
      ["render", "none"],
      ["sources", { allow: ["*.gov"] }],
    ] as const) {
      expect(keysOf(p({}), p({ [field]: value }))).toEqual([`provability.${field}`]);
    }
    expect(keysOf(p({}), p({ grounded: { independent: 2 } }))).toEqual(["provability.grounded"]);
    // The dials on their own keep their own direction.
    expect(keysOf(p({}), p({ grounded: { coverage: 0.9, window_tokens: 40 } }))).toEqual([]);
    expect(() =>
      validatePatch(parseSpec(CLI), {
        target: "cli",
        path: ["provability", "max_retries"],
        op: "replace",
        value: 2,
      }),
    ).toThrow(/would loosen/);
  });
});

describe("an unprotected block stays tunable both ways for every field", () => {
  test("judge, evaluation and provability fields move freely without protection", () => {
    const gate = (judge: Record<string, unknown>) => ({ steps: stepsWith(judge) });
    const base = { criteria: "is it right", threshold: 0.7 };
    expect(
      protectedBarChanges(
        gate({ ...base, on_fail: "halt" }),
        gate({ ...base, on_fail: "continue", criteria: "x", max_retries: 5, repeats: 3 }),
      ),
    ).toEqual([]);
    const e = (extra: Record<string, unknown>) => ({
      evaluation: { grader: { type: "llm_judge", criteria: "be good" }, ...extra },
    });
    expect(
      protectedBarChanges(e({ on_fail: "halt" }), e({ on_fail: "note", allow_self_judge: true })),
    ).toEqual([]);
    expect(
      protectedBarChanges(
        { provability: { level: "proven" } },
        { provability: { level: "off", render: "none" } },
      ),
    ).toEqual([]);
  });
});

describe("a spending period that lets the harness spend more needs the security edit", () => {
  const period = (p: unknown) => ({ budget: { usd: 5, period: p } });
  const raises = (before: unknown, after: unknown): readonly string[] =>
    escalationFor(before, after).find((e) => e.needs === "h.spec.edit.security")?.paths ?? [];

  test("a higher period.usd, a shorter period and a removed period each raise", () => {
    expect(
      raises(period({ every: "month", usd: 50 }), period({ every: "month", usd: 80 })),
    ).toEqual(["budget.period.usd"]);
    expect(raises(period({ every: "month", usd: 50 }), period({ every: "week", usd: 50 }))).toEqual(
      ["budget.period.every"],
    );
    expect(raises(period({ every: "week", usd: 50 }), period({ every: "day", usd: 50 }))).toEqual([
      "budget.period.every",
    ]);
    expect(raises(period({ every: "month", usd: 50 }), { budget: { usd: 5 } })).toEqual([
      "budget.period",
    ]);
  });

  test("any change to every, starts or timezone opens a new period, so it raises", () => {
    // Longer as well as shorter: the new period starts its spend at zero.
    expect(raises(period({ every: "week", usd: 10 }), period({ every: "month", usd: 10 }))).toEqual(
      ["budget.period.every"],
    );
    expect(raises(period({ every: "day", usd: 10 }), period({ every: "week", usd: 10 }))).toEqual([
      "budget.period.every",
    ]);
    expect(
      raises(
        period({ every: "week", usd: 10 }),
        period({ every: "week", usd: 10, timezone: "Europe/Berlin" }),
      ),
    ).toEqual(["budget.period.timezone"]);
    expect(
      raises(
        period({ every: "week", usd: 10 }),
        period({ every: "week", usd: 10, starts: "2026-11-19" }),
      ),
    ).toEqual(["budget.period.starts"]);
    expect(
      raises(
        period({ every: "month", usd: 10, starts: "2026-11-01" }),
        period({ every: "month", usd: 10, starts: "2026-11-02" }),
      ),
    ).toEqual(["budget.period.starts"]);
    // An `every` that is an inherited name is still a change, never a lookup.
    expect(
      raises(period({ every: "month", usd: 10 }), period({ every: "constructor", usd: 10 })),
    ).toEqual(["budget.period.every"]);
  });

  test("a first period, a lower one, and an explicit UTC zone raise nothing", () => {
    expect(raises({ budget: { usd: 5 } }, period({ every: "month", usd: 50 }))).toEqual([]);
    expect(
      raises(period({ every: "month", usd: 50 }), period({ every: "month", usd: 20 })),
    ).toEqual([]);
    expect(
      raises(
        period({ every: "month", usd: 50 }),
        period({ every: "month", usd: 50, timezone: "UTC" }),
      ),
    ).toEqual([]);
  });
});
