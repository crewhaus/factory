/**
 * T1 unit tests for the `attachMetricsCollector` sink-selection switch and the
 * `attachIfEnvSet` env gate. The stdout path is exercised by the three-turn
 * integration test; this file covers the textfile + http branches (without any
 * real filesystem writes — `node:fs/promises` is mocked) and the env gate.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import { attachIfEnvSet, attachMetricsCollector } from "./index";

/** A bus with an empty env so no ambient traceparent leaks in. */
const makeBus = () => new TraceEventBus({ runId: "run_a", sessionId: "sess_1", env: {} });

describe("attachMetricsCollector — textfile sink", () => {
  afterEach(() => {
    // Remove the node:fs/promises mock so it never leaks into other files.
    mock.restore();
  });

  test("textfile (default path) wires a sink whose flush writes the exposition", async () => {
    const calls: Array<{ path: string; data: string }> = [];
    await mock.module("node:fs/promises", () => ({
      writeFile: async (path: string, data: string) => {
        calls.push({ path, data });
      },
    }));

    const bus = makeBus();
    const metrics = await attachMetricsCollector(bus, { sink: { kind: "textfile" } });
    // Drive one turn so the registry has something to serialize.
    bus.publish({
      runId: bus.runId,
      sessionId: bus.sessionId,
      turnNumber: 1,
      traceId: bus.traceId,
      spanId: bus.rootSpanId,
      timestamp: new Date().toISOString(),
      kind: "turn_end",
      turn: 1,
      durationMs: 1000,
    });

    expect(metrics.port).toBeUndefined();
    await metrics.flush();
    await metrics.shutdown();
    metrics.unsubscribe();

    expect(calls).toHaveLength(1);
    // Falls back to the DEFAULT_PROM_PATH when no path is supplied.
    expect(calls[0]?.path).toBe("/var/run/crewhaus/metrics.prom");
    expect(calls[0]?.data).toContain("crewhaus_turns_total");
  });

  test("textfile with explicit path is threaded through to writeFile", async () => {
    const calls: Array<{ path: string }> = [];
    await mock.module("node:fs/promises", () => ({
      writeFile: async (path: string) => {
        calls.push({ path });
      },
    }));

    const bus = makeBus();
    const metrics = await attachMetricsCollector(bus, {
      sink: { kind: "textfile", path: "/tmp/custom.prom" },
    });
    await metrics.flush();
    await metrics.shutdown();
    metrics.unsubscribe();

    expect(calls[0]?.path).toBe("/tmp/custom.prom");
  });
});

describe("attachMetricsCollector — http sink", () => {
  test("http sink binds a port and exposes it on the AttachedMetrics handle", async () => {
    const bus = makeBus();
    const metrics = await attachMetricsCollector(bus, { sink: { kind: "http", port: 0 } });
    try {
      // port 0 → OS assigns a real ephemeral port, surfaced on the handle.
      expect(typeof metrics.port).toBe("number");
      expect(metrics.port).toBeGreaterThan(0);
      // flush() is a no-op for the pull-based sink but must resolve cleanly.
      await expect(metrics.flush()).resolves.toBeUndefined();
    } finally {
      await metrics.shutdown();
      metrics.unsubscribe();
    }
  });
});

describe("attachIfEnvSet", () => {
  test("returns undefined when CREWHAUS_METRICS is absent", async () => {
    const bus = makeBus();
    const result = await attachIfEnvSet(bus, {});
    expect(result).toBeUndefined();
  });

  test("returns undefined for an unrecognized CREWHAUS_METRICS value", async () => {
    const bus = makeBus();
    const result = await attachIfEnvSet(bus, { CREWHAUS_METRICS: "nonsense" });
    expect(result).toBeUndefined();
  });

  test("attaches a collector when CREWHAUS_METRICS=stdout", async () => {
    const bus = makeBus();
    const metrics = await attachIfEnvSet(bus, { CREWHAUS_METRICS: "stdout" });
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("expected an attached collector");
    try {
      expect(metrics.registry).toBeDefined();
      // stdout sink has no bound port.
      expect(metrics.port).toBeUndefined();
    } finally {
      await metrics.shutdown();
      metrics.unsubscribe();
    }
  });
});
