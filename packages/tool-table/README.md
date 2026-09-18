# @crewhaus/tool-table

Making a messy export usable.

| Tool | Answers |
|---|---|
| `TableProfile` | what is actually in this file |
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
