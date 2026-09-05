/**
 * 0.6.0 §8.1 — a `FailoverChain` PREDICTS effective params against the
 * candidate `plan()` names, with the request rewritten for that candidate.
 */
import { describe, expect, test } from "bun:test";
import type {
  ProviderAdapter,
  ProviderFeatures,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { createFailoverChain } from "./failover";

const FEATURES: ProviderFeatures = {
  caching: "explicit",
  tool_use: true,
  vision: false,
  thinking: false,
  web_search: false,
};

/** Adapter whose projection echoes the wire model and drops temperature on Claude 5. */
function projectingAdapter(opts: {
  failing?: () => boolean;
  withProjection?: boolean;
}): ProviderAdapter {
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: FEATURES,
    estimateTokens: () => 0,
    async *stream(): AsyncIterable<StreamEvent> {
      if (opts.failing?.()) throw new Error("boom");
      yield { kind: "message_start", usage: { input: 1, output: 0 } };
      yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 1, output: 1 } };
      yield { kind: "message_stop" };
    },
  };
  if (opts.withProjection === false) return adapter;
  return {
    ...adapter,
    effectiveParams(req: ProviderRequest) {
      const rejects = /claude-(?:sonnet|opus|fable)-5/.test(req.model);
      return {
        model: req.model,
        maxTokens: req.maxTokens,
        ...(req.temperature !== undefined && !rejects ? { temperature: req.temperature } : {}),
        dropped: req.temperature !== undefined && rejects ? ["temperature" as const] : [],
      };
    },
  };
}

const REQ: ProviderRequest = {
  model: "ignored-by-chain",
  system: [{ type: "text", text: "sys" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 64,
  temperature: 0,
};

async function drain(it: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ of it) {
    // consume
  }
}

describe("FailoverChain.effectiveParams", () => {
  test("predicts against the primary with the request rewritten to its wire id", async () => {
    const chain = await createFailoverChain({
      model: "claude-haiku-4-5",
      fallbacks: ["claude-sonnet-5"],
      adapters: new Map([
        ["claude-haiku-4-5", projectingAdapter({})],
        ["claude-sonnet-5", projectingAdapter({})],
      ]),
    });
    const ep = chain.effectiveParams(REQ);
    expect(ep?.model).toBe("claude-haiku-4-5");
    expect(ep?.dropped).toEqual([]);
    expect(ep?.temperature).toBe(0);
  });

  test("after the primary's breaker opens, the prediction follows plan() to the fallback", async () => {
    let primaryFailing = true;
    const chain = await createFailoverChain({
      model: "claude-haiku-4-5",
      fallbacks: ["claude-sonnet-5"],
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
      adapters: new Map([
        ["claude-haiku-4-5", projectingAdapter({ failing: () => primaryFailing })],
        ["claude-sonnet-5", projectingAdapter({})],
      ]),
    });
    // First call: primary fails once (threshold 1) → breaker opens; the chain
    // itself retries down to the fallback? No — a failure inside the stream
    // surfaces; the NEXT call routes to the fallback. Trigger it.
    await drain(chain.stream(REQ)).catch(() => undefined);
    primaryFailing = false;
    expect(chain.plan().modelString).toBe("claude-sonnet-5");
    const ep = chain.effectiveParams(REQ);
    expect(ep?.model).toBe("claude-sonnet-5");
    // The Claude-5 fallback reports ITS OWN temperature drop — not the primary's.
    expect(ep?.dropped).toContain("temperature");
  });

  test("returns undefined when the planned candidate's adapter cannot project", async () => {
    const chain = await createFailoverChain({
      model: "claude-haiku-4-5",
      fallbacks: [],
      adapters: new Map([["claude-haiku-4-5", projectingAdapter({ withProjection: false })]]),
    });
    expect(chain.effectiveParams(REQ)).toBeUndefined();
  });
});
