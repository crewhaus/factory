/**
 * Track F (§57) — wellformedness check tests. Source: AgentFlow
 * (arxiv 2604.20801).
 */
import { describe, expect, test } from "bun:test";
import type { IrCrewV0, IrGraphV0 } from "@crewhaus/ir";
import { IrPassError, wellFormednessCheck } from "./index";

const baseGraph: IrGraphV0 = {
  version: 0,
  name: "test-graph",
  target: "graph",
  entry: "a",
  nodes: [
    { name: "a", instructions: "node a", model: "m", tools: [], toolConfigs: {} },
    { name: "b", instructions: "node b", model: "m", tools: [], toolConfigs: {} },
  ],
  edges: [{ from: "a", to: "b" }],
  permissions: { rules: [] },
  compaction: {},
};

describe("Track F — wellFormednessCheck (graph)", () => {
  test("accepts a well-formed graph", () => {
    expect(() => wellFormednessCheck(baseGraph)).not.toThrow();
  });

  test("rejects edge referencing undeclared node", () => {
    const bad: IrGraphV0 = {
      ...baseGraph,
      edges: [{ from: "a", to: "ghost" }],
    };
    expect(() => wellFormednessCheck(bad)).toThrow(IrPassError);
  });

  test("rejects unreachable node", () => {
    const bad: IrGraphV0 = {
      ...baseGraph,
      nodes: [
        ...baseGraph.nodes,
        { name: "orphan", instructions: "x", model: "m", tools: [], toolConfigs: {} },
      ],
    };
    expect(() => wellFormednessCheck(bad)).toThrow(IrPassError);
  });

  test("rejects entry that's not a declared node", () => {
    const bad: IrGraphV0 = { ...baseGraph, entry: "missing" };
    expect(() => wellFormednessCheck(bad)).toThrow(IrPassError);
  });

  test("rejects edge schema that references undeclared schema", () => {
    const bad: IrGraphV0 = {
      ...baseGraph,
      edges: [{ from: "a", to: "b", schema: { kind: "named", name: "ghost-schema" } }],
    };
    expect(() => wellFormednessCheck(bad)).toThrow(IrPassError);
  });

  test("accepts edge with untyped schema", () => {
    const g: IrGraphV0 = {
      ...baseGraph,
      edges: [{ from: "a", to: "b", schema: { kind: "untyped" } }],
    };
    expect(() => wellFormednessCheck(g)).not.toThrow();
  });

  test("accepts edge with declared named schema", () => {
    const g: IrGraphV0 = {
      ...baseGraph,
      messageSchemas: [{ name: "decision", schema: { type: "object" } }],
      edges: [{ from: "a", to: "b", schema: { kind: "named", name: "decision" } }],
    };
    expect(() => wellFormednessCheck(g)).not.toThrow();
  });
});

const baseCrew: IrCrewV0 = {
  version: 0,
  name: "test-crew",
  target: "crew",
  entry: "alpha",
  roles: [
    { name: "alpha", model: "m", instructions: "a", tools: [], toolConfigs: {}, subAgents: [] },
    { name: "beta", model: "m", instructions: "b", tools: [], toolConfigs: {}, subAgents: [] },
  ],
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
};

describe("Track F — wellFormednessCheck (crew)", () => {
  test("accepts a well-formed crew", () => {
    expect(() => wellFormednessCheck(baseCrew)).not.toThrow();
  });

  test("rejects routing.match to undeclared role", () => {
    const bad: IrCrewV0 = {
      ...baseCrew,
      routing: {
        kind: "match",
        match: { alpha: [{ contains: "x", to: "ghost" }] },
      },
    };
    expect(() => wellFormednessCheck(bad)).toThrow(IrPassError);
  });

  test("rejects duplicate messageSchemas", () => {
    const bad: IrCrewV0 = {
      ...baseCrew,
      messageSchemas: [
        { name: "dup", schema: { type: "object" } },
        { name: "dup", schema: { type: "object" } },
      ],
    };
    expect(() => wellFormednessCheck(bad)).toThrow(IrPassError);
  });
});
