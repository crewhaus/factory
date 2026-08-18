import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_CODE_SYSTEM_PREFIX } from "./client.js";
import {
  claudeRejectsTemperature,
  rawEventToCanonical,
  toAnthropicMessages,
  toAnthropicParams,
  toAnthropicSystem,
} from "./translate.js";
import {
  type CanonicalMessage,
  type CanonicalTextBlockParam,
  EFFORT_THINKING_BUDGET_TOKENS,
  type ProviderRequest,
} from "./types.js";

const baseReq: ProviderRequest = {
  model: "claude-sonnet-4-6",
  system: [{ type: "text", text: "you are helpful" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 1024,
};

describe("toAnthropicParams", () => {
  test("non-OAuth path passes the system blocks through unchanged", () => {
    const params = toAnthropicParams(baseReq, false);
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(params.max_tokens).toBe(1024);
    expect(params.system).toEqual([{ type: "text", text: "you are helpful" }]);
    expect(params.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("OAuth path prepends Claude Code system prefix", () => {
    const params = toAnthropicParams(baseReq, true);
    const sys = params.system as Anthropic.TextBlockParam[];
    expect(sys[0]?.text).toBe(CLAUDE_CODE_SYSTEM_PREFIX);
    expect(sys[1]?.text).toBe("you are helpful");
  });

  test("preserves cache_control markers on system blocks", () => {
    const req: ProviderRequest = {
      ...baseReq,
      system: [{ type: "text", text: "long instructions", cache_control: { type: "ephemeral" } }],
    };
    const params = toAnthropicParams(req, false);
    const sys = params.system as Anthropic.TextBlockParam[];
    expect(sys[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("translates tools and tool_choice", () => {
    const req: ProviderRequest = {
      ...baseReq,
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      toolChoice: { type: "tool", name: "Read" },
    };
    const params = toAnthropicParams(req, false);
    expect(params.tools).toEqual([
      {
        name: "Read",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ] as Anthropic.Tool[]);
    expect(params.tool_choice).toEqual({ type: "tool", name: "Read" });
  });

  test("translates thinking config", () => {
    const req: ProviderRequest = {
      ...baseReq,
      thinking: { type: "enabled", budgetTokens: 4096 },
    };
    const params = toAnthropicParams(req, false);
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  test("maps temperature onto the request (NEW-HUNT-2)", () => {
    const params = toAnthropicParams({ ...baseReq, temperature: 0 }, false);
    expect(params.temperature).toBe(0);
    const warm = toAnthropicParams({ ...baseReq, temperature: 0.7 }, false);
    expect(warm.temperature).toBe(0.7);
  });

  test("omits temperature when the request does not set it", () => {
    const params = toAnthropicParams(baseReq, false);
    expect("temperature" in params).toBe(false);
  });

  test("drops temperature when extended thinking is enabled (API constraint)", () => {
    const explicit = toAnthropicParams(
      { ...baseReq, temperature: 0, thinking: { type: "enabled", budgetTokens: 4096 } },
      false,
    );
    expect("temperature" in explicit).toBe(false);
    const viaEffort = toAnthropicParams(
      { ...baseReq, temperature: 0, reasoningEffort: "low" },
      false,
    );
    expect("temperature" in viaEffort).toBe(false);
  });

  test("drops temperature for models that reject the parameter (#413)", () => {
    for (const model of [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-fable-5",
      "claude-mythos-5",
      "claude-opus-4-7",
      "claude-opus-4-8",
    ]) {
      const params = toAnthropicParams({ ...baseReq, model, temperature: 0 }, false);
      expect("temperature" in params).toBe(false);
    }
  });

  test("keeps the pin for models that still accept it (#413)", () => {
    for (const model of [
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
    ]) {
      expect(toAnthropicParams({ ...baseReq, model, temperature: 0 }, false).temperature).toBe(0);
    }
  });
});

describe("claudeRejectsTemperature (#413)", () => {
  test("rejects: Opus 4.7+, the whole Claude 5 family, and future majors", () => {
    for (const model of [
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-mythos-5",
      // Future family members inherit the constraint, not the pin.
      "claude-haiku-5",
      "claude-sonnet-5-1",
    ]) {
      expect(claudeRejectsTemperature(model)).toBe(true);
    }
  });

  test("accepts: pre-4.7 Opus, Sonnet ≤ 4.6, Haiku 4.5 — dated ids included", () => {
    for (const model of [
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-opus-4-1-20250805",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ]) {
      expect(claudeRejectsTemperature(model)).toBe(false);
    }
  });

  test("a datestamp is not a minor version: claude-opus-4-20250514 is Opus 4.0", () => {
    expect(claudeRejectsTemperature("claude-opus-4-20250514")).toBe(false);
    expect(claudeRejectsTemperature("claude-sonnet-4-20250514")).toBe(false);
  });

  test("Bedrock prefixes and suffixes don't defeat the match", () => {
    expect(claudeRejectsTemperature("anthropic.claude-sonnet-5")).toBe(true);
    expect(claudeRejectsTemperature("us.anthropic.claude-opus-5")).toBe(true);
    expect(claudeRejectsTemperature("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(false);
  });

  test("legacy number-first ids and non-Claude models keep the pin", () => {
    for (const model of [
      "claude-3-5-sonnet-20241022",
      "claude-3-7-sonnet-20250219",
      "claude-2.1",
      "gpt-4o-mini",
      "gemini-2.0-flash",
      "meta.llama3-1-70b-instruct-v1:0",
    ]) {
      expect(claudeRejectsTemperature(model)).toBe(false);
    }
  });

  test("omits tools key entirely when empty", () => {
    const params = toAnthropicParams({ ...baseReq, tools: [] }, false);
    expect(params.tools).toBeUndefined();
  });

  test("omits tools key when tools is undefined", () => {
    const params = toAnthropicParams(baseReq, false);
    expect(params.tools).toBeUndefined();
    expect(params.tool_choice).toBeUndefined();
    expect(params.thinking).toBeUndefined();
  });

  test("tool_choice auto translates", () => {
    const params = toAnthropicParams({ ...baseReq, toolChoice: { type: "auto" } }, false);
    expect(params.tool_choice).toEqual({ type: "auto" });
  });

  test("tool_choice any translates", () => {
    const params = toAnthropicParams({ ...baseReq, toolChoice: { type: "any" } }, false);
    expect(params.tool_choice).toEqual({ type: "any" });
  });
});

describe("rawEventToCanonical", () => {
  test("message_start carries usage", () => {
    const ev = rawEventToCanonical({
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 0,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        },
      },
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({
      kind: "message_start",
      usage: { input: 12, output: 0, cacheRead: 5, cacheCreate: 3 },
    });
  });

  test("content_block_start text → canonical text block", () => {
    const ev = rawEventToCanonical({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: "",
      } as Anthropic.RawContentBlockStartEvent["content_block"],
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({
      kind: "content_block_start",
      index: 0,
      block: { type: "text", text: "" },
    });
  });

  test("content_block_start tool_use → canonical tool_use block", () => {
    const ev = rawEventToCanonical({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: "Read",
        input: {},
      } as Anthropic.RawContentBlockStartEvent["content_block"],
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({
      kind: "content_block_start",
      index: 1,
      block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    });
  });

  test("text_delta passes text through", () => {
    const ev = rawEventToCanonical({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({
      kind: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    });
  });

  test("input_json_delta passes partial_json through", () => {
    const ev = rawEventToCanonical({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"x":' },
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({
      kind: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"x":' },
    });
  });

  test("message_delta surfaces stop_reason and running output token count", () => {
    const ev = rawEventToCanonical({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 30 },
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({
      kind: "message_delta",
      stopReason: "end_turn",
      usage: { input: 0, output: 30 },
    });
  });

  test("message_stop yields canonical message_stop", () => {
    const ev = rawEventToCanonical({ type: "message_stop" } as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({ kind: "message_stop" });
  });

  test("message_start with null cache fields omits cacheRead/cacheCreate", () => {
    const ev = rawEventToCanonical({
      type: "message_start",
      message: {
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({ kind: "message_start", usage: { input: 7, output: 0 } });
  });

  test("content_block_start thinking → canonical thinking block (with signature)", () => {
    const ev = rawEventToCanonical({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "thinking",
        thinking: "let me reason",
        signature: "sig-abc",
      } as Anthropic.RawContentBlockStartEvent["content_block"],
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({
      kind: "content_block_start",
      index: 0,
      block: { type: "thinking", thinking: "let me reason", signature: "sig-abc" },
    });
  });

  test("content_block_start thinking without signature omits the field", () => {
    const ev = rawEventToCanonical({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "thinking",
        thinking: "partial",
        signature: "",
      } as Anthropic.RawContentBlockStartEvent["content_block"],
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({
      kind: "content_block_start",
      index: 0,
      block: { type: "thinking", thinking: "partial" },
    });
  });

  test("content_block_start with unmapped block type → null (dropped)", () => {
    const ev = rawEventToCanonical({
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "server_tool_use",
        id: "srv_1",
        name: "web_search",
        input: {},
      } as unknown as Anthropic.RawContentBlockStartEvent["content_block"],
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toBeNull();
  });

  test("thinking_delta passes thinking text through", () => {
    const ev = rawEventToCanonical({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "more thought" },
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({
      kind: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "more thought" },
    });
  });

  test("signature_delta passes signature through", () => {
    const ev = rawEventToCanonical({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "final-sig" },
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({
      kind: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "final-sig" },
    });
  });

  test("unmapped content_block_delta type → null (dropped)", () => {
    const ev = rawEventToCanonical({
      type: "content_block_delta",
      index: 0,
      delta: { type: "citations_delta", citation: {} },
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toBeNull();
  });

  test("message_delta without stop_reason or usage yields bare kind", () => {
    const ev = rawEventToCanonical({
      type: "message_delta",
      delta: { stop_reason: null, stop_sequence: null },
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({ kind: "message_delta" });
  });

  test("message_delta usage with missing output_tokens defaults output to 0", () => {
    const ev = rawEventToCanonical({
      type: "message_delta",
      delta: { stop_reason: null, stop_sequence: null },
      usage: {},
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toEqual({ kind: "message_delta", usage: { input: 0, output: 0 } });
  });

  test("unknown top-level event type → null (dropped)", () => {
    const ev = rawEventToCanonical({
      type: "ping",
    } as unknown as Anthropic.RawMessageStreamEvent);
    expect(ev).toBeNull();
  });
});

describe("toAnthropicMessages", () => {
  test("passes the canonical message array through unchanged", () => {
    const messages: CanonicalMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const out = toAnthropicMessages(messages);
    expect(out).toEqual(messages as unknown as Anthropic.MessageParam[]);
  });
});

describe("toAnthropicSystem", () => {
  test("maps text blocks, dropping undefined cache_control", () => {
    const system: CanonicalTextBlockParam[] = [{ type: "text", text: "rules" }];
    expect(toAnthropicSystem(system)).toEqual([{ type: "text", text: "rules" }]);
  });

  test("preserves cache_control when present", () => {
    const system: CanonicalTextBlockParam[] = [
      { type: "text", text: "big context", cache_control: { type: "ephemeral" } },
    ];
    expect(toAnthropicSystem(system)).toEqual([
      { type: "text", text: "big context", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("preserves an explicit null cache_control", () => {
    const system: CanonicalTextBlockParam[] = [{ type: "text", text: "ctx", cache_control: null }];
    expect(toAnthropicSystem(system)).toEqual([{ type: "text", text: "ctx", cache_control: null }]);
  });
});

// ---------------------------------------------------------------------------
// Loop contract 0.4 (Batch A) — reasoningEffort → thinking budget presets.
// ---------------------------------------------------------------------------
describe("toAnthropicParams — reasoningEffort presets", () => {
  test.each([
    ["low", 2048],
    ["medium", 8192],
    ["high", 24576],
  ] as const)(
    "effort %s converts to budget_tokens %d via EFFORT_THINKING_BUDGET_TOKENS",
    (effort, budget) => {
      const req: ProviderRequest = { ...baseReq, reasoningEffort: effort };
      const params = toAnthropicParams(req, false);
      expect(params.thinking).toEqual({ type: "enabled", budget_tokens: budget });
      expect(EFFORT_THINKING_BUDGET_TOKENS[effort]).toBe(budget);
    },
  );

  test("an explicit thinking budget wins over reasoningEffort", () => {
    const req: ProviderRequest = {
      ...baseReq,
      thinking: { type: "enabled", budgetTokens: 4096 },
      reasoningEffort: "high",
    };
    const params = toAnthropicParams(req, false);
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  test("neither thinking nor reasoningEffort leaves thinking undefined", () => {
    const params = toAnthropicParams(baseReq, false);
    expect(params.thinking).toBeUndefined();
  });
});
