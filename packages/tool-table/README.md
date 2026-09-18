# @crewhaus/tool-table

Making a messy export usable.

| Tool | Answers |
|---|---|
| `TableProfile` | what is actually in this file |
| `DataDriftCheck` | has today's feed moved away from the baseline |
| `TableDiff` | what changed since yesterday's export |
| `RecordLinkage` | is this the same customer as that one |
| `ContactNormalize` | what do these identifiers look like canonically |
| `TableReshape` | pivot between wide and long |
| `TableShard` | split a file too big for one pass |
| `FixedWidthParse` | read a positional layout with no delimiter |

The first questions about any data file are always the same, and the usual
way to answer them is to read the first fifty rows into a context window and
guess. Fifty rows do not tell you that column nine is empty in the last
thousand, or that the id you were about to join on repeats.

Files are read here rather than passed in: a table worth these tools is one
too big to paste, which is the whole saving. CSV parsing comes from
`@crewhaus/tool-data` — two readers in one repository would disagree about
quoting and embedded newlines on the same file, in different tools.

## It refuses to guess where guessing is invisible

Each of these produces output that looks right when it is wrong, so each is
reported instead:

- **A duplicate key in a diff.** With a key that appears twice there is no
  fact about which row became which. Picking one produces a reconciliation
  that looks authoritative and is arbitrary.
- **A pivot collision.** Going long to wide, a repeated (identifier,
  variable) pair does not say which value wins. Silently taking the last
  makes a pivot that looks complete and is wrong in a way nothing downstream
  can detect.
- **A short line in a fixed-width file.** Padding it turns a truncated record
  into one with empty trailing fields, which read as real data.
- **A record matching two others.** That is a question, not two matches, so
  each record is used once and the leftovers are listed.

A candidate key must be unique **and** complete: a column with distinct
values and some nulls cannot key a join, and offering it would be worse than
offering nothing.

## Matching carries its evidence

`RecordLinkage` returns, for every accepted pair, which field matched and how
closely. "These are the same person" is a claim somebody will have to defend,
and a bare score cannot be defended. Pairs above the review floor but below
the accept floor come back separately rather than being decided.

Rules can normalize before comparing, with the same canonicalization
`ContactNormalize` applies — without it, "Dr Jane Smith" and "Smith Jane"
score far apart on an edit distance while obviously being the same person.

Gmail's dots and `+tags` fold **only** for Gmail-family domains, because they
are a Gmail feature and not a rule of email: treating `a.b@other.com` as
`ab@other.com` merges two different people. A phone number with no country
code stays national and says so rather than being given one. Every fold is
named, and the original is never discarded.

## Bounds are on the work, not on a proxy for it

Edit distance is quadratic in the length of what it compares, so the real
cost of a linkage run is comparisons **times** length squared. A cap on the
number of comparisons alone bounds the wrong quantity: thirty records against
thirty, with three-thousand-character values, is only nine hundred
comparisons and took forty-five seconds. Fuzzy comparison looks at the first
256 characters, which is far more than the names, companies and addresses
this exists to match, and the same run now takes four milliseconds.

Pivoting on a high-cardinality column is refused rather than answered — an id
or a timestamp gives a column per row, which is a table nobody can read
rather than an error anybody notices. And `TableShard` returns the plan
without the shard bodies once they exceed a few megabytes, because returning
them at that size is not a result, it is the file again.

## Positions are 1-based and inclusive

`FixedWidthParse` takes the positions exactly as a layout document, copybook
or mainframe spec states them. Converting in your head is how a field ends up
one character off down the whole file.

## Drift, and the one thing a baseline has to carry

`DataDriftCheck` compares today's file against a `TableProfile` taken earlier
and reports schema drift, distribution shift, null-rate and cardinality jumps,
categories that are new today, and the row-count ratio.

The Population Stability Index at the centre of it is only meaningful when
today's numbers are binned against the **baseline's** bin edges. Bin each side
against its own quantiles and both come back as ten deciles of ten percent, so
the index reads near zero however far the data moved — and that is not an edge
case, it is what happens every time. In this package's own tests, a column
moved bodily from 0-100 to 500-600 scores **11.46** against the stored edges
and **exactly 0** against fresh ones.

So the edges are captured when the baseline is taken, and cannot be recovered
afterwards:

```
TableProfile { file: "month.csv", driftProfile: {} }   # stores edges, category
                                                       # counts and a value sample
DataDriftCheck { referenceProfile: "month.json", file: "today.csv", epsilon: 1e-3 }
```

A baseline profiled without `driftProfile` is **refused**, with the command
that fixes it, rather than answered from edges derived on the spot. So is a
column whose two sides were somehow binned differently.

`driftProfile` is opt-in because the capture is machine fodder — a 500-value
sample per numeric column makes the answer a person asked for worse. A profile
taken without it is byte-for-byte what it always was.

## Epsilon is an input, not a constant

An empty bin makes the PSI log term infinite, so an empty bin's share is
floored at `epsilon`. That floor decides the verdict. For a ten-bin baseline
where one bin empties out:

| epsilon | PSI | band |
|---|---|---|
| 0.001 | 0.4664 | significant |
| 0.01 | 0.2178 | moderate |
| 0.05 | 0.0452 | stable |

Three ship decisions from one dataset. `epsilon` is therefore a **required**
input with no default anywhere in the stack, it is echoed in the result, and a
PSI that leaned on the floor says so. Put it in the same config as the
threshold it is compared against.

Values beyond the baseline's range get their own two bins rather than being
clamped into the end ones: a distribution that walked off the edge of the chart
is the loudest drift signal there is, and clamping is how it reads as stable.

## What the drift check refuses to say

- **New categories, when the stored list was capped.** With a truncated list
  there is no telling a genuinely new value from one that was always there and
  merely rare. "Three new payment methods appeared" is a sentence somebody
  acts on, so a wrong one is worse than none.
- **A p-value the approximation does not support.** The rank test carries the
  kernel's own `normalApproximationValid`, and an invalid p cannot trip the
  `pValue` gate — below eight values a side it is a rank ordering, not a rate.
  The chi-square carries Cochran's condition for the same reason.
- **A distribution comparison across a type flip.** A column that arrives as
  numbers and returns as labels is reported as `kindChanged`; its null rate and
  cardinality are still compared, because those still mean something.
- **Anything, when `failOn` is absent.** `gate.ok` is then true because nothing
  was checked, and it says so in as many words.
- **A comparison across a repeated header.** Two columns with one name give no
  fact about which is which, so they are named in the notes and left
  uncompared rather than matched to whichever came last.

A refusal is not a pass. Every threshold above that could not be evaluated —
PSI on a column that stopped parsing, new categories on a capped list, a p the
approximation does not support, any per-column gate on a column that vanished
or whose name repeats — lands in `gate.unchecked`, and `gate.ok` is **false**
while that list is non-empty. `failures` still means "measured and breached",
so the two are told apart; `unchecked` means the gate never got to look, which
is the one thing "ok" must never be allowed to mean.

Statistics come from `@crewhaus/tool-math`'s kernel — Mann-Whitney, PSI and the
normal tail live there for the whole repository. The chi-square test of
homogeneity and its incomplete-gamma tail are the one piece that was not
already there; the df=1 case is pinned against that kernel's normal tail, which
is an exact identity and so an independent oracle.

One JSON wrinkle worth knowing: the out-of-range bins are bounded by infinity,
and `JSON.stringify` turns those into `null`. The bin's `label` (`"(-inf, 0)"`,
`"[99, +inf)"`) is the field to read.

## What it does not do

- **It does not write.** Everything here reads; `TableShard` returns the
  shard bodies and the caller writes them.
- **It does not query.** For selection, aggregation and joins there are
  `jsonQuery`, `tableQuery` and `tableAggregate` in `@crewhaus/tool-data`,
  and `sqlQuery` in `@crewhaus/tool-sql`.
- **It does not read Parquet, ORC, Avro or Excel.** Delimited text and fixed
  width only; `xlsxRead` in `@crewhaus/tool-docs` handles spreadsheets.
- **It does not clean data.** Nothing here corrects a value, fills a null or
  resolves an inconsistency — it tells you they are there.
- **It does not explain drift.** `DataDriftCheck` says which column moved and
  by how much. Why it moved is upstream of here.
