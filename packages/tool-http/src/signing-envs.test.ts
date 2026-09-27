/**
 * WebhookSign and WebhookVerify key their HMAC only with a variable the
 * operator listed (C158, security-8#20).
 *
 * Both read `process.env[input.secretEnvVar]` for any name the call gave.
 * WebhookSign is readOnly, so plan and auto mode ran it unasked: with the
 * plain-body scheme its output is exactly HMAC(secret, payload), so it
 * minted valid signatures over any payload with any secret in the process
 * (an exchange API's HMAC key, another service's webhook secret), and its
 * "unset or empty" refusal told set variables from unset ones.
 *
 * `tool_config.http.allowed_signing_envs` now names the variables; anything
 * else is refused before the environment is read. Both tools stay
 * readOnly: they have no side effect, and the list is the control.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { _resetHttpConfig, registerHttpConfig, webhookSign, webhookVerify } from "./index";
import { HttpPermissionError, buildHttpConfig } from "./net";

const LISTED = "CREWHAUS_TEST_HOOK_SECRET";
const LISTED_VALUE = "whsec-listed-value";
const OTHER = "CREWHAUS_TEST_PROVIDER_KEY";
const OTHER_VALUE = "sk-provider-key-that-must-not-sign";

beforeEach(() => {
  process.env[LISTED] = LISTED_VALUE;
  process.env[OTHER] = OTHER_VALUE;
  registerHttpConfig({ allowed_origins: [], allowed_signing_envs: [LISTED] });
});

afterEach(() => {
  delete process.env[LISTED];
  delete process.env[OTHER];
  _resetHttpConfig();
});

const sign = async (secretEnvVar: string, ctx?: unknown): Promise<string> =>
  String(
    await webhookSign.execute({ scheme: "body", payload: "x", secretEnvVar }, (ctx ?? {}) as never),
  );

describe("the HMAC key is a variable the operator listed (C158)", () => {
  test("an unlisted variable is refused, and no signature comes back", async () => {
    const out = await sign(OTHER);
    expect(out).toContain("tool_config.http.allowed_signing_envs");
    expect(out).not.toMatch(/^\{/);
    const forged = createHmac("sha256", OTHER_VALUE).update("x").digest("hex");
    expect(out).not.toContain(forged);
    expect(out).not.toContain(OTHER_VALUE);
  });

  test("the refusal is the same whether the variable is set or not", async () => {
    const set = await sign(OTHER);
    delete process.env[OTHER];
    expect(await sign(OTHER)).toBe(set);
  });

  test("a listed variable signs as before", async () => {
    const out = JSON.parse(await sign(LISTED));
    const expected = createHmac("sha256", LISTED_VALUE).update("x").digest("hex");
    expect(out.header).toBe(`sha256=${expected}`);
  });

  test("with no list, every variable is refused", async () => {
    _resetHttpConfig();
    expect(await sign(LISTED)).toContain("tool_config.http.allowed_signing_envs");
  });

  test("a per-call block uses its own list", async () => {
    const out = await sign(OTHER, { toolConfig: { allowed_signing_envs: [OTHER] } });
    expect(JSON.parse(out).signature).toBe(
      createHmac("sha256", OTHER_VALUE).update("x").digest("hex"),
    );
    expect(await sign(LISTED, { toolConfig: { allowed_signing_envs: [OTHER] } })).toContain(
      "is not listed",
    );
  });

  test("WebhookVerify is held to the same list", async () => {
    const header = `sha256=${createHmac("sha256", OTHER_VALUE).update("x").digest("hex")}`;
    const out = String(
      await webhookVerify.execute(
        { scheme: "body", payload: "x", signatureHeader: header, secretEnvVar: OTHER },
        {} as never,
      ),
    );
    expect(out).toContain("tool_config.http.allowed_signing_envs");
    expect(out).not.toContain('"valid"');
  });

  test("both tools stay read-only: the list is the control, not the flag", () => {
    expect(webhookSign.readOnly).toBe(true);
    expect(webhookVerify.readOnly).toBe(true);
  });

  test("a malformed list entry is refused at boot without being echoed", () => {
    // Built from parts: push protection matches on shape, not on whether a
    // value is real.
    const pasted = `whsec_${"0123456789abcdef0123456789abcdef"}`;
    let message = "";
    try {
      buildHttpConfig({ allowed_signing_envs: [pasted] });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpPermissionError);
      message = (err as Error).message;
    }
    expect(message).toContain("allowed_signing_envs lists environment variable NAMES");
    expect(message).not.toContain(pasted);
  });
});
