# Recipe 07 — Autonomous Research

> **Status:** stub.

## What you'll learn

Run a long-horizon research agent: hand it a goal, it decomposes into
sub-questions, fetches sources, cites verbatim snippets, and assembles
a markdown report. Progress checkpoints to disk so a kill-and-resume
picks up where it left off — same goal yields byte-identical citation
blocks.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The `target: research` shape — `goal`, `branchingFactor`, `maxDurationMs`, `retrieve.allowedFileRoots` / `allowedOrigins`.
2. The planner: how `decompose(goal)` produces sub-questions in a deterministic JSON shape.
3. The auto-injected `Source(uri)` and `CiteFact(uri, snippet, supportingClaim?)` tools.
4. Citation tracker: file-backed JSONL ensures every URL is fetched at most once and citations are append-stable.
5. Per-branch budgeting: `maxDurationMs` is hard, branch count is `branchingFactor`.
6. Resume: `--resume <runId>` re-reads `state.json` and continues at the next sub-question.
7. The output: numbered citation block + per-sub-question markdown + JSON mirror.
8. Web sources vs file:// sources — origin allow-lists, redirect caps, body caps.

## Run it now

```bash
bun run compile:hello-research
bun run run:hello-research
```

## Pointers to existing material

- **Example:** [`examples/hello-research/crewhaus.yaml`](../../examples/hello-research/crewhaus.yaml) — researches what target shapes the factory supports, against local sources.
- **Codegen:** [`packages/target-research-bundle`](../../packages/target-research-bundle).
- **Modules:** [`packages/planner`](../../packages/planner), [`packages/crawler`](../../packages/crawler), [`packages/citation-tracker`](../../packages/citation-tracker), [`packages/report-writer`](../../packages/report-writer).
- **Catalog:** §23 (RES).

## Where to go next

- For a queue of independent jobs instead of one long goal → [Recipe 08 — Batch Worker](08-batch-worker.md).
- For graders that score citation accuracy → [Recipe 12 — Eval Harness](12-eval-harness.md).
- For RAG-style retrieval against an indexed corpus → [Recipe 06 — RAG Pipeline](06-rag-pipeline.md).
