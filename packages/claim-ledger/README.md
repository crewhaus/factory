# @crewhaus/claim-ledger

The one text layer every claim checker reads: what a document claims, what each claim cites, what
kind of evidence a citation names, whether a source says the claim's words, and which values a
claim states. It has no dependencies and makes no model call; every answer is a function of the
characters.

It exists because the same heuristics used to live in three places. tool-verify had the citation
grammar, the sentence splitter and the FactCrossCheck kernel; grader-continuity had the content
tokens and coverage; grader-12-metric-rubric carried a byte-for-byte copy of those because it
could not declare the dependency. Two copies of a marker pattern drift, and then one tool checks a
claim the other never saw. The provability gate has to see exactly the claims and markers those
tools see, so the text layer got one owner. tool-verify, the continuity graders and the
faithfulness graders import from here, and on plain-ASCII text they behave as they did before the
move. The one change is the fold (below): `FactCrossCheck` now reads a lookalike character as the
plain one.

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

## API

| Module | Exports |
|---|---|
| `claims.ts` | `extractClaims(text, { minTokens?, bibliographic? }): ExtractedClaim[]`, each `{ index, text, raw, line, markers }`. Every declarative, non-question sentence that carries a marker, states a number, or has at least `MIN_CLAIM_TOKENS` (3) content words. Uncited claims come back with `markers: []`, which is what a `cited` floor refuses. |
| `citations.ts` | The marker grammar (`[1]`, `[^a]`, `[A1]`) and the definition grammar (`[1]: source`, the source also allowed on the next line). `lintCitations(text): CitationReport` (`markers`, `defined`, `undefinedMarkers`, `uncited`, `ok`), `citationDefinitions(text): Map<id, source>` (first definition wins), `citationMarkers(text)`, `citedClaims(text)`, `plainClaim(sentence)`. The two patterns are module-private, so they have exactly one definition. |
| `refs.ts` | `classifyDefinition(source): EvidenceRef`, the evidence-reference grammar: `url`, `doi` (`doi:` or a bare `10.x/…`), `path` (with its `fragment`; `%23` and `%25` decode to `#` and `%`), `tool` (`tool:<toolUseId>`), `proof` (`proof:prf_…`), `assume` (`assume: <text>`), or free `text`. `definitionGloss(source, ref, bibliographic?)`: the text a definition line shows past what it names. `isAssumptionMarker(id)`. |
| `locate.ts` | The FactCrossCheck kernel. `indexSource(text): SourceIndex` once per body, `claimQuery(text): ClaimQuery`, then `locateClaim(claim, source, { coverage?, windowTokens?, strictFigures?, maxExcerptChars? }): Location` (`status`, `mode`, `cause`, `matched`, `total`, `coverage`, and `missing`, `differing`, `line`, `excerpt` where they apply). `isWaivableMiss(location)`, `governingNegation(index, at)`, `clauseNumbers(index)`, `claimWords(text)`, `foldTypography(text)`, `writtenSpan`, and the constants `DEFAULT_WINDOW_TOKENS` (60), `MAX_EXCERPT_CHARS` (240), `QUOTE_MIN_TOKENS` (4), `NEGATIONS`. The kernel's own steps are exported for tool-verify (FactCrossCheck calls `locateWords` and `locateQuotes` directly) and provability: `tokenize`, `normalizeToken`, `locateWords(index, need, { coverage?, windowTokens?, strictFigures?, maxExcerptChars? })`, `locateQuote`, `locateQuotes`, `quotedRuns`, `findSequence`, `bestSpan`, `tightestWindows`, `spanExcerpt`, `lineOf`, `breaksClause`, `figureKey`, `claimFigures`, `claimFigureKeys`, `scanMeter` (the counter the linear-time tests read), `MISQUOTE_COVERAGE` (0.7) and `MISQUOTE_MIN_MATCHED` (3). |
| `numbers.ts` | `extractNumbers(text): string[]` and `normalizeNumber(written)`, values as exact decimal strings; `containsValue(haystack, value)`; `compoundValues(text)` (ISO dates and times of day as whole values); `figureWord(word)` (number words for the figure rule). |
| `quotes.ts` | `quotedSpans(text, minTokens?)` and `containsQuote(haystack, span)`, the `checked` rung's quotations. |
| `tokens.ts`, `sentences.ts`, `messages.ts` | The graders' measure: `contentTokens(text): Set<string>`, `coverage(needle, haystack)`, `STOPWORDS`, the transcript splitter `sentences`, `splitSentences`, `isQuestion`, `claimSentences`, `ABBREVIATIONS`, and `messageText(payload)`. Their thresholds were set against exactly these. |
| `markdown.ts` | Code spans and fences (`codeSpans`, `fencedSpans`, `codeSpanTest`, `indexSpans`, `inSpan`), `lineIndex`, and link helpers (`inlineLinks`, `hasUriScheme`, `splitLinkTarget`, `withoutLinkTitle`). |

What stays internal is `verbs.ts`, the CommonMark block reader the extractor uses and the
grammar's patterns; `index.test.ts` pins what stays private and that the package imports
nothing.

## Who reads it

tool-verify's `CitationLint` and `FactCrossCheck` (FactCrossCheck locates at `coverage: 1`, as it
always has), `@crewhaus/grader-continuity` and `@crewhaus/grader-12-metric-rubric` (the token
measures), [`@crewhaus/provability`](../provability), which builds every rung on
`extractClaims`, `classifyDefinition` and `locateClaim`, the research report gate in
`@crewhaus/report-writer`, and `crewhaus provability`. `crewhaus doctor --philosophy-alignment`
fails if the citation-marker pattern is defined anywhere but `citations.ts`.

## Things worth knowing

**`coverage` is a parameter, and a figure never counts as covered.** FactCrossCheck locates a
claim at `coverage: 1`, every word in one window. The provability gate passes its
`grounded.coverage` (default 0.8) and `grounded.window_tokens` (default 60). Below 1 the figure
rule applies (`strictFigures`, which a gate at `coverage: 1` passes explicitly): some of a claim's
words may be missing, but never a figure and never a negation the claim makes. Without it, "the
refund window for every online order is 30 days" would clear 0.8 against a source that says 14:
six of its seven words are there. A figure is a numeral compared by value and sign (`$1,284.50`
is `1284.5`; `12%` is not `12`; `500` is not `-500`), a cardinal word (`thirty` is `30`), an
ordinal, or a magnitude glued to a numeral (`$5M` is not `$5B`). An ISO date or a time of day
must sit in the span whole. A missing figure is `notFound` with `cause: "value"`, a missing
negation `cause: "negation"`, and either wins over `coverage`. A negation that opens the
source's statement is the span's own: "No two of the six meetings overlap" is a
`polarityConflict` for "two of the six meetings overlap". Only `cause: "coverage"` is a
paraphrase miss: ask `isWaivableMiss(location)` before handing one to the waiver judge.

**A quotation is checked verbatim.** A claim that puts four or more words in double quotes is
checked by those words, in order, whatever `coverage` says, and a near-identical span is
`misquoted`, with what the source actually wrote. Under the figure rule the framing around a
quotation is read for figures and negations too, and each must sit within `windowTokens` of it.

**`extractClaims` leans toward reading a sentence.** One it skips is one the gate passes unread.
It reads code as a CommonMark renderer does (list items included), cuts fenced code and
definition lines out of a sentence, and gives a marker written after the full stop (`text. [1]`,
`text.[1]`) to the sentence before it. It leaves out only the question at the end of a piece
(`…30 days [1] — anything else?` keeps its claim; `Is it 30 days, or 14?` is a question), reads a
question the answer answers itself (`…30 days? Yes.`) as a claim, and treats a numbered list's
`1.` as a bullet. A heading is a title unless it cites a source for a figure or a claim's words,
states a measured value after a label (`## Invoice total: 1,284.50`), or is a sentence stating a
figure (`## Refunds close after 30 days`); an answer of nothing but headings is read as its
headings. `citedClaims` keeps its older sentence extraction, so the claims FactCrossCheck reads
from a document do not move; the tests pin both readers.

**A definition line is a claim only when nothing else reads what it shows.** The definition
`citationDefinitions` keeps for its id is never one: `[8]: https://… Payments clear within 5
days` renders as that sentence, and the provability gate reads it (`definitionGloss`) as claims
citing `[8]`. A definition that shows nothing past its destination and a link title is never one
either. Every other definition-shaped line that shows text (a second `[8]:` line, a bulleted
`- [8]: …`) is read as the prose it renders as, uncited. `bibliographic: true` makes a free-text
source the reference, as the gate's `sources.bibliographic` does.

**A negation governs the words right after it, not the sentence.** `governingNegation` finds the
negation that denies one word: before it, in the same clause, at most two words between and no
copula among them ("is not 1,284.50", "did not exceed 40"). "No" denies only the word after it.
"No discount was applied, so the total is 1,284.50" states the total.

**Numbers are read only where the reading is certain.** `1,5`, `1.284,50`, `v1.2.3` and
`10.0.0.1` are not numbers: a version or a figure in another locale is left out rather than read
as the wrong value. A digit of any script is its digit (`٣٠`, `３０` and `𝟑𝟎` are 30). Both ends
of a time range are values (`10:00-11:30` states 11:30); a UTC offset is not a time of day; a
slash date, a ratio and a numeric range are read as their parts only.

**What the reader cannot tell apart is one spelling.** Every comparison reads through one fold
(`foldTypography`): a zero-width character inside a word, fullwidth and mathematical letters, a
Cyrillic or Greek lookalike inside a Latin word, and a digit of any script read as the plain
spelling, so `not` with a zero-width space inside it, `ｎｏｔ` and a `nоt` with a Cyrillic `о` are
the negation `not`. The fold keeps every length, so offsets match the text as written except
inside a word whose ignorable characters it moved to the word's end (a zero-width joiner, the
second code unit of a mathematical digit); `writtenSpan` widens a range that starts or ends
inside such a word to the whole word, which is how an excerpt is cut from the text as written. A
word wholly in Cyrillic or Greek letters is left as written.

**Two token measures, two questions.** `contentTokens` (lowercased ASCII alphanumeric tokens of
three or more characters, so `120` is one too, and a broad stopword list) asks "is this about
the same thing?" and is what the graders score with. `claimWords` (Unicode words, numbers with
their separators and `%`, negations kept) asks "does the source say these words?" and is what
the locate kernel compares. tool-verify still exports `claimWords` as `contentTokens` from its
`lib/spans.ts`, the name it had there.

## Limits

The extractor and the kernel are heuristics over characters, not a parser. What they still get
wrong, stated so nobody has to find it:

**Strict: the gate asks for more than the answer needed.**

- A closing courtesy sentence with three content words ("Let me know if you need anything
  else.") is a claim, and uncited it fails a `cited` floor at `threshold: 1`.
- A clarifying question wrapped onto a second line after a figure ("Which of these 3 plans" then
  "do you mean?") is read as a claim, and so is a list whose numbers are bold (`**1.**`) or
  inside a block quote.
- A line that is only inline code and states a figure (`` `bun test --timeout 5000` ``) is an
  uncited claim; one without a figure is skipped.
- Indented four-space code blocks, a fence inside a block quote and a heading after a list marker
  are read as prose.
- `citationDefinitions` keeps the citation grammar's looser fence reader: a definition after a
  malformed fence is invisible to it while `extractClaims` sees the claim, so the gate fails that
  claim closed (`no_definition`).

**Lenient: a sentence passes with less checking than it deserves.**

- Some finding headlines are still read as titles (`## Refunds now take 5 days`): the heading
  test reads closed verb lists.
- `[1][2]` is one marker, `[2]`, as CommonMark renders it and CitationLint reads it; `[1]` is
  reported uncited.
- "second" is not a figure, because it is a unit of time as often as a rank, so it is one more
  word under the coverage bar. "The team ranked second in the national league this season" is
  `supported` against a source that says fifth; a claim too short to clear the bar without it
  ("The team ranked second") is a coverage miss, which is waivable, not a value miss.
- `governingNegation` reads a negation only before the word it denies, with at most two words
  between, so in "did not reach a total of 1,284.50" it denies no figure. The locate kernel reads
  every negation inside the span a claim is found in, and a claim found across that "not" is a
  `polarityConflict`; before the span it reads only the negation that governs the claim's first
  word, so "It is not the case that the meetings overlap on Tuesday afternoon" supports "The
  meetings overlap on Tuesday afternoon". provability's `checked` rung reads a result's
  negations through `governingNegation` alone, so one that denies neither the figure nor a word
  the claim states is missed: "The invoice came to 1,284.50" checks against "The invoice did not
  reach a total of 1,284.50".

## Tests

```sh
bun test src
```

The suite pins the extractor's shapes, the locate kernel's causes, the number layer and the fold,
that the extractor, the grammar and the number layer stay linear on adversarial input, and that
the package imports nothing. tool-verify's own suites hold FactCrossCheck and CitationLint to
their behaviour.

Design: [design/0.8.0-provability-release.md](../../design/0.8.0-provability-release.md) §2, §4.1,
§6.2.
