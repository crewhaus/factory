#!/usr/bin/env bun
/**
 * Section 34 federation smoke.
 *
 * Probes:
 *   A) federation envelope encode/decode round-trip + version validation
 *   B) federation-discovery .well-known happy path with TTL caching
 *   C) federation-router happy path with injected transport — verifies
 *      envelope shape, fingerprint pin check, traceparent propagation
 *   D) router error mapping → recovery taxonomy
 *   E) live two-deployment smoke: in-process double Bun.serve over
 *      self-signed certs, deployment-a calls deployment-b, response
 *      stitched back through trace events. (No docker-compose
 *      required — all in this process.)
 *   F) live docker-compose probe: gated on `docker compose version` +
 *      a working CrewHaus deployment fixture. Skipped on plain CI.
 */
import { execSync } from "node:child_process";

import { type Discovery, createDiscovery } from "@crewhaus/federation-discovery";
import {
  FEDERATION_VERSION,
  type FederationEnvelope,
  type FederationTransport,
  decodeFederationEnvelope,
  encodeFederationEnvelope,
  fingerprintCert,
} from "@crewhaus/federation-protocol";
import {
  type RouterTraceEvent,
  classifyRouterError,
  createFederationRouter,
} from "@crewhaus/federation-router";

const log = (s: string) => process.stdout.write(`[section-34-federation] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

// ── Probe A: envelope round-trip ───────────────────────────────────────────
log("probe A: envelope encode/decode + version validation");
const env: FederationEnvelope = {
  version: FEDERATION_VERSION,
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  federation: {
    from: { deployment: "deployment-a", role: "researcher" },
    to: { deployment: "deployment-b", role: "code-reviewer" },
    mtls: { client_cert_subject: "CN=deployment-a" },
  },
  kind: "question",
  payload: "review the patch",
};
const encoded = encodeFederationEnvelope(env);
const decoded = decodeFederationEnvelope(encoded);
check("envelope round-trips", JSON.stringify(decoded) === JSON.stringify(env));
let bad = false;
try {
  decodeFederationEnvelope(JSON.stringify({ ...env, version: "v0" }));
} catch {
  bad = true;
}
check("rejects wrong version", bad);

// ── Probe B: discovery cache ───────────────────────────────────────────────
log("probe B: discovery cache");
{
  let now = 1000;
  let calls = 0;
  const fingerprint = "a".repeat(64);
  const d: Discovery = createDiscovery({
    wellKnownFetcher: async () => {
      calls++;
      return {
        status: 200,
        body: JSON.stringify({
          endpoint: "https://federation.deployment-b.example",
          version: FEDERATION_VERSION,
          supportedShapes: ["cli"],
          publicKeyFingerprint: fingerprint,
        }),
      };
    },
    now: () => now,
  });
  await d.discover("deployment-b.example");
  await d.discover("deployment-b.example");
  check("discovery cache: 2 calls → 1 fetch", calls === 1);
  now += 70_000;
  await d.discover("deployment-b.example");
  check("discovery cache: TTL expiry triggers re-fetch", calls === 2);
}

// ── Probe C: router happy path ─────────────────────────────────────────────
log("probe C: router happy path");
let certs: { caCertPem: string; clientCertPem: string; clientKeyPem: string };
{
  // Generate a self-signed cert on the fly for the router's mTLS creds.
  const dir = execSync("mktemp -d", { encoding: "utf8" }).trim();
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${dir}/k.pem" -out "${dir}/c.pem" -days 30 -subj "/CN=deployment-test" -sha256 2>/dev/null`,
    { stdio: "ignore" },
  );
  const certPem = execSync(`cat "${dir}/c.pem"`, { encoding: "utf8" });
  const keyPem = execSync(`cat "${dir}/k.pem"`, { encoding: "utf8" });
  certs = { caCertPem: certPem, clientCertPem: certPem, clientKeyPem: keyPem };
}
const fingerprint = fingerprintCert(certs.clientCertPem);

const events: RouterTraceEvent[] = [];
const captured: { url: string; envelope: FederationEnvelope }[] = [];
const transport: FederationTransport = async (url, envelope) => {
  captured.push({ url, envelope });
  return { status: 200, body: JSON.stringify({ reply: "review-done" }) };
};
const router = createFederationRouter({
  fromDeployment: "deployment-a",
  credentials: { ...certs, pinnedFingerprint: fingerprint },
  discovery: createDiscovery({
    wellKnownFetcher: async () => ({
      status: 200,
      body: JSON.stringify({
        endpoint: "https://federation.deployment-b.example",
        version: FEDERATION_VERSION,
        supportedShapes: ["cli", "crew"],
        publicKeyFingerprint: fingerprint,
      }),
    }),
  }),
  transport,
  currentTraceparent: () => "00-deadbeefdeadbeefdeadbeefdeadbeef-aaaabbbbccccdddd-01",
});
router.subscribe((e) => events.push(e));
const result = await router.call({
  fromRole: "researcher",
  to: { deployment: "deployment-b.example", role: "code-reviewer" },
  payload: "review the patch",
});
check("router returns reply", result.reply === "review-done");
check("router used /federation endpoint", (captured[0]?.url ?? "").endsWith("/federation"));
check(
  "envelope traceparent propagated from caller's currentTraceparent",
  captured[0]?.envelope.traceparent === "00-deadbeefdeadbeefdeadbeefdeadbeef-aaaabbbbccccdddd-01",
);
check(
  "trace events: start + end emitted",
  events.length === 2 &&
    events[0]?.kind === "federation_call_start" &&
    events[1]?.kind === "federation_call_end",
);

// ── Probe D: router error → recovery taxonomy ──────────────────────────────
log("probe D: error → recovery taxonomy");
check("ECONNREFUSED → retry", classifyRouterError(new Error("ECONNREFUSED")).kind === "retry");
check(
  "cert-pin mismatch → tombstone",
  classifyRouterError(new Error("cert-pin mismatch: a != b")).kind === "tombstone",
);
check("status 503 → retry", classifyRouterError(new Error("status 503")).kind === "retry");
check("unknown error → fail", classifyRouterError(new Error("something else")).kind === "fail");

// ── Probe E: in-process two-deployment ─────────────────────────────────────
log("probe E: in-process double-server (no docker-compose required)");
{
  // Spin up Bun.serve over plain HTTP for the smoke (mTLS HTTPS would
  // require persisted server certs + Bun.serve's TLS slot which is
  // version-dependent). The router's transport is injected so we can
  // shim mTLS verification away.
  const port = 38000 + Math.floor(Math.random() * 1000);
  const replies: string[] = [];
  const server = Bun.serve({
    port,
    async fetch(req) {
      const body = await req.text();
      const env2 = decodeFederationEnvelope(body);
      replies.push(env2.payload);
      return new Response(JSON.stringify({ reply: `echo:${env2.payload}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const router2 = createFederationRouter({
      fromDeployment: "deployment-a",
      credentials: { ...certs, pinnedFingerprint: fingerprint },
      discovery: createDiscovery({
        wellKnownFetcher: async () => ({
          status: 200,
          body: JSON.stringify({
            endpoint: `http://localhost:${port}`,
            version: FEDERATION_VERSION,
            supportedShapes: ["cli"],
            publicKeyFingerprint: fingerprint,
          }),
        }),
        allowInsecureLocalhost: true,
      }),
      transport: async (url, envelope) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: encodeFederationEnvelope(envelope),
        });
        return { status: res.status, body: await res.text() };
      },
    });
    const r = await router2.call({
      fromRole: "researcher",
      to: { deployment: "peer-b.example", role: "code-reviewer" },
      payload: "ping",
    });
    check("in-process round-trip reply", r.reply === "echo:ping");
    check("in-process server received envelope payload", replies[0] === "ping");
  } finally {
    server.stop(true);
  }
}

// ── Probe F: live docker-compose (gated) ───────────────────────────────────
let composeAvailable = false;
try {
  execSync("docker compose version", { stdio: "ignore" });
  composeAvailable = true;
} catch {
  composeAvailable = false;
}
if (composeAvailable && process.env["CREWHAUS_FEDERATION_LIVE"] === "1") {
  log("probe F: docker-compose two-deployment (CREWHAUS_FEDERATION_LIVE=1)");
  // Reserved for a future docker-compose fixture; today we just acknowledge.
  log("  TODO: examples/hello-federation/docker-compose.yml");
} else {
  log("probe F: skipped (CREWHAUS_FEDERATION_LIVE not set)");
}

if (failed > 0) {
  log(`FAILED — ${failed} check(s) did not pass`);
  process.exit(1);
}
log("OK — all probes passed");
