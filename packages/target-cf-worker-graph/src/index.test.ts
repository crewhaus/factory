import { describe, expect, test } from "bun:test";
import type { IrGraphNode, IrGraphV0 } from "@crewhaus/ir";
import { TargetEmitError, emitCfWorkerGraph } from "./index";

const node = (name: string, instructions: string): IrGraphNode => ({
  name,
  instructions,
  model: "claude-haiku-4-5-20251001",
  tools: [],
  toolConfigs: Object.freeze({}),
});

// entry -> execute -> summarise : a single linear path.
const baseIr: IrGraphV0 = {
  version: 0,
  name: "hello-graph",
  target: "graph",
  entry: "plan",
  nodes: [
    node("plan", "Plan the work."),
    node("execute", "Execute the plan."),
    node("summarise", "Summarise the result."),
  ],
  edges: [
    { from: "plan", to: "execute" },
    { from: "execute", to: "summarise" },
  ],
  permissions: { rules: [] },
  compaction: {},
};

const parseJs = (code: string) => new Bun.Transpiler({ loader: "js" }).transformSync(code);

describe("emitCfWorkerGraph", () => {
  test("emits worker.js, wrangler.toml, and package.json", () => {
    const bundle = emitCfWorkerGraph(baseIr);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(["package.json", "worker.js", "wrangler.toml"]);
  });

  test("worker.js inlines every node's model + instructions and the Anthropic endpoint", () => {
    const bundle = emitCfWorkerGraph(baseIr);
    const worker = bundle.files.find((f) => f.path === "worker.js")?.content ?? "";
    expect(worker).toContain("claude-haiku-4-5-20251001");
    expect(worker).toContain("Plan the work.");
    expect(worker).toContain("Execute the plan.");
    expect(worker).toContain("Summarise the result.");
    expect(worker).toContain("api.anthropic.com");
    // Speaks the same /chat SSE protocol the PWA expects.
    expect(worker).toContain("/chat");
    expect(worker).toContain("/health");
    expect(worker).toContain('"done"');
  });

  test("nodes are baked in linear execution order, not declaration order", () => {
    // Declared out of order; edges still form plan -> execute -> summarise.
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("summarise", "S"), node("plan", "P"), node("execute", "E")],
    };
    const worker = emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content ?? "";
    const iPlan = worker.indexOf('name: "plan"');
    const iExec = worker.indexOf('name: "execute"');
    const iSumm = worker.indexOf('name: "summarise"');
    expect(iPlan).toBeGreaterThanOrEqual(0);
    expect(iPlan).toBeLessThan(iExec);
    expect(iExec).toBeLessThan(iSumm);
  });

  test("wrangler.toml uses sanitized spec name", () => {
    const ir: IrGraphV0 = { ...baseIr, name: "Hello World!" };
    const wrangler =
      emitCfWorkerGraph(ir).files.find((f) => f.path === "wrangler.toml")?.content ?? "";
    expect(wrangler).toContain('name = "hello-world-"');
  });

  test("worker.js escapes special characters in instructions", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [
        { ...node("plan", 'Respond with "quoted" text\nand newlines.') },
        node("execute", "ok"),
      ],
      edges: [{ from: "plan", to: "execute" }],
    };
    const worker = emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content ?? "";
    expect(worker).toContain('\\"quoted\\"');
    expect(worker).toContain("\\n");
  });

  test("rejects non-graph IR variants", () => {
    const wrong = { ...baseIr, target: "cli" } as unknown as IrGraphV0;
    expect(() => emitCfWorkerGraph(wrong)).toThrow(TargetEmitError);
  });

  test("rejects a branching graph (node with 2 outgoing edges)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      edges: [
        { from: "plan", to: "execute" },
        { from: "plan", to: "summarise" },
      ],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/linear single-path/);
  });

  test("rejects a node with hitlPrompt set", () => {
    const planNode = baseIr.nodes[0];
    if (planNode === undefined) throw new Error("baseIr is missing the plan node");
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [{ ...planNode, hitlPrompt: "approve?" }, node("execute", "E")],
      edges: [{ from: "plan", to: "execute" }],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/HITL/);
  });

  test("rejects nodes that declare tools", () => {
    const planNode = baseIr.nodes[0];
    if (planNode === undefined) throw new Error("baseIr is missing the plan node");
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [{ ...planNode, tools: ["read", "write"] }, node("execute", "E")],
      edges: [{ from: "plan", to: "execute" }],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/tools/);
  });

  test("rejects an entry that doesn't reference a declared node", () => {
    const ir: IrGraphV0 = { ...baseIr, entry: "missing" };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/entry node "missing"/);
  });

  test("rejects an edge that references an unknown from-node", () => {
    const ir: IrGraphV0 = { ...baseIr, edges: [{ from: "ghost", to: "plan" }] };
    expect(() => emitCfWorkerGraph(ir)).toThrow(/unknown node "ghost"/);
  });

  test("rejects an edge that references an unknown to-node", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("plan", "P")],
      edges: [{ from: "plan", to: "ghost" }],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(/unknown node "ghost"/);
  });

  test("rejects unreachable nodes (node not on the path from entry)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("plan", "P"), node("execute", "E"), node("orphan", "O")],
      edges: [{ from: "plan", to: "execute" }],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/unreachable nodes: orphan/);
  });

  test("rejects a cycle", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [node("plan", "P"), node("execute", "E")],
      edges: [
        { from: "plan", to: "execute" },
        { from: "execute", to: "plan" },
      ],
    };
    expect(() => emitCfWorkerGraph(ir)).toThrow(TargetEmitError);
    expect(() => emitCfWorkerGraph(ir)).toThrow(/cycle detected/);
  });

  test("accepts a single-node graph with no edges", () => {
    const ir: IrGraphV0 = { ...baseIr, nodes: [node("plan", "P")], edges: [] };
    const worker = emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content ?? "";
    expect(worker).toContain('name: "plan"');
    expect(() => parseJs(worker)).not.toThrow();
  });

  // Regression guard: the emitter must never wrap escapeJsonString output in
  // extra quotes (`name: ""hello-graph""`), which Cloudflare rejects at upload
  // with a syntax error. Substring assertions miss it, so parse the whole
  // module instead.
  test("worker.js is syntactically valid JavaScript", () => {
    const worker = emitCfWorkerGraph(baseIr).files.find((f) => f.path === "worker.js")?.content;
    expect(() => parseJs(worker ?? "")).not.toThrow();
  });

  test("worker.js stays valid with tricky node instructions (quotes/newline/$/backtick)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      name: "tricky-graph",
      nodes: [
        node("plan", 'Quotes "here", a newline\nhere, a ${dollar} and a ` backtick.'),
        node("execute", "Plain second node."),
      ],
      edges: [{ from: "plan", to: "execute" }],
    };
    const worker = emitCfWorkerGraph(ir).files.find((f) => f.path === "worker.js")?.content;
    expect(() => parseJs(worker ?? "")).not.toThrow();
  });
});
