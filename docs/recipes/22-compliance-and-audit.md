# Recipe 22 — Compliance and Audit

> **Status:** stub.

## What you'll learn

Use the hash-chained audit log as the substrate for SOC 2 Type II,
ISO 27001, and HIPAA evidence collection. Define which audit records
prove which controls, run a periodic collector, and ship signed
evidence bundles to your auditor.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for the audit-log substrate.
- [Recipe 17 — Observability](17-observability.md) for the trace event taxonomy.

## Roadmap

1. The audit log: append-only JSONL per tenant per day, mode 0o600, hash-chained (`prevHash` per line).
2. `crewhaus audit verify <tenant>` — re-walk the chain, report the first broken link.
3. `ControlDefinition` shape: `{ frameworkId, controlId, description, evidenceQueries }`.
4. The collector — walks the audit log per control, gathers matching records, writes an `EvidenceBundle` to `.crewhaus/compliance/<framework>/<controlId>/<period>.json`.
5. Bundle integrity: `digest = sha256(record.hash | record.hash | …)`, optional HMAC `signature` over the digest.
6. Built-in framework definitions: SOC 2 Type II CC6.1 / CC6.7 / CC7.2 / CC7.3, ISO 27001 A.12.4, HIPAA §164.312(b).
7. The CLI: `crewhaus compliance evidence --framework soc2 --period 2026-Q2 [--control CC6.1] [--audit-dir <d>] [--signing-key-env <ENV>]`.
8. Path-traversal refusal on framework / control / period names.
9. Worked example: producing the quarterly evidence package an external auditor can verify.

## Run it now

```bash
bun run smoke:section-39-compliance
bun apps/cli/src/index.ts compliance evidence --framework soc2 --period 2026-Q2
```

## Pointers to existing material

- **Modules:** [`packages/audit-log`](../../packages/audit-log), [`packages/compliance-controls`](../../packages/compliance-controls).
- **Catalog:** §20 (audit-log), §39 (compliance-controls).

## Where to go next

- For PII redaction inside audited payloads → [Recipe 23 — PII Redaction and Encryption](23-pii-redaction-and-encryption.md).
- For data-retention windows that prevent premature deletion of audit records → §39 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
- For canary-gated rollouts whose decisions land in the audit log → [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
