/**
 * `buildRequestParams` (§4.4) — the per-candidate lift of runtime-core's
 * boot constants, plus the N1 `maxOutputTokens` clamp.
 */
import { describe, expect, test } from "bun:test";
import { EFFORT_THINKING_BUDGET_TOKENS } from "@crewhaus/adapter-anthropic";
import { buildRequestParams } from "./params";

describe("buildRequestParams", () => {
  test("bare profile inherits the run defaults", () => {
    expect(buildRequestParams({}, { maxTokens: 8192 })).toEqual({
      maxTokens: 8192,
      effectiveMaxTokens: 8192,
    });
  });

  test("budget-form thinking maps verbatim and lifts the ceiling when it crowds it out", () => {
    const p = buildRequestParams({ thinking: { budgetTokens: 16000 } }, { maxTokens: 8192 });
    expect(p.thinking).toEqual({ type: "enabled", budgetTokens: 16000 });
    expect(p.reasoningEffort).toBeUndefined();
    expect(p.maxTokens).toBe(8192);
    expect(p.effectiveMaxTokens).toBe(16000 + 8192);
  });

  test("effort form sets BOTH thinking (via the preset table) and reasoningEffort", () => {
    const p = buildRequestParams({ thinking: { effort: "high" } }, { maxTokens: 8192 });
    expect(p.thinking).toEqual({
      type: "enabled",
      budgetTokens: EFFORT_THINKING_BUDGET_TOKENS.high,
    });
    expect(p.reasoningEffort).toBe("high");
    expect(p.effectiveMaxTokens).toBe(EFFORT_THINKING_BUDGET_TOKENS.high + 8192);
  });

  test("a budget below the ceiling does not lift it", () => {
    const p = buildRequestParams({ thinking: { effort: "low" } }, { maxTokens: 8192 });
    expect(p.effectiveMaxTokens).toBe(8192);
  });

  test("profile fields override base field-by-field; temperature passes through", () => {
    const p = buildRequestParams(
      { maxTokens: 4096, temperature: 0 },
      { maxTokens: 8192, thinking: { effort: "medium" }, temperature: 0.7 },
    );
    expect(p.maxTokens).toBe(4096);
    expect(p.temperature).toBe(0);
    // base thinking still applies when the profile does not override it
    expect(p.reasoningEffort).toBe("medium");
  });

  test("N1 — maxTokens is clamped to the candidate's maxOutputTokens", () => {
    const p = buildRequestParams(
      { maxTokens: 64000 },
      { maxTokens: 8192 },
      { maxOutputTokens: 8192 },
    );
    expect(p.maxTokens).toBe(8192);
    expect(p.clampedTo).toBe(8192);
    expect(p.effectiveMaxTokens).toBe(8192);
  });

  test("N1 — the thinking lift never exceeds the output ceiling either", () => {
    const p = buildRequestParams(
      { thinking: { budgetTokens: 20000 } },
      { maxTokens: 8192 },
      { maxOutputTokens: 24000 },
    );
    expect(p.maxTokens).toBe(8192);
    expect(p.clampedTo).toBeUndefined();
    expect(p.effectiveMaxTokens).toBe(24000);
  });

  test("unknown maxOutputTokens leaves everything unclamped", () => {
    const p = buildRequestParams({ maxTokens: 100000 }, { maxTokens: 8192 }, {});
    expect(p.maxTokens).toBe(100000);
    expect(p.clampedTo).toBeUndefined();
  });
});
