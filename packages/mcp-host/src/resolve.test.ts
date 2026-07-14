/**
 * 0.3.0 — boot-time secret-ref resolution tests:
 *  - resolveSecretRef: literal / env / plain-string passthrough / missing var.
 *  - resolveMcpServerConfig: stdio + sse happy paths, error context, and the
 *    no-$refs regression guard (all-literal configs resolve to the exact
 *    plain-string config a pre-0.3.0 spec produced).
 *  - buildStdioChildEnv: the SDK-allowlist delivery fix — explicit env keys
 *    are merged ON TOP of getDefaultEnvironment(), not passed alone.
 */
import { describe, expect, test } from "bun:test";
import { ConfigError } from "@crewhaus/errors";
import { buildStdioChildEnv } from "./client.js";
import { resolveMcpServerConfig, resolveSecretRef } from "./resolve.js";

describe("resolveSecretRef", () => {
  test("literal ref returns the embedded value", () => {
    expect(resolveSecretRef({ kind: "literal", value: "plain" })).toBe("plain");
  });

  test("plain string passes through (idempotent resolution)", () => {
    expect(resolveSecretRef("already-resolved")).toBe("already-resolved");
  });

  test("env ref resolves from the injected env record", () => {
    expect(
      resolveSecretRef(
        { kind: "env", name: "THREDZ_API_KEY" },
        { env: { THREDZ_API_KEY: "sk-123" } },
      ),
    ).toBe("sk-123");
  });

  test("env ref defaults to process.env", () => {
    process.env["CREWHAUS_RESOLVE_TEST_VAR"] = "from-process-env";
    try {
      expect(resolveSecretRef({ kind: "env", name: "CREWHAUS_RESOLVE_TEST_VAR" })).toBe(
        "from-process-env",
      );
    } finally {
      Reflect.deleteProperty(process.env, "CREWHAUS_RESOLVE_TEST_VAR");
    }
  });

  test("missing env var throws ConfigError naming the variable", () => {
    expect(() => resolveSecretRef({ kind: "env", name: "THREDZ_API_KEY" }, { env: {} })).toThrow(
      ConfigError,
    );
    expect(() => resolveSecretRef({ kind: "env", name: "THREDZ_API_KEY" }, { env: {} })).toThrow(
      /THREDZ_API_KEY/,
    );
  });

  test("empty env var is treated as missing (matches secrets-manager env-var backend)", () => {
    expect(() =>
      resolveSecretRef({ kind: "env", name: "EMPTY_KEY" }, { env: { EMPTY_KEY: "" } }),
    ).toThrow(/EMPTY_KEY/);
  });

  test("error message carries the `what` context when provided", () => {
    expect(() =>
      resolveSecretRef(
        { kind: "env", name: "MISSING" },
        { env: {}, what: 'mcp server "thredz" env MISSING' },
      ),
    ).toThrow(/mcp server "thredz" env MISSING/);
  });
});

describe("resolveMcpServerConfig", () => {
  test("stdio: resolves env refs + literals into the plain-string SDK shape", () => {
    const resolved = resolveMcpServerConfig(
      {
        transport: "stdio",
        command: "npx",
        args: ["-y", "thredz-mcp@0.2.0"],
        env: {
          THREDZ_API_KEY: { kind: "env", name: "THREDZ_API_KEY" },
          THREDZ_BASE_URL: { kind: "literal", value: "https://thredz.example/api" },
        },
      },
      { env: { THREDZ_API_KEY: "sk-456" } },
    );
    expect(resolved).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "thredz-mcp@0.2.0"],
      env: {
        THREDZ_API_KEY: "sk-456",
        THREDZ_BASE_URL: "https://thredz.example/api",
      },
    });
  });

  test("sse: resolves header refs", () => {
    const resolved = resolveMcpServerConfig(
      {
        transport: "sse",
        url: "https://mcp.example.com/sse",
        headers: { Authorization: { kind: "env", name: "API_TOKEN" } },
      },
      { env: { API_TOKEN: "Bearer abc" } },
    );
    expect(resolved).toEqual({
      transport: "sse",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer abc" },
    });
  });

  test("omitted env/headers stay omitted (absent-when-omitted discipline)", () => {
    expect(resolveMcpServerConfig({ transport: "stdio", command: "bunx", args: [] })).toEqual({
      transport: "stdio",
      command: "bunx",
      args: [],
    });
    expect(resolveMcpServerConfig({ transport: "sse", url: "https://x.example/sse" })).toEqual({
      transport: "sse",
      url: "https://x.example/sse",
    });
  });

  test("regression guard: an all-literal config (spec with NO $refs) resolves to the identical plain-string config", () => {
    const resolved = resolveMcpServerConfig(
      {
        transport: "stdio",
        command: "bun",
        args: ["server.ts"],
        env: { LOG_LEVEL: { kind: "literal", value: "debug" } },
      },
      // No env record needed — literals never consult the environment.
      { env: {} },
    );
    expect(resolved).toEqual({
      transport: "stdio",
      command: "bun",
      args: ["server.ts"],
      env: { LOG_LEVEL: "debug" },
    });
  });

  test("missing env var error names both the variable and the server/field", () => {
    expect(() =>
      resolveMcpServerConfig(
        {
          transport: "stdio",
          command: "npx",
          args: [],
          env: { THREDZ_API_KEY: { kind: "env", name: "THREDZ_API_KEY" } },
        },
        { env: {}, name: "thredz" },
      ),
    ).toThrow(
      /environment variable THREDZ_API_KEY is not set \(required by mcp server "thredz" env THREDZ_API_KEY\)/,
    );
  });
});

describe("buildStdioChildEnv (SDK allowlist delivery fix)", () => {
  test("explicit keys are merged ON TOP of getDefaultEnvironment()", () => {
    const merged = buildStdioChildEnv({ THREDZ_API_KEY: "sk-789" });
    // The explicit key survives…
    expect(merged["THREDZ_API_KEY"]).toBe("sk-789");
    // …AND the SDK's safe default set is still present (PATH is on
    // DEFAULT_INHERITED_ENV_VARS on every platform and set in any test env),
    // so a spawned `npx`/`node` child can actually start.
    expect(merged["PATH"]).toBe(process.env["PATH"] as string);
  });

  test("explicit keys win over inherited defaults on collision", () => {
    const merged = buildStdioChildEnv({ PATH: "/custom/bin" });
    expect(merged["PATH"]).toBe("/custom/bin");
  });
});
