import { describe, expect, test } from "bun:test";
import type { ProviderRequest } from "@crewhaus/adapter-anthropic";
import { toOpenAIChatParams } from "./translate.js";

const baseReq: ProviderRequest = {
  model: "gpt-4o-mini",
  system: [{ type: "text", text: "you are helpful" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 1024,
};

describe("toOpenAIChatParams", () => {
  test("collapses canonical system array into a leading system message", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(params.messages[0]).toEqual({ role: "system", content: "first\n\nsecond" });
  });

  test("strips empty system blocks", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      system: [
        { type: "text", text: "" },
        { type: "text", text: "real instruction" },
      ],
    });
    expect(params.messages[0]).toEqual({ role: "system", content: "real instruction" });
  });

  test("user message with text content passes through", () => {
    const params = toOpenAIChatParams(baseReq);
    expect(params.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("translates tools as function specs", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      toolChoice: { type: "tool", name: "Read" },
    });
    expect(params.tools).toEqual([
      {
        type: "function",
        function: {
          name: "Read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ]);
    expect(params.tool_choice).toEqual({ type: "function", function: { name: "Read" } });
  });

  test("toolChoice 'any' → 'required'", () => {
    const params = toOpenAIChatParams({ ...baseReq, toolChoice: { type: "any" } });
    expect(params.tool_choice).toBe("required");
  });

  test("assistant tool_use block → tool_calls on the assistant message", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "On it." },
            { type: "tool_use", id: "tu_1", name: "Read", input: { path: "/x" } },
          ],
        },
      ],
    });
    const assistant = params.messages[2] as { role: string; tool_calls?: unknown[] };
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls).toEqual([
      {
        id: "tu_1",
        type: "function",
        function: { name: "Read", arguments: JSON.stringify({ path: "/x" }) },
      },
    ]);
  });

  test("user tool_result block → separate tool message with tool_call_id", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }],
        },
      ],
    });
    expect(params.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "file contents",
    });
  });

  test("dropping cache_control markers (auto-cached on OpenAI)", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      system: [{ type: "text", text: "long sys", cache_control: { type: "ephemeral" } }],
    });
    // No cache_control in the OpenAI request anywhere.
    expect(JSON.stringify(params)).not.toContain("cache_control");
  });

  test("empty system array → no leading system message", () => {
    const params = toOpenAIChatParams({ ...baseReq, system: [] });
    expect(params.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  test("toolChoice 'auto' → 'auto'", () => {
    const params = toOpenAIChatParams({ ...baseReq, toolChoice: { type: "auto" } });
    expect(params.tool_choice).toBe("auto");
  });

  test("empty tools array is not forwarded", () => {
    const params = toOpenAIChatParams({ ...baseReq, tools: [] });
    expect(params.tools).toBeUndefined();
  });

  test("user image block (base64) → image_url data URI part", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look:" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
    });
    expect(params.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  test("user image block (url) → image_url with the raw url", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://img.example/p.png" } }],
        },
      ],
    });
    expect(params.messages[1]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://img.example/p.png" } }],
    });
  });

  test("text before a tool_result is flushed as a user message first (order preserved)", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "here is the result" },
            { type: "tool_result", tool_use_id: "tu_1", content: "OUTPUT" },
          ],
        },
      ],
    });
    // First the flushed user part, then the tool message.
    expect(params.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "here is the result" }],
    });
    expect(params.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "OUTPUT",
    });
  });

  test("text AFTER a tool_result is flushed as a trailing user message", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "OUTPUT" },
            { type: "text", text: "follow-up question" },
          ],
        },
      ],
    });
    expect(params.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "OUTPUT",
    });
    expect(params.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "follow-up question" }],
    });
  });

  test("tool_result with array content: text blocks joined, images dropped", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [
                { type: "text", text: "line one" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "ZZ" },
                },
                { type: "text", text: "line two" },
              ],
            },
          ],
        },
      ],
    });
    expect(params.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "line one\nline two",
    });
  });

  test("tool_result with undefined content → empty string", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1" }],
        },
      ],
    });
    expect(params.messages[1]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "" });
  });

  test("assistant message with plain string content passes through", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello there" },
      ],
    });
    expect(params.messages[2]).toEqual({ role: "assistant", content: "hello there" });
  });

  test("assistant block message with only tool_use → content null + tool_calls", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_9", name: "Run", input: { x: 1 } }],
        },
      ],
    });
    const assistant = params.messages[2] as {
      role: string;
      content: string | null;
      tool_calls?: unknown[];
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toEqual([
      {
        id: "tu_9",
        type: "function",
        function: { name: "Run", arguments: JSON.stringify({ x: 1 }) },
      },
    ]);
  });

  test("assistant tool_use with undefined input → arguments '{}'", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_0", name: "Noop", input: undefined }],
        },
      ],
    });
    const assistant = params.messages[2] as { tool_calls?: { function: { arguments: string } }[] };
    expect(assistant.tool_calls?.[0]?.function.arguments).toBe("{}");
  });
});
