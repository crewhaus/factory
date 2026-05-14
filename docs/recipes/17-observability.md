---
test:
  packages:
    - packages/trace-event-bus
    - packages/structured-event-printer
    - packages/metrics-collector
    - packages/otel-exporter
    - packages/cost-tracker
    - packages/exporter-datadog
    - packages/exporter-honeycomb
    - packages/exporter-splunk
    - packages/exporter-newrelic
---

# Recipe 17 — Observability

Every meaningful runtime event flows through an in-process
`TraceEventBus`. By default the bus has no subscribers and produces no
output — every observability surface is opt-in by env var, so you only
pay for what you turn on.

This recipe covers the five layers, in order from "I want to see what
my agent is doing right now" to "I want every event in Datadog with
gen_ai/* semantic conventions."

## Prerequisites

- A working spec from [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md)
  to point the observability surfaces at.

## The five layers

| Layer                | What it does                                              | Cost   | Opt in via                                                |
| -------------------- | --------------------------------------------------------- | ------ | --------------------------------------------------------- |
| Session JSONL        | Append-only event log per session.                        | Always-on. Disk only. | (default)                                                 |
| Trace printer        | Color-coded live events on stderr (or JSON on stdout).    | Cheap. | `CREWHAUS_TRACE=pretty` or `=json`                        |
| Metrics              | Prometheus counters + histograms.                         | Cheap. | `CREWHAUS_METRICS=stdout` / `textfile:/path` / `http:9464`|
| OpenTelemetry        | OTLP/HTTP export, `gen_ai/*` semantic conventions.        | Network. | `OTEL_EXPORTER_OTLP_ENDPOINT=…`                           |
| Cost tracking        | `cost_accrual` events from `model_response`.              | Cheap. | `CREWHAUS_COST_TRACKING=1`                                |
| Vendor exporters     | Datadog / Honeycomb / Splunk / New Relic, auto-attaching. | Network. | Each vendor's API key env var (`DD_API_KEY`, etc.)        |

You can mix and match. Pretty trace + metrics + OTel is a fine
local-dev setup; OTel + cost tracking + a vendor exporter is a typical
production deployment.

## Layer 1 — The session JSONL

The substrate. Always-on, no env var, no opt-in.

Every run writes to `.crewhaus/sessions/sess_<id>.jsonl` (mode 0o600 —
owner-only). Each line is one of these event kinds, with a discriminator
under `.kind`:

| Kind                  | Payload includes                                       |
| --------------------- | ------------------------------------------------------ |
| `user_message`        | Anthropic `MessageParam` content.                      |
| `assistant_message`   | Anthropic `MessageParam` content (with tool_use blocks).|
| `tool_use`            | Tool name, input, run id, tool use id.                 |
| `tool_result`         | Tool use id, content (or a `<10KB-truncated, see file …>` pointer for outputs over 10 KB). |
| `error`               | Error class + message + recovery action.               |
| `compaction`          | Strategy (`snip` / `autocompact`), before/after token counts. |

Read it after the fact:

```bash
tail -n 50 .crewhaus/sessions/sess_<id>.jsonl | jq -r .kind | sort | uniq -c
```

A typical run for a simple chat turn shows roughly:

- 1 `user_message`
- 1+ `assistant_message`
- 0–N `tool_use` + matching `tool_result` pairs
- 0–1 `compaction` (only when context gets near 85% of limit)
- 0 `error` (if nothing went wrong)

The JSONL is also what `--resume` reads — see
[Recipe 31 — Session Resume and Replay](31-session-resume-and-replay.md).

## Layer 2 — Live tracing on stderr/stdout

For watching an agent's turn unfold in real time:

```bash
CREWHAUS_TRACE=pretty bun run run:hello
```

Color-coded events stream to stderr. `model_stream_token` deltas
collapse into a rolling line via `\r` rewrites on a TTY (or one
summary line when stderr is piped). `NO_COLOR=1` disables ANSI codes.

For machine consumption:

```bash
CREWHAUS_TRACE=json bun run run:hello | jq -c .
```

One JSON object per event on stdout. This format is stable and meant
to be consumed by your own tooling — pipe it into a tail aggregator, a
log shipper, or your local development dashboard.

The bus emits 15 event kinds beyond what the JSONL persists:

- `turn_start`, `turn_end`
- `model_request`, `model_stream_token`, `model_response`
- `tool_request`, `tool_response`
- `mcp_call_start`, `mcp_call_end`
- `hook_fired`
- `compaction_start`, `compaction_end`
- `permission_decision`
- `error_recovered`
- Sub-agent boundaries (`sub_agent_start`, `sub_agent_end`)

The ring buffer holds the most recent 5000 events for in-process
inspection; `model_stream_token` is marked `ephemeral` and skips the
buffer so 10K-token responses don't evict everything else.

## Layer 3 — Metrics

For Prometheus-shaped counters and histograms.

```bash
# Buffered stdout JSON, emitted as one dump on shutdown:
CREWHAUS_METRICS=stdout bun run run:hello

# Atomic Prometheus textfile writes:
CREWHAUS_METRICS=textfile:/var/lib/node_exporter/crewhaus.prom bun run run:hello

# Pull-based HTTP endpoint:
CREWHAUS_METRICS=http:9464 bun run run:hello   # GET http://localhost:9464/metrics
```

The metrics:

| Metric                                 | Type      | Labels                            |
| -------------------------------------- | --------- | --------------------------------- |
| `crewhaus_turns_total`                 | counter   | —                                 |
| `crewhaus_tool_calls_total`            | counter   | `tool`                            |
| `crewhaus_tokens_total`                | counter   | `direction` (`input`/`output`)    |
| `crewhaus_errors_total`                | counter   | `kind`                            |
| `crewhaus_turn_duration_seconds`       | histogram | —                                 |
| `crewhaus_tool_duration_seconds`       | histogram | `tool`                            |
| `crewhaus_model_ttft_seconds`          | histogram | —                                 |

`crewhaus_model_ttft_seconds` is the time-to-first-token, computed as
the gap between `model_request` and the first `model_stream_token`
event sharing the same trace id.

The stdout sink buffers and flushes once on shutdown — that avoids
interleaving metric dumps with assistant text on stdout. Use
`textfile:` or `http:` in production.

## Layer 4 — OpenTelemetry

OTLP/HTTP export with `gen_ai/*` semantic conventions:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=my-agent \
OTEL_EXPORTER_OTLP_HEADERS="api-key=…,tenant=acme" \
  bun run run:hello
```

The exporter pairs lifecycle events into spans:

| Span                  | Attributes                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `chat`                | `gen_ai.system` (`anthropic` / `openai` / `gcp.gemini` / `aws.bedrock`), `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reason`, `gen_ai.operation.name="chat"` |
| `tool.<name>`         | `code.function = <tool name>`, plus extension keys `crewhaus.tool.*`                        |
| `mcp.<server>.<tool>` | `mcp.server.name`, `mcp.tool.name`                                                          |
| sub-agent             | rooted under the parent span via `parentSpanId`                                             |

`model_stream_token` events ride as span events on the model span
rather than getting individual sub-spans — sub-spans-per-token would
explode any APM bill.

5-second batch flush; sync flush on shutdown.

W3C trace-context propagation: sub-agents and federation calls
inherit `parent.bus.traceId` so OTel stitches the whole multi-agent
flow as one trace. To attach an external traceparent, set the
`TRACEPARENT` env var.

## Layer 5 — Cost tracking

For dollar-amount reporting per session and per tenant:

```bash
CREWHAUS_COST_TRACKING=1 bun run run:hello
# Optionally annotate with tenant id (managed-shape deployments):
CREWHAUS_TENANT_ID=acme bun run run:hello
```

The cost tracker subscribes to `model_response` events, looks up
per-provider pricing from `pricing.json`, and emits `cost_accrual`
events with USD aggregation in **microdollars** (to avoid float drift
in long-running sums).

Read totals via:

```bash
bun apps/cli/src/index.ts cost-summary --session sess_<id>
```

The summary breaks down by model, input vs output tokens, and total
USD. Pricing misses (e.g. a brand-new model id the table doesn't
cover yet) increment a counter rather than throwing — a new model
release doesn't crash production.

For per-tenant cost: pass `--tenant <id>` to aggregate every session
tagged with that tenant id.

## Layer 6 — Vendor exporters

Four vendors auto-attach when their API key env var is set; each
wraps the OTel exporter with vendor-specific resource attributes and
endpoint routing.

| Vendor       | Trigger env var(s)                                                  | Endpoint                                                          |
| ------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Datadog**  | `DD_API_KEY`, optional `DD_OTLP_ENDPOINT`, `DD_TAGS`                 | `https://otlp.datadoghq.com/v1/traces` (override per-region)      |
| **Honeycomb**| `HONEYCOMB_API_KEY`, optional `HONEYCOMB_DATASET`, `HONEYCOMB_API_HOST` | `https://api.honeycomb.io/v1/traces` (or `api.eu1.honeycomb.io`)  |
| **Splunk**   | `SPLUNK_REALM` + `SPLUNK_ACCESS_TOKEN`                                | `https://ingest.<realm>.signalfx.com/v2/trace/otlp`               |
| **New Relic**| `NEW_RELIC_LICENSE_KEY`, optional `NEW_RELIC_REGION` (`us` / `eu`)    | `https://otlp.nr-data.net/v1/traces` (US) / `eu01.nr-data.net` (EU)|

All four ship a **credential-leak guard**: a `scrubApiKey()` filter
rewrites the wrapped exporter's `onError` so the API key value never
appears in logs, error messages, or span attrs. If you see
`[REDACTED:DD_API_KEY]` in your logs, the guard is doing its job.

Multiple vendors can attach side by side; each consumes the same
trace event bus, so spans go to every configured destination.

## Putting it together — a typical production deploy

```bash
# Persistent observability:
export CREWHAUS_TRACE=json                # for stdout aggregation
export CREWHAUS_METRICS=http:9464         # for Prometheus scrape
export OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.local:4318
export CREWHAUS_COST_TRACKING=1
export CREWHAUS_TENANT_ID=$TENANT_FROM_REQUEST
export DD_API_KEY=$(cat /var/run/secrets/datadog/api-key)

bun /app/agent.js
```

The agent emits the JSONL log to disk, prints JSON-Lines events on
stdout, exposes Prometheus metrics on :9464, ships OTel traces to your
collector, attributes cost to the right tenant, and routes everything
into Datadog for the operations team. Total runtime overhead: low —
the bus is in-process; the network sends are batched.

## Debugging an unexpected event sequence

When something's off, the most useful first move is:

```bash
CREWHAUS_TRACE=json bun apps/cli/src/index.ts run my-spec.yaml < input.txt \
  | jq -r '"\(.kind)\t\(.payload | tostring | .[0:80])"'
```

That gives you a tab-separated per-event view, payload truncated to
80 chars. Pick the line where things look wrong, then read the full
JSONL for that session for the complete payload.

For span-tree inspection in a UI, set up OTel + a local
[Jaeger](https://www.jaegertracing.io) or load the trace into
[Honeycomb's free tier](https://www.honeycomb.io/pricing).

## What to read next

- **Correlate a runtime trace event back to the spec line that caused it.** [GETTING-STARTED.md § Tracing a request across YAML, IR, and trace](../GETTING-STARTED.md#tracing-a-request-across-yaml-ir-and-trace) — two worked walkthroughs (permission denial; eval-driven prompt mutation) showing YAML, IR, and trace events side by side.
- **Persist sessions across restarts.** [Recipe 31 — Session Resume and Replay](31-session-resume-and-replay.md).
- **Audit trail with hash chaining.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- **Multi-tenant observability per tenant.** [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- **Eval runs as a special case of tracing.** [Recipe 12 — Eval Harness](12-eval-harness.md) — every per-sample run produces its own trace event log.

## Pointers to source

- **Trace bus:** [`packages/trace-event-bus`](../../packages/trace-event-bus).
- **Printer:** [`packages/structured-event-printer`](../../packages/structured-event-printer).
- **Metrics:** [`packages/metrics-collector`](../../packages/metrics-collector).
- **OTel:** [`packages/otel-exporter`](../../packages/otel-exporter).
- **Cost tracker:** [`packages/cost-tracker`](../../packages/cost-tracker).
- **Vendor exporters:** [`packages/exporter-datadog`](../../packages/exporter-datadog), [`packages/exporter-honeycomb`](../../packages/exporter-honeycomb), [`packages/exporter-splunk`](../../packages/exporter-splunk), [`packages/exporter-newrelic`](../../packages/exporter-newrelic).
- **Default-subscriber wiring:** [`packages/runtime-core/src/observability.ts`](../../packages/runtime-core/src/observability.ts).
- **Module catalog reference:** §15, §27 (cost-tracker), §37 (vendor exporters) in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
