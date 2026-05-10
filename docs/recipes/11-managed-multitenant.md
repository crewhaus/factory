# Recipe 11 — Managed Multitenant

> **Status:** stub.

## What you'll learn

Stand up a long-running gateway daemon that serves multiple tenants
behind a JSON-RPC protocol with HS256-JWT auth, per-tenant token
budgets, hash-chained audit logs, and storage rebased per tenant so
cross-tenant reads are impossible.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).
- [Recipe 19 — Rate Limiting and Budgets](19-rate-limiting-and-budgets.md) for budget mechanics.
- [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md) if your deployment needs evidence collection.

## Roadmap

1. The `target: managed` spec — `agent`, `tenants: [{ id, budget }]`.
2. The JSON-RPC gateway: `runs.create`, `runs.continue`, `runs.cancel`, `runs.subscribe` (SSE), `sessions.list`, `sessions.fork`, `audit.tail`.
3. JWT authentication: tenant id as a claim; expired tokens rejected; tenant mismatch rejected.
4. Per-tenant storage rebase via AsyncLocalStorage — sessions, evals, tool-results all live under the tenant's roots.
5. Hash-chained audit log — one JSONL per tenant per day; `crewhaus audit verify` walks the chain.
6. Policy engine — tools default to `sideEffect: "external"` (fail-closed); `allow | audit-and-allow | deny`.
7. Budget enforcement: refuse runs over budget at the gateway boundary.
8. Operating: rolling restart, evidence export, rate-limit tuning.

## Run it now

```bash
bun run compile:hello-managed
bun run run:hello-managed
```

## Pointers to existing material

- **Example:** [`examples/hello-managed/crewhaus.yaml`](../../examples/hello-managed/crewhaus.yaml) — two tenants with input/output token budgets.
- **Codegen:** [`packages/target-managed`](../../packages/target-managed).
- **Modules:** [`packages/gateway-protocol`](../../packages/gateway-protocol), [`packages/gateway-server`](../../packages/gateway-server), [`packages/tenancy`](../../packages/tenancy), [`packages/audit-log`](../../packages/audit-log), [`packages/policy-engine`](../../packages/policy-engine).
- **Catalog:** §20.

## Where to go next

- For canary rollouts of new spec versions across tenants → [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- For SOC 2 / ISO 27001 / HIPAA evidence collection → [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- For PII redaction + audit-log encryption → [Recipe 23 — PII Redaction and Encryption](23-pii-redaction-and-encryption.md).
- For Kubernetes deployment of the gateway → [Recipe 24 — Docker and Helm](24-docker-and-helm.md).
