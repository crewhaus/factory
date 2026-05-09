#!/usr/bin/env bun
/**
 * Section 39 audit-encryption smoke.
 *
 * Probes:
 *   A) encrypt/decrypt round-trip via env-var KEK backend
 *   B) per-tenant DEK isolation: tenant A and tenant B encrypt the
 *      same plaintext to different ciphertexts
 *   C) T8 — tampered ciphertext / IV / auth tag / wrapped DEK all
 *      cause decrypt to throw (GCM authentication catches all)
 *   D) KEK rotation: new records use the rotated kekRef and still
 *      decrypt cleanly
 */
import { createAuditEncryption } from "@crewhaus/audit-encryption";
import { createEnvVarBackend, createSecrets } from "@crewhaus/secrets-manager";

const log = (s: string) => process.stdout.write(`[section-39-enc] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

process.env["KEK_SMOKE"] = "kek-smoke-secret-abcdef0123456789";
const secrets = createSecrets({ backend: createEnvVarBackend() });
const enc = await createAuditEncryption({ secrets, kekName: "KEK_SMOKE" });

// ── Probe A: round-trip ───────────────────────────────────────────────────
log("probe A: encrypt + decrypt round-trip");
{
  const payload = { event: "policy_decision", tenant: "alice", verdict: "allow", risk: 0.2 };
  const record = await enc.encryptPayload(payload, "alice-tenant");
  check("record.tenantId set", record.tenantId === "alice-tenant");
  check("record.kekRef set", record.kekRef.startsWith("kek:KEK_SMOKE:"));
  check("encryptedPayload is hex", /^[a-f0-9]+$/.test(record.encryptedPayload));
  check("iv is 24 hex chars (96 bits)", /^[a-f0-9]{24}$/.test(record.iv));
  check("tag is 32 hex chars (128 bits)", /^[a-f0-9]{32}$/.test(record.tag));
  const decoded = await enc.decryptPayload(record);
  check("decrypt matches original", JSON.stringify(decoded) === JSON.stringify(payload));
}

// ── Probe B: per-tenant DEK isolation ─────────────────────────────────────
log("probe B: per-tenant DEK isolation");
{
  const a = await enc.encryptPayload({ x: 1 }, "tenant-a");
  const b = await enc.encryptPayload({ x: 1 }, "tenant-b");
  check("different wrapped DEKs per tenant", a.wrappedDek !== b.wrappedDek);
  check(
    "different ciphertexts per tenant for same plaintext",
    a.encryptedPayload !== b.encryptedPayload,
  );
}

// ── Probe C: T8 tamper detection ──────────────────────────────────────────
log("probe C: T8 — tampered ciphertext fails decrypt (GCM)");
{
  const r = await enc.encryptPayload({ secret: "leakable" }, "tenant-c");
  const flip = (hex: string): string => {
    const buf = Buffer.from(hex, "hex");
    buf[0] = (buf[0] ?? 0) ^ 0xff;
    return buf.toString("hex");
  };
  const variants = [
    { name: "encryptedPayload", record: { ...r, encryptedPayload: flip(r.encryptedPayload) } },
    { name: "iv", record: { ...r, iv: flip(r.iv) } },
    { name: "tag", record: { ...r, tag: flip(r.tag) } },
    { name: "wrappedDek", record: { ...r, wrappedDek: flip(r.wrappedDek) } },
  ];
  for (const v of variants) {
    let threw = false;
    try {
      await enc.decryptPayload(v.record);
    } catch {
      threw = true;
    }
    check(`tampered ${v.name} → decrypt throws`, threw);
  }
}

// ── Probe D: KEK rotation ─────────────────────────────────────────────────
log("probe D: KEK rotation produces new kekRef on subsequent records");
{
  const before = enc.kekRef;
  await enc.rotateKek("rotated-kek-secret-abcdef0123456789", "kek:KEK_SMOKE:v2");
  check("kekRef updated", enc.kekRef !== before && enc.kekRef === "kek:KEK_SMOKE:v2");
  const r = await enc.encryptPayload({ rotated: true }, "tenant-r");
  check("new record carries rotated kekRef", r.kekRef === "kek:KEK_SMOKE:v2");
  const d = await enc.decryptPayload(r);
  check(
    "decrypt under rotated KEK round-trips",
    JSON.stringify(d) === JSON.stringify({ rotated: true }),
  );
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
