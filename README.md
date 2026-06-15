# CrewHaus Factory

*The open-source meta-harness compiler for AI agents.*

Compile a single spec (a `crewhaus.yaml`) into a CLI agent, channel bot, RAG pipeline, multi-agent crew, eval harness, voice/realtime agent, browser/computer-use agent, and more. Active eval optimization. Trust-aware by default. Apache-2.0.

```bash
# Install the standalone binary — no runtime required:
brew tap crewhaus/tap && brew install crewhaus          # macOS / Linux (Homebrew)
# Windows: scoop install crewhaus · winget install CrewHaus.CLI
# Debian/Ubuntu (apt) and npm/Bun: see "Install" below

crewhaus --version
crewhaus init my-agent
cd my-agent
crewhaus compile crewhaus.yaml -o build && crewhaus run crewhaus.yaml
```

`crewhaus` is open source under Apache-2.0 and published as a bare package on npm,
Homebrew, Scoop, winget, and apt — see [Install](#install).

## Install

The fastest path is the self-contained binary — one file, no Bun/Node required:

```bash
# macOS / Linux (Homebrew)
brew tap crewhaus/tap && brew install crewhaus

# Windows (Scoop)
scoop bucket add crewhaus https://github.com/crewhaus/scoop-bucket
scoop install crewhaus

# Windows (winget)
winget install CrewHaus.CLI

# Debian / Ubuntu (apt)
curl -fsSL https://crewhaus.github.io/apt/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/crewhaus.gpg
echo "deb [signed-by=/usr/share/keyrings/crewhaus.gpg] https://crewhaus.github.io/apt stable main" | sudo tee /etc/apt/sources.list.d/crewhaus.list
sudo apt update && sudo apt install crewhaus
```

Prefer npm? The `crewhaus` package runs on [Bun](https://bun.sh) ≥ 1.2:

```bash
npm install -g crewhaus        # global
bun add -d crewhaus            # project-local dev dependency
```

Then confirm your install:

```bash
crewhaus --version
```

You can also grab a binary directly from the [GitHub Releases](https://github.com/crewhaus/factory/releases) page.

## Why CrewHaus?

Write the agent once, as a spec (`crewhaus.yaml`). Compile it to the shape each situation calls for — a CLI to run locally, a Slack bot for the team, an eval bundle to grade it — each emitted as code idiomatic to that runtime, not a generic wrapper.

When the spec changes, every shape recompiles. Run the eval loop and `crewhaus optimize` rewrites the spec from its failures, so the fix lands in all of them. CrewHaus is the layer above the runtimes.

## What you can compile to

These target shapes ship today:

| Target | What it produces |
|---|---|
| `cli` | A self-contained TypeScript CLI agent |
| `channel` (slack / discord / telegram / whatsapp / imessage) | Channel bots |
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
| `onchain` | An on-chain (EVM) agent runtime |
| `onchain-game` | An on-chain game runtime |

Adding a new target shape starts at the IR, not at codegen. See [`COMPILER-ARCHITECTURE.md`](https://github.com/crewhaus/docs/blob/main/COMPILER-ARCHITECTURE.md).

## The three pillars

1. **The compiler is the protagonist.** Specs flow through `parseSpec → lower → applyPasses → emit`. The IR is a discriminated union of target-shape variants; each emitter consumes its own typed variant.

2. **Eval is active, not passive.** Eval failures produce *spec patches*. `crewhaus optimize` searches the mutation space (rule-based or Claude-driven) and writes back through a YAML CST that preserves comments and key order. The loop closes.

3. **Security is a fabric, not a perimeter.** Untrusted content — MCP responses, sub-agent returns, channel inbound messages, federation payloads, skill bodies, compaction summaries — is classified by a single boundary classifier, tagged with `TrustOrigin`, before it reaches a model call. Authentication verifies who; classification verifies what.

Full architecture: [`AI-Harness-Systems.md`](https://github.com/crewhaus/docs/blob/main/AI-Harness-Systems.md), [`COMPILER-ARCHITECTURE.md`](https://github.com/crewhaus/docs/blob/main/COMPILER-ARCHITECTURE.md), [`AGENTS.md`](AGENTS.md).

## Quickstart

Install `crewhaus` (see [Install](#install)) — the binary needs no runtime; the npm package needs [Bun](https://bun.sh) ≥ 1.2.

```bash
# Create a new agent project — writes a minimal `crewhaus.yaml`
crewhaus init my-agent
cd my-agent
```

If you'd rather develop against the workspace directly (contributing to factory itself), see [CONTRIBUTING.md](CONTRIBUTING.md) for the clone-and-link workflow.

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
# Set a provider credential — the default model is Anthropic; the full
# provider matrix (OpenAI, Gemini, Bedrock, Vertex, Azure, Groq/Together/
# OpenRouter/…, and local servers via local/<model>@<url>) is in
# packages/model-router/README.md and factory/.env.example.
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
    You help users research a topic. Given a question, produce a
    short, cited summary. If you have browser tools, start by calling
    Navigate to load https://duckduckgo.com/html/, then use Screenshot
    to read what came back before answering.
```

```yaml
# browser.yaml — same agent, driven against a real browser
name: research-assistant
target: browser
agent:
  model: claude-sonnet-4-6
  instructions: |
    You help users research a topic. Given a question, produce a
    short, cited summary. If you have browser tools, start by calling
    Navigate to load https://duckduckgo.com/html/, then use Screenshot
    to read what came back before answering.
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

## Example: tools and richer shapes

The example above needs no tools. Most real agents do — and tools come from two places. **Built-in tools** go in a `tools:` list (`read`, `write`, `edit`, `bash`, `grep`, `webFetch`, `webSearch`, …). **MCP server tools** are auto-discovered: declare the server under `mcp_servers:` and every tool it exposes is registered for you — you never list them by hand.

```yaml
# triage.yaml — a CLI agent backed by a GitHub MCP server
name: github-issue-triage
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You triage GitHub issues by reading them and assigning labels.
mcp_servers:
  github:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: $GITHUB_TOKEN
```

Richer shapes keep that same `agent:` (and `mcp_servers:`) block and layer their own config on top — only `target:` and the shape-specific block change. The same triage agent becomes a Slack bot, or an eval graded against a labeled dataset:

```yaml
# slack.yaml — same agent, dispatched as a Slack bot
name: github-issue-triage
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: |
    You triage GitHub issues by reading them and assigning labels.
mcp_servers:
  github:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: $GITHUB_TOKEN
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
```

```yaml
# eval.yaml — same agent, graded against a labeled dataset
name: github-issue-triage
target: eval
agent:
  model: claude-sonnet-4-6
  instructions: |
    You triage GitHub issues by reading them and assigning labels.
dataset:
  name: triage-cases
  version: v1
  split: dev
graders:
  - name: exact_match
concurrency: 4
```

```bash
crewhaus compile triage.yaml -o build/cli     # CLI agent with GitHub MCP tools
crewhaus compile slack.yaml  -o build/slack   # Slack bot
crewhaus compile eval.yaml   -o build/eval    # eval bundle
```

Other shapes follow the same rule — `retrieve:` + `indexing:` for a RAG pipeline, `queue:` for a batch worker, `voice:` for a realtime agent — but the `agent:` block stays identical across all of them.

## Documentation

- **New here?** Start with [Getting Started](https://github.com/crewhaus/docs/blob/main/GETTING-STARTED.md) — a guided tour from first principles to a runnable agent.
- **Looking for a recipe?** See [Recipes Index](https://github.com/crewhaus/demos/blob/main/walkthroughs/INDEX.md) — 40+ task-oriented walkthroughs.
- **Need the module reference?** See [Module Catalog](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md) — full module catalog across the target-shape variants.
- **Contributing?** See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Tooling around the compiler

The compiler, runtime, eval stack, and security fabric live in this repo. Tooling that sits *around* the compiler — Studio, IDE extensions, the browser playground — lives in [crewhaus/utilities](https://github.com/crewhaus/utilities), and the section-* example specs live in [crewhaus/demos](https://github.com/crewhaus/demos). Both consume factory via tsconfig path aliases.

- **Studio** ([studio-server](https://github.com/crewhaus/utilities/tree/main/studio-server) + [studio-ui](https://github.com/crewhaus/utilities/tree/main/studio-ui), with [wizard](https://github.com/crewhaus/utilities/tree/main/wizard), [scaffold-templates](https://github.com/crewhaus/utilities/tree/main/scaffold-templates), [trace-viewer](https://github.com/crewhaus/utilities/tree/main/trace-viewer), [graph-visualizer](https://github.com/crewhaus/utilities/tree/main/graph-visualizer), [plugin-sdk](https://github.com/crewhaus/utilities/tree/main/plugin-sdk)) — Bun.serve daemon for spec authoring, run inspection, and plugin discovery.
- **IDE extensions** — [VS Code](https://github.com/crewhaus/utilities/tree/main/vscode-extension), [JetBrains](https://github.com/crewhaus/utilities/tree/main/jetbrains-plugin), [browser playground](https://github.com/crewhaus/utilities/tree/main/crewhaus-playground).
- **Section example specs** — [demos/smoke](https://github.com/crewhaus/demos/tree/main/smoke/) holds the per-section reference specs (`section-15-smoke`, `section-33-discord-smoke`, etc.) used to drive integration runs.

## Crewhaus Forge

Community registry for shared harnesses, skills, tools, and recipes. **Coming Summer 2026.** [See what's coming →](https://forge.crewhaus.ai)

## Contributing

Contributions are welcome. CrewHaus is async-first and BDFL-lite — see [`GOVERNANCE.md`](GOVERNANCE.md) for how decisions are made and [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to contribute.

Quick links:

- [Good first issues](https://github.com/crewhaus/factory/labels/good%20first%20issue)
- [Help wanted](https://github.com/crewhaus/factory/labels/help%20wanted)
- [Open RFCs](https://github.com/crewhaus/factory/labels/rfc)
- [`contributing/your-first-target.md`](https://github.com/crewhaus/docs/blob/main/contributing/your-first-target.md) — adding a new target shape end-to-end

## Support

Async, best-effort, community-driven. See [`SUPPORT.md`](SUPPORT.md) for the channels and what to expect.

- [GitHub Discussions](https://github.com/crewhaus/factory/discussions) and [Issues](https://github.com/crewhaus/factory/issues)

## Security

Vulnerability reports go to a private channel, not GitHub Issues. See [`SECURITY.md`](SECURITY.md).

## License

[Apache License 2.0](LICENSE). The Apache-2.0 license covers the code. **CrewHaus**, **Crewhaus Factory**, **Crewhaus Cloud**, **Crewhaus Forge**, and the logo are trademarks; see [`TRADEMARK.md`](TRADEMARK.md) for use-of-marks policy.

Documentation is licensed under [Creative Commons Attribution 4.0](https://github.com/crewhaus/docs/blob/main/LICENSE).

---

*Built by [StudioMax](https://studiomax.io).*
