/**
 * 0.6.0 §7.9 — latency hygiene for the pool reward.
 *
 * The reward's latency term (`RouteObservation.latencyMs`) was measured as
 * `now - t0Model` at the streaming fold, which spans every tool the
 * streaming executor ran MID-STREAM (a tool dispatches the moment its
 * `input_json` closes, while the model is still generating, and the drain
 * after `message_stop` waits for the stragglers). A tool-heavy cheap arm was
 * therefore penalised for latency it did not cause — and the learned policy
 * learned the wrong thing from it. The non-streaming path never had the
 * problem: tools run after the fold there.
 *
 * `createSpanUnionTracker` accumulates the UNION of overlapping spans (not
 * their sum — up to `maxConcurrentTools` tools run at once, and summing would
 * over-subtract), so `modelLatencyMs = wall - toolBusyMs` is the model's own
 * time. Wall time is untouched: `model_response.durationMs` and `turn_end`
 * keep measuring the turn the user waited for.
 *
 * Pure and clock-injectable so the union semantics are unit-tested with a
 * fake clock — the runtime never asserts wall-clock timing.
 */

export type SpanUnionTracker = {
  /** A span opened (a `runTool` dispatch started). */
  readonly enter: () => void;
  /** A span closed (that dispatch settled — success, error or abort alike). */
  readonly exit: () => void;
  /** Total time, in ms, during which AT LEAST ONE span was open. */
  readonly busyMs: () => number;
};

/**
 * Track the union of concurrent spans against `now` (defaults to
 * `performance.now`). `busyMs()` may be read while spans are still open — it
 * then includes the in-progress stretch up to `now()`.
 */
export function createSpanUnionTracker(
  now: () => number = () => performance.now(),
): SpanUnionTracker {
  let open = 0;
  let openedAt: number | undefined;
  let settled = 0;
  return {
    enter(): void {
      if (open === 0) openedAt = now();
      open += 1;
    },
    exit(): void {
      if (open === 0) return; // tolerate an unmatched exit rather than go negative
      open -= 1;
      if (open === 0 && openedAt !== undefined) {
        settled += Math.max(0, now() - openedAt);
        openedAt = undefined;
      }
    },
    busyMs(): number {
      const live = open > 0 && openedAt !== undefined ? Math.max(0, now() - openedAt) : 0;
      return settled + live;
    },
  };
}

/**
 * The model's own latency for a streamed call: the wall span from request
 * open (`t0Model`) to the fold (`nowMs`), minus the tool-busy union. Clamped
 * at 0 so a tool span that (through clock skew) outlives the wall span can
 * never yield a negative latency — which would be read as "infinitely fast"
 * by the reward.
 */
export function modelLatencyMs(t0Model: number, nowMs: number, toolBusyMs: number): number {
  return Math.max(0, nowMs - t0Model - Math.max(0, toolBusyMs));
}
