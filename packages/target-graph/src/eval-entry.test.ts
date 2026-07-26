/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — the `evalEntry` emit option:
 * byte-identity when absent; the exported `runForEval` (drive-to-run_done on
 * the caller's RunContext, HITL pause throws) + `import.meta.main` guard +
 * the PER-INVOCATION eval seams (sessionRootDir + scripted adapter, keyed on
 * the caller's RunContext) when set.
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
    expect(a).not.toContain("__evalSeam");
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
    expect(c).toContain("const __evalRunContext = __evalOpts.runContext ?? __runContext;");
    expect(c).toContain("{ runContext: __evalRunContext }");
    expect(c).toContain("return JSON.stringify(__finalState, null, 2);");
  });

  test("a HITL pause fails the sample loudly (headless evals cannot approve)", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain("graph paused for HITL approval");
  });

  test("node bodies read PER-INVOCATION eval seams keyed on the RunContext", () => {
    const c = agentTs(BASE_IR, true);
    // No module-scope mutable: two concurrent samples (default concurrency 2)
    // would clobber each other's adapter/session root.
    expect(c).not.toContain("let __evalAdapter");
    expect(c).toContain("const __evalSeams = new WeakMap<");
    expect(c).toContain("__evalSeams.set(__evalRunContext, {");
    // Both non-judge node bodies look their seams up and thread BOTH through.
    expect((c.match(/const __evalSeam = __evalSeams\.get\(ctx\.runContext\);/g) ?? []).length).toBe(
      2,
    );
    expect((c.match(/_adapter: __evalSeam\._adapter/g) ?? []).length).toBe(2);
    expect((c.match(/sessionRootDir: __evalSeam\.sessionRootDir/g) ?? []).length).toBe(2);
  });

  test("runForEval accepts sessionRootDir so node session logs land in the sample dir", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain("sessionRootDir?: string;");
    expect(c).toContain(
      "...(__evalOpts.sessionRootDir !== undefined ? { sessionRootDir: __evalOpts.sessionRootDir } : {}),",
    );
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
