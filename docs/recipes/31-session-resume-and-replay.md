# Recipe 31 — Session Resume and Replay

> **Status:** stub.

## What you'll learn

Resume a prior chat session by id, replay the JSONL event log into a
fresh runtime, branch off a graph checkpoint to explore alternative
paths, and use Studio's trace-replay viewer to step through a past
run at 1×/2×/4× or raw speed.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).
- [Recipe 17 — Observability](17-observability.md) for the trace-event taxonomy.

## Roadmap

1. The session id format: `sess_<16 hex>`. One JSON metadata file plus one JSONL event log per session.
2. The append-only event log: `user_message | assistant_message | tool_use | tool_result | error | compaction`. Mode 0o600.
3. Resume path: `crewhaus run my-spec.yaml --resume <sessionId>` — runtime walks the JSONL, replays `user_message` + `assistant_message` events into a `MessageParam[]`, picks up at the next user turn.
4. Why the replay only walks the message events — tool spans are audit-only; replaying them would re-execute side effects.
5. Channel-bot session keying: deterministic `sess_<16hex>` derived from `sha256(routingKey)` so the same Slack thread always lands on the same session.
6. Branch-history (graph target only): `branchAt(graphRunId, checkpointId)` forks a prior state into a new RunnableGraph. `diff(graphRunIdA, graphRunIdB)` shows which nodes diverged.
7. Eviction: sessions older than 30 days are deleted on next `list()` (mtime-based; `touch -t YYYYMMDD0000 sess_*.json` forces expiry).
8. Studio trace-replay: pure helper `replay(events, { speed: 1|2|4|"raw" })` async-iterates events with timing relative to the first event, capped at 5 s per gap.

## Run it now

```bash
# Run a session, then resume it:
bun apps/cli/src/index.ts run examples/hello-cli/crewhaus.yaml
# (note the sess_… id printed at start; type a turn or two; ctrl-C)
ls .crewhaus/sessions/
bun apps/cli/src/index.ts run examples/hello-cli/crewhaus.yaml --resume sess_<hex>
```

## Pointers to existing material

- **Modules:** [`packages/session-store`](../../packages/session-store), [`packages/event-log`](../../packages/event-log), [`packages/branch-history`](../../packages/branch-history), [`packages/checkpoint-store`](../../packages/checkpoint-store), [`packages/trace-viewer`](../../packages/trace-viewer).
- **Catalog:** §10 (sessions/event-log), §19 (branch-history), §31 (trace-viewer v1 replay).

## Where to go next

- For graph-only state forking → [Recipe 05 — Stateful Graph](05-stateful-graph.md).
- For the Studio trace timeline → [Recipe 35 — Studio Walkthrough](35-studio-walkthrough.md).
