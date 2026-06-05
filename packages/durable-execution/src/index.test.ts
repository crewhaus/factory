import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckpointStore,
  createCheckpointStore,
  newGraphRunId,
} from "@crewhaus/checkpoint-store";
import {
  type IdempotencyRecord,
  type IdempotencyStore,
  InMemoryIdempotencyStore,
  idempotencyKey,
  resumeFrom,
  withIdempotency,
} from "./index";

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

  test("honours an injected store and persists a well-formed record", async () => {
    const grun = newGraphRunId();
    const store = new InMemoryIdempotencyStore();
    const wrapped = withIdempotency<{ v: number }>(async () => ({ v: 7 }), { store, attempt: 3 });
    const out = await wrapped(grun, "node-z", { v: 0 });
    expect(out).toEqual({ v: 7 });
    // The record must be findable in the *shared* store under the derived key.
    const rec = await store.get(idempotencyKey(grun, "node-z", 3));
    expect(rec).toBeDefined();
    expect(rec?.graphRunId).toBe(grun);
    expect(rec?.nodeName).toBe("node-z");
    expect(rec?.attempt).toBe(3);
    expect(rec?.result).toEqual({ v: 7 });
    // completedAt is a valid ISO-8601 timestamp.
    expect(Number.isNaN(Date.parse(rec?.completedAt ?? ""))).toBe(false);
  });

  test("a second wrapper sharing the store reads the cached result", async () => {
    const grun = newGraphRunId();
    const store = new InMemoryIdempotencyStore();
    let firstCalls = 0;
    let secondCalls = 0;
    const first = withIdempotency<{ v: number }>(
      async () => {
        firstCalls += 1;
        return { v: 1 };
      },
      { store },
    );
    const second = withIdempotency<{ v: number }>(
      async () => {
        secondCalls += 1;
        return { v: 2 };
      },
      { store },
    );
    const a = await first(grun, "shared", { v: 0 });
    const b = await second(grun, "shared", { v: 0 });
    expect(a).toEqual({ v: 1 });
    // Cache hit: the second wrapper never runs its inner fn.
    expect(b).toEqual({ v: 1 });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
  });

  test("works with a custom IdempotencyStore implementation", async () => {
    const grun = newGraphRunId();
    const backing = new Map<string, IdempotencyRecord>();
    const calls = { get: 0, put: 0 };
    const custom: IdempotencyStore = {
      async get(key) {
        calls.get += 1;
        return backing.get(key);
      },
      async put(record) {
        calls.put += 1;
        backing.set(record.key, record);
      },
    };
    let invocations = 0;
    const wrapped = withIdempotency<{ n: number }>(
      async () => {
        invocations += 1;
        return { n: invocations };
      },
      { store: custom },
    );
    const a = await wrapped(grun, "node-c", { n: 0 });
    const b = await wrapped(grun, "node-c", { n: 0 });
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
    expect(invocations).toBe(1);
    expect(calls.put).toBe(1);
    expect(calls.get).toBe(2);
  });
});

describe("InMemoryIdempotencyStore", () => {
  test("get returns undefined for an absent key", async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.get("does-not-exist")).toBeUndefined();
  });

  test("put then get round-trips the record", async () => {
    const store = new InMemoryIdempotencyStore();
    const grun = newGraphRunId();
    const record: IdempotencyRecord = {
      key: idempotencyKey(grun, "n", 0),
      graphRunId: grun,
      nodeName: "n",
      attempt: 0,
      result: { ok: true },
      completedAt: new Date(0).toISOString(),
    };
    await store.put(record);
    expect(await store.get(record.key)).toEqual(record);
  });

  test("put overwrites an existing record for the same key", async () => {
    const store = new InMemoryIdempotencyStore();
    const grun = newGraphRunId();
    const key = idempotencyKey(grun, "n", 0);
    const base = {
      key,
      graphRunId: grun,
      nodeName: "n",
      attempt: 0,
      completedAt: new Date(0).toISOString(),
    };
    await store.put({ ...base, result: { v: 1 } });
    await store.put({ ...base, result: { v: 2 } });
    expect((await store.get(key))?.result).toEqual({ v: 2 });
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

  test("returns undefined when meta exists but has no head", async () => {
    const grun = newGraphRunId();
    // A freshly-branched run can have meta with `head` absent (see
    // checkpoint-store GraphRunMeta docs). Model it directly via a stub so
    // the test is deterministic and does not depend on branch internals.
    const stub = {
      async meta() {
        return { version: 1 as const, graphRunId: grun, createdAt: new Date(0).toISOString() };
      },
      async load() {
        throw new Error("load must not be called when head is undefined");
      },
    } as unknown as CheckpointStore;
    expect(await resumeFrom(stub, grun)).toBeUndefined();
  });

  test("returns undefined when head checkpoint is missing", async () => {
    const grun = newGraphRunId();
    // meta names a head, but the underlying checkpoint cannot be loaded
    // (e.g. a corrupted/partially-deleted store). resumeFrom must fail
    // safe rather than dereference an undefined checkpoint.
    let loadCalls = 0;
    const stub = {
      async meta() {
        return {
          version: 1 as const,
          graphRunId: grun,
          head: "ckpt_00000000000000aa",
          createdAt: new Date(0).toISOString(),
        };
      },
      async load() {
        loadCalls += 1;
        return undefined;
      },
    } as unknown as CheckpointStore;
    expect(await resumeFrom(stub, grun)).toBeUndefined();
    expect(loadCalls).toBe(1);
  });
});
