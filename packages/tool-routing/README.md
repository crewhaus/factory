# @crewhaus/tool-routing

Reading and steering model routing, experiments and observational learning, as
deterministic tools.

Four tools over three stores. Two of them answer questions — what has this
harness learned, what has it observed, is its improvement loop wired. Two of
them change what happens next: a freeze pins the policy, a promotion folds
audition evidence into the arms that serve, a recorded outcome moves a
version's tally. So both of those default to a dry run and say what they
changed.

```yaml
tools:
  - routeControl
  - experimentLedger
  - flywheelStatus
  - watchmeReport
```

| Tool | What it does |
|---|---|
| `RouteControl` | Read the reward scoreboard and its lanes; freeze or unfreeze the learned policy; promote observe-only lane evidence into the live arms; compact the store |
| `ExperimentLedger` | Assign a request key to a spec-version variant, record outcomes, and fold the ledger into per-version tallies with a winner or an explicit undecided |
| `FlywheelStatus` | Report the self-improvement loop's scaffolding, its run artifacts, and which dataset rung it would resolve |
| `WatchmeReport` | Read the observational-learning ledger, its per-window outcomes, and how much of its quality has reached routing |

## The real stores, not a second implementation

| Rule | Where it lives |
|---|---|
| The `(routeKey, arm)` fold: Welford, aggregate combine, `v:2` quality, `ungraded`, the `pf` lineage skip | `@crewhaus/routing-store` `openScoreboard` |
| The observe-only lane prefixes and what each one may carry into a live arm | `isObserveOnlyLane` / `liveRouteKeyOf` / `promoteLanes` |
| Which arm ids the shadow lane recorded on each side of an audition | `readShadowLaneSides` |
| The kill switch and its marker | `readRouteFreeze` / `writeRouteFreeze` / `clearRouteFreeze` |
| The watch-me digests, aggregates, judgments and state document | `@crewhaus/watchme-store` `openWatchmeStore` |
| The experiment assignment hash, weight walk, filename sanitizer, ledger format, repeat-measurement dedupe and per-version fold | `@crewhaus/canary-controller` `./experiment` |
| Wilson score intervals and the Mann-Whitney rank test | `@crewhaus/tool-math` `statsKernel` |

This package contributes the schema, the containment, the refusals, the result
shape and the statistics policy. It contains no second copy of any of those
rules. Two are worth naming specifically:

**The assignment hash is imported, never re-derived.** It is
`sha256(salt|requestKey)` mod 100, and `CanaryController.route()` buckets the
same way on purpose. A second implementation anywhere means a tenant is served
version A at the serving boundary and attributed to version B in the ledger,
and every number the experiment produces is then wrong in a way no test of this
package would catch.

**The scoreboard fold is imported, never re-parsed.** Last wave `SpecAdvise`
reported `routingScoreboard.read:false` rather than parsing `arms.jsonl` by
hand, which was right — that would have been a second copy of routing-store's
fold. This package has the dependency, so it opens the store.

## Every rate carries its interval

An arm with three observations is not a better arm than one with three
hundred, and a point estimate says it is.

| Number | What it leaves here as |
|---|---|
| A proportion — an experiment's success rate, an arm's grade-attempt rate, a tool-error rate, a feedback-up rate | A Wilson score interval, `null` at zero trials with the reason |
| An arm's mean reward or mean quality | The mean, its `n`, its sd, and a normal-approximation interval **explicitly labelled as not a Wilson interval** — it is a continuous scalar, not a success count |
| A watch-me roll-up's quality and turns per session | The same, off the aggregate line's own Welford `m2Quality` / `m2Turns` — these are the two numbers an operator reads as "how is this harness doing", and a mean quality of 0.92 over one session is not a better harness than 0.81 over four hundred |
| A comparison between experiment versions | A Mann-Whitney rank test over the per-observation scores, Bonferroni-corrected by the number of pairs |
| A comparison between two proportions | Interval overlap, three-valued, with `undecided` stated as "this much data cannot tell them apart", never as "they are the same" |

Two refusals in that table are load-bearing. `wilsonScoreInterval` returns
`null` at zero trials — an interval on no observations is fabrication, not
caution — and that `null` is carried through rather than flattened to `[0, 0]`.
And `mannWhitneyU` reports `normalApproximationValid: false` below eight
observations a side; this package honours it, so a five-versus-five complete
separation comes back `undecided` with the sample size as the reason even
though its p-value is under 0.05.

### Why arms do not get the rank test

`ArmStats` is a fold: `n`, a Welford mean and an M2. The per-observation
rewards are gone by the time `snapshot()` returns, and `@crewhaus/routing-store`
exports no per-observation reader. Recovering them would mean a second parser
of the `arms.jsonl` grammar that would have to agree with the store's about
aggregate lines, about the `v:2` fields and about the `pf` lineage skip — and
the first time it did not, two parts of the product would disagree about which
arm is winning.

So `RouteControl` reports each arm's mean with its interval and its `n`, and
says in the result that a rank test is not available and why. `ExperimentLedger`
does run one, because its ledger keeps every observation.

## Could not determine is not no

- A scoreboard that could not be read is `unreadable`, never an empty one.
- A watchme ledger that could not be read is `unreadable`, never an empty one.
- A `.github/workflows` that could not be listed is `unreadable`, never an
  unscaffolded harness.
- A `state.json` that exists and will not parse is `unreadable`. The store
  falls back to its default there, which reads as a harness that has never
  watched anything — the opposite of the truth after a torn write.
- A window outcome that is none of the three known ones is counted as
  `unrecognised`, not as a success. `model_refused_unpriced` is a
  configuration error that consumed its window; `model_failed` is transient and
  retries. One needs an edit, the other needs nothing.
- A ledger line the store SKIPPED because it is not JSON is counted and
  reported (`observations.file.unparseable`). A file whose second half was
  overwritten with garbage otherwise reads as a small healthy store.
- An experiment ledger that cannot be read is a refusal.
  `readExperimentOutcomes` tolerates a read failure by returning no records,
  which would report a version as never measured.
- An assignment manifest that exists and will not parse is `corrupt`, not
  absent. `readExperimentAssignment` returns `undefined` for both, and a
  concluded ramp removes its manifest deliberately — so "absent" is a normal
  state that must not absorb a broken file.
- Two reads carry an explicit byte ceiling, because both stores read a whole
  file into memory to fold it. Past the ceiling the tool refuses and names the
  command that compacts, rather than reporting a partial fold.
- A path that could not be **resolved** is reported as unreadable rather than
  as an escape. `paths.ts` fails closed and calls every failure an escape,
  which is the right refusal and the wrong reason: a directory this process
  cannot `realpath` has not been shown to lead anywhere.

### The corrupt kill switch

`readRouteFreeze` takes an `onMalformed` callback and reports **absence** when
the marker will not parse. Every caller that omits the callback therefore reads
a corrupt kill switch as "not frozen" — including `promoteLanes`'s own internal
freeze check, and `apps/cli`'s `loadRouteFreeze`, which documents the behaviour
in its own doc comment.

A promotion is the one operation whose entire purpose is changing which model
serves. So `RouteControl` reads the marker **with** the callback before
anything else, and refuses to promote or compact when it says `corrupt`. The
test for this asserts that `promoteLanes` on the same workspace would have
folded, so the guard cannot quietly become a restatement of library behaviour.

## Steering says what it changed

`RouteControl` and `ExperimentLedger` are `destructive` and `dryRun` defaults
to `true`: acting takes an explicit `dryRun: false`.

The promotion preview is `promoteLanes`'s **own** `dryRun` — the identical walk
over the identical lines with the write suppressed — not a parallel preview
beside it. A test asserts the real fold moves exactly the line count the
preview reported, and that the file is byte-identical after the preview.

`changed` is measured, not inferred. A `q:` lane line carrying no judged
quality folds nothing and is still stamped as already-promoted, rewriting the
store — so `promote` reports `changed: true` whenever the file moved, even at
`linesFolded: 0`, rather than telling an operator that nothing happened to a
store that had just been rewritten.

Compaction is the one write here that can DELETE evidence, and it says which.
`Scoreboard.compact()` keeps only the arms with `n > 0 || ungraded > 0`, and a
live arm whose only evidence is a promoted `q:` quality back-fill has neither —
so it is dropped, and its lane sources are already stamped, so no later
promotion can restore it. Both the preview and the real run report
`armsDropped`, and the real run **refuses** when a dropped arm carries judged
quality unless `acceptArmLoss: true` is passed. The predicate restates
`compact()`'s own filter, so a test runs the real `compact()` and asserts the
arms that disappeared are exactly the ones the preview named.

What each write reports:

| Action | What it says it changed |
|---|---|
| `freeze` | The marker it wrote, the marker it replaced, and where |
| `unfreeze` | Whether a marker was removed and what it had pinned (or that it was unreadable, so what it pinned is unknown) |
| `promote` | Lines folded, lines already promoted, per-lane-arm promotions, and what each carry means |
| `compact` | Arms before and after, bytes before and after, the arms it would delete and why — and nothing at all on a harness that has never routed, rather than creating an empty store |
| `record` | The exact record appended, the ledger's size before and after, and whether the version was checked against a manifest |

## Containment

Every caller-supplied path goes through `resolveSafe` (copied verbatim from
`@crewhaus/tool-pkg`), which refuses anything resolving outside
`process.cwd()`, including via a symlink inside the workspace.

**And every path the tools actually open, not just the directory the caller
named.** Containing a directory and not its leaves contains nothing:

- `routing/arms.jsonl` **and `routing/arms.jsonl.tmp`** — `compact()` and
  `promoteLanes()` write the `.tmp` and then `rename` it on top of the store, so
  a symlink at that name carries the write out before the rename ever runs, and
  a dangling one is created by the write itself.
- `routing/freeze.json` and its `.tmp`, `routing/priors.json`.
- `experiments/<sanitized>.jsonl` — under the name `experimentFileName`
  produces, not the one the caller typed. A batch append groups by
  `record.experiment` and can touch several ledgers; each is contained.
- Every run directory and stage path a `readdir` of `.crewhaus/flywheel` hands
  back, and every experiment name a `readdir` of `.crewhaus/experiments` hands
  back. A name a listing produced is exactly as untrusted as one a caller
  typed. Entries that fail the check are **reported** as `uncontained`, never
  dropped — a run this tool will not open is still a run.

A NUL in a path is refused at the gate: it truncates the path at the syscall
boundary, so the string the containment check resolves and the string the
`open` uses can differ.

Values are validated where they are USED, not where they were spelled. A
`policyVersion` is checked and reported trimmed, because `writeRouteFreeze`
trims before it writes and a preview promising the untrimmed spelling promises
a marker that never lands. A non-finite `score` is refused in `execute` as well
as in the schema, because `readExperimentOutcomes` drops one on the way back
in — the append would succeed and no tally would ever see the value.

`WatchmeReport` treats the routing half as degradable and the ledger half as
required: a scoreboard that cannot be contained or cannot be read makes
`routing.read` false with the reason, and the ledger report still stands.

## What this build cannot do, it says

| Not done here | What does it |
|---|---|
| The promotion's eval gate — a newest `as-declared` run with a pinned seed, a frozen WARM arm snapshot, neither partial nor replayed, passing `gateRuns` against its lineage baseline | `crewhaus route promote --gate`, over `@crewhaus/eval-report` and `@crewhaus/eval-ops`. A real promotion from here needs `acceptUngated: true`. |
| Resetting the scoreboard | `crewhaus route reset`. `routing-store` has no reset primitive; the wipe lives in `apps/cli`. It is also the one routing operation that is unsafe from outside the loop: `arms.jsonl` is append-only and written live, and there is no generation marker for a router to notice the store was replaced underneath it. |
| Whether `registry:<spec>-ratings` is registered | `@crewhaus/dataset-registry`. Reported as `"unknown"`, so the shadow warning is stated as conditional rather than asserted. |
| Whether the optimizer's write-back landed in the spec | `@crewhaus/spec-patch`'s `parseWriteBackHeader`. Its absence from the result says nothing about whether a stamp is there. |
| A flywheel run's acceptance verdict | `@crewhaus/eval-report`'s `loadRun` over the run's `before/` and `after/`. This tool reports which stages exist and does not open them. |
| The phase-2 judge, `watchme synthesize`, and `watchme report --feed-routing` | `crewhaus watchme report`. All three take model calls or write arms. |

### The dataset precedence, and the rung no file can answer

`crewhaus flywheel run` picks its dataset by three rungs: `--dataset`, then the
conventional `eval/dataset.jsonl` beside the spec, then
`registry:<spec>-ratings`. That rule lives in `apps/cli`'s
`resolveFlywheelData`, and the warning for the case where the conventional file
hides distilled user ratings lives beside it in `formatRatingsShadowWarning`.

The survey sketch asked this tool to "report the precedence decision". It
reports something weaker and truer. **The top rung is an argument, not a
file** — no reader of a directory can know whether `--dataset` was passed, so
nothing that reads a directory can name the source the last run used.
`FlywheelStatus` reports which rungs are available, which one wins *if the flag
is omitted*, whether that would shadow the ratings dataset *if one is
registered*, and names `apps/cli` as the owner of the rule.

### `state.json` is not where a flywheel run is recorded

`.crewhaus/flywheel/state.json` is read by the Hangar flywheel endpoint. In
this tree nothing writes it: `crewhaus flywheel run` records itself as
`.crewhaus/flywheel/<runId>/{before,after,optimize,diff}`. The file is probed
and reported anyway — something else may write it — but an absent one means
nothing on its own, and the result says to read `runs` instead.

## Determinism

Listings are sorted with plain string comparison, never `localeCompare`
(the stores sort with it, which is fine for a human table and not for a result
a test pins). `readdir` order is never relied on. Timestamps in results come
from the data, except the one clock a recorded outcome legitimately needs.
