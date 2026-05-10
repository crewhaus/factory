# Recipe 14 — Hooks

> **Status:** stub.

## What you'll learn

Run shell commands at every meaningful runtime moment and let them
allow, deny, or mutate what happens next. Use hooks for sandbox
enforcement, audit trails to external systems, custom safety checks,
slash-command rewriting, and integration with corporate compliance
tools.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The nine lifecycle events: `session-start | stop | pre-tool | post-tool | pre-model | post-model | pre-compact | post-compact | pre-slash`.
2. Where hooks are declared: project `<cwd>/.crewhaus/settings.json`, layered over user `~/.crewhaus/settings.json`.
3. The hook contract: the hook process gets event JSON on stdin, prints a decision JSON on stdout.
4. Decisions: `{ decision: "allow" | "deny" | "block", reason?, mutate? }`. `block` short-circuits the entire turn; `deny` short-circuits only the in-flight tool/model call.
5. The `mutate` field — currently only honored for `pre-slash` (rewrite the expanded command).
6. Restricted env: hooks run with PATH trimmed and credentials stripped (`ANTHROPIC_AUTH_TOKEN`, `AWS_*`, `GH_TOKEN`, `OPENAI_API_KEY`).
7. Default 5 s timeout per hook; SIGKILL on miss with drain-grace for orphan grandchildren.
8. Aggregating multiple hooks per event: short-circuit on first deny/block.
9. Worked examples: log every Bash invocation to syslog, refuse Write under `/etc/`, intercept slash commands.

## Run it now

```bash
# No bundled hooks example yet — add hooks to .crewhaus/settings.json
# in any working spec directory and watch them fire.
```

## Pointers to existing material

- **Module:** [`packages/hooks-engine`](../../packages/hooks-engine).
- **Settings format:** see [`packages/hooks-engine/src/index.test.ts`](../../packages/hooks-engine/src/index.test.ts) for the schema in action.
- **Catalog:** §11.

## Where to go next

- For markdown-based skill discovery → [Recipe 15 — Skills](15-skills.md).
- For slash-command shortcuts that hooks can rewrite → [Recipe 16 — Slash Commands](16-slash-commands.md).
- For audit-log integration in production → [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
