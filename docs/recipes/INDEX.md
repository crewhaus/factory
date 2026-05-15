# Recipes

> Task-oriented walkthroughs for every major feature of crewhaus-factory.
> All 48 recipes are **complete** as of 2026-05-15. Every recipe is
> statically validated by `bun run recipes:test` and every recipe with
> a `compile:*` script in its frontmatter is also compile-smoke
> validated by `bun run recipes:smoke`.

If you're new here, start with [`docs/GETTING-STARTED.md`](../GETTING-STARTED.md)
first. Each recipe assumes you've read it.

Every recipe is statically validated by `bun run recipes:test`
([`scripts/test-recipes.ts`](../../scripts/test-recipes.ts)). Recipes
that opt into a `test:` frontmatter block also get compile-smoke
coverage via `bun run recipes:smoke`. See [Testing recipes](#testing-recipes)
below.

---

## Pick a recipe — diagnostic decision tree

The 48 recipes cover a lot of ground. Most readers don't need to scan
the table of contents; they need to find the shape that matches the
problem they brought. Walk this tree from the top:

0. **Not sure what you want yet?** → [Recipe 48 — Harness
   Designer](48-harness-designer.md) interviews you about intent and
   writes the spec for you. Use this when you can describe the *goal*
   but not the *shape*. Everything below is for when you'd rather
   pick the shape yourself.
1. **Are you just trying the system for the first time?** → start at
   [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md). Every other
   recipe assumes you've worked through it.
2. **Does the task need human-in-the-loop approval between steps, or
   the ability to resume after a crash?** → [Recipe 05 — Stateful
   Graph](05-stateful-graph.md). HITL pauses and durable checkpoints
   are graph-shaped, not workflow-shaped.
3. **Is the task highly parallelizable — multiple subtasks that each
   benefit from a dedicated specialist role?** → [Recipe 04 — Multi-Agent
   Crew](04-multi-agent-crew.md). (Google's scaling study found
   centralized multi-agent topologies help parallelizable reasoning,
   while *hurting* sequential reasoning by 39–70% — see the
   architectural-context callouts in recipes 02 and 04.)
4. **Is each step a clearly-bounded "extract → transform → format"
   stage with a single handoff?** → [Recipe 02 — Sequential
   Workflow](02-sequential-workflow.md). Determinism over flexibility.
5. **Is retrieval quality the main engineering problem (ranking,
   chunking, citation faithfulness)?** → [Recipe 06 — RAG
   Pipeline](06-rag-pipeline.md). Pipeline-first beats agent-first when
   the bottleneck is documents, not reasoning.
6. **Are you shipping to a chat channel (Slack, Discord, Telegram,
   WhatsApp, iMessage)?** → [Recipe 03 — Slack Bot](03-slack-bot.md)
   first, then the matching adapter in Part F.
7. **Do you have a labelled dataset and want to optimize program
   quality rather than hand-tune prompts?** → [Recipe 12 — Eval
   Harness](12-eval-harness.md) to set up the dataset, then
   [Recipe 42 — Active Optimization](42-active-optimization.md) for
   DSPy-style spec mutation (the empirical result that motivates the
   project: +13% accuracy on 5/7 multi-stage programs).
8. **Are you running long-horizon autonomous work (research, batch
   jobs)?** → [Recipe 07 — Autonomous Research](07-autonomous-research.md)
   or [Recipe 08 — Batch Worker](08-batch-worker.md). Both lean on
   compaction, durable sessions, and background execution.
9. **Voice or browser surface?** → [Recipe 09 — Voice
   Agent](09-voice-agent.md) / [Recipe 10 — Browser
   Agent](10-browser-agent.md). Note the elevated trust surface for
   browser tools — read the security primer below first.
10. **Multi-tenant SaaS?** → [Recipe 11 — Managed
    Multitenant](11-managed-multitenant.md), then Part C for hardening.
11. **Touching wallets, contracts, or chain events?** → Part H,
    starting with [Recipe 43 — Wallet-gated
    action](43-wallet-gated-action.md).

The flowchart is a teaching scaffold, not a cage. Once you understand
each pure topology, hybrid systems compose naturally — graph nodes can
embed crews, crews can call workflows, channels can wrap any of them.

## Security primer — read this before you ship anything

Three recipes form the **Pillar 3** "security as fabric" foundation
([CLAUDE.md](../../CLAUDE.md)). Read them *before* the first time you
deploy an agent that touches a host or a network:

- [Recipe 14 — Hooks](14-hooks.md) — `PreToolUse` / `PostToolUse`
  policy hooks; the mechanical guardrail under every other layer.
- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md) —
  the rule-kinds-in-tier-order grammar; why `alwaysDeny` structurally
  beats `alwaysAllow`; concrete `Bash(rm -rf:*)` examples.
- [Recipe 41 — Security Fabric](41-security-fabric.md) — boundary
  classification at every site that ingests external content (MCP,
  sub-agents, channels, federation, skills, compaction, tool results).

The default permission verdict is `ask`, which is safe in a CLI REPL
but **converts to `deny` in non-interactive shapes** (workflow, graph,
channel, batch, managed). If you build a Slack bot in recipe 03
without reading recipe 29, a random user in that Slack channel can ask
the bot to run shell commands on your server — the same kind of
mistake the recipe ordering used to invite. Run `crewhaus doctor
--philosophy-alignment` before any PR that touches a boundary site;
it will fail the build if Pillar 3 has drifted.

---

## Part A — Target shapes (one recipe per shape)

These walk you through every shape `target:` can take. Each shape is
runnable from a 5–30 line spec and a one-line `bun run …`.

| #  | Recipe                                                   | Shape       | Smallest example                                                  | Status   |
| -- | -------------------------------------------------------- | ----------- | ----------------------------------------------------------------- | -------- |
| 01 | [CLI Coding Agent](01-cli-coding-agent.md)               | `cli`       | [`examples/hello-cli`](../../examples/hello-cli)                  | complete |
| 02 | [Sequential Workflow](02-sequential-workflow.md)         | `workflow`  | [`examples/hello-workflow`](../../examples/hello-workflow)        | complete |
| 03 | [Slack Bot](03-slack-bot.md)                             | `channel`   | [`examples/hello-channel`](../../examples/hello-channel)          | complete |
| 04 | [Multi-Agent Crew](04-multi-agent-crew.md)               | `crew`      | [`examples/hello-crew`](../../examples/hello-crew)                | complete |
| 05 | [Stateful Graph](05-stateful-graph.md)                   | `graph`     | [`examples/hello-graph`](../../examples/hello-graph)              | complete |
| 06 | [RAG Pipeline](06-rag-pipeline.md)                       | `pipeline`  | [`examples/hello-rag`](../../examples/hello-rag)                  | complete |
| 07 | [Autonomous Research](07-autonomous-research.md)         | `research`  | [`examples/hello-research`](../../examples/hello-research)        | complete |
| 08 | [Batch Worker](08-batch-worker.md)                       | `batch`     | [`examples/hello-batch`](../../examples/hello-batch)              | complete |
| 09 | [Voice Agent](09-voice-agent.md)                         | `voice`     | [`examples/hello-voice`](../../examples/hello-voice)              | complete |
| 10 | [Browser Agent](10-browser-agent.md)                     | `browser`   | [`examples/hello-browser`](../../examples/hello-browser)          | complete |
| 11 | [Managed Multitenant](11-managed-multitenant.md)         | `managed`   | [`examples/hello-managed`](../../examples/hello-managed)          | complete |
| 12 | [Eval Harness](12-eval-harness.md)                       | `eval`      | [`examples/hello-eval`](../../examples/hello-eval)                | complete |

## Part B — Core capabilities

Cross-cutting features that compose into every shape.

| #  | Recipe                                                       | Catalog       | Status   |
| -- | ------------------------------------------------------------ | ------------- | -------- |
| 13 | [MCP Servers](13-mcp-servers.md)                             | §9            | complete |
| 14 | [Hooks](14-hooks.md)                                         | §11           | complete |
| 15 | [Skills](15-skills.md)                                       | §11           | complete |
| 16 | [Slash Commands](16-slash-commands.md)                       | §11           | complete |
| 17 | [Observability](17-observability.md)                         | §15, §27, §37 | complete |

## Part C — Production hardening

When you're ready to put an agent in front of paying users.

| #  | Recipe                                                                  | Catalog       |
| -- | ----------------------------------------------------------------------- | ------------- |
| 18 | [Multi-Provider Fallback](18-multi-provider-fallback.md)                | §17, §27      |
| 19 | [Rate Limiting and Budgets](19-rate-limiting-and-budgets.md)            | §27, §20      |
| 20 | [Secrets Management](20-secrets-management.md)                          | §27           |
| 21 | [Deployment and Canary](21-deployment-and-canary.md)                    | §28, §29      |
| 22 | [Compliance and Audit](22-compliance-and-audit.md)                      | §20, §39      |
| 23 | [PII Redaction and Encryption](23-pii-redaction-and-encryption.md)      | §39           |

## Part D — Distribution and ecosystem

Ship the agent to others.

| #  | Recipe                                                               | Catalog   |
| -- | -------------------------------------------------------------------- | --------- |
| 24 | [Docker and Helm](24-docker-and-helm.md)                             | §32       |
| 25 | [VS Code and JetBrains](25-vscode-and-jetbrains.md)                  | §35       |
| 26 | [Template Marketplace](26-template-marketplace.md)                   | §40       |
| 27 | [Federation](27-federation.md)                                       | §34       |

## Part E — Going deeper

Topics that don't fit cleanly above but matter once you start building real systems.

| #  | Recipe                                                                | Catalog   |
| -- | --------------------------------------------------------------------- | --------- |
| 28 | [Sub-agents and the Task Tool](28-sub-agents-and-task.md)             | §13       |
| 29 | [Permissions Deep Dive](29-permissions-deep-dive.md)                  | §7, §13   |
| 30 | [Sandboxed Code Execution](30-sandboxed-code-execution.md)            | §18, §36  |
| 31 | [Session Resume and Replay](31-session-resume-and-replay.md)          | §10, §31  |
| 32 | [Local Models](32-local-models.md)                                    | §17       |
| 33 | [Prompt Caching](33-prompt-caching.md)                                | §27       |
| 34 | [Building Custom Graders](34-building-custom-graders.md)              | §16, §38  |
| 35 | [Studio Walkthrough](35-studio-walkthrough.md)                        | §26, §31  |
| 36 | [Cloud Deploy](36-cloud-deploy.md)                                    | §32       |

## Part F — Channel adapters (one per channel; Slack covered in #3)

| #  | Recipe                                                          | Catalog   |
| -- | --------------------------------------------------------------- | --------- |
| 37 | [Channel: Telegram](37-channel-telegram.md)                     | §33       |
| 38 | [Channel: Discord](38-channel-discord.md)                       | §33       |
| 39 | [Channel: WhatsApp](39-channel-whatsapp.md)                     | §33       |
| 40 | [Channel: iMessage](40-channel-imessage.md)                     | §33       |

## Part G — The three architectural pillars (philosophy alignment)

Recipes that map directly onto the invariants codified in [`/CLAUDE.md`](../../CLAUDE.md).

| #  | Recipe                                                          | Pillar             | Status   |
| -- | --------------------------------------------------------------- | ------------------ | -------- |
| 41 | [Security fabric](41-security-fabric.md)                        | Pillar 3 — fabric  | complete |
| 42 | [Active optimization](42-active-optimization.md)                | Pillar 2 — active  | complete |

## Part H — Section 47 blockchain shapes

Recipes covering the §47 blockchain integration. Most blockchain "shapes" from the §47 proposal are compositions of existing IR variants with the cross-cutting `chains` / `wallets` / `contracts` / `transaction_policy` blocks — only the event daemon and game-playing shape needed new IR variants (recipe 47).

| #  | Recipe                                                          | §47 shapes covered           | Status   |
| -- | --------------------------------------------------------------- | ---------------------------- | -------- |
| 43 | [Wallet-gated action](43-wallet-gated-action.md)                | Shapes 1, 11                 | complete |
| 44 | [Chain as tool gateway](44-chain-as-tool-gateway.md)            | Shapes 2, 3, 5, 7            | complete |
| 45 | [DAO governance crew](45-dao-governance-crew.md)                | Shape 6                      | complete |
| 46 | [Tokenized access](46-tokenized-access.md)                      | Shapes 9, 12 (credential)    | complete |
| 47 | [Onchain daemon & game](47-onchain-daemon-and-game.md)          | Shapes 8, 10 + on-chain games | complete |

## Part I — Meta-tooling

Reflexive recipes — CrewHaus designing itself. The system general enough that a YAML spec can produce the harness that writes the YAML.

| #  | Recipe                                                          | Pattern            | Status   |
| -- | --------------------------------------------------------------- | ------------------ | -------- |
| 48 | [Harness Designer](48-harness-designer.md)                      | meta-cli           | complete |

---

## Quick paths (for readers who already know the shape they want)

If the diagnostic tree above already pointed you somewhere, you can
skip this section. These are the back-of-the-book index entries — once
you've internalized the topologies, they're the fastest way to wire up
a known scenario:

- **Newcomer.** 01 → 17 → 13 → 14 → 29.
- **Putting an agent in Slack.** 01 → 03 → 14 → 17.
- **Building an internal eval / canary loop.** 12 → 21 → 17 → 34.
- **Shipping a SaaS.** 11 → 19 → 20 → 22 → 23 → 24 → 36.
- **Multi-agent system.** 04 → 28 → 05 → 27.
- **RAG / research.** 06 → 07 → 12.
- **Blockchain integration.** 43 → 44 → 46 → 45 → 47.
- **Active optimization (DSPy-inspired).** 12 → 34 → 42.
- **Designing a new harness from intent.** 48 → (the recipe for the shape it picks) → 12 → 42.

## Status

| Total recipes | Status                  |
| ------------- | ----------------------- |
| 48            | Total (01-40 + pillars 41, 42 + §47 recipes 43-47 + meta 48) |
| 48            | Walkthrough complete    |
| 0             | Stub                    |

Each recipe walks from "I have an empty workspace" to "I have a
working spec, runnable, with the feature in question exercised." Most
land between 250 and 450 lines of prose, with embedded YAML
snippets and `bun run …` commands that the static validator
re-compiles on every PR.

## Testing recipes

Two scripts validate every recipe in `docs/recipes/`:

```bash
bun run recipes:test    # static checks; ~5 seconds
bun run recipes:smoke   # compile + smoke runs; ~10 seconds in CI mode
```

### `recipes:test` — static validation

[`scripts/test-recipes.ts`](../../scripts/test-recipes.ts) catches the
bugs human reviewers shouldn't have to:

- **Broken markdown links.** Every relative-path link must resolve to
  a file or directory that exists.
- **Embedded spec YAML.** Every code fence with `yaml` language tag
  that contains both `name:` and `target:` is treated as a complete
  spec and compiled through the in-tree CLI. Drift in the spec schema
  (e.g. renaming `agent.tools` to `tools`) breaks the test instantly.
- **`bun run` references.** Every `bun run <script>` token must
  reference a script that exists in package.json.
- **Frontmatter opt-ins.** Recipes can declare `test.spec`,
  `test.bun_scripts`, and `test.packages` lists for stronger
  validation; the script verifies each.

Runs in well under a second; requires no network or API credentials.

### `recipes:smoke` — compile + run smoke

[`scripts/smoke-recipes.ts`](../../scripts/smoke-recipes.ts) actually
runs the `bun_scripts` each recipe declares. Two modes:

- **Default (CI):** runs only `compile:*` scripts. No model calls,
  fast, deterministic. Catches codegen bugs the static check misses
  (e.g. the spec parses but the codegen pipeline rejects it).
- **Live (`RECIPE_SMOKE_LIVE=1`):** also runs `run:*` and `smoke:*`
  scripts. Requires an Anthropic credential and may make billed
  model calls. Run locally before publishing.

### Authoring a testable recipe

Add a `test:` block to the recipe's frontmatter:

```yaml
---
test:
  spec: examples/hello-cli/crewhaus.yaml
  bun_scripts:
    - compile:hello
    - run:hello
  packages:
    - packages/runtime-core
    - packages/target-cli
---
```

The static script validates that every path exists and every script
is defined; the smoke script then runs the compile-prefixed bun
scripts. The recipe body should reference the same paths so a reader
following along sees what the tests verify.

### CI

[`.github/workflows/recipes.yml`](../../.github/workflows/recipes.yml)
runs `recipes:test` on every PR touching `docs/recipes/**`,
`scripts/test-recipes.ts`, or `examples/**/crewhaus.yaml`, followed by
the compile-only `recipes:smoke`. Both must pass before a recipe PR
merges.
