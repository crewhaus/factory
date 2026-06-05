import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError } from "@crewhaus/errors";
import { TenancyError, buildTenant, withTenant } from "@crewhaus/tenancy";
import {
  type Checkpoint,
  type CheckpointStore,
  type CheckpointStoreAdapter,
  CheckpointStoreError,
  type GraphRunId,
  type GraphRunMeta,
  type ListOptions,
  createCheckpointStore,
  newCheckpointId,
  newGraphRunId,
} from "./index";

let tmp: string;
let store: CheckpointStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "checkpoint-store-"));
  store = createCheckpointStore({ rootDir: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("id generators", () => {
  test("newGraphRunId matches the regex", () => {
    expect(newGraphRunId()).toMatch(/^grun_[0-9a-f]{16}$/);
  });
  test("newCheckpointId matches the regex", () => {
    expect(newCheckpointId()).toMatch(/^ckpt_[0-9a-f]{16}$/);
  });
});

describe("save + load round-trip", () => {
  test("save returns a Checkpoint with the requested fields", async () => {
    const grun = newGraphRunId();
    const cp = await store.save({ graphRunId: grun, nodeName: "plan", state: { foo: 1 } });
    expect(cp.graphRunId).toBe(grun);
    expect(cp.nodeName).toBe("plan");
    expect(cp.state).toEqual({ foo: 1 });
    expect(cp.id).toMatch(/^ckpt_[0-9a-f]{16}$/);
    expect(cp.parentCheckpointId).toBeUndefined();
  });

  test("load returns the saved checkpoint", async () => {
    const grun = newGraphRunId();
    const cp = await store.save({ graphRunId: grun, nodeName: "plan", state: { x: 1 } });
    const loaded = await store.load(grun, cp.id);
    expect(loaded?.id).toBe(cp.id);
    expect(loaded?.state).toEqual({ x: 1 });
  });

  test("load without checkpointId returns the head", async () => {
    const grun = newGraphRunId();
    const a = await store.save({ graphRunId: grun, nodeName: "a", state: 1 });
    const b = await store.save({
      graphRunId: grun,
      nodeName: "b",
      state: 2,
      parentCheckpointId: a.id,
    });
    const head = await store.load(grun);
    expect(head?.id).toBe(b.id);
    expect(head?.state).toBe(2);
  });

  test("load returns undefined for an unknown checkpoint", async () => {
    const grun = newGraphRunId();
    const ck = newCheckpointId();
    expect(await store.load(grun, ck)).toBeUndefined();
  });

  test("save updates _meta.json head pointer", async () => {
    const grun = newGraphRunId();
    const cp = await store.save({ graphRunId: grun, nodeName: "x", state: 1 });
    const meta = await store.meta(grun);
    expect(meta?.head).toBe(cp.id);
  });
});

describe("list", () => {
  test("returns checkpoints in insertion order", async () => {
    const grun = newGraphRunId();
    const a = await store.save({ graphRunId: grun, nodeName: "a", state: 1 });
    // small delay so mtime ordering is deterministic
    await new Promise((r) => setTimeout(r, 10));
    const b = await store.save({ graphRunId: grun, nodeName: "b", state: 2 });
    const list = await store.list(grun);
    expect(list.map((c) => c.id)).toEqual([a.id, b.id]);
  });

  test("limit caps the list", async () => {
    const grun = newGraphRunId();
    await store.save({ graphRunId: grun, nodeName: "a", state: 1 });
    await new Promise((r) => setTimeout(r, 10));
    await store.save({ graphRunId: grun, nodeName: "b", state: 2 });
    const list = await store.list(grun, { limit: 1 });
    expect(list.length).toBe(1);
  });

  test("empty list for an unknown graph run", async () => {
    const grun = newGraphRunId();
    expect(await store.list(grun)).toEqual([]);
  });
});

describe("branch", () => {
  test("creates a new run with a fresh head copy", async () => {
    const parentRun = newGraphRunId();
    const a = await store.save({ graphRunId: parentRun, nodeName: "plan", state: { plan: "foo" } });
    const b = await store.save({
      graphRunId: parentRun,
      nodeName: "execute",
      state: { result: "bar" },
      parentCheckpointId: a.id,
    });

    const { newGraphRunId: child, head } = await store.branch(parentRun, a.id);
    expect(child).not.toBe(parentRun);
    expect(child).toMatch(/^grun_[0-9a-f]{16}$/);
    expect(head.nodeName).toBe("plan");
    expect(head.state).toEqual({ plan: "foo" });
    expect(head.id).not.toBe(a.id);
    expect(head.graphRunId).toBe(child);

    const meta = await store.meta(child);
    expect(meta?.branchedFrom).toEqual({ graphRunId: parentRun, checkpointId: a.id });
    expect(meta?.head).toBe(head.id);

    // Parent's head is unchanged.
    const parentMeta = await store.meta(parentRun);
    expect(parentMeta?.head).toBe(b.id);
  });

  test("throws when branching from an unknown checkpoint", async () => {
    const grun = newGraphRunId();
    const ck = newCheckpointId();
    await expect(store.branch(grun, ck)).rejects.toBeInstanceOf(CheckpointStoreError);
  });
});

describe("path-traversal defense (T8)", () => {
  test("rejects malformed graphRunId on save", async () => {
    await expect(
      store.save({ graphRunId: "../etc/passwd", nodeName: "a", state: 1 }),
    ).rejects.toBeInstanceOf(RuntimeError);
  });
  test("rejects malformed graphRunId on load", async () => {
    await expect(store.load("not-a-grun")).rejects.toBeInstanceOf(RuntimeError);
  });
  test("rejects malformed graphRunId on list", async () => {
    await expect(store.list("../etc")).rejects.toBeInstanceOf(RuntimeError);
  });
  test("rejects malformed graphRunId on branch (parent)", async () => {
    await expect(store.branch("../etc", newCheckpointId())).rejects.toBeInstanceOf(RuntimeError);
  });
  test("rejects malformed checkpointId on branch", async () => {
    const grun = newGraphRunId();
    await store.save({ graphRunId: grun, nodeName: "a", state: 1 });
    await expect(store.branch(grun, "../../bad")).rejects.toBeInstanceOf(RuntimeError);
  });
  test("rejects malformed nodeName on save", async () => {
    const grun = newGraphRunId();
    await expect(store.save({ graphRunId: grun, nodeName: "", state: 1 })).rejects.toBeInstanceOf(
      CheckpointStoreError,
    );
  });
});

describe("drop", () => {
  test("removes the graph run directory", async () => {
    const grun = newGraphRunId();
    await store.save({ graphRunId: grun, nodeName: "a", state: 1 });
    await store.drop(grun);
    expect(await store.list(grun)).toEqual([]);
    expect(await store.meta(grun)).toBeUndefined();
  });

  test("idempotent on a missing run", async () => {
    const grun = newGraphRunId();
    await store.drop(grun);
    await store.drop(grun);
  });
});

describe("stress (T7-lite)", () => {
  // 500 sequential async fs writes is tight against bun:test's 5 s default
  // on shared CI runners — observed 5.3 s with 5 s budget. The 15 s budget
  // gives ~3× headroom without sacrificing the stress shape (still 500
  // round-trips against real disk).
  test("saving 500 checkpoints round-trips correctly", async () => {
    const grun = newGraphRunId();
    let parent: string | undefined;
    for (let i = 0; i < 500; i += 1) {
      const cp = await store.save({
        graphRunId: grun,
        nodeName: `n${i}`,
        state: { i },
        ...(parent !== undefined ? { parentCheckpointId: parent } : {}),
      });
      parent = cp.id;
    }
    const list = await store.list(grun);
    expect(list.length).toBe(500);
    expect(list[499]?.state).toEqual({ i: 499 });
  }, 15_000);
});

describe("cross-tenant fencing (CWE-1230)", () => {
  test("inside tenantA, a store rooted under tenantB fails closed", async () => {
    const tenantsRoot = mkdtempSync(join(tmpdir(), "checkpoint-tenants-"));
    try {
      const tenantA = buildTenant("tenant-a", { tenantsRoot });
      const tenantB = buildTenant("tenant-b", { tenantsRoot });
      // Store rooted under tenantB while tenantA is active — every resolved
      // graph-run directory escapes tenantA's sessionRoot, so it fails closed.
      const fenced = createCheckpointStore({ rootDir: tenantB.sessionRoot });
      await withTenant(tenantA, async () => {
        const grun = newGraphRunId();
        await expect(fenced.save({ graphRunId: grun, nodeName: "a", state: 1 })).rejects.toThrow(
          TenancyError,
        );
        await expect(fenced.load(grun)).rejects.toThrow(/cross-tenant access denied/);
      });
    } finally {
      rmSync(tenantsRoot, { recursive: true, force: true });
    }
  });

  test("inside tenantA, a store rooted under tenantA round-trips", async () => {
    const tenantsRoot = mkdtempSync(join(tmpdir(), "checkpoint-tenants-"));
    try {
      const tenantA = buildTenant("tenant-a", { tenantsRoot });
      const ok = createCheckpointStore({ rootDir: tenantA.sessionRoot });
      await withTenant(tenantA, async () => {
        const grun = newGraphRunId();
        const cp = await ok.save({ graphRunId: grun, nodeName: "a", state: { x: 1 } });
        const loaded = await ok.load(grun, cp.id);
        expect(loaded?.id).toBe(cp.id);
      });
    } finally {
      rmSync(tenantsRoot, { recursive: true, force: true });
    }
  });

  test("no active tenant — behaviour is unchanged (no fencing)", async () => {
    const grun = newGraphRunId();
    const cp = await store.save({ graphRunId: grun, nodeName: "a", state: { x: 1 } });
    const loaded = await store.load(grun, cp.id);
    expect(loaded?.id).toBe(cp.id);
  });
});

describe("list: since filter", () => {
  // A controllable clock keeps checkpoint timestamps deterministic so the
  // `since` boundary is exercised without depending on the real wall clock.
  test("skips checkpoints created strictly before `since`", async () => {
    const clock = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
    const clocked = createCheckpointStore({
      rootDir: tmp,
      now: () => new Date(clock.ms),
    });
    const grun = newGraphRunId();

    const older = await clocked.save({ graphRunId: grun, nodeName: "old", state: 1 });
    clock.ms += 60_000; // advance one minute
    const newer = await clocked.save({ graphRunId: grun, nodeName: "new", state: 2 });

    // `since` lands between the two checkpoints: the older one is filtered out
    // (the `continue` branch), the newer one is kept.
    const cutoff = new Date(clock.ms - 30_000).toISOString();
    const list = await clocked.list(grun, { since: cutoff });
    expect(list.map((c) => c.id)).toEqual([newer.id]);
    expect(list.map((c) => c.id)).not.toContain(older.id);
  });

  test("`since` in the future drops everything", async () => {
    const grun = newGraphRunId();
    await store.save({ graphRunId: grun, nodeName: "a", state: 1 });
    const list = await store.list(grun, { since: "2999-01-01T00:00:00.000Z" });
    expect(list).toEqual([]);
  });
});

describe("save: parentCheckpointId validation", () => {
  test("rejects a malformed parentCheckpointId before any write", async () => {
    const grun = newGraphRunId();
    await expect(
      store.save({ graphRunId: grun, nodeName: "a", state: 1, parentCheckpointId: "../../bad" }),
    ).rejects.toBeInstanceOf(RuntimeError);
    // Nothing was persisted for this run.
    expect(await store.meta(grun)).toBeUndefined();
  });
});

describe("pluggable adapter", () => {
  // A minimal in-memory adapter proves `createCheckpointStore({ adapter })`
  // wires a non-filesystem backend through every public method, and lets us
  // reach states the file-backed adapter never produces on its own.
  function makeMemoryAdapter(): {
    adapter: CheckpointStoreAdapter;
    checkpoints: Map<string, Checkpoint>;
    metas: Map<GraphRunId, GraphRunMeta>;
  } {
    const checkpoints = new Map<string, Checkpoint>();
    const metas = new Map<GraphRunId, GraphRunMeta>();
    const key = (g: GraphRunId, c: string): string => `${g}/${c}`;
    const adapter: CheckpointStoreAdapter = {
      async save(c: Checkpoint): Promise<void> {
        checkpoints.set(key(c.graphRunId, c.id), c);
      },
      async load(g: GraphRunId, c: string): Promise<Checkpoint | undefined> {
        return checkpoints.get(key(g, c));
      },
      async list(g: GraphRunId, _opts: ListOptions): Promise<ReadonlyArray<Checkpoint>> {
        return [...checkpoints.values()].filter((c) => c.graphRunId === g);
      },
      async loadMeta(g: GraphRunId): Promise<GraphRunMeta | undefined> {
        return metas.get(g);
      },
      async saveMeta(m: GraphRunMeta): Promise<void> {
        metas.set(m.graphRunId, m);
      },
      async drop(g: GraphRunId): Promise<void> {
        metas.delete(g);
        for (const k of [...checkpoints.keys()]) {
          if (k.startsWith(`${g}/`)) checkpoints.delete(k);
        }
      },
    };
    return { adapter, checkpoints, metas };
  }

  test("save → load → branch → drop all route through the custom adapter", async () => {
    const { adapter, checkpoints, metas } = makeMemoryAdapter();
    const custom = createCheckpointStore({ adapter });

    const grun = newGraphRunId();
    const cp = await custom.save({ graphRunId: grun, nodeName: "plan", state: { a: 1 } });
    expect(checkpoints.get(`${grun}/${cp.id}`)?.nodeName).toBe("plan");
    expect(metas.get(grun)?.head).toBe(cp.id);

    expect((await custom.load(grun, cp.id))?.id).toBe(cp.id);
    expect((await custom.load(grun))?.id).toBe(cp.id);

    const { newGraphRunId: child, head } = await custom.branch(grun, cp.id);
    expect(metas.get(child)?.branchedFrom).toEqual({ graphRunId: grun, checkpointId: cp.id });
    expect(head.state).toEqual({ a: 1 });

    await custom.drop(grun);
    expect(metas.has(grun)).toBe(false);
    expect(await custom.load(grun, cp.id)).toBeUndefined();
  });

  test("load without checkpointId returns undefined when meta has no head", async () => {
    const { adapter, metas } = makeMemoryAdapter();
    const custom = createCheckpointStore({ adapter });
    const grun = newGraphRunId();
    // Seed a meta with no head — a state a freshly-created run can hold before
    // its first commit. `load(grun)` must short-circuit to undefined.
    metas.set(grun, { version: 1, graphRunId: grun, createdAt: new Date(0).toISOString() });
    expect(await custom.load(grun)).toBeUndefined();
  });

  test("save preserves an existing meta's branchedFrom when advancing head", async () => {
    const { adapter, metas } = makeMemoryAdapter();
    const custom = createCheckpointStore({ adapter });
    const grun = newGraphRunId();
    const branchedFrom = { graphRunId: newGraphRunId(), checkpointId: newCheckpointId() };
    // Pre-seed a branched-run meta (head absent), then commit: ensureMeta must
    // reuse the existing meta so branchedFrom survives the head update.
    metas.set(grun, {
      version: 1,
      graphRunId: grun,
      createdAt: new Date(0).toISOString(),
      branchedFrom,
    });
    const cp = await custom.save({ graphRunId: grun, nodeName: "n", state: 1 });
    expect(metas.get(grun)?.head).toBe(cp.id);
    expect(metas.get(grun)?.branchedFrom).toEqual(branchedFrom);
  });
});

describe("CheckpointStoreError", () => {
  test("carries the config code and serializes its cause chain", () => {
    const root = new Error("disk gone");
    const err = new CheckpointStoreError("save failed", root);
    expect(err).toBeInstanceOf(CheckpointStoreError);
    expect(err.code).toBe("config");
    expect(err.name).toBe("CheckpointStoreError");
    const json = err.toJSON();
    expect(json.cause).toEqual({ name: "Error", message: "disk gone" });
  });
});
