# @crewhaus/tool-math

Deterministic numeric tools. Every one is pure: no filesystem, no network, no
clock, no randomness. The same input always produces the same bytes.

That property is the point. A harness spends a model call when it needs
judgement; it should not spend one to total an invoice, convert a unit, or work
out a percentile — and it certainly should not spend one on a task where a
plausible wrong answer is indistinguishable from a right one.

Because that is the real hazard here. Text tools fail visibly. Number tools
fail **silently**: a float answer to a money question is off by a cent, a
percentile computed by a different convention is off by a little, a markup
reported as a margin is off by a third. So every tool in this package states
its method in its result, and refuses when the data cannot answer the question.

```yaml
tools:
  - all-math          # every tool below
  - -Evaluate         # ...except this one
```

| Tool | What it does |
|---|---|
| `Amortize` | Loan schedule: payment, interest, principal and balance per period |
| `Correlation` | Pearson's r and Spearman's rho, with n and a caution |
| `CurrencyConvert` | Convert money using a rate table **you** supply |
| `Evaluate` | Arithmetic expressions, real parser, never `eval()` |
| `GeoBoundingBox` | Lat/lon box around points, or around a centre and radius |
| `GeoDistance` | Great-circle distance and initial bearing (haversine) |
| `GeoPointInPolygon` | Ray-casting geofence test, boundary hits reported |
| `Histogram` | Equal-width buckets with their bounds and counts |
| `Irr` | Internal rate of return by bisection, multiple roots flagged |
| `LinearRegression` | OLS slope, intercept, r², residual error, predictions |
| `MoneyAdd` | Exact addition of integer minor units |
| `MoneyAllocate` | Split an amount by ratios so the parts sum to the whole |
| `MoneyMultiply` | Money times an exact decimal factor, rounded once |
| `Npv` | Net present value, timing convention stated |
| `NumberFormat` | Format for an explicit locale via `Intl` |
| `NumberParse` | Parse a locale-formatted number back, explicit locale |
| `Outliers` | Flag by the IQR rule or by z-score, convention named |
| `Percent` | Change, share of total, and the markup/margin square |
| `Percentile` | One or more percentiles by a chosen convention |
| `Round` | Decimal places, significant figures or nearest multiple |
| `Statistics` | Count, sum, mean, median, mode, variance, stdev, quartiles |
| `UnitConvert` | Ten dimensions, exact factors, affine temperature |

## The conventions, stated once

Every one of these appears in the tool's own output too. They are collected
here because they are what makes the answers checkable.

**Sample vs population.** `Statistics` reports variance and standard deviation
*both* ways, labelled. Sample divides by n-1 (spreadsheet `STDEV`), population
divides by n (`STDEVP`). Sample variance of a single value is `null`, not zero.

**Percentiles.** Three named conventions, because they disagree — on `1..10` at
p25 they give 3.25, 2.75 and 3:

- `r7` (default) — linear interpolation, h=(n-1)p. R type 7, NumPy's default,
  Excel `PERCENTILE.INC`.
- `r6` — h=(n+1)p. Excel `PERCENTILE.EXC`, Minitab, SPSS. **Refused** outside
  the range [1/(n+1), n/(n+1)] where it is defined, rather than clamped — and
  that includes a single observation, where the range collapses to p=0.5.
- `nearestRank` — ceil(p·n), no interpolation, so the answer is always an
  observed value. ISO 2602.

**Rounding.** Seven modes, applied to the exact decimal digits of the input,
never through binary floating point: `halfEven` (banker's, the default and what
accounting expects), `halfUp`, `halfDown`, `ceiling`, `floor`, `up`, `down`.

**Money.** Integer minor units in `bigint`s, never floats. A currency's ISO 4217
minor-unit exponent decides what those units mean — JPY has 0, most have 2, the
Gulf dinars have 3 — and an unknown code is refused rather than assumed to have
2, because that assumption is a 100× error waiting for a yen invoice.
`MoneyAllocate` uses the largest-remainder (Hamilton) method so the parts always
sum to the whole; that invariant is asserted in the result *and* over 500
generated cases in the tests. An amount is capped at 1 000 digits, the same
limit the decimal parser applies: no price is that long, and the bigint work
behind an allocation grows faster than the input does.

**NPV timing.** `cashflows[0]` sits at t=0 and is not discounted — the textbook
definition. Excel's `NPV()` discounts its first argument one full period;
`firstPeriod: 1` reproduces that on purpose.

**Markup vs margin.** Markup is profit over **cost**; margin is profit over
**price**. A 50% markup is a 33.3% margin. `Percent` reports both, always.

**Geodesy.** A sphere of radius 6 371 008.8 m (the IUGG mean radius of WGS-84),
stated in every result, because a spherical model differs from the ellipsoid by
up to ~0.5%. Fine for logistics, not for surveying.

**Units.** Definitional factors are exact (1 in = 0.0254 m, 1 lb =
0.45359237 kg, 1 cal = 4.184 J) and marked `exact: true`; conventional ones
(psi, mmHg, BTU) are marked `false`. Temperature converts **affinely** — an
offset and a ratio relative to kelvin, never a scale factor — and each pair is
converted in one step rather than in two hops through kelvin, so 100 °C comes
back as exactly 212 °F instead of 211.99999999999994. US and imperial volumes
are separate units — there is no bare `gal`. Months and years are deliberately
absent from the time units, because they have no fixed length.

## What is deliberately refused

A refusal is a result: a readable string saying what cannot be answered and
why, not a thrown exception and not a confident number.

- `Evaluate` never calls `eval()` or `new Function()`. It is a hand-written
  tokenizer and precedence-climbing parser over a fixed grammar, and anything
  outside that grammar — a property access, a semicolon, a string literal, a
  hex literal — is refused with the character offset. Division by zero, and any
  step producing `NaN` or `Infinity`, is refused rather than returned. Names
  that exist only on `Object.prototype` (`__proto__`, `constructor`,
  `toString`) are unknown names, not functions.
- Percent change from zero, correlation of a constant series, a least-squares
  line through vertical points, an IRR for cashflows that never change sign, a
  temperature below absolute zero, a percentile the r6 convention does not
  define, an IQR rule on data whose interquartile range is zero.
- `NumberParse` validates grouping *before* stripping separators, so `1234.56`
  under `de-DE` is refused rather than read as 123456.
- `CurrencyConvert` has no network and no built-in rates. A live rate would make
  the answer depend on the minute it ran.
- `GeoPointInPolygon` refuses a ring spanning more than 180° of longitude
  instead of reading it inside-out across the antimeridian.
- A unit name that is not in the catalog, including one inherited from
  `Object.prototype`, and a non-finite radius, origin or bucket width —
  `Infinity` satisfies a plain number schema and would otherwise turn into a
  `null` where a number belongs.
- `NumberParse` refuses nested or unbalanced accounting parentheses; one pair
  means a negative, and `((1,234.50))` is not a number.
- `Percent` refuses an over-determined markup/margin square. Three of the four
  values fix it twice over, and the extra one used to be dropped in silence.

## What a detector can and cannot tell you

`Outliers` is the only tool here that looks for something rather than computing
it, so its result carries a `finding` sentence in both directions. An empty
list means no value crossed that fence at that threshold — it is **not** a
clean bill of health, because neither rule can see a shifted distribution, a
duplicated record, a wrong unit, or a cluster of errors large enough to drag
the bounds along with it. A flagged value is a candidate for review, not a
verdict: extreme values are often correct.

## Precision, honestly

Money, rounding and unit factors are exact decimal or rational arithmetic.
Statistics, regression, NPV/IRR and geodesy are IEEE-754 doubles, where sums use
Neumaier compensation and variance is two-pass so the result does not depend on
input order. `NumberFormat` and `NumberParse` are the one place where output
depends on something other than the input: the glyphs come from the runtime's
ICU/CLDR data, identical for a given runtime, not guaranteed across runtime
versions. That caveat is in the tool's own description too.

## The nonparametric kernel — a library, not a tool

`src/lib/stats-kernel.ts` is exported from the package root as `statsKernel`
and registers **no tool**. It is what CI gates import when they have to decide
something from a handful of noisy numbers:

| Function | The question |
|---|---|
| `mannWhitneyU` | Did this branch really get slower, or was the runner busy? |
| `wilsonScoreInterval` | How flaky is a test that failed 3 of 5 runs? |
| `cohensKappa` | Do two raters agree beyond what chance would give them? |
| `populationStabilityIndex`, `psiOverEdges`, `binCounts` | Has the input distribution moved? |
| `median`, `quantile`, `trimmedMean`, `medianAbsoluteDeviation` | Robust location and spread |
| `normalCdf`, `normalUpperTail`, `TWO_SIDED_Z` | The normal distribution underneath all of it |

Four things make it usable for a gate rather than for a report:

**`null` means "this data cannot answer this question".** Never `NaN`, never a
plausible number, never a throw for a degenerate-but-legal shape — no
observations, one observation, every value identical, every observation tied.
A throw is reserved for a caller bug: mismatched array lengths, a negative
count, bin edges that do not increase. Every nullable result says so in its
type, because a gate that reads `null` as `0` ships on no evidence.

**Three failures in five runs is not 60%.** It is `[0.231, 0.882]` at 95% —
a range that spans "mildly annoying" and "the test is broken" without telling
them apart. Quarantining on the point estimate is quarantining on noise.

**Every convention is named and pinned.** The quantile is R-7 (R's and NumPy's
default). The trimmed mean is R's `mean(x, trim=)`, cutting `floor(n·trim)` per
tail. Mann-Whitney carries the standard tie correction and a continuity
correction you can switch off. Each is pinned in `lib.test.ts` to a published
worked example or, for the Mann-Whitney small-sample case, to a brute-force
enumeration of the exact null distribution derived in the test itself.

**PSI takes its bin edges and its epsilon as arguments.** Edges, because PSI
only means anything when the *reference's* edges are reused for the current
data — a function that re-bins each sample by its own quantiles reports "no
drift" no matter how far the distribution moved. Epsilon, because it decides
the verdict: on one ten-bin comparison, `1e-3` gives PSI 0.47 ("significant"),
`1e-2` gives 0.22 ("moderate") and `0.05` gives 0.05 ("stable"). Same data,
three ship decisions. It has no default anywhere in the file.

The normal approximation to U stops being trustworthy below about eight
observations per sample, and `normalApproximationValid` says so: at five
versus five, fully separated, it reads p = 0.0122 where the exact test reads
0.0079.

## Layout

`src/lib/` holds the pure functions and is where the behaviour is tested;
`src/index.ts` wraps them as tools. A bug in `divideRound` reads better as a
failing unit than as a failing tool call. `src/lib/stats-kernel.ts` is the one
file with no tool above it — see the section above for why.

## Safety flags

All twenty-two are `readOnly`, non-destructive, `scope: "internal"`, and declare
no io capability, because none of them touches a file, a socket or a process.
`packages/tool-math/src/index.test.ts` asserts that for every tool, so a future
addition that quietly needs the network cannot slip in unnoticed.
