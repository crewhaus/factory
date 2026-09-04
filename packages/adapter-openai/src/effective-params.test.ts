/**
 * 0.6.0 §8.1 — OpenAI's projection reads the wire body back so the private
 * `usesMaxCompletionTokens` gate is never re-derived elsewhere.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderRequest } from "@crewhaus/adapter-anthropic";
import type OpenAI from "openai";
import { OpenAIAdapter } from "./adapter";
import { openAIEffectiveParams } from "./translate";

const BASE: ProviderRequest = {
  model: "gpt-4o-mini",
  system: [{ type: "text", text: "sys" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 512,
};

describe("openAIEffectiveParams", () => {
  test("standard model: temperature sent, reasoning controls dropped", () => {
    const ep = openAIEffectiveParams({ ...BASE, temperature: 0, reasoningEffort: "high" });
    expect(ep.model).toBe("gpt-4o-mini");
    expect(ep.maxTokens).toBe(512);
    expect(ep.temperature).toBe(0);
    expect(ep.reasoningEffort).toBeUndefined();
    expect(ep.dropped).toEqual(["reasoningEffort"]);
  });

  test("reasoning model: temperature dropped, reasoning_effort sent, max_completion_tokens read", () => {
    const ep = openAIEffectiveParams({
      ...BASE,
      model: "gpt-5",
      temperature: 0,
      reasoningEffort: "low",
    });
    expect(ep.dropped).toContain("temperature");
    expect(ep.temperature).toBeUndefined();
    expect(ep.reasoningEffort).toBe("low");
    expect(ep.maxTokens).toBe(512);
  });

  test("reasoning model: a thinking budget is mapped to the nearest effort bucket (note)", () => {
    const ep = openAIEffectiveParams({
      ...BASE,
      model: "o3-mini",
      thinking: { type: "enabled", budgetTokens: 8000 },
    });
    expect(ep.reasoningEffort).toBe("medium");
    expect(ep.dropped).toEqual([]);
    expect(ep.notes?.[0]).toMatch(/nearest reasoning_effort bucket "medium"/);
  });

  test("standard model with a thinking budget drops it", () => {
    const ep = openAIEffectiveParams({
      ...BASE,
      thinking: { type: "enabled", budgetTokens: 2048 },
    });
    expect(ep.dropped).toEqual(["thinking"]);
    expect(ep.thinking).toBeUndefined();
  });

  test("nothing requested → nothing dropped", () => {
    expect(openAIEffectiveParams(BASE)).toEqual({
      model: "gpt-4o-mini",
      maxTokens: 512,
      dropped: [],
    });
  });

  test("the adapter exposes the method without touching the client", () => {
    const client = {
      chat: {
        completions: {
          create: () => {
            throw new Error("must not be called");
          },
        },
      },
    } as unknown as OpenAI;
    const adapter = new OpenAIAdapter({ client });
    expect(adapter.effectiveParams({ ...BASE, model: "o1", temperature: 0.5 }).dropped).toEqual([
      "temperature",
    ]);
  });
});
