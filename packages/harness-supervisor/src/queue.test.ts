import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileJobStore,
  createHarnessMutex,
  createJobQueue,
  createMemoryJobStore,
  isReadOnlyJob,
} from "./queue";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-queue-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Let the queue's post-completion microtasks run. */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A runner whose completions the test controls. */
function controllable() {
  const started: string[] = [];
  const finishers = new Map<string, () => void>();
  return {
    started,
    finish: (jobId: string) => {
      const fn = finishers.get(jobId);
      finishers.delete(jobId);
      fn?.();
    },
    run: async (job: { jobId: string }) => {
      started.push(job.jobId);
      await new Promise<void>((resolve) => finishers.set(job.jobId, resolve));
      return {};
    },
  };
}

describe("read-only classification", () => {
  test("doctor / audit verify / security digest bypass the mutex", () => {
    expect(isReadOnlyJob("doctor")).toBe(true);
    expect(isReadOnlyJob("audit verify")).toBe(true);
    expect(isReadOnlyJob("security digest")).toBe(true);
    // eval WRITES (reports, baselines) — it is mutating despite being a
    // read-only FLEET subcommand.
    expect(isReadOnlyJob("eval")).toBe(false);
    expect(isReadOnlyJob("compile")).toBe(false);
  });
});

describe("createJobQueue", () => {
  test("one mutating job per harness; the next one waits", async () => {
    const ctl = controllable();
    const queue = createJobQueue({ store: createMemoryJobStore(), run: ctl.run });
    const first = queue.submit({ harnessDir: "/a", kind: "eval", argv: ["eval"] });
    const second = queue.submit({ harnessDir: "/a", kind: "compile", argv: ["compile"] });
    expect(ctl.started).toEqual([first.jobId]);
    expect(queue.pending().map((j) => j.jobId)).toEqual([second.jobId]);
    ctl.finish(first.jobId);
    await tick();
    expect(ctl.started).toEqual([first.jobId, second.jobId]);
    ctl.finish(second.jobId);
    await queue.idle();
  });

  test("a read-only job runs alongside a mutating one on the same harness", () => {
    const ctl = controllable();
    const queue = createJobQueue({ store: createMemoryJobStore(), run: ctl.run });
    const mutating = queue.submit({ harnessDir: "/a", kind: "eval", argv: ["eval"] });
    const readOnly = queue.submit({ harnessDir: "/a", kind: "doctor", argv: ["doctor"] });
    expect(ctl.started).toEqual([mutating.jobId, readOnly.jobId]);
    ctl.finish(mutating.jobId);
    ctl.finish(readOnly.jobId);
  });

  test("different harnesses run in parallel up to the concurrency limit", async () => {
    const ctl = controllable();
    const queue = createJobQueue({
      store: createMemoryJobStore(),
      run: ctl.run,
      concurrency: 3,
    });
    const ids = ["/a", "/b", "/c", "/d"].map(
      (dir) => queue.submit({ harnessDir: dir, kind: "eval", argv: ["eval"] }).jobId,
    );
    expect(ctl.started).toEqual(ids.slice(0, 3));
    expect(queue.pending().map((j) => j.jobId)).toEqual([ids[3] as string]);
    ctl.finish(ids[0] as string);
    await tick();
    expect(ctl.started).toHaveLength(4);
    for (const id of ids.slice(1)) ctl.finish(id);
  });

  test("a blocked harness does not stall the whole queue", () => {
    const ctl = controllable();
    const queue = createJobQueue({ store: createMemoryJobStore(), run: ctl.run, concurrency: 2 });
    const a1 = queue.submit({ harnessDir: "/a", kind: "eval", argv: [] });
    const a2 = queue.submit({ harnessDir: "/a", kind: "optimize", argv: [] });
    const b1 = queue.submit({ harnessDir: "/b", kind: "eval", argv: [] });
    // a2 is blocked by a1's harness lock, so b1 takes the free slot.
    expect(ctl.started).toEqual([a1.jobId, b1.jobId]);
    expect(queue.pending().map((j) => j.jobId)).toEqual([a2.jobId]);
    ctl.finish(a1.jobId);
    ctl.finish(b1.jobId);
  });

  test("queued work survives a manager restart; running work is closed as interrupted", () => {
    const dir = tempDir();
    const store = createFileJobStore(join(dir, "jobs.jsonl"));
    const first = controllable();
    const queue = createJobQueue({ store, run: first.run, concurrency: 1 });
    const running = queue.submit({ harnessDir: "/a", kind: "eval", argv: ["eval"] });
    const waiting = queue.submit({ harnessDir: "/b", kind: "compile", argv: ["compile"] });
    expect(first.started).toEqual([running.jobId]);

    // The manager dies here — no completions are ever written.
    const second = controllable();
    const revived = createJobQueue({ store, run: second.run, concurrency: 1 });
    const restored = revived.restore();
    expect(restored.requeued.map((j) => j.jobId)).toEqual([waiting.jobId]);
    expect(restored.interrupted.map((j) => j.jobId)).toEqual([running.jobId]);
    // The queued job actually runs on the new manager.
    expect(second.started).toEqual([waiting.jobId]);
    // …and the interrupted one is NOT silently re-run.
    expect(second.started).not.toContain(running.jobId);
    second.finish(waiting.jobId);
  });

  test("the persisted record folds open + close into one entry", async () => {
    const dir = tempDir();
    const store = createFileJobStore(join(dir, "jobs.jsonl"));
    const queue = createJobQueue({
      store,
      run: async () => ({ exitCode: 0 }),
      newJobId: () => "job_fixed",
    });
    queue.submit({ harnessDir: "/a", kind: "doctor", argv: ["doctor"] });
    await queue.idle();
    const records = store.read();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ jobId: "job_fixed", state: "done", exitCode: 0 });
    expect(records[0]?.startedAt).toBeDefined();
    expect(records[0]?.endedAt).toBeDefined();
  });

  test("a failing runner is recorded as failed, not thrown", async () => {
    const store = createMemoryJobStore();
    const queue = createJobQueue({
      store,
      run: async () => {
        throw new Error("boom");
      },
    });
    queue.submit({ harnessDir: "/a", kind: "eval", argv: [] });
    await queue.idle();
    expect(store.read()[0]).toMatchObject({ state: "failed", error: "boom" });
  });

  test("a pending job can be cancelled", () => {
    const ctl = controllable();
    const store = createMemoryJobStore();
    const queue = createJobQueue({ store, run: ctl.run, concurrency: 1 });
    const first = queue.submit({ harnessDir: "/a", kind: "eval", argv: [] });
    const second = queue.submit({ harnessDir: "/b", kind: "eval", argv: [] });
    expect(queue.cancel(second.jobId)).toBe(true);
    expect(queue.cancel("job_nope")).toBe(false);
    expect(queue.pending()).toEqual([]);
    expect(store.read().find((j) => j.jobId === second.jobId)?.state).toBe("cancelled");
    ctl.finish(first.jobId);
  });

  test("a torn line in the persisted ledger never hides the rest", () => {
    const dir = tempDir();
    const path = join(dir, "jobs.jsonl");
    const store = createFileJobStore(path);
    store.append({ jobId: "job_a", state: "pending" });
    Bun.write(path, `${'{"jobId":"job_a","state":"pending"}'}\n{"jobId":"job_b"`);
    expect(store.read().map((j) => j.jobId)).toEqual(["job_a"]);
  });
});

describe("createHarnessMutex", () => {
  test("holds per harness and releases idempotently", () => {
    const mutex = createHarnessMutex();
    const release = mutex.tryAcquire("/a");
    expect(release).toBeDefined();
    expect(mutex.tryAcquire("/a")).toBeUndefined();
    expect(mutex.tryAcquire("/b")).toBeDefined();
    expect(mutex.isHeld("/a")).toBe(true);
    release?.();
    release?.();
    expect(mutex.isHeld("/a")).toBe(false);
    expect(mutex.tryAcquire("/a")).toBeDefined();
  });
});
