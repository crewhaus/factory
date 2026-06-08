/**
 * Section 27 — `vault` backend coverage.
 *
 * No real network: every test injects a deterministic `fetchImpl` that
 * returns canned `Response`s. `VAULT_TOKEN` is saved in beforeEach and
 * restored in afterEach so the surrounding process env is never mutated
 * across tests. No real clock, no leaked handles.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createVaultBackend } from "../backends/vault";
import { SecretsError } from "../index";

const ADDR = "http://127.0.0.1:8200";

/** Build a fetch stub plus a record of the calls it observed. */
function stubFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responder(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env["VAULT_TOKEN"];
  Reflect.deleteProperty(process.env, "VAULT_TOKEN");
});

afterEach(() => {
  if (savedToken === undefined) {
    Reflect.deleteProperty(process.env, "VAULT_TOKEN");
  } else {
    process.env["VAULT_TOKEN"] = savedToken;
  }
});

describe("vault backend — id + token resolution", () => {
  test("exposes the vault id", () => {
    const backend = createVaultBackend({
      addr: ADDR,
      token: "t",
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    expect(backend.id).toBe("vault");
  });

  test("falls back to VAULT_TOKEN env when no constructor token is given", async () => {
    process.env["VAULT_TOKEN"] = "env-token";
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify({ data: { data: { value: "v" } } }), { status: 200 }),
    );
    const backend = createVaultBackend({ addr: ADDR, fetchImpl });

    await backend.get("K");

    const sentToken = (calls[0]?.init?.headers as Record<string, string>)?.["X-Vault-Token"];
    expect(sentToken).toBe("env-token");
  });

  test("constructor token wins over VAULT_TOKEN env", async () => {
    process.env["VAULT_TOKEN"] = "env-token";
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify({ data: { data: { value: "v" } } }), { status: 200 }),
    );
    const backend = createVaultBackend({ addr: ADDR, token: "ctor-token", fetchImpl });

    await backend.get("K");

    const sentToken = (calls[0]?.init?.headers as Record<string, string>)?.["X-Vault-Token"];
    expect(sentToken).toBe("ctor-token");
  });

  test("throws when neither constructor token nor VAULT_TOKEN is set", async () => {
    const { fetchImpl } = stubFetch(() => new Response("{}"));
    const backend = createVaultBackend({ addr: ADDR, fetchImpl });
    expect(backend.get("K")).rejects.toBeInstanceOf(SecretsError);
  });
});

describe("vault backend — dataUrl name validation", () => {
  test("get rejects names with illegal characters (no fetch issued)", async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response("{}"));
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });
    expect(backend.get("bad name!")).rejects.toBeInstanceOf(SecretsError);
    await backend.get("bad name!").catch((e: unknown) => {
      const msg = (e as Error).message;
      expect(msg).toContain("invalid secret name");
      expect(msg).not.toContain("bad name!");
    });
    expect(calls.length).toBe(0);
  });

  test("rotate rejects names with illegal characters (no fetch issued)", async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response("{}"));
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });
    expect(backend.rotate("space here")).rejects.toBeInstanceOf(SecretsError);
    await backend.rotate("space here").catch(() => {});
    expect(calls.length).toBe(0);
  });

  test("allows KV-v2 nested paths (slashes are legal)", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify({ data: { data: { value: "nested" } } }), { status: 200 }),
    );
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });
    expect(await backend.get("app/db/password")).toBe("nested");
    expect(calls[0]?.url).toBe(`${ADDR}/v1/secret/data/app/db/password`);
  });

  test("uses a custom mount point when provided", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify({ data: { data: { value: "v" } } }), { status: 200 }),
    );
    const backend = createVaultBackend({ addr: ADDR, mount: "kv2", token: "t", fetchImpl });
    await backend.get("K");
    expect(calls[0]?.url).toBe(`${ADDR}/v1/kv2/data/K`);
  });
});

describe("vault backend — get() response handling", () => {
  test("returns the KV-v2 value on 200", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(JSON.stringify({ data: { data: { value: "vault-secret" } } }), {
          status: 200,
        }),
    );
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });
    expect(await backend.get("K")).toBe("vault-secret");
  });

  test("throws SecretsError on 404 (missing secret) without leaking name or url", async () => {
    const { fetchImpl } = stubFetch(() => new Response("not found", { status: 404 }));
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });
    expect(backend.get("SENSITIVE_NAME")).rejects.toBeInstanceOf(SecretsError);
    await backend.get("SENSITIVE_NAME").catch((e: unknown) => {
      const msg = (e as Error).message;
      expect(msg).toContain("404");
      expect(msg).not.toContain("SENSITIVE_NAME");
      // the url embeds the name + addr; it must not appear either.
      expect(msg).not.toContain(ADDR);
    });
  });

  test("throws SecretsError on a non-ok, non-404 status (e.g. 500) with status but no name/body", async () => {
    const { fetchImpl } = stubFetch(() => new Response("permission denied", { status: 500 }));
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });
    expect(backend.get("SENSITIVE_NAME")).rejects.toBeInstanceOf(SecretsError);
    await backend.get("SENSITIVE_NAME").catch((e: unknown) => {
      const msg = (e as Error).message;
      // status is retained for debugging...
      expect(msg).toContain("500");
      // ...but the raw response body and the secret name are redacted.
      expect(msg).not.toContain("permission denied");
      expect(msg).not.toContain("SENSITIVE_NAME");
    });
  });

  test("throws when KV-v2 body is missing data.data.value", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ data: { data: {} } }), { status: 200 }),
    );
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });
    expect(backend.get("SENSITIVE_NAME")).rejects.toBeInstanceOf(SecretsError);
    await backend.get("SENSITIVE_NAME").catch((e: unknown) => {
      const msg = (e as Error).message;
      expect(msg).toContain("missing data.data.value");
      expect(msg).not.toContain("SENSITIVE_NAME");
    });
  });

  test("throws when the value is present but not a string", async () => {
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify({ data: { data: { value: 42 } } }), { status: 200 }),
    );
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });
    expect(backend.get("K")).rejects.toBeInstanceOf(SecretsError);
  });

  test("throws when the response is an empty object (no data key)", async () => {
    const { fetchImpl } = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });
    expect(backend.get("K")).rejects.toBeInstanceOf(SecretsError);
  });
});

describe("vault backend — rotate()", () => {
  test("PUTs the supplied newValue and returns it", async () => {
    let putBody = "";
    const { fetchImpl, calls } = stubFetch((_url, init) => {
      if (init?.method === "PUT") {
        putBody = init.body as string;
        return new Response("{}", { status: 204 });
      }
      return new Response("not found", { status: 404 });
    });
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });

    const v = await backend.rotate("KEY", { newValue: "fresh" });

    expect(v).toBe("fresh");
    expect(JSON.parse(putBody)).toEqual({ data: { value: "fresh" } });
    const putCall = calls.find((c) => c.init?.method === "PUT");
    const headers = putCall?.init?.headers as Record<string, string>;
    expect(headers?.["X-Vault-Token"]).toBe("t");
    expect(headers?.["Content-Type"]).toBe("application/json");
  });

  test("auto-generates a 64-char hex secret when newValue is omitted", async () => {
    let putBody = "";
    const { fetchImpl } = stubFetch((_url, init) => {
      putBody = (init?.body as string) ?? "";
      return new Response("{}", { status: 200 });
    });
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });

    const v = await backend.rotate("KEY");

    expect(v).toMatch(/^[a-f0-9]{64}$/);
    // the generated value is what got PUT to vault
    expect(JSON.parse(putBody)).toEqual({ data: { value: v } });
  });

  test("throws SecretsError when the PUT is not ok, with status but no name/body", async () => {
    const { fetchImpl } = stubFetch(() => new Response("sealed", { status: 503 }));
    const backend = createVaultBackend({ addr: ADDR, token: "t", fetchImpl });
    expect(backend.rotate("SENSITIVE_NAME", { newValue: "x" })).rejects.toBeInstanceOf(
      SecretsError,
    );
    await backend.rotate("SENSITIVE_NAME", { newValue: "x" }).catch((e: unknown) => {
      const msg = (e as Error).message;
      // status is retained for debugging...
      expect(msg).toContain("503");
      // ...but the raw response body and the secret name are redacted.
      expect(msg).not.toContain("sealed");
      expect(msg).not.toContain("SENSITIVE_NAME");
    });
  });
});
