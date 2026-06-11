/**
 * Regression — Section 27 cost tracking over the live `runChatLoop` path
 * with provider-prefixed spec model strings.
 *
 * `model_response` used to publish the raw spec string
 * (`"bedrock/us.anthropic.claude-…"`, `"openai/gpt-4o"`); cost-tracker
 * pricing keys are bare wire model ids, so every prefixed run was a
 * silent pricing miss charged $0 — only unprefixed `claude-*` strings
 * priced. These tests run the real loop (stub adapter) against a
 * cost-tracker on the run bus and assert non-zero cost, zero misses, and
 * the wire-id/spec-string split on the published events.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { createCostTracker } from "@crewhaus/cost-tracker";
import { createRunContext } from "@crewhaus/run-context";
import type {
  CostAccrualEvent,
  ModelResponseEvent,
  ProviderId,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { runChatLoop } from "./index";

const SHARED_SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-cost-wire-model-tests-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SHARED_SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
});

/** Single text-only turn: 100 input tokens, 10 output tokens. */
function makeTextAdapter(providerId: ProviderId): ProviderAdapter {
  return {
    providerId,
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream: () =>
      (async function* () {
        yield { kind: "message_start", usage: { input: 100, output: 0 } } as const;
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: "end_turn",
          usage: { input: 100, output: 10 },
        } as const;
        yield { kind: "message_stop" } as const;
      })(),
  };
}

async function runOnce(model: string, providerId: ProviderId) {
  const runContext = createRunContext();
  const seen: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => {
    seen.push(e);
  });
  const tracker = createCostTracker(runContext.eventBus);
  await runChatLoop({
    model,
    instructions: "test",
    _adapter: makeTextAdapter(providerId),
    runContext,
    singleTurn: true,
    seedMessages: [{ role: "user", content: "hello" }],
  });
  tracker.unsubscribe();
  const responses = seen.filter((e): e is ModelResponseEvent => e.kind === "model_response");
  const accruals = seen.filter((e): e is CostAccrualEvent => e.kind === "cost_accrual");
  return { tracker, responses, accruals, runId: runContext.eventBus.runId };
}

describe("cost tracking with provider-prefixed spec model strings", () => {
  test("bedrock inference-profile spec string prices — no $0 pricing miss", async () => {
    const spec = "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    const wire = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    const { tracker, responses, accruals, runId } = await runOnce(spec, "bedrock");

    expect(responses.length).toBe(1);
    expect(responses[0]?.model).toBe(wire);
    expect(responses[0]?.specModel).toBe(spec);

    expect(tracker.pricingMisses()).toBe(0);
    expect(tracker.observed()).toBe(1);
    // anthropic.claude-sonnet-4 row: 100 in × $3/M + 10 out × $15/M = 450 micros
    expect(tracker.getRunCost(runId).totalUsdMicros).toBe(450);
    expect(tracker.getRunCost(runId).byProvider.bedrock).toBe(450);

    expect(accruals.length).toBe(1);
    expect(accruals[0]?.modelId).toBe(wire);
    expect(accruals[0]?.specModel).toBe(spec);
    expect(accruals[0]?.costUsdMicros).toBe(450);
  });

  test("openai/* spec string prices — no $0 pricing miss", async () => {
    const { tracker, responses, accruals, runId } = await runOnce("openai/gpt-4o", "openai");

    expect(responses[0]?.model).toBe("gpt-4o");
    expect(responses[0]?.specModel).toBe("openai/gpt-4o");

    expect(tracker.pricingMisses()).toBe(0);
    // gpt-4o row: 100 in × $2.5/M + 10 out × $10/M = 350 micros
    expect(tracker.getRunCost(runId).byProvider.openai).toBe(350);
    expect(accruals[0]?.modelId).toBe("gpt-4o");
  });

  test("unprefixed claude-* spec string still prices; no specModel published", async () => {
    const { tracker, responses, accruals, runId } = await runOnce("claude-sonnet-4-6", "anthropic");

    expect(responses[0]?.model).toBe("claude-sonnet-4-6");
    expect(responses[0]?.specModel).toBeUndefined();

    expect(tracker.pricingMisses()).toBe(0);
    expect(tracker.getRunCost(runId).byProvider.anthropic).toBe(450);
    expect(accruals[0]?.specModel).toBeUndefined();
  });
});
