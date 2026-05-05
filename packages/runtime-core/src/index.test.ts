import { describe, expect, test } from "bun:test";
import { resolveAuth } from "./index";

describe("resolveAuth", () => {
  test("returns mode=none when neither var is set", () => {
    expect(resolveAuth({})).toEqual({ mode: "none" });
  });

  test("recognizes an OAuth token by the sk-ant-oat prefix", () => {
    expect(resolveAuth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-abc" })).toEqual({
      mode: "oauth",
      token: "sk-ant-oat01-abc",
    });
  });

  test("treats a non-OAuth ANTHROPIC_AUTH_TOKEN as an API key", () => {
    expect(resolveAuth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-api01-xyz" })).toEqual({
      mode: "api-key",
      token: "sk-ant-api01-xyz",
    });
  });

  test("falls back to ANTHROPIC_API_KEY when AUTH_TOKEN is missing", () => {
    expect(resolveAuth({ ANTHROPIC_API_KEY: "sk-ant-api01-aaa" })).toEqual({
      mode: "api-key",
      token: "sk-ant-api01-aaa",
    });
  });

  test("AUTH_TOKEN takes precedence over API_KEY", () => {
    expect(
      resolveAuth({
        ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-abc",
        ANTHROPIC_API_KEY: "sk-ant-api01-xyz",
      }),
    ).toEqual({ mode: "oauth", token: "sk-ant-oat01-abc" });
  });

  test("ignores empty-string env values", () => {
    expect(
      resolveAuth({ ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "sk-ant-api01-only" }),
    ).toEqual({ mode: "api-key", token: "sk-ant-api01-only" });
  });
});
