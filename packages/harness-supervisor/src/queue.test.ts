import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CancellableChild,
  type JobRunContext,
  createFileJobStore,
  createHarnessMutex,
  createJobQueue,
  createMemoryJobStore,
  isReadOnlyJob,
  processOpsChild,
} from "./queue";
import { createFakeClock, createFakeProcessOps } from "./testkit";

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

// ---------------------------------------------------------------------------
// Reaching a RUNNING child
// ---------------------------------------------------------------------------

/**
 * A runner that spawns — i.e. one that hands the queue a child handle, the
 * way a real spawning runner must. `ignoreTerm` reproduces a child that
 * refuses SIGTERM, which is the whole reason the ladder has a second step.
 */
function childRunner(options: { readonly ignoreTerm?: boolean } = {}) {
  const signals: string[] = [];
  const started: string[] = [];
  return {
    signals,
    started,
    run: async (job: { jobId: string }, ctx: JobRunContext) => {
      started.push(job.jobId);
      let finish: (value: { exitCode?: number }) => void = () => {};
      const exited = new Promise<{ exitCode?: number }>((resolve) => {
        finish = resolve;
      });
      const child: CancellableChild = {
        pid: 31_337,
        terminate: () => {
          signals.push("SIGTERM");
          if (options.ignoreTerm !== true) finish({ exitCode: 143 });
        },
        forceKill: () => {
          signals.push("SIGKILL");
          finish({ exitCode: 137 });
        },
      };
      ctx.register(child);
      return exited;
    },
  };
}

describe("cancelling a RUNNING job", () => {
  test("the child is terminated and the row closes as cancelled", async () => {
    const clock = createFakeClock();
    const ctl = childRunner();
    const store = createMemoryJobStore();
    const queue = createJobQueue({ store, run: ctl.run, clock, stopGraceMs: 500 });
    const job = queue.submit({ harnessDir: "/a", kind: "eval", argv: ["eval"] });
    expect(queue.running().map((j) => j.jobId)).toEqual([job.jobId]);

    expect(queue.cancel(job.jobId)).toBe(true);
    await queue.idle();

    expect(ctl.signals).toEqual(["SIGTERM"]);
    const row = store.read().find((j) => j.jobId === job.jobId);
    expect(row?.state).toBe("cancelled");
    // A graceful stop is not a forced one.
    expect(row?.forced).toBeUndefined();
  });

  test("a child that ignores SIGTERM is SIGKILLed after the grace and recorded forced", async () => {
    const clock = createFakeClock();
    const ctl = childRunner({ ignoreTerm: true });
    const store = createMemoryJobStore();
    const queue = createJobQueue({ store, run: ctl.run, clock, stopGraceMs: 500 });
    const job = queue.submit({ harnessDir: "/a", kind: "eval", argv: ["eval"] });

    expect(queue.cancel(job.jobId)).toBe(true);
    expect(ctl.signals).toEqual(["SIGTERM"]);
    // Still alive on the far side of SIGTERM — that is the failure mode.
    expect(queue.running()).toHaveLength(1);

    clock.advance(500);
    await queue.idle();

    expect(ctl.signals).toEqual(["SIGTERM", "SIGKILL"]);
    const row = store.read().find((j) => j.jobId === job.jobId);
    expect(row?.state).toBe("cancelled");
    expect(row?.forced).toBe(true);
  });

  test("cancel is honest when the runner handed us no child to signal", async () => {
    const store = createMemoryJobStore();
    let finish: (() => void) | undefined;
    const queue = createJobQueue({
      store,
      run: () =>
        new Promise<{ exitCode?: number }>((resolve) => {
          finish = () => resolve({ exitCode: 0 });
        }),
    });
    const job = queue.submit({ harnessDir: "/a", kind: "eval", argv: [] });
    // `true` here would claim a cancellation that never reached a process —
    // which is how "cancel" came to mean "removed a row from a list".
    expect(queue.cancel(job.jobId)).toBe(false);
    finish?.();
    await queue.idle();
    expect(store.read()[0]?.state).toBe("done");
  });

  test("a second cancel does not re-signal or re-arm the escalation", async () => {
    const clock = createFakeClock();
    const ctl = childRunner({ ignoreTerm: true });
    const queue = createJobQueue({
      store: createMemoryJobStore(),
      run: ctl.run,
      clock,
      stopGraceMs: 500,
    });
    const job = queue.submit({ harnessDir: "/a", kind: "eval", argv: [] });
    queue.cancel(job.jobId);
    queue.cancel(job.jobId);
    expect(ctl.signals).toEqual(["SIGTERM"]);
    clock.advance(500);
    await queue.idle();
    expect(ctl.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("processOpsChild signals through the ops adapter, and tolerates no pid", () => {
    const ops = createFakeProcessOps();
    const spawned = ops.spawn({
      argv: ["bun", "job.ts"],
      cwd: "/a",
      env: {},
      stdio: { mode: "pipe" },
      detached: false,
    });
    const fake = ops.last();
    if (fake !== undefined) fake.ignoreTerm = true;
    const child = processOpsChild(ops, spawned.pid);
    child.terminate();
    child.forceKill();
    expect(fake?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // A runner that never got a pid must not blow up the ladder.
    expect(() => processOpsChild(ops, undefined).forceKill()).not.toThrow();
  });
});

describe("terminateRunning — manager shutdown", () => {
  test("signals the children, leaves the rows OPEN, and restore() reopens them as interrupted", async () => {
    const dir = tempDir();
    const store = createFileJobStore(join(dir, "jobs.jsonl"));
    const clock = createFakeClock();
    const ctl = childRunner();
    const queue = createJobQueue({ store, run: ctl.run, clock, concurrency: 1, stopGraceMs: 500 });
    const running = queue.submit({ harnessDir: "/a", kind: "eval", argv: ["eval"] });
    const waiting = queue.submit({ harnessDir: "/b", kind: "compile", argv: ["compile"] });
    expect(ctl.started).toEqual([running.jobId]);

    const abandoned = await queue.terminateRunning();

    expect(abandoned.map((j) => j.jobId)).toEqual([running.jobId]);
    expect(ctl.signals).toEqual(["SIGTERM"]);
    // The ledger row is STILL open — no done, no failed, no cancelled.
    expect(store.read().find((j) => j.jobId === running.jobId)?.state).toBe("running");
    // The latch: queued work is not spawned into a manager on its way out.
    expect(ctl.started).toEqual([running.jobId]);

    // The next manager boots over the same persisted ledger.
    const next = controllable();
    const revived = createJobQueue({ store, run: next.run, concurrency: 1 });
    const restored = revived.restore();
    expect(restored.interrupted.map((j) => j.jobId)).toEqual([running.jobId]);
    expect(restored.requeued.map((j) => j.jobId)).toEqual([waiting.jobId]);
    // The killed job is reopened as `interrupted`, never silently re-run.
    expect(next.started).toEqual([waiting.jobId]);
    expect(revived.recent().find((j) => j.jobId === running.jobId)?.state).toBe("interrupted");
    next.finish(waiting.jobId);
  });

  test("a job child that ignores SIGTERM is escalated rather than orphaned", async () => {
    const clock = createFakeClock();
    const ctl = childRunner({ ignoreTerm: true });
    const queue = createJobQueue({
      store: createMemoryJobStore(),
      run: ctl.run,
      clock,
      stopGraceMs: 400,
    });
    queue.submit({ harnessDir: "/a", kind: "eval", argv: [] });

    const done = queue.terminateRunning({ graceMs: 400, deadlineMs: 5_000 });
    expect(ctl.signals).toEqual(["SIGTERM"]);
    clock.advance(400);
    await done;

    expect(ctl.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(queue.running()).toEqual([]);
  });

  test("a runner that hands us nothing to signal is still bounded by the deadline", async () => {
    const clock = createFakeClock();
    const queue = createJobQueue({
      store: createMemoryJobStore(),
      run: () => new Promise<{ exitCode?: number }>(() => {}),
      clock,
    });
    queue.submit({ harnessDir: "/a", kind: "eval", argv: [] });
    const done = queue.terminateRunning({ deadlineMs: 2_000 });
    clock.advance(2_000);
    // The manager exits regardless — a wedged runner must never hold it.
    expect((await done).map((j) => j.harnessDir)).toEqual(["/a"]);
  });

  test("nothing running means nothing signalled and no waiting at all", async () => {
    const clock = createFakeClock();
    const queue = createJobQueue({
      store: createMemoryJobStore(),
      run: async () => ({ exitCode: 0 }),
      clock,
    });
    await queue.idle();
    expect(await queue.terminateRunning()).toEqual([]);
    // No deadline timer was ever armed.
    expect(clock.pendingCount()).toBe(0);
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

describe("recent() — terminal jobs stay visible", () => {
  test("finished jobs are folded from the ledger, newest first, after a restart", async () => {
    const store = createMemoryJobStore();
    const q1 = createJobQueue({ store, run: async () => ({ exitCode: 0 }) });
    const done = q1.submit({ harnessDir: "/h/a", kind: "doctor", argv: ["doctor"] });
    await q1.idle();

    // A job still RUNNING when the manager dies: nothing marks it finished,
    // so the ledger keeps it open. That is exactly the record `restore()`
    // reopens as `interrupted` — the state an operator most needs to see.
    const stuckQueue = createJobQueue({ store, run: () => new Promise<void>(() => {}) });
    const stuck = stuckQueue.submit({ harnessDir: "/h/b", kind: "eval", argv: ["eval"] });
    expect(stuckQueue.running().map((j) => j.jobId)).toContain(stuck.jobId);

    // The manager restarts over the same persisted ledger.
    const q2 = createJobQueue({ store, run: async () => ({ exitCode: 0 }) });
    q2.restore();

    const byId = new Map(q2.recent().map((j) => [j.jobId, j.state]));
    expect(byId.get(done.jobId)).toBe("done");
    expect(byId.get(stuck.jobId)).toBe("interrupted");
    // A fresh queue holds nothing in memory — this can only come from the
    // persisted ledger.
    expect(q2.running()).toHaveLength(0);
    expect(q2.recent(1)).toHaveLength(1);
  });
});
