/**
 * 0.6.0 §8.1 — the breaker forwards `effectiveParams` when the wrapped adapter
 * has it, and stays without the method when it does not.
 */
import { describe, expect, test } from "bun:test";
import type {
  EffectiveParams,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { wrap } from "./index";

const REQ: ProviderRequest = {
  model: "claude-sonnet-5",
  system: [],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 64,
  temperature: 0,
};

function base(): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    async *stream(): AsyncIterable<StreamEvent> {
      yield { kind: "message_stop" };
    },
  };
}

describe("wrap() and effectiveParams", () => {
  test("forwards the wrapped adapter's projection verbatim", () => {
    const projected: EffectiveParams = {
      model: REQ.model,
      maxTokens: 64,
      dropped: ["temperature"],
    };
    const seen: ProviderRequest[] = [];
    const inner: ProviderAdapter = {
      ...base(),
      effectiveParams(req) {
        seen.push(req);
        return projected;
      },
    };
    const wrapped = wrap(inner);
    expect(wrapped.effectiveParams).toBeDefined();
    expect(wrapped.effectiveParams?.(REQ)).toBe(projected);
    expect(seen).toEqual([REQ]);
  });

  test("stays absent when the wrapped adapter lacks the method", () => {
    const wrapped = wrap(base());
    expect(wrapped.effectiveParams).toBeUndefined();
    expect("effectiveParams" in wrapped).toBe(false);
  });

  test("forwards even while the breaker is open (prediction is not a call)", () => {
    const inner: ProviderAdapter = {
      ...base(),
      effectiveParams: () => ({ model: "m", maxTokens: 1, dropped: [] }),
    };
    const wrapped = wrap(inner);
    wrapped.trip("test");
    expect(wrapped.state()).toBe("open");
    expect(wrapped.effectiveParams?.(REQ)?.model).toBe("m");
  });
});
