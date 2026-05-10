# Recipe 06 — RAG Pipeline

> **Status:** stub.

## What you'll learn

Stand up a RAG agent: chunk and index a small document corpus, embed
the chunks, and let the agent answer questions by calling a `Retrieve`
tool that does vector search and returns top-k snippets with citation
numbers it must cite by `[N]`.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The `target: pipeline` shape — `agent`, `retrieve`, `indexing`, optional `permissions`.
2. Indexing config: `chunkStrategy: fixed | semantic | markdown`, `chunkSize`, `chunkOverlap`, `documents: [{ id, text }]`.
3. Embedder selection: `mock/det` for tests, `openai/text-embedding-3-small`, Voyage, Cohere, `local/<model>@<url>`.
4. Vector store backends: `in-memory` (default), Lance, Qdrant, Pinecone, Weaviate.
5. The `Retrieve(query, k?, filter?)` tool — what the model sees and how to instruct it to cite.
6. Telling the model when to refuse to answer — "if retrieved chunks don't cover the question, say so."
7. Loading documents from disk vs inline; how to swap to a real document set.
8. Tuning chunk size + overlap; comparing strategies with the eval harness.

## Run it now

```bash
bun run compile:hello-rag
bun run run:hello-rag
```

## Pointers to existing material

- **Example:** [`examples/hello-rag/crewhaus.yaml`](../../examples/hello-rag/crewhaus.yaml) — 4 inline documents about target shapes.
- **Codegen:** [`packages/target-pipeline`](../../packages/target-pipeline).
- **Modules:** [`packages/pipeline-engine`](../../packages/pipeline-engine), [`packages/chunker`](../../packages/chunker), [`packages/embedder`](../../packages/embedder), [`packages/vector-store`](../../packages/vector-store), [`packages/tool-retrieve`](../../packages/tool-retrieve).
- **Catalog:** §21, §30 (production embedder + vector backends).

## Where to go next

- For autonomous goal decomposition over a corpus → [Recipe 07 — Autonomous Research](07-autonomous-research.md).
- To grade retrieval quality → [Recipe 12 — Eval Harness](12-eval-harness.md).
- For production vector backends → [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md) (similar lazy-load pattern).
