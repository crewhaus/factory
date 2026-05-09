import { describe, expect, test } from "bun:test";
import { createEnvVarBackend, createSecrets } from "@crewhaus/secrets-manager";
import { AuditEncryptionError, InMemoryDekStore, createAuditEncryption } from "./index";

function setKek(name: string, value: string): void {
  process.env[name] = value;
}

async function buildEncryption(kekValue = "ke-secret-1234567890") {
  setKek("KEK_TEST", kekValue);
  const secrets = createSecrets({ backend: createEnvVarBackend() });
  return createAuditEncryption({ secrets, kekName: "KEK_TEST" });
}

describe("createAuditEncryption (T1 + T2)", () => {
  test("encrypt + decrypt round-trip", async () => {
    const enc = await buildEncryption();
    const record = await enc.encryptPayload(
      { event: "policy_decision", verdict: "allow" },
      "tenant-a",
    );
    expect(record.tenantId).toBe("tenant-a");
    expect(record.encryptedPayload).toMatch(/^[a-f0-9]+$/);
    expect(record.iv).toMatch(/^[a-f0-9]{24}$/);
    expect(record.tag).toMatch(/^[a-f0-9]{32}$/);
    const decoded = await enc.decryptPayload(record);
    expect(decoded).toEqual({ event: "policy_decision", verdict: "allow" });
  });

  test("encryption is non-deterministic (fresh IV per record)", async () => {
    const enc = await buildEncryption();
    const a = await enc.encryptPayload({ event: "x" }, "tenant-a");
    const b = await enc.encryptPayload({ event: "x" }, "tenant-a");
    expect(a.iv).not.toBe(b.iv);
    expect(a.encryptedPayload).not.toBe(b.encryptedPayload);
    // Both decrypt back to the same value.
    expect(await enc.decryptPayload(a)).toEqual({ event: "x" });
    expect(await enc.decryptPayload(b)).toEqual({ event: "x" });
  });

  test("requires kekName", async () => {
    setKek("KEK_TEST", "v");
    const secrets = createSecrets({ backend: createEnvVarBackend() });
    await expect(createAuditEncryption({ secrets, kekName: "" })).rejects.toThrow(
      /kekName is required/,
    );
  });

  test("requires secrets", async () => {
    await expect(
      createAuditEncryption({
        secrets: undefined as unknown as ReturnType<typeof createSecrets>,
        kekName: "x",
      }),
    ).rejects.toThrow(/secrets is required/);
  });
});

describe("Per-tenant isolation", () => {
  test("DEK differs per tenant — same plaintext encrypts differently", async () => {
    const enc = await buildEncryption();
    const a = await enc.encryptPayload({ event: "x" }, "tenant-a");
    const b = await enc.encryptPayload({ event: "x" }, "tenant-b");
    // Different DEK means different wrapped DEK + different ciphertext.
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.encryptedPayload).not.toBe(b.encryptedPayload);
  });

  test("missing tenantId throws AuditEncryptionError", async () => {
    const enc = await buildEncryption();
    await expect(enc.encryptPayload({ x: 1 }, "")).rejects.toThrow(AuditEncryptionError);
  });
});

describe("T8 — tampered ciphertext detection", () => {
  test("flipping a byte in encryptedPayload causes decrypt to throw", async () => {
    const enc = await buildEncryption();
    const record = await enc.encryptPayload({ secret: "value" }, "tenant-a");
    // Flip the first byte of the ciphertext.
    const tampered = {
      ...record,
      encryptedPayload: (() => {
        const buf = Buffer.from(record.encryptedPayload, "hex");
        buf[0] = (buf[0] ?? 0) ^ 0xff;
        return buf.toString("hex");
      })(),
    };
    await expect(enc.decryptPayload(tampered)).rejects.toThrow();
  });

  test("flipping the auth tag causes decrypt to throw", async () => {
    const enc = await buildEncryption();
    const record = await enc.encryptPayload({ secret: "value" }, "tenant-a");
    const tampered = {
      ...record,
      tag: (() => {
        const buf = Buffer.from(record.tag, "hex");
        buf[0] = (buf[0] ?? 0) ^ 0xff;
        return buf.toString("hex");
      })(),
    };
    await expect(enc.decryptPayload(tampered)).rejects.toThrow();
  });

  test("flipping the IV causes decrypt to throw", async () => {
    const enc = await buildEncryption();
    const record = await enc.encryptPayload({ secret: "value" }, "tenant-a");
    const tampered = {
      ...record,
      iv: (() => {
        const buf = Buffer.from(record.iv, "hex");
        buf[0] = (buf[0] ?? 0) ^ 0xff;
        return buf.toString("hex");
      })(),
    };
    await expect(enc.decryptPayload(tampered)).rejects.toThrow();
  });

  test("flipping the wrapped DEK causes decrypt to throw", async () => {
    const enc = await buildEncryption();
    const record = await enc.encryptPayload({ secret: "value" }, "tenant-a");
    const tampered = {
      ...record,
      wrappedDek: (() => {
        const buf = Buffer.from(record.wrappedDek, "hex");
        buf[0] = (buf[0] ?? 0) ^ 0xff;
        return buf.toString("hex");
      })(),
    };
    await expect(enc.decryptPayload(tampered)).rejects.toThrow();
  });
});

describe("KEK rotation", () => {
  test("rotateKek with new value lets new records encrypt+decrypt", async () => {
    const enc = await buildEncryption("kek-v1-secret-12345678");
    await enc.rotateKek("kek-v2-secret-87654321", "kek:KEK_TEST:v2");
    expect(enc.kekRef).toBe("kek:KEK_TEST:v2");
    const r = await enc.encryptPayload({ x: 1 }, "tenant-a");
    expect(r.kekRef).toBe("kek:KEK_TEST:v2");
    const d = await enc.decryptPayload(r);
    expect(d).toEqual({ x: 1 });
  });
});

describe("DekStore plumbing", () => {
  test("custom DekStore is used for DEK persistence", async () => {
    setKek("KEK_TEST", "kek-secret-12345678");
    const secrets = createSecrets({ backend: createEnvVarBackend() });
    const store = new InMemoryDekStore();
    const enc = await createAuditEncryption({ secrets, kekName: "KEK_TEST", dekStore: store });
    await enc.encryptPayload({ x: 1 }, "tenant-a");
    expect(await store.get("tenant-a")).toBeDefined();
    expect((await store.get("tenant-a"))?.length).toBe(32);
  });

  test("InMemoryDekStore round-trip", async () => {
    const store = new InMemoryDekStore();
    expect(await store.get("missing")).toBeUndefined();
    const buf = Buffer.from("a".repeat(32));
    await store.set("tenant-a", buf);
    const out = await store.get("tenant-a");
    expect(out).toBeDefined();
    expect(out?.length).toBe(32);
  });
});
