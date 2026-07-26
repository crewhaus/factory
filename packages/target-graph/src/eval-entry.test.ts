/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — the `evalEntry` emit option:
 * byte-identity when absent; the exported `runForEval` (drive-to-run_done on
 * the caller's RunContext, HITL pause throws) + `import.meta.main` guard +
 * the module-scope scripted-adapter seam when set.
 */
import { describe, expect, test } from "bun:test";
import type { IrGraphV0 } from "@crewhaus/ir";
import { emitGraph } from "./index";

const BASE_IR: IrGraphV0 = {
  version: 0,
  name: "demo-graph",
  target: "graph",
  entry: "plan",
  nodes: [
    {
      name: "plan",
      instructions: "Plan it",
      model: "claude-sonnet-4-6",
      tools: [],
      toolConfigs: {},
    },
    {
      name: "answer",
      instructions: "Answer it",
      model: "claude-sonnet-4-6",
      tools: [],
      toolConfigs: {},
    },
  ],
  edges: [{ from: "plan", to: "answer" }],
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
};

const agentTs = (ir: IrGraphV0, evalEntry: boolean): string =>
  emitGraph(ir, { readme: false, ...(evalEntry ? { evalEntry: true } : {}) }).files[0]?.content ??
  "";

describe("emitGraph — evalEntry off is byte-identical (back-compat pin)", () => {
  test("omitted, {} and evalEntry: false all emit the same bytes", () => {
    const a = emitGraph(BASE_IR).files[0]?.content;
    const b = emitGraph(BASE_IR, {}).files[0]?.content;
    const c = emitGraph(BASE_IR, { evalEntry: false }).files[0]?.content;
    expect(b).toBe(a as string);
    expect(c).toBe(a as string);
    expect(a).not.toContain("runForEval");
    expect(a).not.toContain("import.meta.main");
    expect(a).not.toContain("__evalAdapter");
  });
});

describe("emitGraph — evalEntry variant (cluster S)", () => {
  test("exports runForEval and guards the CLI invocation behind import.meta.main", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain("export async function runForEval(");
    expect(c).toContain("if (import.meta.main) {");
  });

  test("runForEval drives the compiled graph on the caller's RunContext", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain("__graph.run(");
    expect(c).toContain("runContext: __evalOpts.runContext ?? __runContext");
    expect(c).toContain("return JSON.stringify(__finalState, null, 2);");
  });

  test("a HITL pause fails the sample loudly (headless evals cannot approve)", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain("graph paused for HITL approval");
  });

  test("node bodies spread the module-scope scripted-adapter seam", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain("let __evalAdapter:");
    // Both non-judge node bodies thread it into their runChatLoop call.
    expect((c.match(/_adapter: __evalAdapter/g) ?? []).length).toBe(2);
  });

  test("judge-carrying graphs stay valid under the variant", () => {
    const ir: IrGraphV0 = {
      ...BASE_IR,
      nodes: [
        ...BASE_IR.nodes,
        {
          name: "gate",
          instructions: "judge",
          model: "claude-sonnet-4-6",
          tools: [],
          toolConfigs: {},
          kind: "judge",
          judge: { criteria: "good?", threshold: 0.5, onFail: "continue", maxRetries: 0 },
        },
      ],
      edges: [...BASE_IR.edges, { from: "answer", to: "gate" }],
    };
    const c = agentTs(ir, true);
    const t = new Bun.Transpiler({ loader: "ts" });
    expect(() => t.transformSync(c)).not.toThrow();
    expect(c).toContain("export async function runForEval(");
  });

  test("evalEntry emission is syntactically valid TypeScript", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    expect(() => t.transformSync(agentTs(BASE_IR, true))).not.toThrow();
  });
});
