# CrewHaus Factory

*The open-source meta-harness compiler for AI agents.*

Compile a single spec (a `crewhaus.yaml`) into a CLI agent, channel bot, RAG pipeline, multi-agent crew, eval harness, voice/realtime agent, browser/computer-use agent, and more. Active eval optimization. Trust-aware by default. Apache-2.0.

```bash
# Until @crewhaus/cli is on npm (tracking in PACKAGES.md), use it from a clone.
git clone https://github.com/crewhaus/factory && cd factory && bun install && cd ..
alias crewhaus="bun $(pwd)/factory/apps/cli/src/index.ts"
crewhaus init my-agent
cd my-agent
crewhaus compile crewhaus.yaml -o build && crewhaus run crewhaus.yaml
```

## Why CrewHaus?

Most teams build a different harness for every shape of agent — a CLI here, a Slack bot there, a RAG pipeline somewhere else, an eval rig on the side. The behaviour is identical; the wiring is wildly different.

CrewHaus is the layer above. You write the agent once, as a spec (`crewhaus.yaml`). The compiler emits whichever runtime shape you need.

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

Adding a new target shape starts at the IR, not at codegen. See [`COMPILER-ARCHITECTURE.md`](https://github.com/crewhaus/docs/blob/main/COMPILER-ARCHITECTURE.md).

## The three pillars

1. **The compiler is the protagonist.** Specs flow through `parseSpec → lower → applyPasses → emit`. The IR is a discriminated union of target-shape variants; each emitter consumes its own typed variant.

2. **Eval is active, not passive.** Eval failures produce *spec patches*. `crewhaus optimize` searches the mutation space (rule-based or Claude-driven) and writes back through a YAML CST that preserves comments and key order. The loop closes.

3. **Security is a fabric, not a perimeter.** Every untrusted ingress — MCP responses, sub-agent returns, channel inbound messages, federation payloads, skill bodies, compaction summaries — goes through the boundary classifier with `TrustOrigin` metadata before it hits a model call. Authentication verifies who; classification verifies what.

Full architecture: [`AI-Harness-Systems.md`](https://github.com/crewhaus/docs/blob/main/AI-Harness-Systems.md), [`COMPILER-ARCHITECTURE.md`](https://github.com/crewhaus/docs/blob/main/COMPILER-ARCHITECTURE.md), [`AGENTS.md`](AGENTS.md).

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
# Until @crewhaus/cli is on npm (tracking in PACKAGES.md), use it from a clone.
git clone https://github.com/crewhaus/factory && cd factory && bun install && cd ..
alias crewhaus="bun $(pwd)/factory/apps/cli/src/index.ts"

# Create a new agent project — writes a minimal `crewhaus.yaml`
crewhaus init my-agent
cd my-agent
```

`crewhaus init` writes a runnable starter spec:

```yaml
# crewhaus.yaml
name: my-agent
target: cli
agent:
  model: claude-opus-4-7
  instructions: |
    You are a helpful assistant. Replace these instructions with your
    agent's actual behavior, persona, and constraints.
```

Edit the `instructions` block to describe what your agent should do, then:

```bash
# Set a provider credential (the default model is Anthropic;
# other providers are listed in factory/.env.example)
export ANTHROPIC_API_KEY=sk-ant-...

# Compile crewhaus.yaml to a runnable bundle in ./build
crewhaus compile crewhaus.yaml -o build

# Run the agent
crewhaus run crewhaus.yaml
```

To compile to a different shape, change `target:` in `crewhaus.yaml` to one of the values from the table above (`channel`, `pipeline`, `eval`, …) and re-run `crewhaus compile`.

## Example: one spec, multiple shapes

The two specs below share an identical `agent:` block — only `target:` changes. The same agent compiles to either a local CLI or a browser/computer-use agent, with no other config.

```yaml
# cli.yaml — runs in a terminal
name: research-assistant
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You help users research a topic. Given a question, find
    relevant sources and produce a short, cited summary.
```

```yaml
# browser.yaml — same agent, driven against a real browser
name: research-assistant
target: browser
agent:
  model: claude-sonnet-4-6
  instructions: |
    You help users research a topic. Given a question, find
    relevant sources and produce a short, cited summary.
```

```bash
# Compile to runnable bundles
crewhaus compile cli.yaml     -o build/cli      # local CLI agent
crewhaus compile browser.yaml -o build/browser  # browser/computer-use agent

# Or run directly — no compile step needed
crewhaus run cli.yaml                                   # interactive terminal
crewhaus run browser.yaml --prompt "research X"         # one-shot browser session
```

The browser target launches a headless Chromium via [Playwright](https://playwright.dev) — run `bunx playwright install chromium` once if you don't already have it. The compiled bundle and `crewhaus run` use the same runtime; pick whichever fits your deployment.

Same agent. Different runtimes. Only `target:` changed.

Richer target shapes carry their own config block — `channels:` + `routing:` for a Slack bot, `dataset:` + `graders:` for an eval, `retrieve:` + `indexing:` for a RAG pipeline, `queue:` for a batch worker, `voice:` for a realtime agent — but the `agent:` block stays the same across all of them.

## Documentation

- **New here?** Start with [Getting Started](https://github.com/crewhaus/docs/blob/main/GETTING-STARTED.md) — a guided tour from first principles to a runnable agent.
- **Looking for a recipe?** See [Recipes Index](https://github.com/crewhaus/demos/blob/main/recipes/INDEX.md) — 40+ task-oriented walkthroughs.
- **Need the module reference?** See [Module Catalog](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md) — full module catalog across the target-shape variants.
- **Contributing?** See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Tooling around the compiler

The compiler, runtime, eval stack, and security fabric live in this repo. Tooling that sits *around* the compiler — Studio, IDE extensions, the browser playground, and the section-* example specs — lives in the sibling [crewhaus/demos](https://github.com/crewhaus/demos) repo and consumes factory via tsconfig path aliases.

- **Studio** ([demos/packages/studio-server](https://github.com/crewhaus/demos/tree/main/packages/studio-server) + [studio-ui](https://github.com/crewhaus/demos/tree/main/packages/studio-ui), with [wizard](https://github.com/crewhaus/demos/tree/main/packages/wizard), [scaffold-templates](https://github.com/crewhaus/demos/tree/main/packages/scaffold-templates), [trace-viewer](https://github.com/crewhaus/demos/tree/main/packages/trace-viewer), [graph-visualizer](https://github.com/crewhaus/demos/tree/main/packages/graph-visualizer), [plugin-sdk](https://github.com/crewhaus/demos/tree/main/packages/plugin-sdk)) — Bun.serve daemon for spec authoring, run inspection, and plugin discovery.
- **IDE extensions** — [VS Code](https://github.com/crewhaus/demos/tree/main/packages/vscode-extension), [JetBrains](https://github.com/crewhaus/demos/tree/main/packages/jetbrains-plugin), [browser playground](https://github.com/crewhaus/demos/tree/main/packages/crewhaus-playground).
- **Section example specs** — [demos/examples](https://github.com/crewhaus/demos/tree/main/examples/) holds the per-section reference specs (`section-15-smoke`, `section-33-discord-smoke`, etc.) used to drive integration runs.

## Crewhaus Forge

Community registry for shared harnesses, skills, tools, and recipes. **Coming Summer 2026.** [See what's coming →](https://forge.crewhaus.ai)

## A hosted version?

We may build a hosted CrewHaus eventually — managed runtime, private registry, observability. We're listening for signal first. [Tell us what you'd want →](https://cloud.crewhaus.ai). No promises.

## Contributing

Contributions are welcome. CrewHaus is async-first and BDFL-lite — see [`GOVERNANCE.md`](GOVERNANCE.md) for how decisions are made and [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to contribute.

Quick links:

- [Good first issues](https://github.com/crewhaus/factory/labels/good%20first%20issue)
- [Help wanted](https://github.com/crewhaus/factory/labels/help%20wanted)
- [Open RFCs](https://github.com/crewhaus/factory/labels/rfc)
- [`contributing/your-first-target.md`](https://github.com/crewhaus/docs/blob/main/contributing/your-first-target.md) — adding a new target shape end-to-end

## Support

Async, best-effort, community-driven. See [`SUPPORT.md`](SUPPORT.md) for the channels and what to expect.

- Free users → [GitHub Discussions](https://github.com/crewhaus/factory/discussions) and [Issues](https://github.com/crewhaus/factory/issues)
- Paid Cloud users → support tied to your plan
- Custom implementation → [StudioMax implementation packages](https://studiomax.io/work/crewhaus)

## Security

Vulnerability reports go to a private channel, not GitHub Issues. See [`SECURITY.md`](SECURITY.md).

## License

[Apache License 2.0](LICENSE). The Apache-2.0 license covers the code. **CrewHaus**, **Crewhaus Factory**, **Crewhaus Cloud**, **Crewhaus Forge**, and the logo are trademarks; see [`TRADEMARK.md`](TRADEMARK.md) for use-of-marks policy.

Documentation is licensed under [Creative Commons Attribution 4.0](https://github.com/crewhaus/docs/blob/main/LICENSE).

---

*Built by [StudioMax](https://studiomax.io).*
