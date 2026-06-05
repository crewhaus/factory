import { describe, expect, test } from "bun:test";
import * as api from "./index.js";

/**
 * The barrel is the package's public surface. Importing it executes every
 * re-export; these assertions pin the surface so an accidental drop of an
 * export (or a renamed symbol) fails loudly.
 */
describe("public surface (index barrel)", () => {
  test("re-exports the adapter factory + class", () => {
    expect(typeof api.AnthropicAdapter).toBe("function");
    expect(typeof api.createAnthropicAdapter).toBe("function");
  });

  test("re-exports auth + client helpers", () => {
    expect(typeof api.resolveAuth).toBe("function");
    expect(typeof api.createAnthropicClient).toBe("function");
    expect(api.CLAUDE_CODE_SYSTEM_PREFIX).toContain("Claude Code");
    expect(Array.isArray(api.OAUTH_BETAS)).toBe(true);
    expect(api.CLAUDE_CODE_HEADERS["x-app"]).toBe("cli");
  });

  test("re-exports the stream-consumption helpers", () => {
    expect(typeof api.collectFinalMessage).toBe("function");
    expect(typeof api.consumeStream).toBe("function");
    expect(typeof api.extractFirstText).toBe("function");
    expect(typeof api.extractToolUse).toBe("function");
  });

  test("re-exports the translate helpers", () => {
    expect(typeof api.rawEventToCanonical).toBe("function");
    expect(typeof api.toAnthropicMessages).toBe("function");
    expect(typeof api.toAnthropicParams).toBe("function");
    expect(typeof api.toAnthropicSystem).toBe("function");
  });

  test("re-exports the Anthropic SDK class + error taxonomy as a single instance", () => {
    expect(typeof api.Anthropic).toBe("function");
    expect(typeof api.APIError).toBe("function");
    expect(typeof api.RateLimitError).toBe("function");
    expect(typeof api.AuthenticationError).toBe("function");
    expect(typeof api.APIConnectionError).toBe("function");
    // The re-exported error classes are the SDK's own — usable for instanceof.
    expect(api.RateLimitError.prototype).toBeInstanceOf(api.APIError);
  });

  test("the re-exported Anthropic is constructible (single canonical copy)", () => {
    const client = new api.Anthropic({ apiKey: "sk-ant-api01-x", authToken: null });
    expect(client).toBeInstanceOf(api.Anthropic);
  });
});
