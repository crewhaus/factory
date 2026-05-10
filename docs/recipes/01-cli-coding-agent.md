---
test:
  spec: examples/hello-cli/crewhaus.yaml
  bun_scripts:
    - compile:hello
    - run:hello
---

# Recipe 01 — CLI Coding Agent

Build a streaming chat agent with file tools, bash, MCP servers, hooks,
skills, and slash commands — the Claude Code shape. This is the
canonical starting point and the right shape to learn the system on
before reaching for any of the more specialized ones.

By the end of this recipe you'll have a working agent that:

- Reads, writes, and edits files in your project.
- Runs bash commands (with permission gating).
- Reaches out to MCP servers for additional tools.
- Picks up custom slash commands you author.
- Persists every turn to a resumable session log.

Time: ~30 minutes if you follow along. ~5 minutes if you just run the
example and skip the explanations.

## Prerequisites

- [Bun](https://bun.sh) 1.2 or later.
- An Anthropic credential. The easiest path is `claude setup-token` if
  you have a Claude Pro/Max subscription; otherwise grab an API key at
  <https://console.anthropic.com/settings/keys>.
- This repo cloned and `bun install` run once.

If you haven't read [Getting Started](../GETTING-STARTED.md) yet, do
that first — it sets up the mental model this recipe builds on.

## Step 1 — The smallest possible spec

Open [`examples/hello-cli/crewhaus.yaml`](../../examples/hello-cli/crewhaus.yaml).
The whole file is five lines:

```yaml
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a helpful, concise assistant. Reply in two sentences or fewer
    unless the user asks for more detail.
```

Three top-level fields:

| Field    | Purpose                                                                |
| -------- | ---------------------------------------------------------------------- |
| `name`   | Human label; persists into session metadata. Anything you want.        |
| `target` | The runtime shape. `cli` produces a streaming chat REPL.               |
| `agent`  | The model and the system prompt.                                       |

`agent.model` follows the [model id grammar](../GETTING-STARTED.md#other-model-providers):
bare `claude-...` for Anthropic, `openai/...`, `gemini/...`,
`bedrock/...`, or `local/<model>@<url>` for an OpenAI-compatible local
endpoint.

`agent.instructions` is the system prompt. It can be a multi-line YAML
block; `|` preserves the linebreaks.

## Step 2 — Compile and run

From the repo root:

```bash
bun run compile:hello   # writes examples/hello-cli/dist/agent.ts
bun run run:hello       # opens an interactive REPL
```

Type a message, get a streaming reply, type `exit` to quit.

What just happened: `compile:hello` ran
`bun apps/cli/src/index.ts compile examples/hello-cli/crewhaus.yaml -o examples/hello-cli/dist`.
The compiler parsed the YAML, lowered it to an `IrV0` value, and
emitted a single TypeScript file. Then `run:hello` executed that file
with Bun.

Open `examples/hello-cli/dist/agent.ts` and read it. It's about 25
lines and contains no magic — it imports `runChatLoop` from
`@crewhaus/runtime-core`, loads hooks/skills/slash-commands from your
`.crewhaus/` directory, and calls into the runtime. You could have
written this file by hand. The compiler's job is to do it correctly
for every target shape.

## Step 3 — Adding tools

The five-line spec gives you a chat agent with no tools — it can talk
but not act. Add filesystem and bash tools to turn it into something
that can actually help with code.

Create a copy at `examples/hello-cli/my-agent.yaml`:

```yaml
name: my-agent
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a TypeScript expert. When asked to change code, always
    read the relevant files first, then make the smallest possible
    edit. Run `bun run typecheck` after any edit and report the result.
tools:
  - read
  - write
  - edit
  - glob
  - grep
  - bash
```

Note that `tools:` lives at the top level of the spec, not nested
under `agent:` — for CLI specs the agent block carries the model and
instructions; everything else is sibling-level. The eleven canonical
tool names you can put in `tools:`:

| Spec name    | Model-facing name | What it does                                                 |
| ------------ | ----------------- | ------------------------------------------------------------ |
| `read`       | `Read`            | Read a file (sandboxed to `process.cwd()`).                  |
| `write`      | `Write`           | Atomic write to a new or existing file.                      |
| `edit`       | `Edit`            | Exact-string replace in an existing file.                    |
| `glob`       | `Glob`            | Find files by glob pattern.                                  |
| `grep`       | `Grep`            | Search file contents.                                        |
| `bash`       | `Bash`            | Run a shell command. 30 s default timeout, 10 min cap.       |
| `todoWrite`  | `TodoWrite`       | Per-process markdown task list.                              |
| `webFetch`   | `WebFetch`        | Fetch a URL, return rendered markdown.                       |
| `webSearch`  | `WebSearch`       | Provider-backed web search (configurable).                   |
| `readImage`  | `ReadImage`       | Read an image file, return an Anthropic image block.         |
| `fetch`      | `Fetch`           | Generic HTTP with fail-closed allow-list and SSRF defenses.  |

Compile and run:

```bash
bun apps/cli/src/index.ts compile examples/hello-cli/my-agent.yaml -o /tmp/my-agent
bun /tmp/my-agent/agent.ts
```

Try a prompt like "what does the `runChatLoop` function in
`packages/runtime-core/src/index.ts` do?". The agent should call
`Read` to fetch the file, then summarize it.

If you instead try "delete all .ts files in the runtime-core package",
the agent will try to call `Bash` and the runtime will pause and ask
for your approval. That's the permission system at work — covered next.

## Step 4 — Permissions

The runtime won't run destructive tools without consent. There are
four permission modes:

| Mode        | Behavior                                                              |
| ----------- | --------------------------------------------------------------------- |
| `default`   | Allow read-only operations; ask for destructive ones interactively.   |
| `plan`      | Strictest. Deny all writes; the agent plans then asks before acting.  |
| `auto`      | Allow what `permissions.rules` declares; ask for the rest.            |
| `bypass`    | Allow everything. **Only legal from the `--permission-mode` flag.**    |

Per-tool overrides via `permissions.rules`:

```yaml
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysAllow
      pattern: Write(**/src/**)
    - type: alwaysAsk
      pattern: Bash(**)
    - type: alwaysDeny
      pattern: Bash(rm *)
```

The pattern grammar is glob-like over the model-facing tool name plus
an optional argument matcher:

- `Read` — matches any Read call.
- `Write(**/src/**)` — matches Write whose target path is under any `src/` directory.
- `Bash(git *)` — matches Bash whose command starts with `git`.
- `Bash(**)` — matches any Bash invocation.
- `Bash(rm *)` — matches any `rm` command.

Tier order is **deny > ask > allow**, so an `alwaysDeny` rule beats an
`alwaysAllow` rule for the same call even if they're both declared.

Add `permissions:` to `my-agent.yaml`, recompile, and try a Bash
command — only the calls matching `alwaysAllow` skip the prompt.

For the complete five-layer rule system (flag → settings → yaml →
hooks → builtin), see [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md).

## Step 5 — Plugging in an MCP server

Model Context Protocol servers add their tools to your agent without
any runtime changes. Add an `mcp_servers:` block:

```yaml
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

Compile and run. The runtime starts the MCP server as a subprocess on
boot, lists its tools, and registers each one as `filesystem__<toolName>`.
The model now sees `filesystem__read_file`, `filesystem__list_directory`,
etc. alongside your built-ins.

Two transport options:

- `transport: stdio` with `command` and `args` — runtime spawns the
  process and speaks over stdin/stdout.
- `transport: sse` with `url` — runtime connects to a running server
  over Server-Sent Events.

Auto-reconnect: 1 s → 30 s exponential backoff with jitter, no max
attempts. In-flight calls during a reconnect wait on a queue capped at
16.

The runtime forwards the server's JSON Schema for each tool verbatim
to the model. Per-tool overrides (e.g. flagging a remote tool as
`destructive`) live under `tool_config.mcp.<server>.<tool>` in the
spec.

For a longer walkthrough see [Recipe 13 — MCP Servers](13-mcp-servers.md).

## Step 6 — Skills

Skills are markdown procedures the agent can opt into via a synthetic
`Skill(name)` tool. The frontmatter is loaded at boot; the body loads
only when the model invokes the skill — so a registry of 50 skills
doesn't cost 50 system prompts' worth of tokens.

Create `<your-spec-dir>/.crewhaus/skills/release-checklist/SKILL.md`:

```markdown
---
name: release-checklist
description: Walk through a release. Use when the user says "ship", "release", "tag a version".
---

# Release checklist

1. Run `bun run typecheck` and `bun run test` — both must pass.
2. Update CHANGELOG.md with notable changes since the last tag.
3. Bump the version in package.json (`npm version patch|minor|major`).
4. Create a release commit and tag.
5. Push the tag: `git push origin --tags`.
6. Verify the CI release workflow succeeded.

If any step fails, stop and ask the user before continuing.
```

The runtime auto-discovers it on next run. The model sees a
short reference (`release-checklist — Walk through a release...`) in
its system prompt; when it decides to use the skill it calls
`Skill({ name: "release-checklist" })` and the body loads on demand.

User-level skills under `~/.crewhaus/skills/<name>/SKILL.md` are
layered under project-level ones; project overrides user by skill name.

See [Recipe 15 — Skills](15-skills.md) for authoring guidance.

## Step 7 — Slash commands

Slash commands are user-typed shortcuts that expand into a prompt
before the model ever sees them.

Create `<your-spec-dir>/.crewhaus/commands/review.md`:

```markdown
---
description: Review a pull request
argument-hint: <pr-number>
---

Review PR $ARGUMENTS using the `gh` CLI:
1. Run `gh pr view $ARGUMENTS --json title,body,files`.
2. For each changed file, Read it and check for: untested changes,
   missing error handling, security issues, style inconsistencies.
3. Report findings as a markdown checklist with file:line references.
```

In the REPL, type `/review 1234`. The runtime expands it to the body
above with `$ARGUMENTS` replaced by `1234`, then sends that as your
user message.

The expansion is non-recursive (a command body that contains
`/another-command` will not trigger further expansion) and
regex-special-safe (arguments containing `$1`, `\n`, etc. paste
literally).

See [Recipe 16 — Slash Commands](16-slash-commands.md).

## Step 8 — Hooks

Hooks are shell commands that run at lifecycle events and can `allow`,
`deny`, `block`, or mutate. Useful for sandbox enforcement, audit, or
integration with corporate compliance tools.

Create `<your-spec-dir>/.crewhaus/settings.json`:

```json
{
  "hooks": {
    "pre-tool": [
      {
        "command": "if echo \"$CREWHAUS_TOOL_NAME\" | grep -q '^Bash$' && echo \"$CREWHAUS_TOOL_INPUT\" | grep -q 'rm -rf /'; then echo '{\"decision\":\"deny\",\"reason\":\"refused rm -rf /\"}'; else echo '{\"decision\":\"allow\"}'; fi"
      }
    ]
  }
}
```

The hook receives event JSON on stdin and event-derived env vars
(`CREWHAUS_TOOL_NAME`, `CREWHAUS_TOOL_INPUT`, etc.); it prints a JSON
decision on stdout. The runtime aggregates multiple hooks per event
and short-circuits on the first `deny`/`block`.

Restricted env: hooks run with PATH trimmed to standard system bins,
and credentials (`ANTHROPIC_AUTH_TOKEN`, `AWS_*`, `GH_TOKEN`,
`OPENAI_API_KEY`) are stripped — a compromised hook can't exfiltrate
keys.

Default 5 s timeout per hook with SIGKILL on miss.

See [Recipe 14 — Hooks](14-hooks.md) for the full lifecycle event list
and aggregation semantics.

## Step 9 — Sessions and resume

Every run writes to `.crewhaus/sessions/sess_<16hex>.json` (metadata)
and `.crewhaus/sessions/sess_<16hex>.jsonl` (append-only event log).
The session id prints when the run starts.

To resume:

```bash
bun apps/cli/src/index.ts run examples/hello-cli/crewhaus.yaml --resume sess_abcdef0123456789
```

The runtime walks the JSONL, replays the `user_message` and
`assistant_message` events into a `MessageParam[]`, and continues at
the next user turn.

Why only those two event kinds? `tool_use` and `tool_result` are
already nested inside the assistant/user message content arrays — the
replay walks the conversation, not the side effects. `error` and
`compaction` events are observability-only.

Sessions older than 30 days are evicted on the next `list()` call
(mtime-based). To force expiry from the shell:
`touch -t 202001010000 .crewhaus/sessions/sess_*.json`.

See [Recipe 31 — Session Resume and Replay](31-session-resume-and-replay.md)
for branching and replay.

## Step 10 — Debugging a turn

When something looks wrong, the JSONL event log is usually the fastest
path to a diagnosis. Find the session id from the run's first line of
output, then:

```bash
tail -n 20 .crewhaus/sessions/sess_<id>.jsonl | jq .
```

Each line is one of:

- `user_message` — your prompt + system reminders.
- `assistant_message` — the model's reply (text + tool calls).
- `tool_use` — a tool invocation about to run.
- `tool_result` — the tool's output (or a truncation pointer for
  outputs over 10 KB, with full content under `.crewhaus/tool-results/<runId>/`).
- `error` — a recovered or unrecovered error with its taxonomy
  classification.
- `compaction` — a snip or autocompact event with before/after token
  counts.

If you want live tracing during a run, set `CREWHAUS_TRACE=pretty`
(color-coded on stderr) or `CREWHAUS_TRACE=json` (one JSON object per
event on stdout). See [Recipe 17 — Observability](17-observability.md)
for the full surface.

## Putting it all together

A production-shaped CLI spec might look like this:

```yaml
name: my-coding-agent
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You help with TypeScript. Read files before editing. Run tests
    after non-trivial changes. Refuse to delete files without
    explicit confirmation in the prompt.
tools:
  - read
  - write
  - edit
  - glob
  - grep
  - bash
  - todoWrite
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysAllow
      pattern: Glob
    - type: alwaysAllow
      pattern: Grep
    - type: alwaysAllow
      pattern: Write(**/src/**)
    - type: alwaysAllow
      pattern: Write(**/test/**)
    - type: alwaysAllow
      pattern: Edit(**/src/**)
    - type: alwaysAllow
      pattern: Bash(bun *)
    - type: alwaysAllow
      pattern: Bash(git status)
    - type: alwaysAllow
      pattern: Bash(git diff*)
    - type: alwaysAsk
      pattern: Bash(**)
    - type: alwaysDeny
      pattern: Bash(rm -rf *)
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

That's a real coding agent. Adapt it to your project: tighten the
`Write` globs to your source dirs, allow-list the `bash` commands your
workflow uses, and add an `mcp_servers` entry for any external tools
you reach for often.

## What to read next

- **Different shape, same patterns.** [Recipe 02 — Sequential Workflow](02-sequential-workflow.md)
  is the simplest progression — strict step ordering instead of a chat
  loop. [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md) is the
  natural progression when one role isn't enough.
- **Put it in Slack.** Once you have a CLI agent you like, [Recipe 03
  — Slack Bot](03-slack-bot.md) shows how to keep the same spec but
  serve it from a long-running daemon.
- **Test it.** [Recipe 12 — Eval Harness](12-eval-harness.md) walks
  through writing a dataset + graders for the spec you just built.
- **Watch it run.** [Recipe 17 — Observability](17-observability.md)
  covers tracing, metrics, OTel, and cost reporting.

## Pointers to source

- **Smallest example:** [`examples/hello-cli/crewhaus.yaml`](../../examples/hello-cli/crewhaus.yaml).
- **Bigger example with MCP:** [`examples/mcp-smoke/crewhaus.yaml`](../../examples/mcp-smoke/crewhaus.yaml).
- **Spec schema (the source of truth for valid YAML):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts).
- **CLI compiler entry:** [`apps/cli/src/index.ts`](../../apps/cli/src/index.ts).
- **CLI codegen:** [`packages/target-cli`](../../packages/target-cli).
- **Runtime loop:** [`packages/runtime-core/src/index.ts`](../../packages/runtime-core/src/index.ts).
- **Module catalog reference:** §2, §6–§14 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
