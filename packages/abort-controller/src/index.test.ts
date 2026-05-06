import { describe, expect, test } from "bun:test";
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
