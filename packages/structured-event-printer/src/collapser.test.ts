/**
 * T1 — `model_stream_token` events collapse into one rolling summary line.
 * Non-token events are passed through to the caller's formatter.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { StreamCollapser } from "./stream-collapser";

const baseEnv = {
  runId: "run_a",
  sessionId: "sess_1",
  turnNumber: 1,
  traceId: `${"0".repeat(31)}1`,
  spanId: `${"0".repeat(15)}1`,
  timestamp: "2026-05-07T12:00:00.000Z",
};

describe("StreamCollapser", () => {
  test("absorbs 100 token events into rolling-line writes (TTY)", () => {
    const writes: string[] = [];
    const collapser = new StreamCollapser({
      sink: (c) => writes.push(c),
      isTty: true,
    });
    for (let i = 0; i < 100; i += 1) {
      const consumed = collapser.consume({
        ...baseEnv,
        kind: "model_stream_token",
        chunkIndex: i,
        deltaChars: 5,
      } as TraceEvent);
      expect(consumed).toBe(true);
    }
    expect(writes).toHaveLength(100);
    // Every write starts with carriage return so it overwrites the previous line.
    for (const w of writes) expect(w.startsWith("\r")).toBe(true);
  });

  test("non-TTY mode swallows token events silently and prints one summary on finalize", () => {
    const writes: string[] = [];
    const collapser = new StreamCollapser({
      sink: (c) => writes.push(c),
      isTty: false,
    });
    for (let i = 0; i < 50; i += 1) {
      collapser.consume({
        ...baseEnv,
        kind: "model_stream_token",
        chunkIndex: i,
        deltaChars: 5,
      } as TraceEvent);
    }
    expect(writes).toHaveLength(0);
    collapser.finalize();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("chunks=50");
    expect(writes[0]).toContain("chars=250");
  });

  test("non-token event is not consumed and triggers finalize for any active stream", () => {
    const writes: string[] = [];
    const collapser = new StreamCollapser({
      sink: (c) => writes.push(c),
      isTty: true,
    });
    collapser.consume({
      ...baseEnv,
      kind: "model_stream_token",
      chunkIndex: 0,
      deltaChars: 1,
    } as TraceEvent);
    const consumed = collapser.consume({
      ...baseEnv,
      kind: "model_response",
      model: "x",
      stopReason: "end_turn",
      usage: { input: 1, output: 1 },
      durationMs: 1,
    } as TraceEvent);
    expect(consumed).toBe(false);
    // Two writes: the rolling stream update + the (done) finalizer.
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes[writes.length - 1]).toContain("(done)");
  });
});

describe("StreamCollapser default sink", () => {
  const originalWrite = process.stderr.write.bind(process.stderr);

  afterEach(() => {
    // Restore the real stderr writer so no mock leaks into other tests.
    process.stderr.write = originalWrite;
  });

  test("falls back to process.stderr.write when no sink is supplied", () => {
    // Exercises the default-sink branch in the constructor without touching
    // the real terminal: we stub stderr.write to capture the chunk. isTty is
    // forced false so exactly one (deterministic) summary line is emitted.
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    const collapser = new StreamCollapser({ isTty: false });
    collapser.consume({
      ...baseEnv,
      kind: "model_stream_token",
      chunkIndex: 0,
      deltaChars: 4,
    } as TraceEvent);
    collapser.finalize();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe("[stream] chunks=1 chars=4 (done)\n");
  });
});
