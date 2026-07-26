/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — the `evalEntry` emit option:
 * byte-identity when absent, the exported `runForEval` + `import.meta.main`
 * guard + per-invocation seams when set.
 */
import { describe, expect, test } from "bun:test";
import type { IrWorkflowV0 } from "@crewhaus/ir";
import { emitWorkflow } from "./index";

const step = (name: string, extra: Partial<IrWorkflowV0["steps"][number]> = {}) => ({
  name,
  instructions: `do ${name}`,
  model: "claude-sonnet-4-6",
  tools: [],
  toolConfigs: {},
  ...extra,
});

const TWO_STEP_IR: IrWorkflowV0 = {
  version: 0,
  name: "demo",
  target: "workflow",
  steps: [step("draft"), step("polish")],
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
};

const agentTs = (ir: IrWorkflowV0, evalEntry: boolean): string =>
  emitWorkflow(ir, { readme: false, ...(evalEntry ? { evalEntry: true } : {}) }).files[0]
    ?.content ?? "";

describe("emitWorkflow — evalEntry off is byte-identical (back-compat pin)", () => {
  test("omitted, {} and evalEntry: false all emit the same bytes", () => {
    const a = emitWorkflow(TWO_STEP_IR).files[0]?.content;
    const b = emitWorkflow(TWO_STEP_IR, {}).files[0]?.content;
    const c = emitWorkflow(TWO_STEP_IR, { evalEntry: false }).files[0]?.content;
    expect(b).toBe(a as string);
    expect(c).toBe(a as string);
    expect(a).not.toContain("runForEval");
    expect(a).not.toContain("import.meta.main");
  });
});

describe("emitWorkflow — evalEntry variant (cluster S)", () => {
  test("exports runForEval and guards the CLI main behind import.meta.main", () => {
    const c = agentTs(TWO_STEP_IR, true);
    expect(c).toContain("export async function runForEval(");
    expect(c).toContain("if (import.meta.main) {");
    // main() becomes the thin stdin wrapper around the entry.
    expect(c).toContain("await runForEval(stdinInput);");
  });

  test("step 1 reads the entry's input, not stdin, inside runForEval", () => {
    const c = agentTs(TWO_STEP_IR, true);
    expect(c).toContain('__evalInput || "begin"');
    // Exactly one stdin read remains — in the CLI main wrapper.
    expect((c.match(/await readStdinToEnd\(\)/g) ?? []).length).toBe(1);
  });

  test("every step call threads the per-invocation RunContext + seams", () => {
    const c = agentTs(TWO_STEP_IR, true);
    expect((c.match(/runContext: __runContext,/g) ?? []).length).toBe(2);
    expect(c).toContain("const __runContext = __evalOpts.runContext ?? createRunContext();");
    expect(c).toContain('import { createRunContext } from "@crewhaus/run-context";');
    expect((c.match(/_adapter: __evalOpts\._adapter/g) ?? []).length).toBe(2);
    expect((c.match(/sessionRootDir: __evalOpts\.sessionRootDir/g) ?? []).length).toBe(2);
  });

  test("durable steps key on the per-invocation run id (no cross-sample dedup)", () => {
    const c = agentTs(TWO_STEP_IR, true);
    expect(c).toContain("__durableStep(__runId, ");
    expect(c).toContain(
      'const __runId = process.env["CREWHAUS_RUN_ID"] ?? `wf_${__randomUUID()}`;',
    );
    // The run id is minted INSIDE runForEval, not at module scope.
    expect(c.indexOf("const __runId")).toBeGreaterThan(
      c.indexOf("export async function runForEval"),
    );
  });

  test("the final step's output is returned", () => {
    const c = agentTs(TWO_STEP_IR, true);
    expect(c).toContain("return priorOutput;");
  });

  test("deadline guard throws inside runForEval instead of poisoning exitCode", () => {
    const ir: IrWorkflowV0 = { ...TWO_STEP_IR, limits: { deadlineMs: 5000 } };
    const c = agentTs(ir, true);
    expect(c).toContain("throw new Error(");
    expect(c).toContain("workflow deadline exceeded");
    expect(c).not.toContain("process.exitCode = 1;");
  });

  test("judge-gated workflows keep the classified wrapper under the guard", () => {
    const ir: IrWorkflowV0 = {
      ...TWO_STEP_IR,
      steps: [
        step("draft"),
        step("gate", {
          kind: "judge",
          judge: { criteria: "is it good?", threshold: 0.5, onFail: "halt", maxRetries: 0 },
        }),
      ],
    };
    const c = agentTs(ir, true);
    expect(c).toContain("export async function runForEval(");
    expect(c).toContain("if (import.meta.main) {");
    expect(c).toContain("judge_verdict");
    const t = new Bun.Transpiler({ loader: "ts" });
    expect(() => t.transformSync(c)).not.toThrow();
  });

  test("evalEntry emission is syntactically valid TypeScript", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    expect(() => t.transformSync(agentTs(TWO_STEP_IR, true))).not.toThrow();
  });
});
