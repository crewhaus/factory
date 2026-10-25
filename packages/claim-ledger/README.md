# @crewhaus/claim-ledger

The one text layer every claim checker reads: what a document claims, what each claim cites, what
kind of evidence a citation names, whether a source says the claim's words, and which values a
claim states. It has no dependencies and makes no model call; every answer is a function of the
characters.

It exists because the same heuristics used to live in three places. tool-verify had the citation
grammar, the sentence splitter and the FactCrossCheck kernel; grader-continuity had the content
tokens and coverage; grader-12-metric-rubric carried a byte-for-byte copy of those because it
could not declare the dependency. Two copies of a marker pattern drift, and then one tool checks a
claim the other never saw. The 0.8.0 provability gate had to see exactly the claims and markers
those tools see, so the text layer got one owner. The move was behaviour-neutral: tool-verify, the
continuity graders and the faithfulness graders import from here and their tests did not change.

```ts
import {
  citationDefinitions,
  classifyDefinition,
  extractClaims,
  indexSource,
  locateClaim,
} from "@crewhaus/claim-ledger";

const answer = "The refund window is 14 days [1].\n\n[1]: https://acme.example/policy";
const sources = citationDefinitions(answer);
for (const claim of extractClaims(answer)) {
  for (const marker of claim.markers) {
    const ref = classifyDefinition(sources.get(marker) ?? ""); // { kind: "url", url: "https://…" }
    const body = fetchedBody(ref); // yours: the page this run actually read, if it read one
    const found = locateClaim(claim.text, indexSource(body), { coverage: 0.8 });
    // found.status: "supported" | "misquoted" | "polarityConflict" | "notFound"
  }
}
```

## What it owns

| Module | What it answers |
|---|---|
| `citations.ts` | The marker grammar (`[1]`, `[^a]`, `[A1]`) and the definition grammar (`[1]: source`, also with the source on the next line). `lintCitations`, `citationDefinitions`, `citedClaims`. The two patterns are module-private, so they have exactly one definition. |
| `claims.ts` | `extractClaims`: every declarative, non-question sentence that cites something, states a number (a numeral, or a number word other than "one") or has at least `MIN_CLAIM_TOKENS` content words. Code, title headings and definition lines are not claims (a definition-shaped line whose text nothing else reads is, below). A heading is a claim when it cites a source for a figure or a claim's words (`## The refund window is 30 days [1]`), states a measured value after a label (`## Invoice total: 1,284.50`, never a count such as `## Part 2: 5 tips` or a list's label such as `## Step 3: 10 minutes`), or is a sentence stating a figure with any finite verb (`## The invoice total is 1,284.60`, `### No two of the six meetings overlap`, `## Refunds close after 30 days`, `## Refund window extended to 30 days`, `## AWS accounted for 17% of revenue`, `## iPhone 15 costs $799`; not a noun phrase such as `## Shipping costs for 2024`, `## Revenue earned in 2024` or `## Changes to 2 policies`, or an imperative such as `## Cut costs by 30%`) — whatever else the answer says or asks — or is all an answer says. Uncited claims come back with `markers: []`, which is what a `cited` floor refuses. |
| `markdown.ts` | Code spans, line lookup and link destinations. Two fence readers: `fencedSpans`, the citation grammar's, and `commonMarkFences`, the stricter one the claim extractor reads. |
| `refs.ts` | `classifyDefinition`: the evidence-reference grammar. A source is a `url`, `doi`, `path` (with its `#fragment`; `%23` and `%25` in a path are `#` and `%`, so `./x%23y.md` names `x#y.md`), `tool:<toolUseId>`, `proof:<prf_id>`, `assume:<text>`, or free `text`. `definitionGloss`: the text a definition line shows past what it names. |
| `locate.ts` | The FactCrossCheck kernel. `indexSource` a body once, then `locateClaim` returns `supported`, `misquoted`, `polarityConflict` or `notFound`, along with the excerpt, line, coverage and a `cause`. `isWaivableMiss` says whether the gate's judge may be asked about a miss. `governingNegation` and `clauseNumbers` scope a negation to the words it denies. |
| `numbers.ts` | `extractNumbers` and `containsValue` compare values as exact decimals, so `1,284.50`, `1284.50` and `1284.5` are one value, and an ISO date or a time of day as a whole value too (`compoundValues`). `figureWord` reads number words for the locate kernel's figure rule. |
| `fold.ts` | `foldText`, the one character-for-character fold every comparison reads through (`foldTypography` in the locate kernel, and the number layer): curly quotes, a digit of any script, fullwidth and mathematical letters, a Cyrillic or Greek lookalike inside a Latin word, and an ignorable character hidden in a word. |
| `quotes.ts` | `quotedSpans` and `containsQuote`, the `checked` rung's quotations. |
| `tokens.ts`, `sentences.ts`, `messages.ts` | The graders' measure: `contentTokens`, `coverage`, the transcript splitter `sentences`, `claimSentences` and `messageText`. Their thresholds were set against exactly these. |

## Things worth knowing

**`coverage` is a parameter, and a figure never counts as covered.** FactCrossCheck locates a
claim at `coverage: 1`, every word in one window, as it always has. The provability gate passes
its `grounded.coverage`, which defaults to 0.8. Below 1 the figure rule applies (`strictFigures`,
which a gate at `coverage: 1` passes explicitly): some of a claim's words may be missing, but never
a figure and never a negation the claim makes. Without it, "the refund window is 30 days" would
clear 0.8 against a source that says 14. A figure is a numeral, compared by value (`$1,284.50` is
the source's `1284.5`; `12%` is not `12`) and with its sign (`500` is not `-500` or `−500`), a
cardinal word (`thirty` is `30`), an ordinal (`third`; a list-counting "First," at the start of a
claim is not one, and "second" is left out because it is a unit of time as often as a rank), or a
magnitude glued to a numeral (`$5M` is `$5 million` and not `$5B`; `k`, `m`, `mn`, `b`, `bn` and
`t`, read without case, so a claim's `5m` of metres misses a source's `5 metres` rather than
matching a wrong figure). An ISO date and a time of day must also sit in the span whole:
`2025-03-04` is not the source's `2025-04-03`, and `10:30` is not the `10` of `10:00` and the `30`
of `18:30`. A missing figure comes back as `notFound` with
`cause: "value"`, a missing negation with `cause: "negation"`, and either one wins over
`coverage` even when the claim's other words fall short too. A negation that opens the source's
statement, just before the span that carries the claim's words, is the span's own: "No two of the
six meetings overlap" is a `polarityConflict` for "two of the six meetings overlap", though every
word of the claim is there. At `coverage: 1` without the rule,
the status and detail are FactCrossCheck's, but a miss whose missing words hold a figure or a
negation still has that cause. Only `cause: "coverage"` is a paraphrase miss: ask
`isWaivableMiss(location)` before handing one to the waiver judge.

**A quotation is checked verbatim.** A claim that puts four or more words in double quotes is
checked by those words, in order, and `coverage` does not loosen that. A near-identical span is
reported as `misquoted`, with what the source actually wrote. Under the figure rule the framing
around a quotation is read for figures and negations too. `The window is 30 days, since "customers
may request a refund".` is a `value` miss against a source that says 14, because each figure the
framing states must sit within `windowTokens` of the quotation. A quoted numeral keeps its sign
under the rule: `"the balance is 500 dollars"` is a misquote of a source that says -500.

**`extractClaims` and `citedClaims` agree on plain prose and differ on purpose elsewhere.** Both use
the same splitter, marker constant and `plainClaim`, and every marker `citedClaims` gives a
declarative sentence is a marker of some extracted claim. `extractClaims` also reads code as a
CommonMark renderer does, list items included (`- ```js` opens a fence, and an item's end closes
one), cuts fenced code and definition lines out of a sentence, gives a marker written after the
full stop (`text. [1]`, `text.[1]`, or `text.[1][2]`, a reference link whose one marker is `[2]`)
to the sentence before it — a run only of citation ids, so `[Stripe][2] charges…` keeps its marker
— leaves out only the question at the end of a piece the splitter ran on (`…30 days [1]` then
`Anything else?` on the next line, `…30 days.Anything else?`, `…30 days.want it?`, a no-break space,
`<br>` or U+2028 after the full stop, an ellipsis, and a claim ending in a dotted name such as
`policy.md.Anything else?` keep their claim; a question wrapped onto a line that opens lowercase,
with no marker or figure before the break, stays one question, and so does a clarifying question
holding a dotted name such as `Array.Sort?`), cuts a claim from a question in the same sentence
after the last clause that holds a marker or a figure (`…30 days [1] — anything else?`, `…1,284.60;
want the PDF?`, `…30 days [1], right?`, a table row ending in a question) unless the sentence opens
as one (`Is it 30 days, or 14?`) — after an acknowledgement (`Got it — 2 seats, correct?`) a figure
clause is left to the question only when it is a restatement of figures and the nouns they count,
so `Sure — refunds close after 30 days, anything else?` is a claim whatever its verb, and so is `Sure — that comes to $1,386.26, want the invoice?` (a demonstrative or quantifier before a verb is a subject, not an article) — reads a question the answer answers itself (`…30 days? Yes.`) as a
claim, treats a numbered list's `1.` as a bullet rather than a sentence (and, as CommonMark does, an
indented `14.` that cannot interrupt a list item's paragraph as that paragraph's text), splits at a
block quote opening under a paragraph, reads a heading only where a line is one (indented
or inside a list item too) and never lets it take the line under it, counts a cited or
figure-bearing line of inline code as a claim, and reports the line where the claim's first
character sits. Every difference leans toward reading
a sentence, because one the extractor skips is one the gate passes unread. `citedClaims` keeps its
older sentence extraction, so the claims FactCrossCheck reads from a document do not move; its
matching reads through the fold below. The tests pin both.

**A definition line is a claim only when nothing else reads what it shows.** The definition
`citationDefinitions` keeps for its id is never one, whatever follows its destination:
`[8]: https://… Payments clear within 5 days` renders as that sentence, and the provability gate
reads it (`definitionGloss`) as claims citing `[8]`. A definition that shows nothing past what it
names (a destination and at most a link title) is never one either. Every other definition-shaped
line that shows text is read as the prose it renders as, uncited: a second `[8]:` line, which
`citationDefinitions` does not keep, and a bulleted `- [8]: …`, which it never counts. Otherwise
a sentence in front of the reader would pass unread. `bibliographic: true` makes a free-text
source the reference, as the gate's `sources.bibliographic` does.

**A negation governs the words right after it, not the sentence.** `governingNegation` finds the
negation that denies one word: before it, in the same clause, at most two words between and no
copula among them ("is not 1,284.50", "did not exceed 40"). "No" denies only the word after it,
and "no-fee" and "not only" deny nothing. "No discount was applied, so the total is 1,284.50"
states the total. The `checked` rung reads a figure's polarity this way, and it errs toward
"not denied" where a parser might say otherwise.

**Numbers are only read where the reading is certain.** `1,5`, `1.284,50`, `v1.2.3` and
`10.0.0.1` are not numbers here. Nothing is guessed: a version and a figure in another locale
are left out rather than read as the wrong value. A digit of any script is its digit (`٣٠`, `３０`
and `𝟑𝟎` are 30), because a figure the number layer could not read was a figure nothing checked.
An ISO date (`2025-04-03`) and a time of day (`10:30`, `09:05:00`) are values whole as well as
their parts, so a result that says `2025-04-03` does not contain a claim's `2025-03-04`. Both ends
of a time range or a date interval are values (`10:00-11:30` states 11:30), and a UTC offset is
not a time of day. A slash date, a ratio and a numeric range are read as their parts only: which
is the day, or whether `3:1` is a score, would be a guess.

**What the reader cannot tell apart is one spelling.** Every comparison reads through `foldText`:
`not` with a zero-width space inside it, `ｎｏｔ` and a `nоt` with a Cyrillic `о` are the negation `not`, and a numeral no fold
reads as digits (`㉚`, `½`) is a figure compared as written. The fold keeps every length, so the
offsets the kernel reports are the text's own, and an excerpt is cut from the text as written —
`٣٠` stays `٣٠`, a Persian joiner stays where it stands — widened to the whole word where the fold
moved an invisible character inside one (`writtenSpan`). A word wholly in Cyrillic or Greek letters is left
as written, even one that looks like a Latin word or a number.

## The two token measures

`contentTokens` (a `Set` of ASCII words of three or more letters, with a broad stopword list) asks
"is this about the same thing?" and is what the graders score with. `claimWords` (Unicode words,
numbers with their separators and `%`, negations kept, a short stopword list) asks "does the source
say these words?" and is what the locate kernel compares. tool-verify still exports `claimWords` as
`contentTokens` from its `lib/spans.ts`, the name it had there.

Design: [design/0.8.0-provability-release.md](../../design/0.8.0-provability-release.md) §4.1, §6.2.
