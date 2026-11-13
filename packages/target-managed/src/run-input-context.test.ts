/**
 * The premise the managed gateway's run-input check relies on: the gateway
 * classifies `runs.create` / `runs.continue` input and calls the run handler
 * inside run-context's inbound scope, and the FIRST `RunContext` created in
 * that scope is the one tagged with the input. The emitted daemon delegates
 * the handler to `@crewhaus/gateway-server/managed-runs`, which creates the
 * run's context and hands it to the emitted `executeTurn`; so the turn must
 * create no context of its own and must hand that one to `runOneTurn`. This
 * guards the emitted text; it changes nothing in it.
 */
import { describe, expect, test } from "bun:test";
import type { IrManagedV0 } from "@crewhaus/ir";
import { emitManaged } from "./index";

const TURN = "  executeTurn: async ({ tenant, sessionId, input, isResume, runContext, log }) =>";

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
  const problems: string[] = [];
  const delegated = daemon.match(/createManagedRuns\(/g) ?? [];
  if (delegated.length !== 1) problems.push(`${delegated.length} createManagedRuns( calls, not 1`);
  if (!daemon.includes("  handler: managedRuns.handler,")) {
    problems.push("the gateway is not handed managedRuns.handler");
  }
  const start = daemon.indexOf(TURN);
  if (start < 0) return [...problems, "the turn was not found"];
  const turn = daemon.indexOf("runOneTurn(", start);
  if (turn < 0) return [...problems, "no runOneTurn( after the turn's start"];
  const created = daemon.slice(start, turn).match(/createRunContext\(/g) ?? [];
  if (created.length !== 0) {
    problems.push(`${created.length} createRunContext( calls before the turn, not 0`);
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
      expect(daemon).toContain(TURN);
      expect(premiseProblems(daemon)).toEqual([]);
    }
  });

  test("fails on a context the turn creates itself", () => {
    const daemon = daemonOf(baseIr);
    const planted = daemon.replace(
      "    reply: await runOneTurn({",
      "    reply: createRunContext() && await runOneTurn({",
    );
    expect(planted).not.toBe(daemon);
    expect(premiseProblems(planted)).toEqual(["1 createRunContext( calls before the turn, not 0"]);
  });

  test("fails when the turn is not handed the run's context", () => {
    const daemon = daemonOf(baseIr);
    const planted = daemon.replace(/extraOptions: \{\s*runContext,/, "extraOptions: {");
    expect(planted).not.toBe(daemon);
    expect(premiseProblems(planted)).toEqual(["the turn is not handed runContext in extraOptions"]);
  });

  test("fails when the gateway is handed a handler of the daemon's own", () => {
    const daemon = daemonOf(baseIr);
    const planted = daemon.replace(
      "  handler: managedRuns.handler,",
      "  handler: async () => ({}),",
    );
    expect(planted).not.toBe(daemon);
    expect(premiseProblems(planted)).toEqual(["the gateway is not handed managedRuns.handler"]);
  });
});
