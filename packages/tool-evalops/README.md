# @crewhaus/tool-evalops

What the eval runs add up to, without running one.

| Tool | Answers |
|---|---|
| `EvalHistory` | where this suite is heading — per lineage, cut wherever the instrument changed |
| `EvalAggregate` | what one run's numbers actually come to, recomputed from its own samples |
| `EvalBaselinePin` | which run the gate is holding the line against — show, move, clear |
| `EvalCoverage` | what production does that the dataset never tries |
| `GraderMetaTest` | how far a grader is from the humans who labelled the same outputs |

Every one of these is a fold over files a run already wrote, so none of them
needs a model turn, a provider key or a network.

## A trend line is cut where the instrument changed

`@crewhaus/eval-report`'s `buildTrends` groups runs by baseline lineage —
(spec, dataset) and, since 0.6.0, the arm. That grouping is right and this
package reuses it. It is not an identity, though: the dataset bytes, the
graders config, the judge model and the arm snapshot are recorded **on the
run** and can change from one run of a lineage to the next. `crewhaus eval`
knows this and refuses to gate across such a change. Nothing carried that
knowledge into the fold that draws the line.

So `EvalHistory` segments each lineage and gives every segment its own
first-to-last delta, in percentage **points**.

| field | both present and different | present on one side only |
|---|---|---|
| `datasetHash` | cut | unverified (a current CLI always writes it, including when absent from both) |
| `gradersHash` | cut | unverified (same) |
| `judgeModel` | cut | unverified — but absent on **both** means "neither run pinned a judge", which is a fact, not a gap |
| `armsDigest` | cut | unverified on a routed lineage; absent on an unrouted one is a statement |
| `policyVersion` | cut | as `armsDigest` |
| `specHash` | note only | note only |

`specHash` is deliberately not a cut. Re-running an edited spec against its
pre-edit baseline is the whole point of the regression gate — the spec is the
thing being measured, not the instrument. (The per-tool survey sketch listed
`specHash` beside `gradersHash` as a reason to segment. That is wrong, and
acting on it would cut the line exactly where it becomes interesting.)

Two details that a simpler fold gets wrong:

- **Comparison is against the last KNOWN value, not the previous run.** With
  runs A(`gradersHash: x`), B(no hash), C(`gradersHash: y`), a pairwise walk
  sees two unverifiable joins, no change, and draws one line through a rubric
  rewrite. Compared against the last known value, C differs from A and the line
  is cut.
- **A budget-aborted run is not a trend endpoint.** Its unexecuted samples were
  recorded as failures, so anchoring a delta on it reports a collapse nobody
  caused. It stays in the run list, out of the endpoints, and is named in
  `excludedFromTrend`.

A segment whose joins could not all be verified is marked `unverified` rather
than quietly trusted. Absence is never read as agreement.

## A rate over a small n gets an interval

3 of 5 is not 60%. Pass@k, pass^k, grader agreement and a coverage gap's share
of production all carry a Wilson interval from `@crewhaus/tool-math`'s stats
kernel — the same kernel `tool-buildperf` and `tool-table` use, not a second
one.

Where the exact counts cannot be recovered from what was recorded, the interval
is **absent with a reason**, never estimated from a rate. `EvalAggregate`
recovers the pass rate's denominator from the aggregate's own abstention and
canary counts (both leave that denominator), and recovers pass@k's numerator
from `rate x total` only when that product is a whole number. A guessed
numerator produces an interval narrower than the truth, and an overconfident
interval is worse than none.

## Could not determine is not no

- A torn line in `index.jsonl` is counted. The shared reader skips it by design;
  a report that does not say so is claiming a completeness it cannot support.
- A row that parses but is not a run (`42`, a pass rate of 1.4) is named with
  the reason, not dropped.
- A malformed `baselines.json` is `unreadable`, which is not "nothing is
  pinned" — and `EvalBaselinePin` refuses to write over one, because that write
  would destroy the pins of lineages the call never named. "Malformed" includes
  a file that is valid JSON but is not a MAP (`null`, `[]`, `"x"`, `3`):
  `readBaselines` is `JSON.parse` plus a cast, and `setBaseline` on an array
  assigns a key `JSON.stringify` then drops — so a pin would report
  `committed: true` over a file that never changed.
- A declared aggregate block that could not be checked comes back as
  `declaredAgrees: null` with the reason, never `true`. No `aggregates` block,
  a declared figure that is not a number, and a recomputation that had to drop
  samples are all "could not determine", and each is a different reason.
- A list in a result that hit its cap carries `<field>Omitted` beside it. A
  truncated listing presented as a complete one is the same failure as an
  unreadable file presented as an empty one.
- `EvalCoverage` names the run it read events from by TIMESTAMP, and says when
  a session directory could not be listed rather than calling it empty.
- `EvalCoverage` over zero readable sessions is a **refusal**. The report's own
  words for an empty comparison are "no coverage gaps", which is also what a
  perfectly covered harness prints.
- An agreement floor that could not be evaluated — every grader skipped — is
  `unknown`, never `pass`.
- A lineage with no pinned baseline is reported as one, with the reason: that is
  exactly the case where a regression gate passes because there is nothing to
  fail against.

## The lineage comes from the run, not from the request

Baselines key on (spec, dataset) and, since 0.6.0, on the arm. A pin keyed off
caller-supplied strings can therefore drop one arm's run onto another arm's key
and clobber a sibling's baseline. `EvalBaselinePin` derives the key from the
run's own recorded columns and refuses a mismatch. It also refuses a partial
run (mirroring `finishEvalRun`, which refuses one on every pin path), refuses a
run whose `results.json` cannot be read, and warns when a re-pin moves the
instrument.

`dryRun` runs the same planner the real call runs and then simply does not
commit it. There is no parallel preview path — that is how `tool-hostfs`'s
`TrashPath` came to predict a destination the real call never used.

## What these tools do not do

They never run an eval, never call a model and never reach a provider.
`GraderMetaTest` replays **deterministic graders only**: an `llm_judge` entry is
skipped because grading it is a model call, and a `type: registry` entry is
skipped because resolving it means loading pack and plugin code. Both are named
with those reasons rather than with the CLI's "no credentials visible" message,
which would tell an operator to set a key that changes nothing here.

Only `EvalBaselinePin` writes, and only to `baselines.json`.

## Two things found upstream while building this

Both are reported by the tools rather than worked around silently:

1. **`readRunIndexLatest` throws on a `null` line.** `readRunIndex` accepts it
   (`JSON.parse("null")` does not throw) and the collapse then dereferences
   `.runId` on it. `EvalHistory` degrades to the uncollapsed rows and says so in
   `collapseFailed` instead of crashing; the fix belongs in
   `@crewhaus/eval-report`.
2. **Two Cohen's kappa implementations disagree on the degenerate case.**
   `@crewhaus/eval-ops` returns 0 where `@crewhaus/tool-math`'s kernel returns 1
   with `degenerate: true`. `GraderMetaTest` reports both numbers and names the
   disagreement rather than picking one.

`@crewhaus/eval-report` also has no `deleteBaseline`, so the `clear` action
rewrites `baselines.json` in exactly the shape `setBaseline` writes it. That is
a second writer and it is marked as one in the source.

## Testing

```
bun test packages/tool-evalops/src
```

The `/src` is load-bearing: `bun test` matches by path PREFIX, so dropping it
also collects sibling packages whose names start the same way.

`lib.test.ts` drives the segmentation and the readers — every boundary
assertion names the field that moved and the runs it moved between.
`index.test.ts` drives the five tools against real files in a temporary
workspace, checks each segment's trend endpoints against that segment's own
runs, and checks the file on disk after every refusal the writing tool makes.
