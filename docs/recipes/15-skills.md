# Recipe 15 — Skills

Make domain-specific procedures available to the agent as markdown
"skills" that it opts into via a synthetic `Skill(name)` tool.
Frontmatter loads at boot; the body loads only when the model calls
the skill — so a registry of 50 skills doesn't cost 50 system prompts'
worth of tokens.

You'd use skills when:

- A procedure is **multi-step and shared** across many sessions
  ("how we run a release", "how we triage a bug").
- The procedure is **conditionally relevant** — most sessions don't
  need it; the ones that do need it badly.
- The procedure is **stable enough to commit** to the repo but
  **specific enough** that you don't want it in the agent's default
  system prompt.

If the guidance is short and every session needs it, put it in
`agent.instructions` instead. If the guidance is a single tool call,
write a tool.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.

## The skill file format

A skill is a directory containing one `SKILL.md` with frontmatter and
a markdown body:

```markdown
---
name: release-checklist
description: Walk through cutting a release. Use when the user says "ship", "release", or "tag a version".
triggers:
  - ship
  - release
  - tag
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

Frontmatter fields:

| Field         | Required? | Purpose                                                   |
| ------------- | --------- | --------------------------------------------------------- |
| `name`        | yes       | The skill identifier — what `Skill({name})` matches.       |
| `description` | yes       | One-line hint shown in the model's system prompt.          |
| `triggers`    | no        | Suggested keywords. Documentation only, not enforced.       |

The body is anything you want. By convention: numbered steps, a
clear "stop and ask" branch, and references to specific tools.

## Discovery order

The runtime looks for skills in three places, in order:

1. **Project skills.** `<cwd>/.crewhaus/skills/<name>/SKILL.md` — version-
   controlled with your repo. Highest priority.
2. **User skills.** `~/.crewhaus/skills/<name>/SKILL.md` — per-user,
   shared across all your projects.
3. **Plugin skills.** Shipped by installed crewhaus plugins (see
   [`packages/skills-registry`](../../packages/skills-registry) for
   the loader).

If two layers declare the same skill name, project wins over user
wins over plugin.

## What the model sees at boot vs at call

Discovery is **frontmatter-only** — the runtime reads each `SKILL.md`,
parses the frontmatter, and ignores the body. So:

- **System prompt at boot:**

  ```
  Skills available (call Skill({name}) to use):
  - release-checklist — Walk through cutting a release. Use when the user says "ship", "release", or "tag a version".
  - bug-triage — Walk through triaging a customer bug report.
  - code-review — Walk through reviewing a pull request.
  ```

  ~30 tokens per skill, regardless of body size.

- **At call time:** when the model invokes `Skill({ name: "release-checklist" })`,
  the runtime reads the body from disk and returns it as the tool's
  output. The model then has the full procedure in its context for
  the rest of the turn.

This lazy loading is why 50 skills aren't 50× as expensive at boot —
only the skill the model picks costs body-sized tokens.

## Authoring guidance

**Lead with the step list.** The model reads top-down; the first
thing it should see is the steps, not the rationale.

**Use second-person imperatives.** "Run X", "Read Y", "Ask the user
before Z". Not "the operator should run X".

**Mark explicit stop points.** Procedures that don't say where to
stop tend to run off the end and the agent improvises. Better:

```markdown
4. If `bun test` fails, **stop**. Print the failing test output and
   ask the user whether to investigate or skip the release.
```

**Reference tools by their model-facing name.** `Read`, `Write`,
`Bash`, `filesystem__read_file` for MCP tools. So the agent knows
exactly what to call.

**Don't repeat instructions** that are already in `agent.instructions`.
A skill is a delta on top of the base system prompt, not a rewrite of
it.

**Keep bodies short.** 500–1500 tokens is the sweet spot. Past 2000,
consider splitting into two skills (`release-checklist-prep` and
`release-checklist-publish`).

## Worked examples

### `release-checklist`

```markdown
---
name: release-checklist
description: Cut a release. Use when the user mentions ship/release/tag/version-bump.
---

# Release

1. Verify CI green on main: `gh workflow view ci.yml`.
2. Run `bun run typecheck` and `bun run test` locally. **Stop on failure.**
3. Update CHANGELOG.md with a section for the new version. Use the
   `Edit` tool to add entries.
4. Bump version: `bun pm version <patch|minor|major>`.
5. Commit: `git commit -am "chore(release): vX.Y.Z"`.
6. Tag: `git tag vX.Y.Z`.
7. Push: `git push && git push --tags`.
8. Verify the release workflow ran: `gh run list --workflow=release.yml -L 1`.
```

### `bug-triage`

```markdown
---
name: bug-triage
description: Triage a customer bug report from Linear. Use when the user shares a Linear link or asks "what should we do with this bug?".
---

# Bug triage

1. Read the Linear ticket via the `linear__get_issue` MCP tool.
2. Read any linked logs or stack traces.
3. Categorize: severity (P0/P1/P2/P3), area (auth/billing/data/UI/infra),
   and reproducibility (always/sometimes/never).
4. Assign to the relevant team based on area.
5. If P0/P1, also: post to #incidents Slack channel, page on-call
   via `pagerduty__incident_create`.
6. Update the Linear ticket with your triage notes.
```

### `code-review`

```markdown
---
name: code-review
description: Review a pull request for safety and correctness. Use when the user provides a PR number or URL.
---

# Code review

1. Fetch PR metadata: `gh pr view <num> --json title,body,files`.
2. For each changed file, `Read` it and the diff (`gh pr diff <num>`).
3. Check for: unhandled errors, untested branches, missing types,
   N+1 queries, security issues (injection, SSRF, secrets).
4. Run the PR's tests locally if they're cheap (under 60s).
5. Post review as a structured comment via `gh pr review`.
6. **Don't approve** without explicit user say-so. Always request changes
   or leave a comment unless the user has authorized approve.
```

## Combining skills with hooks

Skills are model-discovered (the model picks when to use one). For
**always-on** procedures, you want hooks — `pre-tool` or `pre-model`
hooks fire on every call regardless of model intent.

A common combination:

- **Hook:** `pre-tool` hook that audits every Bash invocation.
- **Skill:** `release-checklist` skill that the agent invokes when
  the user says "ship".

The hook never fails; the skill only loads when invoked. Different
shapes for different needs.

## Things that look like a skill but aren't

| Symptom                                                            | Better tool                                    |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| One paragraph that every session needs.                            | `agent.instructions`                           |
| Step-by-step that the **user**, not the model, types.              | [Slash command](16-slash-commands.md)          |
| A single tool call that's awkward to spell out.                    | A custom tool via [tool-builder](../../packages/tool-builder) |
| A long reference document the agent should cite from.              | [RAG pipeline](06-rag-pipeline.md)             |

## Debugging skills

To check what skills the runtime discovered:

```bash
crewhaus skills list
```

Lists every skill the registry found, with its source path. Useful
when a project skill isn't winning over a user skill (e.g. typo in
the name).

To see the system-prompt rendering:

```bash
CREWHAUS_TRACE=pretty bun run run:hello 2>&1 | grep -A20 "system_prompt"
```

The "Skills available:" block prints with the rendered description
for each discovered skill.

## What to read next

- **User-typed shortcuts (the user opts in).** [Recipe 16 — Slash Commands](16-slash-commands.md).
- **Lifecycle-event automation (always-on).** [Recipe 14 — Hooks](14-hooks.md).
- **Skills security.** [Recipe 41 — Security Fabric](41-security-fabric.md)
  — skill bodies are classified before reaching the model.

## Pointers to source

- **Registry / discovery / lazy load:** [`packages/skills-registry`](../../packages/skills-registry).
- **Tool surface:** the `Skill` tool is auto-registered by `runtime-core`.
- **Module catalog reference:** §11 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
