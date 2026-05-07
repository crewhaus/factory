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
});
