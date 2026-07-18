/**
 * Loop contract 0.4 (Batch G, G75) — async MCP secret resolution ladder.
 *
 * `resolveSecretRefAsync` / `resolveMcpServerConfigAsync` route an env-ref
 * through a configured secrets backend FIRST, then fall back to the
 * process/injected env; plain `$FOO`-shaped literals that survived the
 * compiler are warned about (the transports never expand them).
 */
import { describe, expect, test } from "bun:test";
import { ConfigError } from "@crewhaus/errors";
import {
  type SecretsResolver,
  resolveMcpServerConfigAsync,
  resolveSecretRefAsync,
} from "./resolve.js";

function stubSecrets(map: Record<string, string>): SecretsResolver {
  return {
    async get(name) {
      const v = map[name];
      if (v === undefined) throw new Error(`no such secret ${name}`);
      return v;
    },
  };
}

describe("resolveSecretRefAsync — resolution ladder (G75)", () => {
  test("env-ref resolves through the secrets backend first", async () => {
    const value = await resolveSecretRefAsync(
      { kind: "env", name: "API_KEY" },
      { secrets: stubSecrets({ API_KEY: "from-vault" }), env: { API_KEY: "from-env" } },
    );
    expect(value).toBe("from-vault");
  });

  test("a backend miss falls back to env", async () => {
    const value = await resolveSecretRefAsync(
      { kind: "env", name: "API_KEY" },
      { secrets: stubSecrets({}), env: { API_KEY: "from-env" } },
    );
    expect(value).toBe("from-env");
  });

  test("a backend that returns empty string falls back to env", async () => {
    const value = await resolveSecretRefAsync(
      { kind: "env", name: "API_KEY" },
      { secrets: stubSecrets({ API_KEY: "" }), env: { API_KEY: "from-env" } },
    );
    expect(value).toBe("from-env");
  });

  test("with no backend and no env, the fallback throws naming the variable", async () => {
    await expect(
      resolveSecretRefAsync({ kind: "env", name: "MISSING" }, { env: {} }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("literal refs pass through untouched", async () => {
    expect(await resolveSecretRefAsync({ kind: "literal", value: "plain" })).toBe("plain");
  });

  test("a $FOO-shaped literal triggers a G75 warning", async () => {
    const warnings: string[] = [];
    const value = await resolveSecretRefAsync("$THREDZ_TOKEN", {
      onWarn: (m) => warnings.push(m),
      what: 'mcp server "thredz" env TOKEN',
    });
    expect(value).toBe("$THREDZ_TOKEN");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("NOT expanded");
    expect(warnings[0]).toContain("thredz");
  });

  test("${FOO} braces are also flagged", async () => {
    const warnings: string[] = [];
    await resolveSecretRefAsync("${TOKEN}", { onWarn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
  });

  test("a normal literal that merely contains a $ mid-string is NOT flagged", async () => {
    const warnings: string[] = [];
    await resolveSecretRefAsync("price is $5", { onWarn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(0);
  });
});

describe("resolveMcpServerConfigAsync — whole-config resolution (G75)", () => {
  test("stdio env values resolve through the backend before env", async () => {
    const resolved = await resolveMcpServerConfigAsync(
      {
        transport: "stdio",
        command: "server",
        env: { TOKEN: { kind: "env", name: "TOKEN" }, LITERAL: { kind: "literal", value: "lit" } },
      },
      { secrets: stubSecrets({ TOKEN: "vaulted" }), name: "thredz" },
    );
    expect(resolved.transport).toBe("stdio");
    if (resolved.transport === "stdio") {
      expect(resolved.env).toEqual({ TOKEN: "vaulted", LITERAL: "lit" });
    }
  });

  test("sse headers resolve through the ladder", async () => {
    const resolved = await resolveMcpServerConfigAsync(
      {
        transport: "sse",
        url: "https://example.test/sse",
        headers: { Authorization: { kind: "env", name: "AUTH" } },
      },
      { env: { AUTH: "Bearer xyz" } },
    );
    if (resolved.transport === "sse") {
      expect(resolved.headers).toEqual({ Authorization: "Bearer xyz" });
    }
  });

  test("a missing env var (no backend) throws naming the server + field", async () => {
    await expect(
      resolveMcpServerConfigAsync(
        {
          transport: "stdio",
          command: "server",
          env: { TOKEN: { kind: "env", name: "NOPE" } },
        },
        { env: {}, name: "thredz" },
      ),
    ).rejects.toThrow(/NOPE/);
  });
});
