#!/usr/bin/env bun
/**
 * Section 39 compliance-controls smoke. Closes out §39.
 *
 * The kickoff prompt's end-to-end smoke: write a fake audit corpus,
 * run encryption + retention sweep + a SOC 2 evidence collection,
 * assert the resulting bundle covers every required control. We
 * also exercise cross-tenant isolation via the §39 retention engine.
 *
 * Probes:
 *   A) write a fake audit corpus (10 records, mixed kinds)
 *   B) audit-encryption round-trip on those records
 *   C) data-retention sweep with audit-window override pinning the
 *      records during evidence collection
 *   D) compliance-controls SOC 2 collection — bundle covers every
 *      built-in CC6.x + CC7.x control
 *   E) cross-tenant isolation — tenant A purge does not touch tenant
 *      B records
 *   F) writeBundle persists to <tmp>/.crewhaus/compliance/<fw>/<id>/<period>.json
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditEncryption } from "@crewhaus/audit-encryption";
import type { AuditRecord, AuditRecordSource } from "@crewhaus/audit-log";
import {
  type ControlDefinition,
  SOC2_CONTROLS,
  createComplianceCollector,
} from "@crewhaus/compliance-controls";
import {
  InMemoryRecordStore,
  type RetentionRecord,
  createDataRetentionEngine,
} from "@crewhaus/data-retention-engine";
import { createPiiRedactor } from "@crewhaus/pii-redactor";
import { createEnvVarBackend, createSecrets } from "@crewhaus/secrets-manager";

const log = (s: string) => process.stdout.write(`[section-39-compliance] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

const NOW = 1_700_000_000_000;
const tmp = mkdtempSync(join(tmpdir(), "section-39-compliance-smoke-"));

function makeRecord(
  hash: string,
  kind: AuditRecord["kind"],
  payload: unknown,
  ageMs = 0,
): AuditRecord {
  return {
    ts: NOW - ageMs,
    version: 1,
    kind,
    payload,
    prevHash: "GENESIS",
    hash,
  };
}

// ── Probe A: fake audit corpus ────────────────────────────────────────────
log("probe A: write a 10-record audit corpus (multi-kind)");
const audit: AuditRecord[] = [
  makeRecord("h1", "policy_decision", { tenantId: "tenant-a", verdict: "allow" }),
  makeRecord("h2", "policy_decision", { tenantId: "tenant-b", verdict: "deny" }),
  makeRecord("h3", "model_call", { model: "claude-opus-4-7" }),
  makeRecord("h4", "tool_classification", { toolName: "Bash" }),
  makeRecord("h5", "secrets_rotation", { name: "OPENAI_API_KEY" }),
  makeRecord("h6", "secrets_access", { name: "OPENAI_API_KEY" }),
  makeRecord("h7", "gateway_request", { sessionId: "sess_1", route: "/agent" }),
  makeRecord("h8", "tenancy_context", { tenantId: "tenant-a" }),
  makeRecord("h9", "deployment_action", { action: "deploy", target: "prod" }),
  makeRecord("h10", "model_call", { model: "claude-sonnet-4-6" }),
];
check("corpus has 10 records", audit.length === 10);

// ── Probe B: audit-encryption round-trip ──────────────────────────────────
log("probe B: audit-encryption round-trip on the corpus");
process.env["KEK_SMOKE_39"] = "kek-section-39-smoke-secret-1234567890";
const secrets = createSecrets({ backend: createEnvVarBackend() });
const enc = await createAuditEncryption({ secrets, kekName: "KEK_SMOKE_39" });
{
  let mismatches = 0;
  for (const r of audit) {
    const e = await enc.encryptPayload(r.payload, "tenant-a");
    const d = await enc.decryptPayload(e);
    if (JSON.stringify(d) !== JSON.stringify(r.payload)) mismatches += 1;
  }
  check("all 10 records round-trip cleanly", mismatches === 0);
}

// ── Probe C: data-retention sweep with audit-window override ──────────────
log("probe C: retention sweep with active audit-window override");
{
  const retentionRecords: RetentionRecord[] = audit.map((r, i) => ({
    id: r.hash,
    tenantId: (r.payload as { tenantId?: string })?.tenantId ?? "tenant-a",
    kind: r.kind,
    createdAt: r.ts,
    payload: r.payload,
  }));
  const store = new InMemoryRecordStore(retentionRecords);
  const eng = createDataRetentionEngine({
    recordStore: store,
    now: () => NOW + 200 * 24 * 60 * 60 * 1000, // jump 200 days into the future
    defaultRetentionDays: 30,
  });
  // Active audit window pins everything during evidence collection.
  eng.addAuditWindow({
    frameworkId: "soc2",
    controlId: "CC6.1",
    expiresAt: NOW + 365 * 24 * 60 * 60 * 1000,
  });
  const sweep1 = await eng.sweep();
  check("audit window blocks sweep — 0 deletions", sweep1.deletedCount === 0);
  check("all 10 records still present", store.size() === 10);
}

// ── Probe D: SOC 2 evidence collection ────────────────────────────────────
log("probe D: SOC 2 evidence collection covers every CC6.x + CC7.x control");
const auditSource: AuditRecordSource = {
  async *read() {
    for (const r of audit) yield r;
  },
};
const collector = createComplianceCollector({
  auditSource,
  outputDir: join(tmp, ".crewhaus", "compliance"),
});
const bundles = await collector.collectAll("soc2", {
  period: "2026-Q2",
  signingKey: "smoke-signing-key",
});
const collectedIds = new Set(bundles.map((b) => b.controlId));
const expectedIds = new Set(SOC2_CONTROLS.map((c) => c.controlId));
check(
  `bundle count = SOC2_CONTROLS count (${bundles.length})`,
  bundles.length === expectedIds.size,
);
for (const id of expectedIds) {
  check(`SOC 2 ${id} bundle present`, collectedIds.has(id));
}
let signedCount = 0;
let nonEmptyCount = 0;
for (const b of bundles) {
  if (b.signature !== null && b.signature.length === 64) signedCount += 1;
  if (b.recordCount > 0) nonEmptyCount += 1;
}
check("every bundle is HMAC-signed", signedCount === bundles.length);
check("at least 3 bundles have records", nonEmptyCount >= 3);

// ── Probe E: cross-tenant isolation via retention engine ──────────────────
log("probe E: cross-tenant isolation — tenant-A purge keeps tenant-B records");
{
  const store = new InMemoryRecordStore([
    {
      id: "t-a-1",
      tenantId: "tenant-a",
      kind: "policy_decision",
      createdAt: NOW - 200 * 24 * 60 * 60 * 1000,
      payload: {},
    },
    {
      id: "t-b-1",
      tenantId: "tenant-b",
      kind: "policy_decision",
      createdAt: NOW - 200 * 24 * 60 * 60 * 1000,
      payload: {},
    },
  ]);
  const eng = createDataRetentionEngine({
    recordStore: store,
    now: () => NOW,
    defaultRetentionDays: 30,
  });
  await eng.purge("tenant-a");
  check("tenant-a record purged", !store.ids().includes("t-a-1"));
  check("tenant-b record intact", store.ids().includes("t-b-1"));
}

// ── Probe F: writeBundle persistence ──────────────────────────────────────
log("probe F: writeBundle persists to .crewhaus/compliance/<fw>/<id>/<period>.json");
{
  const written = bundles.map((b) => collector.writeBundle(b));
  for (const path of written) {
    if (!path.endsWith(".json")) {
      check(`unexpected path shape: ${path}`, false);
    }
  }
  // Verify at least one file is readable + parseable as JSON.
  const first = bundles[0];
  if (first === undefined) {
    check("at least one bundle exists", false);
  } else {
    const path = collector.writeBundle(first);
    const content = JSON.parse(readFileSync(path, "utf8"));
    check("written bundle round-trips through JSON.parse", content.controlId === first.controlId);
    check("written bundle preserves digest", content.digest === first.digest);
  }
}

// ── PII redactor sanity check ─────────────────────────────────────────────
log("probe G: pii-redactor cleans the audit payloads (sanity check)");
{
  const redactor = createPiiRedactor();
  const dirty = "Tenant alice@example.com SSN 123-45-6789 phone 415-555-1234";
  const out = await redactor.redact(dirty);
  check("multi-PII payload redacted", out.redactedHits.length >= 3);
}

rmSync(tmp, { recursive: true, force: true });

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);

// Suppress unused-export warning on ControlDefinition (it's the public type
// for callers but not directly referenced in this smoke).
type _Control = ControlDefinition;
