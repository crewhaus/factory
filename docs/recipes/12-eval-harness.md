---
test:
  spec: examples/hello-eval/crewhaus.yaml
  bun_scripts:
    - compile:hello-eval
    - smoke:section-29
  packages:
    - packages/eval-dataset
    - packages/eval-grader
    - packages/eval-runner
    - packages/eval-report
    - packages/dataset-registry
    - packages/grader-registry
    - packages/regression-runner
---

# Recipe 12 — Eval Harness

Run an agent against a labelled dataset, grade every sample with one
or more graders, and produce an HTML report you can drill into. This
is the foundation that canary gating and prompt optimization sit on,
and it's the first thing to set up if you're putting an agent in front
of users.

By the end of this recipe you'll have:

- A small JSONL dataset with a train/dev/test split.
- A graders config that mixes deterministic graders, NLG metrics, and
  LLM-as-judge.
- A `target: eval` spec that runs the agent against the dev split and
  writes a sortable HTML report.
- A diff between two eval runs that shows what flipped pass/fail.
- An understanding of where eval plugs into canary rollouts and
  prompt optimization.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) so you have a
  spec to grade.
- An Anthropic credential in `.env` if you want to run live eval
  rather than just compile the bundle.

## Step 1 — The smallest possible eval spec

The bundled example [`examples/hello-eval/crewhaus.yaml`](../../examples/hello-eval/crewhaus.yaml)
grades a math agent with one deterministic grader:

```yaml
name: hello-eval
target: eval
agent:
  model: claude-opus-4-7
  instructions: |
    Answer math questions with just the number.
dataset:
  name: hello-eval
  version: v1
  split: dev
graders:
  - name: exact_match
concurrency: 2
```

Five top-level fields:

| Field         | Purpose                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `agent`       | The agent under test. Same shape as a CLI agent block.                 |
| `dataset`     | Which dataset + version + split to evaluate against.                   |
| `graders`     | Array of grader names (registered globally). Each can take `opts:`.    |
| `concurrency` | How many samples to run in parallel. Default 4.                        |
| `seed`        | Optional integer seed for grader / sampling determinism.               |

Compile to see the generated bundle:

```bash
bun run compile:hello-eval
ls examples/hello-eval/dist/   # agent.ts
```

## Step 2 — Authoring a dataset

The runner reads from a `dataset-registry` keyed by `(name, version, split)`.
File-backed registries live under `.crewhaus/datasets/<name>/<version>.json`
by default.

A dataset file looks like:

```json
{
  "name": "hello-eval",
  "version": "v1",
  "splits": {
    "train": [
      { "id": "t1", "input": "What is 2+2?", "expected_output": "4" },
      { "id": "t2", "input": "What is 7*8?", "expected_output": "56" }
    ],
    "dev": [
      { "id": "d1", "input": "What is 10-3?", "expected_output": "7" },
      { "id": "d2", "input": "What is 15/3?", "expected_output": "5" }
    ],
    "test": [
      { "id": "x1", "input": "What is 17+25?", "expected_output": "42" }
    ]
  },
  "sampleHashes": {},
  "createdAt": "2026-05-09T00:00:00Z"
}
```

Three splits, one purpose each:

- **`train`** — for prompt-optimizer search, hyperparameter tuning,
  anything that touches the dataset to shape the agent.
- **`dev`** — for development-time grading. The default split for
  `target: eval`.
- **`test`** — for the final go/no-go decision. **The runtime refuses
  to load this split** unless the caller passes `{ allowTestSplit: true }`.
  This guard catches the most common eval-pipeline bug — accidentally
  training on the data you also evaluate on.

To register a dataset programmatically, see the section-29 smoke at
[`examples/section-29-smoke/smoke.ts`](../../examples/section-29-smoke/smoke.ts).

## Step 3 — Built-in graders

The `grader-registry` ships with three families of graders, registered
by name.

### Deterministic graders ([`packages/eval-grader`](../../packages/eval-grader))

| Name                   | Behavior                                                                          |
| ---------------------- | --------------------------------------------------------------------------------- |
| `exact_match`          | `agent_output.trim() === sample.expected_output.trim()`                           |
| `contains`             | `agent_output.includes(sample.expected_output)`                                   |
| `regex`                | `new RegExp(opts.pattern).test(agent_output)`                                     |
| `json_path`            | Extracts via JSONPath, compares against `opts.expected`.                          |
| `schema`               | Zod schema in `opts.schema` — pass if the output parses.                          |
| `tool_call_sequence`   | Matches the trace event sequence against `opts.expected: ["Read", "Edit", "Bash"]`.|

Composers:

| Name       | Behavior                                                              |
| ---------- | --------------------------------------------------------------------- |
| `all`      | `opts.graders` array all pass.                                        |
| `any`      | At least one of `opts.graders` passes.                                |
| `weighted` | Score is `sum(grader_i.score * opts.weights[i])`; passes ≥ threshold. |

### NLG metric graders ([`packages/grader-nlg-metrics`](../../packages/grader-nlg-metrics))

For natural-language outputs:

| Name                                   | Algorithm                                                |
| -------------------------------------- | -------------------------------------------------------- |
| `rouge1` / `rouge2` / `rouge_l`        | ROUGE F-measure (unigram / bigram / LCS).                |
| `bleu1` / `bleu2` / `bleu3` / `bleu4`  | BLEU with Chen & Cherry Method 1 smoothing.              |
| `meteor`                               | Greedy unigram alignment with chunk-fragmentation penalty.|

Each accepts `opts.threshold` (default 0.5) and an optional
`opts.reference` override (default: read from `sample.expected_output`).

### Semantic + safety + multimodal ([`packages/grader-semantic-similarity`](../../packages/grader-semantic-similarity), [`packages/grader-safety-classifiers`](../../packages/grader-safety-classifiers), [`packages/grader-multimodal`](../../packages/grader-multimodal))

| Name                  | Behavior                                                                       |
| --------------------- | ------------------------------------------------------------------------------ |
| `semantic_similarity` | Cosine similarity over embeddings. Falls back to ROUGE-L if embedder errors.   |
| `toxicity` / `bias`   | Caller-supplied `Classifier` (OpenAI moderation / Perspective / fastText).     |
| `pii_leak`            | 5 regex detectors (SSN, credit card, phone, email, IBAN) + optional classifier.|
| `image_similarity`    | aHash + Hamming distance for image outputs.                                    |
| `audio_transcript_match` | Wraps an STT call, routes the recognized text through any text grader.       |

### LLM-as-judge ([`packages/eval-judge`](../../packages/eval-judge))

For "is this answer good?" judgments that don't reduce to a regex.
Configured separately because it's slow and costs money:

```yaml
graders:
  - name: llm_judge
    opts:
      rubric_path: graders/answer-quality.yaml
      judge_model: claude-haiku-4-5-20251001
      threshold: 4
```

The rubric is a YAML file with named criteria + 1–5 anchors per level.
The judge prompt explicitly templates the sample's expected output as
**untrusted data** — a 13-payload prompt-injection corpus locks in the
defense.

## Step 4 — Running an eval

```bash
bun apps/cli/src/index.ts eval examples/hello-eval/crewhaus.yaml \
  --dataset .crewhaus/datasets/hello-eval/v1.json \
  --graders examples/hello-eval/graders.yaml \
  --concurrency 2 \
  --seed 42 \
  -o .crewhaus/evals/run-1
```

Per-sample artifacts land at
`.crewhaus/evals/run-1/<sampleId>/{transcript.jsonl, events.jsonl, grades.json}`.
A summary report writes to `.crewhaus/evals/run-1/report.html`.

The HTML report is a self-contained file with:

- A sortable per-sample table (passed/failed, score, latency, turn
  count, model).
- Click any row for a drilldown panel: full transcript on the left,
  trace timeline on the right (the same span layout Studio uses), and
  every grader's pass/fail + rationale at the bottom.
- Aggregates: pass rate, mean score, p50/p95 turn count + latency,
  total token cost (per-provider pricing table).

## Step 5 — Diff mode

The point of having a dev split is to compare runs. After making a
change to your agent, run a second eval:

```bash
bun apps/cli/src/index.ts eval examples/hello-eval/crewhaus.yaml \
  --dataset .crewhaus/datasets/hello-eval/v1.json \
  --graders examples/hello-eval/graders.yaml \
  -o .crewhaus/evals/run-2
```

Then diff:

```bash
bun apps/cli/src/index.ts eval-report diff \
  .crewhaus/evals/run-1 .crewhaus/evals/run-2 \
  -o .crewhaus/evals/diff-1-vs-2
```

The diff report calls out:

- **Regressions** — samples that passed in run-1, fail in run-2.
- **Recoveries** — samples that failed in run-1, pass in run-2.
- **Score shifts** — passing/passing pairs where the score moved by
  more than `--score-shift-threshold` (default 0.1).
- **Latency drift** — p50/p95 changes per sample beyond
  `--latency-threshold` (default 100 ms).

This is what canary controllers use as their go/no-go signal — see
[Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).

## Step 6 — Custom graders

A grader is a function `(sample, runResult) → { passed, score, rationale }`.
Register one for use by name:

```ts
// .crewhaus/grader-plugins/my-grader/index.ts
import type { Grader } from "@crewhaus/eval-grader";

export default {
  name: "starts_with_number",
  grader: (sample, result) => {
    const passed = /^\d/.test(result.agentOutput);
    return {
      passed,
      score: passed ? 1 : 0,
      rationale: passed ? "starts with digit" : "does not start with digit",
    };
  } satisfies Grader,
};
```

`discoverPluginGraders(registry, pluginRoot)` walks `<root>/<plugin>/index.{ts,js,mjs}`
and registers each. Then in your graders config:

```yaml
graders:
  - name: starts_with_number
```

See [Recipe 34 — Building Custom Graders](34-building-custom-graders.md)
for the full walkthrough including LLM-as-judge custom rubrics.

## Step 7 — Wiring eval into canary rollouts

The `regression-runner` package converts two eval runs into a verdict
the `canary-controller` consumes:

```ts
import { gate, regress } from "@crewhaus/regression-runner";
import { loadRun } from "@crewhaus/eval-report";

const prev = await loadRun(".crewhaus/evals/run-1");
const next = await loadRun(".crewhaus/evals/run-2");
const verdict = gate(prev, next, {
  regressionThreshold: 0.02,    // ≤2% pass-rate drop allowed
  latencyThreshold: 500,        // ≤500ms p95 drift allowed
  scoreShiftEpsilon: 0.1,
});
// verdict: { verdict: "pass" | "fail", reason?, report: regress(prev, next, ...) }
```

In a canary rollout:

- `verdict: "pass"` → promote the new spec version for the env.
- `verdict: "fail"` → re-pin the env back to the prior version and
  log the regression reason to the audit log.

See [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).

## Step 8 — Prompt optimization

DSPy-style search over candidate prompt mutations, driven by your
eval. Lives in [`packages/prompt-optimizer`](../../packages/prompt-optimizer).

```ts
import { optimize } from "@crewhaus/prompt-optimizer";

const result = await optimize(basePrompt, {
  trainSet: trainSplit,
  devSet: devSplit,
  fitness: (prompt) => evaluateOnDev(prompt),  // your eval-runner call
  iterations: 50,
  seed: 42,
  // mutations: defaults cover rephrase-instruction, add-few-shot, swap-example, add-COT-prefix
});
console.log("best prompt:", result.bestPrompt);
console.log("best fitness:", result.bestFitness);
```

The optimizer is **deterministic given the same seed** — same input,
same trajectory. Trajectories persist to
`.crewhaus/prompt-optimizer/<runId>/` so you can resume an
interrupted run.

The split-leak guard from Step 2 is your safety net here: the
optimizer can't accidentally read the test split because the registry
refuses unless you opt in.

## Common pitfalls

| Symptom                                                              | Fix                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Grader passes locally, fails in CI                                   | Set `seed:` in the spec for grader determinism; verify the model and provider are pinned. |
| LLM-as-judge scores are wildly inconsistent across runs              | Lower temperature on the judge model; pin the judge model id (not just "claude-...");  add more anchor examples to the rubric. |
| Eval seems to be reading the test split                              | The split-leak guard throws if anyone tries. Search your callers for `allowTestSplit: true` — that's the only way past it. |
| Per-sample HTML report shows no transcript                           | The runner writes `transcript.jsonl` per sample; check your `-o` path is writable and didn't fall back to a tmpdir. |
| Concurrency = 32 but only 4 samples run at once                      | Provider rate limits. Check [`packages/rate-limiter`](../../packages/rate-limiter) buckets; for Anthropic, raise the per-provider concurrency. |

## What to read next

- **Custom graders, deeper.** [Recipe 34 — Building Custom Graders](34-building-custom-graders.md).
- **Canary rollouts using the diff.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- **Observability inside a single eval run.** [Recipe 17 — Observability](17-observability.md) — the per-sample transcript is a full trace event log.
- **Multi-provider eval.** Run the same dataset against `claude-sonnet-4-6`, `openai/gpt-4o`, and `gemini/2.0-flash` by changing one line in the spec; see [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md) for adapter mechanics.

## Pointers to source

- **Example:** [`examples/hello-eval/crewhaus.yaml`](../../examples/hello-eval/crewhaus.yaml).
- **Codegen:** [`packages/target-eval-bundle`](../../packages/target-eval-bundle).
- **Modules:** [`packages/eval-dataset`](../../packages/eval-dataset), [`packages/eval-grader`](../../packages/eval-grader), [`packages/eval-judge`](../../packages/eval-judge), [`packages/eval-runner`](../../packages/eval-runner), [`packages/eval-report`](../../packages/eval-report).
- **Production graders:** [`packages/grader-nlg-metrics`](../../packages/grader-nlg-metrics), [`packages/grader-semantic-similarity`](../../packages/grader-semantic-similarity), [`packages/grader-safety-classifiers`](../../packages/grader-safety-classifiers), [`packages/grader-multimodal`](../../packages/grader-multimodal).
- **Optimizer:** [`packages/prompt-optimizer`](../../packages/prompt-optimizer).
- **Regression gate:** [`packages/regression-runner`](../../packages/regression-runner).
- **End-to-end smoke:** [`examples/section-29-smoke/smoke.ts`](../../examples/section-29-smoke/smoke.ts).
- **Module catalog reference:** §16, §29, §38 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
