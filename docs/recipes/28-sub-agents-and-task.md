# Recipe 28 — Sub-agents and the Task Tool

> **Status:** stub.

## What you'll learn

Spawn an isolated sub-agent from a parent agent's turn. The sub-agent
gets its own session, its own event log, its own state store, and its
own permission posture — but inherits the parent's abort signal so
SIGINT cascades down. Used for "delegate this exploration without
polluting my context."

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).
- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md) for inheritance modes.

## Roadmap

1. The `Task(description, prompt, subagent_type?)` tool — what the model sees.
2. `agent-context-isolation`: fresh `RunContext` (new `runId` + `sess_<16hex>`), child event log under the same `sessionRootDir`, isolated state store.
3. The abort tree: parent's signal cascades to child via WeakRef so abandoned children don't pin parents; sibling-independent.
4. The `RuntimeBridge` slot — runtime stuffs a typed bridge into `ToolExecuteContext.bridge` once per run; the Task tool casts it.
5. Sub-agent definitions: `.crewhaus/sub-agents/<name>.md` with frontmatter (description, tools, permission inheritance).
6. Permission inheritance modes: `inherit` (verbatim copy), `scoped` (only rules whose toolGlob matches a child tool), `{allow, deny}` (explicit), with a bypass non-propagation guard.
7. The sub-agent's transcript: appended to the parent's log as `sub_agent_start` + `sub_agent_end` boundary events.
8. When to reach for sub-agents vs hand control via `Handoff` (crew) — context isolation vs role collaboration.

## Run it now

```bash
bun run smoke:section-13
```

## Pointers to existing material

- **Modules:** [`packages/agent-context-isolation`](../../packages/agent-context-isolation), [`packages/sub-agent-spawner`](../../packages/sub-agent-spawner), [`packages/sub-agent-permission-inheritance`](../../packages/sub-agent-permission-inheritance), [`packages/tool-task`](../../packages/tool-task).
- **Catalog:** §13.

## Where to go next

- For role-based collaboration (peer messaging, handoffs) → [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md).
- For cross-deployment sub-agent calls → [Recipe 27 — Federation](27-federation.md).
