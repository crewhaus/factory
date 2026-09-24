import { describe, expect, test } from "bun:test";
import {
  PROVIDER_TOOL_LIMITS,
  describeToolLimitOverrun,
  providerToolLimit,
  toolLimitOverrun,
} from "./tool-limits";

describe("providerToolLimit (provider-limits#0)", () => {
  test("the routes that serve OpenAI's chat API take 128 tools", () => {
    for (const model of ["openai/gpt-5", "azure/my-deployment", "groq/llama-3.3-70b"]) {
      expect({ model, max: providerToolLimit(model)?.maxTools }).toEqual({ model, max: 128 });
    }
  });

  test("the Gemini API takes 512, direct or on Vertex AI", () => {
    for (const model of ["gemini/gemini-2.5-pro", "vertex/gemini-2.5-flash", "vertex/gemma-3"]) {
      expect({ model, max: providerToolLimit(model)?.maxTools }).toEqual({ model, max: 512 });
    }
  });

  test("routes with no known cap are not checked", () => {
    for (const model of [
      "claude-sonnet-4-6",
      "vertex/claude-sonnet-4-6",
      "bedrock/anthropic.claude-sonnet-4-6",
      "local/llama3.2",
      "local/qwen@http://127.0.0.1:8000/v1",
      "together/meta-llama/Llama-3-70b",
      "openrouter/openai/gpt-5",
    ]) {
      expect({ model, limit: providerToolLimit(model) }).toEqual({ model, limit: undefined });
    }
  });

  test("the table has exactly the rows the module documents", () => {
    // runtime-core's tool-limit test holds each row to a route the model
    // router parses; this pins the set so a dropped row cannot pass silently.
    expect(Object.keys(PROVIDER_TOOL_LIMITS).sort()).toEqual([
      "azure/",
      "gemini/",
      "groq/",
      "openai/",
      "vertex/gemini-",
      "vertex/gemma-",
    ]);
  });
});

describe("toolLimitOverrun", () => {
  test("the limit itself is allowed; one more is an overrun", () => {
    expect(toolLimitOverrun("openai/gpt-5", 128)).toBeUndefined();
    expect(toolLimitOverrun("openai/gpt-5", 129)).toEqual({
      model: "openai/gpt-5",
      toolCount: 129,
      limit: { maxTools: 128, enforcedBy: "OpenAI" },
    });
    expect(toolLimitOverrun("claude-sonnet-4-6", 5000)).toBeUndefined();
  });

  test("the message names the count, the limit, who enforces it and the model", () => {
    const o = toolLimitOverrun("gemini/gemini-2.5-pro", 552);
    expect(o).toBeDefined();
    if (o === undefined) return;
    expect(describeToolLimitOverrun(o, "from tools:")).toBe(
      '552 tools (from tools:) exceed the 512-tool limit Gemini puts on one request, so every call to model "gemini/gemini-2.5-pro" is refused',
    );
  });
});
