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
});
