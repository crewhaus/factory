/**
 * T1 + T7 — exporter happy path: subscribes to a TraceEventBus, accumulates
 * a turn + tool round-trip, flushes via the injected `fetch` impl, and
 * the OTLP/JSON payload is well-formed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { attachIfEnvSet, attachOtelExporter, parseHeaders } from "./exporter";

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

  test("non-ok HTTP response → onError with status + truncated body", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const errors: Error[] = [];
    const bodyText = "x".repeat(400);
    const fakeFetch = (async () =>
      new Response(bodyText, { status: 503 })) as unknown as typeof fetch;
    const otel = attachOtelExporter(bus, {
      endpoint: "http://collector:4318/v1/traces",
      serviceName: "crewhaus-test",
      flushIntervalMs: 0,
      fetchImpl: fakeFetch,
      onError: (e) => errors.push(e),
    });
    bus.publish({ ...env(bus), kind: "turn_start", turn: 1, messageCount: 0 });
    bus.publish({ ...env(bus), kind: "turn_end", turn: 1, durationMs: 1 });
    await otel.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("OTLP export 503");
    // Body is truncated to 256 chars.
    expect(errors[0]?.message.length).toBeLessThan(300);
    expect(errors[0]?.message).toContain("xxx");
    // endpoint already ends in /v1/traces — must not be doubled.
    expect(otel.pendingSpanCount()).toBe(0);
    await otel.shutdown();
  });

  test("non-ok response whose body read throws → '<no body>' fallback", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const errors: Error[] = [];
    // Response stub whose .text() rejects exercises safeText's catch branch.
    const badResponse = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("stream broken")),
    } as unknown as Response;
    const fakeFetch = (async () => badResponse) as unknown as typeof fetch;
    const otel = attachOtelExporter(bus, {
      endpoint: "http://collector:4318",
      serviceName: "crewhaus-test",
      flushIntervalMs: 0,
      fetchImpl: fakeFetch,
      onError: (e) => errors.push(e),
    });
    bus.publish({ ...env(bus), kind: "turn_start", turn: 1, messageCount: 0 });
    bus.publish({ ...env(bus), kind: "turn_end", turn: 1, durationMs: 1 });
    await otel.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("OTLP export 500: <no body>");
    await otel.shutdown();
  });

  test("default onError writes to stderr (no onError supplied)", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    // Patch stderr.write so the default onError branch is observed without
    // emitting noise; restored in finally so no global state leaks.
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    const failing = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const otel = attachOtelExporter(bus, {
      endpoint: "http://collector:4318",
      serviceName: "crewhaus-test",
      flushIntervalMs: 0,
      fetchImpl: failing,
    });
    try {
      bus.publish({ ...env(bus), kind: "turn_start", turn: 1, messageCount: 0 });
      bus.publish({ ...env(bus), kind: "turn_end", turn: 1, durationMs: 1 });
      await otel.flush();
    } finally {
      process.stderr.write = originalWrite;
      await otel.shutdown();
    }
    expect(writes.some((w) => w.includes("[otel-exporter] export failed: boom"))).toBe(true);
  });

  test("timer-based flush fires on the interval and POSTs without a real clock", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    let posted = 0;
    const fakeFetch = (async () => {
      posted += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    // A 1ms interval drives the setInterval branch deterministically; the
    // timer is unref'd inside the exporter and we clear it via shutdown().
    const otel = attachOtelExporter(bus, {
      endpoint: "http://collector:4318",
      serviceName: "crewhaus-test",
      flushIntervalMs: 1,
      fetchImpl: fakeFetch,
    });
    bus.publish({ ...env(bus), kind: "turn_start", turn: 1, messageCount: 0 });
    bus.publish({ ...env(bus), kind: "turn_end", turn: 1, durationMs: 1 });
    // Poll until the interval callback drains the buffer (no fixed sleep).
    const deadline = Date.now() + 2000;
    while (otel.pendingSpanCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(otel.pendingSpanCount()).toBe(0);
    expect(posted).toBeGreaterThanOrEqual(1);
    await otel.shutdown();
  });

  test("concurrent flush() awaits the in-flight request before starting a new one", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      // First call blocks until released so the second flush() observes
      // inFlight !== undefined and awaits it (line 115 branch).
      if (calls === 1) await gate;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const otel = attachOtelExporter(bus, {
      endpoint: "http://collector:4318",
      serviceName: "crewhaus-test",
      flushIntervalMs: 0,
      fetchImpl: fakeFetch,
    });

    bus.publish({ ...env(bus), kind: "turn_start", turn: 1, messageCount: 0 });
    bus.publish({ ...env(bus), kind: "turn_end", turn: 1, durationMs: 1 });
    const first = otel.flush();
    // Second flush starts while the first is still awaiting the gate.
    const second = otel.flush();
    release();
    await Promise.all([first, second]);
    expect(otel.pendingSpanCount()).toBe(0);
    await otel.shutdown();
  });

  test("shutdown is idempotent and a no-op flush returns early on empty buffer", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const otel = attachOtelExporter(bus, {
      endpoint: "http://collector:4318",
      serviceName: "crewhaus-test",
      flushIntervalMs: 0,
      fetchImpl: fakeFetch,
    });
    // Empty buffer → flush returns before touching fetch.
    await otel.flush();
    expect(calls).toBe(0);
    await otel.shutdown();
    // Second shutdown short-circuits via the `stopped` guard.
    await otel.shutdown();
    expect(calls).toBe(0);
  });
});

describe("attachIfEnvSet", () => {
  // Track exporters created so timers/subscriptions never leak between tests.
  let attached: { shutdown(): Promise<void> } | undefined;
  afterEach(async () => {
    if (attached) {
      await attached.shutdown();
      attached = undefined;
    }
  });

  test("returns undefined when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    expect(attachIfEnvSet(bus, {})).toBeUndefined();
  });

  test("attaches with endpoint + parsed headers (header branch)", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    // Exercises the `...(headers ? { headers } : {})` spread with headers set.
    // No spans are published, so the afterEach shutdown()'s flush early-returns
    // on the empty buffer and never touches the global fetch / network.
    const exporter = attachIfEnvSet(bus, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer tok",
    } as NodeJS.ProcessEnv);
    expect(exporter).toBeDefined();
    attached = exporter;
    expect(exporter?.pendingSpanCount()).toBe(0);
  });

  test("default service name path when OTEL_SERVICE_NAME unset and no headers", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    // No OTEL_SERVICE_NAME → default "crewhaus"; no headers → empty spread.
    const named = attachIfEnvSet(bus, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    } as NodeJS.ProcessEnv);
    expect(named).toBeDefined();
    attached = named;
    expect(named?.pendingSpanCount()).toBe(0);
  });

  test("falls back to process.env by default (no endpoint there → undefined)", () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const saved = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    Reflect.deleteProperty(process.env, "OTEL_EXPORTER_OTLP_ENDPOINT");
    try {
      expect(attachIfEnvSet(bus)).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = saved;
    }
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
