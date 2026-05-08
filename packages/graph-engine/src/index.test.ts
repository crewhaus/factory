import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckpointStore, createCheckpointStore } from "@crewhaus/checkpoint-store";
import {
  GraphBuildError,
  GraphRunError,
  HitlPauseSignal,
  type NodeEvent,
  collectLastCheckpoint,
  collectTerminalState,
  createGraph,
} from "./index";

let tmp: string;
let store: CheckpointStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "graph-engine-"));
  store = createCheckpointStore({ rootDir: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

type State = { count: number; trace: ReadonlyArray<string> };

function trivialGraph(): ReturnType<
  typeof createGraph<{ count: number }, State>
>["compile"] extends () => infer R
  ? R
  : never {
  return createGraph<{ count: number }, State>({ checkpointStore: store })
    .setInputAdapter((input) => ({ count: input.count, trace: [] as ReadonlyArray<string> }))
    .addNode("a", async (_ctx, s) => ({ count: s.count + 1, trace: [...s.trace, "a"] }))
    .addNode("b", async (_ctx, s) => ({ count: s.count * 2, trace: [...s.trace, "b"] }))
    .addNode("c", async (_ctx, s) => ({ count: s.count - 3, trace: [...s.trace, "c"] }))
    .addEdge("a", "b")
    .addEdge("b", "c")
    .setEntry("a")
    .compile();
}

describe("builder", () => {
  test("rejects compile without setEntry", () => {
    const b = createGraph<number, number>().addNode("a", async (_c, s) => s);
    expect(() => b.compile()).toThrow(GraphBuildError);
  });

  test("rejects an unknown entry node", () => {
    const b = createGraph<number, number>()
      .addNode("a", async (_c, s) => s)
      .setEntry("zzz");
    expect(() => b.compile()).toThrow(/entry node/);
  });

  test("rejects duplicate node names", () => {
    const b = createGraph<number, number>().addNode("a", async (_c, s) => s);
    expect(() => b.addNode("a", async (_c, s) => s)).toThrow(GraphBuildError);
  });

  test("rejects edges referencing unknown nodes", () => {
    const b = createGraph<number, number>()
      .addNode("a", async (_c, s) => s)
      .addEdge("a", "missing")
      .setEntry("a");
    expect(() => b.compile()).toThrow(/unknown node/);
  });

  test("rejects parallel groups smaller than 2", () => {
    const b = createGraph<number, number>().addNode("a", async (_c, s) => s);
    expect(() => b.addParallel(["a"])).toThrow(GraphBuildError);
  });
});

describe("simple sequential run (T1/T3)", () => {
  test("executes nodes in declared order and emits start/end/checkpoint events", async () => {
    const g = trivialGraph();
    const events: NodeEvent<State>[] = [];
    for await (const ev of g.run({ count: 1 })) events.push(ev);
    const kinds = events.map((e) => e.kind);
    // The exact event sequence: a-start, a-end, checkpoint, b-start, b-end, checkpoint, c-start, c-end, checkpoint, run_done
    expect(kinds).toEqual([
      "node_start",
      "node_end",
      "checkpoint",
      "node_start",
      "node_end",
      "checkpoint",
      "node_start",
      "node_end",
      "checkpoint",
      "run_done",
    ]);
    // Final state: ((1 + 1) * 2) - 3 = 1, trace ["a", "b", "c"]
    const done = events.find((e) => e.kind === "run_done");
    if (done?.kind !== "run_done") throw new Error("missing run_done");
    expect(done.state.count).toBe(1);
    expect(done.state.trace).toEqual(["a", "b", "c"]);
  });

  test("collectTerminalState returns the same final state", async () => {
    const g = trivialGraph();
    const { state } = await collectTerminalState(g.run({ count: 5 }));
    expect(state.count).toBe((5 + 1) * 2 - 3);
  });
});

describe("conditional edges (T9)", () => {
  test("first matching edge wins; condition evaluation order matters", async () => {
    const g = createGraph<{ n: number }, { n: number; route: string }>({ checkpointStore: store })
      .setInputAdapter((i) => ({ n: i.n, route: "" }))
      .addNode("entry", async (_c, s) => s)
      .addNode("low", async (_c, s) => ({ ...s, route: "low" }))
      .addNode("high", async (_c, s) => ({ ...s, route: "high" }))
      .addEdge("entry", "low", (s) => s.n < 10)
      .addEdge("entry", "high", () => true)
      .setEntry("entry")
      .compile();
    const a = await collectTerminalState(g.run({ n: 5 }));
    expect(a.state.route).toBe("low");
    const b = await collectTerminalState(g.run({ n: 50 }));
    expect(b.state.route).toBe("high");
  });
});

describe("parallel groups (T3)", () => {
  test("addParallel runs nodes concurrently and merges their outputs", async () => {
    const order: string[] = [];
    const g = createGraph<unknown, { left?: number; right?: number }>({ checkpointStore: store })
      .setInputAdapter(() => ({}))
      .addNode("entry", async (_c, _s) => ({}))
      .addNode("left", async (_c, _s) => {
        order.push("left-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("left-end");
        return { left: 1 };
      })
      .addNode("right", async (_c, _s) => {
        order.push("right-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("right-end");
        return { right: 2 };
      })
      .addNode("merge", async (_c, s) => s)
      .addParallel(["left", "right"])
      .addEdge("entry", "left")
      .addEdge("right", "merge")
      .setEntry("entry")
      .compile();
    const { state } = await collectTerminalState(g.run({}));
    expect(state.left).toBe(1);
    expect(state.right).toBe(2);
    // Both started before either finished — proves parallelism.
    expect(order.indexOf("right-start")).toBeLessThan(order.indexOf("left-end"));
  });
});

describe("HITL pause + resume (T3)", () => {
  test("pauses on requestApproval and resumes with the decision", async () => {
    const g = createGraph<{ topic: string }, { topic: string; approved?: string; result?: string }>(
      { checkpointStore: store },
    )
      .setInputAdapter((i) => ({ topic: i.topic }))
      .addNode("plan", async (_c, s) => s)
      .addNode("execute", async (ctx, s) => {
        const decision = await ctx.requestApproval(`approve plan for ${s.topic}?`);
        return { ...s, approved: decision, result: `${s.topic}-done` };
      })
      .addNode("summarise", async (_c, s) => ({ ...s, result: `summary: ${s.result}` }))
      .addEdge("plan", "execute")
      .addEdge("execute", "summarise")
      .setEntry("plan")
      .compile();

    const { events, pausedAt } = await collectLastCheckpoint(g.run({ topic: "moon" }));
    expect(pausedAt).toBeDefined();
    if (pausedAt === undefined) throw new Error("missing pausedAt");
    expect(pausedAt.nodeName).toBe("execute");
    expect(pausedAt.prompt).toMatch(/approve plan for moon/);

    // The "summarise" node must NOT have run yet.
    const sawSummarise = events.some(
      (e) => (e.kind === "node_start" || e.kind === "node_end") && e.nodeName === "summarise",
    );
    expect(sawSummarise).toBe(false);

    // A `checkpoint` event for the paused node must NOT exist (only the
    // pause-checkpoint that hitl_pause carried). The engine writes a
    // checkpoint at hitl_pause time but does NOT emit a `checkpoint`
    // node-event for it (those are reserved for completed nodes).
    const completedCheckpoints = events.filter((e) => e.kind === "checkpoint");
    expect(completedCheckpoints.length).toBe(1); // only "plan"

    // Resume — fetch the graphRunId from the hitl_pause event.
    const pauseEv = events.find((e) => e.kind === "hitl_pause");
    if (pauseEv === undefined || pauseEv.kind !== "hitl_pause") {
      throw new Error("missing hitl_pause event");
    }
    const resumed = await collectTerminalState(
      g.resume(pauseEv.graphRunId, pausedAt.checkpointId, "approve"),
    );
    expect(resumed.state.approved).toBe("approve");
    expect(resumed.state.result).toBe("summary: moon-done");
  });
});

describe("checkpoints (T1)", () => {
  test("each completed node lands a row in checkpoint-store", async () => {
    const g = trivialGraph();
    let runId: string | undefined;
    for await (const ev of g.run({ count: 0 })) {
      if (ev.kind === "checkpoint") runId = ev.graphRunId;
    }
    if (runId === undefined) throw new Error("no checkpoint events");
    const list = await store.list(runId);
    expect(list.length).toBe(3);
    expect(list.map((c) => c.nodeName)).toEqual(["a", "b", "c"]);
  });
});
