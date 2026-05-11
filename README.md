# crewhaus-factory

A modular **meta-harness tool**: compile a single high-level harness spec into multiple runtime targets (CLI agent, channel bot, multi-agent crew, RAG pipeline, eval harness, managed runtime, stateful graph, autonomous research, voice/realtime, computer-use, batch worker).

Status: scaffolding + thin vertical slice. The first end-to-end target is **CLI** — a minimal `spec.yaml` → IR → generated TypeScript agent that runs under Bun.

## Documentation

- **New here?** Start with [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) — guided tour from first principles to a runnable agent.
- **Looking for a recipe?** See [`docs/recipes/INDEX.md`](docs/recipes/INDEX.md) — 40 task-oriented walkthroughs, one per major feature.
- **Need the canonical module reference?** See [`docs/MODULE-CATALOG.md`](docs/MODULE-CATALOG.md) — ~190 modules, 25 layers, 12 target shapes.

## Repository layout

```
packages/
  spec/           F1 — user-facing spec schema (Zod) + YAML parser
  ir/             F1 — canonical typed intermediate representation
  compiler/       F2 — compiler-core (parse → validate → lower → emit)
  target-cli/     F2 — codegen backend for CLI target
  runtime-core/   R1 — minimal runtime imported by generated bundles
apps/
  cli/            the `crewhaus` CLI ("compile", "run", ...)
examples/
  hello-cli/      smallest possible spec + generated agent
docs/
  MODULE-CATALOG.md         complete module catalog (~190 modules)
  AI-Harness-Systems.md     ecosystem analysis grounding the catalog
  architecture studies/     reference architectures (Claude Code, OpenClaw)
reference-repos/  (gitignored) cloned upstream harnesses for browsing
```

## Quickstart (vertical slice)

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
bun install
bun run compile:hello   # compiles examples/hello-cli/crewhaus.yaml → dist/agent.ts
ANTHROPIC_API_KEY=sk-... bun run run:hello
```

The compiled agent is a self-contained TypeScript file that imports `@crewhaus/runtime-core` and runs a streaming chat loop with the configured model and instructions.

## Three architectural pillars

Every change in this repo respects three invariants. They exist because the founding thesis in [`docs/AI-Harness-Systems.md`](docs/AI-Harness-Systems.md) only holds if all three stay true together. Contributors should read [`CLAUDE.md`](CLAUDE.md) for the rules each pillar produces.

1. **The compiler is the protagonist.** Crewhaus is a meta-harness compiler, not "yet another agent loop." Specs flow through `parseSpec → lower → applyPasses → emit`; the IR is a discriminated union (`IrNode = IrV0 | IrWorkflowV0 | IrChannelV0 | IrGraphV0 | ...`) and each target shape consumes its own typed IR variant. New target shapes start at the IR, not at codegen. Walked through with file paths in [`docs/COMPILER-ARCHITECTURE.md`](docs/COMPILER-ARCHITECTURE.md).

2. **Eval is active, not passive.** The empirical signal that the harness layer can deliver measurable accuracy gains is DSPy's MIPRO result (+13% on five of seven multi-stage programs). Crewhaus's eval stack closes the loop: eval failures produce *spec patches* via `crewhaus optimize`, not just HTML reports. The orchestration layer wires `eval-runner` (fitness) + `prompt-optimizer` (search via a `MutationProvider` interface, with both rule-based and Claude-driven providers shipping) + `spec-patch` (YAML CST round-trip with comment preservation) + optional write-back. See [`docs/recipes/42-active-optimization.md`](docs/recipes/42-active-optimization.md).

3. **Security is a fabric, not a perimeter.** `prompt-injection-detector` fires at every cross-trust boundary, not just the front door. The `boundary-classifier` package centralises classification with `TrustOrigin` metadata — `"user" | "mcp" | "subagent" | "channel" | "federation" | "skill" | "compaction" | "tool"` — and a content-hash LRU cache. Authentication (mTLS, JWT) verifies *who*; classification verifies *what*. See [`docs/recipes/41-security-fabric.md`](docs/recipes/41-security-fabric.md).

## Operating choices

- **TypeScript + Bun** primary runtime. Python interop is reserved for slots where the ecosystem genuinely outclasses TS (today: nothing — the Claude-backed `MutationProvider` superseded the originally-deferred DSPy bridge for prompt optimisation; Ragas/HELM/lm-evaluation-harness datasets are consumed via shipped JSONL exports rather than a runtime bridge).
- **Spec → IR → target codegen** pipeline. The IR is runtime-agnostic; backends are swappable. Twelve targets ship today (CLI, workflow, channel bot, stateful graph, managed multi-tenant, RAG pipeline, multi-agent crew, autonomous research, batch worker, voice/realtime, browser/computer-use, eval bundle).
- **Generated bundles are runtime-thin**: they import `@crewhaus/runtime-core` rather than embedding everything. The `bundle-packager` module can inline for distribution.
- **Streaming + prompt caching** in the runtime by default — these are core, not optional.

## Roadmap from this scaffold

The vertical slice covers the smallest sliver of these catalog modules:
- `spec-schema`, `spec-parser`, `spec-validator` (F1)
- `ir-model` (F1, v0 only)
- `compiler-core`, `target-cli-bundle`, `codegen-templates` (F2)
- `runtime-orchestrator` (R1, single-turn slice only)
- `model-adapter` (R2, Anthropic only)
- `spec-cli` (F4)

Next, in dependency order from PART G of the catalog: foundations (`infra-utils`, `error-types`, `logging`, `config-loader`, `state-store`, `feature-flags`), then real model layer + tool layer, then permission + compaction, then the harder targets.
