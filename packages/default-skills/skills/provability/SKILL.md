---
name: provability
description: Load before you answer — every claim in your answer is checked against evidence before it is served; this says what the gate checks and how to cite so it passes.
---
A proof gate checks each answer before it is served. Here the floor is
`{{level}}`: every claim needs evidence at that rung or above. An answer
that falls short {{on_fail}}. A claim is any sentence that states a fact or
a number; questions, code and section titles are not claims; a heading that
states a value or cites a source is one.

## How to cite

Put a marker on each claim and close the answer with one definition line per
marker:

    Refunds close after 14 days [1]. The invoice total is 1,284.50 [2].

    [1]: https://acme.example/policy
    [2]: tool:toolu_…

A definition line holds the source and nothing else (a title in quotes is
fine — any other text there is checked as a claim):

- `[n]: <url>` or `[n]: <workspace path>` — a page you fetched, a file you read
- `[n]: tool:<toolUseId>` — the result of a tool call you made {{window}}
{{#proofs}}
- `[n]: proof:prf_…` — the id `ProofCheck` returned
{{/proofs}}
- `[A1]: assume: <text>`, cited as `[A1]` — an assumption: {{assumptions}}

## What the gate checks

Higher-rung evidence meets a lower floor.

- `cited`: every marker has a definition, and each source is locatable — an
  http(s) URL on an allowed host, a `doi:`, or a workspace file that exists.
  What the source says is not checked.
- `grounded`: the cited page or file was fetched or read {{window}}, and
  the claim's words appear close together in it (a quote must appear
  verbatim){{independent}}.
- `checked`: the claim cites `tool:<toolUseId>` of a successful call to an
  allowed tool, and the result contains the claim's figures; a pure tool may
  be re-run to confirm it.
- `proven`: the claim cites `proof:prf_…`, a proof a checker accepted, whose
  recorded claim matches your sentence.

## How to pass

- Fetch or read a source before you cite it, and quote its exact words when
  you can: a quote is matched verbatim, a paraphrase only by word overlap.
- Never state a number you did not read or compute: run the tool, then cite
  its `tool:<toolUseId>`.
{{#proofs}}
- {{proofs}} call `ProofCheckers` and pick an available checker — this
  harness prefers {{checkers}}, in that order — state the claim as a
  theorem, write the certificate or proof in that checker's language, call
  `ProofCheck`, and cite the id it returns. A rejected proof comes back with
  the reason or a counterexample: fix the proof, or drop the claim.
{{/proofs}}
- Before you finish, run `ProvabilityPreflight` on the whole draft,
  definition lines included, and fix every claim it reports.
- Drop a claim you cannot support. Never invent a source, a toolUseId or a
  proof id — the gate looks up every one.
