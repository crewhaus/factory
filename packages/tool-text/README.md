# @crewhaus/tool-text

Deterministic text tools. Every one is pure: no filesystem, no network, no
clock, no randomness. The same input always produces the same bytes.

That property is the point. A harness spends a model call when it needs
judgement; it should not spend one to count lines, pull a version string out
of a log, or fill in a template. These eighteen tools cover the mechanical
half so the model is left with the part that actually needs it.

```yaml
tools:
  - all-text          # every tool below
  - -renderTemplate   # ...except this one
```

| Tool | What it does |
|---|---|
| `CompactLog` | Collapse a long log to distinct lines with repeat counts, failures first |
| `CountTokens` | Characters, words, lines and an estimated token count |
| `EscapeString` | Quote text for a regex, shell word, JSON, URL, HTML, markdown, CSV or SQL LIKE |
| `ExtractEntities` | Pull URLs, emails, IPs, UUIDs, semvers, tickets, amounts and more out of text |
| `ExtractKeywords` | Rank a document's significant terms, stop words excluded |
| `FuzzyMatch` | Rank candidates against a query by edit distance, Jaro-Winkler, trigram or token overlap |
| `GlossaryReplace` | Apply a term mapping, longest term first, whole-word by default |
| `MarkdownOutline` | List a document's headings, or return one section by title or slug |
| `MarkdownTable` | Render records as an aligned GitHub-flavoured table |
| `NormalizeText` | Canonicalize line endings, whitespace, Unicode form, ANSI codes, invisible characters |
| `RegexExtract` | Every match with named groups, offsets and line numbers |
| `RenderTemplate` | Fill `{{placeholders}}` from structured data, strict about missing keys |
| `RuleClassify` | Label text against operator-written phrase and regex rules |
| `SortLines` | Sort, de-duplicate, key by a delimited field |
| `TextDiff` | Unified diff plus added/removed counts |
| `TextSimilarity` | Score two texts 0..1, lexically |
| `TruncateToBudget` | Cut to a character or estimated-token budget, keeping head, tail or both |
| `WrapText` | Hard-wrap at a column width with an optional prefix |

## What is deliberately not here

Anything whose core is judgement rather than mechanism: summarizing,
translating, classifying by meaning, drafting prose, ranking by relevance
beyond lexical scoring. `RuleClassify` labels by rules an operator wrote, not
by understanding. `ExtractEntities` finds things that have a *syntax*, not
things that have a *meaning* — it is regex, explicitly not named-entity
recognition. `TextSimilarity` is lexical, with no embeddings.

Where a deterministic first pass exists, it belongs first and the model is the
escalation path.

## Layout

`src/lib/` holds the pure functions and is where the behaviour is tested;
`src/index.ts` wraps them as tools. A bug in `levenshtein` reads better as a
failing unit than as a failing tool call.

## Safety flags

All eighteen are `readOnly`, non-destructive, `scope: "internal"`, and declare
no io capability, because none of them crosses a process or network boundary.
`packages/tool-text/src/index.test.ts` asserts that for every tool, so a future
addition that reaches outside has to change the assertion deliberately.
