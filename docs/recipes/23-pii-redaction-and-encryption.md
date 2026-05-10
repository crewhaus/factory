# Recipe 23 — PII Redaction and Encryption

> **Status:** stub.

## What you'll learn

Compose three layers of PII defense over the audit log: detector-based
redaction (regex + classifier + per-tenant allow-list), envelope
encryption of audited payloads (AES-256-GCM with KEK→DEK wrapping that
auto-rotates with the secrets manager), and GDPR-shaped retention
windows that respect right-to-delete and right-to-export.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- [Recipe 20 — Secrets Management](20-secrets-management.md) for KEK rotation.

## Roadmap

1. PII detectors: 5 regex defaults (SSN, credit card, phone in US/E.164/UK/EU formats, email, IBAN); pluggable classifier; per-tenant policy allow-list.
2. Two redaction modes: `replace` (`[REDACTED:<kind>]`) and `hash` (HMAC-SHA256 → `[HASHED:<kind>:<hex>]`). Constructor refuses `mode="hash"` without a non-empty secret.
3. `redactObject` — walks string fields and string arrays for callers wiring this into `audit-log.append`.
4. Audit encryption: AES-256-GCM with 96-bit IVs both for DEK→payload and KEK→DEK wrapping; per-tenant DEKs.
5. KEK rotation: auto-subscribes to `secrets.onRotation` so a Vault KEK rotation fires `rotateKek` automatically.
6. Tamper detection: GCM authentication catches changes to encryptedPayload / iv / tag / wrappedDek.
7. Retention engine: `retain(tenantId, kind, durationDays)` (longer-duration wins), `addAuditWindow(...)` (refuses already-expired windows).
8. GDPR operations: `purge(tenantId, opts)` (right-to-delete; honors retention + active audit windows), `export(tenantId, {format, kinds})` (right-to-export; JSON / NDJSON).
9. Cross-tenant guards at every layer.

## Run it now

```bash
bun run smoke:section-39-pii
bun run smoke:section-39-enc
bun run smoke:section-39-retention
```

## Pointers to existing material

- **Modules:** [`packages/pii-redactor`](../../packages/pii-redactor), [`packages/audit-encryption`](../../packages/audit-encryption), [`packages/data-retention-engine`](../../packages/data-retention-engine).
- **Catalog:** §39.

## Where to go next

- For evidence collection that ships these audit records to your auditor → [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- For secret rotation that drives KEK rotation → [Recipe 20 — Secrets Management](20-secrets-management.md).
