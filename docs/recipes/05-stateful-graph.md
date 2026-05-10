# Recipe 05 — Stateful Graph

> **Status:** stub.

## What you'll learn

Build a node/edge runtime where each node is an agent activation, edges
carry conditional control flow, and progress is checkpointed to disk so
you can pause for human review, resume after a crash, or branch off a
prior checkpoint to explore alternative paths (time travel).

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).
- Recommended: [Recipe 02 — Sequential Workflow](02-sequential-workflow.md) so the upgrade in expressiveness is concrete.

## Roadmap

1. Why graph: branches, parallelism, HITL pauses, durable resume.
2. Spec shape: `entry`, `nodes: { name: { instructions, hitl?, … } }`, `edges: [{ from, to, condition? }]`.
3. The `hitl.prompt` field — runtime pauses, persists a checkpoint, returns control.
4. Resuming via `runnable.resume(checkpointId, decision)`.
5. Time travel — `branchAt(graphRunId, checkpointId)` to fork a prior state.
6. Durable execution: idempotency keys per node prevent double-execution under crash-replay.
7. Streaming graph events — `node_start | node_end | edge_taken | branch | checkpoint | hitl_pause`.
8. Visualizing the live graph in Studio with state coloring.

## Run it now

```bash
bun run compile:hello-graph
bun run run:hello-graph
```

## Pointers to existing material

- **Example:** [`examples/hello-graph/crewhaus.yaml`](../../examples/hello-graph/crewhaus.yaml) — plan → execute (HITL) → summarise.
- **Codegen:** [`packages/target-graph`](../../packages/target-graph).
- **Modules:** [`packages/graph-engine`](../../packages/graph-engine), [`packages/checkpoint-store`](../../packages/checkpoint-store), [`packages/branch-history`](../../packages/branch-history), [`packages/durable-execution`](../../packages/durable-execution).
- **Visualizer:** [`packages/graph-visualizer`](../../packages/graph-visualizer).
- **Catalog:** §19.

## Where to go next

- For visual graph layout in the browser → [Recipe 35 — Studio Walkthrough](35-studio-walkthrough.md).
- For agentic crews instead of declared topology → [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md).
- For long-horizon autonomous goals (no edges, just a goal + budget) → [Recipe 07 — Autonomous Research](07-autonomous-research.md).
