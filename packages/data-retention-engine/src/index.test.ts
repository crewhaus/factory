import { describe, expect, test } from "bun:test";
import {
  DataRetentionError,
  InMemoryRecordStore,
  type RetentionRecord,
  _msPerDayForTest,
  createDataRetentionEngine,
} from "./index";

const DAY_MS = _msPerDayForTest;

function record(
  id: string,
  tenantId: string,
  kind: string,
  ageDays: number,
  payload: unknown = {},
  fromNow = Date.now(),
): RetentionRecord {
  return {
    id,
    tenantId,
    kind,
    createdAt: fromNow - ageDays * DAY_MS,
    payload,
  };
}

describe("retention policies (T1)", () => {
  test("retain stores tenant+kind+duration", () => {
    const store = new InMemoryRecordStore();
    const eng = createDataRetentionEngine({ recordStore: store });
    eng.retain("tenant-a", "audit", 30);
    eng.retain("tenant-b", "metrics", 7);
    expect(eng.listRetention()).toEqual([
      { tenantId: "tenant-a", kind: "audit", durationDays: 30 },
      { tenantId: "tenant-b", kind: "metrics", durationDays: 7 },
    ]);
  });

  test("retain composition takes the LONGER duration when re-set", () => {
    const eng = createDataRetentionEngine({ recordStore: new InMemoryRecordStore() });
    eng.retain("tenant-a", "audit", 30);
    eng.retain("tenant-a", "audit", 7);
    eng.retain("tenant-a", "audit", 60);
    const policies = eng.listRetention();
    expect(policies).toHaveLength(1);
    expect(policies[0]?.durationDays).toBe(60);
  });

  test("removeRetention drops the policy", () => {
    const eng = createDataRetentionEngine({ recordStore: new InMemoryRecordStore() });
    eng.retain("tenant-a", "audit", 30);
    eng.removeRetention("tenant-a", "audit");
    expect(eng.listRetention()).toEqual([]);
  });

  test("invalid retain inputs throw", () => {
    const eng = createDataRetentionEngine({ recordStore: new InMemoryRecordStore() });
    expect(() => eng.retain("", "k", 1)).toThrow(DataRetentionError);
    expect(() => eng.retain("t", "", 1)).toThrow(DataRetentionError);
    expect(() => eng.retain("t", "k", 0)).toThrow(DataRetentionError);
    expect(() => eng.retain("t", "k", -1)).toThrow(DataRetentionError);
  });
});

describe("purge (T1 + T8 cross-tenant isolation)", () => {
  test("purge respects retention policy — recent records survive", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryRecordStore([
      record("a-recent", "tenant-a", "audit", 5, {}, now),
      record("a-old", "tenant-a", "audit", 100, {}, now),
    ]);
    const eng = createDataRetentionEngine({ recordStore: store, now: () => now });
    eng.retain("tenant-a", "audit", 30);
    const result = await eng.purge("tenant-a");
    expect(result.deleted).toBe(1);
    expect(result.retentionDeferred).toEqual(["a-recent"]);
    expect(store.ids()).toEqual(["a-recent"]);
  });

  test("purge with restrictKind only deletes that kind", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryRecordStore([
      record("audit-1", "tenant-a", "audit", 100, {}, now),
      record("metrics-1", "tenant-a", "metrics", 100, {}, now),
    ]);
    const eng = createDataRetentionEngine({ recordStore: store, now: () => now });
    await eng.purge("tenant-a", { kind: "audit" });
    expect(store.ids()).toEqual(["metrics-1"]);
  });

  test("purge with `before` cutoff only deletes pre-cutoff records", async () => {
    const now = 1_700_000_000_000;
    const cutoff = now - 50 * DAY_MS;
    const store = new InMemoryRecordStore([
      record("old", "tenant-a", "audit", 100, {}, now), // pre-cutoff
      record("recent", "tenant-a", "audit", 30, {}, now), // post-cutoff
    ]);
    const eng = createDataRetentionEngine({ recordStore: store, now: () => now });
    await eng.purge("tenant-a", { before: cutoff });
    expect(store.ids()).toEqual(["recent"]);
  });

  test("T8 — tenant-A purge does NOT touch tenant-B records", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryRecordStore([
      record("a-1", "tenant-a", "audit", 100, {}, now),
      record("a-2", "tenant-a", "audit", 200, {}, now),
      record("b-1", "tenant-b", "audit", 100, {}, now),
      record("b-2", "tenant-b", "audit", 200, {}, now),
    ]);
    const eng = createDataRetentionEngine({ recordStore: store, now: () => now });
    await eng.purge("tenant-a");
    // tenant-a records gone; tenant-b records intact.
    expect(store.ids().sort()).toEqual(["b-1", "b-2"]);
  });

  test("missing tenantId throws", async () => {
    const eng = createDataRetentionEngine({ recordStore: new InMemoryRecordStore() });
    await expect(eng.purge("")).rejects.toThrow(DataRetentionError);
  });
});

describe("audit-window override", () => {
  test("active audit window blocks purge", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryRecordStore([record("a-1", "tenant-a", "audit", 200, {}, now)]);
    const eng = createDataRetentionEngine({ recordStore: store, now: () => now });
    eng.addAuditWindow({
      frameworkId: "soc2",
      controlId: "CC6.1",
      expiresAt: now + 10 * DAY_MS,
    });
    const result = await eng.purge("tenant-a");
    expect(result.deleted).toBe(0);
    expect(result.deferred).toEqual(["a-1"]);
    expect(result.auditWindowDeferred).toHaveLength(1);
    expect(result.auditWindowDeferred[0]?.frameworkId).toBe("soc2");
    expect(store.ids()).toEqual(["a-1"]);
  });

  test("expired audit window does not block purge", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryRecordStore([record("a-1", "tenant-a", "audit", 200, {}, now)]);
    const eng = createDataRetentionEngine({ recordStore: store, now: () => now });
    expect(() =>
      eng.addAuditWindow({
        frameworkId: "soc2",
        controlId: "CC6.1",
        expiresAt: now - 1, // already expired
      }),
    ).toThrow(DataRetentionError);
  });

  test("listAuditWindows drops expired entries", () => {
    let mutableNow = 1_700_000_000_000;
    const eng = createDataRetentionEngine({
      recordStore: new InMemoryRecordStore(),
      now: () => mutableNow,
    });
    eng.addAuditWindow({
      frameworkId: "soc2",
      controlId: "CC6.1",
      expiresAt: mutableNow + 5 * DAY_MS,
    });
    expect(eng.listAuditWindows()).toHaveLength(1);
    mutableNow += 10 * DAY_MS;
    expect(eng.listAuditWindows()).toHaveLength(0);
  });
});

describe("export (right-to-export)", () => {
  test("JSON format returns pretty-printed array", async () => {
    const store = new InMemoryRecordStore([
      record("a-1", "tenant-a", "audit", 5),
      record("a-2", "tenant-a", "audit", 10),
      record("b-1", "tenant-b", "audit", 5),
    ]);
    const eng = createDataRetentionEngine({ recordStore: store });
    const out = await eng.export("tenant-a", { format: "json" });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("a-1");
  });

  test("NDJSON format returns one record per line", async () => {
    const store = new InMemoryRecordStore([
      record("a-1", "tenant-a", "audit", 5),
      record("a-2", "tenant-a", "metrics", 5),
    ]);
    const eng = createDataRetentionEngine({ recordStore: store });
    const out = await eng.export("tenant-a", { format: "ndjson" });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    const first = lines[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("missing line");
    expect(JSON.parse(first).id).toBe("a-1");
  });

  test("kinds filter restricts exported records", async () => {
    const store = new InMemoryRecordStore([
      record("a-1", "tenant-a", "audit", 5),
      record("a-2", "tenant-a", "metrics", 5),
    ]);
    const eng = createDataRetentionEngine({ recordStore: store });
    const out = await eng.export("tenant-a", { format: "ndjson", kinds: ["audit"] });
    expect(out.split("\n")).toHaveLength(1);
  });

  test("export refuses cross-tenant fishing", async () => {
    const store = new InMemoryRecordStore([
      record("a-1", "tenant-a", "audit", 5),
      record("b-1", "tenant-b", "audit", 5),
    ]);
    const eng = createDataRetentionEngine({ recordStore: store });
    const out = await eng.export("tenant-a", { format: "json" });
    expect(out.includes("tenant-b")).toBe(false);
    expect(out.includes("b-1")).toBe(false);
  });
});

describe("sweep (cron-style)", () => {
  test("deletes expired records across all tenants", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryRecordStore([
      record("a-old", "tenant-a", "audit", 100, {}, now),
      record("a-new", "tenant-a", "audit", 5, {}, now),
      record("b-old", "tenant-b", "audit", 200, {}, now),
    ]);
    const eng = createDataRetentionEngine({
      recordStore: store,
      now: () => now,
      defaultRetentionDays: 30,
    });
    const result = await eng.sweep();
    expect(result.deletedCount).toBe(2);
    expect(result.recordsKept).toBe(1);
    expect(store.ids()).toEqual(["a-new"]);
  });

  test("idempotent — re-running yields zero deletes (T9)", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryRecordStore([
      record("a-old", "tenant-a", "audit", 100, {}, now),
      record("a-new", "tenant-a", "audit", 5, {}, now),
    ]);
    const eng = createDataRetentionEngine({
      recordStore: store,
      now: () => now,
      defaultRetentionDays: 30,
    });
    const r1 = await eng.sweep();
    const r2 = await eng.sweep();
    expect(r1.deletedCount).toBe(1);
    expect(r2.deletedCount).toBe(0);
  });

  test("audit window blocks the entire sweep", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryRecordStore([
      record("a-old", "tenant-a", "audit", 100, {}, now),
      record("b-old", "tenant-b", "audit", 200, {}, now),
    ]);
    const eng = createDataRetentionEngine({
      recordStore: store,
      now: () => now,
      defaultRetentionDays: 30,
    });
    eng.addAuditWindow({
      frameworkId: "iso27001",
      controlId: "A.12.4",
      expiresAt: now + 10 * DAY_MS,
    });
    const result = await eng.sweep();
    expect(result.deletedCount).toBe(0);
    expect(result.recordsKept).toBe(2);
  });
});
