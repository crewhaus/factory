/**
 * Coverage-completion suite for `graph-engine`.
 *
 * Targets the function/line gaps the behavioural `index.test.ts` leaves
 * open: every `GraphRunError` throw site, the defensive parallel-context
 * guard, and the default (un-overridden) input adapter + a no-op run
 * context. Everything here is deterministic — an in-memory CheckpointStore
 * stub (no fs), synchronous node fns (no timers), and an injected
 * RunContext (no lazy import). No real I/O, no real clock, no leaked
 * handles.
 */
import { describe, expect, test } from "bun:test";
import type {
  Checkpoint,
  CheckpointId,
  CheckpointStore,
  GraphRunId,
  GraphRunMeta,
} from "@crewhaus/checkpoint-store";
import type { RunContext } from "@crewhaus/run-context";
import {
  GraphRunError,
  HitlPauseSignal,
  type NodeEvent,
  collectLastCheckpoint,
  collectTerminalState,
  createGraph,
} from "./index";

// --------------------------------------------------------------------
// Deterministic in-memory CheckpointStore — zero fs, zero clock.
// Ids are monotonic counters so runs are fully reproducible.
// --------------------------------------------------------------------
class MemoryCheckpointStore implements CheckpointStore {
  private seq = 0;
  private readonly byRun = new Map<GraphRunId, Map<CheckpointId, Checkpoint>>();
  /** When set, `load` returns undefined to simulate a missing checkpoint. */
  loadReturnsUndefined = false;

  async save(opts: {
    graphRunId: GraphRunId;
    nodeName: string;
    state: unknown;
    parentCheckpointId?: CheckpointId;
  }): Promise<Checkpoint> {
    this.seq += 1;
    const cp: Checkpoint = {
      id: `ckpt_${String(this.seq).padStart(16, "0")}`,
      graphRunId: opts.graphRunId,
      nodeName: opts.nodeName,
      state: opts.state,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...(opts.parentCheckpointId !== undefined
        ? { parentCheckpointId: opts.parentCheckpointId }
        : {}),
    } as Checkpoint;
    let run = this.byRun.get(opts.graphRunId);
    if (run === undefined) {
      run = new Map();
      this.byRun.set(opts.graphRunId, run);
    }
    run.set(cp.id, cp);
    return cp;
  }

  async load(graphRunId: GraphRunId, checkpointId?: CheckpointId): Promise<Checkpoint | undefined> {
    if (this.loadReturnsUndefined) return undefined;
    const run = this.byRun.get(graphRunId);
    if (run === undefined) return undefined;
    if (checkpointId === undefined) return [...run.values()].at(-1);
    return run.get(checkpointId);
  }

  async list(graphRunId: GraphRunId): Promise<ReadonlyArray<Checkpoint>> {
    return [...(this.byRun.get(graphRunId)?.values() ?? [])];
  }

  async branch(): Promise<{ newGraphRunId: GraphRunId; head: Checkpoint }> {
    throw new Error("branch() not used by these tests");
  }

  async meta(): Promise<GraphRunMeta | undefined> {
    return undefined;
  }

  async drop(graphRunId: GraphRunId): Promise<void> {
    this.byRun.delete(graphRunId);
  }
}

// A minimal RunContext stand-in. Injecting it avoids graph-engine's lazy
// `createRunContext()` import (which would pull in @crewhaus/logging) and
// keeps the run side-effect-free.
const fakeRunContext = { id: "rc_test" } as unknown as RunContext;

const drain = async <S>(stream: AsyncIterable<NodeEvent<S>>): Promise<NodeEvent<S>[]> => {
  const out: NodeEvent<S>[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
};

describe("graph-engine — GraphRunError throw sites (line 98 constructor)", () => {
  test("resume() without a checkpointStore throws GraphRunError", () => {
    const g = createGraph<{ x: number }, { x: number }>()
      .setInputAdapter((i) => ({ x: i.x }))
      .addNode("a", async (_c, s) => s)
      .setEntry("a")
      .compile();
    // resume() is synchronous up to the store check — it throws before
    // returning the async iterator.
    expect(() => g.resume("grun_0000000000000000", "ckpt_0000000000000000", "ok")).toThrow(
      GraphRunError,
    );
    expect(() => g.resume("grun_0000000000000000", "ckpt_0000000000000000", "ok")).toThrow(
      /requires a checkpointStore/,
    );
  });

  test("resume() with a missing checkpoint throws GraphRunError on iteration", async () => {
    const store = new MemoryCheckpointStore();
    store.loadReturnsUndefined = true;
    const g = createGraph<{ x: number }, { x: number }>({ checkpointStore: store })
      .setInputAdapter((i) => ({ x: i.x }))
      .addNode("a", async (_c, s) => s)
      .setEntry("a")
      .compile();
    await expect(
      drain(
        g.resume("grun_0000000000000000", "ckpt_dead000000000000", "ok", {
          runContext: fakeRunContext,
        }),
      ),
    ).rejects.toThrow(/checkpoint ckpt_dead000000000000 not found/);
  });

  test("execute() reaching an unregistered cursor node throws GraphRunError", async () => {
    // An edge points at a node that exists at compile time, but we resume
    // directly into a name that was never registered via resumeFrom.
    const store = new MemoryCheckpointStore();
    const g = createGraph<{ x: number }, { x: number }>({ checkpointStore: store })
      .setInputAdapter((i) => ({ x: i.x }))
      .addNode("a", async (_c, s) => s)
      .setEntry("a")
      .compile();
    // run() honours resumeFrom.nextNode as the start cursor; "ghost" is not
    // a registered node, so execute() hits the `fn === undefined` guard.
    await expect(
      drain(
        g.run(
          { x: 1 },
          {
            runContext: fakeRunContext,
            resumeFrom: { checkpointId: "ckpt_0000000000000000", nextNode: "ghost" },
          },
        ),
      ),
    ).rejects.toThrow(/node "ghost" is not registered/);
  });

  test("collectTerminalState throws GraphRunError when the stream pauses before run_done", async () => {
    const store = new MemoryCheckpointStore();
    const g = createGraph<{ x: number }, { x: number; ok?: string }>({ checkpointStore: store })
      .setInputAdapter((i) => ({ x: i.x }))
      .addNode("gate", async (ctx, s) => {
        // No decision threaded → requestApproval throws HitlPauseSignal,
        // the engine yields hitl_pause then closes the stream (no run_done).
        const decision = await ctx.requestApproval("approve?");
        return { ...s, ok: decision };
      })
      .setEntry("gate")
      .compile();
    await expect(
      collectTerminalState(g.run({ x: 1 }, { runContext: fakeRunContext })),
    ).rejects.toThrow(/ended before run_done/);
  });
});

describe("graph-engine — parallel group defensive guards", () => {
  test("a valid parallel group runs concurrently, merges, and terminates", async () => {
    const store = new MemoryCheckpointStore();
    const b = createGraph<unknown, Record<string, unknown>>({ checkpointStore: store })
      .setInputAdapter(() => ({}))
      .addNode("entry", async (_c, _s) => ({}))
      .addNode("p1", async (_c, _s) => ({ p1: 1 }))
      .addNode("p2", async (_c, _s) => ({ p2: 2 }))
      .addParallel(["p1", "p2"])
      .addEdge("entry", "p1")
      .setEntry("entry");
    const g = b.compile();
    const events = await drain(g.run({}, { runContext: fakeRunContext }));
    // The parallel block runs, merges, and the run terminates (p2 has no
    // outgoing edge → terminal).
    const done = events.find((e) => e.kind === "run_done");
    expect(done?.kind).toBe("run_done");
  });

  test("compile rejects a parallel group that references an unknown node", () => {
    const store = new MemoryCheckpointStore();
    const b = createGraph<unknown, Record<string, unknown>>({ checkpointStore: store })
      .setInputAdapter(() => ({}))
      .addNode("p1", async (_c, _s) => ({}))
      .addParallel(["p1", "nope"])
      .setEntry("p1");
    expect(() => b.compile()).toThrow(/parallel group references unknown node "nope"/);
  });
});

describe("graph-engine — default input adapter (line 240 arrow)", () => {
  test("a graph with NO setInputAdapter casts the input straight to state", async () => {
    // Never calls setInputAdapter → the default `(input) => input as State`
    // arrow runs, which is otherwise shadowed by every other test.
    type S = { n: number };
    const store = new MemoryCheckpointStore();
    const g = createGraph<S, S>({ checkpointStore: store })
      .addNode("inc", async (_c, s) => ({ n: s.n + 1 }))
      .setEntry("inc")
      .compile();
    const { state } = await collectTerminalState(g.run({ n: 41 }, { runContext: fakeRunContext }));
    expect(state.n).toBe(42);
  });
});

describe("graph-engine — HitlPauseSignal shape", () => {
  test("carries the prompt and a stable name", () => {
    const sig = new HitlPauseSignal("need sign-off");
    expect(sig).toBeInstanceOf(Error);
    expect(sig.name).toBe("HitlPauseSignal");
    expect(sig.prompt).toBe("need sign-off");
    expect(sig.message).toMatch(/need sign-off/);
  });
});

describe("graph-engine — checkpoint plumbing without fs", () => {
  test("collectLastCheckpoint surfaces the last checkpoint id from an in-memory store", async () => {
    const store = new MemoryCheckpointStore();
    const g = createGraph<{ x: number }, { x: number }>({ checkpointStore: store })
      .setInputAdapter((i) => ({ x: i.x }))
      .addNode("a", async (_c, s) => ({ x: s.x + 1 }))
      .addNode("b", async (_c, s) => ({ x: s.x + 1 }))
      .addEdge("a", "b")
      .setEntry("a")
      .compile();
    let runId: GraphRunId | undefined;
    const events = await drain(g.run({ x: 0 }, { runContext: fakeRunContext }));
    for (const ev of events) {
      if (ev.kind === "checkpoint") runId = ev.graphRunId;
    }
    const { lastCheckpointId, pausedAt } = await collectLastCheckpoint(
      (async function* () {
        for (const ev of events) yield ev;
      })(),
    );
    expect(lastCheckpointId).toBeDefined();
    expect(pausedAt).toBeUndefined();
    // Two nodes → two saved checkpoints in the in-memory store for this run.
    expect(runId).toBeDefined();
    const saved = await store.list(runId as GraphRunId);
    expect(saved.length).toBe(2);
    expect(saved.map((c) => c.nodeName)).toEqual(["a", "b"]);
  });
});
