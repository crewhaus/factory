/**
 * 0.6.0 §7.3 (PR 9c) — the graph half of the cascade: a `retry_previous`
 * judge with `escalate_to` makes the gated node's body read the failing gate
 * off the checkpointed state and spread `forcedCandidate` onto its
 * `runChatLoop` call; judge-bearing bundles boot a durable
 * `attachRunEventSink` for the between-node `judge_verdict` lines.
 * Byte-identity: no `escalate_to` → no `__force`; no judge → no sink.
 */
import { describe, expect, test } from "bun:test";
import type { IrGraphV0 } from "@crewhaus/ir";
import { emitGraph } from "./index";

const POOL = {
  candidates: [
    { model: "claude-haiku-4-5", tags: ["cheap"] },
    { model: "claude-opus-4-1", tags: ["strong"] },
  ],
  policy: "static" as const,
};

const graph = (escalateTo?: string): IrGraphV0 => ({
  version: 0,
  name: "cascade-graph",
  target: "graph",
  entry: "draft",
  nodes: [
    {
      name: "draft",
      instructions: "Write the report.",
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
    {
      name: "publish",
      instructions: "Publish.",
      model: "claude-sonnet-4-5",
      tools: [],
      toolConfigs: {},
    },
  ],
  edges: [
    { from: "draft", to: "gate" },
    { from: "gate", to: "publish" },
  ],
  permissions: { rules: [] },
  compaction: {},
});

const parseTs = (code: string) =>
  new Bun.Transpiler({ loader: "ts" }).transformSync(code.replace(/^#!.*\n/, ""));

describe("emitGraph — judge.escalate_to forces the retry_previous re-run", () => {
  test("the gated node reads the failing gate off state and spreads forcedCandidate", () => {
    const c = emitGraph(graph("strong")).files[0]?.content ?? "";
    expect(() => parseTs(c)).not.toThrow();
    const draftBody = c.slice(c.indexOf('.addNode("draft"'), c.indexOf('.addNode("gate"'));
    expect(draftBody).toContain("let __force: string | undefined;");
    expect(draftBody).toContain('for (const [__j, __arm] of [["gate", "strong"]] as const) {');
    expect(draftBody).toContain('if (__judgeState[__j] === "fail") __force = __arm;');
    expect(draftBody).toContain(
      "        ...(__force !== undefined ? { forcedCandidate: __force } : {}),",
    );
    // The nudge machinery still rides beside it.
    expect(draftBody).toContain('instructions: "Write the report." + __nudge,');
    // Nodes no judge retries carry neither.
    const publishBody = c.slice(c.indexOf('.addNode("publish"'), c.indexOf(".addEdge("));
    expect(publishBody).not.toContain("__force");
  });

  test("without escalate_to the nudge body is unchanged (byte-identity)", () => {
    const c = emitGraph(graph()).files[0]?.content ?? "";
    expect(c).not.toContain("__force");
    expect(c).not.toContain("forcedCandidate");
    expect(c).toContain('instructions: "Write the report." + __nudge,');
  });
});

describe("emitGraph — durable sink for between-node judge_verdict lines", () => {
  test("a judge-bearing bundle imports attachRunEventSink and boots it on the shared RunContext", () => {
    const c = emitGraph(graph()).files[0]?.content ?? "";
    expect(c).toContain('import { attachRunEventSink } from "@crewhaus/runtime-core";');
    expect(c).toContain(
      "const __runContext = createRunContext();\n// 0.6.0 PR 9c — durable sink for the between-node judge_verdict lines.\nconst __runEventSink = await attachRunEventSink(__runContext, {});",
    );
    expect(() => parseTs(c)).not.toThrow();
  });

  test("a judge-free graph carries neither the sink nor the force machinery", () => {
    const plain: IrGraphV0 = {
      ...graph(),
      nodes: graph().nodes.filter((n) => n.kind !== "judge"),
      edges: [{ from: "draft", to: "publish" }],
    };
    const c = emitGraph(plain).files[0]?.content ?? "";
    for (const s of ["attachRunEventSink", "__runEventSink", "__force", "forcedCandidate"]) {
      expect(c).not.toContain(s);
    }
  });
});
