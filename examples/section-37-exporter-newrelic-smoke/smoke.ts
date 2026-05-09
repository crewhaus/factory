#!/usr/bin/env bun
/**
 * Section 37 exporter-newrelic smoke. Closes out §37. Probes A-E
 * mirror the §37 datadog smoke. Live probe gated on
 * CREWHAUS_SECTION37_LIVE_NR=1 + NEW_RELIC_LICENSE_KEY.
 */
import {
  NR_DEFAULT_ENDPOINT_EU,
  NR_DEFAULT_ENDPOINT_US,
  attachNewRelicExporter,
  attachNewRelicIfEnvSet,
} from "@crewhaus/exporter-newrelic";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";

const log = (s: string) => process.stdout.write(`[section-37-newrelic] ${s}\n`);
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

// ── Probe A: header injection + region routing ────────────────────────────
log("probe A: api-key header + US default + EU regional endpoint");
{
  const bus = new TraceEventBus({ runId: "smoke_a", sessionId: "sess_a" });
  const { fetch, calls } = captureFetch();
  const exp = attachNewRelicExporter(bus, {
    licenseKey: "nr-smoke-license-1234567890",
    fetchImpl: fetch,
    flushIntervalMs: 0,
  });
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 50 });
  await exp.flush();
  await exp.shutdown();
  check("at least one fetch call", calls.length > 0);
  check("api-key header set", calls[0]?.headers["api-key"] === "nr-smoke-license-1234567890");
  check("US default endpoint", calls[0]?.url === NR_DEFAULT_ENDPOINT_US);
}
{
  const bus = new TraceEventBus({ runId: "smoke_a2", sessionId: "sess_a2" });
  const { fetch, calls } = captureFetch();
  const exp = attachNewRelicExporter(bus, {
    licenseKey: "nr-smoke-license-1234567890",
    region: "EU",
    fetchImpl: fetch,
    flushIntervalMs: 0,
  });
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 50 });
  await exp.flush();
  await exp.shutdown();
  check("EU regional endpoint", calls[0]?.url === NR_DEFAULT_ENDPOINT_EU);
}

// ── Probe B: 5 model_response events round-trip ───────────────────────────
log("probe B: 5 model_response events round-trip + entity.guid");
{
  const bus = new TraceEventBus({ runId: "smoke_b", sessionId: "sess_b" });
  const { fetch, calls } = captureFetch();
  const exp = attachNewRelicExporter(bus, {
    licenseKey: "nr-smoke-license-1234567890",
    entityGuid: "MTIzNDU2N3xBUE18QVBQTElDQVRJT058MTIzNDU2",
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
  let foundEntityGuid = false;
  for (const c of calls) {
    const body = JSON.parse(c.body);
    for (const rs of body.resourceSpans ?? []) {
      const attrs = rs.resource?.attributes ?? [];
      for (const a of attrs) {
        if (a.key === "entity.guid") foundEntityGuid = true;
      }
      for (const ss of rs.scopeSpans ?? []) {
        totalSpans += (ss.spans ?? []).length;
      }
    }
  }
  check(`5 model spans flushed (got ${totalSpans})`, totalSpans === 5);
  check("entity.guid attr present in payload", foundEntityGuid);
}

// ── Probe C: T8 credential-leak guard ─────────────────────────────────────
log("probe C: T8 — credential-leak guard");
{
  const bus = new TraceEventBus({ runId: "smoke_c", sessionId: "sess_c" });
  const licenseKey = "nr-secret-leakable12345";
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
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 10 });
  await exp.flush();
  await exp.shutdown();
  check("error captured", captured.length > 0);
  const msgs = captured.map((e) => e.message);
  check(
    "license key NEVER appears in error message",
    msgs.every((m) => !m.includes(licenseKey)),
  );
  check(
    "redaction marker [REDACTED:NEW_RELIC_LICENSE_KEY] present",
    msgs.some((m) => m.includes("[REDACTED:NEW_RELIC_LICENSE_KEY]")),
  );
}

// ── Probe D: env-gated attachment ─────────────────────────────────────────
log("probe D: attachNewRelicIfEnvSet env gating");
{
  const bus1 = new TraceEventBus({ runId: "smoke_d1", sessionId: "sess_d1" });
  const bus2 = new TraceEventBus({ runId: "smoke_d2", sessionId: "sess_d2" });
  const bus3 = new TraceEventBus({ runId: "smoke_d3", sessionId: "sess_d3" });
  const noEnv = attachNewRelicIfEnvSet(bus1, {});
  const fullKey = attachNewRelicIfEnvSet(bus2, { NEW_RELIC_LICENSE_KEY: "nr-test-1234567890" });
  const fallback = attachNewRelicIfEnvSet(bus3, { NR_LICENSE_KEY: "nr-test-1234567890" });
  check("no env → undefined", noEnv === undefined);
  check("NEW_RELIC_LICENSE_KEY set → attached", fullKey !== undefined);
  check("NR_LICENSE_KEY fallback → attached", fallback !== undefined);
  await fullKey?.shutdown();
  await fallback?.shutdown();
}

// ── Probe E: live probe ───────────────────────────────────────────────────
const liveProbe =
  process.env["CREWHAUS_SECTION37_LIVE_NR"] === "1" &&
  Boolean(process.env["NEW_RELIC_LICENSE_KEY"] ?? process.env["NR_LICENSE_KEY"]);
log(`probe E: live New Relic probe (gate=${liveProbe ? "on" : "off"})`);
if (liveProbe) {
  const bus = new TraceEventBus({ runId: "smoke_e", sessionId: "sess_e" });
  const exp = attachNewRelicExporter(bus, {
    licenseKey: (process.env["NEW_RELIC_LICENSE_KEY"] ?? process.env["NR_LICENSE_KEY"]) as string,
    region: process.env["NEW_RELIC_REGION"] === "EU" ? "EU" : "US",
    flushIntervalMs: 0,
  });
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 10 });
  try {
    await exp.flush();
    log("  ⓘ probe sent (New Relic returns 202 on accepted)");
  } catch (err) {
    log(`  ✗ live probe failed: ${(err as Error).message}`);
    failed += 1;
  }
  await exp.shutdown();
} else {
  log("  ⓘ skipped (set CREWHAUS_SECTION37_LIVE_NR=1 + NEW_RELIC_LICENSE_KEY)");
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
