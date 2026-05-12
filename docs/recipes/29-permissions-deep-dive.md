# Recipe 29 — Permissions Deep Dive

The full mental model for the five-layer permission system: how rules
compose across layers, how patterns match tool names and arguments,
how the four modes change defaults, and the security guard that
blocks `mode: bypass` from any source other than a CLI flag.

You'd read this end-to-end if you're:

- Authoring **production permission rules** for a real workload.
- Debugging an unexpected ask / deny.
- Reviewing a teammate's permission config before merge.

For first-time spec authoring, [Recipe 01 Step 4](01-cli-coding-agent.md#step-4--permissions)
covers the basics.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  spec block and the first read of rule grammar.

## The five rule sources

The permission engine evaluates rules from five layers, in order.
**Later layers override earlier ones.**

| Layer        | Source                                                | Example                                          |
| ------------ | ----------------------------------------------------- | ------------------------------------------------ |
| 1. Flag      | `--permission-mode <mode>` on the CLI.                | `bun run … -- --permission-mode auto`            |
| 2. Settings  | `<cwd>/.crewhaus/settings.json` → `~/.crewhaus/settings.json`. | `{"permissions":{"mode":"auto","rules":[...]}}` |
| 3. YAML      | `permissions:` block in the spec.                     | Default authoring layer.                          |
| 4. Hooks     | `pre-tool` hook decisions.                             | Shell-time policy.                                |
| 5. Builtin   | Per-tool defaults baked into the tool definition.      | `Read.readOnly = true` ⇒ default allow.           |

Within a layer, rules apply tier-first: **deny > ask > allow**.
Across layers, later layers override.

So if the YAML says `alwaysAllow Bash(*)` but a hook returns
`{decision: deny}`, the hook wins.

The complete evaluation:

```
flag.mode → settings.rules + settings.mode → yaml.rules → hook.decision → builtin
```

The first non-default outcome wins.

## The four modes

| Mode      | Defaults                                                                  |
| --------- | ------------------------------------------------------------------------- |
| `default` | Allow `readOnly` tools (Read, Grep, Glob); ask for `destructive` tools.   |
| `plan`    | Strictest. Deny all writes; the agent plans then asks before acting.       |
| `auto`    | Allow what `rules` declares; ask for the rest.                            |
| `bypass`  | Allow everything. **CLI-flag-only.**                                       |

### The `bypass` security guard

`bypass` is the developer's "I know what I'm doing" escape hatch. But
to prevent a malicious or buggy file from silently turning it on,
**`parsePermissionsConfig` rejects `mode: bypass` from any source
except the CLI flag**.

So a yaml spec containing:

```yaml
permissions:
  mode: bypass
```

Fails at parse with:

```
permissions.mode = "bypass" is not legal in spec or settings; only via --permission-mode flag
```

Same for settings.json and hook output. The only legal source is:

```bash
bun apps/cli/src/index.ts run spec.yaml --permission-mode bypass
```

This is **a security-critical invariant**. There's a dedicated unit
test in `packages/permission-engine/src/permission-engine.test.ts`
that asserts the rejection — don't relax it.

## Rule kinds and tier order

| Kind          | Effect                                       |
| ------------- | -------------------------------------------- |
| `alwaysAllow` | Tool call proceeds without prompt.            |
| `alwaysAsk`   | User prompted for each call.                  |
| `alwaysDeny`  | Tool call refused; the model sees a denial.   |

For a given tool call, the engine matches every rule and picks the
tier in **deny > ask > allow** order. So:

```yaml
permissions:
  rules:
    - type: alwaysAllow
      pattern: Bash(*)
    - type: alwaysDeny
      pattern: Bash(rm -rf *)
```

A `Bash(rm -rf /)` call hits both. The `alwaysDeny` wins (deny beats
allow). A `Bash(ls)` call hits only the first; it's allowed.

## The pattern grammar

Patterns are glob-like, with optional argument matchers:

| Pattern                  | Matches                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `Read`                   | Any `Read` call regardless of arguments.                            |
| `Read(*)`                | Any `Read` call (equivalent to `Read`).                              |
| `Write(**/src/**)`       | `Write` whose path argument is under any `src/` directory.           |
| `Bash(git *)`            | `Bash` whose command starts with `git ` (note the trailing space).   |
| `Bash(**)`               | Any `Bash` call.                                                     |
| `Bash(rm -rf *)`          | Any `Bash` whose command starts with `rm -rf `.                      |
| `*__list_directory`      | Any tool whose name ends with `__list_directory` (MCP namespacing).  |

The argument matcher is a small glob:

- `*` matches any sequence of non-`/` characters.
- `**` matches any sequence including `/`.
- `?` matches a single character.

The matcher is **string-glob**, not regex. So `Bash(rm -rf /)` only
matches the literal command `rm -rf /`, not arbitrary `rm` invocations.

## The `evaluate` contract

```typescript
evaluate(
  call: { tool: string, input: unknown },
  mode: PermissionMode,
  rules: PermissionRule[]
): "allow" | "deny" | "ask"
```

Implementation order:

1. Find every rule whose pattern matches `(tool, input)`.
2. If any `alwaysDeny` matches → `deny`.
3. Else if any `alwaysAsk` matches → `ask`.
4. Else if any `alwaysAllow` matches → `allow`.
5. Else fall through to the mode's default for the tool's flags.

The flags that drive the fall-through:

| Tool flag         | Default in `default` mode                            |
| ----------------- | ---------------------------------------------------- |
| `readOnly: true`  | `allow`                                              |
| `destructive: true` | `ask`                                                |
| `requiresSandbox: true` | `deny` unless a sandbox is configured              |
| Neither flag      | `ask` (fail-closed)                                  |

So a tool author who declares neither flag gets the safest behavior
by default — never silently permitted.

## Sub-agent permission inheritance

Three modes ([Recipe 28](28-sub-agents-and-task.md) for full
treatment):

| Mode      | Behavior                                                                 |
| --------- | ------------------------------------------------------------------------ |
| `inherit` | Child gets exactly the parent's rules.                                    |
| `scoped`  | Child gets only rules whose `toolGlob` matches a child tool. Default.     |
| Explicit  | Child uses its sub-agent definition's `rules` directly.                   |

**`bypass` does not propagate.** A parent in bypass mode still
produces children in `default` mode. This is the same property the
parser enforces (bypass is CLI-flag-only); inheritance respects it.

## Tenant policy overrides (managed only)

For multi-tenant managed deployments ([Recipe 11](11-managed-multitenant.md)),
the policy engine runs **after** the permission grant, before exec:

```
permission_engine.evaluate → policy_engine.evaluatePolicy → tool.exec
```

The policy engine can:

- **`audit-and-allow`** a call (the permission engine said allow; the
  policy engine wraps it with an audit-log entry).
- **`deny`** even if the permission engine said allow (per-tenant
  override).

The policy engine **cannot** override a permission denial — defense
in depth. Once the permission engine says deny, the call doesn't
reach the policy engine at all.

## Worked examples

### 1. Coding agent — Read free, Write scoped, Bash gated

```yaml
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
```

What the agent can do without prompts: read anything, write into any
`src/` dir, run `bun *`, `git status`, `git diff*`. Anything else
that's Bash asks. `rm -rf *` is denied outright.

### 2. Slack bot — Read free, Bash always asks

```yaml
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysAsk
      pattern: Bash(**)
```

In daemon context, "ask" means the daemon logs the question to
stdout/audit. For Slack bots typically replaced with curated
`alwaysAllow Bash(safe-prefix *)` rules so the daemon runs
non-interactively.

### 3. Browser agent — destructive tools allow-listed

```yaml
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Screenshot
    - type: alwaysAllow
      pattern: FindElement
    - type: alwaysAllow
      pattern: Click
    - type: alwaysAllow
      pattern: Type
    - type: alwaysAllow
      pattern: Key
    - type: alwaysAllow
      pattern: Scroll
```

The browser tools declare `destructive: true`; without explicit
allows, every action would prompt. The allow-listed shape is the
production pattern for browser agents ([Recipe 10](10-browser-agent.md)).

### 4. Read-only investigator

```yaml
permissions:
  mode: plan
```

Plan mode denies all writes. The agent has to reason without acting —
useful for "tell me what's wrong with this codebase" workloads where
you don't want it to start changing files.

## Debugging permission decisions

`CREWHAUS_TRACE=pretty` prints permission decisions:

```
[permission] Bash(rm -rf /) → deny (rule: alwaysDeny Bash(rm -rf *))
[permission] Bash(ls -la) → allow (rule: alwaysAllow Bash(bun *) didn't match; fallthrough: destructive, mode=default → ask)
```

The fall-through reasoning makes it clear **why** the decision came
out the way it did.

## Things that look like permissions but aren't

| Symptom                                                            | Better tool                                    |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| Want to **transform** tool input before exec (PII redaction).       | `pre-tool` hook with `mutate`.                  |
| Want a **per-tenant** override.                                     | Policy engine + tenant config.                  |
| Want **rate** limits on tool use.                                   | [Rate limiter](19-rate-limiting-and-budgets.md). |
| Want **audit** of allowed calls.                                    | `sideEffect: audit-and-allow` flag.            |

## What to read next

- **Shell hook-based runtime checks.** [Recipe 14 — Hooks](14-hooks.md).
- **Sandbox-enforced code execution.** [Recipe 30 — Sandboxed Code Execution](30-sandboxed-code-execution.md).
- **Sub-agent inheritance.** [Recipe 28 — Sub-agents and Task](28-sub-agents-and-task.md).

## Pointers to source

- **Permission engine:** [`packages/permission-engine`](../../packages/permission-engine).
- **Pattern matcher:** [`packages/tool-permission-matcher`](../../packages/tool-permission-matcher).
- **Policy engine (multi-tenant):** [`packages/policy-engine`](../../packages/policy-engine).
- **Sub-agent inheritance:** [`packages/sub-agent-permission-inheritance`](../../packages/sub-agent-permission-inheritance).
- **Module catalog reference:** §7, §13 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
