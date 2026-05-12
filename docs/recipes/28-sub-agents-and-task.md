# Recipe 28 — Sub-agents and the Task Tool

Spawn an **isolated** sub-agent from a parent agent's turn. The
sub-agent gets its own session, its own event log, its own state
store, and its own permission posture — but inherits the parent's
abort signal so SIGINT cascades down. The right tool for "delegate
this exploration without polluting my context."

You'd reach for sub-agents when:

- The parent agent wants to **explore something** (search the
  codebase, read 30 files, summarize) without those 30 file reads
  bloating its own context window.
- You want **stronger isolation** than crew — the child shouldn't
  see the parent's messages, tools, or memory.
- You want **parallel exploration** — three sub-agents each looking
  at different parts of a problem, returning summaries.

If the children need to talk to each other or back to the parent,
use [crew](04-multi-agent-crew.md) instead. Sub-agents are
**one-shot exploration**, not interactive collaboration.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.
- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md)
  for permission inheritance modes.

## The `Task` tool

The parent agent calls:

```typescript
Task({
  description: string,         // short label ("review the auth flow")
  prompt: string,              // full instructions for the sub-agent
  subagent_type?: string       // name of sub-agent definition; falls back to "general-purpose"
}) → string                    // the child's final message
```

Synchronous from the parent's perspective: the parent's turn pauses
until the child returns. The child returns its **final assistant
text** as the tool's output.

`description` is the short label — surfaced in trace events, audit
logs, and the parent's UI. `prompt` is the full briefing — what the
child should do, what to return, what constraints apply.

## Context isolation

[`packages/agent-context-isolation`](../../packages/agent-context-isolation)
creates a fresh `RunContext` for each spawn:

| Aspect              | Parent                                | Child                                    |
| ------------------- | ------------------------------------- | ---------------------------------------- |
| Run id              | `run_abc`                             | `run_def` (fresh, not derived)            |
| Session id          | `sess_abc`                             | `sess_def`                                |
| Event log path      | `.crewhaus/sessions/sess_abc.jsonl`   | `.crewhaus/sessions/sess_def.jsonl`      |
| State store         | Parent's keys                          | Empty                                     |
| Tools available     | Parent's tools                         | Per sub-agent definition (may be subset)  |
| Permission rules    | Parent's spec rules                    | Per inheritance mode (next section)       |
| Conversation history| Parent's full history                  | Empty (starts with `prompt`)              |
| Abort signal        | Parent's                                | Inherits via WeakRef                      |

**No mention of the parent's context** appears in the child's view.
The child sees only `prompt` — its instructions. So if the parent had
absorbed an injection from a malicious tool, the child can't see or
propagate it.

## The abort tree

Parent's abort signal cascades to children:

```
SIGINT
  └─ parent.abort()
     ├─ child-1.abort()
     ├─ child-2.abort()
     └─ child-3.abort()
```

But via **WeakRef** — if the parent is GC'd (which happens if the
parent's run finishes before the child does), the child can still
continue. So abandoned children don't pin parents in memory.

Siblings are **independent**: child-1's failure doesn't abort
child-2.

## Sub-agent definitions

`.crewhaus/sub-agents/<name>.md`:

```markdown
---
name: code-reviewer
description: Review changes for safety and correctness.
tools:
  - read
  - grep
  - bash
permissions:
  mode: scoped
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysAllow
      pattern: Grep
    - type: alwaysAsk
      pattern: Bash(**)
---

# Code reviewer

You are a code reviewer. The user (the parent agent) will send you a
PR or a diff to review. Read the changes carefully, look for:

- Untested branches
- Error handling gaps
- Security issues
- Style drift

Return a markdown checklist with file:line references. Do NOT make
edits — the parent will decide what to do with your review.
```

Frontmatter fields:

| Field         | Purpose                                                  |
| ------------- | -------------------------------------------------------- |
| `name`        | The sub-agent type. Referenced from `Task({subagent_type})`. |
| `description` | Short hint, used in `/help`-style listings.              |
| `tools`       | The child's tool whitelist (subset of catalog).          |
| `permissions` | Permission inheritance mode (next section).              |

Discovery order (same as skills): project → user → plugin.

## Permission inheritance modes

When a parent spawns a child, the child's permissions come from one
of three sources:

| Mode      | Effect                                                                       |
| --------- | ---------------------------------------------------------------------------- |
| `inherit` | Verbatim copy of parent's rules.                                              |
| `scoped`  | Filter parent's rules to only those whose `toolGlob` matches a child tool.   |
| Explicit  | Use the rules in the sub-agent definition's `permissions.rules:` block.       |

`scoped` is the sensible default for most sub-agents: the child gets
the parent's rules for tools it actually has, and no more.

**Bypass mode does not propagate.** Even if the parent runs in
`bypass` mode (which is only legal via the `--permission-mode` flag),
children get `default` mode unless their definition explicitly says
otherwise. The reasoning: bypass is a user-typed escape hatch; it
shouldn't be a hereditary property.

## The `RuntimeBridge` slot

Tools need a way to spawn children. The runtime stuffs a typed
bridge into `ToolExecuteContext.bridge` once per run; the Task tool
casts it to `RuntimeBridge`:

```typescript
interface RuntimeBridge {
  spawnSubAgent(opts: SpawnSubAgentOpts): Promise<SpawnResult>;
}
```

This indirection means the Task tool doesn't import `runtime-core`
directly — it gets the bridge through `ToolExecuteContext`. So the
tool is testable in isolation, and the runtime can substitute a mock
bridge for unit tests.

## Reading the parent's log

In the parent's session JSONL, sub-agent activity appears as
**boundary events** only, not the full child transcript:

```json
{ "kind": "sub_agent_start", "description": "review the auth flow", "childRunId": "run_def" }
{ "kind": "sub_agent_end", "childRunId": "run_def", "finalMessage": "..." }
```

The full child transcript lives in
`.crewhaus/sessions/sess_def.jsonl`. To follow a sub-agent's work,
grab the `childRunId` from the boundary event and read the child
log.

This keeps the parent's log readable — a 50-action child becomes one
boundary pair instead of 50 lines.

## Boundary classification on `finalMessage`

[`packages/sub-agent-spawner`](../../packages/sub-agent-spawner)
calls `classifyBoundary(finalMessage, { origin: "subagent" })` before
the message reaches the parent's `tool_result`. So a child that
absorbed an injection can't propagate the injection to the parent —
[Recipe 41](41-security-fabric.md) covers the mechanism.

## When to reach for sub-agents vs Handoff

| Need                                                                    | Right shape                            |
| ----------------------------------------------------------------------- | -------------------------------------- |
| Parent delegates exploration; child returns a summary.                  | Sub-agents (`Task`).                   |
| Roles take turns; each role sees the prior's output verbatim.            | [Crew](04-multi-agent-crew.md) (`Handoff`). |
| Roles ask each other clarifying questions.                              | Crew (`SendMessage`).                  |
| Child must NOT see parent's messages, tools, or state.                  | Sub-agents.                            |
| Parallel exploration of independent sub-questions.                       | Sub-agents (spawn 3 in parallel).      |
| Long-horizon goal with sub-questions; want citation discipline.         | [Research target](07-autonomous-research.md). |

Sub-agents are about **context isolation**; crew is about **role
collaboration**. Pick by what the workload needs.

## Parallel spawn

The Task tool is `concurrencySafe: true` — multiple `Task` calls in
one parent turn run in parallel:

```
[Task: review the auth flow]  → child-1 (running)
[Task: audit the database]    → child-2 (running)
[Task: check the tests]       → child-3 (running)
```

Each child is an independent `IsolatedContext` with no shared state.
The parent's turn pauses until **all three** return; the parent then
sees three tool results.

This is the cheap way to fan out exploration. For 30 sub-questions,
use a [batch worker](08-batch-worker.md) — sub-agents are best below
~10 in parallel.

## Running the smoke

```bash
bun run smoke:section-13
```

Spawns a parent CLI agent that calls `Task` against a `code-reviewer`
sub-agent definition. Validates isolation (parent context not visible
in child), abort cascade (SIGINT from parent stops the child), and
permission inheritance.

## Things that look like sub-agents but aren't

| Symptom                                                          | Better tool                                    |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| Need bidirectional message exchange.                              | [Crew](04-multi-agent-crew.md)                  |
| Need durable state across the "child" + HITL pauses.              | [Graph](05-stateful-graph.md) sub-graphs.       |
| Need 100s of children — fan-out per-item.                         | [Batch](08-batch-worker.md)                      |
| Need cross-deployment.                                            | [Federation](27-federation.md)                  |

## What to read next

- **Permissions inheritance details.** [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md).
- **Role-based collaboration.** [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md).
- **Cross-deployment sub-agent calls.** [Recipe 27 — Federation](27-federation.md).
- **Why sub-agent returns are classified.** [Recipe 41 — Security Fabric](41-security-fabric.md).

## Pointers to source

- **Context isolation:** [`packages/agent-context-isolation`](../../packages/agent-context-isolation).
- **Sub-agent spawner:** [`packages/sub-agent-spawner`](../../packages/sub-agent-spawner).
- **Permission inheritance:** [`packages/sub-agent-permission-inheritance`](../../packages/sub-agent-permission-inheritance).
- **Task tool:** [`packages/tool-task`](../../packages/tool-task).
- **Module catalog reference:** §13 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
