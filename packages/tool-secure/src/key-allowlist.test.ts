/**
 * flag-truth-2#0: the keyed tools read ANY environment variable the call
 * named, and they are read-only, so plan and auto mode ran them unasked. A
 * signature over a known payload under DB_PASSWORD is an offline dictionary
 * oracle for the secret and a forgery for anything keyed by it. Only a name
 * the operator listed in tool_config.secure.key_env_vars is read now, and an
 * unlisted name is refused identically whether or not it is set.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { applyToolConfig, planToolConfigInits } from "@crewhaus/tool-categories";
import * as secure from "./index";
import {
  KEY_ENV_VARS_CONFIG_KEY,
  piiRedact,
  pseudonymize,
  redactForExport,
  registerSecureConfig,
  signPayload,
  verifyPayload,
} from "./index";

const SECRET = ["app", "jwt", "secret", "value"].join("-");
const SET = "APP_JWT_SECRET";
const UNSET = "APP_JWT_UNSETX"; // same length as SET
const DECLARED = "AUDIT_SIGNING_KEY";

beforeEach(() => {
  process.env[SET] = SECRET;
  Reflect.deleteProperty(process.env, UNSET);
  process.env[DECLARED] = "k";
  process.env["EMPTY_UNDECLARED"] = "";
  registerSecureConfig({ key_env_vars: [DECLARED] });
});

afterEach(() => {
  for (const name of [SET, DECLARED, "EMPTY_UNDECLARED", "OTHER_KEY"]) {
    Reflect.deleteProperty(process.env, name);
  }
  registerSecureConfig({});
});

/** One call per keyed tool, keyed by `name`. */
const CALLS: ReadonlyArray<[string, (name: string, ctx?: object) => Promise<unknown>]> = [
  ["SignPayload", (n, ctx) => signPayload.execute({ payload: "x", keyEnvVar: n }, ctx as never)],
  [
    "VerifyPayload",
    (n, ctx) =>
      verifyPayload.execute({ payload: "x", signature: "00", keyEnvVar: n }, ctx as never),
  ],
  [
    "Pseudonymize",
    (n, ctx) =>
      pseudonymize.execute(
        { text: "a", mapping: {}, mint: { values: ["a"], prefix: "P", keyEnvVar: n } },
        ctx as never,
      ),
  ],
  [
    "PiiRedact",
    (n, ctx) =>
      piiRedact.execute({ text: "ada@example.com", mode: "pseudonym", keyEnvVar: n }, ctx as never),
  ],
  [
    "RedactForExport",
    (n, ctx) =>
      redactForExport.execute(
        { text: "ada@example.com", mode: "pseudonym", keyEnvVar: n },
        ctx as never,
      ),
  ],
];

describe("a key variable the operator did not list is refused, set or not", () => {
  for (const [tool, call] of CALLS) {
    test(`${tool}: no result, no signature, and no existence oracle`, async () => {
      const setOut = String(await call(SET));
      const unsetOut = String(await call(UNSET));
      const emptyOut = String(await call("EMPTY_UNDECLARED"));
      // A refusal, not a JSON result.
      expect(() => JSON.parse(setOut)).toThrow();
      expect(setOut).toContain(KEY_ENV_VARS_CONFIG_KEY);
      expect(setOut).not.toContain(SECRET);
      expect(setOut).not.toContain(createHmac("sha256", SECRET).update("x").digest("hex"));
      // Byte-identical but for the name: whether the variable exists is not told.
      expect(setOut.replaceAll(SET, "NAME")).toBe(unsetOut.replaceAll(UNSET, "NAME"));
      expect(setOut.replaceAll(SET, "NAME")).toBe(emptyOut.replaceAll("EMPTY_UNDECLARED", "NAME"));
    });
  }

  test("a listed name signs, and the signature is the HMAC under that key", async () => {
    const out = JSON.parse(
      String(await signPayload.execute({ payload: "x", keyEnvVar: DECLARED })),
    ) as Record<string, unknown>;
    expect(out["signature"]).toBe(createHmac("sha256", "k").update("x").digest("hex"));
  });

  test("a listed but unset name still says it is unset", async () => {
    Reflect.deleteProperty(process.env, DECLARED);
    const out = String(await signPayload.execute({ payload: "x", keyEnvVar: DECLARED }));
    expect(out).toContain("unset or empty");
  });

  test("with no list at all, every keyed call is refused and names the key to set", async () => {
    registerSecureConfig({});
    const out = String(await signPayload.execute({ payload: "x", keyEnvVar: DECLARED }));
    expect(out).toContain("tool_config.secure.key_env_vars lists no variables");
  });

  test("a model-pool candidate's block replaces the boot list for its calls", async () => {
    process.env["OTHER_KEY"] = "o";
    const ctx = { toolConfig: { keyEnvVars: ["OTHER_KEY"] } };
    const other = JSON.parse(
      String(await signPayload.execute({ payload: "x", keyEnvVar: "OTHER_KEY" }, ctx as never)),
    ) as Record<string, unknown>;
    expect(other["signature"]).toBe(createHmac("sha256", "o").update("x").digest("hex"));
    // ...and the boot list's name is not in the candidate's list.
    expect(
      String(await signPayload.execute({ payload: "x", keyEnvVar: DECLARED }, ctx as never)),
    ).toContain("is not listed");
  });

  test("the registrar refuses a list that is not a list of names, without echoing a pasted key", () => {
    const pasted = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
    expect(() => registerSecureConfig({ key_env_vars: "AUDIT_SIGNING_KEY" })).toThrow(
      "must be a list",
    );
    expect(() => registerSecureConfig({ key_env_vars: [pasted] })).toThrow("looks like a key");
    let message = "";
    try {
      registerSecureConfig({ key_env_vars: [pasted] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(pasted);
    expect(() => registerSecureConfig({ key_env_vars: ["A"], keyEnvVars: ["B"] })).toThrow(
      "both key_env_vars and keyEnvVars",
    );
    // Unrelated keys are left to the checks that own them.
    expect(() => registerSecureConfig({ allowed_origins: ["https://a.example"] })).not.toThrow();
  });
});

describe("a spec's tool_config reaches the keyed tools on every shape", () => {
  test("tool_config.secure (or a keyed tool's own key) plans a registerSecureConfig call that allows the name", async () => {
    registerSecureConfig({});
    for (const key of ["secure", "signPayload", "SignPayload"]) {
      const inits = planToolConfigInits([
        { tools: ["signPayload", "piiScan"], toolConfigs: { [key]: { key_env_vars: [DECLARED] } } },
      ]);
      expect(inits.map((i) => [i.package, i.initSymbol])).toEqual([
        ["@crewhaus/tool-secure", "registerSecureConfig"],
      ]);
      const init = inits[0];
      if (init === undefined) throw new Error("no init");
      const registrar = (secure as unknown as Record<string, (c: never) => void>)[init.initSymbol];
      if (registrar === undefined) throw new Error("registrar not exported");
      applyToolConfig(registrar, init.config, init.where, process.env);
      const out = JSON.parse(
        String(await signPayload.execute({ payload: "x", keyEnvVar: DECLARED })),
      ) as Record<string, unknown>;
      expect(out["signature"]).toBe(createHmac("sha256", "k").update("x").digest("hex"));
      registerSecureConfig({});
    }
  });
});
