# Recipe 23 — PII Redaction and Encryption

Compose three layers of PII defense over the audit log: detector-based
redaction (regex + classifier + per-tenant allow-list), envelope
encryption of audited payloads (AES-256-GCM with KEK → DEK wrapping
that auto-rotates with the secrets manager), and GDPR-shaped
retention windows that respect right-to-delete and right-to-export.

You'd reach for this when:

- Audit records will contain **personally identifiable information**
  — names, emails, SSNs, credit cards, customer IDs.
- Compliance requires **encrypted at rest** plus **provable
  redaction**.
- You're subject to **GDPR / CCPA right-to-delete and right-to-export**.

For internal-use, non-regulated workloads, the audit log alone is
fine — PII in audit lives in the same trust boundary as PII anywhere
else in the deployment.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for
  the audit-log substrate.
- [Recipe 20 — Secrets Management](20-secrets-management.md) for KEK
  rotation.

## Layer 1 — Detector-based redaction

[`packages/pii-redactor`](../../packages/pii-redactor) catches PII
before it lands in the audit log.

### Built-in detectors

| Kind          | Detector              | Example match                                |
| ------------- | --------------------- | -------------------------------------------- |
| `ssn`         | US Social Security    | `123-45-6789`                                 |
| `credit-card` | Luhn-validated PAN    | `4111-1111-1111-1111`                         |
| `phone`       | US / E.164 / UK / EU  | `+1 555-123-4567`, `+44 20 7946 0958`, ...    |
| `email`       | RFC-ish               | `alice@example.com`                           |
| `iban`        | IBAN structure check  | `GB29 NWBK 6016 1331 9268 19`                 |

Plus a pluggable LLM classifier slot for fuzzy detection (custom
patterns: customer IDs, internal account numbers, names in free text).

### Redaction modes

| Mode      | Replacement format                          | Reversible? |
| --------- | ------------------------------------------- | ----------- |
| `replace` | `[REDACTED:email]`, `[REDACTED:credit-card]` | No.         |
| `hash`    | `[HASHED:email:<hex>]`                       | No, but joinable (same input → same hash). |

`hash` mode requires a non-empty HMAC key (`new Redactor({ mode: "hash", secret })`).
The constructor refuses an empty secret to prevent accidental
plaintext hashing.

When to choose:

- **`replace`** — strongest privacy. The audit log can't be used to
  correlate users across records.
- **`hash`** — joinable but irreversible. Lets you ask "which records
  involved this user?" by hashing the email and joining, without the
  audit log carrying the plaintext.

### Walking objects

`redactObject(obj)` walks every string field and string-array element
in a JSON object:

```typescript
const r = new Redactor({ mode: "replace" });
const safe = r.redactObject(rawEvent);
// safe carries [REDACTED:email] wherever rawEvent had an email.
```

Wire it into the audit log's `append` path:

```typescript
auditLog.append(redactor.redactObject(event));
```

### Per-tenant allow-list

Some tenants legitimately need certain PII in audit (e.g. an
investigations app must keep email visible). Per-tenant policy:

```yaml
tenants:
  - id: tenant-a
    piiPolicy:
      redact: [credit-card, ssn]    # only these get redacted
      allow: [email]                  # email stays in plaintext
  - id: tenant-b
    piiPolicy:
      mode: hash                      # hash everything
      secret: $TENANT_B_PII_SECRET
```

When unset, the deployment-wide default applies. Tenant overrides are
always **stricter** in practice (you wouldn't reach for an override to
expose more PII to audit), but the runtime allows either direction.

## Layer 2 — Audit encryption

[`packages/audit-encryption`](../../packages/audit-encryption) wraps
the JSONL writer with envelope encryption: every record is encrypted
under a per-tenant DEK, which itself is wrapped under a deployment-wide
KEK.

### The crypto

- **DEK** — 256-bit AES key. Per-tenant.
- **KEK** — 256-bit AES key. Deployment-wide. Stored in
  `secrets-manager` ([Recipe 20](20-secrets-management.md)).
- **Wrapping** — KEK encrypts DEK via AES-256-GCM with a 96-bit random IV.
- **Payload** — DEK encrypts each audit record via AES-256-GCM with
  a 96-bit random IV.

Each encrypted record on disk:

```json
{
  "iv": "<base64 96-bit>",
  "tag": "<base64 GCM tag>",
  "wrappedDek": "<base64 KEK-wrapped DEK>",
  "kekVersion": 3,
  "encryptedPayload": "<base64 ciphertext>"
}
```

Reading inverts: load KEK version 3, unwrap DEK, decrypt payload.

### KEK rotation

The encryption layer subscribes to
`secrets.onRotation("CREWHAUS_AUDIT_KEK")`:

```bash
crewhaus secrets rotate CREWHAUS_AUDIT_KEK
```

On rotation:

1. The handler generates a new per-tenant DEK, wraps it under the
   new KEK.
2. New records use the new wrapped DEK and `kekVersion: N+1`.
3. Old records remain under the old KEK; the reader inspects
   `kekVersion` and uses the matching key.

So a rotated KEK encrypts only **new** records — old records stay
decryptable. To re-encrypt old records under the new KEK, run:

```bash
crewhaus audit reencrypt --since 2026-01-01
```

(Re-encryption is a big I/O operation; only run when the prior KEK is
genuinely compromised.)

### Tamper detection

AES-GCM's authentication tag catches changes to:

- `encryptedPayload` (the ciphertext itself).
- `iv` (the 96-bit nonce).
- `tag` (the GCM tag).
- `wrappedDek` (the KEK-wrapped DEK).

Any modification fails decryption with `bad-tag`. Combined with the
audit log's hash chain (Recipe 22), the security property is:

> The plaintext content of every audit record is verifiable as
> unchanged since write; the ordering and existence of records is
> verifiable as unchanged since write.

## Layer 3 — Retention windows

[`packages/data-retention-engine`](../../packages/data-retention-engine)
tracks per-tenant, per-kind retention requirements.

### Setting retention

```typescript
retention.retain("tenant-a", "audit", 2555);          // 7 years
retention.retain("tenant-a", "user_data", 365);        // 1 year
retention.retain("tenant-a", "session", 90);           // 90 days
```

**Longer-duration wins.** If a tenant has 90-day retention on `session`
and you call `retain("tenant-a", "session", 365)`, the new effective
retention is 365 days — the existing data stays under the longer
window.

This rule prevents accidental shortening of retention; explicit
shortening requires `retention.shorten(tenant, kind, days, { force: true })`.

### Active audit windows

`addAuditWindow({ tenant, kind, start, end })` declares a regulatory
or legal hold over a date range. The engine **refuses to delete data
covered by an active window**.

```typescript
retention.addAuditWindow({
  tenant: "tenant-a",
  kind: "session",
  start: "2026-01-01",
  end: "2026-12-31",
  reason: "litigation hold, case XYZ"
});
```

`addAuditWindow` refuses already-expired windows (`end` < now) — a
hold from the past is either a typo or pointless.

### GDPR right-to-delete

```bash
crewhaus retention purge --tenant tenant-a
```

Walks every kind under tenant-a's storage:

1. For each kind, compute the cutoff = now - retentionDays.
2. Skip any record covered by an active audit window.
3. For each remaining record older than the cutoff, delete it.

The audit log itself records the purge:

```json
{ "kind": "data_purged", "tenant": "tenant-a", "kindsAffected": [...], "recordsDeleted": 1432 }
```

So the audit trail proves the purge happened. (The deleted records
themselves are gone, but the purge entry remains — under audit
retention, which is the longest window in the system.)

### GDPR right-to-export

```bash
crewhaus retention export --tenant tenant-a --format ndjson --out tenant-a-export.ndjson
```

Walks all of tenant-a's storage (subject to read permissions) and
writes:

```
{"kind":"session","ts":"2026-03-01T...","data":{...}}
{"kind":"audit","ts":"2026-03-02T...","data":{...}}
...
```

Format options: `json` (single array), `ndjson` (newline-delimited).

`--kinds session,audit` restricts to specific kinds. `--mask-other-tenants`
double-checks that no record references another tenant's id (defense
in depth against a misclassified record).

## Cross-tenant guards

Every layer enforces tenant isolation:

| Layer       | Guard                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| Redactor    | Per-tenant policy lookup uses `AsyncLocalStorage.tenant` — can't read another tenant's policy. |
| Encryption  | Per-tenant DEK; reading a wrong-tenant record fails at the DEK lookup.   |
| Retention   | `retain` / `purge` / `export` all require an explicit tenant arg.        |

Combined with the [Recipe 11](11-managed-multitenant.md) storage
rebase, the tenant isolation property is layered — a bug at any one
layer doesn't break isolation.

## Running the smokes

```bash
bun run smoke:section-39-pii        # redactor end-to-end
bun run smoke:section-39-enc        # encrypt + decrypt round-trip
bun run smoke:section-39-retention  # retain → purge → export
bun run smoke:section-39-compliance # tie-in with the audit-log
```

Each smoke runs without external services.

## Operational checklist

- **Set the KEK early.** `CREWHAUS_AUDIT_KEK` must be present before
  any audit record writes. A daemon starting without it fails loud.
- **Test rotation.** A KEK rotation in staging exercises the
  `onRotation` handler and the dual-key window. Confirm before
  rotating in prod.
- **Backup the KEK.** Lose the KEK and all encrypted audit is
  permanently unreadable. Store KEK backups in a separate, longer-
  retained secret backend.
- **Run `crewhaus audit reencrypt` after a KEK rotation** only if the
  prior KEK is suspected compromised.

## Things that look like PII protection but aren't

| Symptom                                                            | Better tool                                |
| ------------------------------------------------------------------ | ------------------------------------------ |
| You want to redact PII from **model context**, not audit.          | `pre-tool` / `post-model` hook that runs the redactor on payloads. |
| You want to **encrypt** the trace bus / OTel exporters.            | TLS to the exporter endpoint; the bus is in-process. |
| You want PII protection at the **input boundary** of a channel.    | A channel-adapter middleware that redacts before audit. |

The bundled layers target the audit log because that's where PII
*persists*. In-flight model context is a separate problem.

## What to read next

- **Audit substrate.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- **Secret rotation driving KEK rotation.** [Recipe 20 — Secrets Management](20-secrets-management.md).
- **Boundary classification of inbound content.** [Recipe 41 — Security Fabric](41-security-fabric.md).

## Pointers to source

- **PII redactor:** [`packages/pii-redactor`](../../packages/pii-redactor).
- **Audit encryption:** [`packages/audit-encryption`](../../packages/audit-encryption).
- **Data retention engine:** [`packages/data-retention-engine`](../../packages/data-retention-engine).
- **Module catalog reference:** §39 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
