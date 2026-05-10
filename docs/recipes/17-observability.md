# Recipe 17 — Observability

> **Status:** stub.

## What you'll learn

Wire up traces, metrics, OpenTelemetry, and vendor exporters
(Datadog, Honeycomb, Splunk, New Relic). Default is silent — every
surface opts in by env var so you only pay for what you use.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The `TraceEventBus` model: 15 event kinds (turn / model / tool / mcp / hook / compaction / permission / recovery / sub-agent boundaries) on a 5000-event ring buffer.
2. Default sinks: pretty-printed stderr (`CREWHAUS_TRACE=pretty`) or JSON Lines stdout (`CREWHAUS_TRACE=json`). `NO_COLOR` disables ANSI.
3. The persistent JSONL event log under `.crewhaus/sessions/<id>.jsonl` — written regardless of trace settings.
4. Metrics: counters (turns, tool calls, tokens, errors) and histograms (turn duration, tool duration, model time-to-first-token). Three sinks: stdout JSON, Prometheus textfile, HTTP `/metrics`.
5. OpenTelemetry: dependency-free OTLP/JSON exporter using `gen_ai/*` semantic conventions; `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` + `OTEL_SERVICE_NAME`.
6. W3C trace-context propagation: sub-agents and federation inherit `parent.bus.traceId` so OTel stitches one trace.
7. Vendor exporters: each auto-attaches when its API key env is set. Each ships a `scrubApiKey()` filter so credentials never leak into error messages or span attrs.
8. Cost tracking: `CREWHAUS_COST_TRACKING=1` emits `cost_accrual` events from `model_response`. Read totals via `crewhaus cost-summary --session <id>`.
9. Per-tenant cost annotation: `CREWHAUS_TENANT_ID=<id>` so the gateway can route cost attribution.

## Run it now

```bash
# Pretty trace on stderr:
CREWHAUS_TRACE=pretty bun run run:hello

# JSON trace on stdout:
CREWHAUS_TRACE=json bun run run:hello | jq

# Prometheus textfile:
CREWHAUS_METRICS=textfile:/tmp/crewhaus.prom bun run run:hello

# OTel:
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=my-agent \
  bun run run:hello
```

## Pointers to existing material

- **Modules:** [`packages/trace-event-bus`](../../packages/trace-event-bus), [`packages/structured-event-printer`](../../packages/structured-event-printer), [`packages/metrics-collector`](../../packages/metrics-collector), [`packages/otel-exporter`](../../packages/otel-exporter), [`packages/cost-tracker`](../../packages/cost-tracker).
- **Vendor exporters:** [`packages/exporter-datadog`](../../packages/exporter-datadog), [`packages/exporter-honeycomb`](../../packages/exporter-honeycomb), [`packages/exporter-splunk`](../../packages/exporter-splunk), [`packages/exporter-newrelic`](../../packages/exporter-newrelic).
- **Catalog:** §15, §27 (cost-tracker), §37 (vendor exporters).

## Where to go next

- For per-tenant audit trails → [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- For PII scrubbing of audited payloads → [Recipe 23 — PII Redaction and Encryption](23-pii-redaction-and-encryption.md).
- For gating canaries on regression metrics → [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
