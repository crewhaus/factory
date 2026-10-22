# W1-A — `@crewhaus/claim-ledger`: one owner for the text layer (design §4.1, PR train 1)

## Why
Three packages carry their own copy of the same text heuristics, and the release's gate must
see exactly the claims and markers the existing tools see:
- `packages/tool-verify/src/lib/markdown.ts` — the citation marker/definition grammar
  (`CITATION_MARKER`, `DEFINITION`, `lintCitations`, `citationDefinitions`), `splitSentences`,
  `ABBREVIATIONS`, `citedClaims`, code-span exclusion. Its own comment: "two copies of this drift,
  and then one tool checks a claim the other never saw".
- `packages/tool-verify/src/index.ts` (+ `src/lib/spans.ts`) — the FactCrossCheck kernel: source
  indexing, `quotedRuns`, `checkOneSource`, polarity detection, coverage/window logic.
- `packages/grader-continuity/src/heuristics.ts` (+ `artifacts.ts` `messageText`) — `contentTokens`,
  `coverage`, `sentences`, `isQuestion`, `STOPWORDS`; and
  `packages/grader-12-metric-rubric/src/faithfulness.ts`, which INLINES a byte-for-byte copy of
  those heuristics (see its comment at the top about the missing dependency edge) plus
  `claimSentences`, `MIN_CLAIM_TOKENS`, `GROUNDING_COVERAGE`.

## What to build (you own: `packages/claim-ledger/**`, `packages/tool-verify/**`,
`packages/grader-continuity/**`, `packages/grader-12-metric-rubric/**`)

1. `packages/claim-ledger` — dependency-free (no `@crewhaus/*` deps at all; it is imported by the
   gate, the graders and tools). Move (not copy) the implementations listed above into it, split
   into sensible modules (`tokens.ts`, `sentences.ts`, `citations.ts`, `locate.ts`, `numbers.ts`,
   `refs.ts`), exported from `src/index.ts`:
   - tokens: `STOPWORDS`, `contentTokens(text)`, `coverage(need, have)` — exactly the
     grader-continuity semantics.
   - sentences: `splitSentences`, `sentences`, `isQuestion`, `claimSentences(text)` (the
     faithfulness extractor), `MIN_CLAIM_TOKENS`.
   - citations: `CITATION_MARKER`/`DEFINITION` (keep them module-private if they were; export the
     functions), `lintCitations`, `citationDefinitions`, `citedClaims`, the `Citation`,
     `CitationReport`, `CitedClaim` types, and the code-span helper.
   - locate: the FactCrossCheck kernel as a reusable function, e.g.
     `indexSource(text)` + `locateClaim(claimText, sourceIndexOrText, { windowTokens, coverage })`
     returning `{ status: "supported" | "misquoted" | "polarityConflict" | "notFound", mode:
     "quote" | "paraphrase", coverage, line?, excerpt? }`. FactCrossCheck must keep its exact
     current behaviour by passing its current parameters (find what its effective coverage bar is
     today — likely "every word in one window" — and make that the parameter it passes). The
     provability gate will call it with `coverage: 0.8` by default.
   - NEW `extractClaims(text, { minTokens? })` → `Array<{ index, text, raw, line, markers:
     string[] }>`: EVERY declarative, non-question sentence with ≥ `MIN_CLAIM_TOKENS` content
     tokens, outside fenced/inline code, excluding definition lines (`[n]: …`), headings, and
     list items that are only a definition; `text` has markers stripped, `raw` keeps them,
     `markers` are the marker ids it carries (`"1"`, `"^a"` → normalized the way
     `citationDefinitions` keys them, `"A1"`). Uncited claims are included (markers `[]`) — the
     gate flags them. Reuse `splitSentences` so this agrees with `citedClaims`.
   - NEW evidence-ref grammar `classifyDefinition(source)` → one of
     `{kind:"url", url}` | `{kind:"doi", doi}` | `{kind:"path", path, fragment?}` |
     `{kind:"tool", toolUseId}` | `{kind:"proof", proofId}` | `{kind:"assume", text}` |
     `{kind:"text", text}`. Prefixes `tool:`, `proof:`, `assume:`, `doi:` (case-insensitive scheme,
     value trimmed). A bare `https?://` is a url; a string with another URI scheme (e.g.
     `mailto:`) is `text`; a relative or `./`-prefixed or workspace-looking path (no spaces, has a
     `/` or a file extension) is `path` (use `splitLinkTarget` semantics for `#fragment`);
     anything else (e.g. "Smith, J. (2024) …") is `text`. Backward compatible: every existing
     document still parses; new prefixes are simply sources CitationLint could not locate.
     Also export `isAssumptionMarker(id)` (`A` + digits) if useful.
   - NEW number layer: `extractNumbers(text)` → normalized decimal strings
     (`1,284.50` → `1284.5`, `-3`, `12%` → `12`, `$4.20` → `4.2`, `1 284` NOT merged, years
     stay numbers) and `containsValue(haystack, value)` comparing normalized numerals (exact
     decimal string equality after normalization, so `1284.5` matches `1,284.50` and `1284.50`),
     plus `quotedSpans(text)` (the quoted runs the locate kernel already finds).
   - `messageText` for transcript payloads if both graders need it.
2. Rewire `tool-verify` (markdown.ts re-exports from claim-ledger so its public API is unchanged;
   FactCrossCheck/CitationLint call the kernel), `grader-continuity` (heuristics.ts re-exports or
   imports — keep its public exports working), and `grader-12-metric-rubric/faithfulness.ts`
   (delete the inlined copy, import from claim-ledger, and update that top-of-file comment to say
   the edge now exists). Add the dependency edges in each package.json + tsconfig and run
   `bun install` at the root.
3. **Behaviour-neutral**: every existing test in tool-verify (255), grader-12-metric-rubric (78)
   and grader-continuity must pass UNCHANGED. Do not edit an existing assertion to make it pass;
   if one fails, your hoist changed behaviour — fix the hoist.
4. Tests in `packages/claim-ledger/src/*.test.ts`: the grammar (every definition kind, the
   next-line definition form, blank-line termination, code-block exclusion), `extractClaims`
   (cited/uncited, markers, questions excluded, code excluded, headings excluded, line numbers),
   `classifyDefinition` for every kind and ambiguous inputs, the number layer (thousands
   separators, decimals, percents, currency, negatives, non-matches like version strings
   `v1.2.3` — decide and document), and `locateClaim` (quote mode, paraphrase mode at coverage
   0.8 vs 1.0, window size, polarity conflict, not found, empty claim never "found").
5. `packages/claim-ledger/README.md` — what it owns and why one owner (short, in the repo voice).

Verify: `bunx tsc -b` in claim-ledger, tool-verify, grader-continuity, grader-12-metric-rubric,
and in every package that imports from those (grep `@crewhaus/tool-verify`,
`@crewhaus/grader-continuity`, `@crewhaus/grader-12-metric-rubric` — e.g. apps/cli,
eval-runner, watchme). `bun test` in the four packages. biome on your files.
