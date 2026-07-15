# Packages

The publish-surface view of the factory workspace — what's on npm, how it's versioned, and how to consume it. For the runtime architecture, see [docs/MODULE-CATALOG.md](docs/MODULE-CATALOG.md). For contributor rules, see [AGENTS.md](AGENTS.md).

## Status

**0.3.0 — the memory release (current factory cut 0.3.0).** Every `@crewhaus/*` library package in `packages/` is published to the npm registry under the **public** `@crewhaus` scope, and the flagship CLI ships as the bare, unscoped [`crewhaus`](https://www.npmjs.com/package/crewhaus) package (the old `@crewhaus/cli` name is deprecated and now just points at `crewhaus`). The root `factory` workspace is intentionally private and stays that way (`"private": true`); only the inner packages are publishable.

The sibling [crewhaus/utilities](https://github.com/crewhaus/utilities) workspace (12 packages — Studio, IDE extensions, the browser playground, trace-viewer, graph-visualizer, wizard, scaffold-templates, studio-plugin-sdk) versions in its own lockstep, currently at 0.1.5. The factory workspace itself publishes **209 packages** (208 `@crewhaus/*` libraries under `packages/` plus the unscoped `crewhaus` CLI); together, **221 packages** on the public registry.

> **Why we skipped v0.1.0.** A first publish at v0.1.0 went out with broken inter-package dependency ranges — `bun publish` resolved `workspace:*` against a stale `bun.lock` that still recorded the pre-release `0.0.0` versions, leaving every published package pointing at non-existent `@crewhaus/<dep>@0.0.0`. v0.1.1 regenerates `bun.lock` after the version bump so workspace:* resolves to the actual `0.1.1` cut. If you're authoring a new release on this workspace, delete `bun.lock` before `bun install` after a version bump — the `scripts/publish-workspace.ts` flow does this automatically.

The launch checklist below records the now-completed flip from `restricted` → `public`. The npm install commands in user-facing docs did not change across the flip.

## Using the CLI

The flagship CLI ships as the unscoped **`crewhaus`** package across **five channels**. The Homebrew, Scoop, winget, and apt builds are self-contained binaries — no Bun or Node runtime needed; only the npm/Bun package requires Bun (>= 1.2).

```bash
# npm / Bun (requires Bun >= 1.2)
npm install -g crewhaus        # or: bun add -d crewhaus

# Homebrew (macOS / Linux)
brew tap crewhaus/tap && brew install crewhaus

# Scoop (Windows)
scoop bucket add crewhaus https://github.com/crewhaus/scoop-bucket && scoop install crewhaus

# winget (Windows)
winget install CrewHaus.CLI

# apt (Debian / Ubuntu, signed)
curl -fsSL https://crewhaus.github.io/apt/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/crewhaus.gpg
echo "deb [signed-by=/usr/share/keyrings/crewhaus.gpg] https://crewhaus.github.io/apt stable main" | sudo tee /etc/apt/sources.list.d/crewhaus.list
sudo apt update && sudo apt install crewhaus
```

Then drive it the same way regardless of channel:

```bash
crewhaus init my-agent
cd my-agent
crewhaus compile && crewhaus run
```

`crewhaus --version` prints the build, e.g. `0.3.0`.

The `crewhaus` package transitively pulls in everything else via versioned npm deps (the workspace `workspace:*` references resolve to concrete versions at publish time), so users don't install the rest individually. A generated bundle additionally imports `@crewhaus/runtime-core` directly — that is the one other package consumers see on the receiving end.

> **The scope is public** (since the 0.1.x go-public cut, 2026-06-10): installing `crewhaus` and any `@crewhaus/*` library needs no auth.

## Versioning

The workspace versions in **lockstep**: every publishable package ships the same version, stamped by `bun scripts/release-prep.ts --version <next>` at cut time (see the publishing checklist below). Summary:

- All packages cut at **0.1.0** on 2026-05-30 — the initial public-API surface.
- Pre-1.0, breaking changes bump the minor (0.1.x → 0.2.0), per the [npm semver convention](https://semver.org/#spec-item-4). Features and bugfixes bump the patch.
- No per-package version drift and no per-PR bump bookkeeping — the next cut's version is decided at release time and applied across the board.
- The sibling `utilities/` workspace releases the same way with its own copy of the scripts.

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
- **Apps** — `crewhaus` (the user-facing entry point, in `apps/cli/`; published unscoped — the legacy `@crewhaus/cli` name is deprecated and redirects here)
- **Target codegens** — `@crewhaus/target-*`, one per supported target shape (CLI, channel bot, crew, graph, pipeline, workflow, voice, browser-driver, batch-worker, research-bundle, eval-bundle, managed, onchain, …)
- **Model adapters** — `@crewhaus/adapter-anthropic`, `@crewhaus/adapter-openai`, `@crewhaus/adapter-gemini`, `@crewhaus/adapter-bedrock`
- **Tools** — `@crewhaus/tool-*` (e.g. `tool-bash`, `tool-fetch`, `tool-web`, `tool-fs`, `tool-mcp`, `tool-task`, `tool-image`, `tool-codegraph`, …)
- **Channel adapters** — `@crewhaus/channel-adapter-slack`, `-telegram`, `-discord`, `-whatsapp`, `-imessage`
- **Eval & optimization** — `@crewhaus/eval-runner`, `@crewhaus/eval-grader`, `@crewhaus/grader-*`, `@crewhaus/prompt-optimizer`, `@crewhaus/prompt-optimizer-claude`, `@crewhaus/eval-optimizer-orchestrator`, `@crewhaus/spec-patch`
- **Security fabric** — `@crewhaus/boundary-classifier`, `@crewhaus/egress-classifier`, `@crewhaus/permission-engine`, `@crewhaus/audit-log`, `@crewhaus/audit-encryption`, `@crewhaus/pii-redactor`, `@crewhaus/prompt-injection-detector`
- **Persistence & state** — `@crewhaus/session-store`, `@crewhaus/checkpoint-store`, `@crewhaus/state-store`, `@crewhaus/vector-store`
- **Memory & continuity (v0.3.0)** — `@crewhaus/memory-service` (the composition root every emitter calls), `@crewhaus/continuity-store`, `@crewhaus/tool-plan`, `@crewhaus/wiki-store`, `@crewhaus/tool-wiki`, `@crewhaus/dream-engine`, `@crewhaus/default-skills`, `@crewhaus/grader-continuity`
- **Observability** — `@crewhaus/exporter-datadog`, `@crewhaus/exporter-newrelic`, `@crewhaus/exporter-honeycomb`, `@crewhaus/exporter-splunk`, `@crewhaus/otel-exporter`, `@crewhaus/cost-tracker`, `@crewhaus/run-context`, `@crewhaus/logging`
- **Utilities (factory-side)** — `@crewhaus/errors`, `@crewhaus/rate-limiter`, `@crewhaus/circuit-breaker`, `@crewhaus/token-budget`, `@crewhaus/idempotency-keys`, `@crewhaus/template-registry`, `@crewhaus/dataset-registry`
- **Sandbox images** — `@crewhaus/sandbox-image-*`, one per language for `tool-code-execution`. These may ship as container images in addition to npm packages.

The sibling [crewhaus/utilities](https://github.com/crewhaus/utilities) workspace contributes the **Studio + IDE surface**:

- `@crewhaus/studio-server`, `@crewhaus/studio-ui`, `@crewhaus/studio-plugin-sdk`, `@crewhaus/scaffold-templates`, `@crewhaus/wizard`, `@crewhaus/trace-viewer`, `@crewhaus/graph-visualizer`, `@crewhaus/dataset-builder`, `@crewhaus/grader-builder`
- `@crewhaus/vscode-extension`, `@crewhaus/jetbrains-plugin`
- `@crewhaus/crewhaus-playground` (browser REPL)

All twelve publish in their own lockstep (currently 0.1.5), independent of the factory cut.

## Intentionally NOT published

- `factory` (the root workspace itself) — `"private": true` permanently. It's a workspace orchestrator, not a consumable package.
- `crewhaus-utilities` (the root workspace in `utilities/`) — same reason.
- The deployable app at [crewhaus/studio-pwa](https://github.com/crewhaus/studio-pwa) — it's an Astro PWA you deploy on Cloudflare Pages, not an npm package.
- The demos workspace at [crewhaus/demos](https://github.com/crewhaus/demos) and the smoke packages under `demos/smoke/*` — `@crewhaus-examples/*` smoke tests per catalog section. Internal CI artifacts; the example code is freely copyable under Apache-2.0.
- The doc site at [crewhaus/docs](https://github.com/crewhaus/docs) — prose, not code.
- The sibling apps and tooling in the development meta-repo — none are npm-shipped.

## Publishing checklist (per release cut)

Releases are **lockstep** — every publishable package ships the same version, cut with the two scripts under `scripts/` (a changesets config existed early on but was never adopted and has been removed).

1. **Bump.** `bun scripts/release-prep.ts --version <next>` stamps every publishable package, then reformats **and verifies** the touched files with the pinned biome — it hard-fails rather than committing an un-normalized bump. Land the bump on `main` **via PR** with the workspace green (`bun run typecheck && bun run lint && bun test`), never a direct push: the v0.3.0 cut was pushed straight to `main` and shipped a lint-red tree that stayed red for a day. Belt-and-suspenders, the Release workflow now gates every publish channel on the full CI bar (its `ci` job reuses `.github/workflows/ci.yml`), so a red tag can no longer publish even if a bump lands un-gated.
2. **Auth.** Export a classic npm *Automation* token as `NPM_CONFIG_TOKEN`. A 2FA-bound token dead-ends `bun publish` in a web-OTP prompt.
3. **Canary.** `bun scripts/publish-workspace.ts --filter @crewhaus/errors` — one leaf package proves auth before the full fan-out.
4. **Publish.** `bun scripts/publish-workspace.ts` — topological order, skips versions already on the registry. Must stay on `bun publish`: it rewrites `workspace:*` to concrete versions at pack time; `npm publish` would ship the literal range and break every install.
5. **Verify.** Every name resolves on the registry at the new version (brand-new package names can lag a few minutes before appearing); `npm view crewhaus@<next> dependencies` shows internal deps pinned at exactly `<next>`; and from a fresh directory `npm install -g crewhaus@<next>` (or `bun add -d crewhaus@<next>`) followed by `crewhaus compile <spec> -o out` round-trips without the source repo.

## Flipping the scope to public

Completed for the 0.1.x go-public cut (2026-06-10) — kept for the record. All steps are done:

1. [x] Ran `scripts/release-prep.ts --version <next> --access public` on both `factory/` and `utilities/`. The script rewrites `publishConfig.access` across all package.jsons (public is now the default).
2. [x] Cut a new lockstep version for the visibility flip and published.
3. [x] Ran `npm access public @crewhaus/<pkg>` for the packages that needed to flip retroactively on already-published versions. (npm's policy: `restricted` versions stay restricted; new versions inherit `publishConfig.access`. The CLI command above flips the *package*, not just future versions.)
4. [x] Reverted the "private testing" note in [README.md](README.md) and removed the `<!-- Pre-launch note: … -->` banners from the launch-day draft docs (the specific files are tracked in the private launch runbook).
5. [x] Cut a release tag, pushed to GitHub, and published to npm in the same change window so docs and packages don't drift.

A fully generated list of packages (with versions, descriptions, and access status) is a one-liner over `packages/*/package.json` whenever we want one — that's a follow-up rather than something to hand-curate here.
