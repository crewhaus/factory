import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckpointStore,
  createCheckpointStore,
  newGraphRunId,
} from "@crewhaus/checkpoint-store";
import { idempotencyKey, resumeFrom, withIdempotency } from "./index";

let tmp: string;
let store: CheckpointStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "durable-exec-"));
  store = createCheckpointStore({ rootDir: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("idempotencyKey", () => {
  test("deterministic for the same inputs", () => {
    const grun = newGraphRunId();
    expect(idempotencyKey(grun, "a", 0)).toBe(idempotencyKey(grun, "a", 0));
  });
  test("different attempts produce different keys", () => {
    const grun = newGraphRunId();
    expect(idempotencyKey(grun, "a", 0)).not.toBe(idempotencyKey(grun, "a", 1));
  });
  test("different nodes produce different keys", () => {
    const grun = newGraphRunId();
    expect(idempotencyKey(grun, "a", 0)).not.toBe(idempotencyKey(grun, "b", 0));
  });
});

describe("withIdempotency", () => {
  test("first call invokes inner; second call returns cached value", async () => {
    let invocations = 0;
    const wrapped = withIdempotency(async (_g, _n, _p: { v: number }) => {
      invocations += 1;
      return { v: 42 };
    });
    const grun = newGraphRunId();
    const a = await wrapped(grun, "node-a", { v: 0 });
    const b = await wrapped(grun, "node-a", { v: 999 });
    expect(invocations).toBe(1);
    expect(a).toEqual({ v: 42 });
    expect(b).toEqual({ v: 42 });
  });

  test("different attempt indexes re-invoke inner", async () => {
    let invocations = 0;
    const grun = newGraphRunId();
    const w0 = withIdempotency<{ x: number }>(async () => {
      invocations += 1;
      return { x: invocations };
    });
    const w1 = withIdempotency<{ x: number }>(
      async () => {
        invocations += 1;
        return { x: invocations };
      },
      { attempt: 1 },
    );
    await w0(grun, "n", { x: 0 });
    await w1(grun, "n", { x: 0 });
    expect(invocations).toBe(2);
  });
});

describe("resumeFrom", () => {
  test("returns the head's checkpointId + nodeName", async () => {
    const grun = newGraphRunId();
    await store.save({ graphRunId: grun, nodeName: "plan", state: 1 });
    const cp = await store.save({ graphRunId: grun, nodeName: "execute", state: 2 });
    const r = await resumeFrom(store, grun);
    expect(r?.checkpointId).toBe(cp.id);
    expect(r?.nextNode).toBe("execute");
  });

  test("returns undefined for an unknown run", async () => {
    const grun = newGraphRunId();
    expect(await resumeFrom(store, grun)).toBeUndefined();
  });
});
