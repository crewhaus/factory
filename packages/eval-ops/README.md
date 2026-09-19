# @crewhaus/eval-ops

What the eval runs add up to, once they have been run.

| Module | Answers |
|---|---|
| `eval-coverage` | what production exercises that the dataset never does |
| `eval-history` | the run index, the baseline a run is judged against, and the gate verdict |
| `graders-test` | how far a grader is from the humans who labelled the same outputs |

## A baseline is a lineage, and it can be restarted but not faked

Runs are keyed on (spec, dataset) — and, once routing is in play, on the arm
as well. Two things force a **new lineage** rather than a failure: the sample
ids changed (the dataset is a different dataset now) or the measuring
instrument changed (a different graders hash or judge model). Comparing across
either would report a difference that nobody caused.

Two things are refused outright. A resumed run rewrites its own results under
its original id, so when the pinned baseline *is* the run being resumed both
sides of the diff read the same file — that comparison is refused loudly
rather than reported as a vacuous pass. And a budget-aborted partial run is
recorded but never pinned or promoted on any path: its aborted samples are
synthetic failures, not measurements, and a baseline seeded from them would
make every later regression read as a recovery.

## Agreement, not accuracy

`graders-test` replays a whole grader suite over outputs a human already
adjudicated, and reports Cohen's kappa next to the raw agreement rate — a
grader that passes everything agrees with a mostly-passing label set about as
often as a good one does. It names the false positives (grader passed, human
failed) because those are the ones that let a regression through.

Deterministic and registry graders replay without credentials. An `llm_judge`
with no visible judge credentials is reported as **skipped**, never as
agreeing: a verdict nobody produced is not a verdict.

## Coverage is two distributions intersected

`eval-coverage` builds what production does (tool and MCP call frequencies,
sequence bigrams, compaction rate, clustered input themes) and what the eval
exercises (each sample's expected tools, plus the tools the last run really
called), and ranks the difference. Both sides cluster deterministically, with
the same clustering `graders-suggest` uses — so the backlog is stable enough
to work through.

## Why this is a package

A `packages/tool-*` may not depend on an app, and all three modules lived in
`apps/cli/src`.

## Testing

```
bun test packages/eval-ops/src
```

The `/src` is load-bearing: `bun test` matches by path PREFIX, so dropping it
also collects sibling packages whose names start the same way.

The tests that spawn `crewhaus eval coverage` and `crewhaus graders test` stay
in `apps/cli`.
