# @crewhaus/grader-provability

Six deterministic eval graders over the proof bundle the provability gate produced for each eval
sample. They make no model call and never re-run the verifier: the bundle is the gate's own record
of the answer, so a graded sample and the footer the answer carried can never disagree.

| Grader | Measures | Passes |
|---|---|---|
| `provability.claimCoverage` | claims that meet the floor ÷ claims that count (assumptions excluded) | ≥ 0.95, and every `expected_sources` origin grounds the answer |
| `provability.rungAchieved` | the highest floor the answer passed, as rank ÷ 4 | at or above the floor |
| `provability.citationValidity` | defined markers ÷ markers | ≥ 0.99 |
| `provability.assumptionRate` | declared assumptions ÷ claims (lower is better) | ≤ 0.1 |
| `provability.replayIntegrity` | replayed tool results that matched ÷ replayed | = 1.0 (none replayed passes) |
| `provability.costPerProvenClaim` | gate-caused spend per met claim | reported, never gates |

The floor is the sample's `metadata.provability.level` when set, else the run's (the spec's
`provability.level`, or `crewhaus eval --provability <level>`). `crewhaus eval` runs each such
sample's gate at its own level, so its grade is exact. A sample can also name the sources that must
ground its answer:

```jsonl
{"id": "refund", "input": "What is the refund window?", "metadata": {"provability": {"level": "grounded", "expected_sources": ["https://acme.example/policy"]}}}
```

A run with no proof bundle fails every grader with "no proof bundle (is provability: declared?)",
and so does a bundle the gate could not verify. Proof was expected, so a missing verdict is never a
pass. A bundle made below the sample's level cannot grade it either: the checks only the higher
level runs never ran. `isUnmeasured(result)` tells these failures apart from measured ones.

`costPerProvenClaim` prices the gate's retries from the run's cost events, or through a `pricing`
function (`createProvabilityGraders({ pricing })`) when nothing metered the run. Tokens it cannot
price are reported as unpriced, never as free.

```ts
import { GraderRegistry } from "@crewhaus/grader-registry";
import { registerProvabilityGraders, summarizeProvabilityMetrics } from "@crewhaus/grader-provability";

const registry = new GraderRegistry();
registerProvabilityGraders(registry); // the six names above
```

`crewhaus eval` registers them in its default registry, so a graders file can name them with
`type: registry`, and `crewhaus eval --provability <level>` adds all six to the run. Added that
way, they sit beside your graders' `combine:` policy rather than inside it: a sample passes only
when your graders pass and every provability bar holds, and the cost is reported only.
