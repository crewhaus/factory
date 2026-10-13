/**
 * Listening for a caller's abort without disarming it.
 *
 * Measured on Bun 1.3.14: removing the LAST `abort` listener from a signal
 * made by `AbortSignal.timeout()` cancels its timer for good. The signal
 * never aborts after that, even with a listener added again. A helper that
 * adds a listener per call and removes it when done therefore turned the
 * caller's `AbortSignal.timeout(5000)` into a signal that never fires: the
 * next call it was passed to ran without a deadline.
 *
 * So each signal gets one permanent no-op listener, added once, and a
 * helper's own listeners come and go above it. `AbortSignal.any` and
 * `AbortController` signals are not affected; pinning them is harmless.
 */

const pinned = new WeakSet<AbortSignal>();

const noop = (): void => undefined;

/**
 * Call `fn` once when `signal` aborts. Returns the unsubscribe. Never
 * leaves the signal without a listener, so its timer (if any) stays armed.
 */
export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (signal === undefined) return noop;
  if (!pinned.has(signal)) {
    pinned.add(signal);
    signal.addEventListener("abort", noop, { once: true });
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}
