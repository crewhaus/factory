import { describe, expect, test } from "bun:test";
import { escapeJsonString } from "@crewhaus/infra-utils";
import type { IrGraphV0 } from "@crewhaus/ir";
import { HITL_REJECTION_DECISIONS, TargetEmitError, emitGraph, isHitlRejection } from "./index";

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

/**
 * The graph target rendered NO permission fields at all: IrGraphV0 carries
 * `permissions`, but nothing read it, so a spec's whole `permissions:` block
 * was silently discarded and every node ran on the runtime's defaults.
 */
describe("emitGraph — permissions threading (mode + rules)", () => {
  const permIr: IrGraphV0 = {
    ...baseIr,
    permissions: {
      mode: "plan",
      rules: [
        { type: "deny", pattern: "bash(rm *)" },
        { type: "allow", pattern: "read(*)" },
      ],
    },
  };

  test("permissionMode + permissionRules land in EVERY node's runChatLoop call", () => {
    const c = emitGraph(permIr).files[0]?.content ?? "";
    expect(c.split('permissionMode: "plan",').length - 1).toBe(3); // one per node
    expect(c.split("permissionRules: {").length - 1).toBe(3);
    expect(c).toContain('{ type: "deny", pattern: "bash(rm *)", source: "yaml" },');
    expect(c).toContain('{ type: "allow", pattern: "read(*)", source: "yaml" },');
    // Rules name the builtin layer, so the import rides along.
    expect(c).toContain('import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";');
    expect(c).toContain("builtin: BUILTIN_DEFAULT_RULES,");
  });

  test("mode alone emits no rules block and no permission-engine import", () => {
    const c =
      emitGraph({ ...baseIr, permissions: { mode: "auto", rules: [] } }).files[0]?.content ?? "";
    expect(c).toContain('permissionMode: "auto",');
    expect(c).not.toContain("permissionRules:");
    expect(c).not.toContain("@crewhaus/permission-engine");
  });

  test("a block-less spec emits neither field (only the G11 approval fields)", () => {
    const c = emitGraph(baseIr).files[0]?.content ?? "";
    expect(c).not.toContain("permissionMode:");
    expect(c).not.toContain("permissionRules:");
  });

  test("a malicious rule pattern stays an escaped string literal, never bare code", () => {
    const c =
      emitGraph({
        ...baseIr,
        permissions: { rules: [{ type: "deny", pattern: '"); process.exit(1); ("' }] },
      }).files[0]?.content ?? "";
    expect(c).toContain(`pattern: ${escapeJsonString('"); process.exit(1); ("')},`);
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(c)).not.toThrow();
  });
});

/**
 * Loop contract 0.4 (Batch C, G11) — a compiled bundle is non-interactive, so
 * an `ask` must PARK rather than collapse to a deny. runtime-core parks only
 * when BOTH `askMode: "pause"` and an `approvals` store reach runChatLoop; the
 * emitter passed neither, leaving `permissions.ask_mode` inert in every graph
 * bundle.
 */
describe("emitGraph — ask_mode + pending-approval store (G11)", () => {
  test("every node's runChatLoop carries askMode + approvals, and the store boots once", () => {
    const c = emitGraph(baseIr).files[0]?.content ?? "";
    expect(c).toContain(
      'import { createPendingApprovalStore, resolveSessionRootDir } from "@crewhaus/runtime-core";',
    );
    expect(c).toContain("const __approvalRoot = resolveSessionRootDir(undefined);");
    expect(c).toContain(
      "const __approvals = createPendingApprovalStore(\n  __approvalRoot !== undefined ? { rootDir: __approvalRoot } : {},\n);",
    );
    // Fixed at emit time — a bundle parses no --ask-mode.
    expect(c.split('askMode: "pause",').length - 1).toBe(3); // one per node
    expect(c.split('approvals: { store: __approvals, surface: "graph-node" },').length - 1).toBe(3);
  });

  test('ask_mode: deny emits askMode: "deny" — with the store still wired', () => {
    const c =
      emitGraph({ ...baseIr, permissions: { askMode: "deny", rules: [] } }).files[0]?.content ?? "";
    expect(c).toContain('askMode: "deny",');
    expect(c).not.toContain('askMode: "pause",');
    // Passed under "deny" too (it never parks there): runtime-core's diagnostic
    // branches on `approvals === undefined`, so withholding it would blame
    // absent plumbing for a deliberate operator choice.
    expect(c).toContain('approvals: { store: __approvals, surface: "graph-node" },');
  });

  test("the fields are unconditional — a spec with no permissions block still parks", () => {
    // The case where parking matters MOST: with no block every unmatched tool
    // resolves to `ask`.
    const c = emitGraph(baseIr).files[0]?.content ?? "";
    expect(baseIr.permissions).toEqual({ rules: [] });
    expect(c).toContain('askMode: "pause",');
    expect(c).toContain("approvals: { store: __approvals,");
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

describe("emitGraph — judge gate nodes (loop contract 0.4, G02)", () => {
  const judgeNode = (
    overrides: Partial<IrGraphV0["nodes"][number]["judge"]> = {},
  ): IrGraphV0["nodes"][number] => ({
    name: "gate",
    kind: "judge",
    instructions: "cites at least two sources",
    model: "claude-haiku-4-5",
    tools: [],
    toolConfigs: {},
    judge: {
      criteria: "cites at least two sources",
      threshold: 0.9,
      onFail: "retry_previous",
      maxRetries: 2,
      ...overrides,
    },
  });

  /** draft → gate(judge, retry_previous ≤2) → publish. */
  const RETRY_IR: IrGraphV0 = {
    version: 0,
    name: "judged",
    target: "graph",
    entry: "draft",
    nodes: [
      {
        name: "draft",
        instructions: "Write the report.",
        model: "claude-sonnet-4-6",
        tools: [],
        toolConfigs: {},
      },
      judgeNode(),
      {
        name: "publish",
        instructions: "Publish.",
        model: "claude-sonnet-4-6",
        tools: [],
        toolConfigs: {},
      },
    ],
    edges: [
      { from: "draft", to: "gate" },
      { from: "gate", to: "publish" },
    ],
    permissions: { rules: [] },
    compaction: {},
  };

  const withOnFail = (onFail: "retry_previous" | "halt" | "continue"): IrGraphV0 => ({
    ...RETRY_IR,
    nodes: RETRY_IR.nodes.map((n) => (n.name === "gate" ? judgeNode({ onFail }) : n)),
  });

  const parseTs = (code: string) =>
    new Bun.Transpiler({ loader: "ts" }).transformSync(code.replace(/^#!.*\n/, ""));

  test("judge bundles emit the judge machinery: imports and the __judgeGate scorer", () => {
    const c = emitGraph(RETRY_IR).files[0]?.content ?? "";
    expect(c).toContain(
      'import { EXIT_CODES, RunFailedError, formatRunFailure, toFailureReport } from "@crewhaus/errors";',
    );
    expect(c).toContain('import { judge } from "@crewhaus/eval-judge";');
    expect(c).toContain('import type { TraceEventBus } from "@crewhaus/trace-event-bus";');
    expect(c).toContain("async function __judgeGate(");
    // 0.6.0 — the helper takes the bus and reports the judge's wire model + cost.
    expect(c).toContain(
      "  bus: TraceEventBus;\n}): Promise<{ score: number; rationale: string; judgeModel: string; costUsdMicros?: number }> {",
    );
    expect(c).toContain("    bus: opts.bus,\n  });");
    expect(c).toContain("judgeModel: result.usage.model,");
    // createJudgeGrader's 1–5 → [0,1] mapping.
    expect(c).toContain("score: (result.score - 1) / 4");
    // Resilient classified exit: EXIT_CODES.evaluation with the 35 fallback.
    expect(c).toContain(
      'const __EVAL_EXIT: number = (EXIT_CODES as Record<string, number>)["evaluation"] ?? 35;',
    );
  });

  test("the judge node scores the gated upstream output and publishes judge_verdict", () => {
    const c = emitGraph(RETRY_IR).files[0]?.content ?? "";
    // Emit-time task map keyed by the gated node's name.
    expect(c).toContain(
      'const __tasks: Record<string, string> = { "draft": "Write the report." };',
    );
    expect(c).toContain(
      'throw new Error("judge node \\"gate\\" found no upstream output to gate (expected output from: draft)");',
    );
    expect(c).toContain('criteria: "cites at least two sources",');
    // The judge model is the node's resolved model slot, not the graph model.
    expect(c).toContain('model: "claude-haiku-4-5",');
    expect(c).toContain("const __pass = __result.score >= 0.9;");
    // 0.6.0 §6.2 — the gate hands the node's run bus to the judge (role
    // "judge" on the bus, priced + budget-metered).
    expect(c).toContain("bus: ctx.runContext.eventBus,");
    // One judge_verdict per scoring pass, on the run's bus.
    expect(c).toContain("const __bus = ctx.runContext.eventBus;");
    expect(c).toContain('kind: "judge_verdict",');
    expect(c).toContain('stepOrNode: "gate",');
    expect(c).toContain('verdict: __pass ? "pass" : "fail",');
    expect(c).toContain(
      "...(__result.rationale.length > 0 ? { rationale: __result.rationale } : {}),",
    );
    expect(c).toContain("judgeModel: __result.judgeModel,");
    expect(c).toContain(
      "...(__result.costUsdMicros !== undefined ? { costUsdMicros: __result.costUsdMicros } : {}),",
    );
    // Diagnostics ride the bundle's stderr stream like the [graph] events.
    expect(c).toContain('"[judge gate] "');
    expect(c).toContain('" threshold=0.9\\n"');
    // The judge never runs an agent turn of its own.
    const judgeBody = c.slice(c.indexOf('.addNode("gate"'), c.indexOf('.addNode("publish"'));
    expect(judgeBody).not.toContain("runChatLoop(");
  });

  test("the verdict is recorded under the judge's name (when-predicate friendly) plus a _judge record", () => {
    const c = emitGraph(RETRY_IR).files[0]?.content ?? "";
    expect(c).toContain('["gate"]: __pass ? "pass" : "fail",');
    expect(c).toContain(
      '["gate" + "_judge"]: { verdict: __pass ? "pass" : "fail", score: __result.score, rationale: __result.rationale, retries: __pass ? __retries : __retries + 1 },',
    );
  });

  test("retry_previous: pass-gated outgoing edge + synthesized back-edge through the engine", () => {
    const c = emitGraph(RETRY_IR).files[0]?.content ?? "";
    // The declared edge out of the judge only fires on "pass".
    expect(c).toContain(
      '.addEdge("gate", "publish", (__state) => (__state as Record<string, unknown>)["gate"] === "pass")',
    );
    // The synthesized back-edge fires on "fail" (retries always remain —
    // exhaustion throws inside the judge body).
    expect(c).toContain(
      '.addEdge("gate", "draft", (__state) => (__state as Record<string, unknown>)["gate"] === "fail")',
    );
    // Back-edges append AFTER the declared edges.
    expect(c.indexOf('.addEdge("gate", "publish"')).toBeLessThan(
      c.indexOf('.addEdge("gate", "draft"'),
    );
    // Retry counting lives in the checkpointed state; exhaustion throws.
    expect(c).toContain('const __rec = __state["gate" + "_judge"]');
    expect(c).toContain("if (!__pass && __retries >= 2) {");
    expect(c).toContain('title: "judge gate failed after retries",');
    expect(c).toContain('class: "evaluation" as const,');
    expect(c).toContain("exitCode: __EVAL_EXIT,");
    expect(c).toContain('kind: "run_failed"');
    expect(c).toContain("throw new RunFailedError(__report);");
    expect(c).toContain('"[judge gate] retry "');
  });

  test("the retry target's body appends the failing judge's rationale as a nudge", () => {
    const c = emitGraph(RETRY_IR).files[0]?.content ?? "";
    const draftBody = c.slice(c.indexOf('.addNode("draft"'), c.indexOf('.addNode("gate"'));
    expect(draftBody).toContain('for (const __j of ["gate"]) {');
    expect(draftBody).toContain('if (__judgeState[__j] !== "fail") continue;');
    expect(draftBody).toContain('__rec = __judgeState[__j + "_judge"]');
    expect(draftBody).toContain("[judge feedback — the previous attempt failed the ");
    expect(draftBody).toContain('instructions: "Write the report." + __nudge,');
    // Nodes that no judge retries keep the plain instructions field.
    const publishBody = c.slice(c.indexOf('.addNode("publish"'), c.indexOf(".addEdge("));
    expect(publishBody).toContain('instructions: "Publish.",');
    expect(publishBody).not.toContain("__nudge");
  });

  test("halt: immediate classified throw, pass-gated outgoing edge, NO back-edge", () => {
    const c = emitGraph(withOnFail("halt")).files[0]?.content ?? "";
    expect(c).toContain('title: "judge gate failed",');
    expect(c).toContain("throw new RunFailedError(__report);");
    expect(c).toContain(
      '.addEdge("gate", "publish", (__state) => (__state as Record<string, unknown>)["gate"] === "pass")',
    );
    expect(c).not.toContain('.addEdge("gate", "draft"');
    expect(c).not.toContain("__retries");
    expect(c).not.toContain("retry back-edge");
  });

  test("continue: verdict recorded, edges stay as declared, no throw machinery", () => {
    const c = emitGraph(withOnFail("continue")).files[0]?.content ?? "";
    expect(c).toContain('.addEdge("gate", "publish")');
    expect(c).not.toContain('=== "pass"');
    expect(c).not.toContain('.addEdge("gate", "draft"');
    expect(c).toContain("on_fail=continue — proceeding with the flagged output");
    // Continue-only bundles carry no throw machinery: errors import stays
    // the pre-judge shape and __EVAL_EXIT is not emitted.
    expect(c).toContain('import { formatRunFailure, toFailureReport } from "@crewhaus/errors";');
    expect(c).not.toContain("throw new RunFailedError");
    expect(c).not.toContain("__EVAL_EXIT");
    expect(c).toContain('kind: "judge_verdict",');
  });

  test("an author when on a judge's outgoing edge AND-composes with the pass gate", () => {
    const ir: IrGraphV0 = {
      ...RETRY_IR,
      edges: [
        { from: "draft", to: "gate" },
        { from: "gate", to: "publish", when: { key: "draft", exists: true } },
      ],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain(
      '.addEdge("gate", "publish", (__state) => (__state as Record<string, unknown>)["gate"] === "pass" && (__state as Record<string, unknown>)["draft"] !== undefined)',
    );
  });

  test("author when predicates can read the judge's recorded verdict", () => {
    const ir: IrGraphV0 = {
      ...withOnFail("continue"),
      edges: [
        { from: "draft", to: "gate" },
        { from: "gate", to: "publish", when: { key: "gate", equals: "pass" } },
      ],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain(
      '.addEdge("gate", "publish", (__state) => (__state as Record<string, unknown>)["gate"] === "pass")',
    );
  });

  test("a judge chained behind another judge gates the original producing node (transitive)", () => {
    const ir: IrGraphV0 = {
      ...RETRY_IR,
      nodes: [
        ...RETRY_IR.nodes,
        {
          ...judgeNode({ maxRetries: 1 }),
          name: "tone",
          instructions: "professional tone",
          judge: {
            criteria: "professional tone",
            threshold: 0.7,
            onFail: "retry_previous",
            maxRetries: 1,
          },
        },
      ],
      edges: [
        { from: "draft", to: "gate" },
        { from: "gate", to: "tone" },
        { from: "tone", to: "publish" },
      ],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    // tone's task map resolves through the gate judge to draft.
    const toneBody = c.slice(c.indexOf('.addNode("tone"'), c.indexOf(".addEdge("));
    expect(toneBody).toContain('{ "draft": "Write the report." }');
    // And its back-edge loops all the way to draft (the whole gate chain
    // re-validates on the way back down).
    expect(c).toContain(
      '.addEdge("tone", "draft", (__state) => (__state as Record<string, unknown>)["tone"] === "fail")',
    );
    // draft carries nudge handling for BOTH judges.
    expect(c).toContain('for (const __j of ["gate", "tone"]) {');
  });

  test("halt judges may gate several upstreams (labelled concatenation at runtime)", () => {
    const ir: IrGraphV0 = {
      ...withOnFail("halt"),
      nodes: [
        ...withOnFail("halt").nodes,
        {
          name: "tech",
          instructions: "Handle technical.",
          model: "claude-sonnet-4-6",
          tools: [],
          toolConfigs: {},
        },
      ],
      edges: [
        { from: "draft", to: "gate" },
        { from: "tech", to: "gate" },
        { from: "gate", to: "publish" },
      ],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain(
      'const __tasks: Record<string, string> = { "draft": "Write the report.", "tech": "Handle technical." };',
    );
    expect(c).toContain(
      '__present.map((n) => "## " + n + "\\n" + String(__state[n])).join("\\n\\n")',
    );
    expect(c).toContain("(expected output from: draft, tech)");
  });

  test("retry_previous with several gated upstreams is rejected at emit time", () => {
    const ir: IrGraphV0 = {
      ...RETRY_IR,
      nodes: [
        ...RETRY_IR.nodes,
        {
          name: "tech",
          instructions: "Handle technical.",
          model: "m",
          tools: [],
          toolConfigs: {},
        },
      ],
      edges: [
        { from: "draft", to: "gate" },
        { from: "tech", to: "gate" },
        { from: "gate", to: "publish" },
      ],
    };
    expect(() => emitGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitGraph(ir)).toThrow(
      /retry_previous but gates 2 upstream nodes \(draft, tech\)/,
    );
  });

  test("a judge with no upstream producing node is rejected at emit time", () => {
    const ir: IrGraphV0 = {
      ...RETRY_IR,
      edges: [{ from: "gate", to: "publish" }],
    };
    expect(() => emitGraph(ir)).toThrow(/no non-judge upstream node to gate/);
  });

  test("a judge entry node is rejected at emit time (parseSpec mirror)", () => {
    const ir: IrGraphV0 = { ...RETRY_IR, entry: "gate" };
    expect(() => emitGraph(ir)).toThrow(/entry node "gate" cannot be a judge/);
  });

  test("kind: judge without a judge block renders as a regular node (direct-IR guard)", () => {
    const ir: IrGraphV0 = {
      ...RETRY_IR,
      nodes: RETRY_IR.nodes.map((n) =>
        n.name === "gate" ? { ...n, judge: undefined } : n,
      ) as IrGraphV0["nodes"],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).not.toContain("__judgeGate");
    // It falls back to an ordinary LLM node over its instructions.
    expect(c).toContain('instructions: "cites at least two sources",');
  });

  test("tricky names/criteria stay JSON-escaped in every executable string", () => {
    const name = 'ga"te`${x}';
    const ir: IrGraphV0 = {
      ...RETRY_IR,
      nodes: RETRY_IR.nodes.map((n) =>
        n.name === "gate"
          ? {
              ...n,
              name,
              judge: {
                criteria: 'must "quote" ${sources}',
                threshold: 0.7,
                onFail: "retry_previous" as const,
                maxRetries: 1,
              },
            }
          : n,
      ) as IrGraphV0["nodes"],
      edges: [
        { from: "draft", to: name },
        { from: name, to: "publish" },
      ],
    };
    const c = emitGraph(ir).files[0]?.content ?? "";
    expect(c).toContain('criteria: "must \\"quote\\" ${sources}",');
    expect(c).toContain('stepOrNode: "ga\\"te`${x}",');
    expect(() => parseTs(c)).not.toThrow();
  });

  test("judge bundles are syntactically valid TypeScript (retry/halt/continue, with when+parallel+hitl)", () => {
    for (const onFail of ["retry_previous", "halt", "continue"] as const) {
      const base = withOnFail(onFail);
      const ir: IrGraphV0 = {
        ...base,
        nodes: base.nodes.map((n) =>
          n.name === "publish" ? { ...n, hitlPrompt: "publish it?" } : n,
        ) as IrGraphV0["nodes"],
        edges: [
          { from: "draft", to: "gate", when: { key: "draft", exists: true } },
          { from: "gate", to: "publish" },
        ],
        limits: { deadlineMs: 60000 },
        hooks: [{ event: "stop", command: "./notify.sh" }],
        budget: { usdMicros: 1_000_000, onExceed: { kind: "stop" } },
      };
      const c = emitGraph(ir).files[0]?.content ?? "";
      expect(() => parseTs(c)).not.toThrow();
    }
  });

  test("judge-free graphs carry NO judge machinery (byte-stability)", () => {
    const c = emitGraph(baseIr).files[0]?.content ?? "";
    for (const s of [
      "__judgeGate",
      "__EVAL_EXIT",
      "eval-judge",
      "judge_verdict",
      "throw new RunFailedError", // the catch-wrapper COMMENT may name the class
      "EXIT_CODES",
      "__nudge",
      "retry back-edge",
      "_judge",
    ]) {
      expect(c).not.toContain(s);
    }
    expect(c).toContain('import { formatRunFailure, toFailureReport } from "@crewhaus/errors";');
  });
});

describe("emitGraph — durable exactly-once node wrapping (Batch F, G61)", () => {
  test("acyclic (DAG) nodes are wrapped in __durableNode; plumbing is emitted", () => {
    const code = emitGraph(baseIr).files[0]?.content ?? "";
    expect(code).toContain('import { createGraph, type NodeFn } from "@crewhaus/graph-engine";');
    expect(code).toContain(
      'import { createIdempotencyStore, withIdempotency } from "@crewhaus/durable-execution";',
    );
    expect(code).toContain('const __idempotencyStore = createIdempotencyStore("hello-graph");');
    expect(code).toContain(
      "function __durableNode(name: string, fn: NodeFn<unknown>): NodeFn<unknown>",
    );
    // All three linear nodes are wrapped.
    expect(code).toContain('.addNode("plan", __durableNode("plan",');
    expect(code).toContain('.addNode("execute", __durableNode("execute",');
    expect(code).toContain('.addNode("summarise", __durableNode("summarise",');
  });

  test("a judge-retry loop leaves the gated node UNWRAPPED (re-runs by design)", () => {
    const withJudge: IrGraphV0 = {
      ...baseIr,
      nodes: [
        ...baseIr.nodes,
        {
          name: "gate",
          instructions: "",
          model: "claude-sonnet-4-6",
          tools: [],
          toolConfigs: {},
          kind: "judge",
          judge: {
            graderType: "llm_judge",
            criteria: "is the summary good?",
            threshold: 0.8,
            model: "claude-sonnet-4-6",
            onFail: "retry_previous",
            maxRetries: 2,
          },
        },
      ],
      edges: [
        { from: "plan", to: "execute" },
        { from: "execute", to: "summarise" },
        { from: "summarise", to: "gate" },
      ],
    };
    const code = emitGraph(withJudge).files[0]?.content ?? "";
    // summarise is the gated node (judge retries back to it) → NOT wrapped.
    expect(code).toContain('.addNode("summarise", async (ctx, prev)');
    expect(code).not.toContain('.addNode("summarise", __durableNode');
    // plan/execute are still acyclic → wrapped.
    expect(code).toContain('.addNode("plan", __durableNode("plan",');
    // judge node itself is never wrapped.
    expect(code).not.toContain('.addNode("gate", __durableNode');
  });

  test("an author `when` cycle leaves both cyclic nodes unwrapped", () => {
    const cyclic: IrGraphV0 = {
      ...baseIr,
      entry: "a",
      nodes: [
        { name: "a", instructions: "a", model: "m", tools: [], toolConfigs: {} },
        { name: "b", instructions: "b", model: "m", tools: [], toolConfigs: {} },
        { name: "done", instructions: "done", model: "m", tools: [], toolConfigs: {} },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a", when: { key: "b", equals: "again" } },
        { from: "b", to: "done" },
      ],
    };
    const code = emitGraph(cyclic).files[0]?.content ?? "";
    // a and b are on the cycle → unwrapped; only `done` is wrapped.
    expect(code).not.toContain('.addNode("a", __durableNode');
    expect(code).not.toContain('.addNode("b", __durableNode');
    expect(code).toContain('.addNode("done", __durableNode("done",');
  });
});

describe("emitGraph — emitted durable bundle is syntactically valid TS", () => {
  test("Bun.Transpiler parses the wrapped graph agent.ts", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    const code = emitGraph(baseIr, { readme: false }).files[0]?.content ?? "";
    expect(() => t.transformSync(code)).not.toThrow();
  });
});

/**
 * Audit factory #4 — the HITL gate is a PRE-condition. It used to be emitted
 * AFTER the gated node's runChatLoop call, which (a) showed the approver a
 * prompt but never the work, (b) threw the node's reply away (the engine
 * checkpoints the PRE-node state on a pause) and (c) re-ran — and re-paid
 * for — the same model call on resume.
 */
describe("emitGraph — hitl gate is a pre-condition (audit factory #4)", () => {
  const bodyOf = (code: string, node: string): string => {
    const start = code.indexOf(`.addNode(${JSON.stringify(node)}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = code.slice(start + 1);
    const nextNode = rest.indexOf("  .addNode(");
    const firstEdge = rest.indexOf("  .addEdge(");
    const ends = [nextNode, firstEdge].filter((i) => i >= 0);
    return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
  };

  test("requestApproval is awaited BEFORE the gated node's runChatLoop call", () => {
    const body = bodyOf(emitGraph(baseIr).files[0]?.content ?? "", "execute");
    const ask = body.indexOf("ctx.requestApproval");
    const turn = body.indexOf("await runChatLoop(");
    expect(ask).toBeGreaterThanOrEqual(0);
    expect(turn).toBeGreaterThanOrEqual(0);
    expect(ask).toBeLessThan(turn);
  });

  test("a rejecting decision returns before the model turn", () => {
    const body = bodyOf(emitGraph(baseIr).files[0]?.content ?? "", "execute");
    const guard = body.indexOf("if (__hitlRejected(__decision))");
    const turn = body.indexOf("await runChatLoop(");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(turn);
    // A cancelled node records ONLY its decision — no output key, which is
    // what lets `when: { key: execute, exists: true }` route a rejection.
    const rejectBranch = body.slice(guard, body.indexOf("const __seed"));
    expect(rejectBranch).toContain('__rejected["execute" + "_decision"] = __decision;');
    expect(rejectBranch).not.toContain('["execute"]: __reply');
    expect(rejectBranch).toContain("return __rejected;");
  });

  test("the approved path still records <node>_decision alongside the output", () => {
    const body = bodyOf(emitGraph(baseIr).files[0]?.content ?? "", "execute");
    expect(body).toContain('const __next = { ...prev, ["execute"]: __reply };');
    expect(body).toContain('__next["execute" + "_decision"] = __decision;');
  });

  test("the rejection early-return uses a computed key, not a bare identifier (CWE-94)", () => {
    const name = 'x"] = 1; globalThis.__HITL_PWNED__ = 1; const __z = { ["y';
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
    const code = emitGraph(ir).files[0]?.content ?? "";
    expect(code).toContain(`__rejected[${escapeJsonString(name)} + "_decision"]`);
    expect(code).not.toContain('globalThis.__HITL_PWNED__ = 1; const __z = { ["y"');
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(code)).not.toThrow();
  });

  test("isHitlRejection cancels only rejecting decisions; free text approves", () => {
    for (const yes of ["reject", "REJECT", " no ", "deny", "declined", "abort", "cancel", "veto"]) {
      expect(isHitlRejection(yes)).toBe(true);
    }
    // Free-text notes must reach the state rather than silently skip the work.
    for (const no of ["approve", "yes", "ok", "approve, but keep it short", ""]) {
      expect(isHitlRejection(no)).toBe(false);
    }
  });

  test("the emitted __hitlRejected helper carries that same vocabulary", () => {
    const code = emitGraph(baseIr).files[0]?.content ?? "";
    expect(code).toContain(
      `const __HITL_REJECTIONS: ReadonlySet<string> = new Set(${JSON.stringify(HITL_REJECTION_DECISIONS)});`,
    );
    expect(code).toContain("return __HITL_REJECTIONS.has(decision.trim().toLowerCase());");
  });

  test("gate-free graphs carry NO hitl machinery (byte-stability)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: baseIr.nodes.map((n) => {
        const { hitlPrompt: _drop, ...rest } = n;
        return rest;
      }) as IrGraphV0["nodes"],
    };
    const code = emitGraph(ir).files[0]?.content ?? "";
    for (const s of [
      "__hitlRejected",
      "__HITL_REJECTIONS",
      "ctx.requestApproval",
      "__rejected",
      '"_decision"',
    ]) {
      expect(code).not.toContain(s);
    }
  });

  test("the pause report prints the state the approver is deciding on", () => {
    const code = emitGraph(baseIr).files[0]?.content ?? "";
    expect(code).toContain("state under review");
    expect(code).toContain("JSON.stringify(paused.state, null, 2)");
    // …fed from the engine's hitl_pause event, not re-read from the store.
    expect(code).toContain("prompt: ev.prompt, state: ev.state");
  });
});

describe("emitGraph — per-node model routing (0.6.0 §7.7)", () => {
  const routed = (extra: Partial<IrGraphV0["nodes"][number]>): IrGraphV0 => {
    const [plan, execute, summarise] = baseIr.nodes;
    if (plan === undefined || execute === undefined || summarise === undefined) {
      throw new Error("baseIr is missing nodes");
    }
    return { ...baseIr, nodes: [{ ...plan, ...extra }, execute, summarise] };
  };

  test("a node's modelPool lands on THAT node's runChatLoop call only (mirrors the workflow step)", () => {
    const c =
      emitGraph(
        routed({
          modelPool: {
            candidates: [
              { model: "claude-haiku-4-5", tags: ["cheap"] },
              { model: "claude-opus-4-8", tags: ["strong"] },
            ],
            policy: "heuristic",
          },
        }),
      ).files[0]?.content ?? "";
    // 0.6.0 PR 9a — the pooled node's blob carries `scope: <node name>` when
    // the spec pinned none (the runtime twin of the crew orchestrator's
    // `scopeRolePool`); a declared scope rides verbatim instead.
    expect(c).toContain(
      'modelPool: {"candidates":[{"model":"claude-haiku-4-5","tags":["cheap"]},{"model":"claude-opus-4-8","tags":["strong"]}],"policy":"heuristic","scope":"plan"},',
    );
    expect((c.match(/modelPool:/g) ?? []).length).toBe(1);
    const declared =
      emitGraph(
        routed({
          modelPool: {
            candidates: [{ model: "claude-haiku-4-5", tags: ["cheap"] }],
            policy: "static",
            scope: "planner-arms",
          },
        }),
      ).files[0]?.content ?? "";
    expect(declared).toContain('"policy":"static","scope":"planner-arms"},');
    expect(declared).not.toContain('"scope":"plan"');
  });

  test("0.6.0 PR 9a — a node-level temperature renders beside the node loop fields", () => {
    const c = emitGraph(routed({ temperature: 0.1 })).files[0]?.content ?? "";
    expect(c).toContain("\n        temperature: 0.1,");
    expect((c.match(/temperature:/g) ?? []).length).toBe(1);
  });

  test("model_fallbacks + circuit_breaker and model_tiers emit onto the node call", () => {
    const c =
      emitGraph(
        routed({
          modelFallbacks: ["openai/gpt-4o-mini"],
          circuitBreaker: { failureThreshold: 2 },
        }),
      ).files[0]?.content ?? "";
    expect(c).toContain('modelFallbacks: ["openai/gpt-4o-mini"],');
    expect(c).toContain('circuitBreaker: {"failureThreshold":2},');
    const t =
      emitGraph(routed({ modelTiers: { fast: "claude-haiku-4-5", default: "claude-sonnet-4-6" } }))
        .files[0]?.content ?? "";
    expect(t).toContain('modelTiers: {"fast":"claude-haiku-4-5","default":"claude-sonnet-4-6"},');
  });

  test("a node without routing stays byte-identical", () => {
    const c = emitGraph(baseIr).files[0]?.content ?? "";
    for (const field of ["modelPool:", "modelTiers:", "modelFallbacks:", "circuitBreaker:"]) {
      expect(c).not.toContain(field);
    }
  });
});

describe("0.6.0 PR 9d — side-call strategies on a node", () => {
  const routed = (extra: Partial<IrGraphV0["nodes"][number]>): IrGraphV0 => {
    const [plan, execute, summarise] = baseIr.nodes;
    if (plan === undefined || execute === undefined || summarise === undefined) {
      throw new Error("baseIr is missing nodes");
    }
    return { ...baseIr, nodes: [{ ...plan, ...extra }, execute, summarise] };
  };
  const GUIDED = {
    candidates: [
      { model: "claude-haiku-4-5", tags: ["cheap"] },
      { model: "claude-opus-4-8", tags: ["strong"] },
    ],
    policy: "heuristic" as const,
    strategy: { guide: { model: "claude-opus-4-8", every: "first_turn" as const } },
  };

  test("a node whose pool declares a guide renders the wireSideCalls spread on THAT node and imports the root once", () => {
    const c = emitGraph(routed({ modelPool: GUIDED })).files[0]?.content ?? "";
    expect(c).toContain('import { wireSideCalls } from "@crewhaus/model-service";');
    const pool = JSON.stringify({ ...GUIDED, scope: "plan" });
    expect(c).toContain(
      `\n        modelPool: ${pool},\n        ...wireSideCalls(${pool}, { sessionName: "plan" }),\n`,
    );
    expect((c.match(/wireSideCalls\(/g) ?? []).length).toBe(1);
  });

  test("byte-identity: a pooled node without a side-call strategy renders neither the spread nor the import", () => {
    const c =
      emitGraph(routed({ modelPool: { ...GUIDED, strategy: undefined } })).files[0]?.content ?? "";
    expect(c).not.toContain("wireSideCalls");
    expect(c).not.toContain("@crewhaus/model-service");
  });
});
