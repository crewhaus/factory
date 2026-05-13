import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError } from "@crewhaus/errors";
import {
  type CheckpointStore,
  CheckpointStoreError,
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
