import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError, ProviderAuthError } from "@crewhaus/errors";
import { parseModelString } from "./parse.js";
import {
  clearAdapterCache,
  isLoopbackUrl,
  resolveModel,
  resolveOpenAICompatApiKey,
} from "./router.js";

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

  test("resolves named OpenAI-compatible hosts with the host's own key env", async () => {
    const r = await resolveModel("groq/llama-3.3-70b-versatile", {
      ...ENV,
      GROQ_API_KEY: "gsk-fake",
    });
    expect(r.providerId).toBe("openai");
    expect(r.modelId).toBe("llama-3.3-70b-versatile");
    expect(r.adapter.providerId).toBe("openai");
  });

  test("named host without its key env fails with ProviderAuthError naming it", async () => {
    // OPENAI_API_KEY being set must NOT satisfy a named host.
    await expect(resolveModel("groq/llama-3.3-70b-versatile", ENV)).rejects.toThrow(/GROQ_API_KEY/);
  });

  test("named hosts cache separately from openai/ and from each other", async () => {
    const env = { ...ENV, GROQ_API_KEY: "gsk-fake", XAI_API_KEY: "xai-fake" };
    const openai = await resolveModel("openai/gpt-4o-mini", env);
    const groqA = await resolveModel("groq/llama-3.3-70b-versatile", env);
    const groqB = await resolveModel("groq/qwen-2.5-coder-32b", env);
    const xai = await resolveModel("xai/grok-3-mini", env);
    expect(groqA.adapter).toBe(groqB.adapter);
    expect(groqA.adapter).not.toBe(openai.adapter);
    expect(groqA.adapter).not.toBe(xai.adapter);
  });

  test("local/<model> without @url defaults to the Ollama endpoint", async () => {
    const r = await resolveModel("local/llama3.2", { ...ENV, OPENAI_API_KEY: "" });
    expect(r.providerId).toBe("openai");
    expect(r.modelId).toBe("llama3.2");
  });

  test("azure/<deployment> resolves through the AzureOpenAI client", async () => {
    const r = await resolveModel("azure/my-gpt4o", {
      ...ENV,
      AZURE_OPENAI_ENDPOINT: "https://fake.openai.azure.com",
      AZURE_OPENAI_API_KEY: "azure-fake",
    });
    expect(r.providerId).toBe("openai");
    expect(r.modelId).toBe("my-gpt4o");
    expect(r.adapter.providerId).toBe("openai");
  });

  test("azure/<deployment> without endpoint/key fails with ProviderAuthError", async () => {
    await expect(resolveModel("azure/my-gpt4o", ENV)).rejects.toBeInstanceOf(ProviderAuthError);
  });

  test("vertex/gemini-* forces Vertex mode (project required)", async () => {
    const ok = await resolveModel("vertex/gemini-2.5-flash", {
      GOOGLE_CLOUD_PROJECT: "fake-project",
    });
    expect(ok.providerId).toBe("gemini");
    expect(ok.modelId).toBe("gemini-2.5-flash");
    clearAdapterCache();
    await expect(resolveModel("vertex/gemini-2.5-flash", {})).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
  });

  test("vertex/claude-* builds the Vertex-backed Anthropic adapter", async () => {
    const r = await resolveModel("vertex/claude-sonnet-4-6", {
      ANTHROPIC_VERTEX_PROJECT_ID: "fake-project",
    });
    expect(r.providerId).toBe("anthropic");
    expect(r.modelId).toBe("claude-sonnet-4-6");
    expect(r.adapter.providerId).toBe("anthropic");
  });

  test("vertex/claude-* without a project fails with ProviderAuthError", async () => {
    await expect(resolveModel("vertex/claude-sonnet-4-6", {})).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
  });

  test("vertex and direct Anthropic cache separately", async () => {
    const direct = await resolveModel("claude-sonnet-4-6", ENV);
    const vertex = await resolveModel("vertex/claude-sonnet-4-6", {
      ...ENV,
      ANTHROPIC_VERTEX_PROJECT_ID: "fake-project",
    });
    expect(direct.adapter).not.toBe(vertex.adapter);
  });
});

describe("isLoopbackUrl", () => {
  test("loopback hosts", () => {
    expect(isLoopbackUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:8000/v1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1234/v1")).toBe(true);
    expect(isLoopbackUrl("http://0.0.0.0:8080/v1")).toBe(true);
  });
  test("non-loopback hosts", () => {
    expect(isLoopbackUrl("https://api.groq.com/openai/v1")).toBe(false);
    expect(isLoopbackUrl("http://gpu-host.lan:11434/v1")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("resolveOpenAICompatApiKey", () => {
  function openaiParsed(modelString: string) {
    const parsed = parseModelString(modelString);
    if (parsed.providerId !== "openai") throw new Error("expected openai variant");
    return parsed;
  }

  test("local/ loopback URL inherits OPENAI_API_KEY (LiteLLM compat)", () => {
    const parsed = openaiParsed("local/gpt-4o@http://localhost:4000/v1");
    expect(resolveOpenAICompatApiKey(parsed, { OPENAI_API_KEY: "sk-real" })).toBe("sk-real");
    expect(resolveOpenAICompatApiKey(parsed, {})).toBe("local");
  });

  test("local/ non-loopback URL never receives OPENAI_API_KEY", () => {
    const parsed = openaiParsed("local/llama3.2@http://gpu-host.lan:11434/v1");
    // A spec-supplied remote URL must not be able to exfiltrate the key.
    expect(resolveOpenAICompatApiKey(parsed, { OPENAI_API_KEY: "sk-real" })).toBe("local");
    expect(
      resolveOpenAICompatApiKey(parsed, {
        OPENAI_API_KEY: "sk-real",
        CREWHAUS_LOCAL_API_KEY: "lan-key",
      }),
    ).toBe("lan-key");
  });

  test("plain openai/ leaves resolution to the adapter", () => {
    const parsed = openaiParsed("openai/gpt-4o-mini");
    expect(resolveOpenAICompatApiKey(parsed, { OPENAI_API_KEY: "sk-real" })).toBeUndefined();
  });
});
