# Roadmap

The CrewHaus public roadmap. This is not a commitment; it's the direction we're moving.

For day-to-day visibility on what's in flight, see the [GitHub Project](https://github.com/orgs/crewhaus/projects/1) (set up post-launch) and the [milestone view](https://github.com/crewhaus/factory/milestones).

## Versioning policy

- Pre-1.0: minor versions can include breaking changes; we document them in the changelog.
- The spec schema is versioned from day one (`spec_version: v0`).
- 1.0 ships when: schema is stable, the eval-driven optimization loop is documented and tested for at least three target shapes, and the boundary-classifier inventory is complete.

## What's shipped (current: v0.3.0)

**Compiler core (v0.1.0):**

- Compiler core: `parseSpec → lower → applyPasses → emit`
- IR as a discriminated union of target-shape variants (CLI, channel bot, stateful graph, managed multi-tenant, RAG pipeline, multi-agent crew, autonomous research, batch worker, voice/realtime, browser/computer-use, eval bundle, workflow, on-chain, on-chain game)
- Target emitters, one per shape: CLI, channel-{slack,discord,telegram,whatsapp,imessage}, graph, managed, pipeline, crew, research, batch, voice, browser, eval, workflow, onchain, onchain-game
- `crewhaus-runtime-core` — runtime-thin imports for generated bundles
- The CLI surface, grown well past the original six (`init`, `compile`, `run`, `optimize`, `validate`, `doctor`) to include `eval`, `lint`, `flywheel`, `advise`, `route`, `deploy`/`propose`, `fleet`, and more — see the [CLI reference](https://github.com/crewhaus/docs/blob/main/CLI-REFERENCE.md)
- Eval-driven optimization: rule-based and Claude-driven `MutationProvider`s; spec-patch with YAML CST round-trip
- Boundary classifier with `TrustOrigin` metadata across the nine boundary sites (MCP, sub-agent, channel, federation, skill, compaction, tool, chain, memory — recalled wiki/fact bodies via tool-wiki)
- Hello-world examples for: CLI, workflow, channel-{discord,telegram,whatsapp}, federation, graph, sandbox-image (multiple language variants)

**v0.2.0 — the automation release** (the feedback loops now run themselves):

- **Pillar 3 egress fabric** — sink-side companion to `boundary-classifier`. `packages/egress-classifier`; tool descriptors gain `scope: "internal" | "external"`; `RunContext.dataLineage` tracks per-origin provenance; `runtime-core` scans every external-scope tool input against lineage before invocation. New `egress_decision` audit + `egress-passed | egress-warned | egress-blocked` outcomes. A pluggable `EgressMatcher` (substring / semantic) delivered FR-006. Recipe: [demos/walkthroughs/55-egress-fabric.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/55-egress-fabric.md).
- **Pillar 3 intent gate (justification)** — `permission-engine` gains `evaluateJustification` + `ruleBasedJustificationJudge` + the `JustificationJudge` interface for LLM-backed judges; tools gain `requireJustification`; new `permission_justification_evaluated` audit (FR-004). Recipe: [demos/walkthroughs/53-justification-gates.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/53-justification-gates.md).
- **Pillar 2 canonical 12-metric rubric** — `packages/grader-12-metric-rubric` with all 12 named graders + validated thresholds, `summarize12MetricRubric` roll-ups (p50/p95/p99), and the `costPerUsefulOutput` aggregator. Recipe: [demos/walkthroughs/12-eval-harness.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/12-eval-harness.md).
- **Pillar 2 active context curation** — `packages/compaction-curator` (semantic-dedupe + relevance-reorder + top-K trim); `OPTIMIZABLE_PATHS` exposes `compaction.curate` / `dedupeThreshold` / `relevanceTopK`. Recipe: [demos/walkthroughs/52-context-curation.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/52-context-curation.md).
- **AST-aware code intelligence** — `packages/tool-codegraph` (`CodeGraphSearch` / `CodeGraphCallers` / `CodeGraphCallees` / `CodeGraphImpact`). Recipe: [demos/walkthroughs/54-codegraph-tool.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/54-codegraph-tool.md).
- **The self-improvement automation layer, wired end-to-end** — `crewhaus flywheel`, `advise`, `autodistill`, the canary gate, `faq distill` / `lessons update` / `fewshot harvest` / `sessions summarize`, `fleet`, `knowledge sync`, `retire`, and `state backup/restore`.
- Per-shape GHCR container images, `crewhaus upgrade` spec migrations, an `observability.slo` block, `crewhaus mcp doctor`, and a first-class `memory:` block. Improved `crewhaus doctor --philosophy-alignment` (now covers egress + justification fabric drift).

**v0.2.1 / v0.2.2 — adaptive model routing:**

- `agent.model_pool` — declare *N* candidate models and a selection `policy` (`static` / `heuristic` / `learned`); the superset of `model_tiers` + `model_fallbacks`, backed by `@crewhaus/routing-store` (v0.2.1).
- `crewhaus route status | reset | explain` — inspect, wipe, or replay the durable reward scoreboard.
- **Online learning (v0.2.2)** — ε-greedy and Thompson-sampling bandits (`learning.bandit`, `learning.explorationRate`); every pick emits a `model_route` trace event.
- `crewhaus advise` mines the reward scoreboard into eval-gated pool-policy patches; the pool threads through `crewhaus run` and the pipeline/research/batch/browser shapes. Recipes: [57-advisor-loop](https://github.com/crewhaus/demos/blob/main/walkthroughs/57-advisor-loop.md), [59-model-resilience-and-cost](https://github.com/crewhaus/demos/blob/main/walkthroughs/59-model-resilience-and-cost.md).

**v0.3.0 — the memory release:** default-on continuity (`continuity:`), the local wiki + `learning:` fabric, one-knob hosted memory (`thredz:`), scheduled `memory.dream` consolidation, and classified run failures with meaningful exit codes. Detail in the v0.3.x section below and the [changelog](CHANGELOG.md).

## v0.3.x (Days 60-120)

**Shipped in v0.3.0 — the memory release.** Every agent-loop harness (cli, channel, managed, research, crew) now remembers: **continuity is on by default** — persistent focus, plans, and goals with a claimed→proven proof ladder, a verbatim requirements ledger that survives compaction, and a deterministic teardown handoff (`continuity:`; one line, `continuity: false`, restores the 0.2.x bundle byte-for-byte). **Continual learning** lands as the update-in-place local wiki (`memory.wiki`, hybrid recall) plus the `learning:` block that turns a harness into a self-teaching expert with `/study`, `/reflect`, and a first-class `/exam`. **Thredz is one knob** — `thredz: $THREDZ_API_KEY` flips the wiki backend to the hosted service, private by default. Everything stays **local-first**: the whole fabric runs on files under `.crewhaus/` with zero network, and Thredz is a backend flip, not a requirement. **`memory.dream`** consolidates on a schedule — a deterministic maintenance pass plus a budget-capped model phase. And **failures are honest**: billing/auth/rate-limit classification, one `FailureReport` on every surface, and a documented exit-code table — an out-of-credit account no longer reads as "agent exited."

Still on the 0.3.x line:

- Thredz backend wiring on the channel/managed/research/crew shapes (the `thredz:` block is carried there today; cli is emit-wired)
- `proof: require | off` enforcement in tool-plan (carried; degrades to the ladder with a boot note)
- `crewhaus wiki push | pull --thredz` — the explicit local ↔ hosted knowledge bridge
- Better integration with the Anthropic, OpenAI, Google, and open-source model providers

## v0.4.x (Days 120-180)

The underlying plugin/template marketplace primitives — `packages/plugin-registry`, `module-marketplace-client`, `template-registry`, and the `crewhaus plugins` / `crewhaus templates` CLI — already landed in v0.2.0. The public Forge and its verified-artifact program are the remaining piece:

- **Crewhaus Forge** (community registry) integration: `crewhaus publish`, artifact validation, artifact pages
- Public artifact directory at forge.crewhaus.ai
- Verified-artifact distinction (community vs reviewed)
- More target shapes based on community demand
- IR-level optimization passes beyond `redundantMcpServerCollapse`
- Improved boundary classifier with custom-policy support
- Open-source helpers for self-hosted private registries

(A future Crewhaus Cloud integration — `crewhaus login`, `crewhaus push`, hosted run history — is currently deferred. We may add it later if there's clear demand for a hosted product; the Cloud roadmap itself is documented internally but not part of the public commitment.)

## v0.5.x — v0.9.x (Days 180-365)

- Additional target shapes based on demand (candidates: webhook endpoint, scheduled job, browser extension content script)
- IR-level optimization passes beyond `redundantMcpServerCollapse`
- Plugin system for community-contributed targets
- Improved active-eval optimization (more sophisticated mutation operators, better budget management)
- Hardened boundary classifier with custom-policy support

## v1.0 (target: Q4 2026, but driven by stability, not date)

- Schema and CLI commands stable
- Documented compatibility policy
- Production-readiness statement for each target shape
- Security audit completed

## Themes we are not presently pursuing

To save time on questions: these are not on the roadmap, and may or may not ever be depending on the direction of the project TBD by user demand and community contributions.

- **Visual / no-code spec editor.** CrewHaus is a developer tool. Specs are YAML files in your editor.
- **Drag-and-drop workflow builder.** That's a different product category (n8n, Make, Zapier). CrewHaus targets developers.
- **Python implementation.** The repo's AGENTS.md explains: TS+Bun is the primary runtime. The Claude-backed `MutationProvider` superseded the originally-deferred DSPy bridge.
- **Built-in model hosting.** We integrate with model providers; we don't host models.
- **Generic LLM playground.** CrewHaus is a compiler, not a chat app.

## How to propose roadmap changes

Open an RFC issue. See [`CONTRIBUTING.md`](CONTRIBUTING.md). We expect to revise the roadmap quarterly.

---

*Last updated: 2026-07-14. Subject to change.*
