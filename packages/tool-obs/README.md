# @crewhaus/tool-obs

Observability and cost, without a model turn. Sixteen tools in two clearly
separated halves: ten that work on a harness's **own** telemetry on local disk,
and six that query an **external** platform over an allow-listed API.

The separation is the point. The local tools open no socket and are flagged
`internal` with no I/O capability; the remote tools are flagged `external` with
`ioCapability: "network"`, so a spec can grant "look at your own logs" without
granting "talk to the internet".

```yaml
tools:
  - all-obs         # every tool below
  - -statusPagePost # ...except this one
```

## Local — a harness's own telemetry

`@crewhaus/event-log` writes one JSON object per line to
`.crewhaus/sessions/<sessionId>.jsonl`. Nine of these read it; one writes to it.

| Tool | What it does |
|---|---|
| `EventQuery` | A bounded, cursor-paged page of events, filtered by kind, time, run, session and one field predicate |
| `EventCounts` | Tallies by kind, by tool and by outcome — what this harness actually did |
| `ToolCallStats` | Per-tool calls, failures, mean, p50, p95 and max, most-failing first |
| `ErrorCluster` | Errors grouped by a normalised fingerprint, most frequent first, one example each |
| `RunTimeline` | One run's events in order with gaps and measured durations |
| `CostReport` | Tokens and cost by model, by UTC day and by run, priced with **your** rate table |
| `BudgetCheck` | Pure: spend against a budget, with threshold crossings |
| `SloEvaluate` | Pure: success rate, latency percentile or error budget against an objective |
| `IncidentBundle` | One failed run assembled into a contained JSON file a human can be handed |
| `EmitTraceEvent` | One custom event appended to a session log, so a tool-only run leaves a record the readers above pick up |

Every path goes through the same workspace containment as `@crewhaus/tool-fs`,
including the symlink-aware check, so an in-workspace link pointing at `/etc` is
refused. Every file is size-checked **on disk before a byte is read**, and every
parse is event-capped with a scan that holds one line at a time — a cap applied
after buffering is not a cap.

## Remote — an external platform

| Tool | What it does | Flags |
|---|---|---|
| `MetricsQuery` | A Prometheus-style instant or range query, returning labelled series | read-only |
| `LogsQuery` | A log-platform query, configured rather than vendored | read-only |
| `AlertList` | The alerts currently firing | read-only |
| `AlertAck` | Acknowledge one alert | destructive, justification-gated |
| `StatusPagePost` | Publish an incident update | destructive, justification-gated |
| `HealthProbe` | Check many endpoints under a concurrency cap and a required deadline | read-only |

The outbound posture is `@crewhaus/tool-http`'s, carried over rather than
re-derived: fail-closed origin allow-list (empty means deny all — there is no
allow-everything value), numeric SSRF classification of IP literals in every
encoding and of the DNS-resolved address, IP pinning so a rebinding resolver
cannot swap the target between the check and the socket, per-hop re-checks on
redirects, credential dropping the moment a hop leaves the origin the token was
minted for, and a deadline and byte cap on every request — including the DNS
step, which takes no signal of its own and would otherwise outlive the deadline
by the resolver's own timeout.

The allow-list is a *reachability* list and is wider than the platform the token
belongs to, so the token is scoped separately: it goes only to the origins the
spec configured as obs surfaces. `HealthProbe` can sweep every allow-listed
endpoint in a fleet without handing each one's operator the observability
credential, and says on each probe whether it carried one.

The token is a spec-declared environment variable **name**. A value that is not
shaped like a variable name, or that carries a known token prefix, is refused
without being echoed back — because if that fired, echoing it is the leak the
whole arrangement exists to prevent.

### Configuration

```yaml
tool_config:
  obs:
    allowed_origins: ["https://prom.example.com", "https://logs.example.com"]
    token_env: PROM_TOKEN          # the NAME, never the token
    auth_header: Authorization     # default
    auth_prefix: "Bearer "         # default
    metrics:
      base_url: https://prom.example.com
      path: /api/v1                # instant → /api/v1/query, range → /api/v1/query_range
    logs:
      base_url: https://logs.example.com
      path: /loki/api/v1/query_range
      result_path: data.result
      params:
        query: query
        start: start
        end: end
        limit: limit
        time_format: ns            # ms | s | ns | iso
    alerts:
      base_url: https://alerts.example.com
      path: /api/v2/alerts
    alert_ack:
      base_url: https://alerts.example.com
      path: /api/v2/alerts/{id}/ack
    status_page:
      base_url: https://status.example.com
      path: /v1/incidents
```

A per-candidate `tool_config.obs` block overrides the boot registration for the
duration of one call. An override is only ever read as a config **block**: a
non-object is ignored rather than treated as permission to widen anything.

## What these will not do

**They will not guess a price.** `CostReport` takes the rate table as an
argument. The `costUsdMicros` a run recorded is an artefact of the prices that
process happened to hold, and a model the runtime could not price at all is
recorded at zero cost with real tokens. Both figures come back side by side, and
any model with no row in your table is named in `modelsWithoutRate` rather than
quietly costed at nothing.

**They will not read the clock.** Nothing here calls `Date.now()` for a result.
A budget's elapsed fraction, an incident bundle's generation time and a metrics
query's evaluation instant are all inputs, because a tool that answered "how far
through the month are we" from the system clock returns a different answer for
the same log every time it runs. The single exception is `HealthProbe`'s
`latencyMs`, which is a measurement, and its description says so.

**They will not hard-code a vendor.** `MetricsQuery` speaks the Prometheus HTTP
API because that is a *format* — Thanos, Cortex, Mimir, VictoriaMetrics and
Grafana all serve it. Logs, alerts and status pages genuinely differ, so their
paths, parameter names and result paths come from the spec. A tool that guessed
would be right for one deployment and wrong for every other.

**They will not cluster by meaning.** `ErrorCluster` masks by *shape* — URLs,
uuids, timestamps, paths, prefixed ids, hex blobs, quoted strings and numbers
with their units. Two genuinely different problems whose messages differ only in
a number will land in the same group, which is exactly why a verbatim example is
carried on every group.

**They will not measure what the runtime did not.** `ToolCallStats` reads
durations from the `tool_stats` and `mcp_stats` mirrors only. A harness that ran
with advisor events disabled gets counts and `latencyUnavailable: true`, not an
estimate. Likewise a `RunTimeline` gap is the distance between two log lines and
is not the same as how long that step took; where the runtime measured the step
itself, `durationMs` carries the measured figure.

**They will not invent a percentile.** Percentiles are nearest-rank — the value
at `ceil(p/100 × n) − 1` of the ascending sample — so every figure returned is a
duration that was actually observed. Linear interpolation on six samples returns
a number nobody measured, which is the wrong answer to "how slow does this
actually get".

**They will not window over time.** `SloEvaluate` has no rolling window and no
multi-window burn-rate alerting; both need a clock. The caller decides which
observations make up the window and passes the counts.

**They will not resolve, close or silence an alert.** `AlertAck` acknowledges,
and only that. Resolving and silencing have different blast radii and are not
implemented here.

**They will not address an endpoint you did not ask for.** An id substituted
into a configured path template is percent-encoded, so `a/../b` stays one
segment — and `.` or `..` alone is refused outright, because those two encode to
themselves and the URL parser then *resolves* them: `/incidents/../updates` is
requested as `/updates`, which on most platforms is the collection. Whatever the
parser normalised, every substituted value is checked to still be in the path
that is actually sent.

**They will not let a filter widen a query.** `AlertList`'s `filter` adds
parameters; the spec's own `params` are written last and win, so a scope the
deployment declared cannot be overwritten from a tool call.

**They will not unpublish.** A `StatusPagePost` is public the moment it lands.

**They will not let a written line pass for a recorded one.** `EmitTraceEvent`
writes the runtime's own wire shape — `{ ts, version, kind, payload }` — because
a second shape is a line `RunTimeline` could not draw. But the kind is always
`custom.<name>`, a namespace no runtime kind can occupy (every kind in
`@crewhaus/event-log`'s union is bare `[a-z_]+`, with no dot), the payload
records whether a live run context supplied the attribution or the caller
merely claimed it, and the caller's own fields sit one level down under
`fields`. That nesting is load-bearing rather than tidy: `RunTimeline` sums
`durationMs` on every kind and `IncidentBundle` takes the first `specName` in
log order, and neither looks at the kind first — a caller-supplied
`durationMs` at the top level would enter a total documented as the runtime's
own measurement, and a `specName` would retitle somebody else's bundle.

**They will not write a character a reader cannot trust.** The text on an
emitted line arrived through a tool call, and it lands in a file a human reads
during an incident and a model re-reads on the next turn. Line breaks, escapes,
other control characters, Unicode line separators, bidirectional overrides and
zero-width characters are refused — by code point, with the refusal naming
which one and where — rather than escaped and left to render as a second entry
nobody wrote, as a terminal control sequence, or as a sentence whose displayed
order is not its written order. The rule covers every caller string, not just
the obvious one: the message, each field, the claimed `runId` (which `EventQuery`
renders inside a JSON payload, and JSON escapes control characters but not
U+202E or U+200B), and the `sessionId` and `dir` that become a FILENAME this
tool may create and a path it echoes back. A rule that held for the message and
not for the id would be the same trick through the door nobody guarded. The
name, the message, each field, the field count, the claimed `runId` and the
finished line are all capped; the line cap keeps one append inside the window
`@crewhaus/event-log` relies on for concurrent writers.

**They will not report a provenance nothing supplied.** `emittedFrom.runContext`
has three values, not two. The run context is read structurally — this package
takes no dependency on `@crewhaus/run-context` — so a runtime that renamed a
field hands the tool a carrier it can extract nothing from: that is `unusable`,
which is neither the `present` that would claim an attribution nor the `absent`
that would hide the carrier. An empty `runId` is no attribution either, because
`runIdOf` reads ids back through a non-empty check and every reader that filters
by run would disagree with a result that reported one.

**They will not silently complete somebody else's half-written line.** A
transcript cut short by a killed process ends mid-line. `EmitTraceEvent` reads
the last byte before appending and starts with a newline when it has to, so the
broken line stays broken and the new event stays an event, rather than being
swallowed by it.

## Determinism

Same inputs against the same world state, same bytes out. Listings are sorted
with a locale-free comparator, Prometheus series are re-sorted by label set so
two replicas answering the same query return the same bytes, nothing is random,
and two `IncidentBundle` runs over the same log produce byte-identical files. An
emitted event is the same bytes twice as well — its fields are written in
sorted order, and its timestamp is an argument, so the line does not depend on
the order a caller happened to spell an object or on when the call ran.
`HealthProbe`'s `latencyMs` and the live answers of a remote platform are the
world state, not the tool.
