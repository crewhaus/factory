# CrewHaus Factory

*The open-source meta-harness compiler for AI agents.*

Compile a single `spec.yaml` into a CLI agent, channel bot, RAG pipeline, multi-agent crew, eval harness, voice/realtime agent, browser/computer-use agent, and more. Active eval optimization. Trust-aware by default. Apache-2.0.

```bash
bun add -d @crewhaus/cli
crewhaus init my-agent
cd my-agent
crewhaus compile && crewhaus run
```

## Why CrewHaus?

Most teams build a different harness for every shape of agent — a CLI here, a Slack bot there, a RAG pipeline somewhere else, an eval rig on the side. The behaviour is identical; the wiring is wildly different.

CrewHaus is the layer above. You write the agent once, as a `spec.yaml`. The compiler emits whichever runtime shape you need.

## What you can compile to

Twelve target shapes ship today:

| Target | What it produces |
|---|---|
| `cli` | A self-contained TypeScript CLI agent |
| `channel-slack` / `channel-discord` / `channel-telegram` / `channel-whatsapp` | Channel bots |
| `graph` | A stateful graph runtime |
| `pipeline` | A RAG pipeline |
| `crew` | A multi-agent crew |
| `research` | An autonomous research agent |
| `batch` | A batch worker |
| `voice` | A voice/realtime agent |
| `browser` | A browser/computer-use agent |
| `managed` | A managed multi-tenant runtime |
| `eval` | An eval bundle for grading other targets |
| `workflow` | A workflow orchestration runtime |

Adding a new target shape starts at the IR, not at codegen. See [`docs/COMPILER-ARCHITECTURE.md`](docs/COMPILER-ARCHITECTURE.md).

## The three pillars

1. **The compiler is the protagonist.** Specs flow through `parseSpec → lower → applyPasses → emit`. The IR is a discriminated union of target-shape variants; each emitter consumes its own typed variant.

2. **Eval is active, not passive.** Eval failures produce *spec patches*. `crewhaus optimize` searches the mutation space (rule-based or Claude-driven) and writes back through a YAML CST that preserves comments and key order. The loop closes.

3. **Security is a fabric, not a perimeter.** Every untrusted ingress — MCP responses, sub-agent returns, channel inbound messages, federation payloads, skill bodies, compaction summaries — goes through the boundary classifier with `TrustOrigin` metadata before it hits a model call. Authentication verifies who; classification verifies what.

Full architecture: [`docs/AI-Harness-Systems.md`](docs/AI-Harness-Systems.md), [`docs/COMPILER-ARCHITECTURE.md`](docs/COMPILER-ARCHITECTURE.md), [`CLAUDE.md`](CLAUDE.md).

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
# Install the CLI
bun add -d @crewhaus/cli

# Create a new agent project
crewhaus init my-agent
cd my-agent

# Edit spec.yaml — see docs/recipes/01-first-spec.md

# Compile to the CLI target (the default)
crewhaus compile

# Run it
ANTHROPIC_API_KEY=sk-... crewhaus run

# Or compile to a different shape
crewhaus compile --target channel-slack
crewhaus compile --target rag-pipeline
crewhaus compile --target eval-bundle
```

## Example: compile a spec to two different shapes

```yaml
# spec.yaml
name: github-issue-triage
model:
  provider: anthropic
  name: claude-sonnet-4-6
instructions: |
  You triage GitHub issues by reading them and assigning labels.
tools:
  - github:list_labels
  - github:add_labels
```

```bash
# Get a CLI you can run locally
crewhaus compile --target cli

# Get a Slack bot that responds to a slash command
crewhaus compile --target channel-slack

# Get an eval bundle to test it
crewhaus compile --target eval --eval-set evals/triage.jsonl
```

Same spec. Different shapes. Different deployment paths.

## Documentation

- **New here?** Start with [Getting Started](docs/GETTING-STARTED.md) — a guided tour from first principles to a runnable agent.
- **Looking for a recipe?** See [Recipes Index](docs/recipes/INDEX.md) — 40+ task-oriented walkthroughs.
- **Need the module reference?** See [Module Catalog](docs/MODULE-CATALOG.md) — full module catalog across the target-shape variants.
- **Contributing?** See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Crewhaus Forge

Community registry for shared harnesses, skills, tools, and recipes. **Coming Summer 2026.** [See what's coming →](https://forge.crewhaus.ai)

## Want hands-on help?

[StudioMax](https://studiomax.io/work/crewhaus) — the studio that built CrewHaus — offers fixed-scope implementation packages: install, configure, build your first harnesses, train your team.

## A hosted version?

We may build a hosted CrewHaus eventually — managed runtime, private registry, observability. We're listening for signal first. [Tell us what you'd want →](https://cloud.crewhaus.ai). No promises.

## Contributing

Contributions are welcome. CrewHaus is async-first and BDFL-lite — see [`GOVERNANCE.md`](GOVERNANCE.md) for how decisions are made and [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to contribute.

Quick links:

- [Good first issues](https://github.com/crewhaus/factory/labels/good%20first%20issue)
- [Help wanted](https://github.com/crewhaus/factory/labels/help%20wanted)
- [Open RFCs](https://github.com/crewhaus/factory/labels/rfc)
- [`docs/contributing/your-first-target.md`](docs/contributing/your-first-target.md) — adding a new target shape end-to-end

## Support

Async, best-effort, community-driven. See [`SUPPORT.md`](SUPPORT.md) for the channels and what to expect.

- Free users → [GitHub Discussions](https://github.com/crewhaus/factory/discussions) and [Issues](https://github.com/crewhaus/factory/issues)
- Paid Cloud users → support tied to your plan
- Custom implementation → [StudioMax implementation packages](https://studiomax.io/work/crewhaus)

## Security

Vulnerability reports go to a private channel, not GitHub Issues. See [`SECURITY.md`](SECURITY.md).

## License

[Apache License 2.0](LICENSE). The Apache-2.0 license covers the code. **CrewHaus**, **Crewhaus Factory**, **Crewhaus Cloud**, **Crewhaus Forge**, and the logo are trademarks; see [`TRADEMARK.md`](TRADEMARK.md) for use-of-marks policy.

Documentation is licensed under [Creative Commons Attribution 4.0](docs/LICENSE).

---

*Built by [StudioMax](https://studiomax.io).*
