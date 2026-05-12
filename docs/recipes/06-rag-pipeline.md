---
test:
  spec: examples/hello-rag/crewhaus.yaml
  bun_scripts:
    - compile:hello-rag
    - run:hello-rag
---

# Recipe 06 — RAG Pipeline

Build a retrieval-augmented agent that grounds every answer in an
indexed corpus. The pipeline target chunks your documents, embeds the
chunks, stores the vectors in a backend, and injects a `Retrieve` tool
that the agent calls before answering — so the model can cite specific
chunks by `[N]` and refuse questions outside the corpus.

You'd reach for `target: pipeline` when:

- The agent must answer **only** from a known set of documents.
- You want **citations** the user can click through.
- The corpus is too big (or too proprietary) to put in the system
  prompt.
- You want to swap the **embedder** or **vector store** without
  touching the agent prompt.

If you want fully autonomous, multi-step research over a goal (not a
fixed corpus), use [`research`](07-autonomous-research.md) instead.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.
- No external API keys needed for the example — `mock/det` and
  `in-memory` ship as defaults.

## The smallest spec

The bundled example [`examples/hello-rag/crewhaus.yaml`](../../examples/hello-rag/crewhaus.yaml)
is one agent and four inline documents:

```yaml
name: hello-rag
target: pipeline
agent:
  model: claude-sonnet-4-6
  instructions: |
    For every question, call Retrieve first. Answer in 2-3 sentences
    citing chunks by [N]. If retrieved chunks don't cover the question,
    say "I can only answer questions about the indexed docs."
retrieve:
  embedderModel: mock/det
  vectorBackend: in-memory
  defaultK: 4
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Retrieve
indexing:
  chunkStrategy: fixed
  chunkSize: 400
  chunkOverlap: 0
  documents:
    - id: target-shapes
      text: |
        CrewHaus Factory supports multiple target harness shapes:
        cli, workflow, channel, graph, managed, pipeline, eval,
        research, voice, browser, batch, crew.
    - id: section-19
      text: |
        Section 19 lands the GRPH target shape: checkpoint-store,
        graph-engine (HITL pauses), branch-history, durable-execution.
```

The shape:

- **`agent:`** is the chat-loop spec — same fields as a CLI's agent
  block, plus the `Retrieve` tool that's auto-injected.
- **`retrieve:`** picks the embedder + vector backend and sets the
  default `k` for retrieval.
- **`indexing:`** describes how to chunk and what to index. `documents:`
  can be inline (as here) or paths to files on disk.
- **`permissions:`** must allow `Retrieve` if you want it to call
  without prompting (which is almost always what you want in a RAG
  pipeline).

Run it:

```bash
bun run compile:hello-rag
bun run run:hello-rag
```

Type "What target shapes does crewhaus support?". The agent will call
`Retrieve("target shapes")`, get the top-4 chunks, and answer with
inline `[1]`-style citations. Ask "what's the capital of France?" and
it will refuse — that chunk isn't in the corpus.

## How indexing works

`indexing` runs **at compile time**, not at runtime. When `bun run
compile:hello-rag` executes:

1. Every document text is split via the `chunkStrategy`:
   - **`fixed`** — exact `chunkSize`-character windows with
     `chunkOverlap` overlap. Predictable, no language model required.
   - **`semantic`** — language-model-aware paragraph + sentence
     splitting. Slower; uses a small embed-only call.
   - **`markdown`** — split at heading boundaries (`#`, `##`). Best
     for docs corpora.
2. Each chunk is embedded with `embedderModel`. The vectors get baked
   into the compiled bundle next to the agent.
3. At **runtime** the vector store loads those vectors and serves
   `Retrieve` calls — no re-embedding, no model API calls for the
   corpus itself.

Re-running `compile:hello-rag` after editing `documents:` re-indexes.
For larger corpora prefer `documentsFromDir: ./corpus/` (loads every
`.md` and `.txt` recursively) or `documentsFromGlob: ['./docs/**/*.md']`.

## Embedder selection

`embedderModel` follows the same prefix grammar as `model:`:

| Prefix                                     | Backend                                  | When to use                                              |
| ------------------------------------------ | ---------------------------------------- | -------------------------------------------------------- |
| `mock/det`                                 | Deterministic 256-dim hash               | Tests / smokes. No API key needed.                       |
| `openai/text-embedding-3-small`            | OpenAI                                    | Default production choice; fast and cheap.               |
| `openai/text-embedding-3-large`            | OpenAI                                    | When recall matters more than cost.                      |
| `voyage/voyage-3`                          | Voyage AI                                | Strongest English embedding model as of writing.         |
| `cohere/embed-v3`                          | Cohere                                    | If you already use Cohere for other workloads.            |
| `local/<model>@http://localhost:11434/v1`  | Local Ollama/llama.cpp/etc.              | Air-gapped or cost-sensitive setups.                     |

The model-router lazy-loads each adapter, so a pipeline that uses
`voyage/voyage-3` doesn't pay the cost of loading the OpenAI client.

API keys come from `.env` (`OPENAI_API_KEY`, `VOYAGE_API_KEY`,
`COHERE_API_KEY`). For local backends no key is needed.

## Vector store backends

`vectorBackend` picks the runtime store:

| Backend       | Persistence                                | Scale ceiling                                |
| ------------- | ------------------------------------------ | -------------------------------------------- |
| `in-memory`   | None (rebuilt each compile)                | ~100K chunks; perfect for the docs-corpus case. |
| `lance`       | LanceDB on local disk                      | Millions of chunks, single-host.             |
| `qdrant`      | Remote Qdrant cluster                      | Multi-tenant, billions of vectors.           |
| `pinecone`    | Pinecone managed service                   | Multi-tenant, hosted.                        |
| `weaviate`    | Weaviate (self-hosted or cloud)            | Hybrid keyword + vector.                     |

Each backend reads its connection info from env vars
(`QDRANT_URL`, `PINECONE_API_KEY`, etc.). The `in-memory` backend is
the default because it has zero config; for anything beyond ~100K
chunks switch to `lance` or one of the hosted services.

## The `Retrieve` tool the model sees

```typescript
Retrieve({
  query: string,       // the natural-language question
  k?: number,          // overrides defaultK
  filter?: object      // chunk-metadata filter, backend-specific
}) → Array<{
  id: string,          // chunk id
  text: string,        // chunk content
  score: number,       // similarity score
  source: { docId, chunkIndex }
}>
```

The runtime serializes the result back to the model as JSON. By
convention you want the model to cite chunks by their **position in
the retrieval result** (`[1]`, `[2]`, ...), not the raw id — that way
the citation stays clickable in the trace UI.

The agent's system prompt is the only place that teaches "always cite"
behavior. The example's prompt is a working template:

```
For every question, call Retrieve first. Answer in 2-3 sentences
citing chunks by [N]. If retrieved chunks don't cover the question,
say "I can only answer questions about the indexed docs."
```

The two non-negotiables:

1. **"Call Retrieve first"** — so the model never answers from prior
   knowledge.
2. **"If chunks don't cover, refuse"** — so the model doesn't
   confabulate when retrieval returns weak matches.

## Tuning chunks

`chunkSize` and `chunkOverlap` are the two main knobs.

- **`chunkSize: 400`** is a reasonable default — small enough that
  retrieval is precise, large enough that the chunk carries useful
  context.
- **`chunkOverlap: 0`** is fine for `markdown` chunking (the heading
  boundary is already a natural break); for `fixed` strategy use
  `chunkOverlap: 50–100` so a query straddling a chunk boundary
  doesn't miss.
- **Empirically:** longer chunks (1000+) help when the chunks
  themselves contain self-contained explanations; shorter chunks
  (200) help when queries target specific facts.

Wire it to [Recipe 12 — Eval Harness](12-eval-harness.md) to A/B-test
chunk strategies — the eval target is the natural way to compare
retrieval-grounded accuracy across configurations.

## Loading docs from disk

For real corpora you don't want documents inline:

```yaml
indexing:
  chunkStrategy: markdown
  chunkSize: 800
  chunkOverlap: 0
  documentsFromGlob:
    - "./docs/**/*.md"
    - "./README.md"
```

Or:

```yaml
indexing:
  documentsFromDir: ./corpus/
```

Both resolve relative to the spec file's directory. The compiler reads
every match, infers a docId from the relative path, and chunks it.

## Filtering — metadata-aware retrieval

You can tag chunks with metadata and filter at retrieve-time:

```yaml
documents:
  - id: section-19
    metadata: { section: 19, status: shipped }
    text: |
      ...
  - id: section-22
    metadata: { section: 22, status: planned }
    text: |
      ...
```

Then in the agent's prompt:

```
When the user asks about a specific section, call
Retrieve({ query: ..., filter: { section: <n> } }).
```

The `in-memory` backend supports exact-match filters only; the hosted
backends support richer predicates per their own DSLs.

## Things that look like RAG but aren't

| Symptom                                                            | Wrong shape  | Right shape                                       |
| ------------------------------------------------------------------ | ------------ | ------------------------------------------------- |
| Autonomous goal decomposition over the corpus.                     | pipeline     | [research](07-autonomous-research.md)             |
| Real-time web search, not a fixed corpus.                          | pipeline     | [cli](01-cli-coding-agent.md) with `WebSearch`    |
| One-shot summarization of a single doc.                            | pipeline     | [workflow](02-sequential-workflow.md)             |
| Per-tenant corpora that must not cross-contaminate.                | pipeline     | [managed](11-managed-multitenant.md) + pipeline    |

Pipeline is the right answer when the **boundary of what the agent
knows** is the corpus you indexed. If the agent should also be able
to fall back to general knowledge, pair it with a CLI agent in front:
the CLI decides whether to invoke the pipeline as a sub-agent.

## Production knobs

- **Re-indexing.** Currently a full recompile. If your corpus changes
  often, run `crewhaus index` (a separate command) which only updates
  the vector store, leaving the codegen bundle untouched.
- **Embed-only call budget.** The semantic chunker is the only path
  that calls embedding APIs at compile time. Set
  `CREWHAUS_INDEX_BUDGET_USD=...` to fail loudly if compilation would
  exceed a budget.
- **Persistence.** `in-memory` rebuilds every restart. For zero-cold-start
  switch to `lance` and pin the path with `vectorBackendPath: ./vectors/`.

## What to read next

- **Test RAG accuracy.** [Recipe 12 — Eval Harness](12-eval-harness.md) —
  the eval target treats the pipeline as a black box.
- **Multi-step research over the same corpus.** [Recipe 07 — Autonomous Research](07-autonomous-research.md).
- **Per-tenant corpora.** [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- **Local embedders to avoid API costs.** [Recipe 32 — Local Models](32-local-models.md).

## Pointers to source

- **Example:** [`examples/hello-rag/crewhaus.yaml`](../../examples/hello-rag/crewhaus.yaml).
- **Codegen:** [`packages/target-pipeline`](../../packages/target-pipeline).
- **Engine:** [`packages/pipeline-engine`](../../packages/pipeline-engine).
- **Chunkers:** [`packages/chunker`](../../packages/chunker).
- **Embedder:** [`packages/embedder`](../../packages/embedder).
- **Vector store:** [`packages/vector-store`](../../packages/vector-store).
- **Retrieve tool:** [`packages/tool-retrieve`](../../packages/tool-retrieve).
- **Spec schema (pipeline variant):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts) (search `pipelineSchema`).
- **Module catalog reference:** §21, §30 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
