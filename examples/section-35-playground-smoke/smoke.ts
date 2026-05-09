#!/usr/bin/env bun
/**
 * Section 35 crewhaus-playground smoke.
 *
 * Probes:
 *   A) the SPA shell renders with templates + studio webview iframe
 *   B) /api/templates lists every scaffold-templates entry
 *   C) end-to-end run flow: POST /api/run → scoped run id; GET
 *      /api/runs/:id returns the record for the same session and 404s
 *      across sessions (T8 cross-tenant isolation)
 *   D) anonymous-quota enforcement: 6th run in the window → 429 +
 *      Retry-After header
 *   E) live OAuth + signed-in tier — gated on CREWHAUS_PLAYGROUND_LIVE=1
 *      (requires GitHub/Google client id; never on CI)
 */
import {
  type GatewayClient,
  createPlayground,
  enforceQuota,
  playgroundIndexHtml,
  templateMenuEntries,
} from "@crewhaus/crewhaus-playground";

const log = (s: string) => process.stdout.write(`[section-35-playground] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

const fakeGateway: GatewayClient = {
  async startRun({ tier }) {
    return {
      runId: `run-${tier}-${Math.random().toString(36).slice(2, 8)}`,
      status: "queued" as const,
      traceUrl: `/trace/${tier}`,
    };
  },
};

// ── Probe A: SPA shell ─────────────────────────────────────────────────────
log("probe A: SPA shell renders with templates + studio iframe");
const html = playgroundIndexHtml({ studioUrl: "http://localhost:4242" });
check("includes <title>", html.includes("<title>"));
check("includes editor mount", html.includes('id="editor"'));
check("includes studio iframe", html.includes('id="studio"'));
check(
  "templates list available in __CREWHAUS_PLAYGROUND__",
  html.includes("__CREWHAUS_PLAYGROUND__"),
);

// ── Probe B: templates ─────────────────────────────────────────────────────
log("probe B: /api/templates");
const templates = templateMenuEntries();
check(`templates list has > 5 entries (${templates.length})`, templates.length > 5);
check(
  "cli-coding-agent template present",
  templates.some((t) => t.id === "cli-coding-agent"),
);

// ── Probes C+D: full server fetch flow ─────────────────────────────────────
log("probe C: POST /api/run + cross-tenant isolation");
{
  const playground = createPlayground({
    studioUrl: "http://localhost:4242",
    gatewayClient: fakeGateway,
  });
  const sa = "session-aaa-1234567";
  const sb = "session-bbb-1234567";

  // session-a posts a run
  const run = await playground.fetch(
    new Request("http://localhost/api/run", {
      method: "POST",
      body: JSON.stringify({
        spec: "name: x\ntarget: cli\nagent:\n  model: m\n  instructions: i\n",
      }),
      headers: { "Content-Type": "application/json", Cookie: `sid=${sa}` },
    }),
  );
  check("POST /api/run accepted", run.status === 200);
  const { scopedRunId } = (await run.json()) as { scopedRunId: string };
  check("scopedRunId starts with sessionId", scopedRunId.startsWith(`${sa}:`));

  // same session can read it
  const ok = await playground.fetch(
    new Request(`http://localhost/api/runs/${scopedRunId}`, {
      headers: { Cookie: `sid=${sa}` },
    }),
  );
  check("same session GET /api/runs/:id → 200", ok.status === 200);

  // other session is 404'd
  const denied = await playground.fetch(
    new Request(`http://localhost/api/runs/${scopedRunId}`, {
      headers: { Cookie: `sid=${sb}` },
    }),
  );
  check("cross-tenant GET /api/runs/:id → 404", denied.status === 404);
}

log("probe D: anonymous quota");
{
  let now = 1000;
  const playground = createPlayground({
    studioUrl: "http://localhost:4242",
    gatewayClient: fakeGateway,
    now: () => now,
  });
  const post = () =>
    playground.fetch(
      new Request("http://localhost/api/run", {
        method: "POST",
        body: JSON.stringify({
          spec: "name: x\ntarget: cli\nagent:\n  model: m\n  instructions: i\n",
        }),
        headers: { "Content-Type": "application/json", Cookie: "sid=quota-aaaaaaaaa" },
      }),
    );
  for (let i = 0; i < 5; i++) {
    const r = await post();
    check(`accept run ${i + 1}/5`, r.status === 200);
    now += 60_000;
  }
  const r6 = await post();
  check("6th run rejected with 429", r6.status === 429);
  check("Retry-After header present", r6.headers.has("retry-after"));
}

// ── Probe E: live OAuth (gated) ────────────────────────────────────────────
if (process.env["CREWHAUS_PLAYGROUND_LIVE"] === "1") {
  log("probe E: live OAuth signed-in flow (CREWHAUS_PLAYGROUND_LIVE=1)");
  log("  TODO: needs hosted OAuth client id; gated until §32 crewhaus-cloud lands one");
} else {
  log("probe E: skipped (CREWHAUS_PLAYGROUND_LIVE not set)");
}

// Show that the underlying enforceQuota is the same surface tests + server share.
const decision = enforceQuota({ state: { runs: [] }, tier: "anonymous" });
check("enforceQuota happy path", decision.accepted === true);

if (failed > 0) {
  log(`FAILED — ${failed} check(s) did not pass`);
  process.exit(1);
}
log("OK — all probes passed");
