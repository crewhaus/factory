# Getting Started with crewhaus-factory

> A guided tour for new users. Starts at first principles, drills down to
> data flow, and ends with a runnable agent on your machine.
>
> If you only have five minutes, jump to **[Your first agent in 60 seconds](#your-first-agent-in-60-seconds)**.

---

## Table of contents

1. [What this is, in one minute](#what-this-is-in-one-minute)
2. [The mental model](#the-mental-model)
3. [Your first agent in 60 seconds](#your-first-agent-in-60-seconds)
4. [The 12 target shapes](#the-12-target-shapes)
5. [Anatomy of a spec](#anatomy-of-a-spec)
6. [How data moves through the system](#how-data-moves-through-the-system)
7. [Debugging the compiler](#debugging-the-compiler)
8. [The CLI, end to end](#the-cli-end-to-end)
9. [The runtime directory](#the-runtime-directory)
10. [Tools, permissions, and skills](#tools-permissions-and-skills)
11. [Observability and cost](#observability-and-cost)
12. [Studio: the visual front door](#studio-the-visual-front-door)
13. [Going further](#going-further)
14. [Troubleshooting](#troubleshooting)

---

## What this is, in one minute

**crewhaus-factory is a meta-harness compiler.** You write one short YAML
file describing the agent you want — what model, what tools, what shape
of runtime. The compiler emits a self-contained TypeScript program that
you run with [Bun](https://bun.sh).

The same spec language can produce **twelve different runtime shapes** —
a CLI agent, a Slack bot, a multi-agent crew, a stateful graph with
human-in-the-loop, a multi-tenant managed daemon, a RAG pipeline, an
autonomous research worker, a queue consumer, a realtime voice service,
a browser-driving agent, an evaluation harness, or a sequential
workflow. The same compiler. The same runtime core. The same observability
and audit trails. Different output shapes.

> **Why this exists.** Today, every agent framework picks one shape and
> bakes it in. CrewAI is crews. LangGraph is graphs. Claude Code is a
> CLI. None of them let you switch shape without rewriting. crewhaus-factory
> separates the *spec* (your intent) from the *target* (how it runs), so
> you can move a working agent into a new shape — Slack today, voice
> tomorrow, batch worker the week after — by changing one line of YAML.

[`docs/MODULE-CATALOG.md`](MODULE-CATALOG.md) lists the ~190 modules
that compose into the runtime. You don't need to read it to use the
system; come back to it when you want to extend the system or when a
recipe links to a specific module.

---

## The mental model

Three layers, three pieces of vocabulary:

```
┌──────────────────────────────────────────────────────────────────┐
│  SPEC  (you write this)                                          │
│  crewhaus.yaml — name, target, model, tools, instructions, …    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼  parse + validate (Zod)
┌──────────────────────────────────────────────────────────────────┐
│  IR    (compiler-internal, you usually never see it)             │
│  IrNode = IrV0 | IrWorkflowV0 | IrChannelV0 | IrGraphV0 |       │
│           IrManagedV0 | IrPipelineV0 | IrCrewV0 | IrResearchV0 |│
│           IrBatchV0 | IrVoiceV0 | IrBrowserV0 | IrEvalV0        │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼  lower → emit (target-specific codegen)
┌──────────────────────────────────────────────────────────────────┐
│  BUNDLE (compiler writes this to disk)                           │
│  agent.ts (or daemon.ts + agent.ts + …) — runs on Bun.           │
│  Imports @crewhaus/runtime-core. No magic, no hidden runtime.    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼  bun dist/agent.ts
                         ┌─────────┐
                         │ AGENT   │   reads stdin, calls model, runs
                         │ RUNTIME │   tools, writes events to .crewhaus/
                         └─────────┘
```

**Key idea:** the bundle is a normal Bun TypeScript file. You can read
it. You can edit it. You can vendor it. You can ship it to a serverless
runtime. The compiler's job is to write *good code you could have
written by hand*, not to hide a framework.

---

## Your first agent in 60 seconds

Prerequisites: [Bun](https://bun.sh) ≥ 1.2 and an Anthropic credential.

```bash
# 1. Install the workspace
bun install

# 2. Tell it which credential to use (pick ONE)
echo 'ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-...' > .env   # Pro/Max OAuth
# echo 'ANTHROPIC_API_KEY=sk-ant-...'        > .env   # pay-per-token

# 3. Compile + run the smallest example
bun run compile:hello   # writes examples/hello-cli/dist/agent.ts
bun run run:hello       # opens an interactive REPL — type, get streaming reply, type "exit" to quit
```

That's the whole loop. The 5-line spec [`examples/hello-cli/crewhaus.yaml`](../examples/hello-cli/crewhaus.yaml)
became a real, runnable agent. Open the generated `examples/hello-cli/dist/agent.ts`
and read it — it's about fifty lines, no surprises.

> **Don't have a token?** Run `claude setup-token` if you're a Claude
> Pro/Max subscriber, or grab an API key from
> <https://console.anthropic.com/settings/keys>. The repo defaults to
> Claude; see [Going further → Other model providers](#other-model-providers) to use OpenAI / Gemini / Bedrock instead.

---

## The 12 target shapes

`target:` in your spec picks the shape. Each shape has its own minimal
example under `examples/hello-*/` and a recipe under
[`docs/recipes/`](recipes/) that walks you through using it for real.

### Pick your target — a short funnel

Twelve shapes is a lot to absorb at once. In practice almost everyone
starts from one of four entry points; the recipe for that entry point
is the right next read. Pick one and skip the rest until you need it:

| You want to build…                                              | Start here                                                                                | Then come back for                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **A local chat agent / coding companion** (laptop, dev, CI)     | [Recipe 01 — CLI Coding Agent](recipes/01-cli-coding-agent.md)                            | tools, permissions, MCP — section 10 below                        |
| **A bot that lives in a chat product** (Slack / Telegram / …)   | [Recipe 03 — Slack Bot](recipes/03-slack-bot.md) (Telegram/Discord/WhatsApp/iMessage at 37–40) | inbound classification — section 5 above + Recipe 41              |
| **A deterministic multi-step pipeline** (extract → transform → write) | [Recipe 02 — Sequential Workflow](recipes/02-sequential-workflow.md)                      | hooks + observability — Recipes 14 + 17                           |
| **A RAG / document-Q&A agent**                                  | [Recipe 06 — RAG Pipeline](recipes/06-rag-pipeline.md)                                    | eval-driven prompt tuning — Recipe 42                             |

**Pick `cli` first if you're unsure.** Every other shape adds something
on top of the chat loop, so `cli` is the right shape for learning the
runtime before reaching for the specialized ones — and the polymorphism
later is one YAML line, not a rewrite. Recipe 01 is the canonical first
read regardless of where you land; the chat-loop primitives every other
shape composes on top of are explained there.

### Full survey

The remaining eight shapes round out the runtime. Skim once for
breadth; return to the row that matches your problem when you need
it.

| `target:`     | What it is                                               | Smallest example                                                          | Recipe                                                                                       |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **`cli`**     | Streaming chat REPL. Tools, MCP, hooks, slash commands.  | [`examples/hello-cli`](../examples/hello-cli/crewhaus.yaml)               | [recipes/01-cli-coding-agent.md](recipes/01-cli-coding-agent.md)                             |
| **`workflow`**| Sequential steps; each step's output feeds the next.     | [`examples/hello-workflow`](../examples/hello-workflow/crewhaus.yaml)     | [recipes/02-sequential-workflow.md](recipes/02-sequential-workflow.md)                       |
| **`channel`** | Long-running daemon for Slack / Discord / Telegram / WhatsApp / iMessage. | [`examples/hello-channel`](../examples/hello-channel/crewhaus.yaml) | [recipes/03-slack-bot.md](recipes/03-slack-bot.md)                                           |
| **`crew`**    | Multiple roles, structured handoffs, peer messaging.     | [`examples/hello-crew`](../examples/hello-crew/crewhaus.yaml)             | [recipes/04-multi-agent-crew.md](recipes/04-multi-agent-crew.md)                             |
| **`graph`**   | Stateful nodes + edges, checkpointing, HITL pauses.      | [`examples/hello-graph`](../examples/hello-graph/crewhaus.yaml)           | [recipes/05-stateful-graph.md](recipes/05-stateful-graph.md)                                 |
| **`pipeline`**| RAG-style component DAG with retrieval.                  | [`examples/hello-rag`](../examples/hello-rag/crewhaus.yaml)               | [recipes/06-rag-pipeline.md](recipes/06-rag-pipeline.md)                                     |
| **`research`**| Long-horizon goal decomposition with citations.          | [`examples/hello-research`](../examples/hello-research/crewhaus.yaml)     | [recipes/07-autonomous-research.md](recipes/07-autonomous-research.md)                       |
| **`batch`**   | Queue consumer; one turn per pulled job.                 | [`examples/hello-batch`](../examples/hello-batch/crewhaus.yaml)           | [recipes/08-batch-worker.md](recipes/08-batch-worker.md)                                     |
| **`voice`**   | Realtime audio with VAD + barge-in.                      | [`examples/hello-voice`](../examples/hello-voice/crewhaus.yaml)           | [recipes/09-voice-agent.md](recipes/09-voice-agent.md)                                       |
| **`browser`** | Computer-use agent (chromium + click/type/screenshot).   | [`examples/hello-browser`](../examples/hello-browser/crewhaus.yaml)       | [recipes/10-browser-agent.md](recipes/10-browser-agent.md)                                   |
| **`managed`** | Multi-tenant gateway daemon with per-tenant budgets and audit. | [`examples/hello-managed`](../examples/hello-managed/crewhaus.yaml) | [recipes/11-managed-multitenant.md](recipes/11-managed-multitenant.md)                       |
| **`eval`**    | Benchmark harness — dataset + graders + report.          | [`examples/hello-eval`](../examples/hello-eval/crewhaus.yaml)             | [recipes/12-eval-harness.md](recipes/12-eval-harness.md)                                     |

---

## Anatomy of a spec

The smallest possible spec is five lines. Read it for the shape; we
add a `permissions:` block before introducing tools (next snippet)
because **every spec that ever calls a tool should make a permission
decision explicit** — a defaulted-away permission rule is the
single most common source of "my agent did something I didn't expect"
in production. The chat-only smallest example skips it (there are no
tool calls to gate), but treat that as the exception, not the
template.

```yaml
# examples/hello-cli/crewhaus.yaml
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a helpful, concise assistant. Reply in two sentences or fewer
    unless the user asks for more detail.
```

Once the agent has any tools, the next thing the spec should declare
is its permission posture. The minimal addition is a `permissions:`
block with `mode:` set explicitly — even leaving `rules: []` empty
tells the runtime "I have thought about this and I want the default
ask-on-destructive behaviour." That single declaration is what stops
a new contributor from copy-pasting a spec and accidentally inheriting
a permission posture they didn't choose:

```yaml
name: hello-with-tools
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: You read files and answer questions about them.
tools:
  - read          # safe — gated by permissions.rules below
permissions:
  mode: default   # default | plan | auto | bypass (bypass: CLI-flag only)
  rules:
    - { type: alwaysAllow, pattern: Read }
```

The four modes are explained in
[Tools, permissions, and skills](#tools-permissions-and-skills); the
short version is `default` allows read-only, asks for destructive,
which is the right shape for an interactive CLI. The lift from the
five-line spec is one block — typing it out is the point. It is the
moment in your learning where you internalise that **every tool call
crosses a permission boundary**, and that boundary is named in
the spec rather than hidden in framework defaults.

For internet-exposed targets (`channel`, `managed`) the lift is one
more idea on top: inbound text from Slack / Telegram / Discord /
WhatsApp / iMessage / federation peers is *untrusted content* even
after the adapter has cryptographically verified the sender, and the
recipes for those targets show where to wire the `classifyBoundary`
fabric call. See
[Recipe 03 — Slack Bot, Step 6](recipes/03-slack-bot.md#step-6--classify-untrusted-inbound-text-security-primer)
and [Recipe 41 — Security Fabric](recipes/41-security-fabric.md) once
you reach that target shape.

### Trust boundaries at a glance

The whole security posture of the system is one sentence: **every
piece of content entering the model's context has a `TrustOrigin`,
and crossing a trust boundary means calling `classifyBoundary` first.**
Authentication (mTLS, Slack signatures, JWTs) verifies *who* sent
something; classification verifies *what* the content contains. They
are different problems and require different primitives.

The seven boundary sites the runtime classifies today, with the
package that wires each one and the severity policy a malicious
verdict triggers by default:

| Site                                 | `TrustOrigin`  | Severity default | Wired in                                                                                              |
| ------------------------------------ | -------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| MCP tool responses                   | `"mcp"`        | `block`          | [packages/tool-mcp](../packages/tool-mcp)                                                             |
| Sub-agent `finalMessage`             | `"subagent"`   | `block`          | [packages/sub-agent-spawner](../packages/sub-agent-spawner)                                           |
| Inbound channel text                 | `"channel"`    | `block`          | `packages/channel-adapter-*` (Slack / Telegram / Discord / WhatsApp / iMessage)                       |
| Federation peer payloads             | `"federation"` | `block`          | [packages/federation-router](../packages/federation-router)                                           |
| Skill bodies loaded from disk        | `"skill"`      | `block`          | [packages/skills-registry](../packages/skills-registry)                                               |
| Compaction summaries                 | `"compaction"` | `block`          | [packages/compaction-autocompact](../packages/compaction-autocompact)                                 |
| Tool results (the §18 baseline path) | `"tool"`       | `block`          | [packages/runtime-core](../packages/runtime-core) — `applyInjectionClassification`                    |
| Direct CLI input                     | `"user"`       | `pass`           | (the developer typing) — the developer *is* the user in a CLI context                                 |

A `cli` spec only goes near `"user"` (and `"tool"` once it has any
destructive tools). A `channel` spec adds `"channel"` and any
`"mcp"` it uses. A `managed` spec adds `"federation"` if it peers.
You don't have to engage with every row of the table on day one;
the table is here so when a runtime trace says `boundary: mcp,
action: redact` you know immediately which package made the call.

[Recipe 41 — Security Fabric](recipes/41-security-fabric.md) walks
two threat scenarios (malicious MCP, poisoned sub-agent) end-to-end
and is the contributor checklist for adding a new boundary site.

Adding tools, permissions, and an MCP server brings you to a
production-shaped CLI:

```yaml
name: my-coding-agent
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You help with TypeScript. Read files before editing.
  tools:
    - read         # filesystem read
    - write        # filesystem write
    - edit         # filesystem edit
    - bash         # shell exec (sandboxed working dir)
permissions:
  mode: default   # default | plan | auto | bypass
  rules:
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysAllow, pattern: Write(**/src/**) }
    - { type: alwaysAsk,   pattern: Bash(**) }
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

Different `target:` values unlock additional top-level fields. A
`channel` spec adds `channels:` and `routing:`. A `crew` spec replaces
`agent:` with `roles:` and `entry:`. A `graph` spec adds `nodes:` and
`edges:`. The smallest example for each shape is the best reference —
they're all under `examples/hello-*/`.

The full Zod schema lives in
[`packages/spec/src/index.ts`](../packages/spec/src/index.ts) — when
the compiler tells you a field is wrong, that's the file to consult.

---

## How data moves through the system

This is the part most worth understanding. Once you have it, every
recipe and every error message will read clearly.

### Compile time

```
crewhaus.yaml
     │
     ▼  spec-parser   ──► YAML.parse
     │
     ▼  spec-validator ──► Zod schema (rejects unknown keys)
     │
     ▼  ir-model      ──► spec → IrNode (discriminated union on `target`)
     │
     ▼  ir-passes     ──► dead-tool elim, MCP dedupe, permission canonicalize
     │
     ▼  compiler-core ──► dispatch on ir.target
     │                       cli      → emitCli
     │                       channel  → emitChannelBot
     │                       crew     → emitCrew
     │                       graph    → emitGraph
     │                       …
     │
     ▼  target-<shape>-bundle ──► writes one or more .ts files
                                 (`agent.ts`, sometimes `daemon.ts`,
                                 `gateway.ts`, `session-router.ts`,
                                 `agent_<role>.ts`, etc.)
```

The output is plain TypeScript that imports `@crewhaus/runtime-core`.
No code-generation magic — open it and read it.

### Run time, one turn

```
            ┌─────────────────────────────────────────────────────┐
            │ ENTRY                                               │
            │ Stdin (cli), HTTPS webhook (channel), queue pull    │
            │ (batch), spec.goal (research), telephony adapter    │
            │ (voice), CLI --prompt (browser).                    │
            └─────────────────────────────────────────────────────┘
                                   │
                                   ▼
            ┌─────────────────────────────────────────────────────┐
            │ runChatLoop({model, instructions, tools, …})        │
            │   from @crewhaus/runtime-core                       │
            └─────────────────────────────────────────────────────┘
                                   │
                                   ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │ turn-state-machine: NeedModel → NeedTools → NeedCompaction        │
   │                     → NeedRecovery → Done                         │
   └───────────────────────────────────────────────────────────────────┘
        │             │                │                │
        ▼             ▼                ▼                ▼
   ┌────────┐    ┌─────────┐    ┌──────────┐     ┌──────────┐
   │ MODEL  │    │ TOOLS   │    │ COMPACT  │     │ RECOVER  │
   │ adapter│    │ executor│    │ snip +   │     │ from     │
   │ (router│    │ split:  │    │ auto-    │     │ provider │
   │  picks │    │ parallel│    │ compact  │     │ errors   │
   │ based  │    │ for safe│    │ when     │     │ (rate    │
   │ on     │    │ ops,    │    │ context  │     │ limit,   │
   │ model  │    │ serial  │    │ near 85% │     │ over-    │
   │ prefix)│    │ for     │    │ of limit │     │ load,    │
   │        │    │ destruc-│    │          │     │ prompt   │
   │ stream │    │ tive.   │    │          │     │ too long │
   │ events │    │ Permis- │    │          │     │ )        │
   │        │    │ sion    │    │          │     │          │
   │        │    │ check   │    │          │     │          │
   │        │    │ each.   │    │          │     │          │
   └────────┘    └─────────┘    └──────────┘     └──────────┘
        │             │                │                │
        └─────────────┴────────────────┴────────────────┘
                      │
                      ▼
            ┌─────────────────────────────────────────────────────┐
            │ TraceEventBus                                       │
            │ pre-tool / post-tool / pre-model / post-model /     │
            │ pre-compact / model_stream_token / tool_use /       │
            │ tool_result / cost_accrual / error / recovery /     │
            │ permission_decision                                 │
            └─────────────────────────────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
       ┌───────────┐         ┌───────────┐       ┌───────────┐
       │ event-log │         │ printer   │       │ otel-     │
       │ (.jsonl on│         │ (stderr,  │       │ exporter  │
       │  disk)    │         │ pretty or │       │ + vendor  │
       │           │         │ JSON)     │       │ adapters  │
       └───────────┘         └───────────┘       └───────────┘
                                                       │
                                                       ▼
                                                 Datadog / New Relic
                                                 / Honeycomb / Splunk
```

### What each phase actually does

1. **NeedModel.** runtime-core builds a request from the seed messages
   plus any prior turn's history, hands it to the provider adapter the
   `model-router` picked from your `model:` string, and consumes the
   stream. Tokens flow through `model_stream_token` events as they
   arrive — that's how you see streaming output in the REPL.

2. **NeedTools.** If the model asked to call tools, the
   `tool-orchestrator` looks at each tool's flags and splits the calls
   into a concurrent batch (read-only, idempotent) and a serial list
   (destructive, side-effecting). Each call goes through the
   `permission-engine` first; in `default` mode, destructive tools
   require either an `alwaysAllow` rule or interactive approval.
   Outputs over 10 KB spill to `.crewhaus/tool-results/` and the model
   sees a preview + a path.

3. **NeedCompaction.** When the prompt is past 85% of the model's
   context window, runtime-core first tries `snip` (drop middle
   messages, keep tool-use/result pairs intact), and if that's not
   enough, calls `autocompact` (have the model summarize older history
   into a single assistant message). The next user turn appends
   naturally onto the compacted prefix.

4. **NeedRecovery.** Provider errors are taxonomized — `prompt_too_long`
   triggers compaction, `overloaded` retries with exponential backoff,
   `invalid_request` tombstones the turn. You almost never see this
   layer; when you do, the trace event tells you what happened.

5. **Done.** The terminal assistant text is returned (single-turn mode)
   or printed and the REPL waits for the next user input.

Every event lands in the in-process `TraceEventBus`. The default
subscribers persist to a JSONL file under
`.crewhaus/sessions/<id>.jsonl`, and — if the right env var is set —
also pretty-print to stderr and forward to OTel.

### Resuming and replaying

Every session has an id (`sess_<16 hex>`). The CLI can resume one with
`crewhaus run my-spec.yaml --resume <sessionId>` — the runtime replays
the event log into a `MessageParam[]` and picks up where it left off.
Studio reads the same JSONL to render its trace timeline.

---

## Debugging the compiler

The diagram above is honest about *what* happens; this section is
about *where to look* when the agent does something you didn't expect.
A 50-line YAML lowers into multi-hundred-line generated TypeScript
running against a runtime built from ~190 modules — that's a lot of
distance between your intent and the running program. The system
ships three compiler-equivalents-of-debugging-symbols that keep the
distance crossable:

1. **`crewhaus compile --emit-ir`** — print the intermediate
   representation as JSON, *before* code generation runs. This is the
   middleman of the whole pipeline. It shows you exactly what the
   compiler decided your spec means after `lower()` normalised it
   (sub-agent maps flattened to arrays, role names alphabetized,
   secrets rewritten as env-var references, permission rules deduped
   and reordered).
2. **`.crewhaus/sessions/<id>.jsonl`** — the durable append-only
   conversation transcript. Each line is one structural event:
   `user_message`, `assistant_message`, `tool_use`, `tool_result`,
   `compaction`, `error`, `sub_agent_*`, `role_*`, `handoff`,
   `a2a_message`, `crew_done`. This is what `crewhaus run --resume`
   replays and what Studio renders as a session timeline. It is *not*
   the full runtime stream — finer-grained signals (per-tool start /
   end, permission decisions, model requests, cost accrual) live in
   the in-process bus and only land here if they're in that
   structural set.
3. **`CREWHAUS_TRACE=json` / `pretty`** — the in-process
   `TraceEventBus` exported live as JSON Lines on stdout (or
   colour-coded events on stderr). This is the post-execution
   counterpart to `--emit-ir`: the IR tells you what the compiler
   emitted; the trace stream tells you what that emission actually
   *did*, at the granularity of every model request, every tool call,
   every permission decision, every hook firing, every compaction
   trigger, every cost accrual. The same stream feeds the
   `otel-exporter` and the vendor adapters listed in
   [Observability and cost](#observability-and-cost).

When you're chasing a "why did the runtime decide X?" question, the
trace stream is the source. When you're reconstructing what the agent
*said* and *did*, the JSONL is the source. The IR is the source for
"what does the compiler think my spec means."

### Inspecting the IR before codegen

```bash
# Print the IR as JSON to stdout
bun apps/cli/src/index.ts compile examples/hello-cli/crewhaus.yaml --emit-ir

# Or write it to disk for diffing across spec edits
bun apps/cli/src/index.ts compile examples/hello-cli/crewhaus.yaml \
    --emit-ir -o /tmp/hello-ir
diff <(jq -S . /tmp/hello-ir-before/ir.json) \
     <(jq -S . /tmp/hello-ir/ir.json)
```

The output is a typed JSON value matching one of the twelve `IrNode`
variants listed under [The mental model](#the-mental-model). The
`target` field tells you which variant you're looking at; everything
else is what that target's emitter will receive verbatim. **If a
field is missing from the IR, the target can't reference it** —
that's the discriminated-union invariant the compiler enforces.

This is the fastest way to answer questions like:

- "Did my `$SLACK_BOT_TOKEN` reference lower to an env-var read, or
  did the compiler bake a literal into the bundle?" → Look for
  `"botToken": { "kind": "env", "name": "SLACK_BOT_TOKEN" }` in the
  IR. If `kind` is `"literal"`, your `$` prefix is malformed (env
  refs match `^\$[A-Z_][A-Z0-9_]*$` only).
- "I have three `alwaysAllow` rules for `Read` — did dedup keep them
  all?" → The IR's `permissions.rules` shows the canonical, deduped
  set. If a rule you wrote is missing, an earlier rule subsumed it.
- "Why doesn't my new MCP tool show up in the bundle?" → If the IR
  doesn't list it under `mcp_servers`, the spec didn't parse it (most
  often: a YAML indentation mistake silently put the block at the
  wrong nesting level).

### Reading the JSONL transcript

The JSONL is the durable record of the conversation. Each line wraps
its payload in a small envelope — `{ ts, version: 1, kind, payload }`
— so subscribers can fan out on `kind` and migrate on `version`
without re-parsing. The `kind` values are deliberately structural;
the full list is in [packages/event-log/src/index.ts](../packages/event-log/src/index.ts).

```bash
# 1. Find the session id — the run prints it on the first line of stderr.
ls -t .crewhaus/sessions/ | head -2

# 2. Look at the last few events of the failing turn.
tail -n 20 .crewhaus/sessions/sess_<id>.jsonl | jq -c .

# 3. See every tool the assistant invoked, regardless of outcome.
jq -c 'select(.kind == "tool_use") | {tool: .payload.name, args: .payload.input}' \
   .crewhaus/sessions/sess_<id>.jsonl
```

| Question the JSONL can answer            | Filter                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| What did the user actually type?         | `select(.kind == "user_message")`                                               |
| Which tools did the assistant call?      | `select(.kind == "tool_use") \| .payload.name`                                  |
| Did a tool error or succeed?             | `select(.kind == "tool_result") \| {is_error: .payload.is_error, content: .payload.content}` |
| Was anything compacted out of context?   | `select(.kind == "compaction") \| .payload.subKind`                             |
| Did the run hit an unrecoverable error?  | `select(.kind == "error")` — the `payload.recoverable` field tells you whether it tombstoned the turn. |
| Did a sub-agent run?                     | `select(.kind == "sub_agent_start" or .kind == "sub_agent_end")`                |

### Reading the live trace stream

The events the JSONL doesn't capture — `permission_decision`,
`model_request` / `model_response`, `tool_call_start` /
`tool_call_end`, `hook_fired`, `compaction_fired`, `cost_accrual`,
`error_recovered`, the boundary classifier outcomes — flow through
the in-process `TraceEventBus`. Set `CREWHAUS_TRACE=json` and the
stream lands as one JSON object per line on stdout; redirect it to
disk if you want the same kind of after-the-fact `jq` filtering you'd
do on the JSONL.

```bash
# Capture the full trace stream for the run.
CREWHAUS_TRACE=json bun run run:hello 2> hello.stderr > hello.trace.jsonl

# Find permission decisions the engine made during the run.
jq -c 'select(.kind == "permission_decision")' hello.trace.jsonl
```

A `permission_decision` event has the shape defined in
[packages/trace-event-bus/src/types.ts:138](../packages/trace-event-bus/src/types.ts) —
an envelope (`runId`, `sessionId`, `turnNumber`, `traceId`, `spanId`,
`timestamp`) plus the event-specific fields:

```json
{
  "runId": "run_8a7d6f5e4c3b2a19",
  "sessionId": "sess_3f9c2b1a8e7d6c5b",
  "turnNumber": 2,
  "traceId": "4c1b6d8e9f0a2b3c4d5e6f7a8b9c0d1e",
  "spanId": "a1b2c3d4e5f60718",
  "parentSpanId": "f0e1d2c3b4a59687",
  "timestamp": "2026-05-13T17:42:11.013Z",
  "kind": "permission_decision",
  "toolName": "Write",
  "decision": "ask",
  "mode": "default"
}
```

`decision: "ask"` with **no `reason` field** is the moment the runtime
had no rule it could match and fell through to default-mode behaviour.
The engine only populates `reason` when it can name a specific cause
(sandbox-floor denial, prompt-injection redaction, etc.); plain
no-rule-matched cases stay quiet on purpose so absence-of-reason is
itself a signal. In an interactive REPL the runtime then calls
`askApproval` and the user decides; in a non-interactive run (CI,
`bun run` piped) the call is refused with `tool denied (single-turn
mode: cannot prompt for interactive approval)`. The fix is to add
an `alwaysAllow` rule that covers the tool (or set
`permissions.mode: auto` for allow-by-default behaviour).

The same trace stream is what
[Recipe 17 — Observability](recipes/17-observability.md) walks
through in detail; the same events feed `OTEL_EXPORTER_OTLP_ENDPOINT`
and the vendor exporters.

| Symptom in the REPL                          | Where to look                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Tool ran but produced garbage                | JSONL — `select(.kind == "tool_result" and .payload.is_error == false) \| .payload.content`                      |
| Tool refused or was redacted unexpectedly    | Trace — `select(.kind == "permission_decision")` (look at `decision` and `outcome`)                              |
| Agent went silent / stuck                    | JSONL — `select(.kind == "error")` — the `payload.recoverable` field tells you whether it'll be retried.         |
| Reply contradicts an earlier turn            | JSONL — `select(.kind == "compaction")` — was the offending message snipped or summarised?                       |
| Cost looks wrong                             | Trace — `select(.kind == "cost_accrual") \| {turnNumber, usage, totalUsd}` (requires `CREWHAUS_COST_TRACKING=1`) |
| Hook fired but didn't seem to take effect    | Trace — `select(.kind == "hook_fired") \| {event, matcher, allowed, reason}`                                     |

### Tracing a request across YAML, IR, and trace

The three surfaces above are most useful when you read them as one
sequence. This subsection walks two concrete scenarios end-to-end —
a permission denial and an eval-driven prompt mutation — with every
panel quoted from real compiler / runtime output. Read the panels
top to bottom; the **What this proves** note at the end of each
scenario explains what the breadcrumbs tell you.

#### Scenario 1 — your agent's `write` got refused

You write a small note-keeping CLI agent. It can `read` files
(safe — covered by an `alwaysAllow` rule) and `write` files (not
covered). The first time the model tries to save a note, the runtime
intercepts the call. Where does the trail of evidence start?

**Panel 1 — the spec you wrote** (`note-keeper.yaml`):

```yaml
name: note-keeper
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You help the user keep notes. When asked to save something, write it
    to a file in the current working directory.
tools:
  - read
  - write
permissions:
  mode: default
  rules:
    - { type: alwaysAllow, pattern: Read }
```

**Panel 2 — the IR after `lower()`**, captured by
`bun apps/cli/src/index.ts compile note-keeper.yaml --emit-ir`:

```json
{
  "version": 0,
  "name": "note-keeper",
  "target": "cli",
  "agent": {
    "model": "claude-sonnet-4-6",
    "instructions": "You help the user keep notes. When asked to save something, write it\nto a file in the current working directory.\n"
  },
  "tools": [
    "read",
    "write"
  ],
  "toolConfigs": {},
  "mcp_servers": {},
  "permissions": {
    "mode": "default",
    "rules": [
      { "type": "alwaysAllow", "pattern": "Read" }
    ]
  },
  "subAgents": [],
  "compaction": {}
}
```

**Panel 3 — the trace event** from `CREWHAUS_TRACE=json` when the
model invokes `Write({"path": "todo.txt", "content": "buy milk"})`:

```json
{
  "runId": "run_8a7d6f5e4c3b2a19",
  "sessionId": "sess_3f9c2b1a8e7d6c5b",
  "turnNumber": 2,
  "traceId": "4c1b6d8e9f0a2b3c4d5e6f7a8b9c0d1e",
  "spanId": "a1b2c3d4e5f60718",
  "timestamp": "2026-05-13T17:42:11.013Z",
  "kind": "permission_decision",
  "toolName": "Write",
  "decision": "ask",
  "mode": "default"
}
```

**What this proves.** Three views, one story:

- The YAML's `permissions.rules` has one entry. It covers `Read`.
- The IR's `permissions.rules` has the same one entry — `lower()`
  faithfully preserved it (nothing to dedupe, nothing to sort, the
  rule was a 1:1 copy). If there were no rule for `Write`, the IR
  shows none.
- The trace shows the engine at `turnNumber: 2` reaching for a rule
  and finding none, so it fell through to default-mode behaviour
  (`decision: "ask"`).

The fix is wherever the chain starts — your YAML. Add
`{ type: alwaysAllow, pattern: Write(**/*.txt) }` to
`permissions.rules`, recompile, and the trace at the same turn now
shows `decision: "allow"` plus a `reason` populated by the matched
rule. No source map needed: the IR field names (`permissions.rules`,
`tools`, `agent.instructions`) are the bridge — they're stable
between the spec you wrote and the trace events the runtime emits.

#### Scenario 2 — an eval failed and the optimizer wants to patch your prompt

You run `crewhaus eval` against a labelled dataset. The grader fails
on too many examples. You run `crewhaus optimize --write-back` and
the system rewrites `agent.instructions` in place. Did it eat your
comments? Where did the patch land? What did it touch?

**Panel 1 — the spec before the run** (excerpt from
[`docs/recipes/42-active-optimization.md`](recipes/42-active-optimization.md)):

```yaml
# crewhaus.yaml — coding agent for our team
# Owner: @max. Reviewed 2026-04-30.
name: my-coding-agent
target: cli

agent:
  model: claude-sonnet-4-6
  # DO NOT CHANGE THIS PROMPT WITHOUT TEAM REVIEW (incident 2026-03-04)
  instructions: |
    You help with TypeScript. Read files before editing.
permissions:
  mode: default
  rules:
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysAsk,   pattern: Bash(**) }
```

**Panel 2 — the failing eval trace**, filtered from the same stream:

```json
{"kind":"tool_call_end","toolName":"grade","isError":false,"outputBytes":312,"durationMs":480,"...":"..."}
{"kind":"tool_call_end","toolName":"grade","isError":false,"outputBytes":298,"durationMs":462,"...":"..."}
{"kind":"cost_accrual","model":"claude-sonnet-4-6","usage":{"input":4210,"output":1180},"...":"..."}
```

The eval harness's grader emits a per-sample score that lands in the
`tool_call_end` payload; the orchestrator aggregates these into the
run's pass rate (`0.450` in this run). The `cost_accrual` events give
the spend per turn — useful for spotting when an optimizer iteration
is paying more than it's worth.

**Panel 3 — the spec after `crewhaus optimize --write-back`**:

```yaml
# crewhaus optimize: runId opt_a8f3b21c
# - mutator: rule-based
# - iterations: 5
# - score: 0.450 → 0.780 (Δ 0.330)
# - generated: 2026-05-12T17:42:00Z

# crewhaus.yaml — coding agent for our team
# Owner: @max. Reviewed 2026-04-30.
name: my-coding-agent
target: cli

agent:
  model: claude-sonnet-4-6
  # DO NOT CHANGE THIS PROMPT WITHOUT TEAM REVIEW (incident 2026-03-04)
  instructions: |
    Think step by step before answering.

    You help with TypeScript. Read files before editing.
permissions:
  mode: default
  rules:
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysAsk,   pattern: Bash(**) }
```

**What this proves.** Look at what survives:

- Your `# DO NOT CHANGE THIS PROMPT WITHOUT TEAM REVIEW` comment is
  byte-identical. So is `# Owner: @max…`, the blank line above
  `agent:`, and the whole `permissions` block. The CST round-trip
  preserves every byte of source not in the patch path.
- The patch path was `["agent", "instructions"]`. That path is
  listed in `OPTIMIZABLE_PATHS["cli"]`
  ([packages/spec-patch/src/index.ts:189](../packages/spec-patch/src/index.ts))
  precisely because `agent.instructions` is a string in the spec, a
  string in the IR, and a string in the generated bundle — the lower
  is 1:1, so the patch path equals the spec path equals the CST
  path.
- The run-header comment prepended at the top is the audit trail:
  `git diff` makes the rewrite obvious to a reviewer, and the runId
  ties back to the eval orchestrator's artefacts in
  `.crewhaus/optimize/<runId>/`.
- If the optimizer had attempted a path *not* in
  `OPTIMIZABLE_PATHS` (say `permissions.rules.0.pattern`), the
  orchestrator would have raised `SpecPatchError: path … is not
  listed in OPTIMIZABLE_PATHS for target "cli"` — see
  [Recipe 42 § What happens if the optimizer targets a structurally volatile field](recipes/42-active-optimization.md)
  for the worked refusal.

The next eval run on the patched YAML shows the new score in its own
`tool_call_end` events, closing the loop: bad score in the trace →
patch on a whitelisted path → updated YAML on disk (comments
intact) → new score in the next trace. The lossy `lower()` doesn't
get in the way because `OPTIMIZABLE_PATHS` is exactly the set of
paths where it isn't lossy.

### Mapping a runtime error back to a spec line

When a trace event tells you "decision: ask, no matching rule," the
model-facing tool name (`Write`, `Bash`, `filesystem__read_file`)
maps directly to the rule pattern in your spec. The IR field name
(`permissions.rules`) is the same as the spec key — there is no
mapping table to consult, because the IR and the spec share names
for every field whose lower is 1:1. Two patterns worth knowing:

- **`decision: "ask"` with no `reason` mentioning a rule** — your
  spec is silent on this tool. Add an `alwaysAllow` rule with the
  narrowest pattern that covers the call (the trace's prior
  `tool_call_start` event has the `inputBytes`; the JSONL's
  preceding `tool_use` event has the argument so you can tighten
  beyond the bare tool name — `Write(**/notes/**)` instead of
  `Write`).
- **`decision: "deny"` with a `reason`** — your spec or the
  builtin safety floor has an `alwaysDeny` / `alwaysAsk` rule
  winning over an `alwaysAllow`. Recall the tier order: **deny >
  ask > allow**, and the layer order: **flag > settings > yaml >
  hooks > builtin**. The IR's `permissions.rules` shows the
  evaluation order; `--emit-ir` is faster than reading the engine
  source.

If `--emit-ir`, the JSONL, and the trace stream together don't make
a failure self-explanatory, the gap is a documentation bug — file
it, because the intent-to-code mapping is supposed to be navigable
from this section without diving into the runtime source.

---

## The CLI, end to end

The `crewhaus` CLI lives at
[`apps/cli/src/index.ts`](../apps/cli/src/index.ts). The
package.json exposes shortcuts (`bun run compile:hello` etc.); the
underlying invocation is always `bun apps/cli/src/index.ts <subcommand>`.

| Subcommand                                   | Purpose                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `compile <spec> -o <out-dir>`                | Parse → IR → emit bundle to `<out-dir>`.                                                |
| `compile <spec> --emit-ir [-o <out-dir>]`    | Print the lowered IR as JSON (or write `<out-dir>/ir.json`); skip codegen. See [Debugging the compiler](#debugging-the-compiler). |
| `run <spec> [--model …] [--resume <id>]`     | Compile in-memory and execute (CLI shape only).                                         |
| `init [name]`                                | Scaffold a fresh `crewhaus.yaml`.                                                       |
| `doctor`                                     | Check Bun version, credentials, working spec, Docker availability for sandboxed tools.  |
| `eval <spec> --dataset <d> --graders <g>`    | Run an eval bundle, write per-sample results + an HTML report.                          |
| `eval-report diff <prevRun> <newRun>`        | Highlight pass/fail flips between two eval runs.                                        |
| `cost-summary --session <id>`                | Aggregate `cost_accrual` events from a session into total USD spend.                    |
| `secrets {doctor,rotate <name>}`             | List + rotate file/vault-backed secrets.                                                |
| `spec {put,list,get,pin,alias} …`            | Versioned spec storage and environment pinning.                                         |
| `deploy {promote,rollback} …`                | Re-pin a spec across environments, with audit log entries.                              |
| `migrate-all --from N --to N`                | Batch-migrate every spec in a registry to a newer IR version.                           |
| `build-image <target> --tag <tag>`           | Build a per-target Docker image.                                                        |
| `cloud {deploy,teardown} --provider <p>`     | Deploy a managed cluster to AWS / GCP / Azure / LocalStack.                             |
| `federation discover <deployment>`           | Resolve a federated peer endpoint via DNS SRV or `.well-known`.                         |
| `sandbox doctor [--probe]`                   | List registered sandbox images and run their healthchecks.                              |
| `compliance evidence --framework <id>`       | Collect SOC 2 / ISO 27001 / HIPAA evidence bundles from the audit log.                  |

Day to day, you'll mostly use `compile`, `run`, `init`, `doctor`, and
the `bun run …` shortcuts in `package.json`.

---

## The runtime directory

Every run writes under `.crewhaus/` in the working directory. This is
the system's audit trail and the source of truth for resuming sessions.

```
.crewhaus/
├── sessions/
│   ├── sess_<id>.json          # session metadata: id, target, model, lastTurnIndex, mtime
│   └── sess_<id>.jsonl         # append-only trace: user_message, assistant_message,
│                               # tool_use, tool_result, cost_accrual, compaction, error, …
│                               # (mode 0o600 — owner-only)
├── tool-results/
│   └── <runId>/<toolUseId>.txt # tool outputs > 10 KB (model sees a preview)
├── settings.json               # project-level settings: permission rules, hooks, paths
├── secrets/                    # file-backed secret store (atomic writes, mode 0o600)
├── audit/                      # hash-chained audit log per tenant per day (managed shape)
├── specs/<name>/<version>.yaml # spec-registry storage (apps/cli `spec put`)
├── compliance/                 # SOC 2 / ISO 27001 / HIPAA evidence bundles
├── evals/<runId>/              # per-sample transcripts + graded results
├── graphs/<graphRunId>/        # graph checkpoints (one JSONL per checkpoint)
├── research/<runId>/           # research citations.jsonl + fetches.jsonl + content cache
├── studio-specs/               # specs created via Studio's Wizard
├── skills/<name>/SKILL.md      # discovered skills (project layer)
└── commands/<name>.md          # custom slash commands
```

Sessions older than 30 days are evicted on next `list()` (mtime-based,
so `touch -t YYYYMMDD0000 sess_*.json` forces expiry from the shell).
Nothing here is sacred — `rm -rf .crewhaus/` is a clean reset.

A user-level `~/.crewhaus/` exists too (skills, commands, plugins,
federation certs); project-level overrides user-level.

---

## Tools, permissions, and skills

### Built-in tools

These ship with the runtime; declare them under `agent.tools:` in your
spec to register them.

| Tool                            | Purpose                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| `Read` / `Write` / `Edit`       | File operations, sandboxed to `process.cwd()`.                       |
| `Glob` / `Grep`                 | Pattern + content search.                                            |
| `Bash`                          | Shell with 30 s default timeout (10 min cap).                        |
| `TodoWrite`                     | Per-process markdown task list.                                      |
| `Task`                          | Spawn a sub-agent with isolated context.                             |
| `WebFetch` / `WebSearch`        | URL → markdown; provider-backed search.                              |
| `Fetch`                         | Generic HTTP, fail-closed allow-list, SSRF defenses.                 |
| `ReadImage`                     | Image file → Anthropic image content block.                          |
| `Retrieve`                      | RAG: embed query → vector store → top-k snippets with citations.    |
| `Source` / `CiteFact`           | Research-only: fetch + cite verbatim snippets.                       |
| `Handoff` / `SendMessage`       | Crew-only: pass control / peer-message between roles.                |
| `Screenshot` / `Click` / `Type` / `Key` / `Scroll` / `FindElement` | Browser-only.                  |
| `Python` / `JavaScript` / `Shell` | Sandboxed REPL (Docker, network=none, read-only root).             |

MCP servers add their own tools, namespaced as `<server>__<tool>`.

### The four permission modes

| Mode         | What it does                                                                              |
| ------------ | ----------------------------------------------------------------------------------------- |
| `default`    | Allow read-only; ask for destructive. Production-shaped.                                  |
| `plan`       | Strictest. Deny all writes; the agent plans then asks for approval.                       |
| `auto`       | Allow everything declared in `permissions.rules`; ask for the rest.                       |
| `bypass`     | Allow everything. **Only honored from a CLI flag, never from a config file** — security guard. |

Rules are evaluated across five layers (flag → settings → yaml → hooks →
builtin), with later layers overriding earlier ones. The pattern syntax
is glob-like: `Bash(git *)`, `Write(**/src/**)`, `Read`.

### Hooks, skills, slash commands

- **Hooks** run at lifecycle events (`pre-tool`, `post-tool`, `pre-model`,
  `pre-compact`, `pre-slash`, `session-start`, `stop`). They're shell
  commands declared in `.crewhaus/settings.json`; they can `allow`,
  `deny`, or mutate. Useful for sandbox enforcement, audit, custom
  checks. See [`recipes/14-hooks.md`](recipes/14-hooks.md).
- **Skills** are markdown files (`SKILL.md`) discovered under
  `~/.crewhaus/skills/` and `<cwd>/.crewhaus/skills/`. The runtime
  exposes a synthetic `Skill(name)` tool; the body loads only when the
  model invokes it. See [`recipes/15-skills.md`](recipes/15-skills.md).
- **Slash commands** are markdown files under `.crewhaus/commands/`
  with `$ARGUMENTS` substitution. `/<name> args` expands at the user
  layer before the model ever sees it. See
  [`recipes/16-slash-commands.md`](recipes/16-slash-commands.md).

---

## Observability and cost

By default, the runtime produces no extra output beyond the assistant's
streaming reply. Every observability surface is opt-in by env var.

| Env var                                        | Effect                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `CREWHAUS_TRACE=pretty`                        | Color-coded events on stderr. Default for human use.                |
| `CREWHAUS_TRACE=json`                          | One JSON object per event on stdout. Pipe-friendly.                 |
| `CREWHAUS_METRICS=stdout`                      | Prometheus-format counters and histograms on shutdown.              |
| `CREWHAUS_METRICS=textfile:/path/m.prom`       | Atomic Prometheus textfile writes.                                  |
| `CREWHAUS_METRICS=http:9464`                   | `/metrics` HTTP endpoint.                                           |
| `OTEL_EXPORTER_OTLP_ENDPOINT=https://…`        | OpenTelemetry export with `gen_ai/*` semantic conventions.          |
| `CREWHAUS_COST_TRACKING=1`                     | Emit `cost_accrual` events from `model_response`. Read with `crewhaus cost-summary --session <id>`. |
| `DD_API_KEY`, `HONEYCOMB_API_KEY`, `SPLUNK_ACCESS_TOKEN`, `NEW_RELIC_LICENSE_KEY` | Vendor exporters auto-attach when their env is set. |

Sessions and the JSONL event log are written regardless of these flags
— that's the audit trail, not the live observability layer.

See [`recipes/17-observability.md`](recipes/17-observability.md) for
worked examples.

---

## Studio: the visual front door

Studio is a Bun-served web UI for browsing specs, running the wizard,
visualizing graphs, and replaying traces.

```bash
bun run studio   # listens on :4187 by default; STUDIO_PORT to override
```

What you get:

- **Specs tab.** List + create + edit specs in the workspace.
- **Wizard.** A 5-question guided spec creation flow that picks a
  scaffold-template per target shape and patches in your answers.
- **Graph layouts.** Deterministic SVG layouts for `target: graph` specs
  with live state coloring as nodes fire.
- **Run viewer.** SSE-streamed trace timeline; clicking a span opens a
  drilldown panel.
- **Plugins.** Sandboxed third-party plugins from `~/.crewhaus/plugins/`.

Studio is optional for using the CLI — the same workspace files work
with or without it.

---

## Going further

### Other model providers

The `model:` field is parsed by the
[`model-router`](../packages/model-router/) using a strict prefix
grammar:

| Prefix                          | Provider                                                              | Env vars                                              |
| ------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| `claude-…`                      | Anthropic (default)                                                   | `ANTHROPIC_AUTH_TOKEN` (recommended) or `ANTHROPIC_API_KEY` |
| `openai/…`                      | OpenAI Chat Completions                                               | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`           |
| `gemini/…`                      | Google Gemini                                                         | `GEMINI_API_KEY` or `GOOGLE_API_KEY`                   |
| `bedrock/…` (e.g. `bedrock/anthropic.claude-…`, `bedrock/meta.llama3-…`, `bedrock/mistral.mistral-…`) | AWS Bedrock | Standard AWS credential chain                         |
| `local/<model>@<url>`           | Any OpenAI-compatible local endpoint (Ollama, vLLM, llama.cpp server) | None — URL is in the model string                     |

The router lazy-imports each adapter, so an Anthropic-only spec never
loads the AWS SDK.

### Production hardening

The recipes that deal with production are:

- [`recipes/18-multi-provider-fallback.md`](recipes/18-multi-provider-fallback.md) — circuit breakers + fallback model lists.
- [`recipes/19-rate-limiting-and-budgets.md`](recipes/19-rate-limiting-and-budgets.md) — multi-dimensional token buckets, per-tenant budgets.
- [`recipes/20-secrets-management.md`](recipes/20-secrets-management.md) — env / file / Vault backends, rotation handlers.
- [`recipes/21-deployment-and-canary.md`](recipes/21-deployment-and-canary.md) — versioned specs, env pins, canary rollouts.
- [`recipes/22-compliance-and-audit.md`](recipes/22-compliance-and-audit.md) — SOC 2 / ISO 27001 / HIPAA evidence collection.
- [`recipes/23-pii-redaction-and-encryption.md`](recipes/23-pii-redaction-and-encryption.md) — audit-log encryption, retention windows.

### Distribution and ecosystem

- [`recipes/24-docker-and-helm.md`](recipes/24-docker-and-helm.md) — single-binary builds, Docker per shape, Helm chart, Kustomize.
- [`recipes/25-vscode-and-jetbrains.md`](recipes/25-vscode-and-jetbrains.md) — IDE plugins for spec authoring + run-from-editor.
- [`recipes/26-template-marketplace.md`](recipes/26-template-marketplace.md) — publishing + installing community templates with sigstore-style signature verification.
- [`recipes/27-federation.md`](recipes/27-federation.md) — cross-deployment A2A with mTLS.
- [`recipes/36-cloud-deploy.md`](recipes/36-cloud-deploy.md) — one-click managed deploy to AWS / GCP / Azure / LocalStack.

### Going deeper

When you outgrow the basics:

- [`recipes/28-sub-agents-and-task.md`](recipes/28-sub-agents-and-task.md) — spawn isolated sub-agents via the `Task` tool.
- [`recipes/29-permissions-deep-dive.md`](recipes/29-permissions-deep-dive.md) — the full five-layer rule system.
- [`recipes/30-sandboxed-code-execution.md`](recipes/30-sandboxed-code-execution.md) — `Python` / `JavaScript` / `Shell` REPL tools in Docker; polyglot images.
- [`recipes/31-session-resume-and-replay.md`](recipes/31-session-resume-and-replay.md) — resume by id, branch from a checkpoint, replay traces.
- [`recipes/32-local-models.md`](recipes/32-local-models.md) — Ollama / vLLM / llama.cpp via the `local/<model>@<url>` grammar.
- [`recipes/33-prompt-caching.md`](recipes/33-prompt-caching.md) — tuning Anthropic `cache_control` rotation.
- [`recipes/34-building-custom-graders.md`](recipes/34-building-custom-graders.md) — extend the eval system with your own graders.
- [`recipes/35-studio-walkthrough.md`](recipes/35-studio-walkthrough.md) — using the Studio web UI end to end.

### Channel adapters

The Slack walkthrough at [`recipes/03-slack-bot.md`](recipes/03-slack-bot.md)
covers the channel-target mental model. Each adapter has its own
recipe for the channel-specific bits:

- [`recipes/37-channel-telegram.md`](recipes/37-channel-telegram.md)
- [`recipes/38-channel-discord.md`](recipes/38-channel-discord.md)
- [`recipes/39-channel-whatsapp.md`](recipes/39-channel-whatsapp.md)
- [`recipes/40-channel-imessage.md`](recipes/40-channel-imessage.md)

The full recipe index lives at [`recipes/INDEX.md`](recipes/INDEX.md).

### The full module catalog

When a recipe says "uses module X," the canonical reference is
[`docs/MODULE-CATALOG.md`](MODULE-CATALOG.md). It's organised as
role-based reading paths ("if you are adding a new target shape, go
to …") rather than a flat glossary, so you can land on the ~5
modules that matter for your task without reading the rest. Per-module
build briefs live in [`docs/module-briefs/`](module-briefs/README.md);
implementation status and the v1.3 backlog live in
[`docs/MODULE-CATALOG-STATUS.md`](MODULE-CATALOG-STATUS.md).

---

## Troubleshooting

| Symptom                                                      | Fix                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `ANTHROPIC_AUTH_TOKEN missing` on first run                  | Copy `.env.example` to `.env` and set one credential. `bun run` auto-loads `.env`.    |
| Compile fails on unknown field                               | The Zod schema rejects unknown keys to catch typos. Check `packages/spec/src/index.ts`. |
| Tool refuses to run with "permission denied"                 | Default mode asks for destructive tools. Add an `alwaysAllow` rule or use `--permission-mode auto`. |
| `Bash` works but `Python`/`JavaScript`/`Shell` doesn't       | Sandboxed REPLs require Docker. Run `crewhaus sandbox doctor` to verify image health. |
| Channel daemon (Slack/Telegram/etc.) gets duplicate messages | The gateway dedups by adapter idempotency key. Check that the inbound payload's `event_id` (Slack) or message id (others) is reaching the dedup cache. |
| Generated bundle imports fail at runtime                     | Run `bun install` from the repo root — the workspace links `@crewhaus/*` packages locally. |
| Resuming a session loses tool calls                          | The replay walks `user_message` + `assistant_message` events only; tool spans are audit-only. This is by design — fix is to grow the model's context window or accept the trim. |

If you hit something not listed here, the JSONL event log under
`.crewhaus/sessions/` is usually the fastest path to a diagnosis.

---

**Next:** pick the target shape that matches your problem and walk
through its recipe under [`docs/recipes/`](recipes/).
