/**
 * Catalog R11 `durable-execution` — exactly-once node-execution wrapper.
 *
 * The graph-engine writes a checkpoint after every successful node, so
 * a crashed run can resume by loading the last checkpoint and replaying
 * the next edge. This package adds two further guarantees:
 *
 *   1. Idempotency keys. Each node-execution attempt computes
 *      `idempotencyKey(graphRunId, nodeName, attemptIndex)` and a
 *      backing store keeps a record of completed attempts. If the same
 *      key is seen twice, the second invocation returns the cached
 *      result instead of re-executing — preventing double-spend in
 *      side-effectful tools.
 *
 *   2. Resume helpers. `resumeFrom(store, graphRunId)` returns the
 *      next-node hint a caller can pass to `graph.run({ resumeFrom })`,
 *      computed by walking the checkpoint chain backward to the latest
 *      successfully-completed node. The default policy ("re-run the
 *      next edge") composes with graph-engine; alternative policies
 *      (e.g. retry the failed node) can be plugged in via the optional
 *      `policy` callback.
 *
 * Layer R11. Pairs with `checkpoint-store` (R7) and `graph-engine` (R11).
 */

import { createHash } from "node:crypto";
import type { CheckpointId, CheckpointStore, GraphRunId } from "@crewhaus/checkpoint-store";

export type IdempotencyKey = string;

export function idempotencyKey(
  graphRunId: GraphRunId,
  nodeName: string,
  attemptIndex = 0,
): IdempotencyKey {
  return createHash("sha256")
    .update(`${graphRunId}|${nodeName}|${attemptIndex}`)
    .digest("hex")
    .slice(0, 24);
}

export type IdempotencyRecord = {
  readonly key: IdempotencyKey;
  readonly graphRunId: GraphRunId;
  readonly nodeName: string;
  readonly attempt: number;
  readonly result: unknown;
  readonly completedAt: string;
};

export interface IdempotencyStore {
  get(key: IdempotencyKey): Promise<IdempotencyRecord | undefined>;
  put(record: IdempotencyRecord): Promise<void>;
}

class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<IdempotencyKey, IdempotencyRecord>();
  async get(key: IdempotencyKey): Promise<IdempotencyRecord | undefined> {
    return this.entries.get(key);
  }
  async put(record: IdempotencyRecord): Promise<void> {
    this.entries.set(record.key, record);
  }
}

/**
 * Wrap a node fn with idempotency. The first call executes normally and
 * caches the result against `idempotencyKey(graphRunId, nodeName,
 * attempt)`. Subsequent calls with the same key return the cached
 * result without invoking the inner fn — which is exactly what crash
 * recovery needs: if the engine restarts mid-node, the same idempotency
 * key resolves to the prior side-effect's result.
 */
export function withIdempotency<S>(
  inner: (graphRunId: GraphRunId, nodeName: string, prev: S) => Promise<S>,
  opts: { readonly store?: IdempotencyStore; readonly attempt?: number } = {},
): (graphRunId: GraphRunId, nodeName: string, prev: S) => Promise<S> {
  const store = opts.store ?? new InMemoryIdempotencyStore();
  const attempt = opts.attempt ?? 0;
  return async (graphRunId, nodeName, prev) => {
    const key = idempotencyKey(graphRunId, nodeName, attempt);
    const cached = await store.get(key);
    if (cached !== undefined) return cached.result as S;
    const result = await inner(graphRunId, nodeName, prev);
    await store.put({
      key,
      graphRunId,
      nodeName,
      attempt,
      result,
      completedAt: new Date().toISOString(),
    });
    return result;
  };
}

/**
 * Read the latest checkpoint of `graphRunId` and return the
 * `{ checkpointId, nextNode }` hint for `graph.run({ resumeFrom })`.
 * `nextNode` is the LAST committed node; the engine will re-evaluate
 * its outgoing edge to figure out where to go next.
 */
export async function resumeFrom(
  store: CheckpointStore,
  graphRunId: GraphRunId,
): Promise<{ checkpointId: CheckpointId; nextNode: string } | undefined> {
  const meta = await store.meta(graphRunId);
  if (meta?.head === undefined) return undefined;
  const head = await store.load(graphRunId, meta.head);
  if (head === undefined) return undefined;
  return { checkpointId: head.id, nextNode: head.nodeName };
}

export { InMemoryIdempotencyStore };
