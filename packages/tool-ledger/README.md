# @crewhaus/tool-ledger

A local double-entry ledger, and the reports and reconciliation that make one
usable.

| Tool | Answers |
|---|---|
| `LedgerPost` | record these entries, or say exactly why not |
| `LedgerQuery` | what is the balance, the P&L, the sheet, the aging, the chain |
| `LedgerReconcile` | which of these rows are the same event, and which are not |
| `InvoiceRender` | produce a numbered document, with the totals computed |

Storage is `bun:sqlite`, which is built into Bun. There are no runtime
dependencies outside the workspace.

## Nothing here moves money

Nothing in this package opens a socket. No schema in it accepts an account
number, a card, a routing number, an API key or any other credential —
`index.test.ts` walks every schema and asserts that, and scans every source
file for anything that could dial out, and both checks assert their own hit
count so a scan that matched nothing cannot pass as a clean result.

An invoice is rendered to a file under the workspace. A reconciliation returns
entries a person could post. Sending a payment instruction is a different job,
in a different package, with different gates.

## Debits equal credits, or the entry does not post

That is the whole of double entry, and a ledger that accepts an unbalanced
entry is not a ledger with a small error in it — it is a pile of rows, and
every report over it is unfalsifiable. So the check happens at POST time and
an unbalanced entry is rejected with the difference named. One rejected entry
does not stop the rest of the batch; each rejection carries its index and its
reason.

Also refused, each with a reason rather than a correction: a negative debit
(it is a credit, so write it as one), a zero line, a line carrying both sides,
an entry with fewer than two lines, an amount whose decimals the currency
cannot hold (`1.005` as USD is not `1.01`, it is a caller who has not
decided), a date that does not exist, an account not in the chart, and a date
inside a locked period.

## Amounts are never JS floats

Decimal strings in, integer minor units out, bigints in between. The
arithmetic and the ISO 4217 exponent table come from `@crewhaus/tool-math`'s
money kernel — one table, so JPY has no cents and a Gulf dinar has three
decimal places. An unknown currency code is refused rather than assumed to
have two.

Amounts are stored as TEXT holding a bigint's digits. SQLite would take them
as INTEGER, but `bun:sqlite` hands an INTEGER column back as a JS number and
`SUM()` silently promotes a 64-bit overflow to a float. Totals are therefore
summed here, exactly.

## The one transaction

A posting is three writes that are only correct together:

1. the entry and line rows,
2. the hash chain's new head,
3. the idempotency claim that says this batch has been seen.

Commit them separately and there is a window in which a crash leaves a ledger
whose chain **verifies perfectly** and whose duplicate suppression has
forgotten the entry — so the retry posts the same payment a second time, and
every check anybody runs says the books are fine. All three go inside one
`BEGIN IMMEDIATE` transaction, following `@crewhaus/durable-state`'s pattern:
`IMMEDIATE` takes the write lock at `BEGIN` rather than at the first write, so
the read half (is this key claimed? what is the head?) serializes against
another writer instead of racing it, and `busy_timeout` makes the loser wait
rather than fail instantly.

`dryRun` is the same code path, rolled back on purpose. A separate "check
only" path is how a dry run comes back clean and the real call fails.

Invoice numbering has the same shape from the other side. Allocate the number
and then write the file, and a crash in between burns a number out of a
sequence that is legally required not to have gaps; write the file and then
allocate, and two concurrent calls issue one number twice. So the number and
the document record — including the hash of everything that determines the
rendered bytes — are allocated in one transaction, and the render happens
after. If the render dies, repeating the call with the same idempotency key
returns the **same number** and re-renders the **same bytes**. And because a
bad template is found at render time, the render is proved once against a
provisional number before the sequence is touched at all.

## Multi-currency: rounding is bounded

An entry with a foreign line balances in the base currency after conversion,
and conversions round, so a residue of a minor unit or two is arithmetic and
goes to the configured `fxAccount`. A residue of nine hundred is not rounding;
it is a rate entered as 1.09 instead of 0.91. So the residue is capped at one
minor unit per converted line — the most rounding can produce — and anything
larger is refused with both numbers in the message. Booking it to "FX
rounding" would hide a real loss in the one account nobody reads.

With no `fxAccount` configured, a residue is a refusal rather than an extra
cent added to whichever line happened to be last.

## A tolerance does not widen matching

`LedgerReconcile` reports **matched**, **unmatched on each side**, and **near
misses** as three separate lists. A match requires the amounts to be *equal*.
The tolerance defines the near-miss radius: a 100.00 and a 100.01 come back as
a near miss for a person to look at, and both rows stay unmatched.

This is the opposite of what most reconcilers do, and it is the reason this
one is worth running unattended. Those two rows are two facts that disagree by
a penny; pairing them destroys the only evidence that anything is wrong. For
the same reason, a matching *reference* with a different amount is a near miss
rather than a match — that pair is the most interesting row in the file.

Bundled payouts are found by a bounded subset-sum. Several different bundles
of charges routinely add up to the same payout, so the search walks subsets by
ascending size and then lexicographically over a pool sorted by (date, id) and
takes the first exact hit: the same bundle is chosen on every rerun, and the
fee entry proposed next to it does not move. The search is capped, and a row
it gave up on is named in `groupingTruncated` rather than reported as
unmatched.

Rows on both sides use `@crewhaus/tool-money`'s `Transaction` — the shape
`StatementParse` produces — imported rather than re-declared. A side with
`kind: "statement"` is read through tool-money's own parser, so a file whose
dates could be day-first or month-first is refused there too.

## Aging refuses rather than answering partially

Aging needs a `counterparty` and a `dueDate` on the lines it ages, and an
explicit `asOf`. Without a due date, every amount lands in "current" and the
report says nothing is overdue — an answer that looks like an answer. So:

- no `asOf` is a refusal (the clock would make the same ledger produce a
  different report tomorrow, and an aging report is a document somebody
  files);
- `asOf` narrows the selection as well as labelling it, as it does on a
  balance sheet: an aging as of June does not include an invoice dated August,
  which would otherwise land in "current" and inflate what a counterparty
  owes;
- no `accounts` is a refusal (ageing every account produces a table with no
  meaning);
- a line with no `counterparty` is a refusal, naming the field and the count;
- *no* line carrying a `dueDate` is a refusal.

Lines that do have a counterparty but no due date are payments and credits.
They are reported as `unapplied` against that counterparty rather than folded
into "current", where they would quietly cancel an overdue invoice.

## Signs come from the chart of accounts

A trial balance says `balanced: true` or `false` only when the selection holds
whole entries. Filtering by account, counterparty, text or amount keeps one leg
and drops the other, so the totals cannot pair up; `balanced` is `null` there
with a note saying why, because `false` would read as "somebody edited the
file" about a caller who typed a filter.

Whether a balance reads positive depends on the account's normal side, which
is a property of the account, not of the query. A report that decides it from
the account's *name* is wrong the first time somebody books a contra account.
`autoCreateAccounts` is off by default for the same reason: an auto-created
account's type is guessed from the numbering convention, and reports sign
their sums by that field.

## Invoice totals add up on the page

The four figures a document shows are `subtotal`, `discount`, `tax` and
`total`, and they satisfy the sum a reader will do on them:

```
subtotal − discount + tax = total
```

So `subtotal` is the lines *before* discount. Reporting the net there leaves
every individual figure defensible and the document as a whole wrong — 90.00
less 10.00 plus 18.00 is not the 108.00 printed at the bottom, and the first
person to check the arithmetic is the customer being asked to pay it. The
after-discount figure is carried as `net` for anyone who wants it without
subtracting, and the lines' own `total` column sums to the same `total`.

A document number is also a file name. It is constrained to letters, digits,
`.`, `-` and `_`, whether it came from `number` or from `numbering.prefix`,
and the check runs before the sequence is touched — so a number that would
walk out of `outDir` is a refusal rather than a burnt number and an
overwritten file somewhere else. `gapFree` comes back `null`, never `true`,
for a number the caller assigned: there is no sequence there to check, and a
gap in a document sequence is a finding.

## Invoice bytes do not move

`Intl.NumberFormat` output varies with the ICU version the runtime was built
against, so the same invoice can render differently on a laptop and in CI — on
a document somebody files. This package has no locale formatter at all.
Amounts are rendered from exact decimal strings with separators the caller
names; dates are ISO. The yearly sequence reset takes its year from
`issueDate`, never from the clock, so a document back-dated across New Year
lands in the right sequence.

The template is logic-less: variables, array sections, inverted sections.
Nothing computes, because a template that can compute can compute a total, and
totals come from the line data. Only arrays iterate — a plain object would
iterate in insertion order, and that is not a property of the document. An
unknown placeholder is refused by default rather than rendered as a blank: a
mistyped `{{seller.taxId}}` would drop the VAT number off the invoice and
nothing would say so.

## The chain, and what it can and cannot tell you

Each entry hashes its predecessor's hash together with a canonical
serialization of the entry and all of its lines, so editing a memo or an
amount after the fact is detectable. `LedgerQuery view: "chain"` walks it and
reports **every** break rather than the first — "entries 4, 900 and 901" and
"entry 4" are different findings.

The head is stored as well as derivable, because a prefix of a valid chain is
itself a valid chain: recomputing the head cannot tell a complete ledger from
a truncated one, and the recorded head and length can.

What this is not, in two parts. The file is on disk and whoever can write it
can rewrite the whole chain from any point: tamper-**evident** against an
edit, not tamper-proof against an author. For that, publish the head somewhere
the same person cannot write. And the chain covers the entries and their
lines — not the chart of accounts. An account's *type* is outside the hash, so
re-typing one from income to expense turns a P&L over and the chain still
reports `ok`. The `chain` view says so in its notes; check account types
against your own record separately.

## Bounds

Everything that can grow is capped, and hitting a cap is said rather than
silently truncating: 500 entries per post, 200 lines per entry, 200 000 lines
scanned by one query (past that it refuses and names the range to narrow),
20 000 rows per reconciliation side, 64 MB per statement file, 256 KB per
template.

## Testing

`bun test packages/tool-ledger`. Nothing in the suite opens a socket or reads
a wall clock — `_setClock` is the one seam, because `postedAt` is inside the
hash chain. The transaction guarantees are tested by aborting inside the
transaction and asserting the rows, the head *and* the claim all rolled back,
and by holding the write lock on a second connection and asserting the failure
names the lock rather than merely happening.
