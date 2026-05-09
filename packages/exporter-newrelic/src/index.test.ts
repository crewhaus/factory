import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  NR_DEFAULT_ENDPOINT_EU,
  NR_DEFAULT_ENDPOINT_US,
  _scrubLicenseKeyForTest,
  attachNewRelicExporter,
  attachNewRelicIfEnvSet,
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

describe("attachNewRelicExporter — T1 header injection + endpoint routing", () => {
  test("US region default endpoint", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const { fetch, calls } = captureFetch();
    const exp = attachNewRelicExporter(bus, {
      licenseKey: "nr-license-1234567890",
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
    expect(c.url).toBe(NR_DEFAULT_ENDPOINT_US);
    expect(c.headers["api-key"]).toBe("nr-license-1234567890");
    expect(c.headers["content-type"]).toBe("application/json");
  });

  test("EU region endpoint", async () => {
    const bus = new TraceEventBus({ runId: "run_b", sessionId: "sess_2" });
    const { fetch, calls } = captureFetch();
    const exp = attachNewRelicExporter(bus, {
      licenseKey: "nr-license-1234567890",
      region: "EU",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(calls[0]?.url).toBe(NR_DEFAULT_ENDPOINT_EU);
  });

  test("custom endpoint takes precedence over region", async () => {
    const bus = new TraceEventBus({ runId: "run_c", sessionId: "sess_3" });
    const { fetch, calls } = captureFetch();
    const exp = attachNewRelicExporter(bus, {
      licenseKey: "nr-license-1234567890",
      region: "EU",
      endpoint: "http://otel-sidecar:4318",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(calls[0]?.url).toBe("http://otel-sidecar:4318/v1/traces");
  });

  test("omits api-key header when licenseKey absent (sidecar mode)", async () => {
    const bus = new TraceEventBus({ runId: "run_d", sessionId: "sess_4" });
    const { fetch, calls } = captureFetch();
    const exp = attachNewRelicExporter(bus, {
      endpoint: "http://otel-sidecar:4318",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(calls[0]?.headers["api-key"]).toBeUndefined();
  });
});

describe("attachNewRelicExporter — T2 fixture trace round-trip", () => {
  test("entity.guid surfaces as a resource attr", async () => {
    const bus = new TraceEventBus({ runId: "run_e", sessionId: "sess_5" });
    const { fetch, calls } = captureFetch();
    const exp = attachNewRelicExporter(bus, {
      licenseKey: "nr-license-1234567890",
      entityGuid: "MTIzNDU2N3xBUE18QVBQTElDQVRJT058MTIzNDU2",
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
    expect(byKey["entity.guid"]).toBe("MTIzNDU2N3xBUE18QVBQTElDQVRJT058MTIzNDU2");
  });
});

describe("attachNewRelicExporter — T8 credential-leak guard", () => {
  test("license key never appears in upstream error messages", async () => {
    const bus = new TraceEventBus({ runId: "run_f", sessionId: "sess_6" });
    const licenseKey = "nr-secret-license-leakable12";
    const captured: Error[] = [];
    const failingFetch = (async () =>
      new Response(`upstream 401: license-key was ${licenseKey}`, {
        status: 401,
      })) as unknown as typeof fetch;
    const exp = attachNewRelicExporter(bus, {
      licenseKey,
      fetchImpl: failingFetch,
      flushIntervalMs: 0,
      onError: (err) => captured.push(err),
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(captured.length).toBeGreaterThan(0);
    for (const err of captured) {
      expect(err.message).not.toContain(licenseKey);
      expect(err.message).toContain("[REDACTED:NEW_RELIC_LICENSE_KEY]");
    }
  });

  test("scrubLicenseKey leaves message unchanged when key short / undefined", () => {
    const msg = "upstream 500: refused";
    expect(_scrubLicenseKeyForTest(msg, undefined)).toBe(msg);
    expect(_scrubLicenseKeyForTest("contains: abc", "abc")).toBe("contains: abc");
  });
});

describe("attachNewRelicIfEnvSet", () => {
  let originalEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns undefined when license key absent", () => {
    const bus = new TraceEventBus({ runId: "run_g", sessionId: "sess_7" });
    expect(attachNewRelicIfEnvSet(bus, {})).toBeUndefined();
  });

  test("attaches when NEW_RELIC_LICENSE_KEY set", () => {
    const bus = new TraceEventBus({ runId: "run_h", sessionId: "sess_8" });
    const exp = attachNewRelicIfEnvSet(bus, { NEW_RELIC_LICENSE_KEY: "nr-test-1234567890" });
    expect(exp).toBeDefined();
    void exp?.shutdown();
  });

  test("falls back to NR_LICENSE_KEY", () => {
    const bus = new TraceEventBus({ runId: "run_i", sessionId: "sess_9" });
    const exp = attachNewRelicIfEnvSet(bus, { NR_LICENSE_KEY: "nr-test-1234567890" });
    expect(exp).toBeDefined();
    void exp?.shutdown();
  });

  test("respects NEW_RELIC_REGION=EU", async () => {
    const bus = new TraceEventBus({ runId: "run_j", sessionId: "sess_a" });
    const { fetch, calls } = captureFetch();
    const env = {
      NEW_RELIC_LICENSE_KEY: "nr-test-1234567890",
      NEW_RELIC_REGION: "EU",
    };
    const exp1 = attachNewRelicIfEnvSet(bus, env);
    expect(exp1).toBeDefined();
    void exp1?.shutdown();
    // Verify the URL via direct attach (env-set path doesn't have a fetch
    // seam), using the same options.
    const exp2 = attachNewRelicExporter(bus, {
      licenseKey: "nr-test-1234567890",
      region: "EU",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp2.flush();
    await exp2.shutdown();
    expect(calls[0]?.url).toBe(NR_DEFAULT_ENDPOINT_EU);
  });
});
