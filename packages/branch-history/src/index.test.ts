import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckpointStore,
  createCheckpointStore,
  newGraphRunId,
} from "@crewhaus/checkpoint-store";
import { branchAt, diff } from "./index";

let tmp: string;
let store: CheckpointStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "branch-history-"));
  store = createCheckpointStore({ rootDir: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("branchAt", () => {
  test("returns the underlying store.branch result", async () => {
    const grun = newGraphRunId();
    const a = await store.save({ graphRunId: grun, nodeName: "a", state: { v: 1 } });
    const r = await branchAt(store, grun, a.id);
    expect(r.newGraphRunId).not.toBe(grun);
    expect(r.head.state).toEqual({ v: 1 });
  });
});

describe("diff", () => {
  test("two identical runs report only `same` rows", async () => {
    const a = newGraphRunId();
    const b = newGraphRunId();
    await store.save({ graphRunId: a, nodeName: "x", state: { i: 1 } });
    await new Promise((r) => setTimeout(r, 10));
    await store.save({ graphRunId: a, nodeName: "y", state: { i: 2 } });
    await store.save({ graphRunId: b, nodeName: "x", state: { i: 1 } });
    await new Promise((r) => setTimeout(r, 10));
    await store.save({ graphRunId: b, nodeName: "y", state: { i: 2 } });
    const d = await diff(store, a, b);
    expect(d.length).toBe(2);
    expect(d.every((row) => row.kind === "same")).toBe(true);
  });

  test("state mismatch flagged when same node has different state", async () => {
    const a = newGraphRunId();
    const b = newGraphRunId();
    await store.save({ graphRunId: a, nodeName: "x", state: { v: 1 } });
    await store.save({ graphRunId: b, nodeName: "x", state: { v: 2 } });
    const d = await diff(store, a, b);
    expect(d.length).toBe(1);
    expect(d[0]?.kind).toBe("state-mismatch");
  });

  test("node mismatch flagged when nodes differ at same position", async () => {
    const a = newGraphRunId();
    const b = newGraphRunId();
    await store.save({ graphRunId: a, nodeName: "x", state: 0 });
    await store.save({ graphRunId: b, nodeName: "y", state: 0 });
    const d = await diff(store, a, b);
    expect(d[0]?.kind).toBe("node-mismatch");
  });

  test("only-a / only-b reported when one run is shorter", async () => {
    const a = newGraphRunId();
    const b = newGraphRunId();
    await store.save({ graphRunId: a, nodeName: "x", state: 0 });
    await new Promise((r) => setTimeout(r, 10));
    await store.save({ graphRunId: a, nodeName: "y", state: 1 });
    await store.save({ graphRunId: b, nodeName: "x", state: 0 });
    const d = await diff(store, a, b);
    expect(d[0]?.kind).toBe("same");
    expect(d[1]?.kind).toBe("only-a");
  });

  test("only-b reported when run B is longer than run A", async () => {
    const a = newGraphRunId();
    const b = newGraphRunId();
    await store.save({ graphRunId: a, nodeName: "x", state: 0 });
    await store.save({ graphRunId: b, nodeName: "x", state: 0 });
    await new Promise((r) => setTimeout(r, 10));
    const extra = await store.save({ graphRunId: b, nodeName: "y", state: 1 });
    const d = await diff(store, a, b);
    expect(d.length).toBe(2);
    expect(d[0]?.kind).toBe("same");
    expect(d[1]?.kind).toBe("only-b");
    // The only-b row carries B's checkpoint metadata and no `a` side.
    expect(d[1]?.a).toBeUndefined();
    expect(d[1]?.b?.checkpointId).toBe(extra.id);
    expect(d[1]?.b?.nodeName).toBe("y");
    expect(typeof d[1]?.b?.stateHash).toBe("string");
  });
});

describe("stateHash (via diff)", () => {
  // Regression: a checkpoint whose `state` serializes to `undefined`
  // (e.g. `state: undefined`) once crashed `diff` with a TypeError from
  // `createHash().update(undefined)`. It must now hash to a stable sentinel.
  test("checkpoints with undefined state diff without throwing", async () => {
    const a = newGraphRunId();
    const b = newGraphRunId();
    await store.save({ graphRunId: a, nodeName: "x", state: undefined });
    await store.save({ graphRunId: b, nodeName: "x", state: undefined });
    const d = await diff(store, a, b);
    expect(d.length).toBe(1);
    // Two undefined states hash identically, so the row is `same`.
    expect(d[0]?.kind).toBe("same");
    expect(d[0]?.a?.stateHash).toBe(d[0]?.b?.stateHash);
  });

  test("undefined state differs from a defined state", async () => {
    const a = newGraphRunId();
    const b = newGraphRunId();
    await store.save({ graphRunId: a, nodeName: "x", state: undefined });
    await store.save({ graphRunId: b, nodeName: "x", state: { v: 1 } });
    const d = await diff(store, a, b);
    expect(d.length).toBe(1);
    expect(d[0]?.kind).toBe("state-mismatch");
    expect(d[0]?.a?.stateHash).not.toBe(d[0]?.b?.stateHash);
  });
});
