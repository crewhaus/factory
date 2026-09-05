/**
 * 0.6.0 §10.1 — the three spec-level model-plan checks `crewhaus lint` and
 * `doctor --philosophy-alignment` share (the fourth, the reply-path drift
 * guard, is a codebase check exercised by doctor's boundary-site audit).
 */
import { describe, expect, test } from "bun:test";
import { type IrNode, lower } from "@crewhaus/compiler";
import { parseSpec } from "@crewhaus/spec";
import { runLint } from "./lint";
import { auditModelPlan } from "./model-plan-lint";

const noTools = (): undefined => undefined;

function lowered(yaml: string): IrNode {
  return lower(parseSpec(yaml));
}

const POOLED = `
name: pooled
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: help
  model_pool:
    candidates:
      - { model: claude-haiku-4-5, tags: [cheap] }
      - { model: claude-opus-4-8, tags: [strong] }
`.trim();

describe("model-plan:self-judge — a pooled block whose judge is a serving arm", () => {
  test("a 0.5.8-shaped pooled spec with an undeclared judge model warns (the judge defaults to the serving model)", () => {
    const ir = lowered(`${POOLED}
evaluation:
  grader: { type: llm_judge, criteria: correct }
`);
    const findings = auditModelPlan(ir);
    expect(findings.map((f) => f.rule)).toEqual(["model-plan:self-judge"]);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.path).toBe("evaluation.grader.model");
    expect(findings[0]?.message).toContain("defaults to the serving model");
    // …and it surfaces through `crewhaus lint` as a WARNING that does not gate.
    const lint = runLint(
      `${POOLED}\nevaluation:\n  grader: { type: llm_judge, criteria: correct }\n`,
      noTools,
    );
    expect(lint.ok).toBe(true);
    expect(lint.findings.some((f) => f.rule === "model-plan:self-judge")).toBe(true);
  });

  test("a judge that is one of the candidates warns; an independent judge does not; allow_self_judge silences", () => {
    const self = auditModelPlan(
      lowered(`${POOLED}
evaluation:
  grader: { type: llm_judge, criteria: correct, model: claude-haiku-4-5 }
`),
    );
    expect(self.map((f) => f.rule)).toEqual(["model-plan:self-judge"]);
    expect(self[0]?.message).toContain('"claude-haiku-4-5"');

    const independent = auditModelPlan(
      lowered(`${POOLED}
evaluation:
  grader: { type: llm_judge, criteria: correct, model: claude-sonnet-4-5 }
`),
    );
    expect(independent).toEqual([]);

    const waived = auditModelPlan(
      lowered(`${POOLED}
evaluation:
  grader: { type: llm_judge, criteria: correct, model: claude-haiku-4-5 }
  allow_self_judge: true
`),
    );
    expect(waived).toEqual([]);
  });

  test("a non-pooled spec is silent: the judge defaulting to the only model is the pre-0.6.0 norm", () => {
    const ir = lowered(`
name: single
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: help
evaluation:
  grader: { type: llm_judge, criteria: correct }
`);
    expect(auditModelPlan(ir)).toEqual([]);
  });

  test("a judge PANEL containing a serving arm warns", () => {
    const ir = lowered(`${POOLED}
evaluation:
  grader: { type: llm_judge, criteria: correct, judges: [claude-sonnet-4-5, claude-opus-4-8] }
`);
    const findings = auditModelPlan(ir);
    expect(findings.map((f) => f.rule)).toEqual(["model-plan:self-judge"]);
    expect(findings[0]?.message).toContain('"claude-opus-4-8"');
  });

  test("workflow: a judge step grading a pooled step on one of its arms warns; an independent judge does not", () => {
    const wf = (judge: string): string => `
name: w
target: workflow
model: claude-sonnet-4-6
steps:
  - name: draft
    instructions: write it
    model_pool:
      candidates:
        - { model: claude-haiku-4-5, tags: [cheap] }
        - { model: claude-opus-4-8, tags: [strong] }
  - name: gate
    kind: judge
    judge: { criteria: grounded, model: ${judge} }
`;
    const self = auditModelPlan(lowered(wf("claude-haiku-4-5")));
    expect(self.map((f) => `${f.rule}@${f.path}`)).toEqual([
      "model-plan:self-judge@steps[1].judge.model",
    ]);
    expect(auditModelPlan(lowered(wf("claude-sonnet-4-5")))).toEqual([]);
  });

  test("graph: a judge node grading its pooled upstream node on one of its arms warns", () => {
    const ir = lowered(`
name: g
target: graph
model: claude-sonnet-4-6
entry: a
nodes:
  a:
    instructions: do a
    model_pool:
      candidates:
        - { model: claude-haiku-4-5, tags: [cheap] }
        - { model: claude-opus-4-8, tags: [strong] }
  gate:
    kind: judge
    judge: { criteria: grounded, model: claude-opus-4-8 }
edges:
  - { from: a, to: gate }
`);
    const findings = auditModelPlan(ir);
    expect(findings.map((f) => `${f.rule}@${f.path}`)).toEqual([
      "model-plan:self-judge@nodes.gate.judge.model",
    ]);
  });

  test("the strategy's shadow grader and committee judge are checked against the pool's own arms", () => {
    const ir = lowered(`
name: w
target: workflow
model: claude-sonnet-4-6
steps:
  - name: draft
    instructions: write it
    model_pool:
      candidates:
        - { model: claude-haiku-4-5, tags: [cheap] }
        - { model: claude-opus-4-8, tags: [strong] }
      strategy:
        shadow: { candidate: claude-sonnet-4-5, grade_with: claude-opus-4-8 }
        committee: { members: [cheap, strong], judge: claude-haiku-4-5 }
`);
    const findings = auditModelPlan(ir);
    expect(findings.map((f) => f.path).sort()).toEqual([
      "steps[0].model_pool.strategy.committee.judge",
      "steps[0].model_pool.strategy.shadow.grade_with",
    ]);
    expect(findings.every((f) => f.rule === "model-plan:self-judge")).toBe(true);
  });
});

describe("model-plan:profile-tools — a profile's tools ⊆ the shape's resolved toolset", () => {
  // The spec layer refuses a profile tool outside a DECLARED `tools:` list,
  // and the compiler refuses profile tools on a single-model slot until the
  // plan carrier lands; the lint-reachable case is therefore a pool candidate
  // profile on a shape that declares no `tools:` — its resolved toolset is
  // what the IR carries, and the spec layer had nothing to compare against.
  const POOLED_PROFILE = (tools: string): string => `
name: p
target: cli
models:
  fast: { model: claude-haiku-4-5, tools: ${tools} }
agent:
  model: claude-sonnet-4-6
  instructions: help
  model_pool:
    candidates:
      - { model: $fast, tags: [cheap] }
      - { model: claude-opus-4-8, tags: [strong] }
`;

  test("a profile naming tools the shape does not resolve warns, naming every stray", () => {
    const findings = auditModelPlan(lowered(POOLED_PROFILE("[read, bash]")));
    expect(findings.map((f) => f.rule)).toEqual(["model-plan:profile-tools"]);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.path).toBe("models.fast.tools");
    expect(findings[0]?.message).toContain('"read", "bash"');
    expect(findings[0]?.message).toContain("can only narrow");
  });

  test("a subset (case-insensitive), MCP globs and the model-directed tools are not strays", () => {
    const ir = lowered(
      `${POOLED_PROFILE("[read, grep]")}tools: [read, grep, glob]\n`,
    ) as unknown as {
      models: { fast: { tools: string[] } };
    };
    expect(auditModelPlan(ir as unknown as IrNode)).toEqual([]);
    // Case differences, server-scoped MCP globs and Consult / Escalate are
    // validated elsewhere (the spec layer, the ir-pass) — not strays here.
    ir.models.fast.tools = ["Read", "GREP", "mcp__github__*", "Consult", "Escalate"];
    expect(auditModelPlan(ir as unknown as IrNode)).toEqual([]);
    ir.models.fast.tools = ["Read", "bash"];
    expect(auditModelPlan(ir as unknown as IrNode).map((f) => f.message)[0]).toContain('"bash"');
  });

  test("on a tool-less shape any profile tools list is flagged as ignored", () => {
    const ir = lowered(`
name: p
target: eval
models:
  fast: { model: claude-haiku-4-5 }
agent:
  model: claude-sonnet-4-6
  instructions: help
dataset: { name: d, version: v1 }
graders: [{ name: g }]
`) as unknown as { models: { fast: { tools?: string[] } } };
    expect(auditModelPlan(ir as unknown as IrNode)).toEqual([]);
    ir.models.fast.tools = ["read"];
    const findings = auditModelPlan(ir as unknown as IrNode);
    expect(findings.map((f) => f.rule)).toEqual(["model-plan:profile-tools"]);
    expect(findings[0]?.message).toContain("registers no tool catalog");
  });
});

describe("model-plan:roster-ref — references that name no roster member (drift guard)", () => {
  /** The spec layer refuses these at parse time; the guard is exercised on a direct IR. */
  function pooledIr(mutate: (pool: Record<string, unknown>) => void): IrNode {
    const ir = lowered(POOLED) as unknown as { agent: { modelPool: Record<string, unknown> } };
    mutate(ir.agent.modelPool);
    return ir as unknown as IrNode;
  }

  test("a strategy role, a rule target and the floor arm outside the roster are ERRORS", () => {
    const ir = pooledIr((pool) => {
      pool["strategy"] = { cascade: { draft: "cheap", escalateTo: "titan" } };
      pool["rules"] = [{ id: "r", when: { has_images: true }, use: "vision" }];
      pool["reward"] = { floor: { arm: "ghost" } };
    });
    const findings = auditModelPlan(ir);
    expect(findings.map((f) => `${f.severity}@${f.path}`).sort()).toEqual([
      "error@agent.model_pool.reward.floor.arm",
      "error@agent.model_pool.rules[0].use",
      "error@agent.model_pool.strategy.cascade.escalate_to",
    ]);
    expect(findings.every((f) => f.rule === "model-plan:roster-ref")).toBe(true);
    // A tag OR an arm id (profile name, else model string) is a member.
    const ok = pooledIr((pool) => {
      pool["strategy"] = { cascade: { draft: "cheap", escalateTo: "claude-opus-4-8" } };
      pool["reward"] = { floor: { arm: "strong" } };
    });
    expect(auditModelPlan(ok)).toEqual([]);
  });

  test("a sub-agent allowed_profiles entry the registry does not declare is an ERROR", () => {
    const ir = lowered(`
name: s
target: cli
models:
  fast: { model: claude-haiku-4-5 }
agent:
  model: claude-sonnet-4-6
  instructions: help
  sub_agents:
    helper:
      description: helps
      instructions: help
      allowed_profiles: [$fast]
`) as unknown as { subAgents: Array<{ allowedProfiles?: Array<{ profile: string }> }> };
    expect(auditModelPlan(ir as unknown as IrNode)).toEqual([]);
    // Drift: the registry no longer declares what the child allows.
    (ir.subAgents[0] as { allowedProfiles: Array<{ profile: string }> }).allowedProfiles = [
      { profile: "ghost" },
    ];
    const findings = auditModelPlan(ir as unknown as IrNode);
    expect(findings.map((f) => `${f.severity}@${f.path}`)).toEqual([
      "error@agent.sub_agents.helper.allowed_profiles[0]",
    ]);
    expect(findings[0]?.message).toContain("declared: fast");
  });

  test("a judge gate's escalate_to outside the gated step's pool is an ERROR, and it gates lint", () => {
    const ir = lowered(`
name: w
target: workflow
model: claude-sonnet-4-6
steps:
  - name: draft
    instructions: write it
    model_pool:
      candidates:
        - { model: claude-haiku-4-5, tags: [cheap] }
        - { model: claude-opus-4-8, tags: [strong] }
  - name: gate
    kind: judge
    judge: { criteria: grounded, model: claude-sonnet-4-5 }
`) as unknown as { steps: Array<{ judge?: Record<string, unknown> }> };
    (ir.steps[1] as { judge: Record<string, unknown> }).judge["escalateTo"] = "titan";
    const findings = auditModelPlan(ir as unknown as IrNode);
    expect(findings.map((f) => `${f.severity}@${f.path}`)).toEqual([
      "error@steps[1].judge.escalate_to",
    ]);
  });
});
