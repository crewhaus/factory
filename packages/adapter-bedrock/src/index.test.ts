import { describe, expect, test } from "bun:test";
import * as pkg from "./index.js";

/**
 * The barrel module re-exports the adapter, the family helpers, the
 * anthropic invoke-path marshalling, and the converse marshalling. This
 * test pins the public surface so the re-export list can't silently
 * regress.
 */
describe("@crewhaus/adapter-bedrock barrel", () => {
  test("re-exports the adapter + factory", () => {
    expect(typeof pkg.BedrockAdapter).toBe("function");
    expect(typeof pkg.createBedrockAdapter).toBe("function");
  });

  test("re-exports the family detection helpers", () => {
    expect(typeof pkg.detectFamily).toBe("function");
    expect(typeof pkg.featuresForFamily).toBe("function");
    expect(pkg.detectFamily("anthropic.claude-3")).toBe("anthropic");
    expect(pkg.detectFamily("amazon.nova-pro-v1:0")).toBe("nova");
  });

  test("re-exports the anthropic marshalling surface", () => {
    expect(pkg.ANTHROPIC_BEDROCK_VERSION).toBe("bedrock-2023-05-31");
    expect(typeof pkg.buildAnthropicBedrockBody).toBe("function");
    expect(typeof pkg.decodeAnthropicBedrockChunk).toBe("function");
  });

  test("re-exports the converse marshalling surface", () => {
    expect(typeof pkg.buildConverseRequest).toBe("function");
    expect(typeof pkg.translateConverseStream).toBe("function");
  });
});
