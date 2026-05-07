/**
 * T7 backpressure: 1000 events/sec with one slow async subscriber. Verifies
 * the bus never silently drops events on the publish side and that `flush()`
 * resolves once async work settles.
 */
import { describe, expect, test } from "bun:test";
import { TraceEventBus } from "./event-bus";

describe("TraceEventBus backpressure", () => {
  test("absorbs 5000 events with a slow async subscriber without dropping", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", ringSize: 10000 });
    let received = 0;
    bus.subscribe(async () => {
      await Promise.resolve();
      received += 1;
    });
    const N = 5000;
    const start = performance.now();
    for (let i = 0; i < N; i += 1) {
      bus.publish({
        runId: bus.runId,
        sessionId: bus.sessionId,
        turnNumber: 1,
        traceId: bus.traceId,
        spanId: bus.rootSpanId,
        timestamp: new Date().toISOString(),
        kind: "model_stream_token",
        chunkIndex: i,
        deltaChars: 1,
      });
    }
    await bus.flush();
    const elapsedMs = performance.now() - start;
    expect(received).toBe(N);
    expect(bus.stats().subscriberFailures).toBe(0);
    // 5000 events in well under 5 seconds even with a microtask per event.
    expect(elapsedMs).toBeLessThan(5000);
  });

  test("ephemeral events skip the ring buffer under load", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1", ringSize: 100 });
    let count = 0;
    bus.subscribe(() => {
      count += 1;
    });
    for (let i = 0; i < 1000; i += 1) {
      bus.publish(
        {
          runId: bus.runId,
          sessionId: bus.sessionId,
          turnNumber: 1,
          traceId: bus.traceId,
          spanId: bus.rootSpanId,
          timestamp: new Date().toISOString(),
          kind: "model_stream_token",
          chunkIndex: i,
          deltaChars: 1,
        },
        { ephemeral: true },
      );
    }
    expect(count).toBe(1000);
    expect(bus.recent()).toHaveLength(0);
  });
});
