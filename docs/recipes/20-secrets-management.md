# Recipe 20 — Secrets Management

> **Status:** stub.

## What you'll learn

Pick between three secret backends — env-var, file, or HashiCorp Vault
— and wire long-running daemons to a rotation event so a Vault key
rotation propagates without restart. Every read and rotation is
audit-logged when scoped to a tenant.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for the tenancy + audit context (the file backend works standalone).

## Roadmap

1. The `Secrets` interface — `get(name)`, `rotate(name, newValue)`, `onRotation(handler)`.
2. Backends:
   - **env-var** — reads `process.env`. Rotation = a logged warning (env vars are immutable in-process).
   - **file** — atomic-write under `.crewhaus/secrets/<name>` with mode 0o600 + path-traversal guards.
   - **vault** — HashiCorp Vault KV v2 over HTTP.
3. The rotation contract: long-running daemons subscribe via `onRotation`, handler exceptions are isolated.
4. Auditing: every `get` and `rotate` lands as a `secrets_access` / `secrets_rotation` audit event when scoped to a tenant.
5. `crewhaus secrets doctor` — reports `available` / `missing` per registered secret.
6. `crewhaus secrets rotate <name>` — triggers a rotation manually (file/vault backends only).
7. Wiring secrets into spec `$VAR_NAME` references — startup-time fail-loud check (no silent empty signing secrets).
8. Worked examples: rotating a Slack signing secret, rotating an audit-encryption KEK.

## Run it now

```bash
# CLI surface:
bun apps/cli/src/index.ts secrets doctor
bun apps/cli/src/index.ts secrets rotate <name>
```

## Pointers to existing material

- **Module:** [`packages/secrets-manager`](../../packages/secrets-manager).
- **Catalog:** §27 (secrets-manager).

## Where to go next

- For audit-log encryption that auto-rotates with the KEK → [Recipe 23 — PII Redaction and Encryption](23-pii-redaction-and-encryption.md).
- For deployment scenarios where Vault sits behind the daemon → [Recipe 24 — Docker and Helm](24-docker-and-helm.md).
