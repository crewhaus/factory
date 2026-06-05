import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { createAbortTree } from "./index";

describe("createAbortTree — basics", () => {
  test("root has an unsignalled signal", () => {
    const root = createAbortTree();
    expect(root.signal.aborted).toBe(false);
  });

  test("aborting root signals its signal", () => {
    const root = createAbortTree();
    root.abort();
    expect(root.signal.aborted).toBe(true);
  });

  test("abort reason propagates", () => {
    const root = createAbortTree();
    root.abort(new Error("test reason"));
    expect((root.signal.reason as Error).message).toBe("test reason");
  });
});

describe("parent → child cascade", () => {
  test("parent abort cascades to child", () => {
    const root = createAbortTree();
    const child = root.child();
    expect(child.signal.aborted).toBe(false);
    root.abort();
    expect(child.signal.aborted).toBe(true);
  });

  test("parent abort cascades to grandchild", () => {
    const root = createAbortTree();
    const child = root.child();
    const grandchild = child.child();
    root.abort();
    expect(child.signal.aborted).toBe(true);
    expect(grandchild.signal.aborted).toBe(true);
  });

  test("siblings are independent", () => {
    const root = createAbortTree();
    const a = root.child();
    const b = root.child();
    a.abort();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(root.signal.aborted).toBe(false);
  });

  test("child abort does NOT propagate to parent", () => {
    const root = createAbortTree();
    const child = root.child();
    child.abort();
    expect(child.signal.aborted).toBe(true);
    expect(root.signal.aborted).toBe(false);
  });

  test("child constructed from already-aborted parent is born aborted", () => {
    const root = createAbortTree();
    root.abort();
    const child = root.child();
    expect(child.signal.aborted).toBe(true);
  });

  test("createAbortTree(parent) — external parent signal", () => {
    const ctl = new AbortController();
    const tree = createAbortTree(ctl.signal);
    expect(tree.signal.aborted).toBe(false);
    ctl.abort();
    expect(tree.signal.aborted).toBe(true);
  });
});

describe("reason propagation", () => {
  test("parent abort reason cascades to child and grandchild", () => {
    const root = createAbortTree();
    const child = root.child();
    const grandchild = child.child();
    const reason = new Error("cascade reason");
    root.abort(reason);
    expect(child.signal.reason).toBe(reason);
    expect(grandchild.signal.reason).toBe(reason);
  });

  test("already-aborted parent passes its reason to a freshly born child", () => {
    const root = createAbortTree();
    const reason = new Error("born-aborted reason");
    root.abort(reason);
    const child = root.child();
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe(reason);
  });

  test("child's own abort reason does not leak to the parent", () => {
    const root = createAbortTree();
    const child = root.child();
    child.abort(new Error("child-only reason"));
    expect(root.signal.aborted).toBe(false);
    expect(root.signal.reason).toBeUndefined();
  });

  test("abort with no reason yields the default DOMException reason on cascade", () => {
    const root = createAbortTree();
    const child = root.child();
    root.abort();
    expect(child.signal.aborted).toBe(true);
    // AbortController with no explicit reason produces an AbortError DOMException.
    expect(child.signal.reason).toBeInstanceOf(DOMException);
    expect((child.signal.reason as DOMException).name).toBe("AbortError");
  });
});

describe("idempotency & ordering", () => {
  test("aborting the root twice is a no-op the second time (reason is sticky)", () => {
    const root = createAbortTree();
    const first = new Error("first");
    root.abort(first);
    root.abort(new Error("second"));
    expect(root.signal.reason).toBe(first);
  });

  test("aborting a parent after the child already self-aborted leaves the child's reason intact", () => {
    const root = createAbortTree();
    const child = root.child();
    const childReason = new Error("child self");
    child.abort(childReason);
    // Parent aborts afterwards; child must keep its own reason, not adopt the parent's.
    root.abort(new Error("parent later"));
    expect(child.signal.reason).toBe(childReason);
    expect(root.signal.aborted).toBe(true);
  });

  test("deep chain (5 levels) all cascade from a single root abort", () => {
    const root = createAbortTree();
    const levels = [root];
    for (let i = 0; i < 5; i++) {
      const next = levels[levels.length - 1];
      if (next === undefined) throw new Error("unreachable");
      levels.push(next.child());
    }
    for (const node of levels) expect(node.signal.aborted).toBe(false);
    root.abort();
    for (const node of levels) expect(node.signal.aborted).toBe(true);
  });
});

describe("listener hygiene on the parent signal (finalization-removal path)", () => {
  test("each live child registers exactly one abort listener on the parent", () => {
    const root = createAbortTree();
    expect(getEventListeners(root.signal, "abort").length).toBe(0);
    const a = root.child();
    expect(getEventListeners(root.signal, "abort").length).toBe(1);
    const b = root.child();
    expect(getEventListeners(root.signal, "abort").length).toBe(2);
    // Keep references alive so neither can be GC'd before we assert.
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
  });

  test("a child's own abort removes its listener from the parent", () => {
    const root = createAbortTree();
    const a = root.child();
    const b = root.child();
    expect(getEventListeners(root.signal, "abort").length).toBe(2);

    a.abort();
    expect(getEventListeners(root.signal, "abort").length).toBe(1);

    b.abort();
    expect(getEventListeners(root.signal, "abort").length).toBe(0);
    // Parent itself stays unaborted throughout.
    expect(root.signal.aborted).toBe(false);
  });

  test("parent abort consumes the once-listener (parent left with none afterwards)", () => {
    const root = createAbortTree();
    const child = root.child();
    expect(getEventListeners(root.signal, "abort").length).toBe(1);
    root.abort();
    expect(child.signal.aborted).toBe(true);
    // The { once: true } parent listener is consumed on fire.
    expect(getEventListeners(root.signal, "abort").length).toBe(0);
  });
});

describe("external parent signal", () => {
  test("createAbortTree wraps an external AbortController signal and cascades", () => {
    const ext = new AbortController();
    const tree = createAbortTree(ext.signal);
    expect(tree.signal.aborted).toBe(false);
    const grandchild = tree.child();
    const reason = new Error("external abort");
    ext.abort(reason);
    expect(tree.signal.aborted).toBe(true);
    expect(tree.signal.reason).toBe(reason);
    expect(grandchild.signal.aborted).toBe(true);
    expect(grandchild.signal.reason).toBe(reason);
  });

  test("already-aborted external signal yields a born-aborted tree", () => {
    const ext = new AbortController();
    const reason = new Error("pre-aborted external");
    ext.abort(reason);
    const tree = createAbortTree(ext.signal);
    expect(tree.signal.aborted).toBe(true);
    expect(tree.signal.reason).toBe(reason);
  });
});

describe("memory-safety: collected child does not break parent abort", () => {
  // Exercises the WeakRef deref()===undefined branch in attachParent's
  // onParentAbort: an abandoned child must not pin the parent, and the parent
  // aborting after the child is collected must be a safe no-op for that child.
  test("aborting a parent whose child was GC'd does not throw", () => {
    const root = createAbortTree();

    // Create a child but retain only a WeakRef to its signal so the underlying
    // AbortController is eligible for collection once this helper returns.
    const probe = ((): WeakRef<AbortSignal> => {
      const child = root.child();
      return new WeakRef(child.signal);
    })();

    // Bun.gc(true) performs a synchronous, deterministic full GC.
    let collected = false;
    for (let i = 0; i < 20 && !collected; i++) {
      Bun.gc(true);
      collected = probe.deref() === undefined;
    }

    // The parent still holds one listener for the (now possibly collected) child.
    // Aborting must never throw, regardless of whether collection happened.
    expect(() => root.abort(new Error("after-collect"))).not.toThrow();
    expect(root.signal.aborted).toBe(true);

    // Bun reliably collects the unreferenced controller; assert we actually hit
    // the deref()===undefined path. If a future runtime cannot collect here,
    // this assertion documents the regression rather than silently passing.
    expect(collected).toBe(true);
  });
});

// T3: Integration — abort the parent and observe a real Bun.spawn'd child
// process exit (SIGTERM cascade via { signal }).
describe("T3 — child-process SIGTERM on parent abort", () => {
  test("Bun.spawn(['sleep', '30'], { signal: child.signal }) exits when parent aborts", async () => {
    const root = createAbortTree();
    const child = root.child();

    const proc = Bun.spawn(["sleep", "30"], {
      signal: child.signal,
      stdout: "pipe",
      stderr: "pipe",
    });

    const start = Date.now();
    // Abort 100 ms in to make sure the spawn has time to start.
    setTimeout(() => root.abort(), 100);

    const exitCode = await proc.exited;
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(2_000); // sleep 30 — would have run for 30 s without abort
    expect(child.signal.aborted).toBe(true);
    // Bun's signal-driven exit yields a non-zero exit code (typically null/143).
    // We just assert the process ended early.
    expect(exitCode).not.toBe(0);
  });
});
