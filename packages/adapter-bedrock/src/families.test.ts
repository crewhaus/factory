import { describe, expect, test } from "bun:test";
import { EFFORT_THINKING_BUDGET_TOKENS, type ProviderRequest } from "@crewhaus/adapter-anthropic";
import {
  ANTHROPIC_BEDROCK_VERSION,
  buildAnthropicBedrockBody,
  decodeAnthropicBedrockChunk,
} from "./families/anthropic.js";

const baseReq: ProviderRequest = {
  model: "irrelevant",
  system: [{ type: "text", text: "be helpful" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 256,
};

describe("anthropic-on-bedrock body", () => {
  test("includes anthropic_version, max_tokens, system, messages", () => {
    const body = buildAnthropicBedrockBody(baseReq);
    expect(body.anthropic_version).toBe(ANTHROPIC_BEDROCK_VERSION);
    expect(body.max_tokens).toBe(256);
    expect(body.system).toEqual([{ type: "text", text: "be helpful" }]);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("strips empty system", () => {
    const body = buildAnthropicBedrockBody({ ...baseReq, system: [] });
    expect(body.system).toBeUndefined();
  });

  test("threads tools + tool_choice=tool + thinking", () => {
    const body = buildAnthropicBedrockBody({
      ...baseReq,
      tools: [{ name: "Read", description: "x", input_schema: { type: "object" } }],
      toolChoice: { type: "tool", name: "Read" },
      thinking: { type: "enabled", budgetTokens: 1024 },
    });
    expect(body.tools).toEqual([
      { name: "Read", description: "x", input_schema: { type: "object" } },
    ]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "Read" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("reasoningEffort converts to budget_tokens via the shared preset table", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const body = buildAnthropicBedrockBody({ ...baseReq, reasoningEffort: effort });
      expect(body.thinking).toEqual({
        type: "enabled",
        budget_tokens: EFFORT_THINKING_BUDGET_TOKENS[effort],
      });
    }
  });

  test("explicit thinking budget wins over reasoningEffort", () => {
    const body = buildAnthropicBedrockBody({
      ...baseReq,
      thinking: { type: "enabled", budgetTokens: 4096 },
      reasoningEffort: "high",
    });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  test("non-tool tool_choice (auto/any) passes only the type through", () => {
    const auto = buildAnthropicBedrockBody({ ...baseReq, toolChoice: { type: "auto" } });
    expect(auto.tool_choice).toEqual({ type: "auto" });
    const any = buildAnthropicBedrockBody({ ...baseReq, toolChoice: { type: "any" } });
    expect(any.tool_choice).toEqual({ type: "any" });
  });

  test("omits tools when the array is empty and tool_choice when absent", () => {
    const body = buildAnthropicBedrockBody({ ...baseReq, tools: [] });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  test("decodeAnthropicBedrockChunk delegates to rawEventToCanonical", () => {
    // A standard Anthropic raw event decodes to its canonical form.
    const ev = decodeAnthropicBedrockChunk({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    });
    expect(ev).toEqual({
      kind: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    });
    // message_stop is embedded in the raw stream and maps 1:1.
    expect(decodeAnthropicBedrockChunk({ type: "message_stop" })).toEqual({ kind: "message_stop" });
    // Dropped events return null (e.g. ping is not a canonical event).
    expect(decodeAnthropicBedrockChunk({ type: "ping" })).toBeNull();
  });
});

describe("anthropic-on-bedrock body — temperature (NEW-HUNT-2)", () => {
  test("maps req.temperature when no thinking control is set", () => {
    expect(buildAnthropicBedrockBody({ ...baseReq, temperature: 0 }).temperature).toBe(0);
    expect(buildAnthropicBedrockBody({ ...baseReq, temperature: 0.7 }).temperature).toBe(0.7);
  });

  test("drops temperature alongside thinking / reasoningEffort (API rejects the combination)", () => {
    const withThinking = buildAnthropicBedrockBody({
      ...baseReq,
      temperature: 0,
      thinking: { type: "enabled", budgetTokens: 1024 },
    });
    expect(withThinking.temperature).toBeUndefined();
    const withEffort = buildAnthropicBedrockBody({
      ...baseReq,
      temperature: 0,
      reasoningEffort: "low",
    });
    expect(withEffort.temperature).toBeUndefined();
  });

  test("omits temperature entirely when the request carries none", () => {
    expect("temperature" in buildAnthropicBedrockBody(baseReq)).toBe(false);
  });

  test("drops temperature for Bedrock Claude ids that reject the parameter (#413)", () => {
    for (const model of [
      "anthropic.claude-sonnet-5",
      "anthropic.claude-opus-5",
      "us.anthropic.claude-opus-4-7",
    ]) {
      expect(
        buildAnthropicBedrockBody({ ...baseReq, model, temperature: 0 }).temperature,
      ).toBeUndefined();
    }
    // Pre-4.7 Claude ids keep the pin — the constraint starts at Opus 4.7.
    expect(
      buildAnthropicBedrockBody({
        ...baseReq,
        model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        temperature: 0,
      }).temperature,
    ).toBe(0);
  });
});
