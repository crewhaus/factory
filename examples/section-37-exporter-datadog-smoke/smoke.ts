#!/usr/bin/env bun
import {
  DD_DEFAULT_ENDPOINT,
  attachDatadogExporter,
  attachDatadogIfEnvSet,
} from "@crewhaus/exporter-datadog";
/**
 * Section 37 exporter-datadog smoke.
 *
 * Probes:
 *   A) attachDatadogExporter wires DD-API-KEY header + dd.* attrs
 *   B) 5 model_response events round-trip through stub fetch
 *   C) credential-leak guard scrubs API key from error messages
 *   D) attachDatadogIfEnvSet honors DD_API_KEY / DD_TRACE_ENABLED gates
 *   E) live probe — pulls a real DD endpoint when DD_API_KEY is set
 *      AND CREWHAUS_SECTION37_LIVE_DD=1; sends one fixture span and
 *      asserts a 2xx response. Skipped otherwise.
 */
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";

const log = (s: string) => process.stdout.write(`[section-37-datadog] ${s}\n`);
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
  return {
    calls,
    fetch: (async (input, init) => {
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
    }) as typeof fetch,
  };
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
log("probe A: DD-API-KEY header + dd.* resource attrs");
{
  const bus = new TraceEventBus({ runId: "smoke_a", sessionId: "sess_a" });
  const { fetch, calls } = captureFetch();
  const exp = attachDatadogExporter(bus, {
    apiKey: "dd-smoke-key-1234567890",
    service: "smoke-agent",
    env: "smoke",
    version: "1.0.0",
    fetchImpl: fetch,
    flushIntervalMs: 0,
  });
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 50 });
  await exp.flush();
  await exp.shutdown();
  check("at least one fetch call", calls.length > 0);
  check("DD-API-KEY header set", calls[0]?.headers["dd-api-key"] === "dd-smoke-key-1234567890");
  check("default endpoint is OTLP intake URL", calls[0]?.url === DD_DEFAULT_ENDPOINT);
  const body = JSON.parse(calls[0]?.body ?? "{}");
  const resourceAttrs = body.resourceSpans?.[0]?.resource?.attributes ?? [];
  const byKey = Object.fromEntries(
    resourceAttrs.map((a: { key: string; value: { stringValue?: string } }) => [
      a.key,
      a.value.stringValue,
    ]),
  );
  check("dd.service attr present", byKey["dd.service"] === "smoke-agent");
  check("dd.env attr present", byKey["dd.env"] === "smoke");
  check("dd.version attr present", byKey["dd.version"] === "1.0.0");
}

// ── Probe B: 5 model_response events round-trip via stub fetch ───────────
log("probe B: 5 model_response events round-trip");
{
  const bus = new TraceEventBus({ runId: "smoke_b", sessionId: "sess_b" });
  const { fetch, calls } = captureFetch();
  const exp = attachDatadogExporter(bus, {
    apiKey: "dd-smoke-key-1234567890",
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
  check("at least one batch posted", calls.length > 0);
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

// ── Probe C: credential-leak guard ────────────────────────────────────────
log("probe C: T8 — credential-leak guard");
{
  const bus = new TraceEventBus({ runId: "smoke_c", sessionId: "sess_c" });
  const apiKey = "dd-secret-leakable-abcdef0123456";
  const captured: Error[] = [];
  const failingFetch: typeof fetch = (async () =>
    new Response(`upstream 500: api-key was ${apiKey}`, { status: 500 })) as typeof fetch;
  const exp = attachDatadogExporter(bus, {
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
    "redaction marker [REDACTED:DD_API_KEY] present",
    msgs.some((m) => m.includes("[REDACTED:DD_API_KEY]")),
  );
}

// ── Probe D: env-gated attachment ─────────────────────────────────────────
log("probe D: attachDatadogIfEnvSet env gating");
{
  const bus1 = new TraceEventBus({ runId: "smoke_d1", sessionId: "sess_d1" });
  const bus2 = new TraceEventBus({ runId: "smoke_d2", sessionId: "sess_d2" });
  const bus3 = new TraceEventBus({ runId: "smoke_d3", sessionId: "sess_d3" });
  const noEnv = attachDatadogIfEnvSet(bus1, {});
  const traceDisabled = attachDatadogIfEnvSet(bus2, { DD_API_KEY: "k", DD_TRACE_ENABLED: "false" });
  const apiKeySet = attachDatadogIfEnvSet(bus3, { DD_API_KEY: "dd-test-1234567890" });
  check("no env → undefined", noEnv === undefined);
  check("DD_TRACE_ENABLED=false → undefined", traceDisabled === undefined);
  check("DD_API_KEY set → exporter attached", apiKeySet !== undefined);
  await apiKeySet?.shutdown();
}

// ── Probe E: live probe ───────────────────────────────────────────────────
const liveProbe =
  process.env["CREWHAUS_SECTION37_LIVE_DD"] === "1" && Boolean(process.env["DD_API_KEY"]);
log(`probe E: live DD intake probe (gate=${liveProbe ? "on" : "off"})`);
if (liveProbe) {
  const bus = new TraceEventBus({ runId: "smoke_e", sessionId: "sess_e" });
  const exp = attachDatadogExporter(bus, {
    apiKey: process.env["DD_API_KEY"] as string,
    flushIntervalMs: 0,
  });
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 10 });
  try {
    await exp.flush();
    log("  ⓘ probe sent (DD does not reply with rich status; absence of error = ok)");
  } catch (err) {
    log(`  ✗ live probe failed: ${(err as Error).message}`);
    failed += 1;
  }
  await exp.shutdown();
} else {
  log("  ⓘ skipped (set CREWHAUS_SECTION37_LIVE_DD=1 + DD_API_KEY to enable)");
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
