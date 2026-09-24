import { describe, expect, test } from "bun:test";
import { checkEnvReveal, resolveCredentialEnv } from "./credential";

const ENV = {
  GITHUB_TOKEN: "ghp_operator-configured-token-000",
  GHE_TOKEN: "ghe-enterprise-token-111",
  ANTHROPIC_API_KEY: "sk-ant-api03-PROVIDER-KEY-222",
  EMPTY_TOKEN: "",
} as const;

const opts = {
  allowed: ["GITHUB_TOKEN", "GHE_TOKEN", "UNSET_TOKEN", "EMPTY_TOKEN"],
  purpose: "the PrList token",
  configKey: "tool_config.codehost.token_envs",
  env: ENV,
};

/** No refusal may carry any value from the environment. */
function expectNoValues(reason: string): void {
  for (const value of Object.values(ENV)) if (value !== "") expect(reason).not.toContain(value);
}

describe("resolveCredentialEnv", () => {
  test("an allow-listed name resolves to its value", () => {
    expect(resolveCredentialEnv("GITHUB_TOKEN", opts)).toEqual({
      ok: true,
      name: "GITHUB_TOKEN",
      value: ENV.GITHUB_TOKEN,
    });
    // The model may pick among the listed names.
    expect(resolveCredentialEnv("GHE_TOKEN", opts)).toMatchObject({
      ok: true,
      value: ENV.GHE_TOKEN,
    });
  });

  test("a name the operator did not list is refused, even when it is set (security-10#8, flag-truth-5#11)", () => {
    const r = resolveCredentialEnv("ANTHROPIC_API_KEY", opts);
    expect(r).toMatchObject({ ok: false, code: "not-allowed" });
    if (r.ok) return;
    // The refusal says exactly which key an operator sets, and to what.
    expect(r.reason).toContain(
      'an operator allows one by adding "ANTHROPIC_API_KEY" to tool_config.codehost.token_envs',
    );
    expect(r.reason).toContain("A tool call cannot add a name");
    expect(r.reason).toContain(
      'tool_config.codehost.token_envs allows "GITHUB_TOKEN", "GHE_TOKEN"',
    );
    expectNoValues(r.reason);
  });

  test("the refusal for an unlisted name is the same whether or not the variable exists", () => {
    // flag-truth-2#0: a different message for set and unset names makes the
    // call an existence oracle for every variable in the process.
    const set = resolveCredentialEnv("ANTHROPIC_API_KEY", opts);
    const unset = resolveCredentialEnv("NO_SUCH_VARIABLE_ANYWHERE", opts);
    expect(set.ok || unset.ok).toBe(false);
    if (set.ok || unset.ok) return;
    expect(set.code).toBe(unset.code);
    expect(set.reason.replaceAll("ANTHROPIC_API_KEY", "X")).toBe(
      unset.reason.replaceAll("NO_SUCH_VARIABLE_ANYWHERE", "X"),
    );
  });

  test("exact names only: no case folding, no prefix match", () => {
    for (const name of ["github_token", "GITHUB_TOKEN_2", "GITHUB"]) {
      expect(resolveCredentialEnv(name, opts)).toMatchObject({ ok: false, code: "not-allowed" });
    }
  });

  test("a listed name that is unset or empty says so, naming the key", () => {
    for (const name of ["UNSET_TOKEN", "EMPTY_TOKEN"]) {
      const r = resolveCredentialEnv(name, opts);
      expect(r).toMatchObject({ ok: false, code: "unset" });
      if (!r.ok) {
        expect(r.reason).toContain(`"${name}", which tool_config.codehost.token_envs allows`);
        expect(r.reason).toContain("unset or empty");
      }
    }
  });

  test("a pasted secret is refused without being quoted back", () => {
    for (const pasted of [
      "sk-ant-api03-PROVIDER-KEY-222",
      `ghp_${"A1b2C3d4".repeat(5)}`,
      "has spaces in it",
    ]) {
      const r = resolveCredentialEnv(pasted, opts);
      expect(r).toMatchObject({ ok: false, code: "invalid-name" });
      if (!r.ok) {
        expect(r.reason).not.toContain(pasted);
        expect(r.reason).toContain("has not been echoed back");
        expect(r.reason).toContain("tool_config.codehost.token_envs");
      }
    }
  });

  test("no name at all, and an empty allow-list, say what to configure", () => {
    const missing = resolveCredentialEnv(undefined, opts);
    expect(missing).toMatchObject({ ok: false, code: "missing-name" });
    if (!missing.ok) expect(missing.reason).toContain("the NAME of an environment variable");
    const none = resolveCredentialEnv("GITHUB_TOKEN", { ...opts, allowed: [] });
    expect(none).toMatchObject({ ok: false, code: "not-allowed" });
    if (!none.ok) {
      expect(none.reason).toContain("tool_config.codehost.token_envs lists no variables");
    }
  });

  test("malformed allow-list entries are ignored, never matched", () => {
    const r = resolveCredentialEnv("GITHUB_TOKEN", {
      ...opts,
      allowed: ["", "not a name", "GITHUB_TOKEN"],
    });
    expect(r).toMatchObject({ ok: true });
    const listed = resolveCredentialEnv("OTHER", { ...opts, allowed: ["not a name", "A_B"] });
    expect(listed).toMatchObject({ ok: false, code: "not-allowed" });
    if (!listed.ok) expect(listed.reason).toContain('allows "A_B".');
  });

  test("prototype names read nothing; an overlay's inherited variables still count", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(resolveCredentialEnv(name, { ...opts, allowed: [name] })).toMatchObject({
        ok: false,
        code: "unset",
      });
    }
    const overlay = Object.create(ENV) as Record<string, string>;
    overlay["EXTRA_TOKEN"] = "extra-token-value";
    const allowed = ["GITHUB_TOKEN", "EXTRA_TOKEN"];
    expect(resolveCredentialEnv("GITHUB_TOKEN", { ...opts, allowed, env: overlay })).toMatchObject({
      ok: true,
      value: ENV.GITHUB_TOKEN,
    });
    expect(resolveCredentialEnv("EXTRA_TOKEN", { ...opts, allowed, env: overlay })).toMatchObject({
      ok: true,
      value: "extra-token-value",
    });
  });

  test("a long allow-list is summarised", () => {
    const allowed = Array.from({ length: 14 }, (_, i) => `TOKEN_${i}`);
    const r = resolveCredentialEnv("OTHER", { ...opts, allowed });
    expect(r).toMatchObject({ ok: false, code: "not-allowed" });
    if (!r.ok) {
      expect(r.reason).toContain('"TOKEN_9" and 4 more');
      expect(r.reason).not.toContain("TOKEN_10");
    }
  });

  test("the default environment is this process's", () => {
    const path = process.env["PATH"];
    expect(path).toBeDefined();
    expect(
      resolveCredentialEnv("PATH", {
        allowed: ["PATH"],
        purpose: "the test",
        configKey: "tool_config.test.envs",
      }),
    ).toEqual({ ok: true, name: "PATH", value: path as string });
  });
});

describe("checkEnvReveal", () => {
  const reveal = {
    allowed: ["NODE_ENV", "ANTHROPIC_API_KEY"],
    configKey: "tool_config.proc.env_reveal",
  };

  test("a credential-shaped name is never revealed, even when listed (flag-truth-4#1, security-8#3)", () => {
    const r = checkEnvReveal("ANTHROPIC_API_KEY", reveal);
    expect(r).toMatchObject({ ok: false, code: "credential-shaped" });
    if (!r.ok) {
      expect(r.reason).toContain("never shown");
      expect(r.reason).toContain("APIKEY");
    }
  });

  test("an ordinary name is revealed only when the operator listed it", () => {
    expect(checkEnvReveal("NODE_ENV", reveal)).toEqual({ ok: true });
    const r = checkEnvReveal("LOG_LEVEL", reveal);
    expect(r).toMatchObject({ ok: false, code: "not-allowed" });
    if (!r.ok) expect(r.reason).toContain("adds it to tool_config.proc.env_reveal");
  });

  test("something that is not a name is refused without being quoted", () => {
    const r = checkEnvReveal("sk-ant-api03-PROVIDER-KEY-222", reveal);
    expect(r).toMatchObject({ ok: false, code: "invalid-name" });
    if (!r.ok) expect(r.reason).not.toContain("sk-ant");
  });
});
