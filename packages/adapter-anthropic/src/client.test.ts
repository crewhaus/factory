import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { ProviderAuthError } from "@crewhaus/errors";
import type { ResolvedAuth } from "./auth.js";
import {
  CLAUDE_CODE_HEADERS,
  CLAUDE_CODE_SYSTEM_PREFIX,
  OAUTH_BETAS,
  createAnthropicClient,
} from "./client.js";

describe("constants", () => {
  test("OAUTH_BETAS includes the subscription-routing beta flags", () => {
    expect(OAUTH_BETAS).toContain("oauth-2025-04-20");
    expect(OAUTH_BETAS).toContain("claude-code-20250219");
  });

  test("CLAUDE_CODE_HEADERS spoof the official CLI user-agent", () => {
    expect(CLAUDE_CODE_HEADERS["x-app"]).toBe("cli");
    expect(CLAUDE_CODE_HEADERS["user-agent"]).toMatch(
      /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/,
    );
    expect(CLAUDE_CODE_HEADERS.accept).toBe("application/json");
  });

  test("CLAUDE_CODE_SYSTEM_PREFIX is the Claude Code identity line", () => {
    expect(CLAUDE_CODE_SYSTEM_PREFIX).toContain("Claude Code");
  });
});

describe("createAnthropicClient", () => {
  test("throws ProviderAuthError when auth mode is none", () => {
    const auth: ResolvedAuth = { mode: "none" };
    expect(() => createAnthropicClient(auth, {})).toThrow(ProviderAuthError);
    expect(() => createAnthropicClient(auth, {})).toThrow(/no Anthropic credentials/);
  });

  test("api-key auth builds a non-OAuth client", () => {
    const auth: ResolvedAuth = { mode: "api-key", token: "sk-ant-api01-xyz" };
    const { client, isOAuth } = createAnthropicClient(auth, {});
    expect(isOAuth).toBe(false);
    expect(client).toBeInstanceOf(Anthropic);
    expect(client.apiKey).toBe("sk-ant-api01-xyz");
  });

  test("oauth auth builds an OAuth client with the token set", () => {
    const auth: ResolvedAuth = { mode: "oauth", token: "sk-ant-oat01-abc" };
    const { client, isOAuth } = createAnthropicClient(auth, {});
    expect(isOAuth).toBe(true);
    expect(client).toBeInstanceOf(Anthropic);
    expect(client.authToken).toBe("sk-ant-oat01-abc");
    // OAuth clients deliberately leave apiKey null so the SDK routes via the
    // subscription-billing auth-token header instead of an x-api-key.
    expect(client.apiKey).toBeNull();
  });

  test("honours ANTHROPIC_BASE_URL for the api-key path", () => {
    const auth: ResolvedAuth = { mode: "api-key", token: "sk-ant-api01-xyz" };
    const { client } = createAnthropicClient(auth, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4010",
    });
    expect(client.baseURL).toBe("http://127.0.0.1:4010");
  });

  test("honours ANTHROPIC_BASE_URL for the oauth path", () => {
    const auth: ResolvedAuth = { mode: "oauth", token: "sk-ant-oat01-abc" };
    const { client } = createAnthropicClient(auth, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4011",
    });
    expect(client.baseURL).toBe("http://127.0.0.1:4011");
  });

  test("empty ANTHROPIC_BASE_URL is ignored (SDK default kept)", () => {
    const auth: ResolvedAuth = { mode: "api-key", token: "sk-ant-api01-xyz" };
    const { client } = createAnthropicClient(auth, { ANTHROPIC_BASE_URL: "" });
    // Falls back to the SDK's own default base URL.
    expect(client.baseURL).toBe("https://api.anthropic.com");
  });

  test("missing ANTHROPIC_BASE_URL is ignored (SDK default kept)", () => {
    const auth: ResolvedAuth = { mode: "oauth", token: "sk-ant-oat01-abc" };
    const { client } = createAnthropicClient(auth, {});
    expect(client.baseURL).toBe("https://api.anthropic.com");
  });

  test("defaults to process.env when no env arg is passed", () => {
    // Exercises the default-parameter binding. We only assert it constructs
    // without consulting a real network; ANTHROPIC_BASE_URL may or may not
    // be set in the ambient env, so we don't assert on baseURL here.
    const auth: ResolvedAuth = { mode: "api-key", token: "sk-ant-api01-default" };
    const { client, isOAuth } = createAnthropicClient(auth);
    expect(isOAuth).toBe(false);
    expect(client).toBeInstanceOf(Anthropic);
  });
});
