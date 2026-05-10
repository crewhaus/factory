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
7. [The CLI, end to end](#the-cli-end-to-end)
8. [The runtime directory](#the-runtime-directory)
9. [Tools, permissions, and skills](#tools-permissions-and-skills)
10. [Observability and cost](#observability-and-cost)
11. [Studio: the visual front door](#studio-the-visual-front-door)
12. [Going further](#going-further)
13. [Troubleshooting](#troubleshooting)

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

**Pick `cli` first.** Every other shape adds something on top of the
chat loop — `cli` is the right shape for learning the system before
you reach for the more specialized ones.

---

## Anatomy of a spec

The smallest possible spec is five lines:

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

## The CLI, end to end

The `crewhaus` CLI lives at
[`apps/cli/src/index.ts`](../apps/cli/src/index.ts). The
package.json exposes shortcuts (`bun run compile:hello` etc.); the
underlying invocation is always `bun apps/cli/src/index.ts <subcommand>`.

| Subcommand                                   | Purpose                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `compile <spec> -o <out-dir>`                | Parse → IR → emit bundle to `<out-dir>`.                                                |
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
[`docs/MODULE-CATALOG.md`](MODULE-CATALOG.md). It documents every
package in `packages/` — inputs, outputs, design choices, test
coverage, the section it shipped in. Treat it as a glossary, not
required reading.

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
