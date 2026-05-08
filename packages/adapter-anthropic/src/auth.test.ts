import { describe, expect, test } from "bun:test";
import { resolveAuth } from "./auth.js";

describe("resolveAuth", () => {
  test("none when no env vars set", () => {
    expect(resolveAuth({})).toEqual({ mode: "none" });
  });

  test("ANTHROPIC_AUTH_TOKEN with sk-ant-oat prefix → oauth", () => {
    expect(resolveAuth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-abc" })).toEqual({
      mode: "oauth",
      token: "sk-ant-oat01-abc",
    });
  });

  test("ANTHROPIC_AUTH_TOKEN without sk-ant-oat → api-key", () => {
    expect(resolveAuth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-api01-xyz" })).toEqual({
      mode: "api-key",
      token: "sk-ant-api01-xyz",
    });
  });

  test("falls back to ANTHROPIC_API_KEY when ANTHROPIC_AUTH_TOKEN unset", () => {
    expect(resolveAuth({ ANTHROPIC_API_KEY: "sk-ant-api01-aaa" })).toEqual({
      mode: "api-key",
      token: "sk-ant-api01-aaa",
    });
  });

  test("ANTHROPIC_AUTH_TOKEN beats ANTHROPIC_API_KEY when both set", () => {
    expect(
      resolveAuth({
        ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-from-auth",
        ANTHROPIC_API_KEY: "sk-ant-api01-other",
      }),
    ).toEqual({ mode: "oauth", token: "sk-ant-oat01-from-auth" });
  });

  test("empty ANTHROPIC_AUTH_TOKEN treated as unset; falls through to API key", () => {
    expect(
      resolveAuth({ ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "sk-ant-api01-only" }),
    ).toEqual({ mode: "api-key", token: "sk-ant-api01-only" });
  });
});
