# Recipe 20 — Secrets Management

Pick between three secret backends — env-var, file, or HashiCorp
Vault — and wire long-running daemons to a rotation event so a Vault
key rotation propagates without restart. Every read and rotation is
audit-logged when scoped to a tenant.

You'd reach for `secrets-manager` when:

- You need **rotation without restart** — daemons that hold long-lived
  channel credentials, gateway JWT secrets, audit-log encryption keys.
- You need **per-tenant secret isolation** in a managed deployment.
- You want **audit evidence** for every secret read (compliance asks
  "who accessed `STRIPE_API_KEY` and when?").

For single-process CLIs with `$VAR_NAME` references straight to env
vars, the env-var backend is already in use (without you naming it).

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for
  the tenancy + audit context. The file backend works standalone.

## The `Secrets` interface

```typescript
interface Secrets {
  get(name: string): Promise<string>;
  rotate(name: string, newValue: string): Promise<void>;
  onRotation(handler: (name: string) => void): () => void;
}
```

Three methods, three semantics:

| Method        | Returns / Effect                                          | Audit event           |
| ------------- | --------------------------------------------------------- | --------------------- |
| `get(name)`    | The current value. Throws if missing.                     | `secrets_access`      |
| `rotate(name, v)` | Atomically replaces the stored value. Notifies subscribers. | `secrets_rotation`    |
| `onRotation(h)` | Subscribes to all rotations. Returns an unsubscribe handle. | (no event — subscription is local) |

## Three backends

### `env-var` (default)

Reads from `process.env`. The simplest possible backend; what every
`$VAR_NAME` spec reference uses by default.

| Operation      | Behavior                                                    |
| -------------- | ----------------------------------------------------------- |
| `get(name)`     | `process.env[name]`. Throws if undefined or empty.          |
| `rotate(...)`   | Logs a warning and rejects — env vars are immutable in-process. |
| `onRotation(h)` | No-op; warning logged.                                       |

When to use: every dev environment, every CLI agent, every test.

### `file`

Atomic-write secrets under `.crewhaus/secrets/<name>` with `0o600`
file permissions. Path-traversal guards reject names containing `/`,
`..`, or null bytes.

| Operation      | Behavior                                                       |
| -------------- | -------------------------------------------------------------- |
| `get(name)`     | `readFile(.crewhaus/secrets/${name})`. Throws if missing.       |
| `rotate(name, v)` | Atomic write via tempfile + rename. Notifies subscribers.    |
| `onRotation(h)` | Subscribed in-process. fs.watch fires the handler when the file changes. |

When to use: persistent secrets you need to rotate without redeploying
the daemon. Often used as a staging area for vault-fetched secrets.

### `vault`

HashiCorp Vault KV v2 over HTTP.

| Operation      | Behavior                                                                   |
| -------------- | -------------------------------------------------------------------------- |
| `get(name)`     | GET `/v1/secret/data/<name>`. Caches for `cacheTtlMs` (default 60s).        |
| `rotate(...)`   | POST `/v1/secret/data/<name>`. Invalidates cache. Notifies subscribers.    |
| `onRotation(h)` | Polls Vault for `metadata.version` change every `pollMs` (default 60s).     |

Configuration via env vars:

| Env var               | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `VAULT_ADDR`           | Vault HTTP base URL.                                   |
| `VAULT_TOKEN`          | Auth token (or AppRole role-id/secret-id via separate vars). |
| `VAULT_NAMESPACE`      | Vault Enterprise namespace (optional).                  |
| `VAULT_KV_MOUNT`       | KV v2 mount path (default `secret`).                    |

When to use: production deployments that need centrally-managed secret
rotation, tenant isolation via Vault namespaces, or compliance
attestation that secrets never live in env vars.

## Selecting a backend

The runtime picks the backend by env var:

```bash
CREWHAUS_SECRETS_BACKEND=env       # default
CREWHAUS_SECRETS_BACKEND=file
CREWHAUS_SECRETS_BACKEND=vault
```

For mixed setups (most secrets in Vault, a few in env vars during
migration), use a **chained** backend:

```bash
CREWHAUS_SECRETS_BACKEND=vault,env
```

The chain tries vault first; if a name is missing, falls back to env.
Useful during migration.

## The rotation contract

Long-running daemons (channel, managed, voice, batch) subscribe via
`onRotation`:

```typescript
import { secrets } from "@crewhaus/secrets-manager";

const unsub = secrets.onRotation((name) => {
  if (name === "SLACK_SIGNING_SECRET") {
    rewireSlackVerification();
  }
});

// On shutdown:
unsub();
```

Semantics:

- Handlers are called **per-rotation**, with the rotated name. They do
  **not** receive the new value — they call `secrets.get()` to fetch
  it.
- Handler exceptions are isolated. One handler throwing does not stop
  the others.
- Handlers run in the same process; for cross-process notification,
  the rotating side calls `secrets.rotate()` and every subscriber's
  next `get()` returns the new value.

The bundled channel adapters all subscribe to their relevant
signing-secret rotation, so a Vault rotation propagates within
`pollMs` without a restart.

## Audit events

When a tenant context is active (managed gateway), every operation
emits an audit event:

| Event                | Payload                                                |
| -------------------- | ------------------------------------------------------ |
| `secrets_access`     | `{ tenant, name, backend, hit: cache | fetch, latency }` |
| `secrets_rotation`   | `{ tenant, name, backend, version }`                    |
| `secrets_access_denied` | `{ tenant, name, reason }`                          |

These are hash-chained into the tenant's audit JSONL ([Recipe 11](11-managed-multitenant.md))
so the audit trail can prove **who accessed what secret when**.

For non-tenant contexts (CLI, single-tenant), audit is optional via
`CREWHAUS_SECRETS_AUDIT_PATH=/path/to/secrets-audit.jsonl`.

## CLI surface

```bash
crewhaus secrets doctor
```

Walks every `$VAR_NAME` reference in the active spec, checks whether
the corresponding secret is available in the configured backend,
and reports:

```
secret: SLACK_BOT_TOKEN       backend: env       status: available
secret: SLACK_SIGNING_SECRET  backend: env       status: missing
secret: ANTHROPIC_AUTH_TOKEN  backend: env       status: available
```

Run before deploying — catches missing secrets at deploy time rather
than at first traffic.

```bash
crewhaus secrets rotate <name>
```

For `file` and `vault` backends, generates a new value (or prompts
for one) and rotates. Subscribers receive the rotation event. Not
supported for env-var (env vars are immutable in-process).

```bash
crewhaus secrets list
```

Lists all secrets the backend knows about. **Does not print values**
— the list is metadata only (name, backend, last-rotation-time).

## Wiring secrets into spec `$VAR_NAME`

Every `$VAR_NAME` reference in spec YAML is lowered by the compiler
to `process.env.VAR_NAME` reads with a **startup-time** null check:

```yaml
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
```

Compiled into:

```typescript
const slackBotToken = process.env.SLACK_BOT_TOKEN ?? throwMissing("SLACK_BOT_TOKEN");
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET ?? throwMissing("SLACK_SIGNING_SECRET");
```

So a missing secret crashes the daemon at startup with a clear error,
not at first inbound request with a cryptic `undefined` error.

To switch a spec from env to vault, set the backend env var; the
spec doesn't change. The `secrets-manager` shims the `process.env`
read with a vault-fetched lookup transparently.

## Worked examples

### Rotating a Slack signing secret

```bash
# Generate a new signing secret in the Slack app console, then:
crewhaus secrets rotate SLACK_SIGNING_SECRET
# prompts for the new value, atomically rotates, notifies the daemon
```

The Slack channel adapter's `onRotation` handler refreshes the HMAC
verifier with the new key on the next request. In-flight requests
finish with the old key (verified before rotation completed).

### Rotating an audit-encryption KEK

For audit-log encryption ([Recipe 23](23-pii-redaction-and-encryption.md)),
the KEK rotates via:

```bash
crewhaus secrets rotate CREWHAUS_AUDIT_ENCRYPTION_KEK
```

The audit-log writer's `onRotation` handler:

1. Generates a new DEK encrypted under the new KEK.
2. Updates the `kek_version` field in the current audit segment's
   header.
3. Continues writing with the new DEK.

Old audit segments remain encrypted under the prior KEK; the verifier
uses `kek_version` to pick the right key for decryption.

## Things that look like secrets but aren't

| Symptom                                                  | Better tool                                       |
| -------------------------------------------------------- | ------------------------------------------------- |
| Spec value that's secret-sensitive at compile.            | Don't put it in the spec; use `$VAR_NAME`.        |
| Per-tenant secret (tenant-A's Slack token).               | Vault namespace per tenant, or a custom backend.  |
| One-time bootstrap token.                                 | Env var; not worth the rotation infra.            |

## Things that look like a rotation but aren't

`secrets.rotate` changes the **value** of a secret. It doesn't:

- Re-issue a JWT for in-flight gateway connections (they expire by
  their own `exp` claim).
- Force a circuit breaker reset.
- Restart a daemon (subscribers handle the rotation in-process).

If you want to force a restart on rotation, layer that into the
subscriber handler.

## What to read next

- **Audit-log encryption that rotates with the KEK.** [Recipe 23 — PII Redaction and Encryption](23-pii-redaction-and-encryption.md).
- **Vault behind the daemon.** [Recipe 24 — Docker and Helm](24-docker-and-helm.md)
  — annotations to mount Vault credentials.
- **Compliance evidence for secret access.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).

## Pointers to source

- **Module:** [`packages/secrets-manager`](../../packages/secrets-manager).
- **Module catalog reference:** §27 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
