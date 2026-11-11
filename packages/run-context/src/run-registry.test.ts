/**
 * The run registry: a context that made its own controller can be cancelled by
 * its run id, holds keep a run open until the last one is released, and the
 * map is bounded by a count, never by time.
 */
import { describe, expect, test } from "bun:test";
import {
  RUN_REGISTRY_CAP,
  cancelRun,
  createRunContext,
  isCancelReason,
  onRunIdle,
  retainRun,
} from "./index";

describe("cancelRun", () => {
  test("a context with no signal of its own is cancelled by its run id, with the branded reason", () => {
    const ctx = createRunContext();
    expect(ctx.abortSignal.aborted).toBe(false);
    expect(cancelRun(ctx.runId)).toBe(true);
    expect(ctx.abortSignal.aborted).toBe(true);
    expect(ctx.abortSignal.reason).toEqual({ crewhausCancel: true });
    expect(isCancelReason(ctx.abortSignal)).toBe(true);
  });

  test("a context made with a caller's signal is not the registry's to cancel", () => {
    const controller = new AbortController();
    const ctx = createRunContext({ abortSignal: controller.signal });
    expect(cancelRun(ctx.runId)).toBe(false);
    expect(ctx.abortSignal.aborted).toBe(false);
  });

  test("an unknown run answers false", () => {
    expect(cancelRun("run_00000000000000000000000000")).toBe(false);
  });

  test("another abort reason is not a cancel", () => {
    const controller = new AbortController();
    controller.abort(new Error("SIGINT"));
    expect(isCancelReason(controller.signal)).toBe(false);
    expect(isCancelReason(new AbortController().signal)).toBe(false);
  });

  test("after the last release the run is gone: cancelRun answers false", () => {
    const ctx = createRunContext();
    const release = retainRun(ctx);
    expect(cancelRun(ctx.runId)).toBe(true);
    release();
    expect(cancelRun(ctx.runId)).toBe(false);
  });

  test(`the registry keeps ${RUN_REGISTRY_CAP} runs: the oldest of ${RUN_REGISTRY_CAP + 1} is evicted, the newest is not`, () => {
    const contexts = Array.from({ length: RUN_REGISTRY_CAP + 1 }, () => createRunContext());
    const first = contexts[0];
    const last = contexts[contexts.length - 1];
    if (first === undefined || last === undefined) throw new Error("no contexts");
    expect(cancelRun(first.runId)).toBe(false);
    expect(cancelRun(last.runId)).toBe(true);
    expect(first.abortSignal.aborted).toBe(false);
  });
});

describe("holds", () => {
  test("two holds: the idle handler runs once, on the second release; a double release is a no-op", () => {
    const ctx = createRunContext();
    const releaseA = retainRun(ctx);
    const releaseB = retainRun(ctx);
    let idle = 0;
    expect(onRunIdle(ctx.runId, () => idle++)).toBe(true);
    releaseA();
    expect(idle).toBe(0);
    releaseA();
    expect(idle).toBe(0);
    // Still held by B: the run can still be cancelled.
    expect(cancelRun(ctx.runId)).toBe(true);
    releaseB();
    expect(idle).toBe(1);
    releaseB();
    expect(idle).toBe(1);
  });

  test("the last idle handler set is the one that runs", () => {
    const ctx = createRunContext();
    const release = retainRun(ctx);
    const ran: string[] = [];
    onRunIdle(ctx.runId, () => ran.push("first"));
    onRunIdle(ctx.runId, () => ran.push("second"));
    release();
    expect(ran).toEqual(["second"]);
  });

  test("an idle handler that throws does not reach the caller, and the entry still goes", () => {
    const ctx = createRunContext();
    const release = retainRun(ctx);
    onRunIdle(ctx.runId, () => {
      throw new Error("boom");
    });
    expect(() => release()).not.toThrow();
    expect(cancelRun(ctx.runId)).toBe(false);
  });

  test(`a held run survives ${RUN_REGISTRY_CAP} newer contexts: the oldest unheld one is evicted instead`, () => {
    const unheld = createRunContext();
    const held = createRunContext();
    const release = retainRun(held);
    for (let i = 0; i < RUN_REGISTRY_CAP; i++) createRunContext();
    expect(cancelRun(unheld.runId)).toBe(false);
    expect(cancelRun(held.runId)).toBe(true);
    let idle = 0;
    onRunIdle(held.runId, () => idle++);
    release();
    expect(idle).toBe(1);
  });

  test("a context with a caller's signal can be held: its idle handler runs, and it is still not cancellable", () => {
    const ctx = createRunContext({ abortSignal: new AbortController().signal });
    expect(onRunIdle(ctx.runId, () => {})).toBe(false);
    const release = retainRun(ctx);
    let idle = 0;
    expect(onRunIdle(ctx.runId, () => idle++)).toBe(true);
    expect(cancelRun(ctx.runId)).toBe(false);
    release();
    expect(idle).toBe(1);
  });

  test("a held run evicted because every other entry is held still runs its idle handler on release", () => {
    const releases: Array<() => void> = [];
    const first = createRunContext();
    releases.push(retainRun(first));
    let idle = 0;
    onRunIdle(first.runId, () => idle++);
    for (let i = 0; i < RUN_REGISTRY_CAP; i++) releases.push(retainRun(createRunContext()));
    // Every entry was held, so the oldest held one made room.
    expect(cancelRun(first.runId)).toBe(false);
    for (const release of releases) release();
    expect(idle).toBe(1);
  });
});
