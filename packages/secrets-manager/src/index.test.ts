/**
 * Section 27 — `secrets-manager` tests:
 *  - T1 per backend (env-var, file, vault)
 *  - T8 cross-tenant secret isolation
 *  - T3 rotation callback within 5s of rotate()
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditRecord, openAuditLog } from "@crewhaus/audit-log";
import {
  SecretsError,
  createEnvVarBackend,
  createFileBackend,
  createSecrets,
  createVaultBackend,
} from "./index";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "secrets-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("env-var backend (T1)", () => {
  test("get returns the env value", async () => {
    const backend = createEnvVarBackend({
      env: { MY_SECRET: "abc123" } as NodeJS.ProcessEnv,
    });
    expect(await backend.get("MY_SECRET")).toBe("abc123");
  });

  test("get throws when missing", async () => {
    const backend = createEnvVarBackend({ env: {} as NodeJS.ProcessEnv });
    expect(backend.get("MISSING")).rejects.toBeInstanceOf(SecretsError);
  });

  test("get throws on empty-string value", async () => {
    const backend = createEnvVarBackend({
      env: { EMPTY: "" } as NodeJS.ProcessEnv,
    });
    expect(backend.get("EMPTY")).rejects.toBeInstanceOf(SecretsError);
  });

  test("rotate(newValue) overwrites the env entry and returns it", async () => {
    const env: NodeJS.ProcessEnv = { TOKEN: "old" };
    const backend = createEnvVarBackend({ env });
    const v = await backend.rotate("TOKEN", { newValue: "new" });
    expect(v).toBe("new");
    expect(env["TOKEN"]).toBe("new");
  });
});

describe("file backend (T1)", () => {
  test("get returns the file contents", async () => {
    const root = join(tmpRoot, "secrets");
    require("node:fs").mkdirSync(root);
    writeFileSync(join(root, "API_KEY"), "secret-value");
    const backend = createFileBackend({ rootDir: root });
    expect(await backend.get("API_KEY")).toBe("secret-value");
  });

  test("get throws when file missing", async () => {
    const root = join(tmpRoot, "secrets");
    require("node:fs").mkdirSync(root);
    const backend = createFileBackend({ rootDir: root });
    expect(backend.get("MISSING")).rejects.toBeInstanceOf(SecretsError);
  });

  test("rotate writes atomically (mode 0o600) and returns the new value", async () => {
    const root = join(tmpRoot, "secrets");
    require("node:fs").mkdirSync(root);
    writeFileSync(join(root, "TOKEN"), "old", { mode: 0o600 });
    const backend = createFileBackend({ rootDir: root });
    const v = await backend.rotate("TOKEN", { newValue: "fresh-token-xyz" });
    expect(v).toBe("fresh-token-xyz");
    expect(readFileSync(join(root, "TOKEN"), "utf8")).toBe("fresh-token-xyz");
  });

  test("rotate generates a hex token when newValue is omitted", async () => {
    const root = join(tmpRoot, "secrets");
    require("node:fs").mkdirSync(root);
    const backend = createFileBackend({ rootDir: root });
    const v = await backend.rotate("AUTO");
    expect(v).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects malformed names (T8 path-traversal defense)", async () => {
    const backend = createFileBackend({ rootDir: tmpRoot });
    expect(backend.get("../../../etc/passwd")).rejects.toBeInstanceOf(SecretsError);
    expect(backend.rotate("path/with/slash")).rejects.toBeInstanceOf(SecretsError);
  });
});

describe("vault backend (T1)", () => {
  test("get reads via KV v2 endpoint", async () => {
    let observedUrl = "";
    let observedToken = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      observedUrl = url;
      observedToken = (init?.headers as Record<string, string>)?.["X-Vault-Token"] ?? "";
      return new Response(JSON.stringify({ data: { data: { value: "vault-secret" } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const backend = createVaultBackend({
      addr: "http://127.0.0.1:8200",
      token: "test-token",
      fetchImpl,
    });
    const v = await backend.get("MY_KEY");
    expect(v).toBe("vault-secret");
    expect(observedUrl).toBe("http://127.0.0.1:8200/v1/secret/data/MY_KEY");
    expect(observedToken).toBe("test-token");
  });

  test("get throws on 404", async () => {
    const fetchImpl = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const backend = createVaultBackend({
      addr: "http://127.0.0.1:8200",
      token: "t",
      fetchImpl,
    });
    expect(backend.get("MISSING")).rejects.toBeInstanceOf(SecretsError);
  });

  test("rotate PUTs the new value", async () => {
    let observedBody = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        observedBody = init.body as string;
        return new Response("{}", { status: 204 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const backend = createVaultBackend({
      addr: "http://127.0.0.1:8200",
      token: "t",
      fetchImpl,
    });
    const v = await backend.rotate("KEY", { newValue: "fresh" });
    expect(v).toBe("fresh");
    expect(JSON.parse(observedBody)).toEqual({ data: { value: "fresh" } });
  });

  test("missing token throws", async () => {
    const oldToken = process.env["VAULT_TOKEN"];
    process.env["VAULT_TOKEN"] = undefined;
    const backend = createVaultBackend({ addr: "http://127.0.0.1:8200" });
    expect(backend.get("X")).rejects.toBeInstanceOf(SecretsError);
    if (oldToken !== undefined) process.env["VAULT_TOKEN"] = oldToken;
  });
});

describe("createSecrets — rotation handlers (T3)", () => {
  test("onRotation handlers fire within 5s of rotate()", async () => {
    const root = join(tmpRoot, "secrets");
    require("node:fs").mkdirSync(root);
    writeFileSync(join(root, "TOKEN"), "old");
    const secrets = createSecrets({
      backend: createFileBackend({ rootDir: root }),
    });

    const events: Array<{ name: string; newValue: string; rotatedAt: number }> = [];
    secrets.onRotation((e) => {
      events.push({ name: e.name, newValue: e.newValue, rotatedAt: e.rotatedAt });
    });

    const t0 = Date.now();
    await secrets.rotate("TOKEN", { newValue: "new-value" });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(5_000);
    expect(events.length).toBe(1);
    expect(events[0]?.name).toBe("TOKEN");
    expect(events[0]?.newValue).toBe("new-value");
  });

  test("multiple handlers fire in order; one throwing does not block others", async () => {
    const root = join(tmpRoot, "secrets");
    require("node:fs").mkdirSync(root);
    writeFileSync(join(root, "TOKEN"), "old");
    const secrets = createSecrets({ backend: createFileBackend({ rootDir: root }) });

    const calls: string[] = [];
    secrets.onRotation(() => {
      calls.push("first");
      throw new Error("first handler boom");
    });
    secrets.onRotation(() => {
      calls.push("second");
    });

    await secrets.rotate("TOKEN", { newValue: "new" });
    expect(calls).toEqual(["first", "second"]);
  });

  test("unsubscribe stops further notifications", async () => {
    const root = join(tmpRoot, "secrets");
    require("node:fs").mkdirSync(root);
    writeFileSync(join(root, "TOKEN"), "old");
    const secrets = createSecrets({ backend: createFileBackend({ rootDir: root }) });
    let calls = 0;
    const off = secrets.onRotation(() => {
      calls++;
    });
    await secrets.rotate("TOKEN", { newValue: "v1" });
    off();
    await secrets.rotate("TOKEN", { newValue: "v2" });
    expect(calls).toBe(1);
  });

  test("async handler that resolves is awaited before rotate() returns", async () => {
    const root = join(tmpRoot, "secrets");
    require("node:fs").mkdirSync(root);
    writeFileSync(join(root, "TOKEN"), "old");
    const secrets = createSecrets({ backend: createFileBackend({ rootDir: root }) });

    let settled = false;
    secrets.onRotation(async (e) => {
      // microtask + macrotask hop to prove rotate() actually awaits us
      await Promise.resolve();
      expect(e.newValue).toBe("async-value");
      settled = true;
    });

    await secrets.rotate("TOKEN", { newValue: "async-value" });
    expect(settled).toBe(true);
  });

  test("async handler that rejects is swallowed and does not block siblings", async () => {
    const root = join(tmpRoot, "secrets");
    require("node:fs").mkdirSync(root);
    writeFileSync(join(root, "TOKEN"), "old");
    const secrets = createSecrets({ backend: createFileBackend({ rootDir: root }) });

    const order: string[] = [];
    // rejecting async handler -> exercises the promise .catch(() => {}) path
    secrets.onRotation(async () => {
      order.push("rejecting");
      await Promise.resolve();
      throw new Error("async handler boom");
    });
    // resolving async sibling -> still runs
    secrets.onRotation(async () => {
      order.push("resolving");
    });

    // rotate must resolve (not reject) despite the rejecting handler
    const v = await secrets.rotate("TOKEN", { newValue: "v" });
    expect(v).toBe("v");
    expect(order).toEqual(["rejecting", "resolving"]);
  });
});

describe("createSecrets — audit-log integration (T8 tenant isolation)", () => {
  async function readAuditRecords(rootDir: string): Promise<AuditRecord[]> {
    const audit = await openAuditLog({ rootDir });
    const out: AuditRecord[] = [];
    for await (const rec of audit.read()) out.push(rec);
    return out;
  }

  test("audit-log records secrets_access only when tenant scoped", async () => {
    const root = join(tmpRoot, "secrets");
    const auditRoot = join(tmpRoot, "audit");
    require("node:fs").mkdirSync(root);
    writeFileSync(join(root, "K"), "v");

    const audit = await openAuditLog({ rootDir: auditRoot });
    const secretsTenantA = createSecrets({
      backend: createFileBackend({ rootDir: root }),
      auditLog: audit,
      tenantId: "tenant-a",
    });
    const secretsNoTenant = createSecrets({
      backend: createFileBackend({ rootDir: root }),
      auditLog: audit,
    });

    await secretsTenantA.get("K");
    await secretsNoTenant.get("K");

    const records = await readAuditRecords(auditRoot);
    expect(records.length).toBe(1);
    expect(records[0]?.kind).toBe("secrets_access");
    expect((records[0]?.payload as { tenantId: string }).tenantId).toBe("tenant-a");
  });

  test("rotate also audit-logs and includes timestamp", async () => {
    const root = join(tmpRoot, "secrets");
    const auditRoot = join(tmpRoot, "audit");
    require("node:fs").mkdirSync(root);
    writeFileSync(join(root, "K"), "v");

    const audit = await openAuditLog({ rootDir: auditRoot });
    const secrets = createSecrets({
      backend: createFileBackend({ rootDir: root }),
      auditLog: audit,
      tenantId: "tenant-a",
    });

    await secrets.rotate("K", { newValue: "v2" });
    const records = await readAuditRecords(auditRoot);
    expect(records.length).toBe(1);
    expect(records[0]?.kind).toBe("secrets_rotation");
    const payload = records[0]?.payload as {
      tenantId: string;
      name: string;
      backend: string;
      rotatedAt: number;
    };
    expect(payload.tenantId).toBe("tenant-a");
    expect(payload.name).toBe("K");
    expect(payload.backend).toBe("file");
    expect(typeof payload.rotatedAt).toBe("number");
  });
});

describe("createSecrets — doctor()", () => {
  test("reports available + missing for known names", async () => {
    const root = join(tmpRoot, "secrets");
    require("node:fs").mkdirSync(root);
    writeFileSync(join(root, "EXISTS"), "v");
    const secrets = createSecrets({
      backend: createFileBackend({ rootDir: root }),
      knownSecrets: ["EXISTS", "MISSING"],
    });
    const report = await secrets.doctor();
    expect(report.backend).toBe("file");
    expect(report.available).toEqual(["EXISTS"]);
    expect(report.missing).toEqual(["MISSING"]);
  });
});
