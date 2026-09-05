/**
 * 0.6.0 §8.1 — Bedrock projects whichever marshaller the family uses: the
 * Anthropic body (same #413 drop rules as adapter-anthropic) or Converse
 * (no reasoning control at all).
 */
import { describe, expect, test } from "bun:test";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { ProviderRequest } from "@crewhaus/adapter-anthropic";
import { BedrockAdapter } from "./adapter";
import { converseEffectiveParams } from "./converse";
import { anthropicBedrockEffectiveParams } from "./families/anthropic";

const BASE: ProviderRequest = {
  model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  system: [{ type: "text", text: "sys" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 2048,
};

describe("anthropicBedrockEffectiveParams", () => {
  test("Claude 4.5 on Bedrock keeps the temperature pin", () => {
    const ep = anthropicBedrockEffectiveParams({ ...BASE, temperature: 0 });
    expect(ep.dropped).toEqual([]);
    expect(ep.temperature).toBe(0);
    expect(ep.model).toBe(BASE.model);
  });

  test("Claude 5 on Bedrock drops it (#413 survives the regional prefix)", () => {
    const ep = anthropicBedrockEffectiveParams({
      ...BASE,
      model: "us.anthropic.claude-sonnet-5-20260201-v1:0",
      temperature: 0,
    });
    expect(ep.dropped).toContain("temperature");
    expect(ep.temperature).toBeUndefined();
  });

  test("effort preset → thinking budget with a note", () => {
    const ep = anthropicBedrockEffectiveParams({ ...BASE, reasoningEffort: "high" });
    expect(ep.thinking).toEqual({ type: "enabled", budgetTokens: 24576 });
    expect(ep.dropped).toEqual([]);
    expect(ep.notes?.[0]).toMatch(/budget_tokens=24576/);
  });
});

describe("converseEffectiveParams", () => {
  test("temperature maps; thinking and reasoningEffort are dropped", () => {
    const ep = converseEffectiveParams({
      ...BASE,
      model: "meta.llama3-1-70b-instruct-v1:0",
      temperature: 0.1,
      thinking: { type: "enabled", budgetTokens: 2048 },
      reasoningEffort: "low",
    });
    expect(ep.model).toBe("meta.llama3-1-70b-instruct-v1:0");
    expect(ep.maxTokens).toBe(2048);
    expect(ep.temperature).toBe(0.1);
    expect(ep.dropped).toEqual(["thinking", "reasoningEffort"]);
    expect(ep.notes?.[0]).toMatch(/Converse has no cross-vendor/);
  });

  test("nothing requested → nothing dropped", () => {
    expect(converseEffectiveParams({ ...BASE, model: "mistral.mistral-large-2407-v1:0" })).toEqual({
      model: "mistral.mistral-large-2407-v1:0",
      maxTokens: 2048,
      dropped: [],
    });
  });
});

describe("BedrockAdapter.effectiveParams", () => {
  const client = {
    send: () => {
      throw new Error("must not be called");
    },
  } as unknown as BedrockRuntimeClient;

  test("dispatches by family without touching the client", () => {
    const anthropic = new BedrockAdapter({ client, family: "anthropic" });
    expect(
      anthropic.effectiveParams({
        ...BASE,
        model: "anthropic.claude-opus-5-v1:0",
        temperature: 0,
      }).dropped,
    ).toEqual(["temperature"]);
    const llama = new BedrockAdapter({ client, family: "llama" });
    expect(
      llama.effectiveParams({
        ...BASE,
        model: "meta.llama3-1-8b-instruct-v1:0",
        reasoningEffort: "low",
      }).dropped,
    ).toEqual(["reasoningEffort"]);
  });
});
