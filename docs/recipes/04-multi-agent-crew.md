---
test:
  spec: examples/hello-crew/crewhaus.yaml
  bun_scripts:
    - compile:hello-crew
    - run:hello-crew
---

# Recipe 04 — Multi-Agent Crew

Build a crew of specialist roles — researcher, writer, critic — that
hand control off to each other via a `Handoff` tool and exchange peer
queries via `SendMessage`. The whole crew lives under one trace id, so
the run renders as a single span tree regardless of how many baton
passes happened.

You'd reach for `target: crew` when:

- One role isn't enough, but you want **emergent** routing rather than
  a fixed step order (the latter is [Recipe 02 — Workflow](02-sequential-workflow.md)).
- Roles need to ask each other clarifying questions (peer messaging).
- You want per-role tool whitelists — researcher gets `WebSearch`, the
  writer doesn't.
- You're okay paying the orchestration overhead (each handoff is a new
  model call) for the structural clarity.

If you want **state across nodes plus human-in-the-loop pauses**, use
[`graph`](05-stateful-graph.md). If you want **fully isolated child
agents** that can't see the parent's context, use [`Task` sub-agents](28-sub-agents-and-task.md).

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics each role runs on.
- A working Anthropic credential in `.env`.

## The smallest spec

The bundled example [`examples/hello-crew/crewhaus.yaml`](../../examples/hello-crew/crewhaus.yaml)
is three roles, one entry point:

```yaml
name: hello-crew
target: crew
model: claude-sonnet-4-6
entry: researcher
permissions:
  mode: default
roles:
  researcher:
    instructions: |
      You are the RESEARCHER. List 3 concise risks of the topic. Then
      call Handoff(target="writer", reason=...) and end your turn.
  writer:
    instructions: |
      You are the WRITER. You received a list of risks from the
      researcher. Write a 4-sentence summary post. If you need a
      sanity check, use SendMessage(target="critic", payload=...).
      Then end your turn.
  critic:
    instructions: |
      You are the CRITIC. When asked a question via SendMessage,
      give a one-sentence direct answer. Be terse.
```

Three things to notice:

1. **`entry:`** picks which role starts. Picking entry at the spec
   level avoids the "who goes first" coordination problem.
2. **`model:`** is top-level (like workflow), but **each role can
   override it** with a `model:` field — the researcher might use
   haiku for cheap structural work while the writer uses sonnet.
3. **No `routing:` block.** With three roles and `Handoff`, the model
   picks the next role dynamically. Adding deterministic routing is
   covered later.

Compile and run:

```bash
bun run compile:hello-crew
echo "Topic: rolling out vector-search to production" | bun run run:hello-crew
```

The crew daemon reads one prompt per line from stdin; if you run it
without piping anything it exits with `[crew] no input on stdin` and
status 2 (designed: no input → no turn). On a piped run you'll see the
researcher list risks, hand off to the writer, the writer
post-question the critic via SendMessage, and the final summary print.
Three model calls minimum, sometimes four if the writer pings the
critic.

## The two auto-injected tools

The crew target adds two tools to every role's tool set automatically.
You never declare them yourself — `crew-orchestrator` injects them
during codegen:

| Tool                         | Synchronous? | What it does                                                                   |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `Handoff(target, reason)`    | No           | Transfers control: the calling role ends; the target role starts a new turn.  |
| `SendMessage(target, payload)` | Yes        | Peer ask: the target role takes a turn and returns a string. The caller continues. |

`Handoff` is a one-way baton pass — the calling role doesn't resume.
`SendMessage` is request-reply — the calling role gets the answer
back and keeps going.

Per-role tool whitelisting still works:

```yaml
roles:
  researcher:
    instructions: |
      Use WebSearch to find recent academic sources.
    tools:
      - webSearch
  writer:
    instructions: |
      You only write. You receive a list from the researcher.
    tools: []   # writer can't search; it can only Handoff or SendMessage
```

The researcher's tool set is `{ WebSearch, Handoff, SendMessage }`;
the writer's is `{ Handoff, SendMessage }`. Each role's tool set is
visible to its model only — the writer never sees `WebSearch` in its
tool list.

## Recursion caps and refusal loops

Without bounds, a misbehaving model could `Handoff` to itself in an
infinite loop. `crew-orchestrator` enforces three caps
([packages/crew-orchestrator/src/index.ts](../../packages/crew-orchestrator/src/index.ts)):

| Cap              | Default | What it bounds                                                              |
| ---------------- | ------- | --------------------------------------------------------------------------- |
| `refusalDepth`   | 2       | Consecutive role refusals (target says "not my job") before stopping.       |
| `maxActivations` | 16      | Total role turns in the run, across all roles.                              |
| `maxA2ADepth`    | 3       | How deep peer-asks-peer recursion can go before SendMessage returns an error. |

Hit any of them and the run terminates with a clear error
(`HandoffRefusedError`, `MaxActivationsExceededError`,
`MaxA2ADepthExceededError`), the partial trace flushes, and the JSONL
log has a `crew_done` event with `status: "aborted"` and a reason.

Override per run on the CLI:

```bash
bun run run:hello-crew -- --max-activations 32 --refusal-depth 1
```

For a small crew you're unlikely to hit them. The caps exist so a
runaway loop fails loud instead of running up your Anthropic bill.

## How one trace id covers the whole crew

The runtime threads a single `RunContext` through every role
activation. Every model call, tool call, `Handoff`, and `SendMessage`
inherits that context's `traceId`, so:

- A Jaeger/Tempo trace view of the run renders every role's spans
  nested under one root span.
- The JSONL session log has one `sess_<id>` covering the whole crew
  rather than one per role.
- Cost reports attribute spend back to the entry role, with per-role
  breakdowns under it (see [Recipe 17](17-observability.md)).

To see it for yourself:

```bash
CREWHAUS_TRACE=json bun run run:hello-crew 2>&1 | jq -r '.traceId' | sort -u
```

You'll see one trace id printed many times. Drop into the JSONL log
afterwards:

```bash
tail .crewhaus/sessions/sess_*.jsonl | jq 'select(.kind=="crew_event")'
```

`crew_event` is a top-level event kind specific to the crew target:

| Subkind       | Payload                                       |
| ------------- | --------------------------------------------- |
| `role_start`  | `{ role, activationIndex }`                   |
| `handoff`     | `{ from, to, reason }`                        |
| `a2a_message` | `{ from, to, payload, reply }`                |
| `role_end`    | `{ role, finalText }`                         |
| `crew_done`   | `{ status: "ok" or "aborted", reason? }`      |

Walking those events in order is the right way to reconstruct who
did what — `tool_use` events alone won't tell you the role boundaries.

## Routing — when you want determinism

The default behavior lets the model pick the next target. For some
crews you want hard rules — e.g. "researcher always hands to writer;
writer always hands to critic". Add a `routing:` block:

```yaml
routing:
  - from: researcher
    to: writer        # deterministic edge: every researcher Handoff goes to writer
  - from: writer
    match:
      - if: "containsRegex:needs_review"
        to: critic
      - default: end   # writer's done; the run terminates after this turn
```

Two rule types:

- **`match:`** — fast, deterministic. The orchestrator runs each `if`
  predicate against the researcher's terminal message text in order
  and routes to the first match. `containsRegex:`, `equals:`, and
  `startsWith:` are the supported predicates.
- **`llm:`** — slow, flexible. The orchestrator makes a routing-only
  model call ("given the researcher's output, pick the next role from
  [writer, critic, end]"). Use when intent is too fuzzy for a regex
  rule.

If neither `match:` nor `llm:` rules cover the case, control falls
back to the model picking via Handoff (the default behavior). So you
can mix: hard rules for the common path, model choice for everything
else.

## Per-role models — the cost lever

Roles share the workflow-level model unless overridden:

```yaml
roles:
  researcher:
    model: claude-haiku-4-5-20251001     # cheap structural extraction
    instructions: |
      Extract 5 risks from the topic. Use only the user-supplied input.
  writer:
    model: claude-opus-4-7               # high-quality synthesis
    instructions: |
      Compose a brief from the researcher's risks.
  critic:
    model: claude-haiku-4-5-20251001     # fast review
    instructions: |
      Give a one-sentence critique.
```

The model-router lazy-loads each adapter, so a crew using opus + haiku
only pays the startup cost of those two — no Bedrock SDK loaded if no
role uses it.

The whole crew shape is most cost-effective when at least one role
uses a cheaper tier. If every role runs the same opus model the crew
is just a chat with extra orchestration.

## Things that look like crew but aren't

| Symptom                                                              | Wrong shape   | Right shape                                       |
| -------------------------------------------------------------------- | ------------- | ------------------------------------------------- |
| You want to call back to step N–1 after step N.                      | workflow      | crew or graph                                     |
| You want children that *can't see* the parent's context.             | crew          | [sub-agents (Task tool)](28-sub-agents-and-task.md) |
| You want state across all nodes and HITL pauses between them.        | crew          | [graph](05-stateful-graph.md)                     |
| You want each role to run on a different deployment / cluster.       | crew          | [federation](27-federation.md)                    |
| You only have one role; you just want planning + execution.          | crew          | [cli](01-cli-coding-agent.md) with TodoWrite      |

Crew is the sweet spot when you have **3–5 specialist roles** that
need **dynamic baton passing** and **per-role tool curation**, all
within **one shared trace**.

## Debugging a crew

The JSONL session log is the friendliest debug surface:

```bash
SESSION=$(ls -t .crewhaus/sessions/sess_*.jsonl | head -1)
jq -c 'select(.kind == "crew_event")' "$SESSION"
```

That's the role-by-role timeline. If a run aborted, look for the
final `crew_done` event — its `reason` field is the dispositive
diagnosis (refusal loop, activation cap, A2A depth, model error).

For deeper analysis, also look at `tool_use` events whose `name` is
`Handoff` or `SendMessage`. Their `input` carries the routing
decisions in the model's own words.

## What to read next

- **State + HITL between roles.** [Recipe 05 — Stateful Graph](05-stateful-graph.md)
  is the natural progression when "who goes next" depends on
  accumulated state, not just the last role's message.
- **Crew across deployments.** [Recipe 27 — Federation](27-federation.md)
  shows how to put roles on different hosts via mTLS-authenticated peers.
- **Cross-deployment without crew.** [Recipe 28 — Sub-agents](28-sub-agents-and-task.md)
  if you want isolated children rather than shared-context roles.
- **Watch a crew run.** [Recipe 17 — Observability](17-observability.md)
  — render the crew's span tree in Tempo/Jaeger.

## Pointers to source

- **Example:** [`examples/hello-crew/crewhaus.yaml`](../../examples/hello-crew/crewhaus.yaml).
- **Codegen:** [`packages/target-crew`](../../packages/target-crew).
- **Orchestrator:** [`packages/crew-orchestrator`](../../packages/crew-orchestrator).
- **Handoff tool:** [`packages/agent-handoff`](../../packages/agent-handoff).
- **Peer messaging:** [`packages/a2a-protocol`](../../packages/a2a-protocol).
- **Spec schema (crew variant):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts) (search `crewSchema`).
- **Module catalog reference:** §22 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
