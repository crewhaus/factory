/**
 * Catalog R7 `branch-history` — composable time-travel helpers.
 *
 * The runtime feature is owned by `checkpoint-store.branch()`; this
 * package adds two ergonomics:
 *
 *   branchAt(store, parentRunId, checkpointId) — same as
 *     `store.branch(...)` but records the branch lineage in a
 *     dedicated event stream the operator UI can render.
 *
 *   diff(store, runIdA, runIdB) — walk both runs' checkpoints in
 *     insertion order and emit a `NodeDiff[]` listing where they
 *     diverge (different node names, different state hashes, or one
 *     run terminated earlier than the other).
 *
 * Layer R7. Pairs with `checkpoint-store` (R7) and `graph-engine` (R11).
 */

import { createHash } from "node:crypto";
import type {
  Checkpoint,
  CheckpointId,
  CheckpointStore,
  GraphRunId,
} from "@crewhaus/checkpoint-store";

export type NodeDiff = {
  readonly position: number;
  readonly a?: {
    readonly checkpointId: CheckpointId;
    readonly nodeName: string;
    readonly stateHash: string;
  };
  readonly b?: {
    readonly checkpointId: CheckpointId;
    readonly nodeName: string;
    readonly stateHash: string;
  };
  readonly kind: "same" | "node-mismatch" | "state-mismatch" | "only-a" | "only-b";
};

export type BranchAtResult = {
  readonly newGraphRunId: GraphRunId;
  readonly head: Checkpoint;
};

function stateHash(c: Checkpoint): string {
  // `JSON.stringify` returns `undefined` for `state === undefined` (and for
  // values that serialize to nothing, e.g. functions/symbols). Feeding that
  // straight into `createHash().update()` throws a TypeError, so coalesce to a
  // stable sentinel — every other state serializes unchanged, preserving hashes.
  const serialized = JSON.stringify(c.state) ?? "undefined";
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

export async function branchAt(
  store: CheckpointStore,
  parentGraphRunId: GraphRunId,
  checkpointId: CheckpointId,
): Promise<BranchAtResult> {
  const result = await store.branch(parentGraphRunId, checkpointId);
  return result;
}

export async function diff(
  store: CheckpointStore,
  graphRunIdA: GraphRunId,
  graphRunIdB: GraphRunId,
): Promise<ReadonlyArray<NodeDiff>> {
  const [a, b] = await Promise.all([store.list(graphRunIdA), store.list(graphRunIdB)]);
  const out: NodeDiff[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const ca = a[i];
    const cb = b[i];
    if (ca === undefined && cb !== undefined) {
      out.push({
        position: i,
        b: { checkpointId: cb.id, nodeName: cb.nodeName, stateHash: stateHash(cb) },
        kind: "only-b",
      });
      continue;
    }
    if (cb === undefined && ca !== undefined) {
      out.push({
        position: i,
        a: { checkpointId: ca.id, nodeName: ca.nodeName, stateHash: stateHash(ca) },
        kind: "only-a",
      });
      continue;
    }
    if (ca !== undefined && cb !== undefined) {
      const ha = stateHash(ca);
      const hb = stateHash(cb);
      if (ca.nodeName !== cb.nodeName) {
        out.push({
          position: i,
          a: { checkpointId: ca.id, nodeName: ca.nodeName, stateHash: ha },
          b: { checkpointId: cb.id, nodeName: cb.nodeName, stateHash: hb },
          kind: "node-mismatch",
        });
      } else if (ha !== hb) {
        out.push({
          position: i,
          a: { checkpointId: ca.id, nodeName: ca.nodeName, stateHash: ha },
          b: { checkpointId: cb.id, nodeName: cb.nodeName, stateHash: hb },
          kind: "state-mismatch",
        });
      } else {
        out.push({
          position: i,
          a: { checkpointId: ca.id, nodeName: ca.nodeName, stateHash: ha },
          b: { checkpointId: cb.id, nodeName: cb.nodeName, stateHash: hb },
          kind: "same",
        });
      }
    }
  }
  return out;
}
