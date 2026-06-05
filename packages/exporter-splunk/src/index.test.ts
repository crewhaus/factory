import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  _scrubAccessTokenForTest,
  _wrapFetchWithSplunkAttrsForTest,
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

  test("forwards OTEL_SERVICE_NAME / SPLUNK_INDEX / SPLUNK_SOURCE into the exporter", async () => {
    // attachSplunkIfEnvSet exposes no fetch seam, so we stub the global fetch
    // to keep this deterministic (no real network) and inspect the request the
    // env-derived options ultimately produce.
    const calls: Array<{ url: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    let exp: ReturnType<typeof attachSplunkIfEnvSet>;
    try {
      const bus = new TraceEventBus({ runId: "run_h2", sessionId: "sess_8b" });
      exp = attachSplunkIfEnvSet(bus, {
        SPLUNK_REALM: "eu0",
        SPLUNK_ACCESS_TOKEN: "sf-test-1234567890",
        OTEL_SERVICE_NAME: "custom-svc",
        SPLUNK_INDEX: "audit",
        SPLUNK_SOURCE: "fleet",
      });
      expect(exp).toBeDefined();
      publishTurnPair(bus);
      await exp?.flush();
      await exp?.shutdown();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.url).toBe("https://ingest.eu0.signalfx.com/v2/trace/otlp/v1/traces");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    const attrs = body.resourceSpans[0].resource.attributes;
    const byKey = Object.fromEntries(
      attrs.map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(byKey["service.name"]).toBe("custom-svc");
    expect(byKey["splunk.index"]).toBe("audit");
    expect(byKey["splunk.source"]).toBe("fleet");
  });
});

describe("attachSplunkExporter — default error logger (no onError)", () => {
  test("writes a token-scrubbed message to stderr when export fails", async () => {
    const bus = new TraceEventBus({ runId: "run_i", sessionId: "sess_9" });
    const accessToken = "sf-secret-leakable12345";
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      // 500 body embeds the token; the upstream exporter folds it into the
      // error message, and our default logger must scrub it before stderr.
      const failingFetch = (async () =>
        new Response(`upstream 500: token was ${accessToken}`, {
          status: 500,
        })) as unknown as typeof fetch;
      const exp = attachSplunkExporter(bus, {
        realm: "us0",
        accessToken,
        fetchImpl: failingFetch,
        flushIntervalMs: 0,
      });
      publishTurnPair(bus);
      await exp.flush();
      await exp.shutdown();
    } finally {
      spy.mockRestore();
    }
    const splunkLines = writes.filter((w) => w.includes("[exporter-splunk] export failed:"));
    expect(splunkLines.length).toBeGreaterThan(0);
    for (const line of splunkLines) {
      expect(line).not.toContain(accessToken);
      expect(line).toContain("[REDACTED:SPLUNK_ACCESS_TOKEN]");
    }
  });

  test("passes the original error through stderr when the message has no token", async () => {
    const bus = new TraceEventBus({ runId: "run_i2", sessionId: "sess_9b" });
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      // Network-style failure: the thrown message never contains the token,
      // exercising the `err.message === safeMessage ? err : ...` pass-through.
      const throwingFetch = (async () => {
        throw new Error("ECONNREFUSED 10.0.0.1:4318");
      }) as unknown as typeof fetch;
      const exp = attachSplunkExporter(bus, {
        realm: "us0",
        accessToken: "sf-secret-leakable12345",
        fetchImpl: throwingFetch,
        flushIntervalMs: 0,
      });
      publishTurnPair(bus);
      await exp.flush();
      await exp.shutdown();
    } finally {
      spy.mockRestore();
    }
    const splunkLines = writes.filter((w) => w.includes("[exporter-splunk] export failed:"));
    expect(splunkLines.length).toBeGreaterThan(0);
    expect(splunkLines.some((l) => l.includes("ECONNREFUSED"))).toBe(true);
  });
});

describe("wrapFetchWithSplunkAttrs — fetch-wrapper edge cases", () => {
  test("returns the base fetch unchanged when neither index nor source is set", () => {
    const base = (async () => new Response("ok")) as unknown as typeof fetch;
    const wrapped = _wrapFetchWithSplunkAttrsForTest(base, {});
    expect(wrapped).toBe(base);
  });

  test("falls through to base fetch when the body is not valid JSON", async () => {
    const seen: Array<{ input: unknown; init?: RequestInit }> = [];
    const base = (async (input: unknown, init?: RequestInit) => {
      seen.push({ input, init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const wrapped = _wrapFetchWithSplunkAttrsForTest(base, { index: "main" });
    const badBody = "{not json";
    const res = await wrapped("https://ingest.us0.signalfx.com/v2/trace/otlp/v1/traces", {
      method: "POST",
      body: badBody,
    });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
    // On parse failure the wrapper must forward the *original* init untouched.
    expect(seen[0]?.init?.body).toBe(badBody);
  });

  test("falls through when the parsed body has no resourceSpans array", async () => {
    const seen: Array<{ init?: RequestInit }> = [];
    const base = (async (_input: unknown, init?: RequestInit) => {
      seen.push({ init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const wrapped = _wrapFetchWithSplunkAttrsForTest(base, { source: "fleet" });
    const body = JSON.stringify({ somethingElse: true });
    await wrapped("https://example/v1/traces", { method: "POST", body });
    expect(seen.length).toBe(1);
    // No resourceSpans → untouched passthrough (no re-serialization).
    expect(seen[0]?.init?.body).toBe(body);
  });

  test("forwards requests with non-string bodies to the base fetch verbatim", async () => {
    const seen: Array<{ init?: RequestInit }> = [];
    const base = (async (_input: unknown, init?: RequestInit) => {
      seen.push({ init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const wrapped = _wrapFetchWithSplunkAttrsForTest(base, { index: "main" });
    await wrapped("https://example/v1/traces", { method: "GET" });
    expect(seen.length).toBe(1);
    expect(seen[0]?.init?.method).toBe("GET");
  });

  test("appends splunk.index onto pre-existing resource attributes", async () => {
    const seen: Array<{ init?: RequestInit }> = [];
    const base = (async (_input: unknown, init?: RequestInit) => {
      seen.push({ init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const wrapped = _wrapFetchWithSplunkAttrsForTest(base, { index: "main" });
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "crewhaus" } }],
          },
          scopeSpans: [],
        },
      ],
    });
    await wrapped("https://example/v1/traces", { method: "POST", body });
    const sentBody = seen[0]?.init?.body;
    expect(typeof sentBody).toBe("string");
    const parsed = JSON.parse(sentBody as string);
    const attrs = parsed.resourceSpans[0].resource.attributes;
    const keys = attrs.map((a: { key: string }) => a.key);
    expect(keys).toEqual(["service.name", "splunk.index"]);
  });

  test("synthesizes a resource.attributes array when the span has none", async () => {
    const seen: Array<{ init?: RequestInit }> = [];
    const base = (async (_input: unknown, init?: RequestInit) => {
      seen.push({ init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const wrapped = _wrapFetchWithSplunkAttrsForTest(base, { source: "fleet" });
    const body = JSON.stringify({ resourceSpans: [{ scopeSpans: [] }] });
    await wrapped("https://example/v1/traces", { method: "POST", body });
    const parsed = JSON.parse(seen[0]?.init?.body as string);
    const attrs = parsed.resourceSpans[0].resource.attributes;
    expect(attrs).toEqual([{ key: "splunk.source", value: { stringValue: "fleet" } }]);
  });
});
