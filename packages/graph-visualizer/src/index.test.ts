import { describe, expect, test } from "bun:test";
import type { IrGraphV0 } from "@crewhaus/ir";
import { applyEvent, initialLiveState, layoutGraph, renderLiveSvg, renderSvg } from "./index.js";

const baseIr: IrGraphV0 = {
  version: 0,
  name: "g",
  target: "graph",
  entry: "plan",
  nodes: [
    { name: "plan", instructions: "p", model: "m", tools: [], toolConfigs: Object.freeze({}) },
    { name: "execute", instructions: "e", model: "m", tools: [], toolConfigs: Object.freeze({}) },
    { name: "summarise", instructions: "s", model: "m", tools: [], toolConfigs: Object.freeze({}) },
  ],
  edges: [
    { from: "plan", to: "execute" },
    { from: "execute", to: "summarise" },
  ],
  permissions: { rules: [] },
  compaction: {},
};

describe("layoutGraph (T1)", () => {
  test("places entry in column 0 and successors at increasing columns", () => {
    const l = layoutGraph(baseIr);
    const plan = l.nodes.find((n) => n.id === "plan");
    const execute = l.nodes.find((n) => n.id === "execute");
    const summarise = l.nodes.find((n) => n.id === "summarise");
    if (!plan || !execute || !summarise) throw new Error("nodes missing");
    expect(plan.x).toBeLessThan(execute.x);
    expect(execute.x).toBeLessThan(summarise.x);
  });

  test("emits all 3 nodes + 2 edges with resolved fromXY/toXY (T3 fixture invariant)", () => {
    const l = layoutGraph(baseIr);
    expect(l.nodes).toHaveLength(3);
    expect(l.edges).toHaveLength(2);
    for (const e of l.edges) {
      expect(typeof e.fromXY.x).toBe("number");
      expect(typeof e.toXY.x).toBe("number");
    }
  });

  test("layout-stability: same graph → byte-identical positions across re-runs (T1 ±0 px deterministic)", () => {
    const a = layoutGraph(baseIr);
    const b = layoutGraph(baseIr);
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
    expect(JSON.stringify(a.edges)).toBe(JSON.stringify(b.edges));
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
  });

  test("unreachable node lands in a column past the last reachable one", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [
        ...baseIr.nodes,
        {
          name: "orphan",
          instructions: "x",
          model: "m",
          tools: [],
          toolConfigs: Object.freeze({}),
        },
      ],
    };
    const l = layoutGraph(ir);
    const orphan = l.nodes.find((n) => n.id === "orphan");
    if (!orphan) throw new Error("orphan missing");
    const summariseX = l.nodes.find((n) => n.id === "summarise")?.x ?? 0;
    expect(orphan.x).toBeGreaterThan(summariseX);
  });

  test("width/height bound the highest node coordinates with margin", () => {
    const l = layoutGraph(baseIr, { columnGap: 200, rowGap: 80, margin: 40 });
    const maxX = Math.max(...l.nodes.map((n) => n.x));
    const maxY = Math.max(...l.nodes.map((n) => n.y));
    expect(l.width).toBeGreaterThan(maxX);
    expect(l.height).toBeGreaterThan(maxY);
  });
});

describe("renderSvg", () => {
  test("emits valid-shaped SVG with one circle per node + one line per edge", () => {
    const l = layoutGraph(baseIr);
    const svg = renderSvg(l);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    const circleCount = (svg.match(/<circle /g) ?? []).length;
    const lineCount = (svg.match(/<line /g) ?? []).length;
    expect(circleCount).toBe(3);
    expect(lineCount).toBe(2);
  });

  test("escapes text content (no raw <>&)", () => {
    const ir: IrGraphV0 = {
      ...baseIr,
      nodes: [
        { name: "a<b&c", instructions: "i", model: "m", tools: [], toolConfigs: Object.freeze({}) },
      ],
      edges: [],
      entry: "a<b&c",
    };
    const svg = renderSvg(layoutGraph(ir));
    expect(svg).toContain("a&lt;b&amp;c");
  });
});

describe("graph-visualizer v1 — Section 31 live mode", () => {
  test("initialLiveState marks every node as idle", () => {
    const layout = layoutGraph(baseIr);
    const state = initialLiveState(layout);
    for (const n of layout.nodes) {
      expect(state.states[n.id]).toBe("idle");
    }
  });

  test("applyEvent transitions: idle → running → done", () => {
    const layout = layoutGraph(baseIr);
    let state = initialLiveState(layout);
    state = applyEvent(state, { kind: "node_start", node: "plan", ts: "2026-05-08T00:00:00Z" });
    expect(state.states["plan"]).toBe("running");
    state = applyEvent(state, { kind: "node_end", node: "plan", ts: "2026-05-08T00:00:01Z" });
    expect(state.states["plan"]).toBe("done");
  });

  test("hitl_pause + approve resumes running", () => {
    const layout = layoutGraph(baseIr);
    let state = initialLiveState(layout);
    state = applyEvent(state, {
      kind: "hitl_pause",
      node: "execute",
      prompt: "Approve to continue?",
      ts: "2026-05-08T00:00:01Z",
    });
    expect(state.states["execute"]).toBe("paused-hitl");
    expect(state.reasons["execute"]).toBe("Approve to continue?");
    state = applyEvent(state, {
      kind: "hitl_decision",
      node: "execute",
      decision: "approve",
      ts: "2026-05-08T00:00:02Z",
    });
    expect(state.states["execute"]).toBe("running");
  });

  test("hitl reject → errored", () => {
    const layout = layoutGraph(baseIr);
    let state = initialLiveState(layout);
    state = applyEvent(state, {
      kind: "hitl_pause",
      node: "execute",
      prompt: "p",
      ts: "t1",
    });
    state = applyEvent(state, {
      kind: "hitl_decision",
      node: "execute",
      decision: "reject",
      ts: "t2",
    });
    expect(state.states["execute"]).toBe("errored");
  });

  test("history is bounded at 1000 entries", () => {
    const layout = layoutGraph(baseIr);
    let state = initialLiveState(layout);
    // 1100 iterations is enough to prove the cap (1000 + 100 over) without
    // hitting CI runner timeouts. applyEvent does an O(n) [...history]
    // copy + splice, so 1500 × 1000-entry copies tipped over the Bun
    // 5 s test timeout on GitHub Actions even when local Bun ran in
    // ~200 ms.
    for (let i = 0; i < 1100; i++) {
      state = applyEvent(state, {
        kind: "node_start",
        node: "plan",
        ts: `2026-05-08T00:00:${(i % 60).toString().padStart(2, "0")}Z`,
      });
    }
    expect(state.history.length).toBe(1000);
  });

  test("renderLiveSvg adds data-state attributes per node", () => {
    const layout = layoutGraph(baseIr);
    let state = initialLiveState(layout);
    state = applyEvent(state, { kind: "node_start", node: "plan", ts: "t" });
    const svg = renderLiveSvg(layout, state);
    expect(svg).toContain('data-state="running"');
    expect(svg).toContain('data-state="idle"');
  });
});
