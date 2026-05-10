# Recipe 18 — Multi-Provider Fallback

> **Status:** stub.

## What you'll learn

Wrap a model adapter in a circuit breaker so consecutive failures trip
it open, and configure a fallback model list so requests cascade to
the next provider when the primary is degraded. Same agent, no manual
retry logic, automatic recovery on probe success.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).
- Credentials for at least two providers (e.g. `ANTHROPIC_AUTH_TOKEN` + `OPENAI_API_KEY`).

## Roadmap

1. The `model:` prefix grammar — `claude-…` / `openai/…` / `gemini/…` / `bedrock/…` / `local/<model>@<url>`.
2. The `model-router`: parses the model id and lazy-loads the matching adapter.
3. `circuit-breaker.wrap(adapter, opts)` — `closed → open` after `failureThreshold` failures within `windowMs`.
4. Half-open probing: `cooldownMs` later, the breaker tests with one request; success closes, failure re-opens.
5. The `isFailure` predicate — exclude 4xx schema errors from the threshold so client bugs don't trip the breaker.
6. Configuring `fallbackModels: [...]` in the spec — model-router falls through the list.
7. The `circuit_state_changed` trace event — picked up by audit log, structured printer, OTel.
8. Operational guidance: tuning thresholds, monitoring the breaker state.

## Run it now

```bash
# No bundled fallback example yet; in-tree tests at:
#   packages/circuit-breaker/src/index.test.ts
#   packages/model-router/src/router.test.ts
```

## Pointers to existing material

- **Modules:** [`packages/model-router`](../../packages/model-router), [`packages/circuit-breaker`](../../packages/circuit-breaker), [`packages/adapter-anthropic`](../../packages/adapter-anthropic), [`packages/adapter-openai`](../../packages/adapter-openai), [`packages/adapter-gemini`](../../packages/adapter-gemini), [`packages/adapter-bedrock`](../../packages/adapter-bedrock).
- **Catalog:** §17, §27 (circuit-breaker).

## Where to go next

- For multi-dimensional rate limiting per provider/tenant/tool → [Recipe 19 — Rate Limiting and Budgets](19-rate-limiting-and-budgets.md).
- For sandboxed tool execution that the breaker doesn't apply to → [Recipe 30 — Sandboxed Code Execution](30-sandboxed-code-execution.md).
