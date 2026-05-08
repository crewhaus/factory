import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_CODE_SYSTEM_PREFIX } from "./client.js";
import { rawEventToCanonical, toAnthropicParams } from "./translate.js";
import type { ProviderRequest } from "./types.js";

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

  test("omits tools key entirely when empty", () => {
    const params = toAnthropicParams({ ...baseReq, tools: [] }, false);
    expect(params.tools).toBeUndefined();
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
    } as Anthropic.RawMessageStreamEvent);
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
    } as Anthropic.RawMessageStreamEvent);
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
    } as Anthropic.RawMessageStreamEvent);
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
    } as Anthropic.RawMessageStreamEvent);
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
    } as Anthropic.RawMessageStreamEvent);
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
});
