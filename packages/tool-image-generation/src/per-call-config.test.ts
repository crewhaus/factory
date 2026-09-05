/**
 * 0.6.0 §4.4 — per-candidate `tool_config.imageGenerate`: an object override
 * on `ToolExecuteContext.toolConfig` REPLACES the registered config for that
 * one call; absent → the registered config, else `{}` (env-driven defaults).
 */
import { describe, expect, test } from "bun:test";
import { registerImageGenerationConfig, resolveImageGenerationConfig } from "./index";

describe("resolveImageGenerationConfig (per-call tool_config override)", () => {
  test("an object override replaces the registered config for the call", () => {
    registerImageGenerationConfig({ provider: "mock" });
    expect(resolveImageGenerationConfig({ provider: "openai", model: "dall-e-3" })).toEqual({
      provider: "openai",
      model: "dall-e-3",
    });
    // The registration is untouched.
    expect(resolveImageGenerationConfig(undefined)).toEqual({ provider: "mock" });
  });

  test("a non-object override falls back to the registered config", () => {
    registerImageGenerationConfig({ provider: "mock" });
    for (const bad of [null, "openai", 7, ["openai"]]) {
      expect(resolveImageGenerationConfig(bad)).toEqual({ provider: "mock" });
    }
  });
});
