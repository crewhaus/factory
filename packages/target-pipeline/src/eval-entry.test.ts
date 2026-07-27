/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — the `evalEntry` emit option:
 * byte-identity when absent; the exported single-turn `runForEval` (history
 * seeding, caller RunContext/sessionRootDir/_adapter seams) + the
 * `import.meta.main` REPL guard when set.
 */
import { describe, expect, test } from "bun:test";
import type { IrPipelineV0 } from "@crewhaus/ir";
import { emitPipeline } from "./index";

const BASE_IR: IrPipelineV0 = {
  version: 0,
  name: "demo-rag",
  target: "pipeline",
  agent: { model: "claude-sonnet-4-6", instructions: "Use Retrieve." },
  retrieve: { embedderModel: "mock/det", vectorBackend: "in-memory", defaultK: 5 },
  indexing: {
    chunkStrategy: "fixed",
    chunkSize: 200,
    chunkOverlap: 0,
    documents: [{ id: "doc-1", text: "the quick brown fox" }],
  },
  permissions: { rules: [] },
  compaction: {},
};

const agentTs = (ir: IrPipelineV0, evalEntry: boolean): string =>
  emitPipeline(ir, { readme: false, ...(evalEntry ? { evalEntry: true } : {}) }).files[0]
    ?.content ?? "";

describe("emitPipeline — evalEntry off is byte-identical (back-compat pin)", () => {
  test("omitted, {} and evalEntry: false all emit the same bytes", () => {
    const a = emitPipeline(BASE_IR).files[0]?.content;
    const b = emitPipeline(BASE_IR, {}).files[0]?.content;
    const c = emitPipeline(BASE_IR, { evalEntry: false }).files[0]?.content;
    expect(b).toBe(a as string);
    expect(c).toBe(a as string);
    expect(a).not.toContain("runForEval");
    expect(a).not.toContain("import.meta.main");
    // The REPL stays a bare top-level await.
    expect(a).toContain("await runChatLoop({");
  });
});

describe("emitPipeline — evalEntry variant (cluster S)", () => {
  test("exports a single-turn runForEval and guards the REPL behind import.meta.main", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain("export async function runForEval(");
    expect(c).toContain("if (import.meta.main) {");
    expect(c).toContain("singleTurn: true,");
  });

  test("history seeds the conversation ahead of the graded input (chat-capable)", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain(
      'seedMessages: [...(__evalOpts.history ?? []), { role: "user", content: __evalInput }],',
    );
  });

  test("caller seams thread into the eval turn", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain("runContext: __evalOpts.runContext");
    expect(c).toContain("sessionRootDir: __evalOpts.sessionRootDir");
    expect(c).toContain("_adapter: __evalOpts._adapter");
  });

  test("module-scope indexing is untouched — the deployed boot runs at import", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain("const __indexResult = await __indexingPipeline.run(");
    // Indexing sits BEFORE runForEval (module scope, not per call).
    expect(c.indexOf("__indexingPipeline.run(")).toBeLessThan(c.indexOf("runForEval("));
  });

  test("evalEntry emission is syntactically valid TypeScript", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    expect(() => t.transformSync(agentTs(BASE_IR, true))).not.toThrow();
  });
});

/**
 * Loop contract 0.4 (G11) — the eval turn is the bundle's NON-INTERACTIVE
 * surface, so an `ask` there must park rather than collapse to a deny.
 * runtime-core parks only when BOTH `askMode: "pause"` and an `approvals`
 * store are present, so both fields have to reach `runForEval`.
 */
describe("emitPipeline — ask_mode plumbing (G11)", () => {
  test("runForEval carries askMode + the approval store", () => {
    const c = agentTs(BASE_IR, true);
    expect(c).toContain('askMode: "pause",');
    expect(c).toContain('approvals: { store: __approvals, surface: "pipeline-eval" },');
    expect(c).toContain(
      'import { createPendingApprovalStore, resolveSessionRootDir } from "@crewhaus/runtime-core";',
    );
    expect(c).toContain("const __approvalRoot = resolveSessionRootDir(undefined);");
    // Module scope, so the store is built once — before the entry can use it.
    expect(c.indexOf("const __approvals =")).toBeLessThan(c.indexOf("export async function"));
  });

  test("the fields survive a spec with no permissions block — where ask is the default", () => {
    // BASE_IR declares no mode and no rules, so the emitted permission block
    // is empty; the approval fields must NOT ride along with it.
    expect(agentTs(BASE_IR, true)).not.toContain("permissionMode:");
    expect(agentTs(BASE_IR, true)).toContain('askMode: "pause",');
  });

  test('ask_mode: deny emits askMode: "deny" — with the store still wired', () => {
    const c = agentTs({ ...BASE_IR, permissions: { rules: [], askMode: "deny" } }, true);
    expect(c).toContain('askMode: "deny",');
    // Passed even under "deny" (where it never parks) so runtime-core's
    // diagnostic reports the spec's choice instead of missing plumbing.
    expect(c).toContain("approvals: { store: __approvals,");
  });

  test("the REPL is untouched — it prompts on stdin, so it never parks", () => {
    const c = agentTs(BASE_IR, true);
    const repl = c.slice(c.indexOf("if (import.meta.main) {"));
    expect(repl).not.toContain("askMode:");
    expect(repl).not.toContain("approvals:");
  });

  test("a plain (non-eval) bundle emits no approval plumbing", () => {
    const c = agentTs(BASE_IR, false);
    expect(c).not.toContain("askMode:");
    expect(c).not.toContain("createPendingApprovalStore");
  });
});
