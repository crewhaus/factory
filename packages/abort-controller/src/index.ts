/**
 * Catalog R1 `abort-controller` — parent/child cancellation tree.
 *
 * Semantics:
 *   - Parent abort cascades to all children (recursively).
 *   - Sibling abort does NOT propagate.
 *   - Child abort does NOT propagate up to the parent.
 *   - If `parent` is already aborted at construction time, the child is born aborted.
 *
 * Memory: parent → child propagation goes through WeakRefs so an abandoned
 * child doesn't pin the parent, and a finalized child's listener is removed
 * from the parent on its own abort. Mirrors the proven pattern in
 * `claude-code/utils/abortController.ts`.
 *
 * Listener limit: Node's default of 10 trips a warning when a busy turn fans
 * out into many tool calls; we raise it to 50 per signal.
 */
import { setMaxListeners } from "node:events";

const MAX_LISTENERS_PER_SIGNAL = 50;

export type AbortTree = {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
  child(): AbortTree;
};

/**
 * Build an `AbortTree` rooted at the given parent (or no parent for a fresh
 * root). The returned tree's `child()` produces children whose `signal`
 * fires when this tree's `signal` fires.
 */
export function createAbortTree(parent?: AbortSignal): AbortTree {
  const controller = new AbortController();
  setMaxListeners(MAX_LISTENERS_PER_SIGNAL, controller.signal);

  if (parent !== undefined) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      attachParent(parent, controller);
    }
  }

  return {
    signal: controller.signal,
    abort(reason?: unknown) {
      controller.abort(reason);
    },
    child() {
      return createAbortTree(controller.signal);
    },
  };
}

/**
 * Wire `parent` so its abort propagates to `childCtl`. Uses WeakRefs both ways
 * so neither the parent nor the listener pins the other.
 */
function attachParent(parent: AbortSignal, childCtl: AbortController): void {
  const weakChild = new WeakRef(childCtl);

  function onParentAbort(this: AbortSignal): void {
    const ctl = weakChild.deref();
    if (ctl !== undefined && !ctl.signal.aborted) {
      ctl.abort(this.reason);
    }
  }

  parent.addEventListener("abort", onParentAbort, { once: true });

  // When the child aborts on its own, drop the parent listener so the parent
  // doesn't accumulate dead listeners across many children.
  childCtl.signal.addEventListener(
    "abort",
    () => {
      parent.removeEventListener("abort", onParentAbort);
    },
    { once: true },
  );
}
