# @crewhaus/tool-buildperf

Did this change make the build worse — bigger, slower, or less trustworthy.

| Tool | Answers |
|---|---|
| `BundleSizeCheck` | what the artifacts weigh, against budgets and a baseline |
| `BenchmarkCompare` | which timing differences are real |
| `FlakyTestDetect` | which tests are flaky, which are broken, and which are ordered |

Each of these has a cheap wrong answer that a model will produce all day: a
percentage between two numbers that were never comparable, a mean of five
timings, a fail count divided by a run count. Each wrong answer is expensive,
because a gate that cries wolf gets switched off within a month. So the shared
property here is the refusal — every tool has inputs it will not answer, and
says why instead.

## The refusals, one per tool

**`BundleSizeCheck` will not compare across compression parameters.** A gzip
size is not a property of a file; it is a property of a file *and* the
compressor settings. Level 6 against level 9 differs by several percent on a
typical bundle — the same order as the regression anyone is hunting — so a
baseline recorded at one level and a head measured at another produces a
confident `+4.1%` about nothing. The parameters travel with every report, and
a mismatch (including a baseline that never declared any) comes back as
`comparison.status: "refused"` with no delta in the output at all. The verdict
is then `indeterminate`, never `pass`.

The same refusal covers the *column*. A report carries a raw and a compressed
number per entry, and which one a delta is taken on is decided by the
algorithm — so a baseline that declares gzip but stores no `compressedBytes`
is refused rather than read as raw. Filling that in would subtract a gzip size
from a raw one, land near `-98%`, and read as the best week the team ever had.
A compressed column under `algorithm: "none"` is refused for the mirror reason.

**`BenchmarkCompare` will not call significance on five samples a side.** Below
8 per side the normal approximation to Mann-Whitney's U is materially wrong:
for two fully separated groups of five it reads p = 0.0122 where the exact
test reads 0.0079. With the common default of `runs: 5`, the honest answer is
"cannot tell", and that is what comes back — with the p value carried along
for ranking candidates, explicitly not as a rate.

**`FlakyTestDetect` will not report 3-of-5 as 60% flaky.** The Wilson interval
on three failures in five runs is 23%–88%, which spans "mildly annoying" and
"the test is broken" without distinguishing them. Every rate comes with its
interval, and the quarantine recommendation keys on the interval's *lower*
bound; below the floor it says "run it more" rather than acting on the point
estimate.

## Why the median, and why a noise floor

Benchmark timings are right-skewed. They are bounded below by the work the
machine has to do and unbounded above by everything that can interrupt it, so
a GC pause or a scheduler preemption lands in the tail. The mean follows the
tail: for `[1,1,1,1,1,1,1,1,1,100]` the mean is 10.9 and the median is 1, and
comparing means against a clean run of ones reports a 91% improvement from a
change that did nothing. So the location estimate is the median, the spread is
the MAD, and the test is nonparametric.

The noise floor is a separate thing from significance and is **required**, not
defaulted. Significance is about variance you can average down with more
samples. The floor is about *bias* you cannot: thermal throttling, a different
worktree layout, a noisy neighbour on the runner. A difference inside the
declared floor is reported as `no-detectable-change` however small p is,
because no amount of sampling sees past a bias. Nobody but the caller knows
what their machine can resolve, so the tool does not guess it.

For the same reason `collection` is asked for. Base and head runs that were
not interleaved per benchmark have machine drift confounded with the change,
and no test on those samples can separate the two. Undeclared or sequential
collection produces a caveat on the report rather than a quieter verdict.

Size needs none of this. Compression at fixed parameters is deterministic, so
a one-byte difference is a real one-byte difference — which is exactly why the
parameters have to match, and why they are the only thing `BundleSizeCheck`
refuses over.

## Joining a hashed build

Bundlers write content hashes into filenames, so joining head against baseline
by exact path matches nothing on every build — and "nothing matched" reads as
"every file is new", not as "the join is broken". `join: "auto"` normalises
hash-shaped segments in the basename (`app-BXaGz2Qm.js` and `app.4f2a1c.js`
both become `app-[hash].js`), and `join: "custom"` takes the caller's own
pattern for a scheme the heuristic does not know.

The heuristic is conservative in one direction only: `chunk`, `min`, `vendor`
and `esm` are never eaten, because normalising a real name merges two
different artifacts into one row. It needs 6 characters for pure hex or 8 for
a mixed alphabet with both a digit and a letter. The known false positive is a
word that is also hex — `decade`, `defaced` — which is why every entry reports
the `key` it joined on rather than just a delta.

When two artifacts normalise to the same key, neither is paired: they are
listed under `join.ambiguous` and excluded from the comparison. Pairing one
arbitrarily would produce a delta for a file the reader never chose. The
baseline row under that key is set aside with them, in
`comparison.baselineSetAside` — it has no single successor either, and letting
it fall through as `removed` sends a reader hunting for a deleted chunk that
was in fact split in two.

## Order dependence is not flakiness

A test that fails only when another test ran first is not nondeterministic; it
is deterministic in a coordinate the runner did not vary. `FlakyTestDetect`
takes each run's tests **in execution order**, and for a test that both passed
and failed it names the tests that ran before it in *every* failure and in
*none* of the passes. That is a shortlist to bisect, not a cause.

If every run used the same order, the tool reports the question as undecidable
rather than answering "nondeterministic" — including for a test that failed
every single time, which under one fixed order is equally consistent with "it
is broken" and "it is broken after the test before it". Recording a shuffle
seed that never changed the order is reported too: the seed did not reach the
suite.

That check is per test, not per suite. A suite that merely gained or lost a
test varies its *sequence* while a given test keeps the identical prefix in
every run, and an identical prefix is the unvaried case again: "fails after
this prefix" and "fails at random" are the same observation. Reading the
suite's flag as the test's would report "the failures do not line up with a
predecessor" about a comparison that was never available.

A skipped test is never counted as a pass. Counting it as one is how a suite
that stopped running a test reports it as stable for a year.

## Grouping failures

Failures are grouped by `signature` when the caller supplies one, and
otherwise by the failure text after the caller's declared `masks`, with each
mask's hit count returned — a mask that rewrites text invisibly can merge two
genuinely different failures into one group, which reads as "it always fails
the same way" when it does not.

A failure that recorded neither a signature nor any text is in no group at all,
so `sameFailureEveryTime` comes back `null` rather than `true` whenever a
failure went ungrouped. One group among the failures that said something is not
an answer about the failures that did not, and answering `true` from that
subset is what sends someone after a single root cause for two different bugs.

There are deliberately no built-in masks. `ErrorCluster` in
`@crewhaus/tool-obs` already owns shape-based masking of error text (URLs,
uuids, timestamps, paths, prefixed ids, hex blobs, numbers). A second set here
would drift from it and the two tools would then disagree about whether two
failures are the same failure, so pass its fingerprint in as `signature`
instead.

## Shared implementations

Every statistic comes from `@crewhaus/tool-math`'s `statsKernel` — the median,
the MAD, the trimmed mean, Mann-Whitney U and the Wilson score interval. None
of it is re-derived here, and the z table for a confidence level is read from
the kernel rather than written as a literal. The kernel pins its own numbers
against R and against a brute-force enumeration; this package pins what it
does with them.

## What it does not do

- **It runs nothing.** No build, no benchmark suite, no test runner, no git
  worktree. Measurements come in and the honest reading of them comes out.
  Use `RunTests`, or the project's own commands, to produce them.
- **It does not reach a network** and does not spawn a process. Only
  `BundleSizeCheck` touches the filesystem, read-only, and every path is
  contained within the workspace root — a symlink pointing outside it is
  refused rather than weighed. Walking a `directory` does not follow links at
  all, because weighing a link and its target double-counts; the ones it
  skipped are named in `warnings` rather than dropped silently.
- **It does not write a baseline.** A `BundleSizeCheck` report *is* a
  baseline: store it with `Write` and pass it back as `baseline`, or point
  `baselineFile` at it.
- **It does not read `.size-limit.json`, `bundlesize` or any other budget
  config.** Those three formats disagree about what a bare `*` crosses, so one
  glob dialect is implemented and documented instead: `*` within a segment,
  `**` across segments, `?` one character, everything else literal.
- **It does not judge two aggregates.** A framework that reports only a mean
  per side is compared against the noise floor and then explicitly left
  untested — `not-tested`, not `clean`.
- **A budget that matches nothing is a violation**, not a pass. A renamed
  entry point is the usual way a size gate quietly stops gating. For the same
  reason `maxIncreasePercent` gates the **total** as well as each matched
  entry, and says so when it could not gate anything: a new chunk is `added`
  rather than matched, and a build that writes a fresh content hash into every
  filename joins nothing at all, so a limit that only walked the matched rows
  would go green on a bundle that tripled. A limit declared with no baseline is
  a violation too.

- **The glob dialect is not compiled to a regular expression.** `*` and `**`
  would become `[^/]*` and `.*`, and a backtracking engine handed several of
  those separated by literals explores every way of splitting the path between
  them — `*a*a*a…*b` is 49 characters and does not finish against sixty `a`s.
  Patterns are matched by a memoised walk over (token, offset) instead, which
  is bounded by the pattern's token count times the path's length, and a
  pattern over 512 characters is refused.
