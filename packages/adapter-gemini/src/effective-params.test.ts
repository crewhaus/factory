/**
 * 0.6.0 §8.1 — Gemini maps every canonical knob natively, so `dropped` is
 * empty; an effort preset lowered to a token budget is a note.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderRequest } from "@crewhaus/adapter-anthropic";
import type { GoogleGenAI } from "@google/genai";
import { GeminiAdapter } from "./adapter";
import { geminiEffectiveParams } from "./translate";

const BASE: ProviderRequest = {
  model: "gemini-2.5-flash",
  system: [{ type: "text", text: "sys" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 1024,
};

describe("geminiEffectiveParams", () => {
  test("temperature and an explicit thinking budget both land; nothing dropped", () => {
    const ep = geminiEffectiveParams({
      ...BASE,
      temperature: 0,
      thinking: { type: "enabled", budgetTokens: 4096 },
    });
    expect(ep).toEqual({
      model: "gemini-2.5-flash",
      maxTokens: 1024,
      thinking: { type: "enabled", budgetTokens: 4096 },
      temperature: 0,
      dropped: [],
    });
  });

  test("an effort preset lowers to thinkingBudget with a note", () => {
    const ep = geminiEffectiveParams({ ...BASE, reasoningEffort: "medium" });
    expect(ep.thinking).toEqual({ type: "enabled", budgetTokens: 8192 });
    expect(ep.dropped).toEqual([]);
    expect(ep.notes?.[0]).toMatch(/thinkingConfig.thinkingBudget=8192/);
  });

  test("the adapter exposes the method without touching the client", () => {
    const client = {
      models: {
        generateContentStream: () => {
          throw new Error("must not be called");
        },
      },
    } as unknown as GoogleGenAI;
    const adapter = new GeminiAdapter({ client });
    expect(adapter.effectiveParams({ ...BASE, temperature: 0.3 }).temperature).toBe(0.3);
  });
});
