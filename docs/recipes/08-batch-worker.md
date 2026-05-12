---
test:
  spec: examples/hello-batch/crewhaus.yaml
  bun_scripts:
    - compile:hello-batch
    - run:hello-batch
---

# Recipe 08 — Batch Worker

Run the agent as a queue consumer: each pulled job becomes one
single-turn `runChatLoop` invocation. Concurrency-bounded, visibility-
extended for long model calls, idempotency-keyed against duplicate
deliveries, and drained gracefully on SIGTERM. The right shape for
"process N tasks overnight" workloads.

You'd reach for `target: batch` when:

- You have **a queue of independent prompts** rather than a single
  long-running conversation.
- You want **horizontal scaling** — N worker processes pulling from
  the same queue.
- You want **at-least-once delivery with idempotent dedup** — a
  worker crash mid-job re-enqueues it; a duplicate hits cache instead
  of re-running.
- You want **graceful drains** — Kubernetes pod stop, AWS autoscaler
  scale-in, manual SIGTERM all let in-flight jobs finish before exit.

If your jobs need to coordinate (peer queries, shared state), use
[crew](04-multi-agent-crew.md) or [graph](05-stateful-graph.md). If
your goal is one long-horizon research task, use
[research](07-autonomous-research.md).

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics. Each job runs as a `singleTurn` call.
- A working Anthropic credential.

## The smallest spec

The bundled example [`examples/hello-batch/crewhaus.yaml`](../../examples/hello-batch/crewhaus.yaml)
is one agent, one in-memory queue, eight seeded jobs:

```yaml
name: hello-batch
target: batch
agent:
  model: claude-haiku-4-5-20251001
  instructions: |
    You are a batch worker. Each job's input is a short text prompt.
    Respond with a single concise sentence (<=20 words). Do NOT call
    any tools. End your turn after the one-sentence reply.
queue:
  adapter: in-memory
  visibilityTimeoutMs: 30000
  maxRetries: 3
  seedJobs:
    - "Say hello in one sentence."
    - "Name three primary colors in one sentence."
    - "Describe water in one sentence."
    - "Define recursion in one sentence."
concurrency: 4
idempotencyWindowMs: 60000
permissions:
  mode: default
```

The shape:

- **`agent:`** — same chat-loop spec as CLI. The job's input string
  becomes the user message of one single-turn call.
- **`queue:`** — adapter (in-memory / SQS / Redis / Postgres),
  visibility timeout, max retries. `seedJobs:` is in-memory only and
  is the convenient way to test a worker without a real queue.
- **`concurrency:`** — how many jobs run in parallel **per worker
  process**. Total throughput = `concurrency × worker count`.
- **`idempotencyWindowMs:`** — how long an idempotency key (the job
  hash) stays in the seen cache. Within that window, duplicate jobs
  return the cached result without re-invoking the model.

Run it:

```bash
bun run compile:hello-batch
bun run run:hello-batch
```

You'll see eight `job_start` / `job_end` event pairs interleaved (4 at
a time), then a `worker_idle` event when the queue drains, then the
worker exits.

## The pull loop

The worker runs in a loop:

1. **Pull.** `queue.pull(maxBatch = concurrency, visibilityTimeoutMs)`
   returns up to `maxBatch` jobs (newly visible). Visibility timeout
   makes them invisible to other workers for that window.
2. **Slot gate.** Each job claims one of `concurrency` slots
   (`Promise.race` against the slot pool). When a slot frees, the
   loop pulls again.
3. **Visibility extension.** A sidecar timer extends the visibility
   timeout every `visibilityRenewIntervalMs` (default 5s) while the
   handler runs. So a 90-second model call doesn't lose the job.
4. **Handler.** `runChatLoop({ singleTurn: true, input: job.body })`.
   The model's final text becomes the job result.
5. **Ack / nack.** On success, `queue.ack(job.id)` deletes it.
   On failure, `queue.nack(job.id, reason)` either re-enqueues
   (`reason: "transient"` / `"timeout"`) or routes to DLQ
   (`reason: "permanent"`).

The slot gate is the most important part of the design: it means the
worker is **never** pulling more jobs than it can hold. SQS-style
"max in flight" semantics are honored implicitly.

## Failure taxonomy

| Reason             | What it means                                                    | Default disposition           |
| ------------------ | ---------------------------------------------------------------- | ----------------------------- |
| `transient`        | Recoverable — provider rate limit, transient HTTP error.         | Re-enqueue with backoff.      |
| `timeout`          | Visibility renew failed (rare) or job exceeded `jobTimeoutMs`.  | Re-enqueue with backoff.      |
| `permanent`        | Schema validation failure, malformed input, agent error.         | Send to DLQ; don't retry.     |
| `max-retries`      | Job hit `maxRetries`; not really a separate reason, an outcome.  | DLQ.                          |

Backoff is exponential: 1s, 2s, 4s, ... up to `maxBackoffMs` (default
60s). Jitter is ±10%.

The `errors` module ([packages/errors](../../packages/errors))
classifies model and tool errors into these reasons. You can override
classification with the `worker.onError` hook.

## Idempotency

The idempotency key is `sha256(job.body + agent.model + agent.instructions)`
by default. A duplicate job (same body, same agent config) hits the
cache and returns the prior result without re-invoking the model.

When to override the default key:

- **You want per-tenant scoping.** Key by `(tenantId, body)` so the
  same body for tenant A and tenant B both run.
- **You want time-bucketed dedup.** Key by `(date, body)` so a daily
  digest runs once per day even if re-enqueued.

Override via spec:

```yaml
queue:
  idempotencyKey:
    expression: '"$tenantId:" + body'
```

The expression dialect is the same `state`-style language as the
graph target's edge predicates.

`idempotencyWindowMs` controls how long the result stays cached. For
"run once per day" workloads, set it to 25 hours so a re-enqueue
within the day hits cache.

## Concurrency tuning

A worker process with `concurrency: 4` makes 4 concurrent Anthropic
API calls. Anthropic's defaults allow this easily — but a fleet of
10 workers × `concurrency: 8` is 80 concurrent calls, which can hit
provider rate limits.

The right number depends on:

- **Provider limits.** Check Anthropic's organization rate limit.
- **Per-call latency.** If each call takes 20s, `concurrency: 4`
  yields 0.2 jobs/s per worker. To hit 10 jobs/s, you need 50 workers
  at `concurrency: 4` or 25 workers at `concurrency: 8`.
- **Memory budget.** Each in-flight job carries its tool result store
  + JSONL writer + classified-content cache. Typical footprint is
  ~5–10MB per slot. `concurrency: 32` is comfortable; `concurrency:
  256` is rough on a small node.

Start at `concurrency: 4`; tune based on observability data (Recipe
17 covers the metrics).

## Drain

On `SIGTERM`, the worker:

1. Stops pulling new jobs.
2. Emits a `drain_start` event.
3. Lets in-flight handlers complete their current chat turn.
4. Acks/nacks each finished handler.
5. Flushes the JSONL log and exits.

If you send `SIGKILL` instead, in-flight jobs become invisible until
their visibility timeout elapses, at which point another worker
re-pulls them. So data is never lost — at worst you pay for one extra
model call per killed job.

Kubernetes: set the pod's `terminationGracePeriodSeconds` to
`max(jobDuration) + 10s` so the controller waits for the drain.

## Going to a real queue

For production, swap the adapter:

### SQS

```yaml
queue:
  adapter: sqs
  queueUrl: $SQS_QUEUE_URL
  dlqUrl: $SQS_DLQ_URL
  region: us-east-1
  visibilityTimeoutMs: 60000
```

The worker reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from
env. For IRSA / instance profiles, set `AWS_REGION` and let the SDK
auto-discover credentials.

### Redis Streams

```yaml
queue:
  adapter: redis-streams
  url: $REDIS_URL
  stream: jobs:prod
  consumerGroup: workers
```

Redis Streams gives you consumer groups (multiple workers share work)
and at-least-once delivery via XACK.

### Postgres

```yaml
queue:
  adapter: postgres
  connectionString: $DATABASE_URL
  tableName: agent_jobs
```

Postgres is the cheapest "no extra infra" option — if you already
have Postgres in the stack, you can run a queue there with
`SELECT ... FOR UPDATE SKIP LOCKED`.

## Streaming worker events

The worker emits JSON to stdout (one event per line) when
`CREWHAUS_TRACE=json`:

```json
{ "kind": "worker_start", "concurrency": 4, "adapter": "in-memory" }
{ "kind": "job_start", "jobId": "1", "body": "Say hello..." }
{ "kind": "job_end", "jobId": "1", "outcome": "ok", "tokens": { "in": 24, "out": 12 } }
{ "kind": "drain_start" }
{ "kind": "drain_complete" }
```

Pipe to your log aggregator and you have minute-by-minute throughput
+ failure-rate visibility with no extra config.

## Things that look like batch but aren't

| Symptom                                                            | Wrong shape | Right shape                                       |
| ------------------------------------------------------------------ | ----------- | ------------------------------------------------- |
| One long-running conversation per "job".                           | batch       | [channel](03-slack-bot.md) keyed by user.         |
| Jobs that need to coordinate.                                      | batch       | [crew](04-multi-agent-crew.md) or [graph](05-stateful-graph.md). |
| One open-ended research goal split into sub-questions.             | batch       | [research](07-autonomous-research.md).            |
| Eval over a dataset.                                               | batch       | [eval](12-eval-harness.md) (built on the same primitives). |

The eval target is built on top of `target-batch-worker` — it's batch
with a grader on each job result. Useful to know if you find yourself
asking "should I use eval or batch": eval is batch + scoring.

## What to read next

- **Test the worker.** [Recipe 12 — Eval Harness](12-eval-harness.md)
  — the eval target reuses the batch primitives with graders.
- **Multi-tenant batches with per-tenant budgets.** [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- **Deploy as a k8s deployment.** [Recipe 24 — Docker and Helm](24-docker-and-helm.md).
- **Watch the worker.** [Recipe 17 — Observability](17-observability.md).

## Pointers to source

- **Example:** [`examples/hello-batch/crewhaus.yaml`](../../examples/hello-batch/crewhaus.yaml).
- **Codegen:** [`packages/target-batch-worker`](../../packages/target-batch-worker).
- **Queue protocol:** [`packages/queue-protocol`](../../packages/queue-protocol).
- **Consumer:** [`packages/queue-consumer`](../../packages/queue-consumer).
- **Idempotency:** [`packages/idempotency-keys`](../../packages/idempotency-keys).
- **Spec schema (batch variant):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts) (search `batchSchema`).
- **Module catalog reference:** §23 (BATCH), §30 (production adapters) in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
