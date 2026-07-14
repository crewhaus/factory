/**
 * F1 two-birds regression — end-to-end wiring between `cost-tracker`'s
 * emit-on-miss fix and the alert-watchdog's pricing-miss detector.
 *
 * The watchdog's `SessionMetricsAccumulator` has always folded a
 * `cost_accrual` with `costUsdMicros === 0 && inputTokens + outputTokens > 0`
 * into `pricingMisses`. But before F1, `cost-tracker` early-returned on a
 * pricing miss and published nothing, so that detector had no event to fire
 * on in practice. Now `cost-tracker` publishes a $0 accrual carrying the real
 * tokens on a miss, so folding the REAL bus output (not a hand-crafted event)
 * finally drives the counter. These tests wire an actual tracker to a real
 * bus and confirm the accumulator sees the miss.
 */
import { describe, expect, test } from "bun:test";
import { createCostTracker } from "@crewhaus/cost-tracker";
import { type ModelResponseEvent, type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { SessionMetricsAccumulator } from "./alert-watchdog";

const RUN_ID = "run_watchdog_miss";
const SESSION_ID = "sess_watchdog_miss01";

function modelResponse(
  bus: TraceEventBus,
  model: string,
  provider: ModelResponseEvent["provider"],
  input: number,
  output: number,
): ModelResponseEvent {
  return {
    ...bus.envelope(),
    runId: bus.runId,
    kind: "model_response",
    model,
    provider,
    stopReason: "end_turn",
    usage: { input, output },
    durationMs: 100,
  };
}

describe("alert-watchdog ↔ cost-tracker emit-on-miss integration", () => {
  test("an unpriced model's model_response now drives the watchdog pricing-miss counter", () => {
    const bus = new TraceEventBus({ runId: RUN_ID, sessionId: SESSION_ID });
    const acc = new SessionMetricsAccumulator();
    // The watchdog is a bus subscriber that folds every event.
    bus.subscribe((e: TraceEvent) => acc.fold(e));
    // A real cost-tracker on the same bus: it re-publishes a cost_accrual per
    // model_response (including, post-F1, on a pricing miss).
    createCostTracker(bus);

    // An unmapped model → pricing miss → cost-tracker emits a $0 accrual with
    // the real tokens, which the watchdog folds as a pricing miss.
    bus.publish(modelResponse(bus, "totally-unmapped-xyz", "openai", 120, 30));

    const snap = acc.snapshot("sess_x");
    expect(snap.pricingMisses).toBe(1);
    // The response itself was also folded as a model call.
    expect(snap.modelCalls).toBe(1);
    // Nothing was charged.
    expect(snap.costUsdMicros).toBe(0);
  });

  test("a priced model does NOT increment the pricing-miss counter", () => {
    const bus = new TraceEventBus({ runId: RUN_ID, sessionId: SESSION_ID });
    const acc = new SessionMetricsAccumulator();
    bus.subscribe((e: TraceEvent) => acc.fold(e));
    createCostTracker(bus);

    // claude-haiku-4-5 is priced ($1/$5): 1000×1 + 500×5 = 3_500 micros.
    bus.publish(modelResponse(bus, "claude-haiku-4-5", "anthropic", 1000, 500));

    const snap = acc.snapshot("sess_x");
    expect(snap.pricingMisses).toBe(0);
    expect(snap.modelCalls).toBe(1);
    expect(snap.costUsdMicros).toBe(3_500);
  });
});
