/**
 * Catalog R11 `graph-engine` — stateful graph runtime.
 *
 * The engine is a builder + interpreter:
 *
 *   const graph = createGraph<State>()
 *     .addNode("plan",      async (ctx, s) => ({ ...s, plan: "..." }))
 *     .addNode("execute",   async (ctx, s) => {
 *       // HITL is a PRE-condition: ask FIRST, then do the work. The pause
 *       // checkpoints the pre-node state and `resume()` replays this node
 *       // from the top, so anything computed before the ask is discarded
 *       // and re-run (see NodeContext.requestApproval).
 *       const decision = await ctx.requestApproval("execute the plan?");
 *       if (decision === "reject") return s;
 *       return { ...s, result: "..." };
 *     })
 *     .addNode("summarise", async (ctx, s) => ({ ...s, summary: "..." }))
 *     .addEdge("plan", "execute")
 *     .addEdge("execute", "summarise")
 *     .setEntry("plan")
 *     .compile();
 *
 *   for await (const ev of graph.run({ topic: "..." })) {
 *     // node_start | node_end | edge_taken | branch | checkpoint | hitl_pause
 *   }
 *
 *   // resume from a HITL pause:
 *   for await (const ev of graph.resume(checkpointId, "approve")) { ... }
 *
 * Each node receives a `NodeContext` carrying the parent `RunContext`,
 * a `requestApproval` helper, and the previous-node state. The engine
 * persists a checkpoint after every successful node so a crash mid-run
 * can be recovered by `branch-history` / `durable-execution`.
 *
 * Layer R11. Pairs with `checkpoint-store` (R7) and the `target-graph`
 * codegen.
 */

import {
  type Checkpoint,
  type CheckpointId,
  type CheckpointStore,
  type GraphRunId,
  newGraphRunId,
} from "@crewhaus/checkpoint-store";
import { CrewhausError, EXIT_CODES, type FailureReport, RunFailedError } from "@crewhaus/errors";
import type { RunContext } from "@crewhaus/run-context";
import type { RunFailedEvent, TraceEventBus } from "@crewhaus/trace-event-bus";

export type NodeName = string;

/**
 * Per-node execution context. Independent of the broader RunContext so
 * graph-engine stays single-purpose (nodes that need to publish trace
 * events still reach for `runContext.eventBus` directly).
 */
export interface NodeContext {
  readonly runContext: RunContext;
  readonly graphRunId: GraphRunId;
  readonly nodeName: NodeName;
  /**
   * When the engine is replaying after a `resume(checkpointId, decision)`,
   * `approval` is the decision string returned to the node that paused.
   * On a fresh run it's undefined.
   */
  readonly approval?: string;
  /**
   * Pause graph execution and persist a checkpoint. The engine yields a
   * `hitl_pause` event then closes the iterable; the operator calls
   * `graph.resume(checkpointId, decision)` to resume.
   *
   * Returns a value only on resume — on the first run this throws a
   * `HitlPauseSignal` that the engine catches.
   *
   * CONTRACT — approval is a PRE-condition. Call this BEFORE the node does
   * any work: the checkpoint the engine saves on the pause holds the
   * PRE-node state, and `resume()` replays the paused node from the top.
   * Anything the node computed before pausing (a model turn, a tool call)
   * is therefore discarded AND re-executed on resume — paid for twice, and
   * never seen by the approver, since the `hitl_pause` event carries the
   * pre-node state. Nodes that want a human to review their own output
   * should hang the gate on the DOWNSTREAM node, whose pre-node state is
   * exactly that output.
   */
  requestApproval(prompt: string): Promise<string>;
}

export type NodeFn<S> = (ctx: NodeContext, prev: S) => Promise<S>;

export type EdgeCondition<S> = (state: S, ctx: NodeContext) => boolean | Promise<boolean>;

type EdgeSpec<S> = {
  readonly from: NodeName;
  readonly to: NodeName;
  readonly condition?: EdgeCondition<S>;
};

/**
 * Loop contract 0.4 (Batch A, G69) — reducer owning one parallel group's
 * merge. Receives the pre-group state and every member's result, tagged
 * with the producing node's name, in group declaration order. When a group
 * configures a reducer, the engine skips its default last-writer-wins
 * `Object.assign` merge AND the key-collision check — the reducer owns the
 * merge semantics entirely (sync or async, matching `EdgeCondition`).
 */
export type ParallelMergeReducer<S> = (
  prev: S,
  results: ReadonlyArray<{ readonly node: NodeName; readonly state: S }>,
) => S | Promise<S>;

export type AddParallelOptions<S> = {
  readonly reducer?: ParallelMergeReducer<S>;
};

type ParallelGroupSpec<S> = {
  readonly names: ReadonlyArray<NodeName>;
  readonly reducer?: ParallelMergeReducer<S>;
};

export class HitlPauseSignal extends Error {
  override readonly name = "HitlPauseSignal";
  constructor(public readonly prompt: string) {
    super(`hitl pause: ${prompt}`);
  }
}

export class GraphBuildError extends CrewhausError {
  override readonly name = "GraphBuildError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export class GraphRunError extends CrewhausError {
  override readonly name = "GraphRunError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type NodeStartEvent = {
  readonly kind: "node_start";
  readonly graphRunId: GraphRunId;
  readonly nodeName: NodeName;
  readonly turn: number;
};

export type NodeEndEvent<S> = {
  readonly kind: "node_end";
  readonly graphRunId: GraphRunId;
  readonly nodeName: NodeName;
  readonly turn: number;
  readonly state: S;
  readonly durationMs: number;
};

export type EdgeTakenEvent = {
  readonly kind: "edge_taken";
  readonly graphRunId: GraphRunId;
  readonly from: NodeName;
  readonly to: NodeName;
};

export type CheckpointEvent = {
  readonly kind: "checkpoint";
  readonly graphRunId: GraphRunId;
  readonly nodeName: NodeName;
  readonly checkpointId: CheckpointId;
};

export type BranchEvent = {
  readonly kind: "branch";
  readonly fromGraphRunId: GraphRunId;
  readonly fromCheckpointId: CheckpointId;
  readonly newGraphRunId: GraphRunId;
};

// `S` defaults to `unknown` so the pre-0.4.x bare `HitlPauseEvent` spelling
// still compiles for external consumers now that the event carries state.
export type HitlPauseEvent<S = unknown> = {
  readonly kind: "hitl_pause";
  readonly graphRunId: GraphRunId;
  readonly nodeName: NodeName;
  readonly prompt: string;
  readonly checkpointId: CheckpointId;
  /**
   * The state the paused node is about to run on — the same state the
   * pause checkpoint persists. Carried on the event so an approver can see
   * WHAT they are approving (the upstream output that reached this node)
   * without loading the checkpoint out of band.
   */
  readonly state: S;
};

export type GraphRunDoneEvent<S> = {
  readonly kind: "run_done";
  readonly graphRunId: GraphRunId;
  readonly state: S;
};

export type NodeEvent<S> =
  | NodeStartEvent
  | NodeEndEvent<S>
  | EdgeTakenEvent
  | CheckpointEvent
  | BranchEvent
  | HitlPauseEvent<S>
  | GraphRunDoneEvent<S>;

export type RunOptions = {
  /**
   * When set, reuse this graph run id (e.g. for `branch-history`
   * resuming a branched run); otherwise a fresh `grun_<16hex>` is
   * minted.
   */
  readonly graphRunId?: GraphRunId;
  /**
   * When set, the engine starts by loading the named checkpoint and
   * begins execution from `nextNode` (typically used by `resume()`).
   */
  readonly resumeFrom?: { readonly checkpointId: CheckpointId; readonly nextNode: NodeName };
  /**
   * Decisions to feed back into HITL `requestApproval()` calls during
   * replay. Keyed by node name.
   */
  readonly approvals?: Readonly<Record<NodeName, string>>;
  /**
   * Caller-supplied `RunContext`. Defaults to a fresh `createRunContext()`
   * when omitted (graph-engine imports the helper lazily to avoid pulling
   * `@crewhaus/logging` into bundles that supply their own context).
   */
  readonly runContext?: RunContext;
};

export interface RunnableGraph<Input, State> {
  readonly nodes: ReadonlyArray<NodeName>;
  readonly entry: NodeName;
  /** Drive the graph from `input`. Yields events node-by-node. */
  run(input: Input, opts?: RunOptions): AsyncIterable<NodeEvent<State>>;
  /**
   * Resume a previously-paused run. Loads the checkpoint, threads the
   * decision through `NodeContext.approval`, and resumes execution from
   * the node following the paused one.
   */
  resume(
    graphRunId: GraphRunId,
    checkpointId: CheckpointId,
    decision: string,
    opts?: Omit<RunOptions, "resumeFrom">,
  ): AsyncIterable<NodeEvent<State>>;
}

export interface GraphBuilder<Input, State> {
  addNode(name: NodeName, fn: NodeFn<State>): GraphBuilder<Input, State>;
  addEdge(
    from: NodeName,
    to: NodeName,
    condition?: EdgeCondition<State>,
  ): GraphBuilder<Input, State>;
  /**
   * Add a parallel barrier: every node in `names` executes concurrently,
   * the engine waits for all to complete, and the next edge is taken
   * from the LAST of `names` (the synthetic merge sink).
   *
   * Merge semantics (G69): without `opts.reducer` the engine merges the
   * branch results via last-writer-wins `Object.assign` — but FIRST checks
   * that no two branches modified the same state key (relative to the
   * pre-group state); a collision fails the run with a classified
   * `RunFailedError` (`FailureReport` class `"config"`) after publishing a
   * `run_failed` trace event. Configure `opts.reducer` to own the merge
   * (and skip the collision check) when branches intentionally write
   * overlapping keys.
   */
  addParallel(
    names: ReadonlyArray<NodeName>,
    opts?: AddParallelOptions<State>,
  ): GraphBuilder<Input, State>;
  setEntry(name: NodeName): GraphBuilder<Input, State>;
  /**
   * Convert the input shape into the initial state. Default: cast
   * `input as unknown as State`. Override when the input and state
   * types differ.
   */
  setInputAdapter(fn: (input: Input) => State): GraphBuilder<Input, State>;
  compile(): RunnableGraph<Input, State>;
}

export type CreateGraphOptions = {
  readonly checkpointStore?: CheckpointStore;
};

export function createGraph<Input = unknown, State = Input>(
  opts: CreateGraphOptions = {},
): GraphBuilder<Input, State> {
  const nodes = new Map<NodeName, NodeFn<State>>();
  const edges: EdgeSpec<State>[] = [];
  const parallelGroups: ParallelGroupSpec<State>[] = [];
  let entry: NodeName | undefined;
  let inputAdapter: (input: Input) => State = (input) => input as unknown as State;

  const builder: GraphBuilder<Input, State> = {
    addNode(name, fn) {
      if (nodes.has(name)) {
        throw new GraphBuildError(`duplicate node "${name}"`);
      }
      if (name.length === 0) throw new GraphBuildError("node name must be non-empty");
      nodes.set(name, fn);
      return builder;
    },
    addEdge(from, to, condition) {
      edges.push({ from, to, ...(condition !== undefined ? { condition } : {}) });
      return builder;
    },
    addParallel(names, opts) {
      if (names.length < 2) {
        throw new GraphBuildError("addParallel requires at least 2 nodes");
      }
      parallelGroups.push({
        names,
        ...(opts?.reducer !== undefined ? { reducer: opts.reducer } : {}),
      });
      return builder;
    },
    setEntry(name) {
      entry = name;
      return builder;
    },
    setInputAdapter(fn) {
      inputAdapter = fn;
      return builder;
    },
    compile(): RunnableGraph<Input, State> {
      if (entry === undefined) {
        throw new GraphBuildError("setEntry must be called before compile");
      }
      if (!nodes.has(entry)) {
        throw new GraphBuildError(`entry node "${entry}" is not registered`);
      }
      // Validate every edge endpoint references a known node.
      for (const e of edges) {
        if (!nodes.has(e.from)) {
          throw new GraphBuildError(`edge references unknown node "${e.from}" (from)`);
        }
        if (!nodes.has(e.to)) {
          throw new GraphBuildError(`edge references unknown node "${e.to}" (to)`);
        }
      }
      for (const group of parallelGroups) {
        for (const n of group.names) {
          if (!nodes.has(n)) {
            throw new GraphBuildError(`parallel group references unknown node "${n}"`);
          }
        }
      }
      return new CompiledGraph<Input, State>({
        nodes,
        edges,
        parallelGroups,
        entry,
        inputAdapter,
        checkpointStore: opts.checkpointStore,
      });
    },
  };

  return builder;
}

type CompiledOptions<Input, State> = {
  readonly nodes: Map<NodeName, NodeFn<State>>;
  readonly edges: ReadonlyArray<EdgeSpec<State>>;
  readonly parallelGroups: ReadonlyArray<ParallelGroupSpec<State>>;
  readonly entry: NodeName;
  readonly inputAdapter: (input: Input) => State;
  readonly checkpointStore?: CheckpointStore;
};

class CompiledGraph<Input, State> implements RunnableGraph<Input, State> {
  readonly nodes: ReadonlyArray<NodeName>;
  readonly entry: NodeName;
  private readonly o: CompiledOptions<Input, State>;

  constructor(opts: CompiledOptions<Input, State>) {
    this.o = opts;
    this.nodes = [...opts.nodes.keys()];
    this.entry = opts.entry;
  }

  run(input: Input, opts: RunOptions = {}): AsyncIterable<NodeEvent<State>> {
    const initial = this.o.inputAdapter(input);
    return this.execute({
      graphRunId: opts.graphRunId ?? newGraphRunId(),
      state: initial,
      startNode: opts.resumeFrom?.nextNode ?? this.o.entry,
      approvals: opts.approvals ?? {},
      runContext: opts.runContext,
      resumedFromCheckpointId: opts.resumeFrom?.checkpointId,
    });
  }

  resume(
    graphRunId: GraphRunId,
    checkpointId: CheckpointId,
    decision: string,
    opts: Omit<RunOptions, "resumeFrom"> = {},
  ): AsyncIterable<NodeEvent<State>> {
    const store = this.o.checkpointStore;
    if (store === undefined) {
      throw new GraphRunError("resume() requires a checkpointStore at compile time");
    }
    const self = this;
    return (async function* (): AsyncIterable<NodeEvent<State>> {
      const checkpoint = await store.load(graphRunId, checkpointId);
      if (checkpoint === undefined) {
        throw new GraphRunError(`checkpoint ${checkpointId} not found in run ${graphRunId}`);
      }
      // The state stored is the state AT THE PAUSE — the paused node never
      // committed its own output. Replay starts at that node with the
      // decision threaded in via the `approvals` map.
      const approvals = { ...(opts.approvals ?? {}), [checkpoint.nodeName]: decision };
      yield* self.execute({
        graphRunId,
        state: checkpoint.state as State,
        startNode: checkpoint.nodeName,
        approvals,
        runContext: opts.runContext,
        resumedFromCheckpointId: checkpointId,
      });
    })();
  }

  private async *execute(args: {
    graphRunId: GraphRunId;
    state: State;
    startNode: NodeName;
    approvals: Readonly<Record<NodeName, string>>;
    runContext?: RunContext;
    resumedFromCheckpointId?: CheckpointId;
  }): AsyncIterable<NodeEvent<State>> {
    const { graphRunId, approvals } = args;
    let state = args.state;
    let cursor: NodeName | undefined = args.startNode;
    let parentCheckpointId = args.resumedFromCheckpointId;
    let turn = 0;
    const runContext = args.runContext ?? (await this.lazyRunContext());

    while (cursor !== undefined) {
      const nodeName = cursor;
      const fn = this.o.nodes.get(nodeName);
      if (fn === undefined) {
        throw new GraphRunError(`node "${nodeName}" is not registered`);
      }
      // Detect parallel groups: if `nodeName` is the first member of a group,
      // run the whole group in parallel; the cursor advances to the LAST
      // member's outgoing edge.
      const parallelGroup = this.o.parallelGroups.find((g) => g.names[0] === nodeName);
      if (parallelGroup !== undefined) {
        const groupNames = parallelGroup.names;
        turn += 1;
        yield {
          kind: "node_start",
          graphRunId,
          nodeName: `[parallel: ${groupNames.join(",")}]`,
          turn,
        };
        const t0 = performance.now();
        const groupCtxs = groupNames.map((n) =>
          this.makeNodeContext({
            runContext,
            graphRunId,
            nodeName: n,
            approval: approvals[n],
          }),
        );
        const groupFns = groupNames.map((n) => {
          const f = this.o.nodes.get(n);
          if (f === undefined) {
            throw new GraphRunError(`parallel group references missing node "${n}"`);
          }
          return f;
        });
        const results = await Promise.all(
          groupFns.map((f, i) => {
            const ctx = groupCtxs[i];
            if (ctx === undefined) {
              throw new GraphRunError("internal: missing parallel context");
            }
            return f(ctx, state);
          }),
        );
        if (parallelGroup.reducer !== undefined) {
          // A configured reducer owns the merge (G69): it sees every
          // branch's result in declaration order and decides the semantics
          // — overlapping keys are its business, so no collision check.
          state = await parallelGroup.reducer(
            state,
            results.map((r, i) => ({ node: groupNames[i] as string, state: r })),
          );
        } else {
          // Default merge: last writer wins — but a key MODIFIED by two or
          // more branches would silently drop sibling writes, so G69 fails
          // the run first (classified error + `run_failed` trace event).
          this.failOnParallelMergeCollision(groupNames, state, results, runContext);
          // Mutate `acc` in place to avoid quadratic spread cost on large groups.
          const acc: Record<string, unknown> = { ...(state as unknown as object) };
          for (const r of results) {
            Object.assign(acc, r as object);
          }
          state = acc as unknown as State;
        }
        yield {
          kind: "node_end",
          graphRunId,
          nodeName: `[parallel: ${groupNames.join(",")}]`,
          turn,
          state,
          durationMs: performance.now() - t0,
        };
        // Advance cursor from the LAST node in the group.
        cursor = await this.resolveNext(groupNames[groupNames.length - 1] as string, state, {
          runContext,
          graphRunId,
          nodeName: groupNames[groupNames.length - 1] as string,
        });
        continue;
      }

      turn += 1;
      yield { kind: "node_start", graphRunId, nodeName, turn };
      const ctx = this.makeNodeContext({
        runContext,
        graphRunId,
        nodeName,
        approval: approvals[nodeName],
      });
      const t0 = performance.now();
      let next: State;
      try {
        next = await fn(ctx, state);
      } catch (err) {
        if (err instanceof HitlPauseSignal) {
          if (this.o.checkpointStore !== undefined) {
            const cp = await this.o.checkpointStore.save({
              graphRunId,
              nodeName,
              state,
              ...(parentCheckpointId !== undefined ? { parentCheckpointId } : {}),
            });
            yield {
              kind: "hitl_pause",
              graphRunId,
              nodeName,
              prompt: err.prompt,
              checkpointId: cp.id,
              // The pre-node state — what the approver is deciding on, and
              // byte-identical to the state the checkpoint just persisted.
              state,
            };
          } else {
            // No checkpoint store wired; surface a synthetic id so the
            // event shape is uniform and let the operator persist out-of-band.
            yield {
              kind: "hitl_pause",
              graphRunId,
              nodeName,
              prompt: err.prompt,
              checkpointId: "ckpt_unpersisted_0000",
              state,
            };
          }
          return;
        }
        throw err;
      }
      state = next;
      yield {
        kind: "node_end",
        graphRunId,
        nodeName,
        turn,
        state,
        durationMs: performance.now() - t0,
      };
      if (this.o.checkpointStore !== undefined) {
        const cp = await this.o.checkpointStore.save({
          graphRunId,
          nodeName,
          state,
          ...(parentCheckpointId !== undefined ? { parentCheckpointId } : {}),
        });
        parentCheckpointId = cp.id;
        yield { kind: "checkpoint", graphRunId, nodeName, checkpointId: cp.id };
      }
      cursor = await this.resolveNext(nodeName, state, { runContext, graphRunId, nodeName });
    }
    yield { kind: "run_done", graphRunId, state };
  }

  /**
   * Pick the first matching outgoing edge. Edges with no condition match
   * unconditionally; edges with a condition are evaluated in declaration
   * order. Returns undefined when there's no outgoing edge (terminal).
   */
  private async resolveNext(
    from: NodeName,
    state: State,
    ctxParts: { runContext: RunContext; graphRunId: GraphRunId; nodeName: NodeName },
  ): Promise<NodeName | undefined> {
    for (const edge of this.o.edges) {
      if (edge.from !== from) continue;
      if (edge.condition === undefined) return edge.to;
      const ctx = this.makeNodeContext({
        runContext: ctxParts.runContext,
        graphRunId: ctxParts.graphRunId,
        nodeName: ctxParts.nodeName,
      });
      if (await edge.condition(state, ctx)) return edge.to;
    }
    return undefined;
  }

  /**
   * G69 — default-merge safety net. A state key "collides" when two or more
   * group members MODIFIED it relative to the pre-group state: the key is
   * absent from `prev`, or the member's value differs (`Object.is`, so NaN
   * compares sanely). Branches that merely echo untouched upstream keys —
   * the codegen's `{ ...prev, [name]: reply }` pattern — never collide, and
   * two branches writing the SAME new value still do (the last-writer merge
   * would be lossy either way, e.g. both branches incrementing a counter).
   *
   * On collision the run fails with a CLASSIFIED error — a `RunFailedError`
   * whose `FailureReport` is class `"config"` / exit `EXIT_CODES.config` —
   * and a `run_failed` trace event is published immediately before the
   * throw, mirroring runtime-core's terminal-failure convention. No-op when
   * every modified key has exactly one writer.
   */
  private failOnParallelMergeCollision(
    groupNames: ReadonlyArray<NodeName>,
    prev: State,
    results: ReadonlyArray<State>,
    runContext: RunContext,
  ): void {
    const prevRec =
      typeof prev === "object" && prev !== null ? (prev as Record<string, unknown>) : undefined;
    const writersByKey = new Map<string, NodeName[]>();
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      // Non-object results contribute no keys to Object.assign, so they
      // cannot collide (mirrors the default merge's semantics exactly).
      if (typeof result !== "object" || result === null) continue;
      const node = groupNames[i] ?? `#${i}`;
      for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
        const modified =
          prevRec === undefined || !(key in prevRec) || !Object.is(prevRec[key], value);
        if (!modified) continue;
        const writers = writersByKey.get(key);
        if (writers === undefined) {
          writersByKey.set(key, [node]);
        } else {
          writers.push(node);
        }
      }
    }
    const collisions = [...writersByKey.entries()].filter(([, writers]) => writers.length >= 2);
    if (collisions.length === 0) return;
    const detail = collisions
      .map(([key, writers]) => `state key "${key}" written by ${writers.join(", ")}`)
      .join("; ");
    const report: FailureReport = {
      class: "config",
      title: "parallel merge key collision",
      detail: `parallel group [${groupNames.join(", ")}] produced conflicting writes — ${detail}`,
      remediation:
        "make each branch write distinct state keys, or configure a per-group reducer: addParallel(names, { reducer })",
      exitCode: EXIT_CODES.config,
    };
    // Defensive `undefined` check: `RunContext.eventBus` is typed required,
    // but a partial injected context (tests, embedders) must surface the
    // classified error below, not a TypeError from the trace publish.
    const bus: TraceEventBus | undefined = runContext.eventBus;
    if (bus !== undefined) {
      bus.publish({
        ...bus.envelope(),
        kind: "run_failed",
        class: report.class,
        message: `${report.title}: ${report.detail}`,
        ...(report.remediation !== undefined ? { remediation: report.remediation } : {}),
        exitCode: report.exitCode,
      } satisfies RunFailedEvent);
    }
    throw new RunFailedError(report);
  }

  private makeNodeContext(parts: {
    runContext: RunContext;
    graphRunId: GraphRunId;
    nodeName: NodeName;
    approval?: string;
  }): NodeContext {
    return {
      runContext: parts.runContext,
      graphRunId: parts.graphRunId,
      nodeName: parts.nodeName,
      ...(parts.approval !== undefined ? { approval: parts.approval } : {}),
      requestApproval: async (prompt: string): Promise<string> => {
        if (parts.approval !== undefined) return parts.approval;
        throw new HitlPauseSignal(prompt);
      },
    };
  }

  private async lazyRunContext(): Promise<RunContext> {
    const { createRunContext } = await import("@crewhaus/run-context");
    return createRunContext();
  }
}

/**
 * Helper for `branch-history`/durable-execution: walk a node-event
 * stream and collect the terminal state. Throws if the iterable ends
 * before a `run_done` event.
 */
export async function collectTerminalState<S>(
  stream: AsyncIterable<NodeEvent<S>>,
): Promise<{ state: S; events: ReadonlyArray<NodeEvent<S>> }> {
  const events: NodeEvent<S>[] = [];
  let state: S | undefined;
  let done = false;
  for await (const ev of stream) {
    events.push(ev);
    if (ev.kind === "run_done") {
      state = ev.state;
      done = true;
    }
  }
  if (!done) {
    throw new GraphRunError("graph stream ended before run_done (likely a hitl_pause)");
  }
  return { state: state as S, events };
}

/**
 * Walk the stream and collect the LAST checkpoint id.  Used when an
 * external caller wants a resumable handle to the latest state without
 * re-implementing the iterator pattern.
 */
export async function collectLastCheckpoint<S>(stream: AsyncIterable<NodeEvent<S>>): Promise<{
  events: ReadonlyArray<NodeEvent<S>>;
  lastCheckpointId?: CheckpointId;
  pausedAt?: { nodeName: NodeName; checkpointId: CheckpointId; prompt: string; state: S };
}> {
  const events: NodeEvent<S>[] = [];
  let lastCheckpointId: CheckpointId | undefined;
  let pausedAt:
    | { nodeName: NodeName; checkpointId: CheckpointId; prompt: string; state: S }
    | undefined;
  for await (const ev of stream) {
    events.push(ev);
    if (ev.kind === "checkpoint") lastCheckpointId = ev.checkpointId;
    if (ev.kind === "hitl_pause") {
      // `state` = the pre-node state the approver is deciding on.
      pausedAt = {
        nodeName: ev.nodeName,
        checkpointId: ev.checkpointId,
        prompt: ev.prompt,
        state: ev.state,
      };
    }
  }
  return {
    events,
    ...(lastCheckpointId !== undefined ? { lastCheckpointId } : {}),
    ...(pausedAt !== undefined ? { pausedAt } : {}),
  };
}

export type { Checkpoint, CheckpointId, GraphRunId };
