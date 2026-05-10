# Recipe 21 — Deployment and Canary

> **Status:** stub.

## What you'll learn

Manage spec versions like code: store them in a registry, pin which
version each environment runs, promote and roll back through audit-logged
operations, and cut over from `vN` to `vN+1` via a percent-of-traffic
canary that gates on a real eval-runner regression check.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for the deployment surface.
- [Recipe 12 — Eval Harness](12-eval-harness.md) for the regression gate.

## Roadmap

1. The `spec-registry` — file-backed storage at `.crewhaus/specs/<name>/<version>.yaml` plus a `manifest.json` with versions list and env→version pin map.
2. Tenant overlays at `_tenants/<tenantId>/<name>.json` — override the global pin without copying the spec.
3. CLI: `crewhaus spec {put, list, get, pin, alias} …`.
4. IR-passes: dead-tool elimination, redundant MCP collapse, permission rule canonicalization, prompt-cache prefix sort. Idempotent — `apply(apply(x)) === apply(x)`.
5. IR migrations — single-version `up`/`down` steps stitched into chains; `migrate-all` walks every spec in a registry.
6. `deployment-controller`: `promote(name, fromEnv, toEnv)`, `rollback(name, env, version)` — both audit-logged.
7. `canary-controller`: stable-hash routing on `sha256(tenantId|requestId) mod 100` — same user stays on the same side across requests.
8. The regression gate: `regression-runner.gate(prev, next, thresholds)` returns `pass | fail` based on pass-rate / score / latency deltas. Pass → promote; fail → auto-rollback + audit reason.
9. Operational guidance: 0% → 1% → 10% → 50% → 100% rollouts, monitoring during each step.

## Run it now

```bash
# Smoke that exercises spec-registry, ir-passes, migration-runner,
# deployment-controller, and canary-controller:
bun run smoke:section-28
```

## Pointers to existing material

- **Modules:** [`packages/spec-registry`](../../packages/spec-registry), [`packages/ir-passes`](../../packages/ir-passes), [`packages/migration-engine`](../../packages/migration-engine), [`packages/migration-runner`](../../packages/migration-runner), [`packages/deployment-controller`](../../packages/deployment-controller), [`packages/canary-controller`](../../packages/canary-controller), [`packages/regression-runner`](../../packages/regression-runner).
- **Catalog:** §28, §29 (regression-runner).

## Where to go next

- For the eval harness behind the gate → [Recipe 12 — Eval Harness](12-eval-harness.md).
- For the audit log that records every promotion/rollback → [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- For deployment to Kubernetes → [Recipe 24 — Docker and Helm](24-docker-and-helm.md).
