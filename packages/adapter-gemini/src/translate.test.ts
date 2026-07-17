import { describe, expect, test } from "bun:test";
import { EFFORT_THINKING_BUDGET_TOKENS, type ProviderRequest } from "@crewhaus/adapter-anthropic";
import { ConfigError } from "@crewhaus/errors";
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

  test("tool_result functionResponse.name resolves to the declared function name, id carries the correlator", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "Read", input: { path: "/tmp" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents" }],
        },
      ],
    });
    const contents = params.contents as Array<{
      role?: string;
      parts?: Array<{ functionResponse?: { id?: string; name?: string; response?: unknown } }>;
    }>;
    expect(contents[2]?.role).toBe("user");
    expect(contents[2]?.parts?.[0]?.functionResponse).toEqual({
      name: "Read", // Gemini's contract: matches FunctionCall.name
      id: "tu1",
      response: { result: "file contents" },
    });
  });

  test("orphaned synthetic tool_use_ids fall back to stripping the gemini_<name>_<idx> shape", () => {
    // No prior assistant tool_use turn (e.g. trimmed by compaction) —
    // the function name is recovered from the synthetic id pattern.
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "gemini_my_tool_3", content: "ok" }],
        },
      ],
    });
    const fr = (
      params.contents as Array<{
        parts?: Array<{ functionResponse?: { id?: string; name?: string } }>;
      }>
    )[0]?.parts?.[0]?.functionResponse;
    expect(fr?.name).toBe("my_tool");
    expect(fr?.id).toBe("gemini_my_tool_3");
  });

  test("orphaned non-synthetic tool_use_ids pass through as the name unchanged", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
      ],
    });
    const fr = (
      params.contents as Array<{
        parts?: Array<{ functionResponse?: { id?: string; name?: string } }>;
      }>
    )[0]?.parts?.[0]?.functionResponse;
    expect(fr?.name).toBe("tu1");
    expect(fr?.id).toBe("tu1");
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

  test("reasoningEffort converts to a thinkingBudget via the shared preset table", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const params = toGeminiParams({ ...baseReq, reasoningEffort: effort });
      expect(params.config?.thinkingConfig?.thinkingBudget).toBe(
        EFFORT_THINKING_BUDGET_TOKENS[effort],
      );
      expect(params.config?.thinkingConfig?.includeThoughts).toBe(true);
    }
  });

  test("explicit thinking budget wins over reasoningEffort", () => {
    const params = toGeminiParams({
      ...baseReq,
      thinking: { type: "enabled", budgetTokens: 4096 },
      reasoningEffort: "high",
    });
    expect(params.config?.thinkingConfig?.thinkingBudget).toBe(4096);
  });

  test("neither thinking nor reasoningEffort → no thinkingConfig", () => {
    const params = toGeminiParams(baseReq);
    expect(params.config?.thinkingConfig).toBeUndefined();
  });

  test("empty system blocks are filtered and omit systemInstruction", () => {
    const params = toGeminiParams({ ...baseReq, system: [{ type: "text", text: "" }] });
    expect(params.config?.systemInstruction).toBeUndefined();
  });

  test("empty-text system blocks are dropped from the collapsed instruction", () => {
    const params = toGeminiParams({
      ...baseReq,
      system: [
        { type: "text", text: "keep" },
        { type: "text", text: "" },
        { type: "text", text: "also" },
      ],
    });
    expect(params.config?.systemInstruction).toBe("keep\n\nalso");
  });

  test("an abort signal is wired into config.abortSignal", () => {
    const controller = new AbortController();
    const params = toGeminiParams({ ...baseReq, signal: controller.signal });
    expect(params.config?.abortSignal).toBe(controller.signal);
  });

  test("toolChoice 'any' becomes ANY mode with no allowedFunctionNames", () => {
    const params = toGeminiParams({ ...baseReq, toolChoice: { type: "any" } });
    expect(params.config?.toolConfig?.functionCallingConfig?.mode).toBe(
      FunctionCallingConfigMode.ANY,
    );
    expect(params.config?.toolConfig?.functionCallingConfig?.allowedFunctionNames).toBeUndefined();
  });

  test("tools array is omitted when req.tools is empty", () => {
    const params = toGeminiParams({ ...baseReq, tools: [] });
    expect(params.config?.tools).toBeUndefined();
  });

  test("function declarations carry name, description, and schema", () => {
    const params = toGeminiParams({
      ...baseReq,
      tools: [
        {
          name: "Read",
          description: "read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });
    const decls = (
      params.config?.tools as Array<{
        functionDeclarations?: Array<{ name?: string; description?: string; parameters?: unknown }>;
      }>
    )?.[0]?.functionDeclarations;
    expect(decls?.[0]?.name).toBe("Read");
    expect(decls?.[0]?.description).toBe("read a file");
    expect(decls?.[0]?.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  test("base64 image blocks become inlineData parts", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJD" },
            },
          ],
        },
      ],
    });
    const parts = (
      params.contents as Array<{
        parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }>;
      }>
    )[0]?.parts;
    expect(parts?.[0]?.inlineData).toEqual({ mimeType: "image/png", data: "QUJD" });
  });

  test("URL image blocks fall back to a bracketed text reference", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://example.com/cat.png" } }],
        },
      ],
    });
    const parts = (params.contents as Array<{ parts?: Array<{ text?: string }> }>)[0]?.parts;
    expect(parts?.[0]?.text).toBe("[image: https://example.com/cat.png]");
  });

  test("thinking blocks become text parts flagged thought=true", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "let me reason" }],
        },
      ],
    });
    const parts = (
      params.contents as Array<{ parts?: Array<{ text?: string; thought?: boolean }> }>
    )[0]?.parts;
    expect(parts?.[0]).toEqual({ text: "let me reason", thought: true });
  });

  test("thinking blocks with a signature round-trip it as thoughtSignature", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me reason", signature: "c2lnbmF0dXJl" },
            { type: "tool_use", id: "tu1", name: "Read", input: {} },
          ],
        },
      ],
    });
    const parts = (
      params.contents as Array<{
        parts?: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }>;
      }>
    )[0]?.parts;
    expect(parts?.[0]).toEqual({
      text: "let me reason",
      thought: true,
      thoughtSignature: "c2lnbmF0dXJl",
    });
  });

  test("tool_result with structured (array) content joins text blocks", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu1",
              content: [
                { type: "text", text: "line one" },
                { type: "image", source: { type: "url", url: "https://x/y.png" } },
                { type: "text", text: "line two" },
              ],
            },
          ],
        },
      ],
    });
    const fr = (
      params.contents as Array<{ parts?: Array<{ functionResponse?: { response?: unknown } }> }>
    )[0]?.parts?.[0]?.functionResponse;
    // Only text blocks survive; the image block is dropped.
    expect(fr?.response).toEqual({ result: "line one\nline two" });
  });

  test("tool_result with undefined content yields an empty result string", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu1" }] }],
    });
    const fr = (
      params.contents as Array<{ parts?: Array<{ functionResponse?: { response?: unknown } }> }>
    )[0]?.parts?.[0]?.functionResponse;
    expect(fr?.response).toEqual({ result: "" });
  });

  test("tool_use blocks with undefined input default to empty args", () => {
    const params = toGeminiParams({
      ...baseReq,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "Ping", input: undefined }],
        },
      ],
    });
    const parts = (
      params.contents as Array<{
        parts?: Array<{ functionCall?: { name?: string; args?: unknown } }>;
      }>
    )[0]?.parts;
    expect(parts?.[0]?.functionCall).toEqual({ name: "Ping", args: {} });
  });

  test("no toolChoice leaves toolConfig unset", () => {
    const params = toGeminiParams(baseReq);
    expect(params.config?.toolConfig).toBeUndefined();
  });
});

describe("toGeminiParams — Gemma models", () => {
  test("system text is inlined as a leading [System] user turn instead of systemInstruction", () => {
    const params = toGeminiParams({
      ...baseReq,
      model: "gemma-3-27b-it",
      system: [{ type: "text", text: "be helpful" }],
    });
    expect(params.config?.systemInstruction).toBeUndefined();
    const contents = params.contents as Array<{ role?: string; parts?: Array<{ text?: string }> }>;
    expect(contents[0]?.role).toBe("user");
    expect(contents[0]?.parts?.[0]?.text).toBe("[System]\nbe helpful");
    // The original user turn follows the inlined system turn.
    expect(contents[1]?.parts?.[0]?.text).toBe("hi");
  });

  test("no system text means no synthetic leading turn", () => {
    const params = toGeminiParams({ ...baseReq, model: "gemma-3-27b-it", system: [] });
    const contents = params.contents as Array<{ parts?: Array<{ text?: string }> }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]?.parts?.[0]?.text).toBe("hi");
  });

  test("tools raise a ConfigError naming the Gemma limitation", () => {
    const attempt = () =>
      toGeminiParams({
        ...baseReq,
        model: "gemma-3-27b-it",
        tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
      });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/Gemma models do not support function calling/);
    expect(attempt).toThrow(/gemma-3-27b-it/);
  });

  test("an empty tools array does not trip the Gemma function-calling guard", () => {
    const params = toGeminiParams({ ...baseReq, model: "gemma-3-27b-it", tools: [] });
    expect(params.config?.tools).toBeUndefined();
  });
});
