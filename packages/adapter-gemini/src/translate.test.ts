import { describe, expect, test } from "bun:test";
import type { ProviderRequest } from "@crewhaus/adapter-anthropic";
import { FunctionCallingConfigMode } from "@google/genai";
import { toGeminiParams } from "./translate.js";

const baseReq: ProviderRequest = {
  model: "gemini-2.5-flash",
  system: [{ type: "text", text: "be helpful" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 1024,
};

describe("toGeminiParams", () => {
  test("system blocks become config.systemInstruction", () => {
    const params = toGeminiParams({
      ...baseReq,
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(params.config?.systemInstruction).toBe("first\n\nsecond");
  });

  test("user role 'user' translates to Gemini role 'user'", () => {
    const params = toGeminiParams(baseReq);
    expect((params.contents as { role?: string }[])[0]?.role).toBe("user");
    expect((params.contents as { parts?: { text?: string }[] }[])[0]?.parts?.[0]?.text).toBe("hi");
  });

  test("assistant role translates to Gemini role 'model'", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    });
    const contents = params.contents as { role?: string }[];
    expect(contents[0]?.role).toBe("user");
    expect(contents[1]?.role).toBe("model");
  });

  test("tool_use blocks become functionCall parts", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        { role: "user", content: "do X" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling..." },
            { type: "tool_use", id: "tu1", name: "Read", input: { path: "/tmp" } },
          ],
        },
      ],
    });
    const contents = params.contents as Array<{
      role?: string;
      parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
    }>;
    const assistantParts = contents[1]?.parts;
    expect(assistantParts).toBeDefined();
    expect(assistantParts?.[0]?.text).toBe("calling...");
    expect(assistantParts?.[1]?.functionCall).toEqual({ name: "Read", args: { path: "/tmp" } });
  });

  test("tool_result blocks become functionResponse parts", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents" }],
        },
      ],
    });
    const contents = params.contents as Array<{
      role?: string;
      parts?: Array<{ functionResponse?: { name?: string; response?: unknown } }>;
    }>;
    expect(contents[0]?.role).toBe("user");
    expect(contents[0]?.parts?.[0]?.functionResponse).toEqual({
      name: "tu1",
      response: { result: "file contents" },
    });
  });

  test("toolChoice 'tool' becomes ANY mode + allowedFunctionNames", () => {
    const params = toGeminiParams({
      ...baseReq,
      tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
      toolChoice: { type: "tool", name: "Read" },
    });
    expect(params.config?.toolConfig?.functionCallingConfig?.mode).toBe(
      FunctionCallingConfigMode.ANY,
    );
    expect(params.config?.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual([
      "Read",
    ]);
  });

  test("toolChoice 'auto' becomes AUTO mode", () => {
    const params = toGeminiParams({ ...baseReq, toolChoice: { type: "auto" } });
    expect(params.config?.toolConfig?.functionCallingConfig?.mode).toBe(
      FunctionCallingConfigMode.AUTO,
    );
  });

  test("thinking config flows through", () => {
    const params = toGeminiParams({
      ...baseReq,
      thinking: { type: "enabled", budgetTokens: 2048 },
    });
    expect(params.config?.thinkingConfig?.thinkingBudget).toBe(2048);
    expect(params.config?.thinkingConfig?.includeThoughts).toBe(true);
  });
});
