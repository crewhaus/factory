import { describe, expect, test } from "bun:test";
import {
  PROVIDER_TOOL_LIMITS,
  describeToolLimitOverrun,
  limitIsUnverified,
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
    expect(toolLimitOverrun("azure/big", 129)).toEqual({
      model: "azure/big",
      toolCount: 129,
      limit: { maxTools: 128, enforcedBy: "Azure OpenAI" },
    });
    expect(toolLimitOverrun("openai/gpt-5", 129)?.limit.maxTools).toBe(128);
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

// provider-limits#0 — `openai/` honours OPENAI_BASE_URL (adapter-openai), the
// documented way to reach an OpenAI-compatible gateway or proxy (vLLM,
// LiteLLM), which sets its own limit. The 128 is api.openai.com's.
describe("the openai/ row is api.openai.com's limit", () => {
  test("it names the variable and the host, and only it is unverified at compile", () => {
    const rows = Object.entries(PROVIDER_TOOL_LIMITS).filter(([, l]) => limitIsUnverified(l));
    expect(rows.map(([prefix, l]) => [prefix, l.endpoint])).toEqual([
      ["openai/", { env: "OPENAI_BASE_URL", host: "api.openai.com" }],
    ]);
  });

  test("with the environment: unset, empty or api.openai.com keeps the limit", () => {
    for (const env of [
      {},
      { OPENAI_BASE_URL: "" },
      { OPENAI_BASE_URL: "https://api.openai.com/v1" },
      { OPENAI_BASE_URL: "https://API.OpenAI.com./v1" },
    ]) {
      expect({ env, max: providerToolLimit("openai/gpt-5", env)?.maxTools }).toEqual({
        env,
        max: 128,
      });
    }
  });

  test("with the environment: another server has no known limit", () => {
    for (const url of [
      "http://localhost:8000/v1",
      "https://litellm.corp.example/v1",
      "https://api.openai.com.evil.example/v1",
    ]) {
      const env = { OPENAI_BASE_URL: url };
      expect({ url, limit: providerToolLimit("openai/gpt-5", env) }).toEqual({
        url,
        limit: undefined,
      });
      expect(toolLimitOverrun("openai/gpt-5", 500, env)).toBeUndefined();
    }
  });

  test("OPENAI_BASE_URL moves only the openai/ route", () => {
    const env = { OPENAI_BASE_URL: "http://localhost:8000/v1" };
    for (const model of ["azure/big", "groq/llama-3.3-70b", "gemini/gemini-2.5-pro"]) {
      expect({ model, limit: providerToolLimit(model, env) }).toEqual({
        model,
        limit: providerToolLimit(model),
      });
    }
  });

  test("the message says whose limit it is", () => {
    const o = toolLimitOverrun("openai/gpt-5", 143);
    expect(o).toBeDefined();
    if (o === undefined) return;
    expect(describeToolLimitOverrun(o, "from tools:")).toBe(
      '143 tools (from tools:) exceed the 128-tool limit OpenAI puts on one request, so every call to model "openai/gpt-5" is refused by api.openai.com',
    );
  });
});
