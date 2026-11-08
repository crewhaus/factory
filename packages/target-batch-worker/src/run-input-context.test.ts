/**
 * The premise the queue consumer's run-input check relies on: it classifies a
 * job's payload and runs the emitted handler inside run-context's inbound
 * scope, and the FIRST `RunContext` created in that scope is the one tagged
 * with the payload. So the emitted handler must create exactly one context
 * before its `runChatLoop(`, and hand that one to the loop. This guards the
 * emitted text; it changes nothing in it.
 */
import { describe, expect, test } from "bun:test";
import type { IrBatchV0 } from "@crewhaus/ir";
import { emitBatchWorker } from "./index.js";

const CONSUMER = "startConsumer<string, string>({";
const HANDLER = "handler: async (input, ctx) => {";

const ir: IrBatchV0 = {
  version: 0,
  name: "run-input-context",
  target: "batch",
  agent: { model: "claude-haiku-4-5-20251001", instructions: "Answer briefly." },
  queue: {
    adapter: "in-memory",
    visibilityTimeoutMs: 30_000,
    maxRetries: 3,
    seedJobs: ["job 1 input"],
  },
  concurrency: 1,
  idempotencyWindowMs: 60_000,
  tools: [],
  toolConfigs: Object.freeze({}),
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

const agentOf = (): string =>
  emitBatchWorker(ir).files.find((f) => f.path === "agent.ts")?.content ?? "";

/** What breaks the premise in `agent`, or [] when it holds. */
function premiseProblems(agent: string): string[] {
  const consumer = agent.indexOf(CONSUMER);
  if (consumer < 0) return ["startConsumer was not found"];
  const start = agent.indexOf(HANDLER, consumer);
  if (start < 0) return ["the job handler was not found"];
  const loop = agent.indexOf("runChatLoop(", start);
  if (loop < 0) return ["no runChatLoop( in the handler"];
  const problems: string[] = [];
  const created = agent.slice(start, loop).match(/createRunContext\(/g) ?? [];
  if (created.length !== 1) {
    problems.push(`${created.length} createRunContext( calls before the loop, not 1`);
  }
  const call = agent.slice(loop, agent.indexOf("});", loop));
  if (!/\n\s*runContext,\n/.test(call)) problems.push("the loop is not handed runContext");
  return problems;
}

describe("a queue job's payload tags its run's first context (premise)", () => {
  test("holds for the emitted worker", () => {
    const agent = agentOf();
    expect(agent).toContain(CONSUMER);
    expect(agent).toContain(HANDLER);
    expect(premiseProblems(agent)).toEqual([]);
  });

  test("fails on a context created before the run's own", () => {
    const agent = agentOf();
    const planted = agent.replace(HANDLER, `${HANDLER}\n      const early = createRunContext();`);
    expect(planted).not.toBe(agent);
    expect(premiseProblems(planted)).toEqual(["2 createRunContext( calls before the loop, not 1"]);
  });

  test("fails when the loop is not handed the run's context", () => {
    const agent = agentOf();
    const planted = agent.replace(/\n(\s*)runContext,\n(\s*)sessionName/, "\n$2sessionName");
    expect(planted).not.toBe(agent);
    expect(premiseProblems(planted)).toEqual(["the loop is not handed runContext"]);
  });
});
