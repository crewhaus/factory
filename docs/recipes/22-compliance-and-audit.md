# Recipe 22 — Compliance and Audit

Use the hash-chained audit log as the substrate for SOC 2 Type II,
ISO 27001, and HIPAA evidence collection. Define which audit records
prove which controls, run a periodic collector, and ship signed
evidence bundles to your auditor.

You'd reach for this when:

- You're shipping to **regulated customers** that ask for SOC 2 or ISO
  27001 attestation.
- You need to **prove**, not just claim, that "every tool call is
  audited and tamper-proof".
- You want to **automate** the evidence-collection step of an audit
  rather than chasing engineers for screenshots.

For internal-use agents with no compliance ask, none of this is
necessary — the audit log still records, but the collector and
evidence bundles are skippable.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for
  the audit-log substrate.
- [Recipe 17 — Observability](17-observability.md) for the trace
  event taxonomy.

## The audit log substrate

Each tenant gets one JSONL file per day under
`<base>/audit/<tenant>/<yyyy-mm-dd>.jsonl`. Permissions: `0o600`. Each
line is one event with a `prevHash` field forming an immutable chain:

```json
{ "ts": "2026-05-11T08:00:00Z", "kind": "run_started", "runId": "r1", "prevHash": "0000..." }
{ "ts": "2026-05-11T08:00:01Z", "kind": "tool_use", "runId": "r1", "tool": "Bash", "prevHash": "abc1..." }
{ "ts": "2026-05-11T08:00:05Z", "kind": "permission_decision", "runId": "r1", "outcome": "allow", "prevHash": "def4..." }
{ "ts": "2026-05-11T08:00:08Z", "kind": "run_ended", "runId": "r1", "prevHash": "0234..." }
```

Verify:

```bash
crewhaus audit verify <tenant>
```

Re-walks every event, recomputes `sha256(prev event)`, and reports
the first broken link if any. Output:

```
audit verified: 4823 events across 7 segments, no broken links
```

or:

```
audit BROKEN at 2026-05-11/0042: expected prevHash abc1..., got def4...
```

A broken link is **proof of tampering**. The collector refuses to
build evidence bundles from a broken log.

## Control definitions

A `ControlDefinition` ties a framework requirement to audit-log
queries:

```typescript
{
  frameworkId: "soc2",
  controlId: "CC6.7",       // "The entity restricts the transmission, movement, and removal of information..."
  description: "Restrict permitted actions; audit denials.",
  evidenceQueries: [
    {
      name: "permission_denials",
      query: "kind == 'permission_decision' && outcome == 'deny'"
    },
    {
      name: "tool_uses_with_permission",
      query: "kind == 'tool_use' && permission == 'allow'"
    }
  ]
}
```

Definitions live in [`packages/compliance-controls`](../../packages/compliance-controls).
The query language is a small predicate dialect over the JSON event
shape — `==`, `!=`, `&&`, `||`, dotted-path reads.

## Built-in frameworks

Ships with definitions for:

| Framework      | Controls covered                                            |
| -------------- | ----------------------------------------------------------- |
| SOC 2 Type II  | CC6.1 (logical access), CC6.7 (transmission), CC7.2 (anomaly detection), CC7.3 (response) |
| ISO 27001      | A.12.4 (logging)                                             |
| HIPAA          | §164.312(b) (audit controls)                                 |

These are starting points — your auditor may map controls differently.
Add custom definitions in `<cwd>/.crewhaus/compliance-controls/<framework>.json`.

## The evidence collector

```bash
crewhaus compliance evidence --framework soc2 --period 2026-Q2
```

Walks every audited tenant for every SOC 2 control. For each control,
runs the `evidenceQueries` against the audit log, and produces:

```
.crewhaus/compliance/soc2/CC6.1/2026-Q2.json
.crewhaus/compliance/soc2/CC6.7/2026-Q2.json
.crewhaus/compliance/soc2/CC7.2/2026-Q2.json
.crewhaus/compliance/soc2/CC7.3/2026-Q2.json
```

Each `EvidenceBundle` JSON file:

```json
{
  "frameworkId": "soc2",
  "controlId": "CC6.7",
  "period": "2026-Q2",
  "collectedAt": "2026-07-01T00:00:00Z",
  "queries": [
    {
      "name": "permission_denials",
      "matchCount": 142,
      "records": [/* every matching audit record */]
    },
    {
      "name": "tool_uses_with_permission",
      "matchCount": 89421,
      "records": [/* first 1000; with truncation marker */]
    }
  ],
  "digest": "sha256:<hash of all record hashes>",
  "signature": "hmac:<HMAC of digest under signing key>"
}
```

The bundle is **self-verifying**: an auditor with the signing key's
public half can:

1. Recompute `digest = sha256(record.hash | record.hash | ...)`.
2. Check that the `digest` field matches.
3. Verify `signature` against `digest`.

If any step fails, the bundle is rejected as tampered.

## Producing a bundle

```bash
crewhaus compliance evidence \
  --framework soc2 \
  --period 2026-Q2 \
  --control CC6.7 \
  --audit-dir .crewhaus/audit \
  --signing-key-env COMPLIANCE_SIGNING_KEY
```

Flags:

| Flag                  | Default                | Purpose                                              |
| --------------------- | ---------------------- | ---------------------------------------------------- |
| `--framework`         | required               | `soc2`, `iso27001`, `hipaa`, or custom.              |
| `--period`            | required               | Time-bucket label (e.g. `2026-Q2`, `2026-05`).        |
| `--control`           | all                    | Restrict to one control id.                          |
| `--audit-dir`         | `.crewhaus/audit`      | Where to read audit logs.                            |
| `--signing-key-env`   | unset (no signature)   | Env var holding the HMAC signing key.                 |
| `--out-dir`           | `.crewhaus/compliance` | Where to write bundles.                              |

Names (`framework`, `control`, `period`) are validated against
`^[A-Za-z0-9_.-]+$` to prevent path-traversal — `../etc/passwd` and
friends are rejected.

## A worked quarterly cycle

```
T+0:        Quarter starts.
T+90d:      Quarter ends.
T+91d:      crewhaus compliance evidence --framework soc2 --period 2026-Q2
T+91d:      bundles written to .crewhaus/compliance/soc2/{CC6.1,CC6.7,CC7.2,CC7.3}/2026-Q2.json
T+92d:      Manual review of bundles for completeness.
T+95d:      Bundle handed to auditor (signed by your COMPLIANCE_SIGNING_KEY).
T+120d:     Auditor verifies bundles and either signs off or asks follow-up questions.
```

The runtime is one piece; the human review and auditor handoff are
the other pieces. Don't skip the review step — the collector tells
you **what evidence exists**; the human decides **whether the evidence
proves the control**.

## Path-traversal refusal

Every name argument is validated. Examples that get rejected:

```bash
crewhaus compliance evidence --framework ../etc --period 2026-Q2
# → error: framework name must match /^[A-Za-z0-9_.-]+$/

crewhaus compliance evidence --framework soc2 --period 2026-Q2/.. \
  --out-dir /tmp
# → error: period contains path-traversal characters
```

So a malicious or buggy CI script can't trick the collector into
overwriting an unrelated file.

## Data retention

Audit segments older than `auditRetentionDays` (default 2555 days = 7
years, per SOC 2 default) are NOT automatically deleted — the runtime
won't garbage-collect compliance evidence. To rotate, archive offline
or move to compliant cold storage.

To check retention compliance:

```bash
crewhaus audit retention-check
```

Reports the oldest audit segment per tenant and whether each tenant's
retention policy is met. Failing tenants need either older segments
restored from backup or a documented policy change.

## Things that look like audit but aren't

| Symptom                                                          | Better tool                                       |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| Want per-event metric (count, latency, cost).                    | [`trace-event-bus`](../../packages/trace-event-bus) + OTel exporter |
| Want a free-form search over events.                             | Pipe audit JSONL into Loki/Splunk/Elastic.        |
| Want to redact PII before audit captures it.                     | [Recipe 23 — PII Redaction](23-pii-redaction-and-encryption.md). |
| Want tamper-proof but **not** chain-verifiable.                  | Audit log + WORM storage (S3 Object Lock).        |

The audit log is **comprehensive, immutable, tenant-scoped, and
verifiable**. It's not a search engine — Splunk or Loki is.

## What to read next

- **PII inside audit payloads.** [Recipe 23 — PII Redaction and Encryption](23-pii-redaction-and-encryption.md).
- **Audit promotions and rollbacks.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- **The trace event substrate.** [Recipe 17 — Observability](17-observability.md).

## Pointers to source

- **Audit log:** [`packages/audit-log`](../../packages/audit-log).
- **Compliance controls:** [`packages/compliance-controls`](../../packages/compliance-controls).
- **Module catalog reference:** §20 (audit-log), §39 (compliance-controls) in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
