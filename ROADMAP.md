# Roadmap

The CrewHaus public roadmap. This is not a commitment; it's the direction we're moving.

For day-to-day visibility on what's in flight, see the [GitHub Project](https://github.com/orgs/crewhaus/projects/1) (set up post-launch) and the [milestone view](https://github.com/crewhaus/factory/milestones).

## Versioning policy

- Pre-1.0: minor versions can include breaking changes; we document them in the changelog.
- The spec schema is versioned from day one (`spec_version: v0`).
- 1.0 ships when: schema is stable, the eval-driven optimization loop is documented and tested for at least three target shapes, and the boundary-classifier inventory is complete.

## What's in v0.1.0 (current)

- Compiler core: `parseSpec → lower → applyPasses → emit`
- IR as a discriminated union of target-shape variants (CLI, channel bot, stateful graph, managed multi-tenant, RAG pipeline, multi-agent crew, autonomous research, batch worker, voice/realtime, browser/computer-use, eval bundle, workflow, on-chain, on-chain game)
- Target emitters, one per shape: CLI, channel-{slack,discord,telegram,whatsapp,imessage}, graph, managed, pipeline, crew, research, batch, voice, browser, eval, workflow, onchain, onchain-game
- `crewhaus-runtime-core` — runtime-thin imports for generated bundles
- `crewhaus init`, `crewhaus compile`, `crewhaus run`, `crewhaus optimize`, `crewhaus validate`, `crewhaus doctor`
- Eval-driven optimization: rule-based and Claude-driven `MutationProvider`s; spec-patch with YAML CST round-trip
- Boundary classifier with `TrustOrigin` metadata across the eight boundary sites (MCP, sub-agent, channel, federation, skill, compaction, tool, chain)
- Hello-world examples for: CLI, workflow, channel-{discord,telegram,whatsapp}, federation, graph, sandbox-image (multiple language variants)

## v0.2.x (Days 30-60)

**Reference-corpus integrations (this slice):**

- **Pillar 3 egress fabric** — symmetric sink-side companion to `boundary-classifier`. New `packages/egress-classifier`. Tool descriptors gain `scope: "internal" | "external"`; `RunContext.dataLineage` tracks per-origin content provenance; `runtime-core` scans every external-scope tool input against lineage before invocation. New audit kind `egress_decision`. New trace outcomes `egress-passed | egress-warned | egress-blocked`. Recipe: [demos/walkthroughs/51-egress-fabric.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/51-egress-fabric.md). Source: OpenAI 2026-05 prompt-injection paper, SACR 2026 runtime-security paper.
- **Pillar 3 intent gate (justification)** — `permission-engine` adds `evaluateJustification` + `ruleBasedJustificationJudge` + the `JustificationJudge` interface for LLM-backed production judges. Tool descriptors gain `requireJustification: true`. New audit kind `permission_justification_evaluated`. Recipe: [demos/walkthroughs/53-justification-gates.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/53-justification-gates.md). Source: SACR's three-layer model (Cyata's "guardian agent", Apono's intent-based authorization).
- **Pillar 2 canonical 12-metric rubric** — new `packages/grader-12-metric-rubric` with all 12 named graders + industry-validated thresholds. Cross-sample roll-up via `summarize12MetricRubric` (p50/p95/p99, category roll-ups, threshold-breach flags). `costPerUsefulOutput` aggregator. Recipe: [demos/walkthroughs/12-eval-harness.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/12-eval-harness.md). Source: TDS 2026-05 12-metric framework.
- **Pillar 2 active context curation** — new `packages/compaction-curator`. Semantic-dedupe + relevance-reorder + top-K trim. `OPTIMIZABLE_PATHS` exposes `compaction.curate`, `compaction.dedupeThreshold`, `compaction.relevanceTopK`. Recipe: [demos/walkthroughs/52-context-curation.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/52-context-curation.md). Source: Routray 2026-03 context-cost article.
- **AST-aware code intelligence** — new `packages/tool-codegraph` with four tools (`CodeGraphSearch`, `CodeGraphCallers`, `CodeGraphCallees`, `CodeGraphImpact`) wrapping `@colbymchenry/codegraph` as an optional peer. Recipe: [demos/walkthroughs/54-codegraph-tool.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/54-codegraph-tool.md).

**Other v0.2.x items:**

- More example artifacts: GitHub-issue-triage harness, doc-summarization skill, RAG pipeline, multi-agent customer-support crew, eval bundle
- Improved `crewhaus doctor --philosophy-alignment` checks (now covers egress + justification fabric drift)
- Polished error messages from the compiler (especially around invalid IR transitions)
- Tightened recipes index with task-oriented walkthroughs

## v0.3.x (Days 60-120)

- **Crewhaus Forge** (community registry) integration: `crewhaus publish`, artifact validation, artifact pages
- Public artifact directory at forge.crewhaus.ai
- Verified-artifact distinction (community vs reviewed)
- Better integration with the Anthropic, OpenAI, Google, and open-source model providers

## v0.4.x (Days 120-180)

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

*Last updated: 2026-05-30. Subject to change.*
