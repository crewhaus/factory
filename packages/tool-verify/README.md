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

## What it does not do

- **It does not run anything.** No commands, no test runners, no builds.
  Something else does the work; these decide whether it worked.
- **It does not fetch.** `MarkdownLinkCheck` resolves links against the
  filesystem and lists external ones as unchecked. A link checker that made
  requests would be a crawler, and would tell whoever is watching which
  documents are being reviewed. A link whose target is outside the workspace
  is reported rather than followed.
- **It does not judge quality.** Nothing scores prose, and `CitationLint`
  checks that a source exists, never that it says what the sentence claims.
- **It does not diff structurally.** `GoldenCompare` is line-based; a JSON
  document whose keys were reordered will differ. Normalize it first.

`GoldenUpdate` is the only tool here that writes. It overwrites a reviewed
baseline, so it is destructive and justification-gated, and it writes through
a temporary file and a rename — an interrupted run leaves the old golden
intact rather than a truncated one, which passes nothing and is easy to
mistake for a real diff.
