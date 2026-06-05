import { describe, expect, test } from "bun:test";
import {
  DataRetentionError,
  InMemoryRecordStore,
  type RecordStore,
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
    expect([...store.ids()].sort()).toEqual(["b-1", "b-2"]);
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

describe("InMemoryRecordStore", () => {
  test("size() reports the current record count and tracks deletes", async () => {
    const store = new InMemoryRecordStore([
      record("a-1", "tenant-a", "audit", 5),
      record("a-2", "tenant-a", "audit", 5),
    ]);
    expect(store.size()).toBe(2);
    await store.delete("a-1");
    expect(store.size()).toBe(1);
    await store.delete("nope"); // no-op
    expect(store.size()).toBe(1);
  });

  test("delete() returns false when the id is absent", async () => {
    const store = new InMemoryRecordStore([record("a-1", "tenant-a", "audit", 5)]);
    expect(await store.delete("ghost")).toBe(false);
    expect(await store.delete("a-1")).toBe(true);
  });
});

describe("default clock", () => {
  // Exercises the fallback `now` (Date.now) path when no `now` is injected.
  test("addAuditWindow uses Date.now() when no clock is supplied", () => {
    const eng = createDataRetentionEngine({ recordStore: new InMemoryRecordStore() });
    // A window far in the future must be accepted under the real clock...
    eng.addAuditWindow({
      frameworkId: "soc2",
      controlId: "CC6.1",
      expiresAt: Date.now() + 365 * DAY_MS,
    });
    expect(eng.listAuditWindows()).toHaveLength(1);
    // ...and an already-past window must be rejected under the real clock.
    expect(() =>
      eng.addAuditWindow({
        frameworkId: "soc2",
        controlId: "CC6.2",
        expiresAt: Date.now() - 1000,
      }),
    ).toThrow(DataRetentionError);
  });

  test("defaultRetentionDays falls back to 90 when unset", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryRecordStore([
      record("fresh", "tenant-a", "audit", 80, {}, now), // < 90d → kept
      record("stale", "tenant-a", "audit", 100, {}, now), // > 90d → purged
    ]);
    const eng = createDataRetentionEngine({ recordStore: store, now: () => now });
    const result = await eng.purge("tenant-a");
    expect(result.deleted).toBe(1);
    expect(store.ids()).toEqual(["fresh"]);
  });
});

describe("defensive cross-tenant guards (misbehaving store)", () => {
  // A custom store that ignores the tenant filter and leaks foreign records.
  // The engine's per-record `record.tenantId !== tenantId` guard must still
  // refuse to act on them (T8 belt-and-suspenders).
  class LeakyStore implements RecordStore {
    constructor(private readonly recs: ReadonlyArray<RetentionRecord>) {}
    async *listAll(): AsyncIterable<RetentionRecord> {
      for (const r of this.recs) yield r;
    }
    // Deliberately ignores `_tenantId` and yields EVERYTHING.
    async *listByTenant(_tenantId: string): AsyncIterable<RetentionRecord> {
      for (const r of this.recs) yield r;
    }
    async delete(): Promise<boolean> {
      return true;
    }
  }

  test("purge skips foreign-tenant records a leaky store yields", async () => {
    const now = 1_700_000_000_000;
    const deleted: string[] = [];
    const recs = [
      record("a-old", "tenant-a", "audit", 200, {}, now),
      record("b-old", "tenant-b", "audit", 200, {}, now),
    ];
    // Inline store so `delete` can record which ids the engine acts on.
    const store: RecordStore = {
      async *listAll() {
        for (const r of recs) yield r;
      },
      async *listByTenant() {
        for (const r of recs) yield r; // leaks every tenant
      },
      async delete(id: string): Promise<boolean> {
        deleted.push(id);
        return true;
      },
    };
    const eng = createDataRetentionEngine({
      recordStore: store,
      now: () => now,
      defaultRetentionDays: 30,
    });
    const result = await eng.purge("tenant-a");
    expect(result.deleted).toBe(1);
    expect(deleted).toEqual(["a-old"]); // tenant-b never touched
  });

  test("export omits foreign-tenant records a leaky store yields", async () => {
    const store = new LeakyStore([
      record("a-1", "tenant-a", "audit", 5),
      record("b-1", "tenant-b", "audit", 5),
    ]);
    const eng = createDataRetentionEngine({ recordStore: store });
    const out = await eng.export("tenant-a", { format: "json" });
    const parsed = JSON.parse(out) as RetentionRecord[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("a-1");
    expect(out.includes("b-1")).toBe(false);
  });
});

describe("delete-returns-false branches", () => {
  // When the store reports `delete` -> false (record already gone), neither
  // purge nor sweep should count it as deleted.
  class NoopDeleteStore implements RecordStore {
    constructor(private readonly recs: ReadonlyArray<RetentionRecord>) {}
    async *listAll(): AsyncIterable<RetentionRecord> {
      for (const r of this.recs) yield r;
    }
    async *listByTenant(tenantId: string): AsyncIterable<RetentionRecord> {
      for (const r of this.recs) if (r.tenantId === tenantId) yield r;
    }
    async delete(): Promise<boolean> {
      return false; // pretend the record vanished between list and delete
    }
  }

  test("purge does not count a delete that returns false", async () => {
    const now = 1_700_000_000_000;
    const store = new NoopDeleteStore([record("a-old", "tenant-a", "audit", 200, {}, now)]);
    const eng = createDataRetentionEngine({
      recordStore: store,
      now: () => now,
      defaultRetentionDays: 30,
    });
    const result = await eng.purge("tenant-a");
    expect(result.deleted).toBe(0);
  });

  test("sweep counts a delete that returns false as kept", async () => {
    const now = 1_700_000_000_000;
    const store = new NoopDeleteStore([record("a-old", "tenant-a", "audit", 200, {}, now)]);
    const eng = createDataRetentionEngine({
      recordStore: store,
      now: () => now,
      defaultRetentionDays: 30,
    });
    const result = await eng.sweep();
    expect(result.deletedCount).toBe(0);
    expect(result.recordsKept).toBe(1);
  });
});

describe("createDataRetentionEngine guard", () => {
  test("throws when recordStore is missing", () => {
    // Force the undefined-recordStore branch through the public factory.
    expect(() =>
      createDataRetentionEngine({ recordStore: undefined as unknown as RecordStore }),
    ).toThrow(DataRetentionError);
  });
});
