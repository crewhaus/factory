# Recipe 27 — Federation

Make a sub-agent call across deployment boundaries. Agent A in your
deployment can transparently call role X in deployment B over mTLS,
with cert pinning, version-locked envelopes, traceparent propagation
so OpenTelemetry stitches one trace across both, and a recovery
taxonomy that classifies federation errors as retry / tombstone / fail.

You'd reach for federation when:

- Roles need to run on **different hosts** for security, geographic,
  or organizational reasons.
- You're integrating with **another team's agent** that's deployed
  separately.
- You want a **trust boundary** between roles — cert pinning ensures
  Deployment B can verify Deployment A.

For roles in the same deployment, use [crew](04-multi-agent-crew.md).
For isolated children that share no context, use [sub-agents](28-sub-agents-and-task.md).
Federation is **crew handoff that crosses a deployment boundary**.

## Prerequisites

- [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md) — federation
  is the cross-host version.
- A second deployment (or a docker-compose fixture) to call out to.

## The federation envelope

The bytes on the wire:

```json
{
  "version": "crewhaus.federation.v1",
  "kind": "role-call",
  "from": "deployment-a",
  "to": "deployment-b",
  "fromRole": "researcher",
  "toRole": "code-reviewer",
  "payload": "Review this diff: ...",
  "traceparent": "00-abc123...-def456-01",
  "federation": {
    "from": "deployment-a",
    "to": "deployment-b",
    "mtls": {
      "client_cert_subject": "CN=deployment-a, O=crewhaus"
    }
  }
}
```

The `version` field is **strict** — receiver requires exact match.
Version mismatch (e.g. v1 caller, v2 receiver) fails closed. This
forces a deliberate dual-deploy when the protocol changes; there is
no silent fallback.

## Transport: mTLS over HTTPS

Federation uses standard HTTPS POST with **mutual TLS**:

- **Caller** presents its client cert when initiating the connection.
- **Receiver** presents its server cert.
- Both **pin** the other's leaf certificate (not just chain validity).

### Credential validation

Before the network call, `validateCredentials()` walks the local
keypair:

1. PEM shape matches `-----BEGIN CERTIFICATE-----` etc.
2. Parses the cert + key successfully.
3. Cert's `notAfter` is in the future.
4. Cert's subject matches what we expect to present.

Any of these failing aborts the call **before** the network round-trip.
So a missing or expired client cert produces a clear local error
rather than a confusing TLS error from the peer.

### Cert pinning

The pin is checked in `https.request`'s `checkServerIdentity`
callback:

```typescript
checkServerIdentity: (host, cert) => {
  const fingerprint = sha256(cert.raw);
  if (fingerprint !== peer.expectedFingerprint) {
    return new Error(`cert fingerprint mismatch: expected ${peer.expectedFingerprint}, got ${fingerprint}`);
  }
  return undefined;
}
```

Any other cert (even one chaining to the same CA) is rejected. This
catches:

- A new cert issued by your CA to an attacker who compromised the CA.
- A man-in-the-middle with a different but valid cert.
- A cert rotation that didn't go through the pin-update workflow.

Pin updates require a deliberate config change. There is no
automatic rotation that "just works" — the operator must
deliberately accept the new fingerprint.

## Discovery

How does Deployment A find Deployment B's URL + fingerprint?
`discoverDeployment(deployment, opts)` chains:

1. **DNS SRV.** Look up `_crewhaus._tcp.<deployment>.<domain>`.
   Returns `host:port`.
2. **`.well-known/crewhaus.json`.** Fetch
   `https://<host>:<port>/.well-known/crewhaus.json`, which returns:

   ```json
   {
     "version": "crewhaus.discovery.v1",
     "publicKey": "ed25519:...",
     "fingerprint": "sha256:abc...",
     "endpoints": {
       "federation": "https://<host>:<port>/federation"
     }
   }
   ```

3. The fingerprint pinning happens against this value (if matched
   against a local pin file).

### TTL caching

Successful discoveries cache for 60 seconds; negative responses
(SRV not found, well-known 404) cache for 10 seconds. Without this,
a misconfigured peer would trigger a DNS storm under load.

`crewhaus federation discover <deployment>` from the CLI prints the
discovery result with cache status:

```
deployment-b   host: bot-b.example.com:8443
               fingerprint: sha256:abc...
               cache: hit (age=42s)
```

## The router — making a call

```typescript
const router = createFederationRouter({
  fromDeployment: "deployment-a",
  clientCert: process.env.CREWHAUS_FED_CLIENT_CERT,
  clientKey: process.env.CREWHAUS_FED_CLIENT_KEY,
  pinFile: ".crewhaus/federation/pins.json",
});

const result = await router.call({
  fromRole: "researcher",
  to: { deployment: "deployment-b", role: "code-reviewer" },
  payload: "Review the diff for SQL injection.",
  kind: "role-call"
});

console.log(result.reply);
```

What happens:

1. Validate local credentials.
2. Discover deployment-b (with cache).
3. Assert discovered fingerprint matches `pins.json`.
4. Build the envelope (with the caller's traceparent).
5. POST over mTLS, pinned.
6. Decode `{ reply }` from the response.

The router emits trace events at each step (`federation_discover`,
`federation_call_start`, `federation_call_end`, `federation_call_error`)
so OpenTelemetry shows the cross-deployment flow in one trace.

## traceparent propagation

The W3C `traceparent` header propagates through the envelope's
`traceparent` field. When deployment-b receives the call, it picks
up the trace context and emits its spans as children of the caller's
span. The resulting trace shows:

```
deployment-a: agent run
└─ deployment-a: federation call to deployment-b
   └─ deployment-b: role activation (code-reviewer)
      └─ deployment-b: tool call (Read)
      └─ deployment-b: tool call (Grep)
```

One trace, two deployments. Both deployments need OTel exporters
pointing at the same Jaeger / Tempo backend for the trace to render
as a unified tree.

## Error classification

The recovery engine maps federation errors to actions:

| Error                                    | Class       | Action                                            |
| ---------------------------------------- | ----------- | ------------------------------------------------- |
| Network error / timeout                  | `retry`     | Re-call after exponential backoff.                |
| TLS error (cert mismatch, expired)       | `tombstone` | Mark the peer dead; don't retry until operator intervenes. |
| 5xx from peer                            | `retry`     | Re-call after backoff.                            |
| 4xx from peer (auth, bad request)        | `tombstone` | Caller error; retry won't help.                   |
| Unknown                                  | `fail`      | Surface the error; let the agent handle it.       |

Tombstones unblock by setting `federation.tombstones.<deployment>` =
false in `.crewhaus/federation/state.json` (CLI: `crewhaus federation
unmark <deployment>`).

## Spec integration

For a CLI agent that federates out:

```yaml
# CLI spec fragment that uses federation:
agent:
  model: claude-sonnet-4-6
  instructions: |
    For code reviews, call code-reviewer@deployment-b via the
    FederationCall tool.
tools:
  - federationCall
```

The `FederationCall` tool (wired by `federation-router`) takes
`{ deployment, role, payload }` and returns the peer's reply.

For receiving federated calls, the daemon must opt in. Channel /
managed daemons expose `/federation` automatically when
`channels.federation.enabled: true` and the cert files are present.

## A two-deployment fixture

```bash
bun run smoke:section-34
```

The smoke spins up two in-process deployments (no Docker), generates
fresh mTLS certs, pins them to each other, and runs a researcher
in deployment-a that calls a code-reviewer in deployment-b. Three
endpoints validated:

1. Discovery (the inner in-memory DNS).
2. mTLS handshake with the pinned fingerprint.
3. End-to-end role-call with traceparent propagation.

The full Docker-compose fixture (cross-host certs, real DNS) is gated
behind `CREWHAUS_FEDERATION_LIVE=1` and is a TODO for the cross-host
pilot ([`examples/hello-federation/README.md`](../../examples/hello-federation/README.md)).

## Boundary classification

Every federated call's `reply` is **untrusted external content**.
The receiver classifies it via `classifyBoundary(reply, { origin:
"federation" })` before the reply reaches the caller's model
([Recipe 41 — Security Fabric](41-security-fabric.md)).

A malicious deployment-b can't slip prompt injections into
deployment-a's model context without the classifier seeing them.

## Operational checklist

- **Pin files in version control.** `.crewhaus/federation/pins.json`
  belongs in the repo, signed in CI if you can. Pin changes need
  review like any security-sensitive config.
- **Rotate certs deliberately.** Two-week notice; coordinated; CR
  updates `pins.json` on every caller.
- **Tombstones page.** A tombstone is a security signal — page when
  one fires, even if the system is otherwise healthy.
- **Monitor `federation_call_latency_p95`.** Cross-deployment calls
  are slower than in-process. A regression suggests routing issues.

## Things that look like federation but aren't

| Symptom                                                              | Better tool                                       |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| Roles in the same deployment.                                        | [Crew](04-multi-agent-crew.md)                    |
| Need an isolated child that can't see parent context.                | [Sub-agents](28-sub-agents-and-task.md)           |
| Need to call an arbitrary HTTP service.                               | A `Fetch` tool with the right allow-list           |
| Need to deploy across regions for **latency**, not security.         | A regional load balancer in front of one deployment |

## What to read next

- **Crew (the in-deployment version).** [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md).
- **Multi-tenant gateways behind federation.** [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- **Audit trails of federated calls.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- **Trust-boundary classification.** [Recipe 41 — Security Fabric](41-security-fabric.md).

## Pointers to source

- **Protocol:** [`packages/federation-protocol`](../../packages/federation-protocol).
- **Discovery:** [`packages/federation-discovery`](../../packages/federation-discovery).
- **Router:** [`packages/federation-router`](../../packages/federation-router).
- **Fixture:** [`examples/hello-federation/README.md`](../../examples/hello-federation/README.md).
- **Module catalog reference:** §34 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
