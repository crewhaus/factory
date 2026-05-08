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
    test("rejects unknown family", () => {
      expect(() => parseModelString("bedrock/cohere.command-r-v1:0")).toThrow(ConfigError);
    });
    test("rejects empty modelId", () => {
      expect(() => parseModelString("bedrock/")).toThrow(ConfigError);
    });
  });

  describe("local/", () => {
    test("local/llama-3.1-8b@http://localhost:11434", () => {
      expect(parseModelString("local/llama-3.1-8b@http://localhost:11434")).toEqual({
        providerId: "openai",
        modelId: "llama-3.1-8b",
        baseUrl: "http://localhost:11434",
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
