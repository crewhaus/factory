# Recipe 19 — Rate Limiting and Budgets

Apply multi-dimensional rate limits keyed on
`(tenant, provider, tool)`, mix token-bucket and leaky-bucket
algorithms, enforce per-tenant token budgets at the gateway, and
gracefully refund partial-failure acquisitions.

Three separate-but-related guardrails:

| Guardrail        | Bounds                                            | Module                           |
| ---------------- | ------------------------------------------------- | -------------------------------- |
| **Rate limit**   | Requests per second across `(tenant, provider, tool)` | [`rate-limiter`](../../packages/rate-limiter) |
| **Token budget** | Total tokens per tenant per period                  | [`token-budget`](../../packages/token-budget) |
| **Cost track**   | Aggregate $ spend per tenant / model              | [`cost-tracker`](../../packages/cost-tracker) |

Reach for them when:

- You're operating **multi-tenant** ([Recipe 11](11-managed-multitenant.md))
  and tenants can hurt each other.
- You hit **provider quotas** during traffic spikes.
- Compliance requires **per-tenant cost attribution**.

For single-tenant CLIs, none of this is necessary.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for
  the tenancy model. Without tenancy, dimensions collapse and the
  multi-dimensional design loses its value.

## The rate-limiter

### Dimensions

A rate-limit key is a tuple:

```
(tenant, provider, tool)
```

Wildcards collapse a dimension:

| Key                                         | Meaning                                              |
| ------------------------------------------- | ---------------------------------------------------- |
| `(tenant-a, anthropic, *)`                  | All Anthropic calls from tenant-a.                   |
| `(*, *, Bash)`                              | Every Bash call across the whole deployment.         |
| `(*, openai, *)`                            | All OpenAI calls across all tenants.                 |
| `(tenant-a, *, *)`                          | All calls from tenant-a.                             |

Buckets are independent: a request acquires *every* matching bucket
in a single transaction, so an Anthropic call from tenant-a hits the
`(tenant-a, anthropic, *)`, the `(tenant-a, *, *)`, and the
`(*, anthropic, *)` buckets all at once.

### Algorithms

| Algorithm | Behavior                                                            | Right for                                        |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| `token`   | Burst-tolerant. Bucket holds `capacity` tokens; refills at `rate`/s. | UI traffic — short bursts shouldn't get blocked.  |
| `leaky`   | Constant smoothing. Calls arrive at any rate; depart at `rate`/s.   | Backend writes to a provider that hates bursts.  |

Choose token-bucket for human-driven workloads (Slack, chat). Choose
leaky-bucket when you're upstream of a provider that returns 429 on
bursts.

### Spec configuration

```yaml
rateLimits:
  - keys:
      tenant: tenant-a
      provider: anthropic
      tool: "*"
    algorithm: token
    capacity: 100         # max burst
    rate: 10              # refill 10/s
  - keys:
      tenant: tenant-a
      provider: openai
      tool: "*"
    algorithm: leaky
    rate: 20              # 20/s departure rate
  - keys:
      tenant: "*"
      provider: "*"
      tool: Bash
    algorithm: token
    capacity: 5
    rate: 1               # only 1 Bash/s globally
```

### The acquire contract

Pre-call code does:

```typescript
const acquired = await rateLimiter.acquire([
  { tenant: "tenant-a", provider: "anthropic", tool: "*" },
  { tenant: "tenant-a", provider: "*", tool: "*" },
], 1, { maxWaitMs: 30000 });

if (!acquired) {
  throw new Error("rate limit exceeded");
}
try {
  await actuallyCallTheModel();
} catch (err) {
  rateLimiter.refund([...]);   // give the tokens back; the call didn't really happen
  throw err;
}
```

The semantics:

1. Acquire **all** keys atomically. If any single key would block past
   `maxWaitMs`, the whole acquisition fails (fail-closed).
2. On call failure (network error, 5xx), the caller must refund —
   the tokens shouldn't count against quota.
3. On call success, no refund — the spend is real.

### Wiring points

Three places acquire in the bundled targets:

| Site                        | Keys acquired                                                          |
| --------------------------- | ---------------------------------------------------------------------- |
| `model-router` pre-call     | `(tenant, provider, *)`                                                 |
| `gateway-server` pre-handler | `(tenant, *, *)`                                                        |
| Tool-runtime pre-call       | `(tenant, *, <toolName>)` for tools that opted into rate limiting       |

You can add more sites via the `runChatLoop({ rateLimitKeys: [...] })`
option in custom codegen.

## Token budgets

Token budgets are **per-tenant, per-period totals**. They live in
[`token-budget`](../../packages/token-budget) and are enforced at
two points:

1. **Pre-flight at the gateway.** A `runs.create` call estimates the
   input tokens via a fast tokenizer. If `tenant.usage + estimate >
   tenant.budget`, the call rejects with `BUDGET_EXCEEDED` before
   any model call.
2. **Post-flight per turn.** After each turn, the actual tokens used
   update the tenant's counter. A long run that ran past budget
   terminates early — the model bills only through the cutoff.

Spec format (lives on the managed-target tenants list):

```yaml
tenants:
  - id: tenant-a
    budget:
      maxInputTokens: 1_000_000
      maxOutputTokens: 200_000
      period: monthly         # default; alternatives: daily, perRun
  - id: tenant-b
    budget:
      maxInputTokens: 10_000_000
      maxOutputTokens: 2_000_000
      period: daily
```

Period boundaries:

| Period     | Reset                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| `monthly`  | First of the month, UTC midnight.                                       |
| `daily`    | UTC midnight.                                                            |
| `perRun`   | Per-`runs.create` only; no carryover.                                   |
| `none`     | Counter accumulates forever (audit-only, no enforcement).               |

`perRun` is the right answer for evaluation pipelines (each run gets
a fixed budget) and one-off operations.

## Cost tracking

Token counts and dollar costs live in
[`cost-tracker`](../../packages/cost-tracker). The tracker doesn't
*enforce* anything (the budget does that); it aggregates spend for
reporting:

| Aggregation                  | Where it surfaces                                |
| ---------------------------- | ------------------------------------------------ |
| `per_session_cost_usd`        | Session JSONL footer event                       |
| `per_tenant_cost_usd_daily`   | OTel metric (default in [Recipe 17](17-observability.md)) |
| `per_model_cost_usd_daily`    | OTel metric                                      |
| `per_tool_cost_usd_daily`     | OTel metric (tools with provider-side cost)      |

Cost numbers come from the model-router's pricing table, which is
seeded with the latest published provider pricing at compile time
(`packages/model-router/src/pricing.ts`). When a provider raises
prices, update the table.

## Cost vs rate vs budget — three orthogonal limits

| Limit                                                | Catches                                  | Doesn't catch                        |
| ---------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| Rate limit                                           | Too many requests/sec.                   | Spend over time.                     |
| Token budget                                         | Total tokens too high.                   | A burst that fits within the budget. |
| Cost track (passive)                                 | Reports spend; doesn't enforce.          | Anything — it's observational only.   |

In production multi-tenant deployments, **all three** apply. Rate
limit absorbs traffic spikes; budget enforces the SLA per period;
cost tracker reports for billing.

## Refund semantics

Refunds matter because partial acquisitions are common:

```
acquire((tenant-a, anthropic, *)) → 1 token taken
acquire((*, *, Bash)) → blocked, fails
// without refund, tenant-a's anthropic bucket lost a token to a call that didn't happen
refund((tenant-a, anthropic, *)) → 1 token returned
```

The rate-limiter implements transactional acquire so either every key
acquires (success) or none acquire (failure, no refund needed). Refunds
are only needed when the **call itself** fails after a successful
acquisition.

The bundled adapters call `refund` automatically on transient
failures (network error, 5xx). On 4xx (client bug) the refund **does
not** fire — that wasn't a provider problem; the user shouldn't get
the tokens back.

## Operational tuning

| Symptom                                               | Adjustment                                           |
| ----------------------------------------------------- | ---------------------------------------------------- |
| Bursty UI traffic getting blocked.                    | Token-bucket with high `capacity`, modest `rate`.    |
| Backend hitting provider 429s.                        | Leaky-bucket; tune `rate` below provider quota.     |
| One tenant starves others.                            | Add a `(*, *, *)` cap above the per-tenant caps.    |
| Budget exhaustion mid-conversation.                   | Shorter period or `perRun` instead of `monthly`.     |
| Want to test budget exhaustion behavior.              | `tenant.budget.maxInputTokens: 1000` for a smoke.    |

## Starvation testing

Run the bundled load test to verify no starvation under contention:

```bash
bun test packages/rate-limiter
```

The suite runs 1000 concurrent acquisitions against a 100-capacity
bucket and asserts:

1. Total acquisitions = 1000 over the projected time.
2. No single caller waits more than `maxWaitMs`.
3. Refunds restore exactly the granted tokens, no more, no less.

If you tune the rate-limiter's internals, re-run this before merge.

## Interaction with the circuit breaker

The breaker ([Recipe 18](18-multi-provider-fallback.md)) and the rate
limiter are independent:

- The breaker decides **which provider** to call.
- The rate limiter decides **whether** to call it now.

Order: rate-limit acquire **first**, breaker check **second**. So a
budget-exhausted tenant never trips a breaker on Anthropic — the
acquisition fails before the model adapter sees the call.

## Things that look like rate limiting but aren't

| Symptom                                                       | Better tool                                  |
| ------------------------------------------------------------- | -------------------------------------------- |
| One user spamming a public-facing channel.                    | Channel-layer rate limit (HTTP middleware)   |
| Wanting to *charge* users per call.                            | [`cost-tracker`](../../packages/cost-tracker) + billing pipeline |
| Wanting to slow the **agent's own** tool spam.                | A `pre-tool` hook with cooldown logic         |

## What to read next

- **Provider failover when rate-limited paths are degraded.** [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md).
- **Cost reporting in the audit log.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- **Multi-tenant runtime.** [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).

## Pointers to source

- **Rate limiter:** [`packages/rate-limiter`](../../packages/rate-limiter).
- **Cost tracker:** [`packages/cost-tracker`](../../packages/cost-tracker).
- **Token budget:** [`packages/token-budget`](../../packages/token-budget).
- **Gateway server (budget enforcement):** [`packages/gateway-server`](../../packages/gateway-server).
- **Module catalog reference:** §27 (rate-limiter, cost-tracker), §20 (gateway budgets) in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
