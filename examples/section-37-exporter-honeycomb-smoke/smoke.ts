#!/usr/bin/env bun
/**
 * Section 37 exporter-honeycomb smoke. Probes A-E mirror the §37
 * datadog smoke. Live probe gated on
 * CREWHAUS_SECTION37_LIVE_HC=1 + HONEYCOMB_API_KEY.
 */
import {
  HC_DEFAULT_API_HOST,
  attachHoneycombExporter,
  attachHoneycombIfEnvSet,
} from "@crewhaus/exporter-honeycomb";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";

const log = (s: string) => process.stdout.write(`[section-37-honeycomb] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

type Captured = { url: string; headers: Record<string, string>; body: string };
const captureFetch = (): { fetch: typeof fetch; calls: Captured[] } => {
  const calls: Captured[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    calls.push({
      url: typeof input === "string" ? input : (input as URL | Request).toString(),
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response("", { status: 200 });
  };
  return { fetch: f as unknown as typeof fetch, calls };
};

const eventEnv = (bus: TraceEventBus, overrides: Partial<TraceEvent> = {}) => ({
  runId: bus.runId,
  sessionId: bus.sessionId,
  turnNumber: 1,
  traceId: bus.traceId,
  spanId: bus.rootSpanId,
  timestamp: new Date().toISOString(),
  ...overrides,
});

// ── Probe A: header injection + endpoint routing ──────────────────────────
log("probe A: x-honeycomb-team header + dataset routing");
{
  const bus = new TraceEventBus({ runId: "smoke_a", sessionId: "sess_a" });
  const { fetch, calls } = captureFetch();
  const exp = attachHoneycombExporter(bus, {
    apiKey: "hc-smoke-key-1234567890",
    serviceName: "smoke-agent",
    dataset: "smoke-traces",
    fetchImpl: fetch,
    flushIntervalMs: 0,
  });
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 50 });
  await exp.flush();
  await exp.shutdown();
  check("at least one fetch call", calls.length > 0);
  check(
    "x-honeycomb-team header set",
    calls[0]?.headers["x-honeycomb-team"] === "hc-smoke-key-1234567890",
  );
  check(
    "x-honeycomb-dataset header set",
    calls[0]?.headers["x-honeycomb-dataset"] === "smoke-traces",
  );
  check(
    "default endpoint is api.honeycomb.io/v1/traces",
    calls[0]?.url === `${HC_DEFAULT_API_HOST}/v1/traces`,
  );
}

// ── Probe B: 5 model_response events round-trip ───────────────────────────
log("probe B: 5 model_response events round-trip");
{
  const bus = new TraceEventBus({ runId: "smoke_b", sessionId: "sess_b" });
  const { fetch, calls } = captureFetch();
  const exp = attachHoneycombExporter(bus, {
    apiKey: "hc-smoke-key-1234567890",
    fetchImpl: fetch,
    flushIntervalMs: 0,
  });
  for (let i = 0; i < 5; i++) {
    bus.publish({
      ...eventEnv(bus),
      kind: "model_request",
      model: "claude-opus-4-7",
      messageCount: 1,
      toolCount: 0,
      streaming: false,
    });
    bus.publish({
      ...eventEnv(bus),
      kind: "model_response",
      model: "claude-opus-4-7",
      stopReason: "end_turn",
      usage: { input: 100, output: 30 },
      durationMs: 800,
    });
  }
  await exp.flush();
  await exp.shutdown();
  let totalSpans = 0;
  for (const c of calls) {
    const body = JSON.parse(c.body);
    for (const rs of body.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        totalSpans += (ss.spans ?? []).length;
      }
    }
  }
  check(`5 model spans flushed (got ${totalSpans})`, totalSpans === 5);
}

// ── Probe C: T8 credential-leak guard ─────────────────────────────────────
log("probe C: T8 — credential-leak guard");
{
  const bus = new TraceEventBus({ runId: "smoke_c", sessionId: "sess_c" });
  const apiKey = "hc-secret-leakable-abcdef0";
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
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 10 });
  await exp.flush();
  await exp.shutdown();
  check("error captured", captured.length > 0);
  const msgs = captured.map((e) => e.message);
  check(
    "API key NEVER appears in error message",
    msgs.every((m) => !m.includes(apiKey)),
  );
  check(
    "redaction marker [REDACTED:HONEYCOMB_API_KEY] present",
    msgs.some((m) => m.includes("[REDACTED:HONEYCOMB_API_KEY]")),
  );
}

// ── Probe D: env-gated attachment ─────────────────────────────────────────
log("probe D: attachHoneycombIfEnvSet env gating");
{
  const bus1 = new TraceEventBus({ runId: "smoke_d1", sessionId: "sess_d1" });
  const bus2 = new TraceEventBus({ runId: "smoke_d2", sessionId: "sess_d2" });
  const noEnv = attachHoneycombIfEnvSet(bus1, {});
  const apiKeySet = attachHoneycombIfEnvSet(bus2, { HONEYCOMB_API_KEY: "hc-test-1234567890" });
  check("no env → undefined", noEnv === undefined);
  check("HONEYCOMB_API_KEY set → exporter attached", apiKeySet !== undefined);
  await apiKeySet?.shutdown();
}

// ── Probe E: live probe ───────────────────────────────────────────────────
const liveProbe =
  process.env["CREWHAUS_SECTION37_LIVE_HC"] === "1" && Boolean(process.env["HONEYCOMB_API_KEY"]);
log(`probe E: live Honeycomb probe (gate=${liveProbe ? "on" : "off"})`);
if (liveProbe) {
  const bus = new TraceEventBus({ runId: "smoke_e", sessionId: "sess_e" });
  const exp = attachHoneycombExporter(bus, {
    apiKey: process.env["HONEYCOMB_API_KEY"] as string,
    flushIntervalMs: 0,
  });
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 10 });
  try {
    await exp.flush();
    log("  ⓘ probe sent (Honeycomb returns 200 on accepted; absence of error = ok)");
  } catch (err) {
    log(`  ✗ live probe failed: ${(err as Error).message}`);
    failed += 1;
  }
  await exp.shutdown();
} else {
  log("  ⓘ skipped (set CREWHAUS_SECTION37_LIVE_HC=1 + HONEYCOMB_API_KEY to enable)");
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
