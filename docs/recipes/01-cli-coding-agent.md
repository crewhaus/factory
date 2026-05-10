# Recipe 01 — CLI Coding Agent

> **Status:** stub. The pointers below are accurate; the walkthrough prose
> is not written yet.

## What you'll learn

Build a Claude Code-style streaming chat agent with file tools, bash,
MCP servers, hooks, skills, and slash commands. This is the canonical
shape and the right starting point for learning every other shape.

## Prerequisites

- [Getting Started](../GETTING-STARTED.md) up to "Your first agent in 60 seconds"
- An Anthropic credential in `.env` (`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`)

## Roadmap

The full recipe will cover:

1. The minimal 5-line spec and what each line does.
2. Adding the `read` / `write` / `edit` / `bash` / `glob` / `grep` tools.
3. Permission rules — `alwaysAllow`, `alwaysAsk`, glob patterns.
4. Plugging in an MCP server (filesystem + GitHub examples).
5. Project-level skills under `.crewhaus/skills/<name>/SKILL.md`.
6. Custom slash commands under `.crewhaus/commands/`.
7. Hooks at `pre-tool` / `post-tool` / `pre-model` lifecycle events.
8. Resuming a session with `--resume <sessionId>`.
9. Reading the JSONL event log to debug a turn.

## Run it now

```bash
bun run compile:hello
bun run run:hello
```

## Pointers to existing material

- **Example:** [`examples/hello-cli/crewhaus.yaml`](../../examples/hello-cli/crewhaus.yaml) — the 5-line minimum.
- **Bigger example with MCP:** [`examples/mcp-smoke/crewhaus.yaml`](../../examples/mcp-smoke/crewhaus.yaml).
- **Codegen:** [`packages/target-cli`](../../packages/target-cli) — the CLI bundle emitter.
- **Runtime entry:** [`packages/runtime-core/src/index.ts`](../../packages/runtime-core/src/index.ts) — `runChatLoop`.
- **Catalog:** §2, §6–§14 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).

## Where to go next

- For a sequential pipeline of agents instead of one chat loop → [Recipe 02 — Sequential Workflow](02-sequential-workflow.md).
- For a CLI agent that lives in Slack instead of your terminal → [Recipe 03 — Slack Bot](03-slack-bot.md).
- To extend the tool catalog → [Recipe 13 — MCP Servers](13-mcp-servers.md).
- To enforce custom safety/audit logic → [Recipe 14 — Hooks](14-hooks.md).
