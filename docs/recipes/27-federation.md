# Recipe 27 — Federation

> **Status:** stub.

## What you'll learn

Make a sub-agent call across deployment boundaries — agent A in your
deployment can transparently call role X in deployment B over mTLS,
with cert pinning, version-locked envelopes, traceparent propagation
so OpenTelemetry stitches one trace across both, and a recovery
taxonomy that classifies federation errors as retry / tombstone / fail.

## Prerequisites

- [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md) — federation is "crew handoff that crosses a deployment boundary."
- A second deployment (or a docker-compose fixture) to call out to.

## Roadmap

1. The `FederationEnvelope` — extends the in-crew A2A envelope with `version: "crewhaus.federation.v1"` (strict — exact match required) and a `federation` block carrying `from / to / mtls.client_cert_subject`.
2. Transport: HTTPS POST with mutual TLS via `node:https`. `validateCredentials()` checks PEM shape + parses cert/key + asserts cert hasn't expired BEFORE the network call.
3. Cert pinning: pin the peer's leaf cert via `checkServerIdentity` callback — any other cert (even chaining to the same CA) is rejected.
4. Discovery: `discoverDeployment(deployment, opts)` chains DNS SRV (`_crewhaus._tcp.<deployment>.<domain>`) → `.well-known/crewhaus.json` HTTPS fetch.
5. TTL cache: 60 s positive, 10 s negative — a misconfigured peer doesn't trigger DNS storms.
6. The router: `createFederationRouter({...}).call({fromRole, to, payload, kind?})` discovers the peer, asserts the discovered fingerprint matches the local pin, builds the envelope (with the caller's traceparent), POSTs, decodes `{reply}`.
7. Error classification: network/timeout → `retry` with delay; cert/auth → `tombstone`; 5xx → `retry`; 4xx → `tombstone`; unknown → `fail`. Maps to the `recovery-engine` taxonomy.
8. Operational: `crewhaus federation discover <deployment>` from the CLI; subscribe to `federation_call_*` trace events for monitoring.

## Run it now

```bash
# In-process two-deployment smoke (no docker required):
bun run smoke:section-34
```

## Pointers to existing material

- **Modules:** [`packages/federation-protocol`](../../packages/federation-protocol), [`packages/federation-discovery`](../../packages/federation-discovery), [`packages/federation-router`](../../packages/federation-router).
- **Fixture:** [`examples/hello-federation/README.md`](../../examples/hello-federation/README.md).
- **Catalog:** §34.

## Where to go next

- For multi-tenant gateways behind federation → [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- For audit trails of federated calls → [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
