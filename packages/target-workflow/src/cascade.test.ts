/**
 * 0.6.0 §7.3 (PR 9c) — the workflow half of the cascade: a `retry_previous`
 * judge with `escalate_to` forces the gated step's re-run onto that roster arm
 * (the closure gains a `__force` parameter that spreads `forcedCandidate`),
 * and judge-bearing bundles boot a durable `attachRunEventSink` for the
 * between-step `judge_verdict` lines. Byte-identity: no `escalate_to` → no
 * `__force`; no judge → no sink.
 */
import { describe, expect, test } from "bun:test";
import type { IrWorkflowV0 } from "@crewhaus/ir";
import { emitWorkflow } from "./index";

const POOL = {
  candidates: [
    { model: "claude-haiku-4-5", tags: ["cheap"] },
    { model: "claude-opus-4-1", tags: ["strong"] },
  ],
  policy: "static" as const,
};

const gated = (escalateTo?: string): IrWorkflowV0 => ({
  version: 0,
  name: "cascade-wf",
  target: "workflow",
  steps: [
    {
      name: "draft",
      instructions: "Write it.",
      model: "claude-haiku-4-5",
      tools: [],
      toolConfigs: {},
      modelPool: POOL,
    },
    {
      name: "gate",
      kind: "judge",
      instructions: "cites sources",
      model: "claude-sonnet-4-5",
      tools: [],
      toolConfigs: {},
      judge: {
        criteria: "cites sources",
        threshold: 0.9,
        onFail: "retry_previous",
        maxRetries: 2,
        ...(escalateTo !== undefined ? { escalateTo } : {}),
      },
    },
  ],
  mcp_servers: {},
  permissions: { rules: [] },
  compaction: {},
});

const parseTs = (code: string) =>
  new Bun.Transpiler({ loader: "ts" }).transformSync(code.replace(/^#!.*\n/, ""));

describe("emitWorkflow — judge.escalate_to forces the retry_previous re-run", () => {
  test("the gated closure gains __force, spreads forcedCandidate, and the retry passes the rung", () => {
    const c = emitWorkflow(gated("strong")).files[0]?.content ?? "";
    expect(() => parseTs(c)).not.toThrow();
    expect(c).toContain(
      "const __runStep1 = async (__nudge: string, __force?: string): Promise<string> => runChatLoop({",
    );
    expect(c).toContain("    ...(__force !== undefined ? { forcedCandidate: __force } : {}),");
    // First run: unforced. Retry: forced onto "strong".
    expect(c).toContain('priorOutput = await __runStep1("");');
    expect(c).toContain('+ __result.rationale, "strong");');
    // The step's pool blob still rides beside it (the runtime resolves the
    // forced arm against that roster).
    expect(c).toContain('"tags":["strong"]');
  });

  test("without escalate_to the closure keeps its one-parameter shape (byte-identity)", () => {
    const c = emitWorkflow(gated()).files[0]?.content ?? "";
    expect(c).toContain(
      "const __runStep1 = async (__nudge: string): Promise<string> => runChatLoop({",
    );
    expect(c).not.toContain("__force");
    expect(c).not.toContain("forcedCandidate");
    expect(c).toContain("+ __result.rationale);");
  });
});

describe("emitWorkflow — durable sink for between-step judge_verdict lines", () => {
  test("a judge-bearing bundle imports attachRunEventSink, boots it on the shared RunContext and closes it after the steps", () => {
    const c = emitWorkflow(gated()).files[0]?.content ?? "";
    expect(c).toContain('import { attachRunEventSink } from "@crewhaus/runtime-core";');
    expect(c).toContain("const __runEventSink = await attachRunEventSink(__runContext, {});");
    expect(c).toContain("  await __runEventSink.close();\n");
    // Booted right after the shared context, before any step runs.
    expect(c.indexOf("const __runContext = createRunContext();")).toBeLessThan(
      c.indexOf("attachRunEventSink(__runContext"),
    );
    expect(c.indexOf("attachRunEventSink(__runContext")).toBeLessThan(c.indexOf("__runStep1"));
    // Closed after the last step, before main() returns.
    expect(c.indexOf("await __runEventSink.close();")).toBeGreaterThan(
      c.lastIndexOf("__judgeGate({"),
    );
  });

  test("the eval-entry variant re-roots the sink with the per-invocation sessionRootDir", () => {
    const c =
      emitWorkflow(gated(), { evalEntry: true }).files.find((f) => f.path === "agent.ts")
        ?.content ?? "";
    expect(c.match(/attachRunEventSink\(__runContext/g) ?? []).toHaveLength(1);
    expect(c).toContain(
      "  const __runEventSink = await attachRunEventSink(__runContext, {\n    ...(__evalOpts.sessionRootDir !== undefined ? { sessionRootDir: __evalOpts.sessionRootDir } : {}),\n  });",
    );
    expect(c).toContain("  await __runEventSink.close();\n  return priorOutput;");
    expect(() => parseTs(c)).not.toThrow();
  });

  test("a judge-free workflow carries neither the sink nor the force machinery", () => {
    const plain: IrWorkflowV0 = {
      ...gated(),
      steps: gated().steps.filter((s) => s.kind !== "judge"),
    };
    const c = emitWorkflow(plain).files[0]?.content ?? "";
    for (const s of ["attachRunEventSink", "__runEventSink", "__force", "forcedCandidate"]) {
      expect(c).not.toContain(s);
    }
  });
});
