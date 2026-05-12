# Recipe 18 — Multi-Provider Fallback

Wrap each model adapter in a circuit breaker. Consecutive failures
trip the breaker open; a fallback model list cascades to the next
provider when the primary is degraded. No manual retry logic in the
agent; automatic recovery via probe success.

You'd reach for this when:

- Your agent is **user-facing** and downtime is unacceptable.
- You operate across **multiple providers** (Anthropic + OpenAI +
  Bedrock) and want graceful degradation if one tier rate-limits.
- You want **automatic recovery** — once the primary heals, the
  agent goes back to it without a redeploy.

For dev / tests / single-tenant CLIs, skip this — pinning to one
model is simpler and the failure mode is loud rather than silent.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.
- Credentials for at least two providers (e.g.
  `ANTHROPIC_AUTH_TOKEN` + `OPENAI_API_KEY`).

## The `model:` prefix grammar

```
claude-sonnet-4-6                            → Anthropic
claude-opus-4-7                              → Anthropic
openai/gpt-4o                                → OpenAI
openai/gpt-4o-mini                           → OpenAI
gemini/gemini-1.5-pro                        → Google
bedrock/anthropic.claude-3-5-sonnet-20241022 → Bedrock
local/llama3.2@http://localhost:11434/v1     → Local OpenAI-compatible
```

The model-router parses the prefix and lazy-loads only the matching
adapter. A spec with `model: claude-sonnet-4-6` never imports the
OpenAI SDK; a spec with `model: openai/gpt-4o` never imports the
Anthropic SDK. Cold start scales with what you actually use.

## Adding a fallback list

The `agent.fallbackModels` field on a CLI spec (extension to the base
schema):

```yaml
# CLI spec fragment — focus is the agent block:
agent:
  model: claude-sonnet-4-6
  fallbackModels:
    - openai/gpt-4o
    - gemini/gemini-1.5-pro
  instructions: |
    You are a coding assistant.
tools:
  - read
  - write
```

The router treats `model:` + `fallbackModels:` as an ordered list.
Every model call:

1. Tries `claude-sonnet-4-6`.
2. If the call fails (the failure taxonomy — see below — classifies
   it as a fallback-worthy failure) and the primary's circuit is
   open, tries `openai/gpt-4o`.
3. If that also fails or its breaker is open, tries
   `gemini/gemini-1.5-pro`.
4. If all fail, the call surfaces the last error.

Each model in the list has **its own breaker**. A bad Anthropic
provider trips the Anthropic breaker but leaves the OpenAI one
healthy.

## The circuit breaker

`circuit-breaker.wrap(adapter, opts)` from
[`packages/circuit-breaker`](../../packages/circuit-breaker) gives
the adapter three states:

| State        | Behavior                                                              |
| ------------ | --------------------------------------------------------------------- |
| `closed`     | Calls go through normally. Failures increment a counter.              |
| `open`       | Calls fail-fast with `CircuitOpenError`. Falls through to next model. |
| `half-open`  | One trial call goes through. Success → `closed`; failure → `open`.    |

Defaults:

| Opt                 | Default | Meaning                                                  |
| ------------------- | ------- | -------------------------------------------------------- |
| `failureThreshold`  | 5       | Consecutive failures within `windowMs` that trip the breaker. |
| `windowMs`          | 60_000  | Sliding window for counting failures.                    |
| `cooldownMs`        | 30_000  | How long `open` stays open before a `half-open` probe.   |
| `successThreshold`  | 1       | Successful trial calls needed to fully close.            |

Override per-model in the agent block:

```yaml
# CLI spec fragment:
agent:
  model: claude-sonnet-4-6
  fallbackModels:
    - openai/gpt-4o
  circuitBreaker:
    failureThreshold: 3        # tighter — trip after 3
    cooldownMs: 60_000         # but stay open longer
    windowMs: 30_000           # smaller window — only recent failures count
```

A single `circuitBreaker:` block applies to every model in the list.
For per-model tuning, declare the breaker per-provider:

```yaml
# CLI spec fragment:
agent:
  model: claude-sonnet-4-6
  fallbackModels:
    - openai/gpt-4o
  circuitBreaker:
    claude-sonnet-4-6:
      failureThreshold: 3
    openai/gpt-4o:
      failureThreshold: 10     # OpenAI is the secondary; more lenient
```

## What counts as a failure

The breaker's `isFailure` predicate excludes things that aren't
provider problems:

| Classification              | Counts toward breaker? |
| --------------------------- | ---------------------- |
| 5xx server error            | Yes                    |
| 429 rate limit               | Yes                    |
| Network timeout              | Yes                    |
| TLS / DNS failure            | Yes                    |
| 4xx schema validation error  | **No** — client bug, not provider degradation. |
| Cancellation by caller       | **No** — not a failure mode.                  |
| `prompt-injection` redaction | **No** — runtime decision, not provider.      |

Override `isFailure` only if you have a custom adapter that classifies
errors differently. The default is correct for the bundled adapters.

## Half-open probing

When `cooldownMs` elapses on an open breaker, the next call goes
through in `half-open` mode. If it succeeds, the breaker closes;
if it fails, the breaker reopens with another `cooldownMs` wait.

So the recovery profile after a major outage looks like:

```
T+0:    primary fails, breaker trips open
T+0:    every call uses fallback
T+30s:  one probe to primary (in half-open)
T+30s:  if probe fails, back to open; if succeeds, closed
T+30s:  every subsequent call (closed primary) returns to primary
```

The probe is **one** call — not a batch. So a flaky primary doesn't
get hammered into a worse state by simultaneous probes from many
workers.

## Per-provider rate-limit awareness

The bundled adapters parse `Retry-After` headers from 429 responses
and pass them to the breaker, which uses the larger of `cooldownMs`
and `Retry-After` for the next probe. So if Anthropic returns
`Retry-After: 60`, the breaker waits at least 60s — no thundering
herd against a still-overloaded primary.

## `circuit_state_changed` trace events

Every breaker transition emits a structured event:

```json
{
  "kind": "circuit_state_changed",
  "model": "claude-sonnet-4-6",
  "from": "closed",
  "to": "open",
  "reason": "5 failures in 60s",
  "lastError": "ETIMEDOUT"
}
```

Pickup points:

- **Trace bus.** Live in `CREWHAUS_TRACE=json` output.
- **Audit log.** For managed deployments, the event is hash-chained
  in the tenant's audit JSONL.
- **OTel exporters.** Both `circuit_state_changed` and per-call
  attributes (`model.attempt`, `model.circuit_state`) propagate via
  `otel-exporter`.

A grafana panel for breaker state is one of the defaults in
[Recipe 17 — Observability](17-observability.md).

## Operational tuning

| Symptom                                                   | Adjustment                                          |
| --------------------------------------------------------- | --------------------------------------------------- |
| Breaker trips on transient blips.                         | Raise `failureThreshold` or shorten `windowMs`.     |
| Breaker stays open too long after recovery.               | Lower `cooldownMs`; raise `successThreshold`.       |
| Fallback gets traffic during minor primary slowness.      | Tighten primary's `windowMs` so the counter resets faster. |
| Want manual reset.                                         | `crewhaus circuits reset <model>` clears state.    |

## Things that look like fallback but aren't

| Symptom                                                              | Better tool                                       |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| Want a cheaper model first, the expensive one only for hard prompts. | A workflow with a router step in front.            |
| Want different models per role / step.                                | Per-role / per-step `model:` overrides.            |
| Want geo-routed providers (US users → US Anthropic).                  | Bedrock with a regional model id, or federation.   |

Multi-provider fallback is for **availability**, not cost or quality
optimization. Use it as a safety net; not as a routing strategy.

## Local development

For local dev, you usually want **no** fallback — failures should be
loud so you fix the actual problem. Set
`CREWHAUS_DISABLE_CIRCUIT_BREAKER=1` for the duration of dev:

```bash
CREWHAUS_DISABLE_CIRCUIT_BREAKER=1 bun run run:hello
```

That wraps every model in an always-closed breaker, so failures
surface as ordinary errors with the original provider error message.

## What to read next

- **Per-provider rate limiting.** [Recipe 19 — Rate Limiting and Budgets](19-rate-limiting-and-budgets.md).
- **Watch the breaker.** [Recipe 17 — Observability](17-observability.md).
- **Local models as the fallback.** [Recipe 32 — Local Models](32-local-models.md).

## Pointers to source

- **Model router:** [`packages/model-router`](../../packages/model-router).
- **Circuit breaker:** [`packages/circuit-breaker`](../../packages/circuit-breaker).
- **Adapters:** [`packages/adapter-anthropic`](../../packages/adapter-anthropic), [`packages/adapter-openai`](../../packages/adapter-openai), [`packages/adapter-gemini`](../../packages/adapter-gemini), [`packages/adapter-bedrock`](../../packages/adapter-bedrock).
- **Module catalog reference:** §17, §27 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
