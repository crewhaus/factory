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

// ---------------------------------------------------------------------------
// Loop contract 0.4 (Batch A) — `when` key resolution + `parallel` groups
// (declared members, >= 2 per group, reachability closure via group[0]).
// ---------------------------------------------------------------------------
describe("Batch A — wellFormednessCheck (graph when + parallel)", () => {
  test("accepts when.key that names a declared node (both forms)", () => {
    const g: IrGraphV0 = {
      ...baseGraph,
      edges: [
        { from: "a", to: "b", when: { key: "a", equals: "approve" } },
        { from: "a", to: "b", when: { key: "a", exists: true } },
      ],
    };
    expect(() => wellFormednessCheck(g)).not.toThrow();
  });

  test("rejects when.key that references an undeclared node", () => {
    const bad: IrGraphV0 = {
      ...baseGraph,
      edges: [{ from: "a", to: "b", when: { key: "ghost", exists: true } }],
    };
    expect(() => wellFormednessCheck(bad)).toThrow(IrPassError);
    expect(() => wellFormednessCheck(bad)).toThrow(/when\.key "ghost"/);
  });

  test("rejects a parallel group with fewer than 2 members", () => {
    const bad: IrGraphV0 = { ...baseGraph, parallel: [["b"]] };
    expect(() => wellFormednessCheck(bad)).toThrow(IrPassError);
    expect(() => wellFormednessCheck(bad)).toThrow(/at least 2 nodes/);
  });

  test("rejects a parallel group referencing an undeclared node", () => {
    const bad: IrGraphV0 = { ...baseGraph, parallel: [["b", "ghost"]] };
    expect(() => wellFormednessCheck(bad)).toThrow(IrPassError);
    expect(() => wellFormednessCheck(bad)).toThrow(/undeclared node "ghost"/);
  });

  test("a parallel group whose head is reachable makes every member reachable", () => {
    const g: IrGraphV0 = {
      ...baseGraph,
      nodes: [
        ...baseGraph.nodes,
        { name: "c", instructions: "node c", model: "m", tools: [], toolConfigs: {} },
      ],
      // No edge reaches c directly — only the [b, c] barrier does (the
      // engine triggers it when the cursor lands on b, the group head).
      parallel: [["b", "c"]],
    };
    expect(() => wellFormednessCheck(g)).not.toThrow();
  });

  test("a parallel group whose head is unreachable does not launder reachability", () => {
    const bad: IrGraphV0 = {
      ...baseGraph,
      nodes: [
        ...baseGraph.nodes,
        { name: "c", instructions: "node c", model: "m", tools: [], toolConfigs: {} },
        { name: "d", instructions: "node d", model: "m", tools: [], toolConfigs: {} },
      ],
      // c is the head but nothing reaches c → c and d are both unreachable.
      parallel: [["c", "d"]],
    };
    expect(() => wellFormednessCheck(bad)).toThrow(/unreachable/);
  });
});
