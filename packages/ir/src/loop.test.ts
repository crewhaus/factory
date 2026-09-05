/**
 * Loop contract 0.4 (Batch B, G42) — unit tests for `projectLoop` over
 * hand-built IR nodes: structural warnings, judge/hitl surfacing, id
 * collision handling, and the fallback family. The end-to-end goldens
 * (parseSpec → lower → projectLoop, one per IR variant) live in
 * `packages/compiler/src/loop-projection.test.ts` — these tests cover what
 * hand-built (non-parseSpec) IR can express.
 */
import { describe, expect, test } from "bun:test";
import type { IrCrewV0, IrGraphV0, IrNode, IrV0, IrVoiceV0, IrWorkflowV0 } from "./index";
import { NO_BUDGET_WARNING, RING_TARGETS, SEGMENT_ORDER, projectLoop } from "./index";

const minimalCli = (overrides: Partial<IrV0> = {}): IrV0 => ({
  version: 0,
  name: "t",
  target: "cli",
  agent: { model: "m", instructions: "i" },
  tools: [],
  toolConfigs: {},
  mcp_servers: {},
  permissions: { rules: [] },
  subAgents: [],
  compaction: {},
  ...overrides,
});

describe("projectLoop — ring basics", () => {
  test("a bare cli IR projects an all-inactive ring with the NO_BUDGET warning", () => {
    const projection = projectLoop(minimalCli());
    expect(projection.kind).toBe("ring");
    expect(projection.target).toBe("cli");
    expect(projection.canvas).toBeUndefined();
    expect(projection.warnings).toEqual([NO_BUDGET_WARNING]);
    const segments = projection.ring?.segments ?? [];
    expect(segments.map((s) => s.id)).toEqual([...SEGMENT_ORDER]);
    for (const s of segments) {
      expect(s.active).toBe(false);
      expect(s.keys).toEqual([]);
      expect(s.summary.length).toBeGreaterThan(0);
    }
    // A cli IR without continuity means the spec OPTED OUT (default-on shape).
    expect(segments.find((s) => s.id === "update")?.summary).toContain("explicitly disabled");
  });

  test("evaluation lights evaluate; budget/limits light stop and clear the warning", () => {
    const projection = projectLoop(
      minimalCli({
        evaluation: {
          grader: { type: "llm_judge", criteria: "helpful" },
          threshold: 0.7,
          onFail: "retry",
          maxRetries: 1,
        },
        budget: { usdMicros: 1_000_000, onExceed: { kind: "degrade", model: "cheap-model" } },
        limits: { maxToolIterations: 5 },
      }),
    );
    expect(projection.warnings).toEqual([]);
    const evaluate = projection.ring?.segments.find((s) => s.id === "evaluate");
    expect(evaluate?.active).toBe(true);
    expect(evaluate?.keys).toEqual(["evaluation"]);
    expect(evaluate?.summary).toBe("in-loop evaluation (llm_judge, threshold 0.7, on fail: retry)");
    const stop = projection.ring?.segments.find((s) => s.id === "stop");
    expect(stop?.keys).toEqual(["budget", "limits"]);
    expect(stop?.summary).toBe(
      "budget $1 (on exceed: degrade → cheap-model) · limits (max_tool_iterations)",
    );
  });

  // 0.6.0 §7.12 — `budget.scope` shows in the stop summary only when declared.
  test("budget.scope: session is named in the stop summary; absent scope renders as before", () => {
    const scoped = projectLoop(
      minimalCli({
        budget: { usdMicros: 500_000, onExceed: { kind: "stop" }, scope: "session" },
      }),
    );
    const stop = scoped.ring?.segments.find((s) => s.id === "stop");
    expect(stop?.summary).toBe("budget $0.5 (on exceed: stop; scope: session)");
    const plain = projectLoop(
      minimalCli({ budget: { usdMicros: 500_000, onExceed: { kind: "stop" } } }),
    );
    expect(plain.ring?.segments.find((s) => s.id === "stop")?.summary).toBe(
      "budget $0.5 (on exceed: stop)",
    );
  });

  test("RING_TARGETS members are exactly the shapes that get the stop warning", () => {
    expect([...RING_TARGETS]).toEqual(["cli", "channel", "managed"]);
  });
});

describe("projectLoop — workflow canvas", () => {
  const judgeStep = {
    name: "gate",
    kind: "judge" as const,
    instructions: "grounded",
    model: "m",
    tools: [],
    toolConfigs: {},
    judge: { criteria: "grounded", threshold: 0.7, onFail: "continue" as const, maxRetries: 1 },
  };
  const step = (name: string) => ({
    name,
    instructions: "x",
    model: "m",
    tools: [],
    toolConfigs: {},
  });
  const wf = (steps: IrWorkflowV0["steps"]): IrWorkflowV0 => ({
    version: 0,
    name: "w",
    target: "workflow",
    steps,
    mcp_servers: {},
    permissions: { rules: [] },
    compaction: {},
  });

  test("duplicate step names get suffixed ids; labels stay numbered", () => {
    const projection = projectLoop(wf([step("draft"), step("draft")]));
    expect(projection.canvas?.nodes.map((n) => n.id)).toEqual(["draft", "draft-2"]);
    expect(projection.canvas?.nodes.map((n) => n.label)).toEqual(["1. draft", "2. draft"]);
    expect(projection.canvas?.edges).toEqual([{ from: "draft", to: "draft-2" }]);
  });

  test("an on_fail: continue judge produces a PLAIN outgoing edge and no retry edge", () => {
    const projection = projectLoop(wf([step("draft"), judgeStep, step("publish")]));
    expect(projection.canvas?.edges).toEqual([
      { from: "draft", to: "gate" },
      { from: "gate", to: "publish" },
    ]);
  });

  test("an empty workflow warns instead of throwing", () => {
    const projection = projectLoop(wf([]));
    expect(projection.warnings).toEqual(["workflow has no steps — nothing to run"]);
    expect(projection.canvas?.nodes).toEqual([]);
  });

  test("item 9 (G37) — a step model_pool surfaces in the node's reason segment", () => {
    const pooledStep = {
      ...step("route"),
      modelPool: {
        candidates: [
          { model: "claude-haiku-4-5", tags: ["cheap"] },
          { model: "claude-opus-4-8", tags: ["strong"] },
        ],
        policy: "heuristic" as const,
      },
    };
    const projection = projectLoop(wf([pooledStep]));
    const reason = projection.canvas?.nodes[0]?.mini.find((s) => s.id === "reason");
    expect(reason?.keys).toContain("model_pool");
    expect(reason?.summary).toContain("adaptive model pool (2 candidates, policy: heuristic)");
  });
});

describe("projectLoop — crew canvas (item 9 model_pool)", () => {
  const crew = (roles: IrCrewV0["roles"], entry: string): IrCrewV0 => ({
    version: 0,
    name: "cr",
    target: "crew",
    entry,
    roles,
    mcp_servers: {},
    permissions: { rules: [] },
    compaction: {},
  });

  test("a role model_pool surfaces in the role node's reason segment", () => {
    const projection = projectLoop(
      crew(
        [
          {
            name: "lead",
            model: "base-model",
            instructions: "lead it",
            tools: [],
            toolConfigs: {},
            subAgents: [],
            modelPool: {
              candidates: [
                { model: "claude-haiku-4-5", tags: ["cheap"] },
                { model: "claude-opus-4-8", tags: ["strong"] },
              ],
              policy: "learned" as const,
            },
          },
        ],
        "lead",
      ),
    );
    const reason = projection.canvas?.nodes[0]?.mini.find((s) => s.id === "reason");
    expect(reason?.keys).toContain("model_pool");
    expect(reason?.summary).toContain("adaptive model pool (2 candidates, policy: learned)");
  });

  test("a role WITHOUT model_pool leaves model_pool out of its reason keys", () => {
    const projection = projectLoop(
      crew(
        [
          {
            name: "lead",
            model: "base-model",
            instructions: "lead it",
            tools: [],
            toolConfigs: {},
            subAgents: [],
          },
        ],
        "lead",
      ),
    );
    const reason = projection.canvas?.nodes[0]?.mini.find((s) => s.id === "reason");
    expect(reason?.keys).not.toContain("model_pool");
  });
});

describe("projectLoop — graph canvas", () => {
  const node = (name: string): IrGraphV0["nodes"][number] => ({
    name,
    instructions: "x",
    model: "m",
    tools: [],
    toolConfigs: {},
  });
  const graph = (overrides: Partial<IrGraphV0>): IrGraphV0 => ({
    version: 0,
    name: "g",
    target: "graph",
    entry: "a",
    nodes: [node("a"), node("b")],
    edges: [],
    permissions: { rules: [] },
    compaction: {},
    ...overrides,
  });

  test("dangling edges and an unknown entry warn instead of throwing", () => {
    const projection = projectLoop(
      graph({ entry: "ghost", edges: [{ from: "a", to: "missing" }] }),
    );
    expect(projection.warnings).toEqual([
      'entry "ghost" is not a declared node',
      'edge a → missing references unknown node "missing"',
    ]);
  });

  test("when predicates label edges; exists renders distinctly from equals", () => {
    const projection = projectLoop(
      graph({
        edges: [
          { from: "a", to: "b", when: { key: "a", equals: true } },
          { from: "a", to: "b", when: { key: "a", exists: true } },
        ],
      }),
    );
    expect(projection.canvas?.edges).toEqual([
      { from: "a", to: "b", label: "a == true", conditional: true },
      { from: "a", to: "b", label: "a exists", conditional: true },
    ]);
  });

  test("hitl nodes carry the badge and the safety mini", () => {
    const projection = projectLoop(
      graph({ nodes: [{ ...node("a"), hitlPrompt: "Approve?" }, node("b")] }),
    );
    const a = projection.canvas?.nodes.find((n) => n.id === "a");
    expect(a?.hitl).toBe(true);
    const safety = a?.mini.find((s) => s.id === "safety");
    expect(safety?.active).toBe(true);
    expect(safety?.summary).toBe('human approval gate: "Approve?"');
  });
});

describe("projectLoop — fallback family", () => {
  test("voice projects the generic ring with the family-hint warning", () => {
    const voice: IrVoiceV0 = {
      version: 0,
      name: "v",
      target: "voice",
      agent: { model: "m", instructions: "i" },
      voice: {
        provider: "openai",
        voiceId: "alloy",
        vad: "server",
        bargeInTriggerFrames: 4,
        bargeInWindowMs: 200,
      },
      tools: ["webFetch"],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    const projection = projectLoop(voice);
    expect(projection.kind).toBe("ring");
    expect(projection.warnings).toEqual([
      'target "voice" has no dedicated loop projection yet — showing the generic single-agent ring',
    ]);
    // Fallbacks never get the NO_BUDGET warning (their boundaries differ),
    // but their real fields still light segments honestly.
    const act = projection.ring?.segments.find((s) => s.id === "act");
    expect(act?.keys).toEqual(["tools"]);
  });

  test("the projection is pure JSON (survives a serialization round-trip)", () => {
    const shapes: IrNode[] = [minimalCli()];
    for (const ir of shapes) {
      const projection = projectLoop(ir);
      expect(JSON.parse(JSON.stringify(projection))).toEqual(projection as never);
    }
  });
});

describe("projectLoop — 0.6.0 models: registry (§4.3)", () => {
  test("the cli ring surfaces models.<name> keys and the primary's profile in the reason segment", () => {
    const projection = projectLoop({
      version: 0,
      name: "p",
      target: "cli",
      models: {
        fast: { profile: "fast", model: "claude-haiku-4-5" },
        strong: { profile: "strong", model: "claude-opus-4-8" },
      },
      agent: { model: "claude-haiku-4-5", instructions: "i", modelProfile: "fast" },
      tools: [],
      toolConfigs: {},
      mcp_servers: {},
      permissions: { rules: [] },
      subAgents: [],
      compaction: {},
    });
    const reason = projection.ring?.segments.find((s) => s.id === "reason");
    expect(reason?.active).toBe(true);
    expect(reason?.keys).toEqual(["models.fast", "models.strong"]);
    expect(reason?.summary).toContain(
      "2 model profiles (fast, strong) · primary profile: fast on claude-haiku-4-5",
    );
  });

  test("a step's profile provenance and a graph node's pool surface in the node minis", () => {
    const wf = projectLoop({
      version: 0,
      name: "w",
      target: "workflow",
      steps: [
        {
          name: "draft",
          instructions: "x",
          model: "claude-haiku-4-5",
          modelProfile: "fast",
          tools: [],
          toolConfigs: {},
        },
      ],
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    });
    const reason = wf.canvas?.nodes[0]?.mini.find((s) => s.id === "reason");
    expect(reason?.keys).toEqual(["model", "models.fast"]);
    expect(reason?.summary).toContain("profile: fast");

    const graph = projectLoop({
      version: 0,
      name: "g",
      target: "graph",
      entry: "a",
      nodes: [
        {
          name: "a",
          instructions: "x",
          model: "m",
          tools: [],
          toolConfigs: {},
          modelPool: {
            candidates: [
              { model: "a1", tags: ["cheap"] },
              { model: "a2", tags: ["strong"] },
            ],
            policy: "learned",
          },
        },
      ],
      edges: [],
      permissions: { rules: [] },
      compaction: {},
    });
    const nodeReason = graph.canvas?.nodes[0]?.mini.find((s) => s.id === "reason");
    expect(nodeReason?.keys).toContain("model_pool");
    expect(nodeReason?.summary).toContain("adaptive model pool (2 candidates, policy: learned)");
  });
});
