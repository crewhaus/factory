# hello-cli — minimal vertical slice

The smallest possible end-to-end demonstration of the meta-harness pipeline:
a 5-line spec → compiled to a runnable streaming chat agent.

## Run it

From the repo root:

```bash
bun install
bun run compile:hello                       # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bun run run:hello  # opens an interactive REPL
```

Or directly:

```bash
bun ../../apps/cli/src/index.ts compile crewhaus.yaml -o dist
ANTHROPIC_API_KEY=sk-... bun dist/agent.ts
```

Type messages, get streaming replies, type `exit` to quit.

## What this slice exercises

Catalog modules touched (per `docs/MODULE-CATALOG.md`):
- F1 `spec-schema`, `spec-parser`, `spec-validator`, `ir-model`
- F2 `compiler-core`, `target-cli-bundle`, `codegen-templates`
- F4 `spec-cli`
- R1 `runtime-orchestrator` (single-turn-cycle, no recovery yet)
- R2 `model-adapter` (Anthropic only), `prompt-cache-manager` (system prompt)

## Not yet in the slice

Tools, permission system, multi-layer compaction, MCP integration, hooks,
skills, slash commands, plan mode, subagents, telemetry, eval — these
arrive in subsequent layers (see PART G build dependency order in the
module catalog).
