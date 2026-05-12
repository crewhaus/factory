# Recipe 14 — Hooks

Run shell commands at every meaningful runtime lifecycle event and
let them allow, deny, or mutate what happens next. Hooks are the
right tool for sandbox enforcement, custom audit trails, corporate
compliance integration, and slash-command rewriting.

You'd use hooks when:

- A **shell command** is the natural integration point (calling
  `auditd`, `splunk forwarder`, a corp policy CLI).
- The check needs to be **per-deployment, not per-spec** — your team
  enforces "no Bash with rm -rf" across every agent, not in each YAML.
- You want **mutation** capabilities (rewriting a slash command's
  expansion).

If the check is a pure TypeScript function, prefer authoring a
permission hook in code (see [Recipe 29](29-permissions-deep-dive.md)).
Hooks pay subprocess cost; TS predicates don't.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.

## The nine lifecycle events

| Event           | When                                              | Common uses                                       |
| --------------- | ------------------------------------------------- | ------------------------------------------------- |
| `session-start` | Before the first turn of a session.               | Wire up external audit, fetch corp config.        |
| `stop`          | Before the session exits (clean or error).        | Flush metrics, archive session.                   |
| `pre-tool`      | Before every tool call.                           | Permission overrides, custom audit.                |
| `post-tool`     | After every tool call (with result).              | Audit result, redact PII.                          |
| `pre-model`     | Before every model call.                          | Inject system reminders, fail-closed checks.       |
| `post-model`    | After every model response.                       | Audit token spend.                                 |
| `pre-compact`   | Before autocompact runs.                          | Block compaction in regulated workloads.           |
| `post-compact`  | After autocompact completes.                      | Notify on cache invalidation.                      |
| `pre-slash`     | Before a slash command expands.                   | Rewrite expansion, deny dangerous shortcuts.        |

The complete list is enforced by the `hooks-engine` module
([packages/hooks-engine](../../packages/hooks-engine)).

## Declaring hooks

Hooks are declared in `<cwd>/.crewhaus/settings.json`:

```json
{
  "hooks": {
    "pre-tool": [
      {
        "command": "if echo \"$CREWHAUS_TOOL_NAME\" | grep -q '^Bash$' && echo \"$CREWHAUS_TOOL_INPUT\" | grep -q 'rm -rf /'; then echo '{\"decision\":\"deny\",\"reason\":\"refused rm -rf /\"}'; else echo '{\"decision\":\"allow\"}'; fi"
      }
    ],
    "post-tool": [
      {
        "command": "logger -t crewhaus \"tool=$CREWHAUS_TOOL_NAME outcome=$CREWHAUS_TOOL_OUTCOME\""
      }
    ]
  }
}
```

User-level hooks live in `~/.crewhaus/settings.json` and are layered
**under** project-level hooks (project hooks evaluate first, then user
hooks).

## The hook contract

Every hook receives:

- **stdin** — a single line of JSON with the event payload.
- **env vars** — short-form fields lifted out of the payload for
  convenience: `CREWHAUS_EVENT`, `CREWHAUS_SESSION_ID`,
  `CREWHAUS_TOOL_NAME`, `CREWHAUS_TOOL_INPUT`, `CREWHAUS_TOOL_OUTCOME`,
  `CREWHAUS_MODEL`, etc.

Every hook must produce:

- **stdout** — a single line of JSON: `{"decision": "...", "reason": "...", "mutate": {...}}`.

Decision values:

| Value      | Effect                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| `allow`    | Continue normally. Optional `reason` ignored.                              |
| `deny`     | Short-circuit the in-flight call. `pre-tool` deny → tool not invoked; `pre-model` deny → model call refused. |
| `block`    | Short-circuit the **entire turn**. The session continues but the user's next message reignites it. |
| `mutate`   | Currently only `pre-slash` honors `mutate.text` — replaces the expanded command. |

If a hook prints anything other than valid JSON, the engine treats it
as `{"decision": "allow"}` and logs a warning. Errors do not block
runs.

## Restricted env

Hooks run with a restricted environment to prevent a compromised hook
from exfiltrating credentials:

| Env var                                         | Available to hook?       |
| ----------------------------------------------- | ------------------------ |
| `PATH`                                          | Trimmed to `/usr/bin:/usr/local/bin:/opt/homebrew/bin` |
| `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`      | **Stripped**             |
| `OPENAI_API_KEY`                                | **Stripped**             |
| `AWS_*`                                         | **Stripped**             |
| `GH_TOKEN`, `GITHUB_TOKEN`                       | **Stripped**             |
| `CREWHAUS_GATEWAY_JWT_SECRET`                    | **Stripped**             |
| Any other env var matching `*_TOKEN`, `*_SECRET`, `*_KEY` | **Stripped**     |
| `CREWHAUS_*`                                    | Available                |
| `HOME`, `USER`                                  | Available                |

Override the strip list via `hooks.envPolicy` in settings (rare;
generally a bad idea):

```json
{
  "hooks": {
    "envPolicy": "passthrough"
  }
}
```

## Timeout and aggregation

Each hook has a default 5-second timeout. The engine SIGKILLs on
miss; orphan grandchildren get a 250ms drain grace before SIGKILL.

Multiple hooks per event run in **declaration order** and the engine
**short-circuits on the first deny/block**. So:

```json
{
  "hooks": {
    "pre-tool": [
      { "command": "check-policy.sh" },
      { "command": "check-budget.sh" },
      { "command": "audit-call.sh" }
    ]
  }
}
```

If `check-policy.sh` returns `deny`, the other two never run.
`check-budget.sh` and `audit-call.sh` only run if every prior hook
returned `allow`.

For "always run regardless of prior decision" semantics, put the hook
in `post-tool` instead — post-tool hooks always run after the tool
completes, deny or not.

## Worked examples

### 1. Refuse Bash commands matching a denylist

```json
{
  "hooks": {
    "pre-tool": [
      {
        "command": "test \"$CREWHAUS_TOOL_NAME\" != \"Bash\" && { echo '{\"decision\":\"allow\"}'; exit 0; }; CMD=$(echo \"$CREWHAUS_TOOL_INPUT\" | jq -r .command); if echo \"$CMD\" | grep -qE 'rm -rf /|chmod 777|curl.*\\|.*bash'; then echo '{\"decision\":\"deny\",\"reason\":\"command matches denylist\"}'; else echo '{\"decision\":\"allow\"}'; fi"
      }
    ]
  }
}
```

### 2. Audit every tool call to syslog

```json
{
  "hooks": {
    "post-tool": [
      {
        "command": "logger -t crewhaus -p user.info \"session=$CREWHAUS_SESSION_ID tool=$CREWHAUS_TOOL_NAME outcome=$CREWHAUS_TOOL_OUTCOME\"; echo '{\"decision\":\"allow\"}'"
      }
    ]
  }
}
```

### 3. Rewrite `/deploy` slash command to add a timestamp

```json
{
  "hooks": {
    "pre-slash": [
      {
        "command": "test \"$CREWHAUS_SLASH_NAME\" != \"deploy\" && { echo '{\"decision\":\"allow\"}'; exit 0; }; TS=$(date -u +%FT%TZ); ORIG=$(echo \"$CREWHAUS_SLASH_EXPANSION\" | jq -r .); MUTATED=\"$ORIG (deployed at $TS)\"; jq -n --arg t \"$MUTATED\" '{decision:\"allow\",mutate:{text:$t}}'"
      }
    ]
  }
}
```

### 4. Block model calls outside business hours

```json
{
  "hooks": {
    "pre-model": [
      {
        "command": "HOUR=$(date +%H); if [ $HOUR -lt 8 ] || [ $HOUR -gt 18 ]; then echo '{\"decision\":\"block\",\"reason\":\"outside business hours\"}'; else echo '{\"decision\":\"allow\"}'; fi"
      }
    ]
  }
}
```

## Hooks vs permissions vs policy

Three overlapping mechanisms:

| Mechanism             | Authored in                | Runs at                              | Best for                                       |
| --------------------- | -------------------------- | ------------------------------------ | ---------------------------------------------- |
| **`permissions:`**     | spec YAML                  | Built into the codegen bundle        | Per-spec allow/ask/deny rules.                  |
| **Hooks**              | `.crewhaus/settings.json`  | Subprocesses at runtime              | Per-deployment policy, audit, mutation.         |
| **Policy engine**      | spec YAML (managed only)   | At the managed-gateway boundary      | Per-tenant overrides in multi-tenant setups.   |

Use the strongest of the three that fits the use case. For a single
spec, `permissions:` is enough. For deployment-wide rules, hooks. For
multi-tenant SaaS, policy.

## Things that look like a good hook idea but aren't

| Symptom                                                              | Better tool                                    |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| Per-spec deny rule.                                                  | `permissions: rules: alwaysDeny`               |
| Code-level pre-tool check that needs zero subprocess overhead.       | A `permission-engine` callback in code         |
| Cross-spec policy with version control.                              | A repo of `.crewhaus/settings.json` configs    |
| Mutating model output before the user sees it.                       | Not currently supported by hooks                |

## Debugging hooks

Set `CREWHAUS_HOOK_DEBUG=1` to log every hook invocation:

```
[hook:pre-tool] cmd=check-policy.sh stdin={"tool":"Bash",...} 
[hook:pre-tool] cmd=check-policy.sh exit=0 stdout={"decision":"allow"} duration=42ms
```

Useful when a hook isn't firing or when timing matters.

## What to read next

- **Markdown skill discovery.** [Recipe 15 — Skills](15-skills.md).
- **Slash command shortcuts.** [Recipe 16 — Slash Commands](16-slash-commands.md)
  — hooks can rewrite these.
- **Production compliance.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md)
  — hooks as one piece of the audit story.

## Pointers to source

- **Engine:** [`packages/hooks-engine`](../../packages/hooks-engine).
- **Schema (in test fixtures):** [`packages/hooks-engine/src/index.test.ts`](../../packages/hooks-engine/src/index.test.ts).
- **Module catalog reference:** §11 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
