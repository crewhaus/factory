import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  _scrubAccessTokenForTest,
  attachSplunkExporter,
  attachSplunkIfEnvSet,
  buildSplunkEndpoint,
} from "./index";

type Captured = { url: string; headers: Record<string, string>; body: string };
function captureFetch(): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    calls.push({
      url,
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response("", { status: 200 });
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

const eventEnv = (bus: TraceEventBus, overrides: Partial<TraceEvent> = {}) => ({
  runId: bus.runId,
  sessionId: bus.sessionId,
  turnNumber: 1,
  traceId: bus.traceId,
  spanId: bus.rootSpanId,
  timestamp: new Date().toISOString(),
  ...overrides,
});

function publishTurnPair(bus: TraceEventBus): void {
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 50 });
}

describe("buildSplunkEndpoint", () => {
  test("constructs the realm-scoped ingest URL", () => {
    expect(buildSplunkEndpoint("us0")).toBe("https://ingest.us0.signalfx.com/v2/trace/otlp");
    expect(buildSplunkEndpoint("eu0")).toBe("https://ingest.eu0.signalfx.com/v2/trace/otlp");
  });
});

describe("attachSplunkExporter — T1 header injection + endpoint routing", () => {
  test("uses the realm-scoped endpoint by default", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const { fetch, calls } = captureFetch();
    const exp = attachSplunkExporter(bus, {
      realm: "us0",
      accessToken: "sf-test-1234567890",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(calls.length).toBeGreaterThan(0);
    const c = calls[0];
    expect(c).toBeDefined();
    if (c === undefined) throw new Error("calls[0] missing");
    expect(c.url).toBe("https://ingest.us0.signalfx.com/v2/trace/otlp/v1/traces");
    expect(c.headers["x-sf-token"]).toBe("sf-test-1234567890");
    expect(c.headers["content-type"]).toBe("application/json");
  });

  test("custom endpoint takes precedence over realm", async () => {
    const bus = new TraceEventBus({ runId: "run_b", sessionId: "sess_2" });
    const { fetch, calls } = captureFetch();
    const exp = attachSplunkExporter(bus, {
      realm: "us0",
      endpoint: "http://otel-sidecar:4318",
      accessToken: "sf-test-1234567890",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(calls[0]?.url).toBe("http://otel-sidecar:4318/v1/traces");
  });

  test("rejects malformed realm (uppercase / spaces)", () => {
    const bus = new TraceEventBus({ runId: "run_c", sessionId: "sess_3" });
    expect(() => attachSplunkExporter(bus, { realm: "US0", accessToken: "x" })).toThrow(
      /lowercase alphanumeric/,
    );
    expect(() => attachSplunkExporter(bus, { realm: "us 0", accessToken: "x" })).toThrow(
      /lowercase alphanumeric/,
    );
  });

  test("requires at least one of realm / endpoint", () => {
    const bus = new TraceEventBus({ runId: "run_d", sessionId: "sess_4" });
    expect(() => attachSplunkExporter(bus, { accessToken: "x" })).toThrow(
      /requires either `realm` or `endpoint`/,
    );
  });
});

describe("attachSplunkExporter — T2 fixture trace round-trip", () => {
  test("splunk.index / splunk.source surface as resource attrs", async () => {
    const bus = new TraceEventBus({ runId: "run_e", sessionId: "sess_5" });
    const { fetch, calls } = captureFetch();
    const exp = attachSplunkExporter(bus, {
      realm: "us0",
      accessToken: "sf-test-1234567890",
      index: "main",
      source: "crewhaus-runtime",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    const body = JSON.parse(calls[0]?.body ?? "{}");
    const attrs = body.resourceSpans[0].resource.attributes;
    const byKey = Object.fromEntries(
      attrs.map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(byKey["splunk.index"]).toBe("main");
    expect(byKey["splunk.source"]).toBe("crewhaus-runtime");
    expect(byKey["service.name"]).toBe("crewhaus");
  });
});

describe("attachSplunkExporter — T8 credential-leak guard", () => {
  test("access token never appears in upstream error messages", async () => {
    const bus = new TraceEventBus({ runId: "run_f", sessionId: "sess_6" });
    const accessToken = "sf-secret-leakable12345";
    const captured: Error[] = [];
    const failingFetch = (async () =>
      new Response(`upstream 500: token was ${accessToken}`, {
        status: 500,
      })) as unknown as typeof fetch;
    const exp = attachSplunkExporter(bus, {
      realm: "us0",
      accessToken,
      fetchImpl: failingFetch,
      flushIntervalMs: 0,
      onError: (err) => captured.push(err),
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(captured.length).toBeGreaterThan(0);
    for (const err of captured) {
      expect(err.message).not.toContain(accessToken);
      expect(err.message).toContain("[REDACTED:SPLUNK_ACCESS_TOKEN]");
    }
  });

  test("scrubAccessToken leaves message unchanged when token short / undefined", () => {
    const msg = "upstream 500: refused";
    expect(_scrubAccessTokenForTest(msg, undefined)).toBe(msg);
    expect(_scrubAccessTokenForTest("contains: abc", "abc")).toBe("contains: abc");
  });
});

describe("attachSplunkIfEnvSet", () => {
  let originalEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns undefined unless both SPLUNK_REALM and SPLUNK_ACCESS_TOKEN are set", () => {
    const bus = new TraceEventBus({ runId: "run_g", sessionId: "sess_7" });
    expect(attachSplunkIfEnvSet(bus, {})).toBeUndefined();
    expect(attachSplunkIfEnvSet(bus, { SPLUNK_REALM: "us0" })).toBeUndefined();
    expect(attachSplunkIfEnvSet(bus, { SPLUNK_ACCESS_TOKEN: "x" })).toBeUndefined();
  });

  test("attaches when both env vars set", () => {
    const bus = new TraceEventBus({ runId: "run_h", sessionId: "sess_8" });
    const exp = attachSplunkIfEnvSet(bus, {
      SPLUNK_REALM: "us0",
      SPLUNK_ACCESS_TOKEN: "sf-test-1234567890",
    });
    expect(exp).toBeDefined();
    void exp?.shutdown();
  });
});
