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
  test("unknown families surface as 'unknown'", () => {
    expect(detectFamily("amazon.titan-text-express-v1")).toBe("unknown");
    expect(detectFamily("cohere.command-r-v1:0")).toBe("unknown");
  });
});

describe("featuresForFamily", () => {
  test("anthropic has tool_use + caching + thinking", () => {
    const f = featuresForFamily("anthropic");
    expect(f.tool_use).toBe(true);
    expect(f.caching).toBe("explicit");
    expect(f.thinking).toBe(true);
  });
  test("llama is text-only", () => {
    const f = featuresForFamily("llama");
    expect(f.tool_use).toBe(false);
    expect(f.caching).toBe(false);
    expect(f.vision).toBe(false);
  });
  test("mistral is text-only (for now)", () => {
    const f = featuresForFamily("mistral");
    expect(f.tool_use).toBe(false);
  });
});
