/**
 * flag-truth-5#8: ObjectPresign took the secret access key and session token
 * as tool arguments, so they sat in the model's context, the transcript,
 * every later provider request and the session event log — while the schema
 * said the secret was "not logged". Credentials now come only from an
 * operator's profile (tool_config.objectstore.credentials) naming the
 * environment variables that hold them; a call picks a profile by name.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyToolConfig, planToolConfigInits } from "@crewhaus/tool-categories";
import * as pkg from "./index";
import { CREDENTIALS_CONFIG_KEY, objectPresign, registerObjectStoreConfig } from "./index";

const SECRET = ["canary", "S3SECRET", "4c1d9e"].join("-");
const TOKEN = ["canary", "STS", "TOKEN", "77ab"].join("-");

const BASE = {
  operation: "get",
  endpoint: "https://s3.us-east-1.amazonaws.com",
  addressingStyle: "virtual-hosted",
  region: "us-east-1",
  bucket: "examplebucket",
  key: "test.txt",
  signedAt: "2026-02-03T04:05:06Z",
} as const;

const PROFILE = {
  access_key_id_env: "OBJ_CRED_KEY_ID",
  secret_access_key_env: "OBJ_CRED_SECRET",
};

beforeEach(() => {
  process.env["OBJ_CRED_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["OBJ_CRED_SECRET"] = SECRET;
  process.env["OBJ_CRED_TOKEN"] = TOKEN;
  registerObjectStoreConfig({});
});

afterEach(() => {
  for (const n of ["OBJ_CRED_KEY_ID", "OBJ_CRED_SECRET", "OBJ_CRED_TOKEN"]) {
    Reflect.deleteProperty(process.env, n);
  }
  registerObjectStoreConfig({});
});

async function attempt(input: unknown, ctx?: object): Promise<string> {
  const parsed = objectPresign.inputSchema.safeParse(input);
  if (!parsed.success) return `schema: ${parsed.error.message}`;
  try {
    return String(await objectPresign.execute(parsed.data, ctx as never));
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}

describe("a credential is never a tool argument", () => {
  test("the schema has no field that carries one, and refuses the 0.7.0 fields by name", async () => {
    const shape = (objectPresign.inputSchema as unknown as { shape: Record<string, unknown> })
      .shape;
    expect(Object.keys(shape)).not.toContain("secretAccessKey");
    expect(Object.keys(shape)).not.toContain("sessionToken");
    expect(Object.keys(shape)).not.toContain("accessKeyId");
    registerObjectStoreConfig({ credentials: { main: PROFILE } });
    for (const field of ["secretAccessKey", "sessionToken", "accessKeyId"]) {
      const out = await attempt({ ...BASE, [field]: SECRET });
      expect(out).toContain("schema:");
      expect(out).toContain(field);
      expect(out).not.toContain(SECRET);
    }
  });

  test("a profile's variables sign the URL, and the result carries neither the secret nor the variable's value", async () => {
    registerObjectStoreConfig({
      credentials: { main: { ...PROFILE, session_token_env: "OBJ_CRED_TOKEN" } },
    });
    const out = JSON.parse(await attempt(BASE)) as Record<string, unknown>;
    expect(out["credentialProfile"]).toBe("main");
    expect(new URL(String(out["url"])).searchParams.get("X-Amz-Security-Token")).toBe(TOKEN);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test("no profile configured: refused, naming where an operator adds one", async () => {
    const out = await attempt(BASE);
    expect(out).toContain("error:");
    expect(out).toContain(CREDENTIALS_CONFIG_KEY);
    expect(out).not.toContain(SECRET);
  });

  test("two profiles and no choice asks for one; an unknown one is named with the choices", async () => {
    registerObjectStoreConfig({ credentials: { a: PROFILE, b: PROFILE } });
    expect(await attempt(BASE)).toContain('one of "a", "b"');
    expect(await attempt({ ...BASE, credentials: "c" })).toContain('no credential profile "c"');
    expect(JSON.parse(await attempt({ ...BASE, credentials: "b" }))["credentialProfile"]).toBe("b");
  });

  test("an unset variable is refused by name, never by value", async () => {
    registerObjectStoreConfig({ credentials: { main: PROFILE } });
    Reflect.deleteProperty(process.env, "OBJ_CRED_SECRET");
    const out = await attempt(BASE);
    expect(out).toContain("OBJ_CRED_SECRET");
    expect(out).toContain("unset or empty");
  });

  test("a model-pool candidate's block replaces the boot profiles for its calls", async () => {
    registerObjectStoreConfig({ credentials: { boot: PROFILE } });
    const ctx = { toolConfig: { credentials: { cand: PROFILE } } };
    expect(JSON.parse(await attempt(BASE, ctx))["credentialProfile"]).toBe("cand");
    expect(await attempt({ ...BASE, credentials: "boot" }, ctx)).toContain(
      'no credential profile "boot"',
    );
  });

  test("the registrar refuses a profile that holds a credential instead of naming its variable", () => {
    const pasted = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const refused = (block: unknown): string => {
      try {
        registerObjectStoreConfig(block);
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    };
    const literal = refused({ credentials: { main: { ...PROFILE, secret_access_key: SECRET } } });
    expect(literal).toContain("never the credentials themselves");
    expect(literal).not.toContain(SECRET);
    const pastedValue = refused({
      credentials: { main: { ...PROFILE, access_key_id_env: pasted } },
    });
    expect(pastedValue).toContain("looks like the credential itself");
    expect(pastedValue).not.toContain(pasted);
    expect(refused({ credentials: { main: { access_key_id_env: "A" } } })).toContain(
      "secret_access_key_env is required",
    );
    // Unrelated keys are left to the checks that own them.
    expect(refused({ allowed_origins: ["https://a.example"] })).toBe("");
  });

  test("tool_config.objectstore (or objectPresign's own key) is delivered to the registrar", async () => {
    for (const key of ["objectstore", "objectPresign", "ObjectPresign"]) {
      registerObjectStoreConfig({});
      const inits = planToolConfigInits([
        { tools: ["objectPresign"], toolConfigs: { [key]: { credentials: { main: PROFILE } } } },
      ]);
      expect(inits.map((i) => [i.package, i.initSymbol])).toEqual([
        ["@crewhaus/tool-objectstore", "registerObjectStoreConfig"],
      ]);
      const init = inits[0];
      if (init === undefined) throw new Error("no init");
      const registrar = (pkg as unknown as Record<string, (c: never) => void>)[init.initSymbol];
      if (registrar === undefined) throw new Error("registrar not exported");
      applyToolConfig(registrar, init.config, init.where, process.env);
      expect(JSON.parse(await attempt(BASE))["credentialProfile"]).toBe("main");
    }
  });
});
