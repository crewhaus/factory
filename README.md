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

## Design choices

- **TypeScript + Bun** primary runtime. Python is reserved for slots where the ecosystem genuinely outclasses TS — DSPy-style prompt optimization, and the eval/dataset stack (Ragas, HELM, lm-evaluation-harness).
- **Spec → IR → target codegen** pipeline (per [`docs/AI-Harness-Systems.md`](docs/AI-Harness-Systems.md) §reference architecture). The IR is runtime-agnostic; backends are swappable.
- **Generated bundles are runtime-thin**: they import `@crewhaus/runtime-core` rather than embedding everything. The eventual `bundle-packager` module can inline for distribution.
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
