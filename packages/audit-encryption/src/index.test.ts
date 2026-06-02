import { afterAll, describe, expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvVarBackend, createSecrets } from "@crewhaus/secrets-manager";
import {
  AuditEncryptionError,
  type EncryptedRecord,
  InMemoryDekStore,
  createAuditEncryption,
  createFileDekStore,
  staticKekProvider,
} from "./index";

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

describe("#163 — salted, stretched KEK derivation (CWE-916)", () => {
  test("records carry a persisted scrypt salt and decrypt using it", async () => {
    const enc = await buildEncryption("passphrase-shaped-kek");
    const record = await enc.encryptPayload({ x: 1 }, "tenant-a");
    // Salt is persisted on the record (16 bytes => 32 hex chars).
    expect(record.kekSalt).toMatch(/^[a-f0-9]{32}$/);
    // The wrapping key is NOT a bare SHA-256 of the KEK: tampering with
    // the persisted salt must break unwrapping (proves the salt feeds
    // the derivation rather than being decorative).
    const wrongSalt = { ...record, kekSalt: "00".repeat(16) };
    await expect(enc.decryptPayload(wrongSalt)).rejects.toThrow();
    // With the genuine salt, the record round-trips.
    expect(await enc.decryptPayload(record)).toEqual({ x: 1 });
  });

  test("salt is fresh per record", async () => {
    const enc = await buildEncryption();
    const a = await enc.encryptPayload({ x: 1 }, "tenant-a");
    const b = await enc.encryptPayload({ x: 1 }, "tenant-a");
    expect(a.kekSalt).not.toBe(b.kekSalt);
  });

  test("legacy unsalted-SHA-256 records still decrypt (back-compat)", async () => {
    // Hand-build a record in the pre-migration format: DEK wrapped under a
    // bare SHA-256 of the KEK, with no `kekSalt` field.
    const kekValue = "legacy-kek-value-123456";
    setKek("KEK_TEST", kekValue);
    const secrets = createSecrets({ backend: createEnvVarBackend() });
    const store = new InMemoryDekStore();
    const dek = randomBytes(32);
    await store.set("tenant-legacy", dek);
    const legacyKekKey = createHash("sha256").update(kekValue).digest();

    const payloadIv = randomBytes(12);
    const pc = createCipheriv("aes-256-gcm", dek, payloadIv);
    const encryptedPayload = Buffer.concat([
      pc.update(Buffer.from(JSON.stringify({ legacy: true }), "utf8")),
      pc.final(),
    ]);
    const payloadTag = pc.getAuthTag();

    const dekIv = randomBytes(12);
    const wc = createCipheriv("aes-256-gcm", legacyKekKey, dekIv);
    const wrappedDek = Buffer.concat([wc.update(dek), wc.final()]);
    const wrappedTag = wc.getAuthTag();

    const legacyRecord: EncryptedRecord = {
      tenantId: "tenant-legacy",
      kekRef: "kek:KEK_TEST:v1", // the ref createAuditEncryption assigns at init
      dekRef: "dek:tenant-legacy:v1",
      // no kekSalt — the migration's tell-tale that legacy derivation applies
      iv: payloadIv.toString("hex"),
      tag: payloadTag.toString("hex"),
      encryptedPayload: encryptedPayload.toString("hex"),
      wrappedDek: wrappedDek.toString("hex"),
      wrappedDekIv: dekIv.toString("hex"),
      wrappedDekTag: wrappedTag.toString("hex"),
    };

    const enc = await createAuditEncryption({ secrets, kekName: "KEK_TEST", dekStore: store });
    expect(await enc.decryptPayload(legacyRecord)).toEqual({ legacy: true });
  });
});

describe("#164 — DEK versioning + rotation re-keys (CWE-323)", () => {
  test("a record encrypted before rotateKek still decrypts after", async () => {
    const store = new InMemoryDekStore();
    setKek("KEK_TEST", "kek-v1-secret-12345678");
    const secrets = createSecrets({ backend: createEnvVarBackend() });
    const enc = await createAuditEncryption({ secrets, kekName: "KEK_TEST", dekStore: store });

    const before = await enc.encryptPayload({ era: "v1" }, "tenant-a");
    expect(before.kekRef).toBe("kek:KEK_TEST:v1");

    await enc.rotateKek("kek-v2-secret-87654321", "kek:KEK_TEST:v2");
    expect(enc.kekRef).toBe("kek:KEK_TEST:v2");

    // Historical record (sealed under the now-superseded KEK) still decrypts.
    expect(await enc.decryptPayload(before)).toEqual({ era: "v1" });

    // And new writes use the new KEK + a freshly-minted DEK version.
    const after = await enc.encryptPayload({ era: "v2" }, "tenant-a");
    expect(after.kekRef).toBe("kek:KEK_TEST:v2");
    expect(await enc.decryptPayload(after)).toEqual({ era: "v2" });
  });

  test("rotateKek mints a fresh DEK version per tenant", async () => {
    const store = new InMemoryDekStore();
    setKek("KEK_TEST", "kek-v1-secret-12345678");
    const secrets = createSecrets({ backend: createEnvVarBackend() });
    const enc = await createAuditEncryption({ secrets, kekName: "KEK_TEST", dekStore: store });

    const v1a = await enc.encryptPayload({ x: 1 }, "tenant-a");
    const v1b = await enc.encryptPayload({ x: 1 }, "tenant-b");
    expect(v1a.dekRef).toBe("dek:tenant-a:v1");
    expect(v1b.dekRef).toBe("dek:tenant-b:v1");

    await enc.rotateKek("kek-v2-secret-87654321", "kek:KEK_TEST:v2");

    const v2a = await enc.encryptPayload({ x: 1 }, "tenant-a");
    const v2b = await enc.encryptPayload({ x: 1 }, "tenant-b");
    expect(v2a.dekRef).toBe("dek:tenant-a:v2");
    expect(v2b.dekRef).toBe("dek:tenant-b:v2");

    // The new DEK is genuinely different material (different wrapped DEK
    // even accounting for the fresh salt).
    expect(v2a.wrappedDek).not.toBe(v1a.wrappedDek);
  });

  test("DEK rolls to a new version once the per-DEK record threshold is hit", async () => {
    const store = new InMemoryDekStore();
    setKek("KEK_TEST", "kek-secret-12345678");
    const secrets = createSecrets({ backend: createEnvVarBackend() });
    const enc = await createAuditEncryption({
      secrets,
      kekName: "KEK_TEST",
      dekStore: store,
      maxRecordsPerDek: 2,
    });

    const r1 = await enc.encryptPayload({ n: 1 }, "tenant-a");
    const r2 = await enc.encryptPayload({ n: 2 }, "tenant-a");
    const r3 = await enc.encryptPayload({ n: 3 }, "tenant-a");
    // First two records share DEK v1; the third rolls to v2.
    expect(r1.dekRef).toBe("dek:tenant-a:v1");
    expect(r2.dekRef).toBe("dek:tenant-a:v1");
    expect(r3.dekRef).toBe("dek:tenant-a:v2");
    // All three still decrypt.
    expect(await enc.decryptPayload(r1)).toEqual({ n: 1 });
    expect(await enc.decryptPayload(r2)).toEqual({ n: 2 });
    expect(await enc.decryptPayload(r3)).toEqual({ n: 3 });
  });

  test("decrypt throws if no KEK material is retained for the record's kekRef", async () => {
    const enc = await buildEncryption();
    const record = await enc.encryptPayload({ x: 1 }, "tenant-a");
    const orphaned = { ...record, kekRef: "kek:KEK_TEST:unknown-9999" };
    await expect(enc.decryptPayload(orphaned)).rejects.toThrow(/no KEK material retained/);
  });
});

describe("#163/#164 follow-up — persistent FileDekStore across restart", () => {
  const tmpDirs: string[] = [];
  function freshDir(): string {
    const d = mkdtempSync(join(tmpdir(), "audit-enc-dek-"));
    tmpDirs.push(d);
    return d;
  }
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  const V1 = "kek-v1-secret-12345678";
  const V2 = "kek-v2-secret-87654321";
  const V1_REF = "kek:KEK_TEST:v1";
  const V2_REF = "kek:KEK_TEST:v2";

  test("FileDekStore is a drop-in DekStore: encrypt + decrypt round-trip", async () => {
    const dir = freshDir();
    setKek("KEK_TEST", V1);
    const secrets = createSecrets({ backend: createEnvVarBackend() });
    const store = createFileDekStore(dir, staticKekProvider({ kekRef: V1_REF, kekValue: V1 }));
    const enc = await createAuditEncryption({ secrets, kekName: "KEK_TEST", dekStore: store });
    const rec = await enc.encryptPayload({ event: "x" }, "tenant-a");
    expect(await enc.decryptPayload(rec)).toEqual({ event: "x" });
    // The tenant's DEK file exists on disk after the first write.
    expect(existsSync(join(dir, "dek-tenant-a.json"))).toBe(true);
  });

  test("persisted DEK file is wrapped (no raw key bytes, no KEK value) and 0o600", async () => {
    const dir = freshDir();
    setKek("KEK_TEST", V1);
    const secrets = createSecrets({ backend: createEnvVarBackend() });
    const store = createFileDekStore(dir, staticKekProvider({ kekRef: V1_REF, kekValue: V1 }));
    const enc = await createAuditEncryption({ secrets, kekName: "KEK_TEST", dekStore: store });
    await enc.encryptPayload({ event: "x" }, "tenant-a");

    const file = join(dir, "dek-tenant-a.json");
    // File is owner-read/write only (0o600). Mask to the permission bits.
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    // Persists ONLY the wrapped DEK + binding metadata — never the KEK value.
    expect(parsed).toMatchObject({
      version: 1,
      uses: 1,
      kekRef: V1_REF,
      kekSalt: expect.stringMatching(/^[a-f0-9]{32}$/),
      wrappedDek: expect.stringMatching(/^[a-f0-9]+$/),
      wrappedDekIv: expect.stringMatching(/^[a-f0-9]{24}$/),
      wrappedDekTag: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    expect(parsed).not.toHaveProperty("dek");
    // The operator KEK value must not appear anywhere in the file.
    expect(raw).not.toContain(V1);
  });

  test("FRESH engine on the same file store decrypts a pre-rotation record after restart", async () => {
    const dir = freshDir();

    // --- Process 1: boot under v1, encrypt, then rotate to v2. ---
    setKek("KEK_TEST", V1);
    const secrets1 = createSecrets({ backend: createEnvVarBackend() });
    const store1 = createFileDekStore(dir, staticKekProvider({ kekRef: V1_REF, kekValue: V1 }));
    const enc1 = await createAuditEncryption({
      secrets: secrets1,
      kekName: "KEK_TEST",
      dekStore: store1,
    });

    const before = await enc1.encryptPayload({ era: "v1" }, "tenant-a");
    expect(before.kekRef).toBe(V1_REF);
    expect(before.dekRef).toBe("dek:tenant-a:v1");

    await enc1.rotateKek(V2, V2_REF);
    expect(enc1.kekRef).toBe(V2_REF);

    // --- Simulate a restart: brand-new engine + store, same dir. The
    // operator re-provides the current (post-rotation) KEK as the boot
    // value and re-supplies the prior KEK as retained material. Nothing
    // from process 1's in-memory state carries over. ---
    setKek("KEK_TEST", V2); // backend now returns the rotated value
    const secrets2 = createSecrets({ backend: createEnvVarBackend() });
    const store2 = createFileDekStore(
      dir,
      staticKekProvider({ kekRef: V2_REF, kekValue: V2 }, [{ kekRef: V1_REF, kekValue: V1 }]),
    );
    const enc2 = await createAuditEncryption({
      secrets: secrets2,
      kekName: "KEK_TEST",
      kekRef: V2_REF, // boot value is the v2 material; pin its true ref
      retainedKeks: [{ kekRef: V1_REF, kekValue: V1 }],
      dekStore: store2,
    });

    // The pre-rotation record (sealed under v1) still decrypts.
    expect(await enc2.decryptPayload(before)).toEqual({ era: "v1" });

    // The DEK use-count + version survived the restart: the rotation in
    // process 1 re-minted tenant-a to v2, and the fresh engine sees that
    // (it does NOT reset to a fresh v1 DEK).
    const after = await enc2.encryptPayload({ era: "v2" }, "tenant-a");
    expect(after.kekRef).toBe(V2_REF);
    expect(after.dekRef).toBe("dek:tenant-a:v2");
    expect(await enc2.decryptPayload(after)).toEqual({ era: "v2" });
  }, 20_000);

  test("use-count survives restart (DEK does not roll prematurely)", async () => {
    const dir = freshDir();
    setKek("KEK_TEST", V1);

    // Process 1: two writes against a maxRecordsPerDek of 3 (uses -> 2).
    const secrets1 = createSecrets({ backend: createEnvVarBackend() });
    const store1 = createFileDekStore(dir, staticKekProvider({ kekRef: V1_REF, kekValue: V1 }));
    const enc1 = await createAuditEncryption({
      secrets: secrets1,
      kekName: "KEK_TEST",
      dekStore: store1,
      maxRecordsPerDek: 3,
    });
    const r1 = await enc1.encryptPayload({ n: 1 }, "tenant-a");
    const r2 = await enc1.encryptPayload({ n: 2 }, "tenant-a");
    expect(r1.dekRef).toBe("dek:tenant-a:v1");
    expect(r2.dekRef).toBe("dek:tenant-a:v1");

    // Restart: fresh engine + store on the same dir, same KEK. The use
    // counter is read from disk (=2), so the 3rd write stays on v1 and the
    // 4th rolls to v2 — proving the counter was not reset to 0.
    const secrets2 = createSecrets({ backend: createEnvVarBackend() });
    const store2 = createFileDekStore(dir, staticKekProvider({ kekRef: V1_REF, kekValue: V1 }));
    const enc2 = await createAuditEncryption({
      secrets: secrets2,
      kekName: "KEK_TEST",
      dekStore: store2,
      maxRecordsPerDek: 3,
    });
    const r3 = await enc2.encryptPayload({ n: 3 }, "tenant-a");
    const r4 = await enc2.encryptPayload({ n: 4 }, "tenant-a");
    expect(r3.dekRef).toBe("dek:tenant-a:v1"); // 3rd use still fits v1
    expect(r4.dekRef).toBe("dek:tenant-a:v2"); // 4th rolls — counter persisted

    // All four records still decrypt under the persisted DEKs.
    expect(await enc2.decryptPayload(r1)).toEqual({ n: 1 });
    expect(await enc2.decryptPayload(r3)).toEqual({ n: 3 });
    expect(await enc2.decryptPayload(r4)).toEqual({ n: 4 });
  });

  test("reading a DEK file without its KEK material throws a clear error", async () => {
    const dir = freshDir();
    setKek("KEK_TEST", V1);
    const secrets = createSecrets({ backend: createEnvVarBackend() });
    // Persist a DEK wrapped under v1...
    const writeStore = createFileDekStore(dir, staticKekProvider({ kekRef: V1_REF, kekValue: V1 }));
    const enc = await createAuditEncryption({
      secrets,
      kekName: "KEK_TEST",
      dekStore: writeStore,
    });
    await enc.encryptPayload({ x: 1 }, "tenant-a");

    // ...then try to read it with a provider that lacks v1 entirely.
    const blindStore = createFileDekStore(dir, staticKekProvider({ kekRef: V2_REF, kekValue: V2 }));
    await expect(blindStore.getEntry?.("tenant-a")).rejects.toThrow(/no KEK material for kekRef/);
  });

  test("createFileDekStore rejects an empty rootDir", () => {
    expect(() =>
      createFileDekStore("", staticKekProvider({ kekRef: V1_REF, kekValue: V1 })),
    ).toThrow(/rootDir is required/);
  });

  test("FileDekStore.tenants lists persisted tenants for rotation", async () => {
    const dir = freshDir();
    setKek("KEK_TEST", V1);
    const secrets = createSecrets({ backend: createEnvVarBackend() });
    const store = createFileDekStore(dir, staticKekProvider({ kekRef: V1_REF, kekValue: V1 }));
    const enc = await createAuditEncryption({ secrets, kekName: "KEK_TEST", dekStore: store });
    await enc.encryptPayload({ x: 1 }, "tenant-a");
    await enc.encryptPayload({ x: 1 }, "tenant-b");
    const tenants = await store.tenants?.();
    expect([...(tenants ?? [])].sort()).toEqual(["tenant-a", "tenant-b"]);
  });
});

describe("staticKekProvider", () => {
  test("resolves current + retained, current wins on ref collision", () => {
    const p = staticKekProvider({ kekRef: "kek:a:v2", kekValue: "current-value" }, [
      { kekRef: "kek:a:v1", kekValue: "old-value" },
      // A stale retained entry under the current ref must not shadow it.
      { kekRef: "kek:a:v2", kekValue: "stale-value" },
    ]);
    expect(p.current()).toEqual({ kekRef: "kek:a:v2", kekValue: "current-value" });
    expect(p.resolve("kek:a:v1")).toBe("old-value");
    expect(p.resolve("kek:a:v2")).toBe("current-value");
    expect(p.resolve("kek:a:unknown")).toBeUndefined();
  });
});
