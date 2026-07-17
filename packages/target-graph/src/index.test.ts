import { describe, expect, test } from "bun:test";
import { escapeJsonString } from "@crewhaus/infra-utils";
import type { IrGraphV0 } from "@crewhaus/ir";
import { TargetEmitError, emitGraph } from "./index";

const baseIr: IrGraphV0 = {
  version: 0,
  name: "hello-graph",
  target: "graph",
  entry: "plan",
  nodes: [
    {
      name: "plan",
      instructions: "Plan the work",
      model: "claude-sonnet-4-6",
      tools: [],
      toolConfigs: {},
    },
    {
      name: "execute",
      instructions: "Execute the plan",
      model: "claude-sonnet-4-6",
      tools: [],
      toolConfigs: {},
      hitlPrompt: "approve plan?",
    },
    {
      name: "summarise",
      instructions: "Summarise the result",
      model: "claude-sonnet-4-6",
      tools: [],
      toolConfigs: {},
    },
  ],
  edges: [
    { from: "plan", to: "execute" },
    { from: "execute", to: "summarise" },
  ],
  permissions: { rules: [] },
  compaction: {},
};

describe("emitGraph", () => {
  test("returns agent.ts plus the generated README.md (item 42)", () => {
    const bundle = emitGraph(baseIr);
    expect(bundle.files.length).toBe(2);
    expect(bundle.files[0]?.path).toBe("agent.ts");
    expect(bundle.files[1]?.path).toBe("README.md");
    expect(bundle.files[1]?.content).toContain("| Target | `graph` |");
  });

  test("readme: false restores the single-file bundle (item 42 opt-out)", () => {
    const bundle = emitGraph(baseIr, { readme: false });
    expect(bundle.files.length).toBe(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("emits the standard generated header", () => {
    const bundle = emitGraph(baseIr);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain("DO NOT EDIT");
    expect(content).toContain("target: graph");
  });

  test("registers each node in declaration order", () => {
    const bundle = emitGraph(baseIr);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain('.addNode("plan",');
    expect(content).toContain('.addNode("execute",');
    expect(content).toContain('.addNode("summarise",');
  });

  test("emits edges and entry", () => {
    const bundle = emitGraph(baseIr);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain('.addEdge("plan", "execute")');
    expect(content).toContain('.addEdge("execute", "summarise")');
    expect(content).toContain('.setEntry("plan")');
  });

  test("hitl node emits requestApproval call", () => {
    const bundle = emitGraph(baseIr);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain("ctx.requestApproval");
    expect(content).toContain("approve plan?");
  });

  test("non-hitl node does NOT emit requestApproval", () => {
    const planNode = baseIr.nodes[0];
    if (planNode === undefined) throw new Error("baseIr is missing the plan node");
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [{ ...planNode, hitlPrompt: undefined }] as IrGraphV0["nodes"],
      edges: [],
    };
    const bundle = emitGraph(ir);
    const content = bundle.files[0]?.content ?? "";
    expect(content).not.toContain("ctx.requestApproval");
  });

  test("rejects an entry that doesn't reference a declared node", () => {
    const ir: IrGraphV0 = { ...baseIr, entry: "missing" };
    expect(() => emitGraph(ir)).toThrow(TargetEmitError);
  });

  test("rejects an edge that references an unknown from-node", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      edges: [{ from: "ghost", to: "plan" }],
    };
    expect(() => emitGraph(ir)).toThrow(/unknown node "ghost"/);
  });

  test("rejects an edge that references an unknown to-node", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      edges: [{ from: "plan", to: "ghost" }],
    };
    expect(() => emitGraph(ir)).toThrow(/unknown node "ghost"/);
  });

  test("emits CLI arg parsing for --resume and --branch-from", () => {
    const bundle = emitGraph(baseIr);
    const content = bundle.files[0]?.content ?? "";
    expect(content).toContain("--resume");
    expect(content).toContain("--branch-from");
  });

  // Regression — issue #140 (CWE-94). A graph node name must never be
  // interpolated into emitted code as a bare identifier: a name containing
  // `};` previously broke out of the `__next` object literal and injected a
  // top-level statement into agent.ts (RCE on the build/run host).
  test("malicious node name is emitted as a computed string key, not bare code", () => {
    const name = 'pwn: __reply }; globalThis.__PWNED__ = "RCE"; const __z = { x';
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: name,
      nodes: [
        { name, instructions: "x", model: "claude-sonnet-4-6", tools: [], toolConfigs: {} },
      ] as IrGraphV0["nodes"],
      edges: [],
    };
    const content = emitGraph(ir).files[0]?.content ?? "";
    // The name is a computed key built from the escaped string literal …
    expect(content).toContain(`{ ...prev, [${escapeJsonString(name)}]: __reply }`);
    // … never a bare identifier, and the payload never appears as live code.
    expect(content).not.toContain("{ ...prev, pwn:");
    expect(content).not.toContain('__reply }; globalThis.__PWNED__ = "RCE"; const __z');
  });

  test("malicious hitl node name does not break the _decision assignment", () => {
    const name = "x = 1; globalThis.__HITL_PWNED__ = 1; let _q";
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: name,
      nodes: [
        {
          name,
          instructions: "x",
          model: "claude-sonnet-4-6",
          tools: [],
          toolConfigs: {},
          hitlPrompt: "ok?",
        },
      ] as IrGraphV0["nodes"],
      edges: [],
    };
    const content = emitGraph(ir).files[0]?.content ?? "";
    expect(content).toContain(`__next[${escapeJsonString(name)} + "_decision"]`);
    expect(content).not.toContain("__next.x = 1; globalThis.__HITL_PWNED__");
  });
});

describe("emitGraph — failureTaxonomy field (item 23)", () => {
  test("threads failureTaxonomy into every node's runChatLoop call", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      failureTaxonomy: [
        { class: "rate_limited", pattern: "/429|rate.?limit/i", recovery: "retry" },
        { class: "tool_timeout", pattern: "ETIMEDOUT", recovery: "continue", hint: "slow tool" },
      ],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    const matches = c.match(/failureTaxonomy:/g) ?? [];
    expect(matches.length).toBe(3); // one per node
    expect(c).toContain('"recovery":"retry"');
    expect(c).toContain('"pattern":"ETIMEDOUT"');
  });

  test("omits failureTaxonomy when the IR leaves it unset or empty", () => {
    expect(emitGraph(baseIr).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
    const empty: IrGraphV0 = { ...baseIr, failureTaxonomy: [] };
    expect(emitGraph(empty).files[0]?.content ?? "").not.toContain("failureTaxonomy:");
  });
});

describe("emitGraph — node tools (G07)", () => {
  function withTools(
    tools: readonly string[],
    toolConfigs: IrGraphV0["nodes"][number]["toolConfigs"] = {},
  ): IrGraphV0 {
    const [plan, execute, summarise] = baseIr.nodes;
    if (plan === undefined || execute === undefined || summarise === undefined) {
      throw new Error("baseIr is missing nodes");
    }
    return { ...baseIr, nodes: [{ ...plan, tools, toolConfigs }, execute, summarise] };
  }

  test("resolves declared tools into grouped imports and a per-node tools field", () => {
    const c = emitGraph(withTools(["read", "grep", "bash"])).files[0]?.content ?? "";
    expect(c).toContain('import { bash } from "@crewhaus/tool-bash";');
    expect(c).toContain('import { grep, read } from "@crewhaus/tool-fs";');
    // Declaration order inside the node's array, not import order.
    expect(c).toContain("tools: [read, grep, bash],");
    // Only the declaring node advertises tools.
    const matches = c.match(/tools: \[/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("a configured tool emits its init call before the graph is built", () => {
    const c =
      emitGraph(withTools(["webFetch"], { webFetch: { allowed_origins: ["https://x.dev"] } }))
        .files[0]?.content ?? "";
    expect(c).toContain('import { registerWebFetchConfig, webFetch } from "@crewhaus/tool-web";');
    expect(c).toContain('registerWebFetchConfig({"allowed_origins":["https://x.dev"]});');
    // Init precedes the builder so the tool sees its config on first use.
    expect(c.indexOf("registerWebFetchConfig({")).toBeLessThan(c.indexOf("createGraph("));
    expect(c).toContain("tools: [webFetch],");
  });

  test("an unconfigured init-bearing tool emits no init call", () => {
    const c = emitGraph(withTools(["webFetch"])).files[0]?.content ?? "";
    expect(c).toContain('import { webFetch } from "@crewhaus/tool-web";');
    expect(c).not.toContain("registerWebFetchConfig(");
  });

  test("two nodes with different tool sets each get their own array", () => {
    const [plan, execute, summarise] = baseIr.nodes;
    if (plan === undefined || execute === undefined || summarise === undefined) {
      throw new Error("baseIr is missing nodes");
    }
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [{ ...plan, tools: ["read"] }, { ...execute, tools: ["bash", "read"] }, summarise],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain("tools: [read],");
    expect(c).toContain("tools: [bash, read],");
    // The shared `read` import is emitted once.
    const readImports = c.match(/import \{ read \} from "@crewhaus\/tool-fs";/g) ?? [];
    expect(readImports.length).toBe(1);
  });

  test("rejects an unknown tool with the known-tools list", () => {
    expect(() => emitGraph(withTools(["teleport"]))).toThrow(TargetEmitError);
    expect(() => emitGraph(withTools(["teleport"]))).toThrow(/unknown tool "teleport"/);
    expect(() => emitGraph(withTools(["teleport"]))).toThrow(/known tools: .*bash.*read/);
  });

  test("tool-less graphs emit no tools field and no tool imports", () => {
    const c = emitGraph(baseIr).files[0]?.content ?? "";
    expect(c).not.toContain("tools: [");
    expect(c).not.toContain("@crewhaus/tool-");
  });
});

describe("emitGraph — edges[].when → EdgeCondition (Batch A)", () => {
  test("equals lowers onto a strict-equality lambda over the shared state", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      edges: [{ from: "plan", to: "execute", when: { key: "plan", equals: "approve" } }],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain(
      '.addEdge("plan", "execute", (__state) => (__state as Record<string, unknown>)["plan"] === "approve")',
    );
  });

  test("equals: false and numeric equals serialize as JS literals", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      edges: [
        { from: "plan", to: "execute", when: { key: "plan", equals: false } },
        { from: "execute", to: "summarise", when: { key: "execute", equals: 42 } },
      ],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain('(__state as Record<string, unknown>)["plan"] === false)');
    expect(c).toContain('(__state as Record<string, unknown>)["execute"] === 42)');
  });

  test("exists lowers onto an !== undefined lambda", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      edges: [{ from: "plan", to: "execute", when: { key: "plan", exists: true } }],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain(
      '.addEdge("plan", "execute", (__state) => (__state as Record<string, unknown>)["plan"] !== undefined)',
    );
  });

  test("a when-less edge stays a two-argument addEdge (byte-identical form)", () => {
    const c = emitGraph(baseIr).files[0]?.content ?? "";
    expect(c).toContain('.addEdge("plan", "execute")');
  });

  test("a malicious when.key is emitted as an escaped string literal, never bare code", () => {
    const name = 'k"] === 0 || globalThis.__PWNED__ === (__state["x';
    const nodes = [...baseIr.nodes.map((n) => ({ ...n }))];
    const first = nodes[0];
    if (first === undefined) throw new Error("missing node");
    const evil = { ...first, name };
    const ir: IrGraphV0 = {
      ...baseIr,
      entry: name,
      nodes: [evil],
      edges: [{ from: name, to: name, when: { key: name, exists: true } }],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain(`(__state as Record<string, unknown>)[${escapeJsonString(name)}]`);
    expect(c).not.toContain('(__state as Record<string, unknown>)["k"]');
  });

  test("rejects a when.key that names an undeclared node", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      edges: [{ from: "plan", to: "execute", when: { key: "ghost", exists: true } }],
    };
    expect(() => emitGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitGraph(ir)).toThrow(/when\.key references unknown node "ghost"/);
  });

  test("rejects a when block carrying neither equals nor exists (direct-IR guard)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      edges: [{ from: "plan", to: "execute", when: { key: "plan" } }],
    };
    expect(() => emitGraph(ir)).toThrow(/exactly one of equals\/exists/);
  });
});

describe("emitGraph — parallel groups (Batch A)", () => {
  test("each group lowers onto one addParallel call, after edges, before setEntry", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      parallel: [["execute", "summarise"]],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain('.addParallel(["execute", "summarise"])');
    const edgeIdx = c.lastIndexOf(".addEdge(");
    const parallelIdx = c.indexOf(".addParallel(");
    const entryIdx = c.indexOf(".setEntry(");
    expect(edgeIdx).toBeLessThan(parallelIdx);
    expect(parallelIdx).toBeLessThan(entryIdx);
  });

  test("groups preserve declaration order (order is execution semantics)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      parallel: [
        ["summarise", "plan"],
        ["plan", "execute"],
      ],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    const first = c.indexOf('.addParallel(["summarise", "plan"])');
    const second = c.indexOf('.addParallel(["plan", "execute"])');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  test("no parallel block → no addParallel call", () => {
    expect(emitGraph(baseIr).files[0]?.content ?? "").not.toContain(".addParallel(");
  });

  test("rejects a group referencing an undeclared node", () => {
    const ir: IrGraphV0 = { ...baseIr, parallel: [["plan", "ghost"]] };
    expect(() => emitGraph(ir)).toThrow(/parallel group references unknown node "ghost"/);
  });

  test("rejects a group smaller than 2 (addParallel's floor, failed at emit)", () => {
    const ir: IrGraphV0 = { ...baseIr, parallel: [["plan"]] };
    expect(() => emitGraph(ir)).toThrow(/needs at least 2 nodes/);
  });
});

describe("emitGraph — node maxTokens/thinking (Batch A)", () => {
  test("node-level knobs land only in the declaring node's runChatLoop call", () => {
    const [plan, execute, summarise] = baseIr.nodes;
    if (plan === undefined || execute === undefined || summarise === undefined) {
      throw new Error("baseIr is missing nodes");
    }
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [
        { ...plan, maxTokens: 2048, thinking: { budgetTokens: 4096 } },
        { ...execute, thinking: { effort: "low" } },
        summarise,
      ],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain("maxTokens: 2048,");
    expect(c).toContain('thinking: {"budgetTokens":4096},');
    expect(c).toContain('thinking: {"effort":"low"},');
    expect((c.match(/maxTokens:/g) ?? []).length).toBe(1);
    expect((c.match(/thinking:/g) ?? []).length).toBe(2);
  });

  test("absent knobs emit nothing (bundles stay byte-identical)", () => {
    const c = emitGraph(baseIr).files[0]?.content ?? "";
    expect(c).not.toContain("maxTokens:");
    expect(c).not.toContain("thinking:");
  });
});

describe("emitGraph — budget/limits/hooks threading (Batch A)", () => {
  const richIr: IrGraphV0 = {
    ...baseIr,
    budget: { usdMicros: 1_500_000, onExceed: { kind: "degrade", model: "cheap-model" } },
    limits: {
      maxToolIterations: 5,
      maxConcurrentTools: 2,
      contextLimit: 100_000,
      deadlineMs: 300_000,
      turnTimeoutMs: 60_000,
      modelCallTimeoutMs: 30_000,
      loopDetection: { window: 6, threshold: 3, escalation: "warn" },
    },
    hooks: [
      { event: "pre-model", command: "trace", timeoutMs: 2_000 },
      { event: "stop", command: "echo done" },
    ],
  };

  test("graph-level budget/limits/hooks land in EVERY node's runChatLoop call", () => {
    const c = emitGraph(richIr).files[0]?.content ?? "";
    for (const field of [
      'budget: {"usdMicros":1500000,"onExceed":{"kind":"degrade","model":"cheap-model"}},',
      "maxToolIterations: 5,",
      "maxConcurrentTools: 2,",
      "contextLimit: 100000,",
      "deadlineMs: 300000,",
      "turnTimeoutMs: 60000,",
      "modelCallTimeoutMs: 30000,",
      'loopDetection: {"window":6,"threshold":3,"escalation":"warn"},',
    ]) {
      const occurrences = c.split(field).length - 1;
      expect(occurrences).toBe(3); // one per node
    }
    // Hooks keep declaration order — firing order is semantics.
    const hooks = c.match(/hooks: \[.*?\],/g) ?? [];
    expect(hooks.length).toBe(3);
    expect(hooks[0]).toBe(
      'hooks: [{"event":"pre-model","command":"trace","timeoutMs":2000},{"event":"stop","command":"echo done"}],',
    );
  });

  test("declared-only knobs are emitted (absent knobs stay absent)", () => {
    const ir: IrGraphV0 = { ...baseIr, limits: { deadlineMs: 1_000 } };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain("deadlineMs: 1000,");
    expect(c).not.toContain("maxToolIterations:");
    expect(c).not.toContain("loopDetection:");
  });

  test("base bundles carry none of the new fields", () => {
    const c = emitGraph(baseIr).files[0]?.content ?? "";
    for (const absent of ["budget:", "deadlineMs:", "hooks:", "loopDetection:"]) {
      expect(c).not.toContain(absent);
    }
    const empty: IrGraphV0 = { ...baseIr, hooks: [] };
    expect(emitGraph(empty).files[0]?.content ?? "").not.toContain("hooks:");
  });
});

describe("emitGraph — classified terminal failures (v0.3.0 Goal 6)", () => {
  test("main() is wrapped so a classified error renders its report and coded exit", () => {
    const c = emitGraph(baseIr).files[0]?.content ?? "";
    expect(c).toContain('import { formatRunFailure, toFailureReport } from "@crewhaus/errors";');
    expect(c).toContain("const __report = toFailureReport(__err);");
    expect(c).toContain('formatRunFailure(__report, { prefix: "[graph]" })');
    expect(c).toContain("process.exit(__report.exitCode);");
  });
});

describe("emitGraph — when/parallel end-to-end fixture (Batch A)", () => {
  // The full shape a `when` + `parallel` spec lowers to: a review gate whose
  // equals-edge fans into a parallel group, an exists-edge continuation, and
  // an unconditional escalation fallback. Asserts the ONE emitted builder
  // chain carries every registration in engine-consumable order. The engine
  // half of this fixture (same shapes, real run) lives in
  // graph-engine/src/index.test.ts "when/parallel end-to-end".
  const e2eIr: IrGraphV0 = {
    version: 0,
    name: "review-fanout",
    target: "graph",
    entry: "review",
    nodes: [
      {
        name: "review",
        instructions: "Review the change",
        model: "claude-sonnet-4-6",
        tools: ["read"],
        toolConfigs: {},
      },
      {
        name: "fanA",
        instructions: "Run checks",
        model: "claude-sonnet-4-6",
        tools: [],
        toolConfigs: {},
      },
      {
        name: "fanB",
        instructions: "Run docs pass",
        model: "claude-sonnet-4-6",
        tools: [],
        toolConfigs: {},
      },
      {
        name: "publish",
        instructions: "Publish it",
        model: "claude-sonnet-4-6",
        tools: [],
        toolConfigs: {},
      },
      {
        name: "escalate",
        instructions: "Escalate to a human",
        model: "claude-sonnet-4-6",
        tools: [],
        toolConfigs: {},
      },
    ],
    edges: [
      { from: "review", to: "fanA", when: { key: "review", equals: "approve" } },
      { from: "review", to: "escalate" },
      { from: "fanB", to: "publish", when: { key: "fanA", exists: true } },
    ],
    parallel: [["fanA", "fanB"]],
    permissions: { rules: [] },
    compaction: {},
  };

  test("emits the full builder chain: nodes → conditional edges → parallel → entry", () => {
    const c = emitGraph(e2eIr, { readme: false }).files[0]?.content ?? "";
    const orderOf = (needle: string): number => {
      const idx = c.indexOf(needle);
      expect(idx).toBeGreaterThan(-1);
      return idx;
    };
    const nodes = ["review", "fanA", "fanB", "publish", "escalate"].map((n) =>
      orderOf(`.addNode("${n}",`),
    );
    const equalsEdge = orderOf(
      '.addEdge("review", "fanA", (__state) => (__state as Record<string, unknown>)["review"] === "approve")',
    );
    const fallbackEdge = orderOf('.addEdge("review", "escalate")');
    const existsEdge = orderOf(
      '.addEdge("fanB", "publish", (__state) => (__state as Record<string, unknown>)["fanA"] !== undefined)',
    );
    const parallel = orderOf('.addParallel(["fanA", "fanB"])');
    const entry = orderOf('.setEntry("review")');
    // Node registrations precede edges; edges keep spec order (the engine
    // takes the FIRST matching edge, so equals must beat the fallback);
    // parallel groups follow edges; entry closes the chain.
    expect(Math.max(...nodes)).toBeLessThan(equalsEdge);
    expect(equalsEdge).toBeLessThan(fallbackEdge);
    expect(fallbackEdge).toBeLessThan(existsEdge);
    expect(existsEdge).toBeLessThan(parallel);
    expect(parallel).toBeLessThan(entry);
    // The review node advertises its resolved tool.
    expect(c).toContain("tools: [read],");
    expect(c).toContain('import { read } from "@crewhaus/tool-fs";');
  });
});
