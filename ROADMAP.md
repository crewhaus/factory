# Roadmap

The CrewHaus public roadmap. This is not a commitment; it's the direction we're moving.

For day-to-day visibility on what's in flight, see the [GitHub Project](https://github.com/orgs/crewhaus/projects/1) (set up post-launch) and the [milestone view](https://github.com/crewhaus/factory/milestones).

## Versioning policy

- Pre-1.0: minor versions can include breaking changes; we document them in the changelog.
- The spec schema is versioned from day one (`spec_version: v0`).
- 1.0 ships when: schema is stable, the eval-driven optimization loop is documented and tested for at least three target shapes, and the boundary-classifier inventory is complete.

## What's in v0.1.0 (current)

- Compiler core: `parseSpec → lower → applyPasses → emit`
- IR as a discriminated union of target-shape variants (CLI, channel bot, stateful graph, managed multi-tenant, RAG pipeline, multi-agent crew, autonomous research, batch worker, voice/realtime, browser/computer-use, eval bundle, workflow)
- Twelve target emitters: CLI, channel-{slack,discord,telegram,whatsapp}, graph, managed, pipeline, crew, research, batch, voice, browser, eval, workflow
- `crewhaus-runtime-core` — runtime-thin imports for generated bundles
- `crewhaus init`, `crewhaus compile`, `crewhaus run`, `crewhaus optimize`, `crewhaus validate`, `crewhaus doctor`
- Eval-driven optimization: rule-based and Claude-driven `MutationProvider`s; spec-patch with YAML CST round-trip
- Boundary classifier with `TrustOrigin` metadata across the seven boundary sites (MCP, sub-agent, channel, federation, skill, compaction, tool)
- Hello-world examples for: CLI, workflow, channel-{discord,telegram,whatsapp}, federation, graph, sandbox-image (multiple language variants)

## v0.2.x (Days 30-60)

- More example artifacts: GitHub-issue-triage harness, doc-summarization skill, RAG pipeline, multi-agent customer-support crew, eval bundle
- Improved `crewhaus doctor --philosophy-alignment` checks
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
- **Python implementation.** The repo's CLAUDE.md explains: TS+Bun is the primary runtime. The Claude-backed `MutationProvider` superseded the originally-deferred DSPy bridge.
- **Built-in model hosting.** We integrate with model providers; we don't host models.
- **Generic LLM playground.** CrewHaus is a compiler, not a chat app.

## How to propose roadmap changes

Open an RFC issue. See [`CONTRIBUTING.md`](CONTRIBUTING.md). We expect to revise the roadmap quarterly.

---

*Last updated: [DATE]. Subject to change.*
