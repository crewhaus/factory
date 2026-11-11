/**
 * #514 — a value at a whole block is admitted leaf by leaf, at both optimizer
 * entry points (`validatePatch` and `applySpecEdits({ restrictToOptimizable })`).
 * Every refusal names the leaf and says a person can make the change; every
 * value that keeps a person's settings as the spec has them still applies.
 */
import { describe, expect, test } from "bun:test";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { parse } from "yaml";
import {
  type SpecEditPathSegment,
  SpecPatchError,
  admitBlockPatch,
  applySpecEdits,
  changedLeaves,
  isOptimizable,
  leafReachable,
  refusedLeafIn,
  validatePatch,
  wildcardPlacementIssues,
} from "./index";

const WORKFLOW = `name: w
target: workflow
model: base-model
steps:
  - name: fetch
    instructions: Fetch the page.
    model: claude-sonnet-4-6
    max_tokens: 1024
    tools: [http_get]
    tool_config:
      http:
        allowed_origins: ["https://docs.example.com"]
    model_pool:
      policy: learned
      learning:
        seed: s1
        explorationRate: 0
      candidates:
        - { model: claude-haiku-4-5 }
        - { model: claude-sonnet-4-6 }
  - name: summarise
    instructions: Summarise it.
    model: claude-haiku-4-5
`;

const GRAPH = `name: g
target: graph
model: base-model
entry: plan
nodes:
  plan:
    instructions: Plan it.
  execute:
    instructions: Execute it.
    hitl:
      prompt: Approve?
edges: [{ from: plan, to: execute }]
`;

const CREW = `name: cr
target: crew
model: base-model
entry: lead
roles:
  lead:
    instructions: Lead it.
    model: claude-sonnet-4-6
    sub_agents:
      helper:
        description: helps
        instructions: Help.
        permissions: scoped
`;

const CLI_JUSTIFIED = `name: c
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: hi
security:
  justification:
    judge: rule-based
    model: claude-haiku-4-5
`;

const CLI_POOL = `name: c
target: cli
agent:
  model: m
  instructions: hi
  model_pool:
    policy: learned
    learning: { seed: s1, explorationRate: 0 }
    candidates:
      - { model: m1, tags: [cheap] }
      - { model: m2, tags: [strong] }
`;

/** The document as plain data, straight from the text (no schema defaults). */
const plain = (yaml: string): Record<string, unknown> => parse(yaml) as Record<string, unknown>;

/** A deep copy of `value` with `edit` applied to it. */
function edited<T>(value: T, edit: (copy: T) => void): T {
  const copy = structuredClone(value);
  edit(copy);
  return copy;
}

type Step = Record<string, unknown>;
const steps = (): Step[] => plain(WORKFLOW)["steps"] as Step[];

/** Both entry points refuse `value` at `path`, naming `leaf` and a person. */
function refusedBoth(
  yaml: string,
  target: Spec["target"],
  path: ReadonlyArray<string>,
  value: unknown,
  leaf: string,
): void {
  let message = "";
  try {
    validatePatch(parseSpec(yaml), { target, path, op: "replace", value });
  } catch (err) {
    expect(err).toBeInstanceOf(SpecPatchError);
    message = (err as Error).message;
  }
  expect(message).toContain(`would change "${leaf}"`);
  expect(message).toContain("A person can make this change");
  let edits = "";
  try {
    applySpecEdits(yaml, [{ path, value }], { restrictToOptimizable: true });
  } catch (err) {
    edits = (err as Error).message;
  }
  expect(edits).toContain(`would change "${leaf}"`);
  expect(edits).toContain("A person can make this change with crewhaus propose");
}

/** Both entry points admit `value` at `path`. */
function admittedBoth(
  yaml: string,
  target: Spec["target"],
  path: ReadonlyArray<string>,
  value: unknown,
): void {
  expect(() =>
    validatePatch(parseSpec(yaml), { target, path, op: "replace", value }),
  ).not.toThrow();
  expect(applySpecEdits(yaml, [{ path, value }], { restrictToOptimizable: true }).applied).toBe(1);
}

describe("workflow: a whole steps value, and a whole step", () => {
  const CASES: ReadonlyArray<{ label: string; edit: (s: Step[]) => void; leaf: string }> = [
    {
      label: "changing a step's model",
      edit: (s) => {
        (s[0] as Step)["model"] = "claude-opus-4-8";
      },
      leaf: "steps.0.model",
    },
    {
      label: "adding a tool",
      edit: (s) => {
        (s[0] as Step)["tools"] = ["http_get", "bash"];
      },
      leaf: "steps.0.tools.1",
    },
    {
      label: "widening an egress allow-list",
      edit: (s) => {
        (s[0] as Step)["tool_config"] = {
          http: { allowed_origins: ["https://docs.example.com", "https://evil.example"] },
        };
      },
      leaf: "steps.0.tool_config.http.allowed_origins.1",
    },
    {
      label: "adding a pool candidate",
      edit: (s) => {
        const pool = (s[0] as Step)["model_pool"] as { candidates: unknown[] };
        pool.candidates.push({ model: "claude-opus-4-8" });
      },
      leaf: "steps.0.model_pool.candidates.2.model",
    },
  ];

  for (const c of CASES) {
    test(`${c.label} is refused at [steps] and at [steps, 0]`, () => {
      const next = edited(steps(), c.edit);
      refusedBoth(WORKFLOW, "workflow", ["steps"], next, c.leaf);
      refusedBoth(WORKFLOW, "workflow", ["steps", "0"], next[0], c.leaf);
    });

    test(`${c.label}: the same value with the setting kept passes`, () => {
      for (const [key, value] of [
        ["instructions", "Fetch the page, then quote it."],
        ["max_tokens", 2048],
        ["thinking", { budget_tokens: 2048 }],
      ] as const) {
        const next = edited(steps(), (s) => {
          (s[0] as Step)[key] = value;
        });
        admittedBoth(WORKFLOW, "workflow", ["steps"], next);
        admittedBoth(WORKFLOW, "workflow", ["steps", "0"], next[0]);
      }
    });
  }

  test("a path through a new structural segment is no longer admitted by prefix", () => {
    for (const path of [
      ["steps", "0", "permissions", "mode"],
      ["steps", "0", "tool_config", "http", "allowed_origins"],
      ["steps", "0", "tools"],
      ["steps", "0", "model"],
      ["nodes", "a", "hitl", "prompt"],
    ]) {
      const target = path[0] === "nodes" ? "graph" : "workflow";
      expect(isOptimizable(target, path), path.join(".")).toBe(false);
    }
    // The fields beside them stay admitted.
    for (const path of [
      ["steps", "0", "instructions"],
      ["steps", "0", "max_tokens"],
      ["steps", "0", "thinking", "budget_tokens"],
      ["steps", "0", "name"],
      ["steps", "0", "temperature"],
    ]) {
      expect(isOptimizable("workflow", path), path.join(".")).toBe(true);
    }
  });

  test("a refused row inside the value: the seed of a step's pool", () => {
    const next = edited(steps(), (s) => {
      const pool = (s[0] as Step)["model_pool"] as { learning: Record<string, unknown> };
      pool.learning["seed"] = "s2";
    });
    refusedBoth(WORKFLOW, "workflow", ["steps"], next, "steps.0.model_pool.learning.seed");
    expect(() =>
      validatePatch(parseSpec(WORKFLOW), {
        target: "workflow",
        path: ["steps"],
        op: "replace",
        value: next,
      }),
    ).toThrow(/a routed eval PINS model_pool\.learning\.seed/);
  });

  test("the ancestor rule: a tunable leaf under a wholesale entry passes inside a whole-steps value", () => {
    const next = edited(steps(), (s) => {
      const pool = (s[0] as Step)["model_pool"] as { learning: Record<string, unknown> };
      pool.learning["explorationRate"] = 0.05;
    });
    // `isOptimizable` alone refuses the leaf (structural, not exact) …
    expect(
      isOptimizable("workflow", ["steps", "0", "model_pool", "learning", "explorationRate"]),
    ).toBe(false);
    // … `leafReachable` reaches it through `steps.*.model_pool.learning`.
    admittedBoth(WORKFLOW, "workflow", ["steps"], next);
  });

  test("the advisor's spread learning patch passes", () => {
    const spec = parseSpec(CLI_POOL);
    if (spec.target !== "cli") throw new Error("unexpected target");
    const learning = { ...(spec.agent.model_pool?.learning ?? {}), explorationRate: 0.05 };
    const patch = {
      target: "cli" as const,
      path: ["agent", "model_pool", "learning"],
      op: "replace" as const,
      value: learning,
    };
    expect(() => validatePatch(spec, patch)).not.toThrow();
    expect(
      applySpecEdits(CLI_POOL, [{ path: patch.path, value: learning }], {
        restrictToOptimizable: true,
      }).applied,
    ).toBe(1);
  });

  test("a value copied from the spec TEXT (defaults missing) is judged against the parsed spec's defaults", () => {
    // The text's candidates have no `tags`; the parsed spec's carry `tags: []`.
    const next = edited(steps(), (s) => {
      (s[1] as Step)["instructions"] = "Summarise it in one line.";
    });
    expect(() =>
      validatePatch(parseSpec(WORKFLOW), {
        target: "workflow",
        path: ["steps"],
        op: "replace",
        value: next,
      }),
    ).not.toThrow();
  });

  test("a value taken from the PARSED spec (defaults present) passes applySpecEdits", () => {
    const spec = parseSpec(WORKFLOW);
    if (spec.target !== "workflow") throw new Error("unexpected target");
    const next = edited(structuredClone(spec.steps) as unknown as Step[], (s) => {
      (s[1] as Step)["instructions"] = "Summarise it in one line.";
    });
    const pool = (next[0] as Step)["model_pool"] as { candidates: Array<Record<string, unknown>> };
    // The point of the case: the parsed form carries a default the text omits.
    expect(pool.candidates[0]?.["tags"]).toEqual([]);
    expect(
      applySpecEdits(WORKFLOW, [{ path: ["steps"], value: next }], {
        restrictToOptimizable: true,
      }).applied,
    ).toBe(1);
  });

  test("a batch is judged as a whole, and the refusal names the edit that moved the leaf", () => {
    const next = edited(steps(), (s) => {
      (s[1] as Step)["model"] = "claude-opus-4-8";
    });
    // Edit #0 alone is admitted.
    expect(
      applySpecEdits(WORKFLOW, [{ path: ["steps", "0", "name"], value: "get" }], {
        restrictToOptimizable: true,
      }).applied,
    ).toBe(1);
    let message = "";
    try {
      applySpecEdits(
        WORKFLOW,
        [
          { path: ["steps", "0", "name"], value: "get" },
          { path: ["steps"], value: next },
        ],
        { restrictToOptimizable: true },
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('edit #1 (steps) would change "steps.1.model"');
  });

  test("a leaf no edit path covers is the batch's", () => {
    // The step's model aliases its name: an edit to the name moves the model.
    const aliased = [
      "name: w",
      "target: workflow",
      "model: base-model",
      "steps:",
      "  - name: &n claude-haiku-4-5",
      "    instructions: Do it.",
      "    model: *n",
      "",
    ].join("\n");
    let message = "";
    try {
      applySpecEdits(aliased, [{ path: ["steps", 0, "name"], value: "claude-opus-4-8" }], {
        restrictToOptimizable: true,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('the edits together would change "steps.0.model"');
  });
});

describe("graph and crew", () => {
  test("graph: a whole nodes value that drops a node's hitl gate is refused", () => {
    const nodes = plain(GRAPH)["nodes"] as Record<string, Step>;
    const next = edited(nodes, (n) => {
      Reflect.deleteProperty(n["execute"] as Step, "hitl");
    });
    refusedBoth(GRAPH, "graph", ["nodes"], next, "nodes.execute.hitl.prompt");
    admittedBoth(
      GRAPH,
      "graph",
      ["nodes"],
      edited(nodes, (n) => {
        (n["plan"] as Step)["instructions"] = "Plan it carefully.";
      }),
    );
  });

  test("crew: a whole roles value that changes a role's model, or a sub-agent's permissions, is refused", () => {
    const roles = plain(CREW)["roles"] as Record<string, Step>;
    refusedBoth(
      CREW,
      "crew",
      ["roles"],
      edited(roles, (r) => {
        (r["lead"] as Step)["model"] = "claude-opus-4-8";
      }),
      "roles.lead.model",
    );
    refusedBoth(
      CREW,
      "crew",
      ["roles"],
      edited(roles, (r) => {
        const helper = ((r["lead"] as Step)["sub_agents"] as Record<string, Step>)["helper"];
        (helper as Step)["permissions"] = "inherit";
      }),
      "roles.lead.sub_agents.helper.permissions",
    );
    admittedBoth(
      CREW,
      "crew",
      ["roles"],
      edited(roles, (r) => {
        (r["lead"] as Step)["max_tokens"] = 2048;
      }),
    );
  });
});

describe("the intent gate on cli", () => {
  test("a justification value that sets the claude judge and keeps the model passes", () => {
    expect(() =>
      validatePatch(parseSpec(CLI_JUSTIFIED), {
        target: "cli",
        path: ["security", "justification"],
        op: "replace",
        value: { judge: "claude", model: "claude-haiku-4-5" },
      }),
    ).not.toThrow();
  });

  test("one that changes the judge's model is refused, naming it", () => {
    expect(() =>
      validatePatch(parseSpec(CLI_JUSTIFIED), {
        target: "cli",
        path: ["security", "justification"],
        op: "replace",
        value: { judge: "claude", model: "claude-opus-4-8" },
      }),
    ).toThrow(/would change "security\.justification\.model"/);
  });
});

describe("refusedLeafIn honours wildcards and roots", () => {
  const rows = {
    leaves: [
      ["models", "*", "price"],
      ["judge", "protected"],
    ],
    roots: [["intent"]],
  };

  test("a wildcard matches exactly one segment", () => {
    expect(refusedLeafIn(["models", "fast", "price"], rows)).toEqual(["models", "*", "price"]);
    expect(refusedLeafIn(["models", "price"], rows)).toBeUndefined();
    expect(refusedLeafIn(["models", "a", "b", "price"], rows)).toBeUndefined();
  });

  test("a run matches anywhere, inside a whole step", () => {
    expect(refusedLeafIn(["steps", "1", "judge", "protected"], rows)).toEqual([
      "judge",
      "protected",
    ]);
  });

  test("a root row matches only from the root", () => {
    expect(refusedLeafIn(["intent", "purpose"], rows)).toEqual(["intent"]);
    expect(refusedLeafIn(["nodes", "intent", "instructions"], rows)).toBeUndefined();
    // The shipped tables: a node called intent stays tunable.
    expect(refusedLeafIn(["nodes", "intent", "instructions"])).toBeUndefined();
    expect(refusedLeafIn(["steps", "0", "model_pool", "candidates", "1", "model"])).toEqual([
      "model_pool",
      "candidates",
    ]);
  });
});

describe("changedLeaves", () => {
  test("added, removed and changed leaves, with sequence indices", () => {
    const before = { a: { x: 1, y: [1, 2] }, b: "keep", gone: true };
    const after = { a: { x: 2, y: [1, 2, 3] }, b: "keep", fresh: null };
    expect(changedLeaves(before, after, [])).toEqual([
      { path: ["a", "x"], before: 1, after: 2 },
      { path: ["a", "y", "2"], before: undefined, after: 3 },
      { path: ["fresh"], before: undefined, after: null },
      { path: ["gone"], before: true, after: undefined },
    ]);
  });

  test("an empty mapping or sequence is a leaf, and the two kinds differ", () => {
    expect(changedLeaves({ a: {} }, { a: {} }, [])).toEqual([]);
    expect(changedLeaves({ a: [] }, { a: [] }, [])).toEqual([]);
    expect(changedLeaves({ a: {} }, { a: [] }, [])).toEqual([
      { path: ["a"], before: {}, after: [] },
    ]);
    // Filling or emptying a container is told by the leaves under it.
    expect(changedLeaves({ a: [] }, { a: ["x"] }, [])).toEqual([
      { path: ["a", "0"], before: undefined, after: "x" },
    ]);
    expect(changedLeaves({ a: { b: 1 } }, { a: {} }, [])).toEqual([
      { path: ["a", "b"], before: 1, after: undefined },
    ]);
    // A container that appears empty, or turns into another kind, is a leaf.
    expect(changedLeaves({}, { a: {} }, ["a"])).toEqual([
      { path: ["a"], before: undefined, after: {} },
    ]);
    expect(changedLeaves({ a: ["x"] }, { a: {} }, [])).toEqual([
      { path: ["a"], before: undefined, after: {} },
      { path: ["a", "0"], before: "x", after: undefined },
    ]);
  });

  test("only leaves under `at`, with their full paths", () => {
    const before = { s: [{ m: 1 }, { m: 2 }], other: 1 };
    const after = { s: [{ m: 1 }, { m: 3 }], other: 2 };
    expect(changedLeaves(before, after, ["s", 1])).toEqual([
      { path: ["s", "1", "m"], before: 2, after: 3 },
    ]);
  });

  test("the order is deterministic: by dotted path, code unit by code unit", () => {
    const before = { keep: 1 };
    const after = { b: 1, B: 1, a: { z: 1, Z: 1, b: 1 }, "a.b": 1, keep: 1 };
    const paths = changedLeaves(before, after, []).map((l) => l.path.join("."));
    expect(paths).toEqual(["B", "a.Z", "a.b", "a.b", "a.z", "b"]);
    // The two `a.b` leaves are told apart by their segments, in a fixed order.
    expect(changedLeaves(before, after, []).map((l) => l.path)).toEqual([
      ["B"],
      ["a", "Z"],
      ["a", "b"],
      ["a.b"],
      ["a", "z"],
      ["b"],
    ]);
  });
});

describe("admitBlockPatch and leafReachable", () => {
  test("rules apply in order: a refused row, then reach, then the caller's rule", () => {
    const at: SpecEditPathSegment[] = ["steps"];
    const pool = (seed: string) => ({ steps: [{ model_pool: { learning: { seed } } }] });
    expect(admitBlockPatch("workflow", pool("a"), pool("b"), at)?.rule).toBe("refused-leaf");
    const model = (m: string) => ({ steps: [{ model: m }] });
    const notTunable = admitBlockPatch("workflow", model("a"), model("b"), at);
    expect(notTunable).toMatchObject({ rule: "not-tunable", leaf: "steps.0.model" });
    expect(notTunable?.reason).toContain("roster a person chose");
    const prompt = (p: string) => ({ steps: [{ instructions: p }] });
    expect(admitBlockPatch("workflow", prompt("a"), prompt("b"), at)).toBeUndefined();
    const seen: string[] = [];
    const caller = admitBlockPatch("workflow", prompt("a"), prompt("b"), at, {
      leafRule: (leaf) => {
        seen.push(`${leaf.path.join(".")}:${String(leaf.before)}>${String(leaf.after)}`);
        return "the caller says no";
      },
    });
    expect(caller).toEqual({
      leaf: "steps.0.instructions",
      path: ["steps", "0", "instructions"],
      reason: "the caller says no",
      rule: "caller",
    });
    expect(seen).toEqual(["steps.0.instructions:a>b"]);
  });

  test("leafReachable stops at a structural segment between the entry and the leaf", () => {
    expect(leafReachable("workflow", ["steps", "0", "instructions"])).toBe(true);
    expect(leafReachable("workflow", ["steps", "0", "model"])).toBe(false);
    expect(leafReachable("workflow", ["steps", "0", "model_pool", "learning", "bandit"])).toBe(
      true,
    );
    expect(leafReachable("workflow", ["steps", "0", "model_pool", "candidates", "0"])).toBe(false);
    expect(leafReachable("cli", ["security", "justification", "judge"])).toBe(true);
    expect(leafReachable("cli", ["security", "justification", "model"])).toBe(false);
  });

  test("the wildcard placement guard still passes on the shipped table", () => {
    expect(wildcardPlacementIssues()).toEqual([]);
  });
});
