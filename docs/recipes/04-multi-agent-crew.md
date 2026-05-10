# Recipe 04 — Multi-Agent Crew

> **Status:** stub.

## What you'll learn

Build a crew of specialist roles (researcher, writer, critic, …) that
hand control off via a `Handoff` tool and exchange peer messages via
an in-band `SendMessage`. All roles share one trace id, so the whole
crew renders as a single span tree.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the underlying chat-loop semantics.

## Roadmap

1. Why "crew" ≠ "workflow" — roles can address each other dynamically; workflows can't.
2. Spec shape: `entry`, `roles: { name: { instructions, model?, tools? } }`, optional `routing`.
3. The auto-injected `Handoff(target, reason)` tool — refusal-loop guard, recursion cap.
4. `SendMessage(target, payload)` for synchronous peer queries that return a string reply.
5. How `crew-orchestrator` threads `RunContext` so every activation lives under one trace id.
6. Routing: `match` rules (fast, deterministic) vs `llm` (slow, flexible).
7. Per-role tool whitelisting — researcher gets `WebSearch`, writer doesn't.
8. Reading the JSONL `crew_event` stream (`role_start | handoff | a2a_message | role_end | crew_done`).
9. When crew is the wrong shape — prefer `graph` for state, `workflow` for strict order.

## Run it now

```bash
bun run compile:hello-crew
bun run run:hello-crew
```

## Pointers to existing material

- **Example:** [`examples/hello-crew/crewhaus.yaml`](../../examples/hello-crew/crewhaus.yaml) — researcher → writer ↔ critic.
- **Codegen:** [`packages/target-crew`](../../packages/target-crew).
- **Modules:** [`packages/crew-orchestrator`](../../packages/crew-orchestrator), [`packages/agent-handoff`](../../packages/agent-handoff), [`packages/a2a-protocol`](../../packages/a2a-protocol).
- **Catalog:** §22.

## Where to go next

- For sub-agent isolation (parent spawns isolated children that can't see parent state) → [Recipe 28 — Sub-agents and the Task tool](28-sub-agents-and-task.md).
- For state across nodes + HITL pauses → [Recipe 05 — Stateful Graph](05-stateful-graph.md).
- For cross-deployment role calls → [Recipe 27 — Federation](27-federation.md).
