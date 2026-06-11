import { describe, expect, test } from "bun:test";
import { ConfigError } from "@crewhaus/errors";
import { parseModelString } from "./parse.js";

describe("parseModelString", () => {
  describe("anthropic (no prefix)", () => {
    test("claude-sonnet-4-6", () => {
      expect(parseModelString("claude-sonnet-4-6")).toEqual({
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
      });
    });
    test("claude-opus-4-7", () => {
      expect(parseModelString("claude-opus-4-7")).toEqual({
        providerId: "anthropic",
        modelId: "claude-opus-4-7",
      });
    });
  });

  describe("openai/", () => {
    test("openai/gpt-4o-mini", () => {
      expect(parseModelString("openai/gpt-4o-mini")).toEqual({
        providerId: "openai",
        modelId: "gpt-4o-mini",
      });
    });
    test("openai/o4-mini", () => {
      expect(parseModelString("openai/o4-mini")).toEqual({
        providerId: "openai",
        modelId: "o4-mini",
      });
    });
    test("rejects empty modelId", () => {
      expect(() => parseModelString("openai/")).toThrow(ConfigError);
    });
  });

  describe("gemini/", () => {
    test("gemini/gemini-2.5-flash", () => {
      expect(parseModelString("gemini/gemini-2.5-flash")).toEqual({
        providerId: "gemini",
        modelId: "gemini-2.5-flash",
      });
    });
    test("rejects empty modelId", () => {
      expect(() => parseModelString("gemini/")).toThrow(ConfigError);
    });
  });

  describe("bedrock/", () => {
    test("anthropic family", () => {
      expect(parseModelString("bedrock/anthropic.claude-sonnet-4-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "anthropic.claude-sonnet-4-v1:0",
        family: "anthropic",
      });
    });
    test("llama family", () => {
      expect(parseModelString("bedrock/meta.llama3-1-8b-instruct-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "meta.llama3-1-8b-instruct-v1:0",
        family: "llama",
      });
    });
    test("mistral family", () => {
      expect(parseModelString("bedrock/mistral.mistral-large-2402-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "mistral.mistral-large-2402-v1:0",
        family: "mistral",
      });
    });

    // Converse-only families. Twin vectors:
    // adapter-bedrock/src/family.test.ts — keep in sync.
    test("nova family", () => {
      expect(parseModelString("bedrock/amazon.nova-pro-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "amazon.nova-pro-v1:0",
        family: "nova",
      });
    });
    test("titan family (titan-text only)", () => {
      expect(parseModelString("bedrock/amazon.titan-text-express-v1")).toEqual({
        providerId: "bedrock",
        modelId: "amazon.titan-text-express-v1",
        family: "titan",
      });
    });
    test("deepseek family", () => {
      expect(parseModelString("bedrock/deepseek.r1-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "deepseek.r1-v1:0",
        family: "deepseek",
      });
    });
    test("cohere family (command only)", () => {
      expect(parseModelString("bedrock/cohere.command-r-plus-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "cohere.command-r-plus-v1:0",
        family: "cohere",
      });
    });
    test("ai21 family", () => {
      expect(parseModelString("bedrock/ai21.jamba-1-5-large-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "ai21.jamba-1-5-large-v1:0",
        family: "ai21",
      });
    });
    test("qwen family", () => {
      expect(parseModelString("bedrock/qwen.qwen3-32b-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "qwen.qwen3-32b-v1:0",
        family: "qwen",
      });
    });
    test("gpt-oss family", () => {
      expect(parseModelString("bedrock/openai.gpt-oss-120b-1:0")).toEqual({
        providerId: "bedrock",
        modelId: "openai.gpt-oss-120b-1:0",
        family: "gpt-oss",
      });
    });
    test("writer family", () => {
      expect(parseModelString("bedrock/writer.palmyra-x5-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "writer.palmyra-x5-v1:0",
        family: "writer",
      });
    });

    test("rejects unknown families (non-chat vendor siblings included)", () => {
      expect(() => parseModelString("bedrock/amazon.titan-embed-text-v2:0")).toThrow(ConfigError);
      expect(() => parseModelString("bedrock/cohere.embed-english-v3")).toThrow(ConfigError);
      expect(() => parseModelString("bedrock/stability.stable-diffusion-xl-v1")).toThrow(
        ConfigError,
      );
    });
    test("rejects empty modelId", () => {
      expect(() => parseModelString("bedrock/")).toThrow(ConfigError);
    });

    // Cross-region inference-profile ids — AWS requires these (not the
    // bare ids) for on-demand invocation of current-generation models.
    // Twin vectors: adapter-bedrock/src/family.test.ts.
    test("us. inference profile (anthropic)", () => {
      expect(parseModelString("bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        family: "anthropic",
      });
    });
    test("eu. inference profile (anthropic)", () => {
      expect(parseModelString("bedrock/eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
        family: "anthropic",
      });
    });
    test("apac. inference profile (llama)", () => {
      expect(parseModelString("bedrock/apac.meta.llama3-2-90b-instruct-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "apac.meta.llama3-2-90b-instruct-v1:0",
        family: "llama",
      });
    });
    test("global. inference profile (anthropic)", () => {
      expect(parseModelString("bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        family: "anthropic",
      });
    });
    test("us-gov. inference profile (anthropic)", () => {
      expect(parseModelString("bedrock/us-gov.anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "us-gov.anthropic.claude-haiku-4-5-20251001-v1:0",
        family: "anthropic",
      });
    });
    test("us. inference profile (mistral)", () => {
      expect(parseModelString("bedrock/us.mistral.pixtral-large-2502-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "us.mistral.pixtral-large-2502-v1:0",
        family: "mistral",
      });
    });
    test("us. inference profile (nova)", () => {
      expect(parseModelString("bedrock/us.amazon.nova-pro-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "us.amazon.nova-pro-v1:0",
        family: "nova",
      });
    });
    test("eu. inference profile (deepseek)", () => {
      expect(parseModelString("bedrock/eu.deepseek.r1-v1:0")).toEqual({
        providerId: "bedrock",
        modelId: "eu.deepseek.r1-v1:0",
        family: "deepseek",
      });
    });
    test("us. inference profile (gpt-oss)", () => {
      expect(parseModelString("bedrock/us.openai.gpt-oss-120b-1:0")).toEqual({
        providerId: "bedrock",
        modelId: "us.openai.gpt-oss-120b-1:0",
        family: "gpt-oss",
      });
    });
    test("rejects unknown family behind a geo prefix", () => {
      expect(() => parseModelString("bedrock/us.cohere.embed-english-v3")).toThrow(ConfigError);
    });
    test("does not strip non-geo segments", () => {
      // "used." must not be confused with the "us." geo prefix.
      expect(() => parseModelString("bedrock/used.anthropic.claude-x")).toThrow(ConfigError);
    });
  });

  describe("local/", () => {
    test("local/llama-3.1-8b@http://localhost:11434/v1", () => {
      expect(parseModelString("local/llama-3.1-8b@http://localhost:11434/v1")).toEqual({
        providerId: "openai",
        modelId: "llama-3.1-8b",
        baseUrl: "http://localhost:11434/v1",
      });
    });
    test("rejects missing @url", () => {
      expect(() => parseModelString("local/llama-3.1-8b")).toThrow(ConfigError);
    });
    test("rejects empty modelId", () => {
      expect(() => parseModelString("local/@http://x")).toThrow(ConfigError);
    });
    test("rejects empty url", () => {
      expect(() => parseModelString("local/llama@")).toThrow(ConfigError);
    });
  });

  describe("malformed input", () => {
    test("empty string", () => {
      expect(() => parseModelString("")).toThrow(ConfigError);
    });
    test("unrecognised prefix", () => {
      expect(() => parseModelString("anthropic/claude")).toThrow(ConfigError);
      expect(() => parseModelString("xyz/whatever")).toThrow(ConfigError);
    });
    test("non-claude unprefixed", () => {
      expect(() => parseModelString("gpt-4o-mini")).toThrow(ConfigError);
    });
  });
});
