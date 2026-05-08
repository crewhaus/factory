import { describe, expect, test } from "bun:test";
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
  test("returns a single agent.ts file", () => {
    const bundle = emitGraph(baseIr);
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
});
