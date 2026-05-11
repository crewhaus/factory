---
test:
  spec: examples/hello-workflow/crewhaus.yaml
  bun_scripts:
    - compile:hello-workflow
    - run:hello-workflow
---

# Recipe 02 — Sequential Workflow

Compose a deterministic pipeline of single-turn LLM calls where each
step's output threads forward as the next step's user message. The
right shape when you want strict, reproducible "extract → transform →
format" behavior instead of an emergent chat agent.

You'd reach for this when:

- You want predictability over agentic flexibility.
- Each step has a clearly-bounded job with a clear handoff to the next.
- You want to swap models per step — a cheap one for extraction, a
  stronger one for synthesis.
- You don't need any of the things a chat REPL offers (mid-conversation
  follow-up, branching, hooks, memory).

If those properties don't fit, prefer [`graph`](05-stateful-graph.md)
(branches + HITL) or [`crew`](04-multi-agent-crew.md) (roles + peer
messaging).

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) so you know the
  single-turn semantics this shape leans on.
- A working Anthropic credential in `.env`.

## The smallest spec

The bundled example [`examples/hello-workflow/crewhaus.yaml`](../../examples/hello-workflow/crewhaus.yaml)
is two steps: list files, then summarize. The whole file:

```yaml
name: hello-workflow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: list-files
    instructions: |
      Use the bash tool to run `ls -la` in the current directory.
      Report what you find in 1-3 short sentences (file types, sizes, anything notable).
      Do not editorialize beyond what the listing shows.
    tools:
      - bash
  - name: summarize
    instructions: |
      You will receive the previous step's directory listing as context.
      Write a single-paragraph summary describing what kind of project this
      directory contains based on the files you see. Do not call any tools.
```

Note the differences from a CLI spec:

- `model:` is **top-level**, not nested under an `agent:` block.
  Workflows don't have a single agent — they have a sequence of steps.
- `steps:` replaces `agent.instructions`. Each step has its own
  `instructions`, and optionally its own `model` and `tools`.
- No `permissions:` block in this example, but you can add one — it
  applies uniformly across every step.

Compile and run:

```bash
bun run compile:hello-workflow
bun run run:hello-workflow
```

You'll see the first step's output stream, then the second step's
output stream. Two assistant messages, no user input in between.

## How "threading forward" actually works

After step N completes, the runtime takes its **terminal assistant
text** (the final block, ignoring any tool calls along the way) and
prepends a one-line marker, then injects that as a synthetic user
message into step N+1's history before calling the model.

Concretely, if step `list-files` ends with:

> ```
> The directory contains README.md, src/, package.json — a TypeScript project.
> ```

then step `summarize` opens with that text as its user message. The
step never sees the tool calls that produced it, only the final answer.

This is why workflow is **less** powerful than crew — there's no
back-and-forth, no peer messaging, no role-aware routing. Each step
sees only the prior step's conclusion.

It's also why workflow is **more** deterministic — given the same
input, the same step ordering, and the same model temperatures, you
get reproducible behavior.

## Step-level overrides

Each step inherits the workflow-level `model`, but you can override:

```yaml
name: extract-then-write
target: workflow
model: claude-sonnet-4-6
steps:
  - name: extract
    model: claude-haiku-4-5-20251001
    instructions: |
      Extract every TODO comment from the provided source code. List
      each as `<file>:<line>: <text>`. No prose; just the list.
    tools:
      - read
      - grep
  - name: prioritize
    instructions: |
      You will receive a list of TODOs. Pick the top 5 by impact and
      reorder them in priority order. Append a one-sentence rationale
      after each.
```

Two reasons to override per-step:

1. **Cost.** Extraction is a structural task where haiku is plenty;
   synthesis benefits from sonnet/opus. Per-step model swapping is the
   single biggest workflow cost lever.
2. **Provider.** You can route different steps to different providers
   — `openai/gpt-4o` for one step, `claude-sonnet-4-6` for the next,
   `local/llama3.2@http://localhost:11434/v1` for an offline
   sanity-check step. The model-router lazy-imports each adapter, so a
   workflow that uses one provider's model doesn't pay the cost of
   loading the others.

`tools:` at the step level whitelists which tools that step is allowed
to use. Omit the field and the step gets the workflow's tools (if any
are declared at the top level). The step in the example above lets
`extract` use `read` and `grep` but withholds them from `prioritize` —
that step works from the prior step's output alone.

## When the workflow ends

Each step is **one single-turn invocation**. Within a step, the model
can call tools as many times as it needs (the inner tool loop runs
until the model returns a turn with no tool calls). But the workflow
itself advances by exactly one step per assistant turn.

The runtime exits cleanly after the last step's terminal message. The
final assistant text is also printed to stdout — handy if you want to
pipe the workflow into another process.

## Reading the JSONL log

Like every other target, workflows write to `.crewhaus/sessions/sess_<id>.jsonl`.
Each step contributes:

- One `user_message` (the synthetic threading marker; or your prompt
  for the first step if you've extended the workflow to take stdin).
- One `assistant_message` with the step's tool calls and final text.
- Zero or more `tool_use` + `tool_result` pairs.
- Step boundary events are not currently distinct event kinds — you
  identify them by the synthetic-user-message marker text.

To inspect a run:

```bash
cat .crewhaus/sessions/sess_<id>.jsonl | jq -r 'select(.kind == "assistant_message") | .payload.content[-1].text'
```

That prints each step's terminal text on a separate line.

## When workflow is the wrong shape

| Symptom                                            | Use instead                                           |
| -------------------------------------------------- | ----------------------------------------------------- |
| You want a step to be able to ask a clarifying question of a peer. | [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md). |
| You want conditional edges (step 2 only if step 1's output matches X). | [Recipe 05 — Stateful Graph](05-stateful-graph.md). |
| You want to pause for human review between steps.  | [Recipe 05 — Stateful Graph](05-stateful-graph.md) with HITL nodes. |
| The "step" is really one open-ended question.      | [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md). |

## What to read next

- **One step but with tools.** [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md)
  covers tools, permissions, MCP, hooks, skills, slash commands — most
  of which apply to workflow steps too (skills + slash commands don't
  apply since there's no REPL; the rest do).
- **Workflow steps with state.** [Recipe 05 — Stateful Graph](05-stateful-graph.md)
  is the next step up the complexity ladder.
- **Per-step model swapping for cost.** [Recipe 32 — Local Models](32-local-models.md)
  shows how to route one step to a local OpenAI-compatible endpoint.
- **Test the workflow.** [Recipe 12 — Eval Harness](12-eval-harness.md)
  treats the whole workflow as a black box — input → final-step output.

## Pointers to source

- **Example:** [`examples/hello-workflow/crewhaus.yaml`](../../examples/hello-workflow/crewhaus.yaml).
- **Spec schema:** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts) (search for `workflowSchema`).
- **Codegen:** [`packages/target-workflow`](../../packages/target-workflow).
- **Runtime entry per step:** `runChatLoop({ singleTurn: true, seedMessages })` from [`packages/runtime-core/src/index.ts`](../../packages/runtime-core/src/index.ts).
- **Module catalog reference:** PR #11 row in [MODULE-CATALOG.md](../MODULE-CATALOG.md), under "Implemented".
