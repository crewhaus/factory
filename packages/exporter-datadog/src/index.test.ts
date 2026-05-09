import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  DD_DEFAULT_ENDPOINT,
  _parseDdTagsForTest,
  _scrubApiKeyForTest,
  attachDatadogExporter,
  attachDatadogIfEnvSet,
} from "./index";

type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function captureFetch(): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    const headers: Record<string, string> = {};
    const init0 = init ?? {};
    if (init0.headers) {
      const h = new Headers(init0.headers);
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    calls.push({
      url,
      method: init0.method ?? "GET",
      headers,
      body: typeof init0.body === "string" ? init0.body : "",
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

function publishTurnPair(bus: TraceEventBus, turn = 1): void {
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn, durationMs: 100 });
}

describe("attachDatadogExporter — T1 header injection + endpoint routing", () => {
  test("uses DD_DEFAULT_ENDPOINT when no endpoint override", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const { fetch, calls } = captureFetch();
    const exp = attachDatadogExporter(bus, {
      apiKey: "dd-test-1234567890",
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
    expect(c.url).toBe(DD_DEFAULT_ENDPOINT);
    expect(c.method).toBe("POST");
    expect(c.headers["dd-api-key"]).toBe("dd-test-1234567890");
    expect(c.headers["content-type"]).toBe("application/json");
  });

  test("respects custom endpoint override (e.g. sidecar collector)", async () => {
    const bus = new TraceEventBus({ runId: "run_b", sessionId: "sess_2" });
    const { fetch, calls } = captureFetch();
    const exp = attachDatadogExporter(bus, {
      apiKey: "dd-test-1234567890",
      endpoint: "http://otel-sidecar:4318",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(calls[0]?.url).toBe("http://otel-sidecar:4318/v1/traces");
  });

  test("omits DD-API-KEY header when apiKey not supplied (sidecar mode)", async () => {
    const bus = new TraceEventBus({ runId: "run_c", sessionId: "sess_3" });
    const { fetch, calls } = captureFetch();
    const exp = attachDatadogExporter(bus, {
      endpoint: "http://otel-sidecar:4318",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(calls[0]?.headers["dd-api-key"]).toBeUndefined();
  });
});

describe("attachDatadogExporter — T2 fixture trace round-trip", () => {
  test("payload contains dd.service / dd.env / dd.version resource attrs", async () => {
    const bus = new TraceEventBus({ runId: "run_d", sessionId: "sess_4" });
    const { fetch, calls } = captureFetch();
    const exp = attachDatadogExporter(bus, {
      apiKey: "dd-test-1234567890",
      service: "my-agent",
      env: "staging",
      version: "1.2.3",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    const first = calls[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("calls[0] missing");
    const body = JSON.parse(first.body);
    const resourceAttrs = body.resourceSpans[0].resource.attributes;
    const byKey = Object.fromEntries(
      resourceAttrs.map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(byKey["dd.service"]).toBe("my-agent");
    expect(byKey["dd.env"]).toBe("staging");
    expect(byKey["dd.version"]).toBe("1.2.3");
    expect(byKey["service.name"]).toBe("crewhaus");
  });

  test("DD_TAGS-style tags become dd.tag.<key> resource attrs", async () => {
    const bus = new TraceEventBus({ runId: "run_e", sessionId: "sess_5" });
    const { fetch, calls } = captureFetch();
    const exp = attachDatadogExporter(bus, {
      apiKey: "dd-test-1234567890",
      tags: ["team:platform", "region:us-east-1"],
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    const first = calls[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("calls[0] missing");
    const body = JSON.parse(first.body);
    const resourceAttrs = body.resourceSpans[0].resource.attributes;
    const byKey = Object.fromEntries(
      resourceAttrs.map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(byKey["dd.tag.team"]).toBe("platform");
    expect(byKey["dd.tag.region"]).toBe("us-east-1");
  });

  test("default service/env/version when not configured", async () => {
    const bus = new TraceEventBus({ runId: "run_f", sessionId: "sess_6" });
    const { fetch, calls } = captureFetch();
    const exp = attachDatadogExporter(bus, {
      apiKey: "dd-test-1234567890",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    const first = calls[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("calls[0] missing");
    const body = JSON.parse(first.body);
    const byKey = Object.fromEntries(
      body.resourceSpans[0].resource.attributes.map(
        (a: { key: string; value: { stringValue?: string } }) => [a.key, a.value.stringValue],
      ),
    );
    expect(byKey["dd.service"]).toBe("crewhaus");
    expect(byKey["dd.env"]).toBe("production");
    expect(byKey["dd.version"]).toBe("0.0.0");
  });
});

describe("attachDatadogExporter — T8 credential-leak guard", () => {
  test("API key is scrubbed from upstream error messages", async () => {
    const bus = new TraceEventBus({ runId: "run_g", sessionId: "sess_7" });
    const apiKey = "dd-secret-key-abcdef123456";
    const captured: Error[] = [];
    const failingFetch: typeof fetch = (async () =>
      new Response(`upstream error referencing ${apiKey} — should be scrubbed`, {
        status: 500,
      })) as unknown as typeof fetch;
    const exp = attachDatadogExporter(bus, {
      apiKey,
      fetchImpl: failingFetch,
      flushIntervalMs: 0,
      onError: (err) => captured.push(err),
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(captured.length).toBeGreaterThan(0);
    for (const err of captured) {
      expect(err.message).not.toContain(apiKey);
      expect(err.message).toContain("[REDACTED:DD_API_KEY]");
    }
  });

  test("scrubApiKey leaves message unchanged when no key supplied", () => {
    const msg = "upstream 500: refused";
    expect(_scrubApiKeyForTest(msg, undefined)).toBe(msg);
    expect(_scrubApiKeyForTest(msg, "")).toBe(msg);
    // Refuse to scrub overly short keys (would over-match).
    expect(_scrubApiKeyForTest("contains: abc", "abc")).toBe("contains: abc");
  });
});

describe("attachDatadogIfEnvSet", () => {
  let originalEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns undefined when DD_API_KEY and DD_OTLP_ENDPOINT are both absent", () => {
    const bus = new TraceEventBus({ runId: "run_h", sessionId: "sess_8" });
    const exp = attachDatadogIfEnvSet(bus, {});
    expect(exp).toBeUndefined();
  });

  test("returns undefined when DD_TRACE_ENABLED=false", () => {
    const bus = new TraceEventBus({ runId: "run_i", sessionId: "sess_9" });
    const exp = attachDatadogIfEnvSet(bus, { DD_API_KEY: "k", DD_TRACE_ENABLED: "false" });
    expect(exp).toBeUndefined();
  });

  test("attaches when DD_API_KEY is set", () => {
    const bus = new TraceEventBus({ runId: "run_j", sessionId: "sess_a" });
    const exp = attachDatadogIfEnvSet(bus, { DD_API_KEY: "dd-test-1234567890" });
    expect(exp).toBeDefined();
    void exp?.shutdown();
  });

  test("attaches when DD_OTLP_ENDPOINT is set without DD_API_KEY", () => {
    const bus = new TraceEventBus({ runId: "run_k", sessionId: "sess_b" });
    const exp = attachDatadogIfEnvSet(bus, { DD_OTLP_ENDPOINT: "http://sidecar:4318" });
    expect(exp).toBeDefined();
    void exp?.shutdown();
  });
});

describe("parseDdTags", () => {
  test("parses well-formed comma-separated tags", () => {
    expect(_parseDdTagsForTest("team:platform,region:us-east-1")).toEqual([
      "team:platform",
      "region:us-east-1",
    ]);
  });
  test("rejects malformed tags (no colon, embedded space, leading colon)", () => {
    expect(_parseDdTagsForTest("teamplatform,region:us east")).toEqual([]);
    expect(_parseDdTagsForTest(":bare,team:platform")).toEqual(["team:platform"]);
  });
  test("returns empty array for undefined / empty string", () => {
    expect(_parseDdTagsForTest(undefined)).toEqual([]);
    expect(_parseDdTagsForTest("")).toEqual([]);
  });
});
