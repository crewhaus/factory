# Recipe 12 — Eval Harness

> **Status:** stub.

## What you'll learn

Run an agent against a labelled dataset, score every sample with one
or more graders, and produce an HTML report that drills down into
per-sample transcripts and trace timelines. Plus diff mode: highlight
what flipped pass/fail between two runs — the foundation of canary
gating and prompt optimization.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) so you have a base agent to grade.

## Roadmap

1. The `target: eval` spec — `agent`, `dataset: { name, version, split }`, `graders`, `concurrency`, `seed`.
2. Dataset loaders: JSONL, CSV, YAML, HTTP-fetched. Lazy iterator API for 100k-sample sets.
3. The split-leak guard: reading the `test` split throws unless `allowTestSplit: true` (so prompt optimization can't train on test).
4. Built-in graders: `exact_match`, `contains`, `regex`, `json_path`, `schema` (Zod), `tool_call_sequence`. Composers: `all`, `any`, `weighted`.
5. NLG metrics: ROUGE-1/2/L, BLEU-1..4, METEOR. Semantic similarity via embeddings. Safety classifiers (toxicity / bias / PII leak). Multimodal (image / OCR / audio transcript).
6. LLM-as-judge with a YAML rubric and prompt-injection defenses around the sample's expected output.
7. The HTML report: sortable per-sample table, click-through to transcript + trace timeline + grader rationales.
8. `crewhaus eval-report diff <prevRun> <newRun>` — what flipped.
9. Wiring eval into a canary controller as the regression gate.
10. Prompt optimization: DSPy-style search over candidate prompt mutations, fitness driven by your eval.

## Run it now

```bash
bun run compile:hello-eval
# Smoke that exercises the full eval pipeline:
bun run smoke:section-29
```

## Pointers to existing material

- **Example:** [`examples/hello-eval/crewhaus.yaml`](../../examples/hello-eval/crewhaus.yaml) — math questions, exact-match grader.
- **Codegen:** [`packages/target-eval-bundle`](../../packages/target-eval-bundle).
- **Modules:** [`packages/eval-dataset`](../../packages/eval-dataset), [`packages/eval-grader`](../../packages/eval-grader), [`packages/eval-judge`](../../packages/eval-judge), [`packages/eval-runner`](../../packages/eval-runner), [`packages/eval-report`](../../packages/eval-report), [`packages/dataset-registry`](../../packages/dataset-registry), [`packages/grader-registry`](../../packages/grader-registry), [`packages/regression-runner`](../../packages/regression-runner), [`packages/prompt-optimizer`](../../packages/prompt-optimizer).
- **Production graders:** [`packages/grader-nlg-metrics`](../../packages/grader-nlg-metrics), [`packages/grader-semantic-similarity`](../../packages/grader-semantic-similarity), [`packages/grader-safety-classifiers`](../../packages/grader-safety-classifiers), [`packages/grader-multimodal`](../../packages/grader-multimodal).
- **Catalog:** §16, §29, §38.

## Where to go next

- For custom domain graders → [Recipe 34 — Building Custom Graders](34-building-custom-graders.md).
- For canary-gated rollouts using eval → [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- For the JSON Lines event log behind an eval run → [Recipe 17 — Observability](17-observability.md).
