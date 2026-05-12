# Recipe 16 — Slash Commands

Define markdown-templated user-input shortcuts that expand at the
user layer before the model ever sees them. The right tool for
one-key access to recurring workflows: `/review`, `/release`,
`/postmortem`, `/explain`.

You'd use slash commands when:

- The **user** types something the same way every time.
- A short keyword should expand into a longer, more precise prompt.
- You want the team to share **muscle memory** across many sessions.

If the prompt is constant (no arguments), it's a one-line skill
([Recipe 15](15-skills.md)). If the workflow runs *automatically* on
some event, it's a hook ([Recipe 14](14-hooks.md)). Slash commands
sit in the middle: human-triggered, parameterized, terse.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying REPL.

## The command file format

A slash command is one markdown file under `<cwd>/.crewhaus/commands/<name>.md`:

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

Frontmatter fields:

| Field           | Required? | Purpose                                                  |
| --------------- | --------- | -------------------------------------------------------- |
| `description`   | no        | One-line hint in `/help` output.                          |
| `argument-hint` | no        | Tab-completion hint for required args.                    |

Both fields are advisory; the runtime never enforces them. A command
with no frontmatter at all works — the file body becomes the
expansion.

## The expansion grammar

The user types `/<name> <args>`. The runtime:

1. Matches against `^\/(\S+)\s*([\s\S]*)$` to extract name and args.
2. Looks up `<name>` in the project-then-user-then-plugin order.
3. Reads the body and replaces `$ARGUMENTS` (verbatim, including
   regex-special characters) with the args.
4. Sends the result as the user's message to the model.

Example:

```
> /review 1234
```

Expands to:

```
Review PR 1234 using the `gh` CLI:
1. Run `gh pr view 1234 --json title,body,files`.
2. For each changed file, Read it and check for: untested changes,
   missing error handling, security issues, style inconsistencies.
3. Report findings as a markdown checklist with file:line references.
```

The model never sees the literal `/review 1234` — by the time it
gets the message, the expansion has already happened.

## Why non-recursive

If `/foo` expands to `/bar do-stuff`, the inner `/bar` does **not**
trigger another expansion. The user-typed text is the only thing the
runtime scans for slash commands; expanded bodies are sent verbatim.

This avoids:

- Infinite loops if `/a` expands to `/b` and `/b` expands to `/a`.
- Surprise reuse — you can paste a slash-command-style string into
  documentation without worrying about expansion.
- Hidden cost — the user always knows the maximum amount of text
  one keystroke can generate.

## Regex-special-character safety

`$ARGUMENTS` is replaced **literally** — no escaping, no parsing.
If the user types `/explain $1`, the expansion gets the literal `$1`
in the body. If the user types `/grep ".*foo"`, the body sees `.*foo`
unchanged.

So you can safely write commands that take regex arguments, code
snippets with backslashes, etc.

## Discovery layers

Like skills, slash commands have three layers:

1. **Project commands.** `<cwd>/.crewhaus/commands/<name>.md` —
   highest priority. Version-controlled.
2. **User commands.** `~/.crewhaus/commands/<name>.md` — shared
   across all your projects.
3. **Plugin commands.** Shipped by installed plugins.

Same name in multiple layers? Project wins.

## The `pre-slash` hook

A `pre-slash` hook can rewrite or block expansions before they hit
the model. The hook receives:

- **stdin:** `{ name, expansion, arguments, source }`.
- **env vars:** `CREWHAUS_SLASH_NAME`, `CREWHAUS_SLASH_ARGUMENTS`,
  `CREWHAUS_SLASH_EXPANSION`.

Decision options:

- `{"decision": "allow"}` — send the expansion as-is.
- `{"decision": "deny", "reason": "..."}` — refuse the command.
- `{"decision": "allow", "mutate": { "text": "..." }}` — replace the
  expansion entirely.

A worked rewrite hook ([Recipe 14](14-hooks.md) has more
detail):

```json
{
  "hooks": {
    "pre-slash": [
      {
        "command": "test \"$CREWHAUS_SLASH_NAME\" != \"deploy\" && { echo '{\"decision\":\"allow\"}'; exit 0; }; TS=$(date -u +%FT%TZ); ORIG=$(echo \"$CREWHAUS_SLASH_EXPANSION\" | jq -r .); MUTATED=\"$ORIG (deploy time: $TS)\"; jq -n --arg t \"$MUTATED\" '{decision:\"allow\",mutate:{text:$t}}'"
      }
    ]
  }
}
```

Useful for:

- Adding `Today's date is X.` to every `/standup` expansion.
- Refusing `/deploy production` outside business hours.
- Logging slash-command usage to corp audit.

## Worked examples

### `/review <pr-number>`

```markdown
---
description: Review a pull request
argument-hint: <pr-number>
---

Review PR $ARGUMENTS using the `gh` CLI:
1. Run `gh pr view $ARGUMENTS --json title,body,files,additions,deletions`.
2. For each changed file:
   a. Read it with the Read tool.
   b. Look for: untested branches, error handling gaps, security
      issues (injection, SSRF, hardcoded secrets), style drift.
3. Run the PR's tests if they exist: `gh pr checks $ARGUMENTS`.
4. Post your review as a structured markdown checklist with file:line
   references.

**Do not approve** the PR without explicit user instruction.
```

### `/release <patch|minor|major>`

```markdown
---
description: Cut a release
argument-hint: patch | minor | major
---

Cut a $ARGUMENTS release. Follow this exact procedure:
1. Verify CI green on main.
2. Run `bun run typecheck` and `bun run test`. STOP on failure.
3. Update CHANGELOG.md with a section for the new version.
4. Run `bun pm version $ARGUMENTS`.
5. Commit and tag.
6. Push: `git push && git push --tags`.
7. Verify the release workflow ran.

If anything looks off at any step, stop and ask me before continuing.
```

### `/explain <file:line>`

```markdown
---
description: Explain a code location
argument-hint: <file>:<line>
---

Explain the code at $ARGUMENTS:
1. Read the file.
2. Identify the function / block containing the line.
3. Explain what it does in 3-5 sentences, in plain English.
4. Note any non-obvious invariants, edge cases, or dependencies on
   other modules.
```

### `/standup`

```markdown
---
description: Generate yesterday's progress summary
---

Generate a standup update for me:
1. Run `git log --since=yesterday --author=$(git config user.email) --pretty=format:'%h %s'`.
2. For each commit, write one bullet describing what it did (look at
   the diff briefly if the message is terse).
3. Format as:
   - **Yesterday:** <bullets>
   - **Today:** (leave blank for me to fill in)
   - **Blockers:** (leave blank for me to fill in)
```

## Things that look like a slash command but aren't

| Symptom                                                  | Better tool                                |
| -------------------------------------------------------- | ------------------------------------------ |
| The text is the same every time, no `$ARGUMENTS`.        | [Skill](15-skills.md)                      |
| The flow has multiple model turns.                       | [Workflow](02-sequential-workflow.md)      |
| The expansion needs to query a remote system.            | A custom tool + a slash that calls it      |
| The trigger is *automatic*, not user-typed.              | [Hook](14-hooks.md)                        |

## Debugging slash commands

To list what the runtime discovered:

```bash
crewhaus commands list
```

If a project command isn't winning, check the precedence with:

```bash
crewhaus commands show <name>
```

Prints the resolved file path. Useful when a user-level command is
shadowing a project-level one due to a typo.

To see expansions live:

```bash
CREWHAUS_TRACE=pretty bun run run:hello
```

Each slash-command expansion logs at the user-message level:

```
[user] /review 1234
[slash:review] expanded args="1234" → 8 lines
[user] Review PR 1234 using the `gh` CLI: ...
```

## What to read next

- **Rewrite or block expansions.** [Recipe 14 — Hooks](14-hooks.md),
  specifically `pre-slash`.
- **Package slash commands + skills as a plugin.** [Recipe 26 — Template Marketplace](26-template-marketplace.md).
- **Model-discovered shortcuts (not user-typed).** [Recipe 15 — Skills](15-skills.md).

## Pointers to source

- **Module:** [`packages/slash-commands`](../../packages/slash-commands).
- **Hooks integration (`pre-slash`):** [`packages/hooks-engine`](../../packages/hooks-engine).
- **Module catalog reference:** §11 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
