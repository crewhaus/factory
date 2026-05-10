# Recipe 16 — Slash Commands

> **Status:** stub.

## What you'll learn

Define markdown-templated user-input shortcuts that expand at the user
layer before the model ever sees them. Useful for one-key access to
your team's recurring workflows: `/review`, `/release`, `/postmortem`.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The command file format: `<cwd>/.crewhaus/commands/<name>.md` with optional frontmatter (`description`, `argument-hint`).
2. The expansion grammar: `^\/(\S+)\s*([\s\S]*)$` matches `/<name> <args>`; `$ARGUMENTS` is replaced by the args verbatim.
3. Why non-recursive: avoids infinite expansion loops when commands reference each other.
4. Multi-line bodies and regex-special-character safety in arguments.
5. The `pre-slash` hook: rewrite or block expansions before they hit the model.
6. User-level commands (`~/.crewhaus/commands/`) layered under project-level.
7. Worked examples: `/review <pr#>`, `/release <version>`, `/explain <file:line>`.

## Run it now

```bash
# No bundled slash-commands example yet — drop a markdown file under
# .crewhaus/commands/ in any working spec directory.
```

## Pointers to existing material

- **Module:** [`packages/slash-commands`](../../packages/slash-commands).
- **Catalog:** §11.

## Where to go next

- To intercept and rewrite expansions → [Recipe 14 — Hooks](14-hooks.md), specifically `pre-slash`.
- To package skills + commands together for a team → [Recipe 26 — Template Marketplace](26-template-marketplace.md).
