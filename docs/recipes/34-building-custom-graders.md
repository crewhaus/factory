# Recipe 34 — Building Custom Graders

Author your own grader for the eval harness — pure-function or
LLM-as-judge — register it via the grader-registry, and either ship
it inline with your spec or distribute it as a discoverable plugin
under `~/.crewhaus/grader-plugins/`.

You'd build a custom grader when:

- The bundled graders (`exact_match`, `contains`, `regex`, etc.)
  don't capture what you care about.
- You're scoring something **domain-specific** (correct SQL syntax,
  valid OpenAPI spec, well-formed markdown).
- You need **LLM-as-judge** for fuzzy quality (helpfulness, tone,
  faithfulness to source).

For simple shape checks (string match, JSON schema), the bundled
graders are enough.

## Prerequisites

- [Recipe 12 — Eval Harness](12-eval-harness.md) for the eval-runner
  pipeline.

## The grader contract

```typescript
interface Grader {
  name: string;
  evaluate(
    sample: DatasetSample,
    runResult: RunResult
  ): Promise<GraderVerdict>;
}

interface GraderVerdict {
  passed: boolean;       // the gate
  score: number;         // [0, 1]
  rationale: string;     // human-readable
  details?: Record<string, unknown>;
}
```

`passed` is the binary outcome — does this sample pass the test?
`score` is the continuous version (`0` = total failure, `1` = perfect).
`rationale` is a short explanation that lands in the HTML report.

## Example 1 — Pure-function grader

A grader that asserts the answer starts with a digit:

```typescript
import type { Grader } from "@crewhaus/eval-grader";

export const startsWithDigit: Grader = {
  name: "starts_with_digit",
  async evaluate(_sample, runResult) {
    const out = runResult.finalText.trim();
    const passed = /^\d/.test(out);
    return {
      passed,
      score: passed ? 1.0 : 0.0,
      rationale: passed
        ? "Output starts with a digit."
        : `Output starts with '${out.slice(0, 1)}' instead of a digit.`
    };
  }
};
```

Register:

```typescript
import { register } from "@crewhaus/grader-registry";
register("starts_with_digit", startsWithDigit);
```

Use in a spec:

```yaml
graders:
  - name: starts_with_digit
```

That's the entire authoring loop. Pure-function graders are
deterministic, fast, free — pick them whenever possible.

## Example 2 — LLM-as-judge

For fuzzy quality questions (faithfulness, tone), you need a model
in the loop. The eval-judge package gives you a structured rubric:

```typescript
import { llmJudge } from "@crewhaus/eval-judge";
import { z } from "zod";

export const factuallyAccurate = llmJudge({
  name: "factually_accurate",
  rubric: `
    Read the agent's answer and the expected answer. Score the agent's
    answer on factual accuracy:
      1.0 = every claim is supported by the expected answer.
      0.5 = some claims supported, some not.
      0.0 = no overlap with expected answer.
  `,
  judgeModel: "claude-haiku-4-5-20251001",
  responseSchema: z.object({
    score: z.number().min(0).max(1),
    rationale: z.string(),
    passed: z.boolean()
  })
});
```

The judge:

- Loads the rubric.
- Constructs a judge call with the sample's expected output + the
  run's actual output.
- Calls `judgeModel` with `responseSchema` to extract structured
  output.
- Returns the parsed `GraderVerdict`.

### Defending against injection

The sample's expected output is **untrusted-ish** — it's data, not
instructions, but a maliciously-crafted "expected" string could try
to manipulate the judge. The eval-judge wraps both fields with a
sentinel:

```
<<<EXPECTED_BEGIN>>>
{expectedText}
<<<EXPECTED_END>>>

<<<ACTUAL_BEGIN>>>
{actualText}
<<<ACTUAL_END>>>
```

The rubric explicitly tells the judge to score only the **content
between sentinels** and ignore any instructions inside them. The
sentinel pattern is borrowed from [`packages/boundary-classifier`](../../packages/boundary-classifier)'s
defense-in-depth.

## Composers

Multiple graders compose:

```typescript
import { all, any, weighted } from "@crewhaus/eval-grader";

const composed = all([
  startsWithDigit,
  underWordLimit({ max: 20 }),
  factuallyAccurate
]);
```

| Composer    | Behavior                                                          |
| ----------- | ----------------------------------------------------------------- |
| `all([...])`   | `passed` if all pass; `score` is the min.                          |
| `any([...])`   | `passed` if any passes; `score` is the max.                         |
| `weighted([{grader, weight}], threshold)` | `score` is weighted average; `passed` is `score >= threshold`. |

When to use each:

- **`all`** — every check is a hard requirement. Tightest gate.
- **`any`** — at least one path works. For "either string match OR
  semantic match" type checks.
- **`weighted`** — soft scoring with priorities. The right tool for
  "faithfulness is 60% of the score; safety is 30%; brevity is 10%."

## The grader registry

[`packages/grader-registry`](../../packages/grader-registry):

```typescript
import { register, lookup, list } from "@crewhaus/grader-registry";

register("my_grader", myGraderFactory({ threshold: 0.8 }));

const g = lookup("my_grader");
console.log(list());   // ["exact_match", "contains", ..., "my_grader"]
```

Registered names appear in spec `graders:` lists:

```yaml
graders:
  - name: my_grader
    threshold: 0.8         # passed to the factory
```

The registry is **per-process** — registrations don't persist.
Wiring happens at runtime startup (a plugin discovery pass, or a
direct `register()` call in your codebase).

## Plugin discovery

For shared graders across multiple specs, put them in
`~/.crewhaus/grader-plugins/<plugin-name>/`:

```
~/.crewhaus/grader-plugins/
  my-team-graders/
    index.ts
    package.json
```

`index.ts` exports `{ name, grader }` per grader:

```typescript
export default [
  { name: "team_specific_grader_1", grader: ... },
  { name: "team_specific_grader_2", grader: ... }
];
```

`discoverPluginGraders(registry, "~/.crewhaus/grader-plugins")` walks
the root, dynamically imports each plugin's `index.{ts,js,mjs}`,
and registers each entry.

The discovery runs at eval-runner startup. So plugins are picked up
automatically by every eval run, with no per-spec wiring.

## Wiring against production grader families

For hybrid graders, compose your custom check with bundled ones:

```typescript
import { all } from "@crewhaus/eval-grader";
import { rougeL } from "@crewhaus/grader-nlg-metrics";
import { semanticSimilarity } from "@crewhaus/grader-semantic-similarity";
import { safetyClassifier } from "@crewhaus/grader-safety-classifiers";

const productionGrader = all([
  rougeL({ threshold: 0.6 }),
  semanticSimilarity({ embedderModel: "openai/text-embedding-3-small", threshold: 0.85 }),
  safetyClassifier(),
  myCustomBusinessLogicGrader
]);
register("production", productionGrader);
```

The four bundled grader families ([`packages/grader-nlg-metrics`](../../packages/grader-nlg-metrics),
[`grader-semantic-similarity`](../../packages/grader-semantic-similarity),
[`grader-safety-classifiers`](../../packages/grader-safety-classifiers),
[`grader-multimodal`](../../packages/grader-multimodal)) cover the
standard checks; your custom grader fills in the domain-specific
piece.

## Testing graders

Two test styles:

### 1. Fixture-based — deterministic

```typescript
test("starts_with_digit passes 'fix' → '5 things'", async () => {
  const verdict = await startsWithDigit.evaluate(
    { input: "Tell me numbers", expected: "5 things" },
    { finalText: "5 things to remember" }
  );
  expect(verdict.passed).toBe(true);
  expect(verdict.score).toBe(1);
});

test("starts_with_digit fails 'fix' → 'five'", async () => {
  const verdict = await startsWithDigit.evaluate(
    { input: "Tell me numbers", expected: "5 things" },
    { finalText: "five things to remember" }
  );
  expect(verdict.passed).toBe(false);
});
```

### 2. Property-based — invariants

```typescript
test("score is monotonic in input length", async () => {
  for (let len = 10; len < 100; len++) {
    const text = generateText(len);
    const v1 = await myGrader.evaluate(sample, { finalText: text });
    const v2 = await myGrader.evaluate(sample, { finalText: text + " more" });
    expect(v2.score).toBeGreaterThanOrEqual(v1.score - 0.01);  // allow small wobble
  }
});
```

Useful for graders that should "stay consistent" — small input changes
shouldn't cause large score swings.

## Using a grader as a canary gate

The regression runner ([Recipe 21](21-deployment-and-canary.md))
uses graders as the auto-rollback signal:

```bash
crewhaus regression-gate agent-name \
  --prev v2 \
  --next v3 \
  --thresholds 'passRate>=0.95,scoreDelta>=-0.02'
```

Reads the eval-runner's per-version results, computes the deltas,
and gates on the thresholds. A grader that returns useful score
gradients (not just 0/1) is much more useful here than a binary
gate — it lets the canary detect quality regression before it becomes
a pass-rate regression.

## Driving prompt optimization

The prompt-optimizer ([Recipe 42](42-active-optimization.md)) uses
the grader as the **fitness function** for spec patches:

```bash
crewhaus optimize my-spec.yaml --grader production
```

The optimizer mutates spec parameters (instructions, chunkOverlap,
defaultK, temperature) and scores each variant against `production`.
Higher score → keep the patch.

A well-tuned grader makes the optimizer effective; a binary grader
gives the optimizer no gradient to follow. Prefer continuous-score
graders for optimization workflows.

## Things that look like a grader but aren't

| Symptom                                                            | Better tool                                    |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| Want to **check the agent's tool sequence**, not its output.        | `tool_call_sequence` bundled grader.            |
| Want to **score multimodal output** (image + text).                 | `grader-multimodal`.                            |
| Want to **monitor live traffic**, not just eval datasets.           | Per-call OTel metrics ([Recipe 17](17-observability.md)). |
| Want to **A/B test prompts**.                                       | Eval-runner + canary.                            |

## What to read next

- **Using your grader as a canary gate.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- **Driving prompt optimization with your grader.** [Recipe 42 — Active Optimization](42-active-optimization.md).
- **Eval harness end-to-end.** [Recipe 12 — Eval Harness](12-eval-harness.md).

## Pointers to source

- **Core graders:** [`packages/eval-grader`](../../packages/eval-grader).
- **LLM-as-judge:** [`packages/eval-judge`](../../packages/eval-judge).
- **Registry:** [`packages/grader-registry`](../../packages/grader-registry).
- **Production graders:** [`packages/grader-nlg-metrics`](../../packages/grader-nlg-metrics), [`packages/grader-semantic-similarity`](../../packages/grader-semantic-similarity), [`packages/grader-safety-classifiers`](../../packages/grader-safety-classifiers), [`packages/grader-multimodal`](../../packages/grader-multimodal).
- **Module catalog reference:** §16, §29, §38 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
