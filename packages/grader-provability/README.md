# @crewhaus/grader-provability

Deterministic eval graders over the proof bundle the provability gate produced for each eval
sample (`RunResult.artifacts.proof`, the gate's standing verdict). They make no model call and
never re-run the verifier: the bundle is the gate's own record of the answer, so a graded sample
and the footer the answer carried can never disagree.

| Grader | Measures | Passes |
|---|---|---|
| `provability.claimCoverage` | claims that meet the floor ÷ claims that count (assumptions excluded) | ≥ 0.95, and every `expected_sources` origin grounds the answer |
| `provability.rungAchieved` | the highest floor the answer passed, as rank ÷ 4 | at or above the floor |
| `provability.citationValidity` | defined markers ÷ markers | ≥ 0.99 |
| `provability.assumptionRate` | declared assumptions (refused ones and proof hypotheses included) ÷ claims; lower is better | ≤ 0.1 |
| `provability.replayIntegrity` | replayed tool results that matched ÷ replayed | = 1.0 (none replayed passes) |
| `provability.costPerProvenClaim` | gate-caused spend per met claim | reported, never gates |

The floor is the sample's `metadata.provability.level` when set, else the run's (the spec's
`provability.level`, or `crewhaus eval --provability <level>`). `crewhaus eval` runs each such
sample's gate at its own level, so its grade is exact. A sample can also name the sources that
must ground its answer, as URLs, `doi:` references or workspace paths:

```jsonl
{"id": "refund", "input": "What is the refund window?", "metadata": {"provability": {"level": "grounded", "expected_sources": ["https://acme.example/policy"]}}}
```

`metadata.provability: grounded` is the shorthand for `{ level: grounded }`. A malformed value
fails the sample with a rationale naming the field, never silently grades it at the wrong bar.

## Unmeasured is never a pass

A run with no proof bundle fails every grader with "no proof bundle (is provability:
declared?)", and a bundle the gate could not verify fails them with "the gate could not verify
this answer". Proof was expected, so a missing verdict is never a pass. A bundle made below the
sample's level cannot grade it either: rungs above a gate's floor are recorded without the checks
only those floors run, so the floor-dependent graders fail it as unmeasured (`citationValidity`
and `assumptionRate` do not depend on the floor and still measure). `isUnmeasured(result)` tells
these failures apart from measured ones by their pinned prefixes (`UNMEASURED_PREFIXES`), and the
roll-up keeps them out of a lower-is-better mean.

`costPerProvenClaim` prices the gate's retries from the run's cost events, or through a
`pricing` function when nothing metered the run, and adds the waiver judge's reported spend;
checker time (`proof_checked` durations) is reported beside it, never added. Tokens it cannot
price are reported as unpriced (the score is then a lower bound), never as free, and spend with
no met claim is reported as an infinite ratio.

## API

```ts
import { GraderRegistry } from "@crewhaus/grader-registry";
import { registerProvabilityGraders, summarizeProvabilityMetrics } from "@crewhaus/grader-provability";

const registry = new GraderRegistry();
registerProvabilityGraders(registry); // the graders above, under their canonical names
```

- `registerProvabilityGraders(registry)` registers every grader, skipping a name already
  present (a plugin registered first keeps it), and returns the canonical names.
- `PROVABILITY_GRADERS` (name, grader pairs in table order), `PROVABILITY_GRADER_NAMES`, and
  `createProvabilityGraders({ pricing? })`, the same set with `costPerProvenClaim` pricing
  through `pricing`. The graders are exported one by one too (`claimCoverage`, …).
- `provabilityGraderRole(name)`: `"requirement"` for the graders with a bar, `"report"` for
  `costPerProvenClaim` (`PROVABILITY_REPORTED_GRADERS`), `undefined` for any other name.
- `summarizeProvabilityMetrics(byMetric): ProvabilitySummary` folds per-sample results into the
  roll-up (mean, pass fraction, p50/p95, breaches, unmeasured counts);
  `renderProvabilitySummaryLines(summary)` prints it; `summarizeCostPerProvenClaim` is the cost
  metric's own fold.
- `PROVABILITY_METRIC_THRESHOLDS`, `PROVABILITY_METRIC_SPECS`, `sampleProvabilityOf(sample)`,
  `expectedSourceKey(source, workspaceRoot?)`, `gateSpendOf(events, bundle?, { pricing? })`, and
  the pinned prefixes.

## How it is wired

`crewhaus eval` registers the graders in its default registry, so a graders file can name them
with `type: registry`, and `crewhaus eval --provability <level>` adds all of them to the run.
Either way they sit beside your graders' `combine:` policy rather than inside it: a sample passes
only when your graders pass and every provability bar holds, and the cost is reported only. A
`weight` on one of them is not used, and under `combine: any` or `weighted` the run says so at
start.

## Limits

- A bundle made outside `crewhaus eval` (a hand-wired invoker) graded at a floor below its own is
  re-read from the rungs the gate recorded: `grounded.independent` and the guarded HEAD apply only
  at the run's own floor, so that grade is close, not exact.
- An `expected_sources` origin counts only when it grounded the answer in text the run did not
  write there itself (`writtenBy`); a source the run wrote is named in the rationale instead.
- `citationValidity` counts the markers the answer wrote: a claim read from a definition line's
  text is skipped, since its binding is defined by construction.

## Tests

```sh
bun test src
```

Fixture bundles (`src/__test__/fixtures.ts`) pin each grader's score and rationale, the
unmeasured cases, the spend windows and pricing, the sample metadata reader and the roll-up.

Design: [design/0.8.0-provability-release.md](../../design/0.8.0-provability-release.md) §9.1.
