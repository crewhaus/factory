---
test:
  spec: examples/hello-graph/crewhaus.yaml
  bun_scripts:
    - compile:hello-graph
    - run:hello-graph
---

# Recipe 05 — Stateful Graph

Build a graph of nodes that thread state through edges, can pause for
human review (HITL), and resume against a durable checkpoint. The
right shape when "what runs next" depends on what came before — not
on a fixed step order, and not on a model's free-form Handoff choice.

You'd reach for `target: graph` when:

- The flow has **conditional edges** ("if the plan needs approval, go
  to HITL; otherwise straight to execute").
- You want **HITL pauses** between nodes — the run sleeps until a
  human types yes/no, and resumes from there.
- You need **branching** — explore two alternative continuations from
  the same checkpoint and compare them later.
- You want **state to live outside the conversation** — a JSON object
  threading through every node, not just a model-readable history.

If you don't need durable state, conditional edges, or HITL, use
[crew](04-multi-agent-crew.md) (lighter-weight) or
[workflow](02-sequential-workflow.md) (deterministic).

<details>
<summary><strong>Architectural context</strong> — graph durability, checkpoint policy, and HITL</summary>

LangGraph and Microsoft Agent Framework are the two canonical
stateful-graph runtimes ([docs/AI-Harness-Systems.md](../AI-Harness-Systems.md)).
LangGraph exposes durable execution with three explicit durability
modes — `exit`, `async`, `sync` — and MAF centers graph workflows with
**checkpointing, streaming, time travel, and OpenTelemetry**. Every
design decision in this recipe maps to one of those primitives:

- **`checkpoint_policy: sync`** (the default for HITL-bearing graphs)
  writes the state snapshot *before* the runtime asks for a human
  decision. Switching it to `async` saves a handful of milliseconds
  per node but breaks the ability to safely pause for approval — the
  approver could decide while the snapshot is mid-flight, and a crash
  in that window loses the decision context. That's exactly the
  tradeoff LangGraph's durability docs flag as the reason
  `sync` exists.
- **`hitl:` on a node** is the harness-level analogue of LangGraph's
  `interrupt()` and MAF's checkpoint-pause primitive: the run
  serializes state, exits the process cleanly, and waits for an
  out-of-band resume signal. The runtime never holds a blocking
  process during a human review.
- **Conditional edges** map to LangGraph's `add_conditional_edges`. The
  IR variant `IrGraphV0` carries each edge's optional `when` predicate
  so the codegen target can lower to either an in-process router or a
  distributed orchestrator without changing the spec.

If you find yourself wanting graph features but not HITL, you can keep
`checkpoint_policy: async` and save the latency — but make the
decision deliberately, with the durability mode that fits the job, not
by default.

</details>

## Prerequisites

- [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md) for the
  multi-step orchestration baseline; graph is the next step up.

## The smallest spec

The bundled example [`examples/hello-graph/crewhaus.yaml`](../../examples/hello-graph/crewhaus.yaml)
has three nodes and one HITL pause:

```yaml
name: hello-graph
target: graph
model: claude-sonnet-4-6
entry: plan
nodes:
  plan:
    instructions: |
      You are the PLAN node. Read the user's input from upstream state
      and produce a 3-bullet plan. Return only the plan, no preamble.
  execute:
    instructions: |
      You are the EXECUTE node. Read the plan from upstream state's
      `plan` field. Produce concrete findings in 4–6 sentences.
    hitl:
      prompt: "Approve the plan and continue to execute?"
  summarise:
    instructions: |
      You are the SUMMARISE node. Read the plan and execute results
      from upstream state. Produce a 2-sentence executive summary.
edges:
  - from: plan
    to: execute
  - from: execute
    to: summarise
```

The shape:

- **`entry:`** picks the start node (just like crew).
- **`nodes:`** is a map of node name to definition. Each node has
  `instructions` and optionally `hitl`, `model`, `tools`.
- **`edges:`** is a list of `{ from, to }` pairs. They can be unconditional
  (default) or conditional (covered next).
- **`hitl:`** turns a node into a checkpoint. The runtime invokes the
  prompt, persists state, and waits for `--resume <runId> <decision>`
  on the CLI before continuing.

Run it:

```bash
bun run compile:hello-graph
echo "Should we adopt a 4-day work week?" | bun run run:hello-graph
```

The graph reads its input from stdin (the `input` field of the
upstream state seeds the `plan` node). Run it without piping anything
and the model receives an empty string — it'll still complete every
node, but the output is generic. You'll see the plan node print, the
execute node print, then the run **pauses** with the approval prompt.
Type a decision, press enter, and the execute + summarise nodes
complete.

## State threading

Every node receives the **accumulated state** of all upstream nodes
plus its own predecessors. Concretely the runtime constructs an
upstream JSON object before each node call:

```json
{
  "user_input": "Should we adopt Rust?",
  "plan": "1. Survey current Rust adoption.\n2. ...\n3. ...",
  "execute": "Findings: ..."
}
```

The model sees this as the node's user message. To write back, the
node's terminal assistant text becomes the **value** under the node's
own name (so `plan` writes back as `state.plan`, `execute` as
`state.execute`).

If you want a node to write **structured** state (an object, not a
string), opt into a `returns:` schema:

```yaml
nodes:
  plan:
    returns:
      type: object
      properties:
        items: { type: array, items: { type: string } }
        riskLevel: { type: string, enum: [low, med, high] }
    instructions: |
      Return JSON with { items: [...], riskLevel: "..." }.
```

The runtime validates the model's terminal text against the schema,
parses it, and writes the object into upstream state under
`state.plan`. Downstream nodes can read `state.plan.items[0]` etc.

If validation fails: one retry with the validation error as a system
reminder; if still failing, the node errors and the graph aborts with
the schema validation message in the JSONL log.

## Conditional edges

Edges can carry a `when:` predicate that's evaluated against the
current state:

```yaml
edges:
  - from: plan
    to: needs-review
    when: "state.plan.riskLevel == 'high'"
  - from: plan
    to: execute
    when: "state.plan.riskLevel != 'high'"
  - from: needs-review
    to: execute
```

The predicate language is a small expression dialect over the state
JSON: `==`, `!=`, `&&`, `||`, `!`, plus dotted-path reads. It's
intentionally **not** Turing-complete — no function calls, no loops.
If you need richer routing, lean on the structured-`returns:` schema
+ a downstream LLM-routing node, not a fancier edge language.

If multiple edges match, the runtime takes the **first matching edge
in declaration order**. If none match, the run aborts with a clear
"no outgoing edge satisfied for node X" error.

## HITL pauses

Adding `hitl:` to a node turns it into a checkpoint. When the node
finishes, the runtime:

1. Writes the current state + node history to
   `.crewhaus/checkpoints/run_<id>/checkpoint_<n>.json`.
2. Prints `hitl_pause` to stdout and `checkpoint_id: <ckpt>`.
3. Exits cleanly. The process **doesn't** sit on a TTY.

To resume:

```bash
bun run run:hello-graph -- --resume run_<id> "approved with edits"
```

The runtime loads the checkpoint, injects your decision as
`state.<node>.decision`, and continues to the next edge. The decision
string is opaque — node instructions decide what to do with it.

For a richer HITL surface (Slack approval, email-with-link), you
generally wrap the `hitl_pause` event with an external dispatcher
that, on approval, calls `crewhaus resume --decision approved <runId>`.

## Branching — exploring two continuations

From any checkpoint you can branch to compare alternatives:

```bash
bun run run:hello-graph -- --branch-from run_<id> checkpoint_2
```

This forks a new run id whose initial state is checkpoint 2, sharing
all upstream history. You can run both branches in parallel and
compare their `summarise` outputs.

The two branches share **no** in-memory state — each is a fresh process
with its own checkpoint history. They share only the immutable
upstream prefix. This is what makes branching safe: editing branch A's
state never bleeds into branch B's state.

`branch-history` (the catalog module) keeps a diff between branches —
`crewhaus diff run_<id> run_<branchedId>` shows which state keys
diverged and at which checkpoint.

## Tools per node

`tools:` is per-node:

```yaml
nodes:
  plan:
    tools: []                 # plan is closed-book; no tools
    instructions: |
      Produce a plan from the user's input.
  execute:
    tools:
      - read
      - bash
    instructions: |
      Execute the plan. Bash gates ask for permission.
  summarise:
    tools: []                 # closed-book again
    instructions: |
      Summarize the run.
```

A node with no tools is a closed-book reasoner — a useful pattern for
nodes that should reason about state without side effects.

`permissions:` applies graph-wide and is evaluated per tool call;
there's no per-node permission override (deliberately — keeping
permissions one layer flatter than tools).

## What the JSONL log looks like

```bash
SESSION=$(ls -t .crewhaus/sessions/sess_*.jsonl | head -1)
jq -c 'select(.kind | startswith("graph_"))' "$SESSION"
```

Graph-specific event kinds:

| Subkind            | Payload                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `graph_node_start` | `{ node, upstream }`                                               |
| `graph_node_end`   | `{ node, output }` (or `{ node, schemaError }`)                     |
| `graph_edge`       | `{ from, to, condition? }`                                          |
| `graph_hitl_pause` | `{ node, prompt, checkpointId }`                                   |
| `graph_resume`     | `{ checkpointId, decision }`                                       |
| `graph_done`       | `{ status: "ok" \| "aborted", reason? }`                            |

Together with the standard `user_message` / `assistant_message` /
`tool_use` events you can reconstruct exactly what happened: which
nodes ran, what state they read and wrote, which edges fired, which
HITLs were approved.

## Things that look like graph but aren't

| Symptom                                                            | Wrong shape | Right shape                                       |
| ------------------------------------------------------------------ | ----------- | ------------------------------------------------- |
| Linear ordering, no state, no HITL.                                | graph       | [workflow](02-sequential-workflow.md)             |
| Dynamic "who's next" without state across nodes.                   | graph       | [crew](04-multi-agent-crew.md)                    |
| Long-running streaming output — every node is one shot.            | graph       | [cli](01-cli-coding-agent.md) or a streaming workflow |
| Hundreds of nodes, fan-out per item.                               | graph       | [batch](08-batch-worker.md) (one job per item)     |

Graph shines for ≤ ~10 named nodes with a small directed graph between
them. Past that you usually want a different shape.

## Production knobs

- **Checkpoint directory.** `CREWHAUS_CHECKPOINT_DIR` env var overrides
  `.crewhaus/checkpoints/`. For multi-host deployments, point this at
  a shared volume (NFS) or use the S3 backend (catalog module
  `checkpoint-store-s3`, opt-in).
- **Idempotency keys.** Set `--idempotency-key <key>` on a resume to
  make re-runs of the same decision a no-op. Useful when the resume is
  triggered by an at-least-once webhook delivery.
- **Resumability guarantee.** A checkpoint is durable after the
  `graph_node_end` event flushes to disk. Resume always lands on the
  most recent durable checkpoint, never partway through a node.

## What to read next

- **One step up in capability.** [Recipe 27 — Federation](27-federation.md)
  — graph nodes that live on different deployments.
- **One step down in capability.** [Recipe 02 — Workflow](02-sequential-workflow.md)
  — if your edges are all unconditional and you don't need HITL.
- **Branching, evals, and replay.** [Recipe 31 — Session Resume and Replay](31-session-resume-and-replay.md).
- **Test the whole graph.** [Recipe 12 — Eval Harness](12-eval-harness.md)
  — treat the graph as a black box: input → final node's output.

## Pointers to source

- **Example:** [`examples/hello-graph/crewhaus.yaml`](../../examples/hello-graph/crewhaus.yaml).
- **Codegen:** [`packages/target-graph`](../../packages/target-graph).
- **Engine:** [`packages/graph-engine`](../../packages/graph-engine).
- **Checkpointing:** [`packages/checkpoint-store`](../../packages/checkpoint-store).
- **Branching:** [`packages/branch-history`](../../packages/branch-history).
- **Durable execution / idempotency:** [`packages/durable-execution`](../../packages/durable-execution).
- **Spec schema (graph variant):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts) (search `graphSchema`).
- **Module catalog reference:** §19 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
