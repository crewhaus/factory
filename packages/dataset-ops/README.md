# @crewhaus/dataset-ops

Everything that happens to an eval dataset except running it.

| Module | Answers |
|---|---|
| `datasets` | what `registry:<name>[@version][#split]` resolves to, and how splits are assigned |
| `dataset-lint` | the problems that would corrupt a run, before the run pays for them |
| `dataset-audit` | whether an existing dataset carries PII or a secret |
| `dataset-mine` | the hard cases already sitting in the session logs |
| `graders-suggest` | which graders the recorded failures are asking for |

## Splits are assigned by hash, never by an RNG

Split assignment orders samples by `sha256(sample.id)` and cuts at the
cumulative percentage boundaries. Re-importing the same ids lands every sample
in the same split, on any machine, in any file order. The dataset hash that
run history and baselines key on is folded from per-sample content hashes for
the same reason: two datasets with the same name are only the same dataset if
their contents match.

## A duplicate id is an error, not a warning

`dataset-lint` treats a repeated sample id as fatal because per-sample
artifact directories collide and the id-keyed pass→fail detection the strict
gate depends on then corrupts silently. The softer findings — near-duplicate
inputs, an id reused across versions with different content, gold that the
configured graders cannot use — are warnings, because each one distorts a
measurement rather than destroying it.

## An audit report never quotes the hit

`dataset-audit` reports the kind, the field and the sample id, and stops
there: a report that quotes the secret is a second copy of it. The same
synchronous redactor is what the ingestion paths (`distill`, `dataset mine`)
thread through sample construction, so a candidate is already clean when it
reaches quarantine — it mirrors `@crewhaus/pii-redactor`'s replace mode
byte-for-byte, because that API is async-only and the pure sync distill core
cannot await it.

## Mining needs no human

`dataset-mine` reads the signals that need no rating to interpret: an uncaught
error mid-turn, a tool that kept failing, the runtime's own loop nudge, a user
re-asking the same question, a blocked egress decision, an in-loop judge
failure. Each triggering turn becomes a candidate in a quarantine dataset;
promotion into a real version is a separate, reviewed step.

## Why this is a package

A `packages/tool-*` may not depend on an app, and all of this lived in
`apps/cli/src`.

## Testing

```
bun test packages/dataset-ops/src
```

The `/src` is load-bearing: `bun test` matches by path PREFIX, so dropping it
also collects sibling packages whose names start the same way.

The tests that spawn `crewhaus dataset audit` / `dataset mine` /
`dataset synthesize` / `graders suggest` stay in `apps/cli`.
