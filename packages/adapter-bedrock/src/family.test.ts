import { describe, expect, test } from "bun:test";
import { detectFamily, featuresForFamily } from "./family.js";

describe("detectFamily", () => {
  test("anthropic models", () => {
    expect(detectFamily("anthropic.claude-sonnet-4-v1:0")).toBe("anthropic");
    expect(detectFamily("anthropic.claude-3-5-haiku-20241022-v1:0")).toBe("anthropic");
  });
  test("llama models", () => {
    expect(detectFamily("meta.llama3-1-8b-instruct-v1:0")).toBe("llama");
    expect(detectFamily("meta.llama3-70b-instruct-v1:0")).toBe("llama");
  });
  test("mistral models", () => {
    expect(detectFamily("mistral.mistral-large-2402-v1:0")).toBe("mistral");
    expect(detectFamily("mistral.mixtral-8x7b-instruct-v0:1")).toBe("mistral");
  });

  // Converse-only families. Twin vectors: model-router/src/parse.test.ts
  // — keep in sync.
  test("nova models", () => {
    expect(detectFamily("amazon.nova-pro-v1:0")).toBe("nova");
    expect(detectFamily("amazon.nova-lite-v1:0")).toBe("nova");
  });
  test("titan text models", () => {
    expect(detectFamily("amazon.titan-text-express-v1")).toBe("titan");
    expect(detectFamily("amazon.titan-text-premier-v1:0")).toBe("titan");
  });
  test("deepseek models", () => {
    expect(detectFamily("deepseek.r1-v1:0")).toBe("deepseek");
  });
  test("cohere command models", () => {
    expect(detectFamily("cohere.command-r-v1:0")).toBe("cohere");
    expect(detectFamily("cohere.command-r-plus-v1:0")).toBe("cohere");
  });
  test("ai21 models", () => {
    expect(detectFamily("ai21.jamba-1-5-large-v1:0")).toBe("ai21");
  });
  test("qwen models", () => {
    expect(detectFamily("qwen.qwen3-32b-v1:0")).toBe("qwen");
  });
  test("gpt-oss models", () => {
    expect(detectFamily("openai.gpt-oss-120b-1:0")).toBe("gpt-oss");
  });
  test("writer models", () => {
    expect(detectFamily("writer.palmyra-x5-v1:0")).toBe("writer");
  });

  test("unknown families surface as 'unknown'", () => {
    // Vendor segments are not enough: non-chat siblings stay rejected.
    expect(detectFamily("amazon.titan-embed-text-v2:0")).toBe("unknown");
    expect(detectFamily("cohere.embed-english-v3")).toBe("unknown");
    expect(detectFamily("stability.stable-diffusion-xl-v1")).toBe("unknown");
  });

  // Cross-region inference-profile ids. Twin vectors:
  // model-router/src/parse.test.ts — keep in sync.
  test("geo-prefixed inference-profile ids resolve to their family", () => {
    expect(detectFamily("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("anthropic");
    expect(detectFamily("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("anthropic");
    expect(detectFamily("apac.meta.llama3-2-90b-instruct-v1:0")).toBe("llama");
    expect(detectFamily("global.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("anthropic");
    expect(detectFamily("us-gov.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("anthropic");
    expect(detectFamily("us.mistral.pixtral-large-2502-v1:0")).toBe("mistral");
    expect(detectFamily("us.amazon.nova-pro-v1:0")).toBe("nova");
    expect(detectFamily("eu.deepseek.r1-v1:0")).toBe("deepseek");
    expect(detectFamily("us.openai.gpt-oss-120b-1:0")).toBe("gpt-oss");
  });
  test("geo prefix does not rescue unknown families", () => {
    expect(detectFamily("us.cohere.embed-english-v3")).toBe("unknown");
    expect(detectFamily("us.stability.stable-diffusion-xl-v1")).toBe("unknown");
  });
  test("non-geo segments are not stripped", () => {
    expect(detectFamily("used.anthropic.claude-x")).toBe("unknown");
  });
});

describe("featuresForFamily", () => {
  test("anthropic has tool_use + caching + thinking", () => {
    const f = featuresForFamily("anthropic");
    expect(f.tool_use).toBe(true);
    expect(f.caching).toBe("explicit");
    expect(f.thinking).toBe(true);
  });
  test("llama gains tool use via converse (no vision/caching/thinking)", () => {
    const f = featuresForFamily("llama");
    expect(f.tool_use).toBe(true);
    expect(f.caching).toBe(false);
    expect(f.vision).toBe(false);
    expect(f.thinking).toBe(false);
  });
  test("mistral gains tool use via converse (no vision)", () => {
    const f = featuresForFamily("mistral");
    expect(f.tool_use).toBe(true);
    expect(f.vision).toBe(false);
  });
  test("nova has tool use + vision", () => {
    const f = featuresForFamily("nova");
    expect(f.tool_use).toBe(true);
    expect(f.vision).toBe(true);
  });
  test("deepseek has thinking but no tool use", () => {
    const f = featuresForFamily("deepseek");
    expect(f.tool_use).toBe(false);
    expect(f.thinking).toBe(true);
  });
  test("cohere and qwen have tool use", () => {
    expect(featuresForFamily("cohere").tool_use).toBe(true);
    expect(featuresForFamily("qwen").tool_use).toBe(true);
  });
  test("gpt-oss has tool use + thinking", () => {
    const f = featuresForFamily("gpt-oss");
    expect(f.tool_use).toBe(true);
    expect(f.thinking).toBe(true);
  });
  test("titan, ai21, and writer are text-only", () => {
    for (const family of ["titan", "ai21", "writer"] as const) {
      const f = featuresForFamily(family);
      expect(f.tool_use).toBe(false);
      expect(f.vision).toBe(false);
      expect(f.caching).toBe(false);
      expect(f.thinking).toBe(false);
      expect(f.web_search).toBe(false);
    }
  });
});
