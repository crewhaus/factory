/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — `emitSourceBundleWithEvalEntry`
 * dispatch: the shapes whose compiled runtime the bridge invokes re-emit with
 * their eval-entry variant; every other shape returns undefined (the plain
 * compile() bundle is already the right artifact).
 */
import { describe, expect, test } from "bun:test";
import type { IrCrewV0, IrGraphV0, IrPipelineV0, IrWorkflowV0 } from "@crewhaus/ir";
import { emitSourceBundleWithEvalEntry } from "./bridge-emit";

const WORKFLOW_IR: IrWorkflowV0 = {
  version: 0,
  name: "wf",
  target: "workflow",
  steps: [
    { name: "one", instructions: "a", model: "m", tools: [], toolConfigs: {} },
    { name: "two", instructions: "b", model: "m", tools: [], toolConfigs: {} },
  ],
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
};

const GRAPH_IR: IrGraphV0 = {
  version: 0,
  name: "g",
  target: "graph",
  entry: "a",
  nodes: [
    { name: "a", instructions: "a", model: "m", tools: [], toolConfigs: {} },
    { name: "b", instructions: "b", model: "m", tools: [], toolConfigs: {} },
  ],
  edges: [{ from: "a", to: "b" }],
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
};

const CREW_IR: IrCrewV0 = {
  version: 0,
  name: "c",
  target: "crew",
  entry: "solo",
  roles: [
    { name: "solo", model: "m", instructions: "x", tools: [], toolConfigs: {}, subAgents: [] },
  ],
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
};

const PIPELINE_IR: IrPipelineV0 = {
  version: 0,
  name: "p",
  target: "pipeline",
  agent: { model: "m", instructions: "x" },
  retrieve: { embedderModel: "mock/det", vectorBackend: "in-memory", defaultK: 5 },
  indexing: {
    chunkStrategy: "fixed",
    chunkSize: 200,
    chunkOverlap: 0,
    documents: [{ id: "d", text: "t" }],
  },
  permissions: { rules: [] },
  compaction: {},
};

describe("emitSourceBundleWithEvalEntry", () => {
  test("workflow re-emits agent.ts with the exported runForEval", () => {
    const bundle = emitSourceBundleWithEvalEntry(WORKFLOW_IR, { readme: false });
    expect(bundle).toBeDefined();
    const agent = bundle?.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain("export async function runForEval(");
    expect(agent).toContain("if (import.meta.main) {");
  });

  test("graph re-emits agent.ts with the exported runForEval", () => {
    const bundle = emitSourceBundleWithEvalEntry(GRAPH_IR, { readme: false });
    const agent = bundle?.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain("export async function runForEval(");
  });

  test("crew gains the additive eval-entry.ts", () => {
    const bundle = emitSourceBundleWithEvalEntry(CREW_IR, { readme: false });
    expect(bundle?.files.some((f) => f.path === "eval-entry.ts")).toBe(true);
  });

  test("pipeline re-emits agent.ts with the guarded REPL", () => {
    const bundle = emitSourceBundleWithEvalEntry(PIPELINE_IR, { readme: false });
    const agent = bundle?.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain("export async function runForEval(");
    expect(agent).toContain("if (import.meta.main) {");
  });

  test("shapes without an entry re-emission return undefined", () => {
    // Managed's agent.ts already exports runOneTurn; single-agent shapes use
    // the runner's default invoker — the plain bundle is the right artifact.
    for (const target of ["managed", "voice", "browser", "batch", "research", "cli"]) {
      const fake = { ...WORKFLOW_IR, target } as unknown as Parameters<
        typeof emitSourceBundleWithEvalEntry
      >[0];
      expect(emitSourceBundleWithEvalEntry(fake, { readme: false })).toBeUndefined();
    }
  });

  test("readme option threads through (README present by default)", () => {
    const withReadme = emitSourceBundleWithEvalEntry(WORKFLOW_IR);
    expect(withReadme?.files.some((f) => f.path === "README.md")).toBe(true);
    const without = emitSourceBundleWithEvalEntry(WORKFLOW_IR, { readme: false });
    expect(without?.files.some((f) => f.path === "README.md")).toBe(false);
  });
});
