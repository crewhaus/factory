/**
 * 0.6.0 §8.1 — `effectiveParams` projects the SAME marshaller `stream()` runs,
 * so the silent Claude-5 temperature drop (#413) becomes visible: `dropped`
 * contains `"temperature"` for a Claude-5 profile and is empty for Claude 4.5.
 */
import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicAdapter } from "./adapter";
import { anthropicEffectiveParams } from "./translate";
import type { ProviderRequest } from "./types";

const BASE: ProviderRequest = {
  model: "claude-haiku-4-5",
  system: [{ type: "text", text: "sys" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 4096,
};

describe("anthropicEffectiveParams", () => {
  test("Claude 4.5 profile with a pinned temperature: nothing dropped", () => {
    const ep = anthropicEffectiveParams({ ...BASE, temperature: 0 }, false);
    expect(ep).toEqual({ model: "claude-haiku-4-5", maxTokens: 4096, temperature: 0, dropped: [] });
  });

  test("Claude 5 profile with a pinned temperature: temperature dropped (#413)", () => {
    const ep = anthropicEffectiveParams(
      { ...BASE, model: "claude-sonnet-5", temperature: 0 },
      false,
    );
    expect(ep.dropped).toContain("temperature");
    expect(ep.temperature).toBeUndefined();
    expect(ep.notes?.[0]).toMatch(/rejects the temperature parameter/);
  });

  test("temperature alongside thinking is dropped with the thinking reason", () => {
    const ep = anthropicEffectiveParams(
      { ...BASE, temperature: 0.2, thinking: { type: "enabled", budgetTokens: 2048 } },
      false,
    );
    expect(ep.dropped).toEqual(["temperature"]);
    expect(ep.thinking).toEqual({ type: "enabled", budgetTokens: 2048 });
    expect(ep.notes?.[0]).toMatch(/alongside extended thinking/);
  });

  test("an effort preset is a conversion (note), not a drop", () => {
    const ep = anthropicEffectiveParams({ ...BASE, reasoningEffort: "low" }, false);
    expect(ep.dropped).toEqual([]);
    expect(ep.thinking).toEqual({ type: "enabled", budgetTokens: 2048 });
    expect(ep.reasoningEffort).toBeUndefined();
    expect(ep.notes?.[0]).toMatch(/lowered to thinking.budget_tokens=2048/);
  });

  test("no temperature requested → nothing to drop, no notes key", () => {
    const ep = anthropicEffectiveParams({ ...BASE, model: "claude-opus-5" }, false);
    expect(ep).toEqual({ model: "claude-opus-5", maxTokens: 4096, dropped: [] });
  });

  test("the adapter exposes the method and it is pure (no client call)", () => {
    const client = {
      messages: {
        create: () => {
          throw new Error("effectiveParams must not touch the network");
        },
      },
    } as unknown as Anthropic;
    const adapter = new AnthropicAdapter({ client, isOAuth: true });
    const ep = adapter.effectiveParams({ ...BASE, model: "claude-fable-5", temperature: 0 });
    expect(ep.dropped).toContain("temperature");
    expect(adapter.effectiveParams({ ...BASE, temperature: 0 }).dropped).toEqual([]);
  });
});
