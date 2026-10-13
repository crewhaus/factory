import { describe, expect, test } from "bun:test";
import { onAbort } from "./signal";

/** Whether `signal` has aborted within `ms`, polled without adding a listener. */
async function firesWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    if (signal.aborted) return true;
    await Bun.sleep(20);
  }
  return signal.aborted;
}

describe("onAbort", () => {
  test("a listener that comes and goes leaves an AbortSignal.timeout armed", async () => {
    // The premise, measured on Bun 1.3.14: removing the last listener by
    // hand cancels the timer for good.
    const bare = AbortSignal.timeout(100);
    const fn = (): void => undefined;
    bare.addEventListener("abort", fn);
    bare.removeEventListener("abort", fn);
    const signal = AbortSignal.timeout(100);
    const unsubscribe = onAbort(signal, () => undefined);
    unsubscribe();
    expect(await firesWithin(signal, 10_000)).toBe(true);
    // Recorded, not asserted: a Bun that fixes this makes the pin harmless.
    if (!(await firesWithin(bare, 200))) expect(bare.aborted).toBe(false);
  }, 20_000);

  test("calls back once on abort, and not after unsubscribing", () => {
    const controller = new AbortController();
    let calls = 0;
    onAbort(controller.signal, () => {
      calls += 1;
    });
    let later = 0;
    const off = onAbort(controller.signal, () => {
      later += 1;
    });
    off();
    controller.abort();
    controller.abort();
    expect({ calls, later }).toEqual({ calls: 1, later: 0 });
    expect(onAbort(undefined, () => undefined)).toBeTypeOf("function");
  });
});
