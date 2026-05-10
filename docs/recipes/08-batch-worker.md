# Recipe 08 — Batch Worker

> **Status:** stub.

## What you'll learn

Run an agent as a queue consumer: each pulled job becomes a single-turn
`runChatLoop` invocation. Concurrency-bounded, idempotency-keyed,
visibility-extended for long model calls, drained gracefully on
SIGTERM. The right shape for "process N tasks overnight" workloads.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The `target: batch` spec — `agent`, `queue`, `concurrency`, `idempotencyWindowMs`.
2. Queue adapters: `in-memory` (dev/tests, supports `seedJobs`), SQS, Redis Streams, Postgres.
3. The pull loop: `Promise.race` slot gating, sidecar visibility extension, per-job idempotency cache.
4. Failure taxonomy: `transient` (return to pending), `timeout` (same), `permanent` (DLQ).
5. Backoff: exponential per attempt, max retries from spec.
6. Drain semantics: SIGTERM stops new pulls but lets in-flight handlers ack their result.
7. Streaming the worker's stdout JSON events (`worker_start | job_start | job_end | drain_start | …`).
8. Wiring a real SQS queue and a persistent idempotency store.

## Run it now

```bash
bun run compile:hello-batch
bun run run:hello-batch
```

## Pointers to existing material

- **Example:** [`examples/hello-batch/crewhaus.yaml`](../../examples/hello-batch/crewhaus.yaml) — 8 seeded jobs, in-memory queue, concurrency 4.
- **Codegen:** [`packages/target-batch-worker`](../../packages/target-batch-worker).
- **Modules:** [`packages/queue-protocol`](../../packages/queue-protocol), [`packages/queue-consumer`](../../packages/queue-consumer), [`packages/idempotency-keys`](../../packages/idempotency-keys).
- **Catalog:** §23 (BATCH), §30 (production queue adapters).

## Where to go next

- For autonomous goals instead of a flat job list → [Recipe 07 — Autonomous Research](07-autonomous-research.md).
- For multi-tenant scheduling with budgets and audit → [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- For deployment via Helm + Kubernetes → [Recipe 24 — Docker and Helm](24-docker-and-helm.md).
