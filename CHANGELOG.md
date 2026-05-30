# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - §55–§59 integration batch (2026-05-26)

External sources synthesized for this batch:

- **AutoHarness** (Lou et al., Google DeepMind, March 2026; arxiv 2603.03329) — code-as-harness via Thompson-sampled tree search.
- **Natural-Language Agent Harnesses** (Pan et al., Tsinghua, March 2026; arxiv 2603.25723) — contracts + roles + stages + adapters + state semantics + failure taxonomy as portable executable artifacts.
- **Meta-Harness** (Lee et al., Stanford/MIT/KRAFTON, March 2026; arxiv 2603.28052) — filesystem-backed full-history coding-agent optimizer.
- **AgentFlow** (Liu et al., UCSB et al., April 2026; arxiv 2604.20801) — typed graph DSL + four runtime feedback channels.
- **Meta-Engineering Harnesses** (Sengupta et al., HireNimbus, May 2026; arxiv 2605.25665) — two-pass contracts, four-way failure arbiter, specialization records.
- **TDS 12-Metric Framework**, **OpenAI Prompt-Injection Defense**, **Identity Governance**, **Stop Wasting Money on AI Context** — four blog-style studies cross-checked against shipped v0.2.x packages.
- **ECC**, **Understand-Anything**, **claude-plugins-official** — three reference repos providing patterns for rule packs, skill-as-orchestrator, and the Anthropic minimal plugin format.

### Added

- **§55 Track A** — `spec.failure_taxonomy` block (cross-cutting; added to every IR variant). `recovery-engine` consults user-named classes before falling back to its built-in taxonomy. `failure_taxonomy` added to `OPTIMIZABLE_PATHS` for every target. Source: NLAH (arxiv 2603.25723).
- **§55 Track B** — Four-way failure arbiter in `eval-optimizer-orchestrator/failure-arbiter`. Classifies failing samples into `bug | spec-gap | noise | contract-ambiguity` and maps each to a corrective `ArbiterAction`. Tie-break favors process-correcting actions. Source: Meta-Engineering Harnesses (arxiv 2605.25665).
- **§55 Track C** — Coverage cross-check test for `grader-12-metric-rubric`: 12 metrics in 4 categories, threshold constants pinned to the published values. Source: TDS 12-Metric Framework.
- **§55 Track D** — New `packages/tool-harness-synthesizer`. Thompson-sampled tree search over candidate verifier functions; `VerifierMutationProvider` plugs into the existing optimizer. Source: AutoHarness (arxiv 2603.03329).
- **§56 Track E** — New `packages/meta-harness-optimizer`. **BREAKING (opt-in).** Coding-agent proposer with filesystem-backed full history. Ships the experience-store layout + `MetaHarnessMutationProvider` adapter, consumable programmatically via `optimizeSpec({ mutator: new MetaHarnessMutationProvider(...) })`. The proposer is a caller-supplied `ProposerFn` so the package stays pure and testable. Bundle output diverges from spec; `formatBreakingChangeHeader()` prepends a warning. CLI `--mutator meta-harness` wiring is a follow-up — the CLI currently exposes `rule-based` and `claude` only. Source: Meta-Harness (arxiv 2603.28052).
- **§57 Track F** — Typed graph DSL: `IrMessageSchema`, `IrSchemaRef`, optional `messageSchemas` on `IrCrewV0`/`IrGraphV0`; edge `schema` on `IrGraphEdge`. New `wellFormednessCheck` pass in `ir-passes` (graph connectivity, edge resolution, schema reference resolution). Four new TraceEventBus event kinds: `test_verdict`, `program_output`, `coverage_report`, `sanitizer_report`. Source: AgentFlow (arxiv 2604.20801).
- **§58 Track G** — New `packages/specialization-registry` (payments, auth, booking built-ins + project-local JSON overrides) and `packages/contract-compiler` (two-pass: completeness + ambiguity). Source: Meta-Engineering Harnesses (arxiv 2605.25665).
- **§59 Track H** — New `packages/target-claude-plugin` emitter. Transforms any IR variant into an Anthropic-compatible Claude Code plugin directory (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md` + optional `agents/`, `.mcp.json`). Source: claude-plugins-official.
- **§59 (post-batch)** — Browser-deployable `packages/compiler-worker` and new `packages/target-cf-worker-cli`, `packages/target-cf-worker-graph`, `packages/target-cf-worker-workflow` emitters for shipping compiled bundles as Cloudflare Workers.
- **§44 Cloud adapters** — One-click deploy adapters for `packages/cloud-adapter-flyio`, `packages/cloud-adapter-heroku`, `packages/cloud-adapter-railway`, `packages/cloud-adapter-render`.
- **§41 Plugin system** — New `packages/plugin-sdk` (typed surface for third-party extensions) and `packages/plugin-loader` (runtime activation with sandboxed import + signature verification).
- **§42 Plugin registry + marketplace** — New `packages/plugin-registry` (discovery, pinning, signature verification) and `packages/module-marketplace-client` (search / install / update / publish over the registry).
- **Cross-cutting (Track 10)** — `RunContext.agentIdentity` (skillId / subAgentId / roleId) + `formatAgentIdentity` helper. New `packages/rules-engine` reads multi-language rule packs from `rules/{common,typescript,python,...}` with `CREWHAUS_RULES_PROFILE=core|standard|full` gating. Sources: Identity Governance, ECC §4.1.

### Changed

- **`DEFAULT_PIPELINE`** in `ir-passes` now has 6 passes (added `wellFormednessCheck` before `promptCachePrefixSort`).
- **`OPTIMIZABLE_PATHS`** in `spec-patch` extended with `failure_taxonomy` for every target.

### Documentation

- `docs/MODULE-CATALOG-STATUS.md` updated with §55–§59 rows pointing at the new packages.
- Each new/changed source file carries an inline docstring citing the underlying arxiv paper or article (the canonical record of *why* each piece exists).

### Verification

- `bun run tsc -b`: clean.
- `bun run test:smoke`: 17/17 pass.
- Full unit suite: 6016 pass / 0 fail / 2 skip across 440 files.

## [0.1.0] - 2026-05-15

### Added

- Initial public release of the factory meta-harness compiler.
- Compiler pipeline (`parseSpec → lower → applyPasses → emit`) in `packages/compiler`.
- IR discriminated union covering CLI, workflow, channel, graph, managed, pipeline, crew, research, batch, voice, browser, eval, onchain, and onchain-game target shapes (`packages/ir`).
- Target emitters under `packages/target-*` for each IR variant.
- IR-level optimization passes in `packages/ir-passes` (e.g. redundant MCP server collapse).
- Active optimization loop: `packages/eval-runner`, `packages/prompt-optimizer`, `packages/prompt-optimizer-claude`, `packages/spec-patch`, and `packages/eval-optimizer-orchestrator`, exposed via `crewhaus optimize`.
- Security fabric via `packages/boundary-classifier` with `TrustOrigin` metadata and a content-hash LRU cache, wired into MCP, sub-agent, channel, federation, skill, compaction, and tool boundaries.
- `crewhaus doctor --philosophy-alignment` audit for the three architectural pillars.
- CLI app (`apps/cli`), Helm chart (`packages/helm-chart`), and single-binary CLI build. IDE extensions (VS Code, JetBrains) live in the sibling [crewhaus/utilities](https://github.com/crewhaus/utilities) repo.
- Example specs and recipes in the [demos repo](https://github.com/crewhaus/demos) under `smoke/` and `walkthroughs/`.
- Module catalog and build roadmap in the standalone [docs repo](https://github.com/crewhaus/docs).
