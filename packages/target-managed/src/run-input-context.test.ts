/**
 * The premise the managed gateway's run-input check relies on: the gateway
 * classifies `runs.create` / `runs.continue` input and runs the emitted
 * handler inside run-context's inbound scope, and the FIRST `RunContext`
 * created in that scope is the one tagged with the input. So between the
 * handler's start and its first `runOneTurn(`, the emitted daemon must create
 * exactly one context, the run's own, and hand that one to the turn. This
 * guards the emitted text; it changes nothing in it.
 */
import { describe, expect, test } from "bun:test";
import type { IrManagedV0 } from "@crewhaus/ir";
import { emitManaged } from "./index";

const HANDLER = "handler: async ({ method, params, tenant }) => {";

const baseIr: IrManagedV0 = {
  version: 0,
  name: "run-input-context",
  target: "managed",
  agent: { model: "claude-sonnet-4-6", instructions: "Answer briefly." },
  tenants: [{ id: "tenant-a", budget: { maxInputTokens: 1_000, maxOutputTokens: 1_000 } }],
  permissions: { rules: [] },
  compaction: {},
};

const PROVABILITY: NonNullable<IrManagedV0["provability"]> = {
  level: "cited",
  onFail: "note",
  maxRetries: 1,
  threshold: 1,
  scope: "session",
  assumptions: "allow",
  render: "footer",
  sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
  grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
  execution: { allow: ["evaluate"], replay: true, maxReplays: 20 },
  formal: { checkers: ["builtin"], forbid: ["sorry"], timeoutMs: 30_000 },
};

const daemonOf = (ir: IrManagedV0): string =>
  emitManaged(ir).files.find((f) => f.path === "daemon.ts")?.content ?? "";

/** What breaks the premise in `daemon`, or [] when it holds. */
function premiseProblems(daemon: string): string[] {
  const start = daemon.indexOf(HANDLER);
  if (start < 0) return ["the run handler was not found"];
  const turn = daemon.indexOf("runOneTurn(", start);
  if (turn < 0) return ["no runOneTurn( after the handler"];
  const before = daemon.slice(start, turn);
  const problems: string[] = [];
  const created = before.match(/createRunContext\(/g) ?? [];
  if (created.length !== 1) {
    problems.push(`${created.length} createRunContext( calls before the turn, not 1`);
  }
  if (!before.includes("createRunContext({ runId, sessionId })")) {
    problems.push("the run's context is not createRunContext({ runId, sessionId })");
  }
  // The turn's own options: up to the first `extraOptions: {` after the call.
  if (!/^runOneTurn\(\{[\s\S]*?extraOptions: \{\s*runContext,/.test(daemon.slice(turn))) {
    problems.push("the turn is not handed runContext in extraOptions");
  }
  return problems;
}

describe("managed run input tags the run's first context (premise)", () => {
  test("holds for the emitted daemon, with and without provability:", () => {
    for (const ir of [baseIr, { ...baseIr, provability: PROVABILITY }]) {
      const daemon = daemonOf(ir);
      expect(daemon).toContain(HANDLER);
      expect(premiseProblems(daemon)).toEqual([]);
    }
  });

  test("fails on a context created before the run's own", () => {
    const daemon = daemonOf(baseIr);
    const planted = daemon.replace(HANDLER, `${HANDLER}\n    const early = createRunContext();`);
    expect(planted).not.toBe(daemon);
    expect(premiseProblems(planted)).toEqual(["2 createRunContext( calls before the turn, not 1"]);
  });

  test("fails when the turn is not handed the run's context", () => {
    const daemon = daemonOf(baseIr);
    const planted = daemon.replace(/extraOptions: \{\s*runContext,/, "extraOptions: {");
    expect(planted).not.toBe(daemon);
    expect(premiseProblems(planted)).toEqual(["the turn is not handed runContext in extraOptions"]);
  });
});
