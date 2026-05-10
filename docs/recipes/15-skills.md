# Recipe 15 — Skills

> **Status:** stub.

## What you'll learn

Make domain-specific procedures available to the agent as
markdown-defined "skills" that it can opt into via a synthetic
`Skill(name)` tool. Frontmatter loads at boot; the body loads only
when the model calls the skill — so a registry of 50 skills doesn't
cost 50 system prompts' worth of tokens.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The skill file format: `SKILL.md` with frontmatter (`name`, `description`, optional `triggers`).
2. Discovery order: `~/.crewhaus/skills/<name>/SKILL.md` → `<cwd>/.crewhaus/skills/<name>/SKILL.md` → plugin dirs. Project layer overrides user layer by name.
3. The synthetic `Skill` tool — what the model sees in the system prompt vs what loads on call.
4. Lazy loading: discovery touches frontmatter only; the body is loaded by the runtime when the model calls `Skill({ name: "x" })`.
5. Authoring guidance: a skill body is a procedure, not a fact dump. Lead with the step list.
6. Worked examples: a `release-checklist` skill, a `bug-triage` skill, a `code-review` skill.
7. When skills are the wrong abstraction — prefer `instructions` for things every turn needs.

## Run it now

```bash
# No bundled skills example yet — drop a SKILL.md under
# .crewhaus/skills/<name>/ in any working spec directory.
```

## Pointers to existing material

- **Module:** [`packages/skills-registry`](../../packages/skills-registry).
- **Catalog:** §11.

## Where to go next

- For invokable user-typed shortcuts → [Recipe 16 — Slash Commands](16-slash-commands.md).
- For lifecycle-event automation → [Recipe 14 — Hooks](14-hooks.md).
