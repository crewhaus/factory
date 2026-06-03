# Packages

The publish-surface view of the factory workspace — what's on npm, how it's versioned, and how to consume it. For the runtime architecture, see [docs/MODULE-CATALOG.md](docs/MODULE-CATALOG.md). For contributor rules, see [AGENTS.md](AGENTS.md).

## Status

**v0.1.1 — initial private release (2026-05-30).** Every `@crewhaus/*` package in `packages/` and `apps/cli/` is published to the npm registry at `0.1.1` with `publishConfig.access: "restricted"`. The `@crewhaus` scope is therefore private — anyone needs to be added to the scope by the maintainer to install. The root `factory` workspace is intentionally private and stays that way; only the inner `@crewhaus/*` packages are publishable.

The same v0.1.1 cut covers the sibling [crewhaus/utilities](https://github.com/crewhaus/utilities) workspace (10 packages — Studio, IDE extensions, the browser playground, trace-viewer, graph-visualizer, wizard, scaffold-templates, plugin-sdk). Together: **206 packages** at v0.1.1.

> **Why we skipped v0.1.0.** A first publish at v0.1.0 went out with broken inter-package dependency ranges — `bun publish` resolved `workspace:*` against a stale `bun.lock` that still recorded the pre-release `0.0.0` versions, leaving every published package pointing at non-existent `@crewhaus/<dep>@0.0.0`. v0.1.1 regenerates `bun.lock` after the version bump so workspace:* resolves to the actual `0.1.1` cut. If you're authoring a new release on this workspace, delete `bun.lock` before `bun install` after a version bump — the `scripts/publish-workspace.ts` flow does this automatically.

The launch checklist below describes the flip from `restricted` → `public`. The npm install commands in user-facing docs do not change after the flip.

## Using the CLI

```bash
bun add -d @crewhaus/cli
bun x crewhaus init my-agent
cd my-agent
bun x crewhaus compile && bun x crewhaus run
```

`@crewhaus/cli` transitively pulls in everything else via versioned npm deps (the workspace `workspace:*` references resolve to concrete versions at publish time), so users don't install the rest individually. A generated bundle additionally imports `@crewhaus/runtime-core` directly — that is the one other package consumers see on the receiving end.

> **During the private-scope window.** Maintainer-side `npm login` is required, and the consuming machine must either share the same login or be added to the scope. Once the scope flips to public (see launch checklist below), the install command is unchanged but no auth is needed.

## Versioning

The workspace is on [Changesets](https://github.com/changesets/changesets); see [.changeset/README.md](.changeset/README.md) for day-to-day usage. Summary:

- All packages cut at **0.1.0** on 2026-05-30 — the initial public-API surface.
- Pre-1.0, breaking changes bump the minor (0.1.x → 0.2.0), per the [npm semver convention](https://semver.org/#spec-item-4). Features and bugfixes bump the patch.
- Each PR that touches a publishable package includes a `.changeset/*.md` describing the bump. `bun x changeset version` consumes the queue; `bun x changeset publish` releases.
- The sibling `utilities/` workspace runs an identical Changesets config rooted at its own repo.

## Developing from a clone (contributors)

Bun resolves all `workspace:*` dependencies automatically — no `bun link` needed.

```bash
git clone https://github.com/crewhaus/factory && cd factory && bun install
bun apps/cli/src/index.ts --help
```

To use the development CLI from a sibling project:

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

[`GETTING-STARTED.md`](https://github.com/crewhaus/docs/blob/main/GETTING-STARTED.md) walks the development workflow end-to-end and assumes the npm install for first-time users.

## The publishable surface

`packages/*/package.json` and `apps/cli/package.json` are the canonical list — every package in those trees publishes at the workspace cut version. They cluster into these groups (examples per group, not exhaustive):

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
- **Utilities (factory-side)** — `@crewhaus/errors`, `@crewhaus/rate-limiter`, `@crewhaus/circuit-breaker`, `@crewhaus/token-budget`, `@crewhaus/idempotency-keys`, `@crewhaus/template-registry`, `@crewhaus/dataset-registry`
- **Sandbox images** — `@crewhaus/sandbox-image-*`, one per language for `tool-code-execution`. These may ship as container images in addition to npm packages.

The sibling [crewhaus/utilities](https://github.com/crewhaus/utilities) workspace contributes the **Studio + IDE surface**:

- `@crewhaus/studio-server`, `@crewhaus/studio-ui`, `@crewhaus/plugin-sdk`, `@crewhaus/scaffold-templates`, `@crewhaus/wizard`, `@crewhaus/trace-viewer`, `@crewhaus/graph-visualizer`
- `@crewhaus/vscode-extension`, `@crewhaus/jetbrains-plugin`
- `@crewhaus/crewhaus-playground` (browser REPL)

All ten publish at the same cut version as the factory packages.

## Intentionally NOT published

- `factory` (the root workspace itself) — `"private": true` permanently. It's a workspace orchestrator, not a consumable package.
- `crewhaus-utilities` (the root workspace in `utilities/`) — same reason.
- The deployable app at [crewhaus/studio-pwa](https://github.com/crewhaus/studio-pwa) — it's an Astro PWA you deploy on Cloudflare Pages, not an npm package.
- The demos workspace at [crewhaus/demos](https://github.com/crewhaus/demos) and the smoke packages under `demos/smoke/*` — `@crewhaus-examples/*` smoke tests per catalog section. Internal CI artifacts; the example code is freely copyable under Apache-2.0.
- The doc site at [crewhaus/docs](https://github.com/crewhaus/docs) — prose, not code.
- The sibling apps and tooling in the development meta-repo — none are npm-shipped.

## Publishing checklist (per release cut)

The day-to-day flow is just `bun x changeset publish`; this list is the **launch-day or scope-flip** checklist.

1. **Bumps applied.** Verify `bun x changeset version` consumed the queue, the `CHANGELOG.md` regenerated, and the workspace builds clean (`bun run typecheck && bun run lint && bun test`).
2. **Workspace deps resolved.** `bun publish` rewrites `workspace:*` to concrete versions; verify with `bun pm pack --dry-run` on a leaf package and on `@crewhaus/cli`.
3. **Files-field clean.** Each package's `files: ["src", "README.md", "LICENSE", "NOTICE"]` (set by `scripts/release-prep.ts`) ships the right surface. Custom `files` blocks may override.
4. **Publish in dependency order.** Leaf packages first; `@crewhaus/cli` last because it transitively imports almost everything else. `bun x changeset publish` handles ordering automatically.
5. **Verify the install.** From a fresh directory: `bun add -d @crewhaus/cli` → `bun x crewhaus --version` → `bun x crewhaus init demo` → `bun x crewhaus compile`. Round-trip should work end-to-end without referring back to the source repo.

## Flipping the scope to public

When the launch decision lands:

1. Run `scripts/release-prep.ts --access public` on both `factory/` and `utilities/`. The script rewrites `publishConfig.access` across all package.jsons.
2. Cut a new changeset describing the visibility flip (typically a `0.2.0` minor or whatever the next planned cut is). Publish.
3. Run `npm access public @crewhaus/<pkg>` for any packages that need to flip retroactively on already-published versions. (npm's policy: `restricted` versions stay restricted; new versions inherit `publishConfig.access`. The CLI command above flips the *package*, not just future versions.)
4. Revert the "private testing" note in [README.md](README.md) and remove the `<!-- Pre-launch note: … -->` banners from the launch-day draft docs (the specific files are tracked in the private launch runbook).
5. Cut a release tag, push to GitHub, publish to npm in the same change window so docs and packages don't drift.

A fully generated list of packages (with versions, descriptions, and access status) is a one-liner over `packages/*/package.json` whenever we want one — that's a follow-up rather than something to hand-curate here.
