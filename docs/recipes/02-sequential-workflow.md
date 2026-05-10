# Recipe 02 — Sequential Workflow

> **Status:** stub.

## What you'll learn

Compose a deterministic sequence of single-turn LLM calls where each
step's terminal output threads forward as the next step's user message.
Useful for "extract → transform → format" pipelines where you want
predictability over emergent behavior.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) (you'll see how single-turn mode works there).

## Roadmap

1. Why workflow ≠ crew: sequential steps with no roles, handoffs, or peer messaging.
2. The `steps:` array — `name`, `instructions`, optional per-step `model` and `tools`.
3. How the prior step's text becomes a synthetic user message for the next step.
4. Per-step model swap — using a cheap model for extraction, a stronger model for synthesis.
5. Per-step tool whitelisting (e.g. only step 1 gets `bash`).
6. Reading the JSONL event log to see one assistant_message per step.
7. When workflow is the wrong shape — prefer `graph` for branches and HITL.

## Run it now

```bash
bun run compile:hello-workflow
bun run run:hello-workflow
```

## Pointers to existing material

- **Example:** [`examples/hello-workflow/crewhaus.yaml`](../../examples/hello-workflow/crewhaus.yaml) — `list-files` → `summarize`.
- **Codegen:** [`packages/target-workflow`](../../packages/target-workflow).
- **Runtime:** uses `runChatLoop({ singleTurn: true, seedMessages })` from [`packages/runtime-core`](../../packages/runtime-core).
- **Catalog:** PR #11 in [MODULE-CATALOG.md](../MODULE-CATALOG.md) — `target-workflow`.

## Where to go next

- For branches, parallelism, HITL pauses, and durable checkpoints → [Recipe 05 — Stateful Graph](05-stateful-graph.md).
- For role-based collaboration with handoffs → [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md).
