# Roadmap

The CrewHaus public roadmap. This is not a commitment; it's the direction we're moving.

For day-to-day visibility on what's in flight, see the [GitHub Project](https://github.com/orgs/crewhaus/projects/1) (set up post-launch) and the [milestone view](https://github.com/crewhaus/factory/milestones).

## Versioning policy

- Pre-1.0: minor versions can include breaking changes; we document them in the changelog.
- The spec schema is versioned from day one (the optional top-level `version:` key, read as 0 when a spec leaves it out; the current schema version is 2, since v0.6.0, and `crewhaus upgrade` stamps and migrates older specs).
- 1.0 ships when: schema is stable, the eval-driven optimization loop is documented and tested for at least three target shapes, and the boundary-classifier inventory is complete.

## What's shipped (current: v0.8.0)

**v0.8.0 — the provability release:** a spec can say how much proof its answers carry. The `provability:` block sets a floor on a four-rung ladder — `cited`, `grounded`, `checked`, `proven` — and as each answer completes, a deterministic gate checks every claim in it against the evidence the run recorded: sources it actually fetched, tool results it actually logged (pure tools are re-run to confirm them), and proofs a checker accepted. An answer that falls short is retried and, if it still falls short, served with a visible ✗; or escalated, served with the ✗ at once, or halted, as the spec says; and a proof bundle travels with every gated answer: a footer, a gateway `proof` field, a research report section, a trace line and a JSON file on disk. The gate runs on cli, channel, managed and research, and is off unless a spec turns it on. Around it: the `ProofCheckers`, `ProofCheck` and `ProvabilityPreflight` tools and three checkers (a built-in certificate checker, and Z3 and Lean 4 in curated sandbox images), the `crewhaus provability show | check | audit | checkers | prune` verbs, `init --provability`, `eval --provability`, the `provability.*` graders, and one composition root for both in-loop gates (`@crewhaus/evaluation-service`). Among the changes that reach every harness: `continuity.proof: require | off`, carried since v0.3.0, is enforced, and the agent's tools can no longer write the run's own record (its session logs, spilled tool results and proof bundles), shell commands and `--permission-mode bypass` aside. v0.8.0 also ships the v0.7.1 hardening, which was never tagged on its own. Design: [design/0.8.0-provability-release.md](design/0.8.0-provability-release.md); the [changelog](CHANGELOG.md) lists every change that affects a harness without the block.

**v0.7.x — tools a harness can run without spending a token:** v0.7.0 grew the builtin catalog to hundreds of tools — text, structured data, dates, exact money, git and packages, chain and ledger reads, fleet and eval operations — almost none of which makes a model call, and `tools:` gained a grammar for granting a capability group at a time (`all-code`, `-bash`), with `crewhaus tools categories | show | search` to look inside it. It also brought `crewhaus hangar --lan` with a scannable QR code, and `crewhaus services setup`, which creates the Slack app, Cloudflare tunnel and Thredz space a spec declares. The 0.7.1 hardening, shipped inside v0.8.0, makes those tools safe to grant: a permission rule can no longer be dodged by spelling a call another way, tools stay inside the workspace, crafted input cannot freeze the harness, the model no longer picks which environment variable is sent as a credential, and every shape that runs tools can call them, with their `tool_config` (the [changelog](CHANGELOG.md) names the exceptions).

**v0.6.0 — per-model settings and hybrid setups:** a spec names every model it uses in a top-level `models:` registry, references any of them as `$profile` at any model slot, and gives each its own tools, request parameters and permissions. Several models can then work in one loop — a cheap one drafting and a strong one checking (`evaluation.on_fail: escalate`), a guide briefing the turn, a committee voting, a shadow candidate auditioning off to the side, or the model itself calling `Consult` / `Escalate`. Routing decisions are durable and replayable (`crewhaus route explain`), learned routing gains profile-keyed arms, a quality floor and a freeze switch, and `crewhaus eval --routing` measures what production actually serves, per arm, with a leaderboard that declines to name a winner on underpowered data. New verbs: the `crewhaus models` family and a grown `crewhaus route`. Specs move to `version: 2` — run `crewhaus upgrade`. See the [changelog](CHANGELOG.md) for the behaviour changes this release sanctions.

Releases between v0.3.1 and v0.6.0 — the v0.4.x agent-loops line and the v0.5.x fleet-operations, Hangar and advisor line — are documented release by release in the [changelog](CHANGELOG.md).

**v0.3.1 — the memory-release patch:** republishes the memory-release packages with a packaging fix so compiled agent-loop bundles boot. `@crewhaus/default-skills@0.3.0` (and six `templates/` packages) shipped without their runtime data dirs — the publish step dropped every non-`src` `files` entry — so default-on continuity made every compiled bundle crash at boot on a missing `SKILL.md`; `release-prep --for-publish` now preserves data dirs. Also carries the cost-tracker unpriced-model fix and the refreshed pricing/capability tables (Opus 4.8 / Sonnet 5 / Haiku 4.5 / Fable 5). See the [changelog](CHANGELOG.md).


**Compiler core (v0.1.0):**

- Compiler core: `parseSpec → lower → applyPasses → emit`
- IR as a discriminated union of target-shape variants (CLI, channel bot, stateful graph, managed multi-tenant, RAG pipeline, multi-agent crew, autonomous research, batch worker, voice/realtime, browser/computer-use, eval bundle, workflow, on-chain, on-chain game)
- Target emitters, one per shape: CLI, channel-{slack,discord,telegram,whatsapp,imessage}, graph, managed, pipeline, crew, research, batch, voice, browser, eval, workflow, onchain, onchain-game
- `crewhaus-runtime-core` — runtime-thin imports for generated bundles
- The CLI surface, grown well past the original six (`init`, `compile`, `run`, `optimize`, `validate`, `doctor`) to include `eval`, `lint`, `flywheel`, `advise`, `route`, `deploy`/`propose`, `fleet`, and more — see the [CLI reference](https://github.com/crewhaus/docs/blob/main/CLI-REFERENCE.md)
- Eval-driven optimization: rule-based and Claude-driven `MutationProvider`s; spec-patch with YAML CST round-trip
- Boundary classifier with `TrustOrigin` metadata across every boundary site (MCP, sub-agent, channel, federation, skill, compaction, tool, chain, memory for recalled wiki/fact bodies via tool-wiki, and since v0.6.0 consult for a roster sibling's reply)
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

- Thredz backend wiring on the research shape (the `thredz:` block is carried there with a note; cli, channel, managed and crew are wired)
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

### v0.8.x — provability

**Shipped in v0.8.0 — the provability release** (summarised under "What's shipped" above; design: [design/0.8.0-provability-release.md](design/0.8.0-provability-release.md)). The gate shares the turn-completion seam the `evaluation:` judge uses and runs before it; one composition root, `@crewhaus/evaluation-service`, builds both; and `continuity.proof: require | off`, deferred by v0.3.0, is enforced in tool-plan.

Still on the 0.8.x line — each a seam the design names (§12), not an open question:

- The pipeline (RAG) answer stage: verify the answer against the `Retrieve` hits it was given (until then the pipeline schema rejects `provability:`)
- The crew orchestrator's synthesis turn (crew accepts the block today with an `accepted-but-unwired` warning)
- `on_fail: retry` on research, as a per-branch re-run with the nudge (research degrades `retry` and `escalate` to `note` today, with a warning)
- `kind: provability` gate steps on workflow and gate nodes on graph, beside `kind: judge`
- The Hangar console's rung badge and bundle viewer (the server's `GET /api/runs/:sessionId/proof` ships)
- Third-party proof checkers, registered through a plugin once the plugin loader exposes a `proofCheckers` slot
- Evidence shared across a channel daemon's threads (`scope: session` follows the per-thread session today)

And one direction the design leaves open (§10): keyed integrity on session-log lines, so a `Bash` or `RunCommand` write into the log cannot pass for recorded evidence. The runtime-state floor cannot see where a shell command writes, and `--permission-mode bypass` lifts it.

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

*Last updated: 2026-10-24. Subject to change.*
