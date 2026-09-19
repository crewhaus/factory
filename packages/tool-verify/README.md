# @crewhaus/tool-verify

Did the thing actually work.

| Tool | Answers |
|---|---|
| `GoldenCompare` | did anything change that was not meant to |
| `GoldenUpdate` | accept this output as the new baseline |
| `ChecksumVerify` | is this the artifact I built, unchanged |
| `AcceptanceCheck` | is the task's definition of done met |
| `MarkdownLinkCheck` | do these docs point at anything real |
| `CitationLint` | does every claim have a source behind it |
| `FactCrossCheck` | does the cited source actually say it |
| `SeoLint` | is this page fit to publish, and what was not looked at |

These are the gates between doing something and claiming it is done. Each is
the kind of check a model performs plausibly and incompletely: it will read
four of the six links, or miss the one citation marker with nothing behind
it, and it will do so confidently.

## Normalization is the point, and it is visible

A golden file containing a timestamp, a temporary path or a generated id
fails on its second run and every run after. The usual response is to stop
using goldens. The better one is to mask the parts that are allowed to vary:
timestamps, durations, uuids, hashes, ports, absolute paths, ANSI escapes,
line endings and trailing whitespace, each opt-in.

**Every mask is reported with a count.** A normalizer that quietly rewrote
output would let a real regression hide inside a masked span, which is worse
than a golden that fails too often — and each rule is anchored tightly enough
not to eat the text beside it. `v1.2.3` is not a duration and `deadbeef` is
not a hash.

Absolute paths are replaced first, because a temporary directory carries
digits a later rule would mask, leaving the path unrecognisable.

## Failure modes are kept apart

A tool that collapses distinct problems into one boolean makes the caller
re-derive them:

- `ChecksumVerify` reports **missing**, **changed** and **unexpected** files
  separately. An unexpected extra file is how something ships that nobody
  meant to ship, and it is invisible in a simple "does everything listed
  still match".
- `AcceptanceCheck` reports every check's own verdict, so one failure does
  not hide the others and a pass is a list of things that were actually
  checked rather than an opinion.
- `CitationLint` separates a marker with no source from a source nobody
  cited. The first is a claim with nothing behind it; the second is usually
  only untidy. A caller can gate on the first alone.
- `SeoLint` returns four buckets — **errors**, **warnings**, **observations**
  and **notChecked** — and derives **passed** from what actually ran and
  withheld nothing, so a check that appears in `notChecked` never also
  appears in `passed`. A readability band is an observation and not a
  warning, because it is a measurement with a heuristic inside it rather
  than a defect.

## What it does not do

- **It does not run anything.** No commands, no test runners, no builds.
  Something else does the work; these decide whether it worked.
- **It does not fetch.** `MarkdownLinkCheck` resolves links against the
  filesystem and lists external ones as unchecked. A link checker that made
  requests would be a crawler, and would tell whoever is watching which
  documents are being reviewed. A link whose target is outside the workspace
  is reported rather than followed — including one that only leaves through a
  symlink, because `resolve` does not follow links and `statSync` does.
- **It does not judge quality, or truth.** Nothing here decides whether a
  claim is correct. `CitationLint` checks that a source exists;
  `FactCrossCheck` checks that the source contains the words of the claim
  citing it. Neither reads for meaning. `SeoLint` measures sentence and word
  length and reports a readability BAND, which is a measurement and not a
  verdict on the writing.
- **It does not consult schema.org.** `SeoLint` validates JSON-LD for shape
  and for the fields the rich results require, from a table it bundles. It
  cannot tell you whether a property name exists in the vocabulary, and it
  names every `@type` it has no bundled rule for instead of passing it.
- **It does not diff structurally.** `GoldenCompare` is line-based; a JSON
  document whose keys were reordered will differ. Normalize it first.

## A check that did not run is not a check that passed

This is the rule the whole package is built on, and `SeoLint` is where it
bites hardest. Three of its checks cannot always be made, and each says so
rather than returning the answer a passing page would have returned:

- **Near-duplicate** compares the page against a corpus of already-published
  pages. With no corpus configured — or one that exists and holds nothing
  readable — it reports `notChecked` with the reason. Degrading quietly to
  "no duplicate found" is the failure this check exists to prevent. When the
  page being linted lives in the corpus it is left out of the comparison: a
  page is not a near-duplicate of itself.
- **Keyword density** needs to know where one word ends and the next begins.
  For Chinese, Japanese, Thai, Lao, Khmer, Burmese and Tibetan there are no
  spaces to split on, so the check disables itself and says why instead of
  reporting a confident zero. The page's text decides this, not its `lang`
  attribute, which is a claim rather than a fact. `Intl.Segmenter` is
  deliberately not used: its output depends on the ICU data compiled into the
  runtime, and a gate whose answer moves with the runtime is not a gate.
  Where words ARE separated the match is made on word tokens, so a keyword
  the tokenizer cannot carry whole — "C++" arrives as the single word `c` —
  is reported under what was actually looked for, and a keyword with no
  letters or digits in it at all is `notChecked` rather than "does not
  appear".
- **Readability** is Flesch-Kincaid, whose coefficients were fitted on
  English, and whose syllable count is a heuristic with a long exception list.
  It declines for any other language, and it reports a BAND — never a number.
  A grade to two decimals invites writing against this tool's bugs rather than
  against readability, and that tuning would outlive the bug. The
  passive-voice and long-sentence figures have the same shape: without a
  part-of-speech tagger, "was" plus an "-ed" word over-fires on "was tired",
  so they are reported as candidates to read.

`ok` is therefore false whenever anything went unchecked, even when nothing
failed. A caller who wants a weaker gate reads `errors`; what it must not be
able to do is read a pass out of a run that never looked.

## Saying it and being true are different questions

`FactCrossCheck` locates a claim's words — or the exact span it puts in
quotation marks — inside the sources cited for it. That is all it does, and
every verdict is worded so it cannot be read as more:

- **supported** — the source contains the assertion. Not that it is true.
  When the claim puts something in quotation marks, that span is what was
  located and the words around it are the author's framing, so `mode` reads
  `quote` and the verdict covers the quotation alone.
- **misquoted** — the source has a nearly identical span, but not the words
  inside the quotation marks. The differing words are reported both ways, so
  "we expected" for "anyone expected" is visible rather than merely flagged.
- **polarityConflict** — every word is there and the span carrying them is
  negated where the claim is not. This is as close to "it says the opposite"
  as counting words can honestly get, and it is reported as something to read.
- **notFound** — the words could not be located. This is **not** a finding
  that the source disagrees, and not a finding that the claim is false; a
  different tense or a different spelling of a figure lands here too, which is
  why the words that were missing are always listed.
- **unreadable** / **unchecked** / **noSource** — no verdict was reached,
  with the reason named. A cited URL is unchecked, never fetched, and a source
  that could not be opened leaves the claim undetermined rather than
  unsupported: a claim is only reported as absent from its sources once every
  one of them was actually read.

`ok` is true only when every claim was located in a source that could be read.
A claim nobody could check is not a claim that passed — and neither is a claim
nobody looked at, so a run that stopped at its `limit` reports `truncated`,
`ok: false` and how many were left over, rather than a pass covering the ones
that fit.

A citation's destination is read the way a Markdown link's is: `./report.md`
and `./report.md#findings` name the same file, and `CitationLint` and
`MarkdownLinkCheck` ask the same two rules — where a source is declared, and
which file a destination names — so the three tools cannot disagree about what
a marker has behind it. The fragment itself is not honoured: narrowing the
search to one section would decide which span of a source a claim is allowed
to be in, and getting that wrong reports a source that does say the thing as
one that does not.

Two rules inside the matcher are narrow on purpose, because the generous
version of each would manufacture support. Only an unambiguous thousands
grouping is collapsed (`1,200,000` is `1200000`; `1.200` is left alone,
because a dot is a decimal point in one locale and a group separator in
another). And the only word-ending rule is a plural `s`, never stemming —
"completed" does not answer for "complete".

`GoldenUpdate` is the only tool here that writes. It overwrites a reviewed
baseline, so it is destructive and justification-gated, and it writes through
a temporary file and a rename — an interrupted run leaves the old golden
intact rather than a truncated one, which passes nothing and is easy to
mistake for a real diff.
