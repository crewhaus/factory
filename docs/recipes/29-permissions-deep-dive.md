# Recipe 29 — Permissions Deep Dive

> **Status:** stub.

## What you'll learn

The full mental model for the five-layer permission system: how rules
compose across layers, how patterns match tool names and arguments,
how the four modes change defaults, and the security guard that blocks
`mode: bypass` from any source other than a CLI flag.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The five rule sources, in evaluation order: flag → settings → yaml → hooks → builtin. Later layers override earlier ones.
2. The four modes:
   - `default` — allow read-only; ask for destructive.
   - `plan` — strictest; deny all writes; the agent plans then asks.
   - `auto` — allow what's declared; ask for the rest.
   - `bypass` — allow everything. **CLI-flag-only.** `parsePermissionsConfig` rejects `mode: bypass` from yaml/settings/hooks (security test).
3. Rule kinds: `alwaysAllow`, `alwaysAsk`, `alwaysDeny`. Tier order: deny > ask > allow.
4. The pattern grammar: `Bash(git *)`, `Read`, `Write(**/src/**)`, `Bash(**)`. Glob over the tool name + optional argument matcher.
5. The `evaluate(call, mode, rules) → "allow" | "deny" | "ask"` contract.
6. Tool flags that interact with permissions: `destructive`, `concurrencySafe`, `readOnly`, `requiresSandbox`. Defaults are fail-closed.
7. Sub-agent permission inheritance: `inherit` / `scoped` / explicit `{allow, deny}`, with bypass non-propagation.
8. Tenant policy overrides: `policy-engine.evaluatePolicy` runs after the permission grant, before exec — adds `audit-and-allow`.
9. Worked examples: a CLI agent that may freely Read but only Write under `src/`, a channel bot whose `Bash` always asks.

## Run it now

```bash
bun test packages/permission-engine
bun test packages/policy-engine
```

## Pointers to existing material

- **Modules:** [`packages/permission-engine`](../../packages/permission-engine), [`packages/tool-permission-matcher`](../../packages/tool-permission-matcher), [`packages/policy-engine`](../../packages/policy-engine), [`packages/sub-agent-permission-inheritance`](../../packages/sub-agent-permission-inheritance).
- **Catalog:** §7, §13 (sub-agent inheritance).

## Where to go next

- For automated runtime checks via shell hooks → [Recipe 14 — Hooks](14-hooks.md).
- For sandbox-enforced code execution → [Recipe 30 — Sandboxed Code Execution](30-sandboxed-code-execution.md).
