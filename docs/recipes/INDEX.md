# Recipes

> Task-oriented walkthroughs for every major feature of crewhaus-factory.
> All recipes are currently **stubs** — they have accurate pointers to
> code, examples, and module catalog entries, but the prose walk-throughs
> are not yet written. Pick one and contribute the body.

If you're new here, start with [`docs/GETTING-STARTED.md`](../GETTING-STARTED.md)
first. Each recipe assumes you've read it.

---

## Part A — Target shapes (one recipe per shape)

These walk you through every shape `target:` can take. Each shape is
runnable from a 5–30 line spec and a one-line `bun run …`.

| #  | Recipe                                                   | Shape       | Smallest example                                                  |
| -- | -------------------------------------------------------- | ----------- | ----------------------------------------------------------------- |
| 01 | [CLI Coding Agent](01-cli-coding-agent.md)               | `cli`       | [`examples/hello-cli`](../../examples/hello-cli)                  |
| 02 | [Sequential Workflow](02-sequential-workflow.md)         | `workflow`  | [`examples/hello-workflow`](../../examples/hello-workflow)        |
| 03 | [Slack Bot](03-slack-bot.md)                             | `channel`   | [`examples/hello-channel`](../../examples/hello-channel)          |
| 04 | [Multi-Agent Crew](04-multi-agent-crew.md)               | `crew`      | [`examples/hello-crew`](../../examples/hello-crew)                |
| 05 | [Stateful Graph](05-stateful-graph.md)                   | `graph`     | [`examples/hello-graph`](../../examples/hello-graph)              |
| 06 | [RAG Pipeline](06-rag-pipeline.md)                       | `pipeline`  | [`examples/hello-rag`](../../examples/hello-rag)                  |
| 07 | [Autonomous Research](07-autonomous-research.md)         | `research`  | [`examples/hello-research`](../../examples/hello-research)        |
| 08 | [Batch Worker](08-batch-worker.md)                       | `batch`     | [`examples/hello-batch`](../../examples/hello-batch)              |
| 09 | [Voice Agent](09-voice-agent.md)                         | `voice`     | [`examples/hello-voice`](../../examples/hello-voice)              |
| 10 | [Browser Agent](10-browser-agent.md)                     | `browser`   | [`examples/hello-browser`](../../examples/hello-browser)          |
| 11 | [Managed Multitenant](11-managed-multitenant.md)         | `managed`   | [`examples/hello-managed`](../../examples/hello-managed)          |
| 12 | [Eval Harness](12-eval-harness.md)                       | `eval`      | [`examples/hello-eval`](../../examples/hello-eval)                |

## Part B — Core capabilities

Cross-cutting features that compose into every shape.

| #  | Recipe                                                       | Catalog   |
| -- | ------------------------------------------------------------ | --------- |
| 13 | [MCP Servers](13-mcp-servers.md)                             | §9        |
| 14 | [Hooks](14-hooks.md)                                         | §11       |
| 15 | [Skills](15-skills.md)                                       | §11       |
| 16 | [Slash Commands](16-slash-commands.md)                       | §11       |
| 17 | [Observability](17-observability.md)                         | §15, §27, §37 |

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

---

## Suggested reading orders

- **Newcomer.** 01 → 17 → 13 → 14 → 29.
- **Putting an agent in Slack.** 01 → 03 → 14 → 17.
- **Building an internal eval / canary loop.** 12 → 21 → 17 → 34.
- **Shipping a SaaS.** 11 → 19 → 20 → 22 → 23 → 24 → 36.
- **Multi-agent system.** 04 → 28 → 05 → 27.
- **RAG / research.** 06 → 07 → 12.

## Status

| Total recipes | Status                  |
| ------------- | ----------------------- |
| 40            | All stubs               |
| 0             | Walkthrough complete    |

Contributions welcome. Each stub already lists the example, codegen
package, runtime modules, and catalog section relevant to its topic —
the body should walk a new reader from "I have an empty workspace" to
"I have a working spec, runnable, with the feature in question
exercised." Aim for ~200 lines of prose per recipe.
