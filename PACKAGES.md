# Packages

The publish-surface view of the factory workspace — what we will publish to npm when CrewHaus goes public, and how to use the CLI from a clone in the meantime. For the runtime architecture, see [docs/MODULE-CATALOG.md](docs/MODULE-CATALOG.md). For contributor rules, see [AGENTS.md](AGENTS.md).

## Status

Nothing in this repo is published to npm yet. Every `@crewhaus/*` package in `packages/` and `apps/cli/` is marked `"private": true`, version `0.0.0`. The root `factory` workspace is intentionally private and will stay that way — only the inner `@crewhaus/*` packages are publishable.

## Using the CLI today (from a clone)

```bash
git clone https://github.com/crewhaus/factory && cd factory && bun install
bun apps/cli/src/index.ts --help
```

Bun resolves all `workspace:*` dependencies automatically — no `bun link` needed.

To use the CLI from a sibling project (the pattern the demos repo uses):

```bash
# factory and my-agent as siblings
bun ./factory/apps/cli/src/index.ts init my-agent
cd my-agent
bun ../factory/apps/cli/src/index.ts compile
```

A shell alias keeps the rest of any walkthrough readable:

```bash
alias crewhaus="bun $(pwd)/factory/apps/cli/src/index.ts"
crewhaus init my-agent
```

`docs/GETTING-STARTED.md` walks the full development workflow.

## Using the CLI after launch

```bash
bun add -d @crewhaus/cli
crewhaus init my-agent
cd my-agent
crewhaus compile && crewhaus run
```

`@crewhaus/cli` transitively pulls in everything else via `workspace:*` deps, so users don't install the rest individually. A generated bundle additionally imports `@crewhaus/runtime-core` directly — that is the one other package consumers see on the receiving end.

## The publishable surface

`packages/*/package.json` and `apps/cli/package.json` are the canonical list — every package in those trees is publishable once `"private"` is removed. They cluster into these groups (examples per group, not exhaustive):

- **Compiler & spec core** — `@crewhaus/compiler`, `@crewhaus/spec`, `@crewhaus/ir`, `@crewhaus/ir-passes`, `@crewhaus/runtime-core`
- **Apps** — `@crewhaus/cli` (the user-facing entry point, in `apps/cli/`)
- **Target codegens** — `@crewhaus/target-*`, one per supported target shape (CLI, channel bot, crew, graph, pipeline, workflow, voice, browser-driver, batch-worker, research-bundle, eval-bundle, managed, onchain, …)
- **Model adapters** — `@crewhaus/adapter-anthropic`, `@crewhaus/adapter-openai`, `@crewhaus/adapter-gemini`, `@crewhaus/adapter-bedrock`
- **Tools** — `@crewhaus/tool-*` (e.g. `tool-bash`, `tool-fetch`, `tool-web`, `tool-fs`, `tool-mcp`, `tool-task`, `tool-image`, `tool-codegraph`, …)
- **Channel adapters** — `@crewhaus/channel-adapter-slack`, `-telegram`, `-discord`, `-whatsapp`, `-imessage`
- **Eval & optimization** — `@crewhaus/eval-runner`, `@crewhaus/eval-grader`, `@crewhaus/grader-*`, `@crewhaus/prompt-optimizer`, `@crewhaus/prompt-optimizer-claude`, `@crewhaus/eval-optimizer-orchestrator`, `@crewhaus/spec-patch`
- **Security fabric** — `@crewhaus/boundary-classifier`, `@crewhaus/egress-classifier`, `@crewhaus/permission-engine`, `@crewhaus/audit-log`, `@crewhaus/audit-encryption`, `@crewhaus/pii-redactor`, `@crewhaus/prompt-injection-detector`
- **Persistence & state** — `@crewhaus/session-store`, `@crewhaus/checkpoint-store`, `@crewhaus/state-store`, `@crewhaus/vector-store`
- **Observability** — `@crewhaus/exporter-datadog`, `@crewhaus/exporter-newrelic`, `@crewhaus/exporter-honeycomb`, `@crewhaus/exporter-splunk`, `@crewhaus/otel-exporter`, `@crewhaus/cost-tracker`, `@crewhaus/run-context`, `@crewhaus/logging`
- **Utilities** — `@crewhaus/errors`, `@crewhaus/rate-limiter`, `@crewhaus/circuit-breaker`, `@crewhaus/token-budget`, `@crewhaus/idempotency-keys`, `@crewhaus/template-registry`, `@crewhaus/dataset-registry`
- **Sandbox images** — `@crewhaus/sandbox-image-*`, one per language for `tool-code-execution`. These may ship as container images in addition to npm packages.

## Intentionally NOT published

- `factory` (the root workspace itself) — `"private": true` permanently. It's a workspace orchestrator, not a consumable package.
- Everything under `utilities/` — Studio UI/server, IDE extensions, the browser playground, trace-viewer, graph-visualizer, wizard, scaffold-templates, plugin-sdk. Studio and friends live in [crewhaus/utilities](https://github.com/crewhaus/utilities) and consume factory via tsconfig path aliases.
- Everything under `demos/smoke/` — `@crewhaus-examples/*` smoke tests per catalog section. Internal CI artifacts.
- The sibling apps in the repo (`website/`, `cloud/`, `transition-site/`, `operations/`) — none are npm-shipped.

## Pre-publish checklist

When the project goes public, work through these in order:

1. Remove `"private": true` from every `@crewhaus/*` `package.json` under `packages/*` and `apps/cli/`. Leave the root `factory/package.json` private.
2. Bump versions from `0.0.0` to the launch version (e.g. `0.1.0`) across the workspace. Decide on one number, apply uniformly.
3. Add `"publishConfig": { "access": "public" }` to every package — the `@crewhaus` scope publishes private by default otherwise.
4. Verify each package's `license`, `repository`, and `homepage` fields point at the public repo, and that LICENSE + NOTICE are either present at the package root or covered by the workspace-level files.
5. Publish in dependency order. Leaf packages first; `@crewhaus/cli` last because it transitively imports almost everything else. Verify the order with a dry-run before the real publish.
6. Revert the cloned-repo install instructions back to `bun add -d @crewhaus/cli` in:
   - [README.md](README.md)
   - [CONTRIBUTING.md](CONTRIBUTING.md)
   - `../operations/repo-setup/templates/README.md`
   - `../operations/repo-setup/templates/org-profile-README.md`
7. Remove the `<!-- Pre-launch note: … -->` banners from the launch-day drafts:
   - `../operations/LAUNCH-PLAN.md`
   - `../operations/content/LAUNCH-POST.md`
   - `../operations/content/lucky-machines-crossover.md`
   - `../website/project/uploads/HOMEPAGE-COPY.md`
   - `../website/project/uploads/LAUNCH-PLAN.md`
8. Cut a release tag, push to GitHub, publish to npm in the same change window so docs and packages don't drift.

A fully generated list of packages (with versions, descriptions, and private status) is a one-liner over `packages/*/package.json` whenever we want one — that's a follow-up rather than something to hand-curate here.
