# Recipe 34 — Building Custom Graders

> **Status:** stub.

## What you'll learn

Author your own grader for the eval harness — pure-function or
LLM-as-judge — register it via the grader-registry, and either ship
it inline with your spec or distribute it as a discoverable plugin
under `~/.crewhaus/grader-plugins/`.

## Prerequisites

- [Recipe 12 — Eval Harness](12-eval-harness.md) for the eval-runner pipeline.

## Roadmap

1. The grader contract: `(sample, runResult) → { passed, score, rationale }`. Score is `[0, 1]`; passed is the gate.
2. Pure-function example — a regex-anchored grader for "answer must start with a digit."
3. LLM-as-judge example — load a YAML rubric, structure the judge call via Zod, defend against prompt injection in the sample's expected output.
4. Composers: `all([...])`, `any([...])`, `weighted([...])`. When each one is the right tool.
5. The grader-registry: `register("my_grader", myGraderFactory({threshold: 0.8}))`. Registered names show up in spec `graders:` lists.
6. Plugin discovery: `discoverPluginGraders(registry, pluginRoot)` walks `<root>/<plugin>/index.{ts,js,mjs}`, dynamically imports each, and registers `{name, grader}`.
7. Wiring against the production grader families — ROUGE/BLEU/METEOR, semantic similarity, safety classifiers, multimodal — for hybrid graders.
8. Testing: deterministic input → expected score; property tests for monotonicity.

## Run it now

```bash
bun test packages/grader-registry
bun test packages/eval-runner
```

## Pointers to existing material

- **Modules:** [`packages/eval-grader`](../../packages/eval-grader), [`packages/eval-judge`](../../packages/eval-judge), [`packages/grader-registry`](../../packages/grader-registry).
- **Production graders to study:** [`packages/grader-nlg-metrics`](../../packages/grader-nlg-metrics), [`packages/grader-semantic-similarity`](../../packages/grader-semantic-similarity), [`packages/grader-safety-classifiers`](../../packages/grader-safety-classifiers), [`packages/grader-multimodal`](../../packages/grader-multimodal).
- **Catalog:** §16, §29, §38.

## Where to go next

- To use a grader as a canary regression gate → [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- For prompt-optimization driven by your grader → §29 in [MODULE-CATALOG.md](../MODULE-CATALOG.md) (`prompt-optimizer`).
