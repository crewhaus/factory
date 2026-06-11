import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError } from "@crewhaus/errors";
import { clearAdapterCache, resolveModel } from "./router.js";

const ENV = {
  ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-fake",
  OPENAI_API_KEY: "sk-fake-openai",
  GEMINI_API_KEY: "fake-gemini",
};

describe("resolveModel", () => {
  beforeEach(() => clearAdapterCache());
  afterEach(() => clearAdapterCache());

  test("resolves Anthropic for unprefixed claude-* model strings", async () => {
    const r = await resolveModel("claude-sonnet-4-6", ENV);
    expect(r.providerId).toBe("anthropic");
    expect(r.modelId).toBe("claude-sonnet-4-6");
    expect(r.adapter.providerId).toBe("anthropic");
  });

  test("resolves OpenAI for openai/* model strings", async () => {
    const r = await resolveModel("openai/gpt-4o-mini", ENV);
    expect(r.providerId).toBe("openai");
    expect(r.modelId).toBe("gpt-4o-mini");
    expect(r.adapter.providerId).toBe("openai");
  });

  test("resolves OpenAI with baseURL for local/* model strings", async () => {
    const r = await resolveModel(
      "local/llama-3.1-8b@http://localhost:11434/v1",
      // local OpenAI-compatible servers don't need the api key — adapter
      // accepts the base URL alone.
      { ...ENV, OPENAI_API_KEY: "" },
    );
    expect(r.providerId).toBe("openai");
    expect(r.modelId).toBe("llama-3.1-8b");
    expect(r.adapter.providerId).toBe("openai");
  });

  test("resolves Gemini for gemini/* model strings", async () => {
    const r = await resolveModel("gemini/gemini-2.5-flash", ENV);
    expect(r.providerId).toBe("gemini");
    expect(r.modelId).toBe("gemini-2.5-flash");
    expect(r.adapter.providerId).toBe("gemini");
  });

  test("resolves Bedrock with detected family", async () => {
    // Bedrock adapter doesn't need any env at construction (uses
    // default AWS credential chain at request time).
    const r = await resolveModel("bedrock/anthropic.claude-sonnet-4-v1:0", ENV);
    expect(r.providerId).toBe("bedrock");
    expect(r.modelId).toBe("anthropic.claude-sonnet-4-v1:0");
    expect(r.adapter.providerId).toBe("bedrock");
  });

  test("caches adapter instances per (providerId, baseUrl, family)", async () => {
    const a = await resolveModel("claude-sonnet-4-6", ENV);
    const b = await resolveModel("claude-opus-4-7", ENV);
    // Same Anthropic adapter reused for any claude-* model.
    expect(a.adapter).toBe(b.adapter);
  });

  test("Bedrock cache keys on family", async () => {
    const a = await resolveModel("bedrock/anthropic.claude-sonnet-4-v1:0", ENV);
    const b = await resolveModel("bedrock/anthropic.claude-3-5-haiku-20241022-v1:0", ENV);
    const c = await resolveModel("bedrock/meta.llama3-1-8b-instruct-v1:0", ENV);
    expect(a.adapter).toBe(b.adapter); // same family → same instance
    expect(a.adapter).not.toBe(c.adapter); // different family → fresh instance
  });

  test("malformed model string surfaces ConfigError", async () => {
    await expect(resolveModel("notavalidmodel", ENV)).rejects.toBeInstanceOf(ConfigError);
  });
});
