# @crewhaus/tool-kyc

Checking who you are about to pay or invoice, against public registers and
sanctions lists, with evidence you can still read a year later.

| Tool | Answers |
|---|---|
| `VatIdValidate` | is this VAT number real, whose is it, and what is the receipt |
| `EntityRegistryLookup` | what do GLEIF and SEC EDGAR say about this company |
| `SanctionsScreen` | which list entries look like this name, and on what basis |

## Three outcomes, not two

Every tool here reports **found**, **not-found** or **could-not-check**, and
the third one says why. There is no `valid` boolean anywhere in this package,
because a boolean has two values and this has three — and the collapse always
goes the same way.

It matters most at VIES. VIES does not hold the data; it forwards the question
to each member state's own system, and those systems go down individually, for
hours, routinely. VIES reports that as a service code with `isValid: false`
alongside it. A tool that reads the boolean gets "this VAT number is not
valid", and a harness then charges domestic VAT on an intra-community supply —
or refuses to zero-rate an invoice — because a government server was being
rebooted.

So every code VIES publishes is mapped explicitly, and a code we have never
seen becomes *could-not-check* with the code quoted, rather than a guess about
which side of the line it falls on. The same rule covers HTTP: a 500, a 429 or
a 403 is *could-not-check*. The only 404 that means anything about the subject
is HMRC's, which is documented to mean "not registered".

`syntaxOnly` fits the same grammar: the format is well-formed, and registration
reads as unchecked rather than as fine.

## SanctionsScreen returns signals and evidence, never a verdict

A sanctions match is a legal determination with legal consequences, and a
person makes it. This tool surfaces candidates, the basis for each, and the
version of every list it read.

That follows `@crewhaus/tool-money`, whose controls return signals and let the
caller decide — its refund check returns ratios and `null` rather than a
fabricated infinity, and says a person decides. The catalogue asked for a
score here; the shipped convention won.

**The evidence is the product.** The score is the least trustworthy part of the
answer: the lists carry transliterations of names never written in the Latin
alphabet, and aliases the publishers themselves mark as weak. What survives an
audit is not `0.87`, it is "OFAC SDN, version 20260917, published 2026-09-17,
retrieved 2026-09-17". So:

- `version`, `publishedAt` and `retrievedAt` are **required** on every
  snapshot, and a missing one refuses the screen rather than scoring it.
- A list older than `maxAgeDays` (30 by default) refuses the screen. "No
  matches" against a list from March is a sentence about March.
- A snapshot published after it was retrieved, or retrieved after the screen
  ran, refuses as well. Age is clamped at zero, so a mistyped year would
  otherwise report `ageDays: 0` and turn the freshness gate off permanently —
  a control that cannot be evaluated must not count as one that held.
- An empty list refuses too, because empty reads exactly like clean.
- One unusable list refuses the **whole** screen. Screening against the other
  three and reporting no candidates would be an answer with a hole in it that
  nothing in the output would show.
- No candidate over the threshold is reported as *not a clearance*, with the
  best near miss beside it.

Weak aliases are scored into their own bucket and never mixed in. Country and
date of birth corroborate for the person reading the result and never change a
score: most entries carry neither, so a mismatch would clear hardest on the
least complete — and oldest — entries.

**Nothing leaves the machine.** Screening runs against a snapshot you hold.
Sending a counterparty's name to a screening API discloses who you are about to
pay to somebody who did not need to know, and this tool has no endpoint to
disclose it to. The suite asserts that it never dials.

A snapshot is JSON:

```json
{
  "source": "OFAC SDN",
  "version": "20260917",
  "publishedAt": "2026-09-17T00:00:00Z",
  "retrievedAt": "2026-09-17T06:00:00Z",
  "entries": [
    {
      "id": "SDN-1",
      "name": "Mohammed Kharoubi",
      "kind": "person",
      "aliases": [{ "name": "Abu Mohammed", "quality": "weak" }],
      "countries": ["SY"],
      "programs": ["SDGT"]
    }
  ]
}
```

Refreshing it from the publishers is the operator's own step, and deliberately
outside this package — see *What this package does not do*.

## One matcher, not two

Jaro-Winkler, the token comparison and the Unicode hygiene come from
`@crewhaus/tool-text` — this package calls its `FuzzyMatch` and `NormalizeText`
tools rather than carrying a second copy, the way `@crewhaus/tool-token` calls
`tool-onchain` for EIP-55. Two matchers would be two answers to "how close are
these names", and they would disagree exactly where it costs most.

What this package adds is the part that is specific to names on a list:

- **Folding that a diff must not do.** Diacritics are folded, and so are the
  letters NFD cannot decompose (ø, đ, ł, æ, ß). For a diff, "resume" and
  "résumé" are two different files; for a name they are one person.
- **Legal forms dropped from company names**, and recorded — counting "ltd" as
  a shared token inflates every comparison between two British companies.
- **Token weighting from the lists themselves.** On a list where half the
  entries contain "mohammed", matching that token is worth almost nothing and a
  rare surname is worth almost everything. A flat token-set ratio scores them
  equally, which is what floods a queue with false positives on common given
  names while still missing the transliteration pairs.
- **Both directions.** A one-token subject aligns perfectly *into* any entry
  containing that token, so the entry's unmatched tokens have to cost something
  too.
- **A shortlist that can see containment.** The cheap first pass is a
  whole-string comparison, and Jaro-Winkler rewards a shared prefix: "Mohammed"
  against "Mohammed Kharoubi" scores 0.89 and "Kharoubi" against the same entry
  scores 0.35. A shortlist built on that alone answered "no candidates, no near
  miss" for a subject typed as his surname. So it is a union — whole-string
  similarity **plus** every entry sharing a token with the subject, rarest
  token first — and when the union fills its cap the result says so, in the
  note as well as in `prefilterTruncated`.
- **Invisible characters reported, not just removed.** A zero-width joiner
  inside a supplied name is how a name misses a list it should hit.

Every candidate carries which tokens aligned with which, and at what weight.
That is the match basis, and it is the part a reviewer can actually check.

## Two registers, never merged

`EntityRegistryLookup` returns one row per register, each with its own source
URL and retrieval time. It does not produce one confident record, because the
registers disagree about all of it — name spellings, suffixes, accents, number
formats — and above all about status:

- GLEIF's `entity.status` answers "is the company still there".
- GLEIF's `registration.status` answers "is the LEI paid up".

A LAPSED registration is overwhelmingly an unpaid renewal on a trading company.
Folding that into `dissolved` would hold a payment to a live supplier over a
renewal fee. Both travel, under their own names.

Two more details that are only obvious once they have cost you an afternoon:
EDGAR's CIK must be zero-padded to ten digits or the submissions document is a
404 that reads like "this company does not file", and EDGAR's *former* names
are what turn a name disagreement into a rename rather than into two companies.
The comparison block reports the name agreement with its basis and flags when a
former name explains it.

An LEI's check digits are verified before dialling, because GLEIF answers 404
for a mistyped LEI and that 404 reads like "this company has no LEI record" —
a different and much more interesting claim.

## The VAT grammar is a table

A generic "two letters then eight to twelve characters" check passes ids that
VIES then rejects: the worst of both, a local check that gives false confidence
and a remote call that was avoidable. The awkward ones are why the table
exists — Ireland's letter in the *middle*, the Netherlands' B fixed in position
ten, Spain's letter-or-digit at each end, and Greece filing under `EL` while
its ISO code is `GR`.

Check digits are computed for the UK only, in both variants in circulation.
The other member states have their own algorithms; rather than write
twenty-seven from memory, this reports `passed: null` and says so. A checksum
that reports a pass for everything turns "we did not check" into "we checked
and it was fine".

## What this package does not do

- **It does not ingest the published lists.** OFAC, the UN, the EU and OFSI
  publish XML and fixed-column CSV, in five different schemas with no shared
  id. A hand-rolled parser that silently drops entries produces a short list
  that looks complete, which is worse than no list — so this package parses
  neither, and takes the snapshot above instead. If ingestion is wanted, the
  parsers already exist as `@crewhaus/tool-data`'s `XmlParse` and `CsvParse`,
  reachable the same way this package reaches `tool-text`; what it needs on top
  is a recorded fixture per publisher, because a mis-read alias-quality field
  reports a weak match as a strong one and nothing downstream can tell.
- **It reads two registers, not four.** Companies House and OpenCorporates need
  an API key; GLEIF, EDGAR, VIES and HMRC do not, and no schema here accepts a
  credential.
- **EDGAR by name covers listed filers only**, through EDGAR's own ticker map,
  and each row says so. Not finding a company there is not evidence it does not
  exist.
- **A failed read of an INDEX is never a negative.** EDGAR's ticker map and
  GLEIF's legal-name search are things a lookup goes *through*, so a 404 on one
  of them means the file moved and nothing was ever looked up —
  `unavailable`, not "no such company". Only a 404 on a record URL (an LEI, a
  CIK submissions document) is the register saying it holds no such record.

## Nothing here moves money

No schema accepts a bank credential, a card number, an account or an amount,
and `index.test.ts` asserts that over every schema in the package — recursing
into nested fields, and asserting its own hit count so that a scan which
matched nothing cannot pass as a clean result. The only bytes that leave the
process are an identifier going to a public register.

## Testing

The network seam is `_setKycFetch`. Every test drives it, and nothing in the
suite resolves a name or opens a socket — the SSRF check and the connect-time
IP pin live *below* the seam, in the default dialler, so a test never depends
on DNS. `SanctionsScreen` has no seam to drive, and a test asserts it never
reaches for one.
