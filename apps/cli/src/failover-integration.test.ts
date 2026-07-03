/**
 * Item 22 — integration: a LOWERED SPEC drives the failover chain.
 *
 * The unit layers are covered in their own packages (spec parse in
 * packages/spec, lowering + codegen round-trip in packages/compiler, chain
 * routing in packages/model-router, live-loop behaviour in
 * packages/runtime-core). This test walks the same path `crewhaus run`
 * does: YAML → parseSpec → lower → thread `ir.agent.modelFallbacks` +
 * `ir.agent.circuitBreaker` into the runtime seam — proving the spec's
 * declaration is what actually constructs and drives the chain.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { lower, parseSpec } from "@crewhaus/compiler";
import { createFailoverChain } from "@crewhaus/model-router";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import type { ModelFailoverEvent, TraceEvent } from "@crewhaus/trace-event-bus";

const SHARED_SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-failover-int-tests-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SHARED_SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
});

const FAILOVER_SPEC = `
name: failover-int
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be resilient
  model_fallbacks:
    - openai/gpt-4o-mini
  circuit_breaker:
    failureThreshold: 1
    cooldownMs: 60000
`;

function stubAdapter(opts: {
  providerId: "anthropic" | "openai";
  failing?: boolean;
  text?: string;
}): ProviderAdapter {
  return {
    providerId: opts.providerId,
    features: {
      caching: opts.providerId === "anthropic" ? "explicit" : "automatic",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(_req: ProviderRequest): AsyncIterable<StreamEvent> {
      return (async function* () {
        if (opts.failing === true) {
          const err = new Error("scripted outage") as Error & { error: { type: string } };
          err.error = { type: "max_output_tokens" };
          throw err;
        }
        yield { kind: "message_start", usage: { input: 1, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: opts.text ?? "ok" },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 1, output: 1 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

describe("failover chain from a lowered spec (item 22)", () => {
  test("lowered IR fields construct a chain with the spec's candidates + tuning", async () => {
    const ir = lower(parseSpec(FAILOVER_SPEC));
    if (ir.target !== "cli") throw new Error("unexpected target");
    const modelFallbacks = ir.agent.modelFallbacks;
    const circuitBreaker = ir.agent.circuitBreaker;
    if (modelFallbacks === undefined || circuitBreaker === undefined) {
      throw new Error("lowering dropped the failover fields");
    }
    const chain = await createFailoverChain({
      model: ir.agent.model,
      fallbacks: modelFallbacks,
      breaker: circuitBreaker,
      adapters: new Map<string, ProviderAdapter>([
        [ir.agent.model, stubAdapter({ providerId: "anthropic" })],
        ["openai/gpt-4o-mini", stubAdapter({ providerId: "openai" })],
      ]),
    });
    expect(chain.candidates().map((c) => c.modelString)).toEqual([
      "claude-sonnet-4-6",
      "openai/gpt-4o-mini",
    ]);
    expect(chain.warnings()).toEqual([]);
    expect(chain.plan().modelId).toBe("claude-sonnet-4-6");
  });

  test("threading the lowered fields into runChatLoop fails over exactly as declared", async () => {
    const ir = lower(parseSpec(FAILOVER_SPEC));
    if (ir.target !== "cli") throw new Error("unexpected target");
    const runContext = createRunContext();
    const failovers: ModelFailoverEvent[] = [];
    runContext.eventBus.subscribe((e: TraceEvent) => {
      if (e.kind === "model_failover") failovers.push(e);
    });
    // Mirror runRun's opts threading (apps/cli runRun → runChatLoop).
    const finalText = await runChatLoop({
      model: ir.agent.model,
      instructions: ir.agent.instructions,
      ...(ir.agent.modelFallbacks !== undefined && ir.agent.modelFallbacks.length > 0
        ? { modelFallbacks: ir.agent.modelFallbacks }
        : {}),
      ...(ir.agent.circuitBreaker !== undefined ? { circuitBreaker: ir.agent.circuitBreaker } : {}),
      _adapter: stubAdapter({ providerId: "anthropic", failing: true }),
      _failoverAdapters: new Map([
        ["openai/gpt-4o-mini", stubAdapter({ providerId: "openai", text: "fallback text" })],
      ]),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
    });
    expect(finalText).toBe("fallback text");
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({
      from: "claude-sonnet-4-6",
      to: "openai/gpt-4o-mini",
      reason: "breaker_open",
    });
  });
});
