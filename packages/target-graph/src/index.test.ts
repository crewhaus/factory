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
