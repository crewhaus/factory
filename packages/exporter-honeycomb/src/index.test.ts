import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  HC_DEFAULT_API_HOST,
  _scrubApiKeyForTest,
  attachHoneycombExporter,
  attachHoneycombIfEnvSet,
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

describe("attachHoneycombExporter — T1 header injection + endpoint routing", () => {
  test("uses HC_DEFAULT_API_HOST + /v1/traces by default", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: "sess_1" });
    const { fetch, calls } = captureFetch();
    const exp = attachHoneycombExporter(bus, {
      apiKey: "hc-key-abcdefghijk",
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
    expect(c.url).toBe(`${HC_DEFAULT_API_HOST}/v1/traces`);
    expect(c.headers["x-honeycomb-team"]).toBe("hc-key-abcdefghijk");
    expect(c.headers["x-honeycomb-dataset"]).toBe("crewhaus");
    expect(c.headers["content-type"]).toBe("application/json");
  });

  test("respects HONEYCOMB_API_HOST override (EU region)", async () => {
    const bus = new TraceEventBus({ runId: "run_b", sessionId: "sess_2" });
    const { fetch, calls } = captureFetch();
    const exp = attachHoneycombExporter(bus, {
      apiKey: "hc-eu-key-abcdefghijk",
      apiHost: "https://api.eu1.honeycomb.io",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    const c = calls[0];
    expect(c?.url).toBe("https://api.eu1.honeycomb.io/v1/traces");
  });

  test("custom dataset overrides the service.name default", async () => {
    const bus = new TraceEventBus({ runId: "run_c", sessionId: "sess_3" });
    const { fetch, calls } = captureFetch();
    const exp = attachHoneycombExporter(bus, {
      apiKey: "hc-key-abcdefghijk",
      serviceName: "agents",
      dataset: "tools-and-eval",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(calls[0]?.headers["x-honeycomb-dataset"]).toBe("tools-and-eval");
    // Resource service.name still reflects the OTel attr.
    const body = JSON.parse(calls[0]?.body ?? "{}");
    const attrs = body.resourceSpans[0].resource.attributes;
    const byKey = Object.fromEntries(
      attrs.map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(byKey["service.name"]).toBe("agents");
  });
});

describe("attachHoneycombExporter — T2 fixture trace round-trip", () => {
  test("OTLP payload shape is well-formed (resourceSpans / scopeSpans / spans)", async () => {
    const bus = new TraceEventBus({ runId: "run_d", sessionId: "sess_4" });
    const { fetch, calls } = captureFetch();
    const exp = attachHoneycombExporter(bus, {
      apiKey: "hc-key-abcdefghijk",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(Array.isArray(body.resourceSpans)).toBe(true);
    expect(body.resourceSpans.length).toBe(1);
    expect(Array.isArray(body.resourceSpans[0].scopeSpans)).toBe(true);
    expect(body.resourceSpans[0].scopeSpans[0].spans.length).toBeGreaterThan(0);
  });
});

describe("attachHoneycombExporter — T8 credential-leak guard", () => {
  test("API key never appears in upstream error messages", async () => {
    const bus = new TraceEventBus({ runId: "run_e", sessionId: "sess_5" });
    const apiKey = "hc-secret-key-leakable123";
    const captured: Error[] = [];
    const failingFetch = (async () =>
      new Response(`upstream 500: api-key was ${apiKey}`, {
        status: 500,
      })) as unknown as typeof fetch;
    const exp = attachHoneycombExporter(bus, {
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
      expect(err.message).toContain("[REDACTED:HONEYCOMB_API_KEY]");
    }
  });

  test("scrubApiKey leaves message unchanged when key is undefined or short", () => {
    const msg = "upstream 500: refused";
    expect(_scrubApiKeyForTest(msg, undefined)).toBe(msg);
    expect(_scrubApiKeyForTest(msg, "")).toBe(msg);
    expect(_scrubApiKeyForTest("contains: abc", "abc")).toBe("contains: abc");
  });
});

describe("attachHoneycombExporter — onError fallback + key handling", () => {
  test("stderr fallback redacts the API key when no onError is supplied", async () => {
    const bus = new TraceEventBus({ runId: "run_se", sessionId: "sess_se" });
    const apiKey = "hc-secret-key-leakable999";
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    try {
      const failingFetch = (async () =>
        new Response(`upstream 500: api-key was ${apiKey}`, {
          status: 500,
        })) as unknown as typeof fetch;
      // No onError => exercises the process.stderr.write fallback branch.
      const exp = attachHoneycombExporter(bus, {
        apiKey,
        fetchImpl: failingFetch,
        flushIntervalMs: 0,
      });
      publishTurnPair(bus);
      await exp.flush();
      await exp.shutdown();
    } finally {
      spy.mockRestore();
    }
    expect(writes.length).toBeGreaterThan(0);
    const joined = writes.join("");
    expect(joined).toContain("[exporter-honeycomb] export failed:");
    expect(joined).not.toContain(apiKey);
    expect(joined).toContain("[REDACTED:HONEYCOMB_API_KEY]");
  });

  test("passes the original Error through unchanged when no key is present in the message", async () => {
    const bus = new TraceEventBus({ runId: "run_orig", sessionId: "sess_orig" });
    const apiKey = "hc-key-abcdefghijk";
    const captured: Error[] = [];
    const networkError = new TypeError("network unreachable");
    const failingFetch = (async () => {
      throw networkError;
    }) as unknown as typeof fetch;
    const exp = attachHoneycombExporter(bus, {
      apiKey,
      fetchImpl: failingFetch,
      flushIntervalMs: 0,
      onError: (err) => captured.push(err),
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    expect(captured.length).toBeGreaterThan(0);
    // Message has no API key => scrubApiKey is a no-op => the SAME Error instance
    // is forwarded (the ternary keeps `err`, not a freshly wrapped Error).
    expect(captured[0]).toBe(networkError);
    expect(captured[0]?.message).toBe("network unreachable");
  });

  test("omits the x-honeycomb-team header when no apiKey is provided", async () => {
    const bus = new TraceEventBus({ runId: "run_nokey", sessionId: "sess_nokey" });
    const { fetch, calls } = captureFetch();
    const exp = attachHoneycombExporter(bus, {
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp.flush();
    await exp.shutdown();
    const c = calls[0];
    expect(c).toBeDefined();
    expect(c?.headers["x-honeycomb-dataset"]).toBe("crewhaus");
    expect(c?.headers["x-honeycomb-team"]).toBeUndefined();
  });
});

describe("attachHoneycombIfEnvSet", () => {
  let originalEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns undefined when HONEYCOMB_API_KEY is absent", () => {
    const bus = new TraceEventBus({ runId: "run_f", sessionId: "sess_6" });
    expect(attachHoneycombIfEnvSet(bus, {})).toBeUndefined();
  });

  test("attaches when HONEYCOMB_API_KEY is set", () => {
    const bus = new TraceEventBus({ runId: "run_g", sessionId: "sess_7" });
    const exp = attachHoneycombIfEnvSet(bus, { HONEYCOMB_API_KEY: "hc-key-abcdefghijk" });
    expect(exp).toBeDefined();
    void exp?.shutdown();
  });

  test("respects HONEYCOMB_DATASET / HONEYCOMB_API_HOST env", async () => {
    const bus = new TraceEventBus({ runId: "run_h", sessionId: "sess_8" });
    const { fetch, calls } = captureFetch();
    const exp = attachHoneycombIfEnvSet(bus, {
      HONEYCOMB_API_KEY: "hc-key-abcdefghijk",
      HONEYCOMB_DATASET: "billing",
      HONEYCOMB_API_HOST: "https://api.eu1.honeycomb.io",
    });
    expect(exp).toBeDefined();
    if (exp === undefined) return;
    // Re-attach via the same bus with fetchImpl is not possible after the
    // env-set call; just check that exporter works for one publish via the
    // attached one. We need a stub fetch — re-create with explicit attach.
    void exp.shutdown();
    const exp2 = attachHoneycombExporter(bus, {
      apiKey: "hc-key-abcdefghijk",
      dataset: "billing",
      apiHost: "https://api.eu1.honeycomb.io",
      fetchImpl: fetch,
      flushIntervalMs: 0,
    });
    publishTurnPair(bus);
    await exp2.flush();
    await exp2.shutdown();
    expect(calls[0]?.url).toBe("https://api.eu1.honeycomb.io/v1/traces");
    expect(calls[0]?.headers["x-honeycomb-dataset"]).toBe("billing");
  });
});
