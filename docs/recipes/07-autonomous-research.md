---
test:
  spec: examples/hello-research/crewhaus.yaml
  bun_scripts:
    - compile:hello-research
    - run:hello-research
---

# Recipe 07 — Autonomous Research

Hand the agent a high-level goal and let it decompose it into
sub-questions, fetch sources, cite verbatim snippets, and assemble a
markdown report. Progress checkpoints to disk after every sub-question,
so a kill-and-resume yields byte-identical citation blocks for the
work that already completed.

You'd reach for `target: research` when:

- You have a **goal**, not a fixed query — "what target shapes does
  crewhaus support and what's the status of each?".
- You want **traced citations** — every claim ties back to a fetched
  URI and a verbatim snippet.
- You want **bounded autonomy** — a wall-clock budget plus a
  branching factor cap. The runtime stops when either is hit.
- You want **resumability** so an 8-minute run that crashes at minute
  7 doesn't redo the first 5 minutes.

If your corpus is fixed (and pre-known), use [`pipeline`](06-rag-pipeline.md)
instead. If you have many independent prompts to run, use
[`batch`](08-batch-worker.md).

<details>
<summary><strong>Architectural context</strong> — long-running autonomous sessions, compaction, and citation discipline</summary>

The `research` target is the harness's answer to the **long-running
autonomous session** pattern that Anthropic's Managed Agents,
OpenAI's background-mode runs, and AWS AgentCore all converge on
([docs/AI-Harness-Systems.md](../AI-Harness-Systems.md)): a session
with persistent event history, durable checkpoints, compaction for
long histories, and structured artifact output. Three primitives map
to specific architectural lessons:

- **Wall-clock + branching-factor caps** are the harness equivalent
  of Anthropic's session-runtime billing surface ($0.08/session-hour
  in `running` state in their public pricing): autonomy without a cost
  ceiling is an outage waiting to happen, so the runtime enforces both
  a time budget and a fan-out cap.
- **Sub-question-level checkpoints** mirror MAF's checkpoint/time-travel
  pattern. A crash at minute 7 resumes the unfinished sub-question
  from its last completed step, not the whole research goal — the same
  reason LangGraph exposes `sync` durability.
- **Verbatim snippet citations** are the per-output analogue of the
  Pillar 3 "compaction summaries are classified content" rule
  ([CLAUDE.md](../../CLAUDE.md)). The runtime never asks the model to
  paraphrase a source it just fetched; it stores the snippet verbatim
  and lets the report reference it by `[N]`. This makes both audit
  and grading tractable: every claim has a substring you can grep for
  in the fetched corpus.

If you want fully unbounded autonomy with no caps, you've left the
harness's safety envelope — that's not a research target, that's an
unsupervised production incident.

</details>

## Prerequisites

- [Recipe 06 — RAG Pipeline](06-rag-pipeline.md) for the retrieval
  primitives this target builds on.
- A working Anthropic credential.

## The smallest spec

The bundled example [`examples/hello-research/crewhaus.yaml`](../../examples/hello-research/crewhaus.yaml):

```yaml
name: hello-research
target: research
agent:
  model: claude-haiku-4-5-20251001
  instructions: |
    You are an autonomous research agent. You research one sub-question
    at a time using a small set of local source documents.
    Workflow for EVERY sub-question:
      1. Load each available file:// source via Source(uri).
      2. Pick AT MOST 2 short verbatim snippets across all sources.
      3. Call CiteFact(uri, snippet, supportingClaim?) once per snippet.
      4. End your turn with a SINGLE 2-3 sentence answer.
goal: |
  What target shapes does the CrewHaus Factory codebase support?
  List them, group by status (shipped vs. planned), and describe
  each shape's runtime spine in one sentence.
branchingFactor: 3
maxDurationMs: 240000
retrieve:
  allowedFileRoots:
    - examples/hello-research/sources
permissions:
  mode: default
```

The shape:

- **`agent:`** — same chat-loop spec as CLI, but the system prompt
  must teach the `Source` + `CiteFact` discipline.
- **`goal:`** — the high-level question. The runtime feeds this to
  the planner, which decomposes it into sub-questions.
- **`branchingFactor:`** — how many sub-questions to spawn in parallel.
  3 is a reasonable default; 1 makes the run sequential; >5 burns
  budget fast.
- **`maxDurationMs:`** — wall-clock budget across the entire run.
  When hit, in-flight sub-questions finish their current turn and the
  report-writer produces the best report it can from what's done.
- **`retrieve.allowedFileRoots:`** — directories of source documents
  the agent can read via `Source(file://...)`. For web research, use
  `retrieve.allowedOrigins: ["https://docs.example.com"]` instead.

Run it:

```bash
bun run compile:hello-research
bun run run:hello-research
```

You'll see the planner spawn 3 sub-questions, each fetch its sources,
each emit citations, and finally a `report.md` + `report.json` write
into `.crewhaus/research/<runId>/`.

## The two auto-injected tools

| Tool                                            | Behavior                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `Source(uri)`                                   | Fetches the URI and returns its content. Cached per run.          |
| `CiteFact(uri, snippet, supportingClaim?)`      | Records a verbatim snippet for the citation tracker.              |

`Source(uri)`:

- For `file://...` URIs, reads the file. Must be under
  `retrieve.allowedFileRoots` — otherwise the tool returns an error.
- For `https://...` URIs, fetches with redirect cap 5 and body cap 2MB.
  Origin must match `retrieve.allowedOrigins`. The HTML is converted
  to markdown before returning.
- Cached: a second `Source(uri)` for the same uri returns the cached
  content. The cache is per-`runId` and persisted, so resumes don't
  re-fetch.

`CiteFact(uri, snippet, supportingClaim?)`:

- The snippet must be **verbatim** from the corresponding `Source(uri)`
  body — the runtime validates this (string contains check).
- Each citation gets a stable numeric id assigned in declaration order.
  The id appears in `report.md` as `[N]`.
- A repeat `CiteFact` with the same `(uri, snippet)` is deduped to a
  single citation entry. This is why resumes produce byte-identical
  citations for completed sub-questions.

## The planner — how goal becomes sub-questions

The planner is one model call at the start of the run. The model
sees the goal and returns a JSON array of sub-question strings:

```json
[
  "What target shapes are currently shipped in the codebase?",
  "What target shapes are planned but not yet shipped?",
  "What does the runtime spine look like for each shape?"
]
```

Number of sub-questions = `branchingFactor`. The planner is the only
place the model gets to be creative about decomposition; everything
downstream is a per-sub-question chat loop with the auto-injected
tools.

To swap planner strategies (e.g. an LLM-free deterministic planner
for testing), pass `--planner deterministic` on the CLI — that
splits the goal into `branchingFactor` shards by punctuation and
hands them to the runtime literally.

## Resume

The runtime writes a `state.json` after each sub-question completes:

```bash
ls -t .crewhaus/research/run_*/state.json | head -1
```

Each `state.json` carries:

- The goal, branching factor, and per-sub-question completion status.
- The full citation table (uri, snippet, citation id).
- The `Source(uri)` cache (so the resume doesn't re-fetch).

Resume with:

```bash
bun run run:hello-research -- --resume run_<id>
```

The runtime walks `state.json`, skips completed sub-questions, and
re-runs the remaining ones with the existing citation ids preserved.
The final `report.md` is byte-identical to a never-crashed run for
the completed prefix.

## What the run produces

`.crewhaus/research/run_<id>/`:

| File          | Content                                                              |
| ------------- | -------------------------------------------------------------------- |
| `state.json`  | Resumable run state (citation table, sub-question status, cache).    |
| `report.md`   | Final markdown report — goal restated, per-sub-question section, citation block. |
| `report.json` | JSON mirror of the report. Each section carries `cited: [n, m, ...]`. |
| `sources/`    | Cached HTML/markdown bodies (one file per fetched URI).              |

The markdown is intentionally clean — no boilerplate, no preamble.
Pipe it to a webhook for human review, attach to a Slack message, or
upload to a documentation system.

## Web research vs file:// research

The example uses `file://` because it's the cheapest test fixture.
For real web research:

```yaml
retrieve:
  allowedOrigins:
    - https://docs.crewhaus.dev
    - https://github.com/crewhaus
  maxBodyBytes: 2_000_000
  redirectCap: 5
```

The crawler:

- Verifies the URL matches `allowedOrigins` before fetching.
- Caps body at `maxBodyBytes` (default 2MB) — anything longer is
  truncated and a `truncated: true` flag is set on the source.
- Caps redirects at `redirectCap` (default 5).
- Strips cookies and auth headers — research runs are anonymous to
  prevent accidental credential leak.

For private endpoints, use a corporate proxy in front and add the
proxy URL via `CREWHAUS_FETCH_PROXY=...`.

## Branching factor — what to set

- **`branchingFactor: 1`** — sequential, debuggable. Use during
  prompt iteration.
- **`branchingFactor: 3`** — the example default. Good signal-to-cost
  for typical research goals.
- **`branchingFactor: 5–7`** — for goals with genuinely independent
  sub-questions. Worth the spend if the goal has clear orthogonal
  axes.
- **`branchingFactor: >10`** — almost always wrong. The planner
  starts inventing similar sub-questions to fill the slot. Better to
  decompose the goal yourself and run multiple `branchingFactor: 3`
  runs in batch.

## Things that look like research but aren't

| Symptom                                              | Wrong shape | Right shape                                  |
| ---------------------------------------------------- | ----------- | -------------------------------------------- |
| A fixed list of docs, no goal decomposition.         | research    | [pipeline](06-rag-pipeline.md)               |
| Many independent prompts to process.                 | research    | [batch](08-batch-worker.md)                  |
| One reasoning chain with HITL approval.              | research    | [graph](05-stateful-graph.md)                |
| Multi-role human-vs-AI debate over a topic.          | research    | [crew](04-multi-agent-crew.md) with roles    |

Research is the right shape when the work splits naturally into
**parallel, independent investigations** that all serve **one
overarching question** — and you want the citation discipline.

## Production knobs

- **Citation cache.** `CREWHAUS_RESEARCH_CACHE=/path/to/cache` shares
  the source cache across runs — useful when multiple research goals
  hit the same web pages.
- **Strict-cite mode.** `--strict-cite` causes the runtime to fail
  the run if the model produces a final answer with no `CiteFact`
  calls. Use to enforce the citation discipline.
- **Eval the citations.** The eval target has a `citation_accuracy`
  grader (catalog §38) that verifies every cited snippet is actually
  present in the cited source.

## What to read next

- **Test citation accuracy.** [Recipe 12 — Eval Harness](12-eval-harness.md)
  pairs naturally — graders that check the citation block.
- **Many goals, not one.** [Recipe 08 — Batch Worker](08-batch-worker.md)
  for fan-out research.
- **State across nodes with HITL.** [Recipe 05 — Stateful Graph](05-stateful-graph.md)
  if you want approval before each sub-question fetches sources.

## Pointers to source

- **Example:** [`examples/hello-research/crewhaus.yaml`](../../examples/hello-research/crewhaus.yaml).
- **Codegen:** [`packages/target-research-bundle`](../../packages/target-research-bundle).
- **Planner:** [`packages/planner`](../../packages/planner).
- **Crawler (Source + CiteFact):** [`packages/crawler`](../../packages/crawler).
- **Citation tracker:** [`packages/citation-tracker`](../../packages/citation-tracker).
- **Report writer:** [`packages/report-writer`](../../packages/report-writer).
- **Spec schema (research variant):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts) (search `researchSchema`).
- **Module catalog reference:** §23 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
