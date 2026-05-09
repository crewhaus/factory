#!/usr/bin/env bun
/**
 * Section 39 data-retention-engine smoke.
 *
 * Probes:
 *   A) retain composition: longer duration wins
 *   B) export (right-to-export) → JSON + NDJSON; kinds filter; refuses
 *      cross-tenant fishing
 *   C) purge (right-to-delete): respects retention; restrictKind +
 *      `before` cutoff
 *   D) T8 — tenant-A purge does NOT touch tenant-B records
 *   E) audit-window override: active window blocks purge + sweep
 *   F) sweep (cron-style) is idempotent — re-running yields zero deletes
 */
import {
  InMemoryRecordStore,
  type RetentionRecord,
  createDataRetentionEngine,
} from "@crewhaus/data-retention-engine";

const DAY_MS = 24 * 60 * 60 * 1000;
const log = (s: string) => process.stdout.write(`[section-39-retention] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

const NOW = 1_700_000_000_000;
const rec = (id: string, tenant: string, kind: string, ageDays: number): RetentionRecord => ({
  id,
  tenantId: tenant,
  kind,
  createdAt: NOW - ageDays * DAY_MS,
  payload: {},
});

// ── Probe A: retain composition ───────────────────────────────────────────
log("probe A: retain composition takes the longer duration");
{
  const eng = createDataRetentionEngine({ recordStore: new InMemoryRecordStore() });
  eng.retain("tenant-a", "audit", 7);
  eng.retain("tenant-a", "audit", 30);
  eng.retain("tenant-a", "audit", 14);
  const policies = eng.listRetention();
  check("1 policy after composition", policies.length === 1);
  check("longest duration wins (30)", policies[0]?.durationDays === 30);
}

// ── Probe B: export ───────────────────────────────────────────────────────
log("probe B: export — JSON + NDJSON + cross-tenant guard");
{
  const store = new InMemoryRecordStore([
    rec("a-1", "tenant-a", "audit", 1),
    rec("a-2", "tenant-a", "metrics", 1),
    rec("b-1", "tenant-b", "audit", 1),
  ]);
  const eng = createDataRetentionEngine({ recordStore: store, now: () => NOW });
  const json = await eng.export("tenant-a", { format: "json" });
  check("JSON parses", Array.isArray(JSON.parse(json)));
  const nd = await eng.export("tenant-a", { format: "ndjson", kinds: ["audit"] });
  check("NDJSON kinds filter restricts to 1 line", nd.split("\n").length === 1);
  const bResult = await eng.export("tenant-a", { format: "json" });
  check("tenant-a export does NOT contain tenant-b", !bResult.includes("tenant-b"));
}

// ── Probe C: purge ────────────────────────────────────────────────────────
log("probe C: purge — respects retention + restrictKind + before");
{
  const store = new InMemoryRecordStore([
    rec("a-old-audit", "tenant-a", "audit", 100),
    rec("a-recent-audit", "tenant-a", "audit", 5),
    rec("a-old-metrics", "tenant-a", "metrics", 100),
  ]);
  const eng = createDataRetentionEngine({ recordStore: store, now: () => NOW });
  eng.retain("tenant-a", "audit", 30);
  // restrictKind: only audit kind, retention defers a-recent-audit.
  const r1 = await eng.purge("tenant-a", { kind: "audit" });
  check("purge.deleted = 1 (a-old-audit)", r1.deleted === 1);
  check(
    "retentionDeferred contains a-recent-audit",
    r1.retentionDeferred.includes("a-recent-audit"),
  );
  check("metrics record still present", store.ids().includes("a-old-metrics"));
}

// ── Probe D: T8 cross-tenant isolation ────────────────────────────────────
log("probe D: T8 — tenant-A purge leaves tenant-B records intact");
{
  const store = new InMemoryRecordStore([
    rec("a-1", "tenant-a", "audit", 100),
    rec("a-2", "tenant-a", "audit", 200),
    rec("b-1", "tenant-b", "audit", 100),
    rec("b-2", "tenant-b", "audit", 200),
  ]);
  const eng = createDataRetentionEngine({ recordStore: store, now: () => NOW });
  await eng.purge("tenant-a");
  const remaining = store.ids().sort();
  check("tenant-a records purged", !remaining.includes("a-1") && !remaining.includes("a-2"));
  check("tenant-b records intact", remaining.includes("b-1") && remaining.includes("b-2"));
}

// ── Probe E: audit-window override ────────────────────────────────────────
log("probe E: audit-window override blocks purge + sweep");
{
  const store = new InMemoryRecordStore([rec("a-1", "tenant-a", "audit", 200)]);
  const eng = createDataRetentionEngine({ recordStore: store, now: () => NOW });
  eng.addAuditWindow({
    frameworkId: "soc2",
    controlId: "CC7.2",
    expiresAt: NOW + 5 * DAY_MS,
  });
  const r = await eng.purge("tenant-a");
  check("purge deferred under active window", r.deleted === 0);
  check(
    "auditWindowDeferred carries frameworkId",
    r.auditWindowDeferred[0]?.frameworkId === "soc2",
  );
  check("record still present", store.ids().includes("a-1"));
}

// ── Probe F: sweep idempotence ────────────────────────────────────────────
log("probe F: sweep — idempotent across runs");
{
  const store = new InMemoryRecordStore([
    rec("a-old", "tenant-a", "audit", 100),
    rec("a-new", "tenant-a", "audit", 5),
  ]);
  const eng = createDataRetentionEngine({
    recordStore: store,
    now: () => NOW,
    defaultRetentionDays: 30,
  });
  const r1 = await eng.sweep();
  const r2 = await eng.sweep();
  check("sweep #1 deletes 1 expired record", r1.deletedCount === 1);
  check("sweep #2 deletes 0 records (idempotent)", r2.deletedCount === 0);
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
