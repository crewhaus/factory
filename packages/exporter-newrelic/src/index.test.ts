import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  NR_DEFAULT_ENDPOINT_EU,
  NR_DEFAULT_ENDPOINT_US,
  _scrubLicenseKeyForTest,
  _wrapFetchWithEntityGuidForTest,
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

  test("default onError writes a scrubbed message to stderr when no handler given", async () => {
    const bus = new TraceEventBus({ runId: "run_k", sessionId: "sess_b" });
    const licenseKey = "nr-secret-license-leakable12";
    const writes: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ): boolean => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write);
    try {
      const failingFetch = (async () =>
        new Response(`upstream 401: license-key was ${licenseKey}`, {
          status: 401,
        })) as unknown as typeof fetch;
      // No onError supplied -> exercises the default stderr branch.
      const exp = attachNewRelicExporter(bus, {
        licenseKey,
        fetchImpl: failingFetch,
        flushIntervalMs: 0,
      });
      publishTurnPair(bus);
      await exp.flush();
      await exp.shutdown();
    } finally {
      stderrSpy.mockRestore();
    }
    const joined = writes.join("");
    expect(joined).toContain("[exporter-newrelic] export failed:");
    expect(joined).toContain("[REDACTED:NEW_RELIC_LICENSE_KEY]");
    expect(joined).not.toContain(licenseKey);
  });
});

describe("wrapFetchWithEntityGuid (direct test seam)", () => {
  const ENTITY = "MTIzNDU2N3xBUE18QVBQTElDQVRJT058MTIzNDU2";

  function recordingFetch(): {
    fetch: typeof fetch;
    calls: { input: unknown; init?: RequestInit }[];
  } {
    const calls: { input: unknown; init?: RequestInit }[] = [];
    const fn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    return { fetch: fn, calls };
  }

  test("injects entity.guid into each resourceSpans resource", async () => {
    const { fetch, calls } = recordingFetch();
    const wrapped = _wrapFetchWithEntityGuidForTest(fetch, ENTITY);
    const body = JSON.stringify({
      resourceSpans: [
        { resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] } },
        {}, // no resource -> existing falls back to []
      ],
    });
    await wrapped("https://otlp.example/v1/traces", { method: "POST", body });

    expect(calls.length).toBe(1);
    const sent = JSON.parse(String(calls[0]?.init?.body));
    const attrs0 = sent.resourceSpans[0].resource.attributes;
    const attrs1 = sent.resourceSpans[1].resource.attributes;
    // First resource keeps its original attr AND gains entity.guid.
    expect(attrs0).toContainEqual({ key: "service.name", value: { stringValue: "svc" } });
    expect(attrs0).toContainEqual({ key: "entity.guid", value: { stringValue: ENTITY } });
    // Second resource (none originally) gets just entity.guid.
    expect(attrs1).toEqual([{ key: "entity.guid", value: { stringValue: ENTITY } }]);
  });

  test("falls through unchanged when body is not valid JSON (catch path)", async () => {
    const { fetch, calls } = recordingFetch();
    const wrapped = _wrapFetchWithEntityGuidForTest(fetch, ENTITY);
    await wrapped("https://otlp.example/v1/traces", { method: "POST", body: "not-json{" });
    expect(calls.length).toBe(1);
    // Original (untouched) body forwarded verbatim.
    expect(calls[0]?.init?.body).toBe("not-json{");
  });

  test("falls through unchanged when JSON lacks resourceSpans array", async () => {
    const { fetch, calls } = recordingFetch();
    const wrapped = _wrapFetchWithEntityGuidForTest(fetch, ENTITY);
    const body = JSON.stringify({ resourceSpans: "nope" });
    await wrapped("https://otlp.example/v1/traces", { method: "POST", body });
    expect(calls.length).toBe(1);
    expect(calls[0]?.init?.body).toBe(body);
  });

  test("falls through unchanged when body is absent or non-string", async () => {
    const { fetch, calls } = recordingFetch();
    const wrapped = _wrapFetchWithEntityGuidForTest(fetch, ENTITY);
    // Absent init entirely.
    await wrapped("https://otlp.example/v1/traces");
    // Non-string body (e.g. a Uint8Array).
    const bytes = new Uint8Array([1, 2, 3]);
    await wrapped("https://otlp.example/v1/traces", { method: "POST", body: bytes });
    expect(calls.length).toBe(2);
    expect(calls[0]?.init).toBeUndefined();
    expect(calls[1]?.init?.body).toBe(bytes);
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
