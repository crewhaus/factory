/**
 * T1 + T7 — exporter happy path: subscribes to a TraceEventBus, accumulates
 * a turn + tool round-trip, flushes via the injected `fetch` impl, and
 * the OTLP/JSON payload is well-formed.
 */
import { describe, expect, test } from "bun:test";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { attachOtelExporter, parseHeaders } from "./exporter";

const env = (bus: TraceEventBus, overrides: Partial<TraceEvent> = {}) => ({
  runId: bus.runId,
  sessionId: bus.sessionId,
  turnNumber: 1,
  traceId: bus.traceId,
  spanId: bus.rootSpanId,
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe("attachOtelExporter", () => {
  test("flush POSTs OTLP payload with resourceSpans/scopeSpans/spans", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    let lastUrl = "";
    let lastBody: string | undefined;
    const fakeFetch = (async (url: string, init?: { body?: unknown }) => {
      lastUrl = url;
      lastBody = typeof init?.body === "string" ? init.body : "";
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const otel = attachOtelExporter(bus, {
      endpoint: "http://collector:4318",
      serviceName: "crewhaus-test",
      flushIntervalMs: 0,
      fetchImpl: fakeFetch,
    });

    bus.publish({ ...env(bus), kind: "turn_start", turn: 1, messageCount: 0 });
    bus.publish({
      ...env(bus),
      kind: "model_request",
      model: "claude-opus-4-7",
      messageCount: 1,
      toolCount: 1,
      streaming: true,
    });
    bus.publish({
      ...env(bus),
      kind: "model_response",
      model: "claude-opus-4-7",
      stopReason: "tool_use",
      usage: { input: 100, output: 30 },
      durationMs: 800,
    });
    bus.publish({
      ...env(bus),
      kind: "tool_call_start",
      toolUseId: "toolu_a",
      toolName: "Bash",
      inputBytes: 20,
    });
    bus.publish({
      ...env(bus),
      kind: "tool_call_end",
      toolUseId: "toolu_a",
      toolName: "Bash",
      isError: false,
      outputBytes: 50,
      durationMs: 12,
    });
    bus.publish({ ...env(bus), kind: "turn_end", turn: 1, durationMs: 1500 });

    expect(otel.pendingSpanCount()).toBe(3);
    await otel.flush();
    expect(otel.pendingSpanCount()).toBe(0);
    expect(lastUrl).toBe("http://collector:4318/v1/traces");
    expect(lastBody).toBeDefined();
    const payload = JSON.parse(lastBody as string);
    expect(payload.resourceSpans).toHaveLength(1);
    const rs = payload.resourceSpans[0];
    const serviceName = rs.resource.attributes.find(
      (a: { key: string }) => a.key === "service.name",
    );
    expect(serviceName.value.stringValue).toBe("crewhaus-test");
    expect(rs.scopeSpans).toHaveLength(1);
    const spans = rs.scopeSpans[0].spans;
    expect(spans).toHaveLength(3);
    const names = spans.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(["gen_ai.chat", "tool.Bash", "turn"]);
    for (const s of spans) {
      expect(s.traceId).toBe(bus.traceId);
    }

    await otel.shutdown();
  });

  test("export errors are captured via onError, not thrown", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const errors: Error[] = [];
    const failing = (async () => {
      throw new Error("network is down");
    }) as unknown as typeof fetch;
    const otel = attachOtelExporter(bus, {
      endpoint: "http://collector:4318",
      serviceName: "crewhaus-test",
      flushIntervalMs: 0,
      fetchImpl: failing,
      onError: (e) => errors.push(e),
    });

    bus.publish({ ...env(bus), kind: "turn_start", turn: 1, messageCount: 0 });
    bus.publish({ ...env(bus), kind: "turn_end", turn: 1, durationMs: 1 });
    await otel.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("network is down");
    await otel.shutdown();
  });
});

describe("parseHeaders", () => {
  test("returns undefined for empty/undefined", () => {
    expect(parseHeaders(undefined)).toBeUndefined();
    expect(parseHeaders("")).toBeUndefined();
    expect(parseHeaders(",")).toBeUndefined();
  });
  test("parses comma-separated k=v pairs", () => {
    expect(parseHeaders("Authorization=Bearer foo,X-Tenant=bar")).toEqual({
      Authorization: "Bearer foo",
      "X-Tenant": "bar",
    });
  });
  test("ignores malformed entries", () => {
    expect(parseHeaders("Authorization=Bearer foo,malformed,=alone,Tenant=bar")).toEqual({
      Authorization: "Bearer foo",
      Tenant: "bar",
    });
  });
});
