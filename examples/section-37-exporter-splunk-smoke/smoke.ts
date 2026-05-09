#!/usr/bin/env bun
/**
 * Section 37 exporter-splunk smoke. Probes A-E mirror the §37 datadog
 * smoke. Live probe gated on CREWHAUS_SECTION37_LIVE_SPLUNK=1 +
 * SPLUNK_REALM + SPLUNK_ACCESS_TOKEN.
 */
import {
  attachSplunkExporter,
  attachSplunkIfEnvSet,
  buildSplunkEndpoint,
} from "@crewhaus/exporter-splunk";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";

const log = (s: string) => process.stdout.write(`[section-37-splunk] ${s}\n`);
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

// ── Probe A: header injection + realm routing ─────────────────────────────
log("probe A: X-SF-TOKEN header + realm endpoint");
{
  const bus = new TraceEventBus({ runId: "smoke_a", sessionId: "sess_a" });
  const { fetch, calls } = captureFetch();
  const exp = attachSplunkExporter(bus, {
    realm: "us0",
    accessToken: "sf-smoke-token-1234567890",
    fetchImpl: fetch,
    flushIntervalMs: 0,
  });
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 50 });
  await exp.flush();
  await exp.shutdown();
  check("at least one fetch call", calls.length > 0);
  check("X-SF-TOKEN header set", calls[0]?.headers["x-sf-token"] === "sf-smoke-token-1234567890");
  check("realm-scoped endpoint", calls[0]?.url === `${buildSplunkEndpoint("us0")}/v1/traces`);
}

// ── Probe B: 5 model_response events round-trip ───────────────────────────
log("probe B: 5 model_response events round-trip");
{
  const bus = new TraceEventBus({ runId: "smoke_b", sessionId: "sess_b" });
  const { fetch, calls } = captureFetch();
  const exp = attachSplunkExporter(bus, {
    realm: "us0",
    accessToken: "sf-smoke-token-1234567890",
    index: "main",
    source: "crewhaus-runtime",
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
  let foundIndexAttr = false;
  for (const c of calls) {
    const body = JSON.parse(c.body);
    for (const rs of body.resourceSpans ?? []) {
      const attrs = rs.resource?.attributes ?? [];
      for (const a of attrs) {
        if (a.key === "splunk.index") foundIndexAttr = true;
      }
      for (const ss of rs.scopeSpans ?? []) {
        totalSpans += (ss.spans ?? []).length;
      }
    }
  }
  check(`5 model spans flushed (got ${totalSpans})`, totalSpans === 5);
  check("splunk.index attr present in payload", foundIndexAttr);
}

// ── Probe C: T8 credential-leak guard ─────────────────────────────────────
log("probe C: T8 — credential-leak guard");
{
  const bus = new TraceEventBus({ runId: "smoke_c", sessionId: "sess_c" });
  const accessToken = "sf-secret-leakable123";
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
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 10 });
  await exp.flush();
  await exp.shutdown();
  check("error captured", captured.length > 0);
  const msgs = captured.map((e) => e.message);
  check(
    "access token NEVER appears in error message",
    msgs.every((m) => !m.includes(accessToken)),
  );
  check(
    "redaction marker [REDACTED:SPLUNK_ACCESS_TOKEN] present",
    msgs.some((m) => m.includes("[REDACTED:SPLUNK_ACCESS_TOKEN]")),
  );
}

// ── Probe D: env-gated attachment ─────────────────────────────────────────
log("probe D: attachSplunkIfEnvSet env gating");
{
  const bus1 = new TraceEventBus({ runId: "smoke_d1", sessionId: "sess_d1" });
  const bus2 = new TraceEventBus({ runId: "smoke_d2", sessionId: "sess_d2" });
  const bus3 = new TraceEventBus({ runId: "smoke_d3", sessionId: "sess_d3" });
  const noEnv = attachSplunkIfEnvSet(bus1, {});
  const onlyRealm = attachSplunkIfEnvSet(bus2, { SPLUNK_REALM: "us0" });
  const both = attachSplunkIfEnvSet(bus3, {
    SPLUNK_REALM: "us0",
    SPLUNK_ACCESS_TOKEN: "sf-test-1234567890",
  });
  check("no env → undefined", noEnv === undefined);
  check("only realm → undefined", onlyRealm === undefined);
  check("realm + token → exporter attached", both !== undefined);
  await both?.shutdown();
}

// ── Probe E: live probe ───────────────────────────────────────────────────
const liveProbe =
  process.env["CREWHAUS_SECTION37_LIVE_SPLUNK"] === "1" &&
  Boolean(process.env["SPLUNK_REALM"]) &&
  Boolean(process.env["SPLUNK_ACCESS_TOKEN"]);
log(`probe E: live Splunk probe (gate=${liveProbe ? "on" : "off"})`);
if (liveProbe) {
  const bus = new TraceEventBus({ runId: "smoke_e", sessionId: "sess_e" });
  const exp = attachSplunkExporter(bus, {
    realm: process.env["SPLUNK_REALM"] as string,
    accessToken: process.env["SPLUNK_ACCESS_TOKEN"] as string,
    flushIntervalMs: 0,
  });
  bus.publish({ ...eventEnv(bus), kind: "turn_start", turn: 1, messageCount: 0 });
  bus.publish({ ...eventEnv(bus), kind: "turn_end", turn: 1, durationMs: 10 });
  try {
    await exp.flush();
    log("  ⓘ probe sent (Splunk returns 200 on accepted)");
  } catch (err) {
    log(`  ✗ live probe failed: ${(err as Error).message}`);
    failed += 1;
  }
  await exp.shutdown();
} else {
  log("  ⓘ skipped (set CREWHAUS_SECTION37_LIVE_SPLUNK=1 + SPLUNK_REALM + SPLUNK_ACCESS_TOKEN)");
}

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
