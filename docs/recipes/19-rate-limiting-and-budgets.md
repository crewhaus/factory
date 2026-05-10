# Recipe 19 — Rate Limiting and Budgets

> **Status:** stub.

## What you'll learn

Apply multi-dimensional rate limits keyed on `(tenant, provider, tool)`,
mix token-bucket (burst-tolerant) and leaky-bucket (smoothing)
algorithms, enforce per-tenant token budgets at the gateway, and
gracefully refund partial-failure acquisitions.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for the tenancy model.

## Roadmap

1. Rate-limit dimensions: `(tenant, provider, tool)` plus `*` wildcards for per-dimension defaults.
2. Algorithms: `token` (burst tolerance) vs `leaky` (constant smoothing). When to choose which.
3. The `acquire(keys, cost?)` contract — blocks until every bucket pays out or rejects after `maxWaitMs` (fail-closed).
4. Partial-failure refunds: re-credit successful acquisitions when a later one denies, so callers can retry safely.
5. Wiring: model-router pre-call (provider bucket), gateway-server pre-handler (tenant bucket), `RunChatLoopOptions.rateLimitKeys` (codegen-side).
6. Per-tenant input/output token budgets — enforced by the gateway, refused at the boundary if exceeded.
7. Cost vs rate vs budget — three orthogonal limits, what each catches.
8. Operational guidance: starvation tests, queue depth, circuit-breaker interaction.

## Run it now

```bash
# Rate-limiter unit + load tests:
bun test packages/rate-limiter
```

## Pointers to existing material

- **Modules:** [`packages/rate-limiter`](../../packages/rate-limiter), [`packages/cost-tracker`](../../packages/cost-tracker), [`packages/token-budget`](../../packages/token-budget), [`packages/gateway-server`](../../packages/gateway-server).
- **Catalog:** §27 (rate-limiter, cost-tracker), §20 (gateway budgets).

## Where to go next

- For provider failover when a rate-limited path is down → [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md).
- For audit-logged cost reporting → [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
