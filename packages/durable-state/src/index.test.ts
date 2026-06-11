/**
 * Audit follow-up R3 — store contract tests. The SAME behavioral suite runs
 * against both backends so the sqlite store is interchangeable with the
 * in-memory default; sqlite-only suites then cover what the in-memory store
 * can't promise: cross-instance (cross-process) visibility and atomicity.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  type BudgetStore,
  type DedupStore,
  InMemoryBudgetStore,
  InMemoryDedupStore,
  SqliteBudgetStore,
  SqliteDedupStore,
  createBudgetStore,
  createDedupStore,
} from "./index";

let tmp: string | undefined;
const opened: Array<DedupStore | BudgetStore> = [];

afterEach(async () => {
  while (opened.length > 0) {
    await opened.pop()?.close();
  }
  if (tmp !== undefined) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function dbPath(name: string): string {
  if (tmp === undefined) tmp = mkdtempSync(path.join(tmpdir(), "durable-state-"));
  return path.join(tmp, name);
}

function track<T extends DedupStore | BudgetStore>(store: T): T {
  opened.push(store);
  return store;
}

const LIMITS = { maxInputTokens: 100, maxOutputTokens: 100 };

// ---------------------------------------------------------------------------
// Backend-agnostic contracts
// ---------------------------------------------------------------------------

const dedupBackends: Array<[string, () => DedupStore]> = [
  ["InMemoryDedupStore", () => track(new InMemoryDedupStore())],
  ["SqliteDedupStore", () => track(new SqliteDedupStore({ path: dbPath("dedup.db") }))],
];

describe.each(dedupBackends)("DedupStore contract — %s", (_name, make) => {
  test("first remember returns false, repeat returns true", async () => {
    const store = make();
    expect(await store.remember("evt_1")).toBe(false);
    expect(await store.remember("evt_1")).toBe(true);
    expect(await store.remember("evt_2")).toBe(false);
  });

  test("clear() forgets recorded keys", async () => {
    const store = make();
    await store.remember("evt_1");
    await store.clear();
    expect(await store.remember("evt_1")).toBe(false);
  });
});

const budgetBackends: Array<[string, () => BudgetStore]> = [
  ["InMemoryBudgetStore", () => track(new InMemoryBudgetStore())],
  ["SqliteBudgetStore", () => track(new SqliteBudgetStore({ path: dbPath("budget.db") }))],
];

describe.each(budgetBackends)("BudgetStore contract — %s", (_name, make) => {
  test("reserve within limits succeeds; usage stays recorded-only", async () => {
    const store = make();
    expect(await store.tryReserve("t1", { input: 40, output: 10 }, LIMITS)).toEqual({ ok: true });
    expect(await store.usage("t1")).toEqual({ input: 0, output: 0 });
  });

  test("recorded + reserved + delta over the limit is refused with totals", async () => {
    const store = make();
    await store.recordUsage("t1", { input: 60, output: 0 });
    expect(await store.tryReserve("t1", { input: 30, output: 0 }, LIMITS)).toEqual({ ok: true });
    const refused = await store.tryReserve("t1", { input: 20, output: 0 }, LIMITS);
    expect(refused).toEqual({ ok: false, reason: "input", total: 110, limit: 100 });
  });

  test("a refused reserve reserves NOTHING", async () => {
    const store = make();
    await store.recordUsage("t1", { input: 95, output: 0 });
    expect((await store.tryReserve("t1", { input: 50, output: 0 }, LIMITS)).ok).toBe(false);
    // A small reserve that fits must still succeed — nothing leaked.
    expect(await store.tryReserve("t1", { input: 2, output: 0 }, LIMITS)).toEqual({ ok: true });
  });

  test("a zero-delta reserve still refuses when recorded usage is at the cap", async () => {
    const store = make();
    await store.recordUsage("t1", { input: 100, output: 0 });
    const refused = await store.tryReserve("t1", { input: 0, output: 0 }, LIMITS);
    expect(refused).toEqual({ ok: false, reason: "input", total: 100, limit: 100 });
  });

  test("the output dimension is enforced independently", async () => {
    const store = make();
    await store.recordUsage("t1", { input: 0, output: 99 });
    const refused = await store.tryReserve("t1", { input: 1, output: 5 }, LIMITS);
    expect(refused).toEqual({ ok: false, reason: "output", total: 104, limit: 100 });
  });

  test("release frees reserved capacity and clamps at zero", async () => {
    const store = make();
    expect(await store.tryReserve("t1", { input: 90, output: 0 }, LIMITS)).toEqual({ ok: true });
    expect((await store.tryReserve("t1", { input: 90, output: 0 }, LIMITS)).ok).toBe(false);
    await store.release("t1", { input: 90, output: 0 });
    expect(await store.tryReserve("t1", { input: 90, output: 0 }, LIMITS)).toEqual({ ok: true });
    // Over-release must clamp, not go negative.
    await store.release("t1", { input: 9999, output: 9999 });
    expect((await store.tryReserve("t1", { input: 99, output: 0 }, LIMITS)).ok).toBe(true);
  });

  test("recordUsage accumulates and usage() reads it back", async () => {
    const store = make();
    await store.recordUsage("t1", { input: 10, output: 5 });
    await store.recordUsage("t1", { input: 7, output: 3 });
    expect(await store.usage("t1")).toEqual({ input: 17, output: 8 });
    expect(await store.usage("other")).toEqual({ input: 0, output: 0 });
  });

  test("tenants are isolated", async () => {
    const store = make();
    await store.recordUsage("t1", { input: 99, output: 0 });
    expect(await store.tryReserve("t2", { input: 50, output: 0 }, LIMITS)).toEqual({ ok: true });
  });

  test("clearReservations frees in-flight capacity but keeps recorded usage", async () => {
    const store = make();
    await store.recordUsage("t1", { input: 50, output: 0 });
    expect(await store.tryReserve("t1", { input: 49, output: 0 }, LIMITS)).toEqual({ ok: true });
    expect((await store.tryReserve("t1", { input: 49, output: 0 }, LIMITS)).ok).toBe(false);
    await store.clearReservations();
    expect(await store.tryReserve("t1", { input: 49, output: 0 }, LIMITS)).toEqual({ ok: true });
    expect(await store.usage("t1")).toEqual({ input: 50, output: 0 });
  });
});

// ---------------------------------------------------------------------------
// SQLite-only: cross-instance (stand-in for cross-process) guarantees
// ---------------------------------------------------------------------------

describe("SqliteDedupStore — cross-instance", () => {
  test("a key remembered by one instance is a duplicate for another on the same file", async () => {
    const file = dbPath("shared-dedup.db");
    const a = track(new SqliteDedupStore({ path: file }));
    const b = track(new SqliteDedupStore({ path: file }));
    expect(await a.remember("evt_shared")).toBe(false);
    expect(await b.remember("evt_shared")).toBe(true);
  });

  test("concurrent remember on the same key: exactly one instance wins", async () => {
    const file = dbPath("race-dedup.db");
    const a = track(new SqliteDedupStore({ path: file }));
    const b = track(new SqliteDedupStore({ path: file }));
    const results = await Promise.all([a.remember("evt_race"), b.remember("evt_race")]);
    expect(results.filter((seen) => seen === false).length).toBe(1);
  });

  test("expired keys can be remembered again (TTL prune inside the txn)", async () => {
    let t = 1_000_000;
    const store = track(
      new SqliteDedupStore({ path: dbPath("ttl-dedup.db"), ttlMs: 60_000, _now: () => t }),
    );
    expect(await store.remember("evt_ttl")).toBe(false);
    expect(await store.remember("evt_ttl")).toBe(true);
    t += 60_001; // past expiry
    expect(await store.remember("evt_ttl")).toBe(false);
  });

  test("survives instance restart (durability)", async () => {
    const file = dbPath("restart-dedup.db");
    const first = new SqliteDedupStore({ path: file });
    await first.remember("evt_durable");
    await first.close();
    const second = track(new SqliteDedupStore({ path: file }));
    expect(await second.remember("evt_durable")).toBe(true);
  });
});

describe("SqliteBudgetStore — cross-instance", () => {
  test("usage recorded by one instance bounds reservations in another", async () => {
    const file = dbPath("shared-budget.db");
    const a = track(new SqliteBudgetStore({ path: file }));
    const b = track(new SqliteBudgetStore({ path: file }));
    await a.recordUsage("t1", { input: 80, output: 0 });
    const refused = await b.tryReserve("t1", { input: 30, output: 0 }, LIMITS);
    expect(refused).toEqual({ ok: false, reason: "input", total: 110, limit: 100 });
  });

  test("jointly-exceeding concurrent reserves: at most one succeeds", async () => {
    const file = dbPath("race-budget.db");
    const a = track(new SqliteBudgetStore({ path: file }));
    const b = track(new SqliteBudgetStore({ path: file }));
    // Each fits alone (60 < 100); together they exceed (120 >= 100). The
    // IMMEDIATE transaction serializes them: the loser sees the winner's
    // reservation.
    const results = await Promise.all([
      a.tryReserve("t1", { input: 60, output: 0 }, LIMITS),
      b.tryReserve("t1", { input: 60, output: 0 }, LIMITS),
    ]);
    expect(results.filter((r) => r.ok).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Spec-string factories
// ---------------------------------------------------------------------------

describe("createDedupStore / createBudgetStore", () => {
  test('"memory" builds the in-memory backends', () => {
    expect(track(createDedupStore("memory"))).toBeInstanceOf(InMemoryDedupStore);
    expect(track(createBudgetStore("memory"))).toBeInstanceOf(InMemoryBudgetStore);
  });

  test('"sqlite:<path>" builds the sqlite backends', () => {
    expect(track(createDedupStore(`sqlite:${dbPath("f1.db")}`))).toBeInstanceOf(SqliteDedupStore);
    expect(track(createBudgetStore(`sqlite:${dbPath("f2.db")}`))).toBeInstanceOf(SqliteBudgetStore);
  });

  test("unknown specs fail closed with a clear error", () => {
    expect(() => createDedupStore("redis://nope")).toThrow(/expected "memory" or "sqlite:<path>"/);
    expect(() => createBudgetStore("sqlite:")).toThrow(/needs a file path/);
  });
});
