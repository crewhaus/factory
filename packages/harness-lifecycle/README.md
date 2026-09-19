# @crewhaus/harness-lifecycle

The back half of a harness's life — what happens after it ships, and when it
stops.

| Module | Answers |
|---|---|
| `retire` | the ordered, evidenced decommission of a harness |
| `retention` | which sessions and audit records are past their TTL |
| `knowledge-sync` | what a harness and the fleet's shared store owe each other |

## Retirement refuses before it deletes

`retire` stops if the spec still has an active deployment pin — an environment
pointing at a live version — unless it is forced. Retiring a bot that is still
answering people is the worst available failure, so it is the first thing
checked, before any state moves.

What follows is ordered so that the evidence outlives the harness: export the
durable state, record a final compliance bundle and an audit-verify result,
optionally push the knowledge to the shared store, tombstone the registry
entry (which clears the env pins), then archive and remove the live state. A
`retirement.json` recording every step and its outcome is written *into* the
archive, so the retirement is itself evidenced. `--dry-run` prints the plan
and touches nothing.

Every heavy step is injected as a seam, which is how the order, the refusal
and the archived log are tested without running a real backup.

## The policy lives in one place on purpose

`retention` enforces the same configuration the daemon janitors read, loaded
by the same code in `@crewhaus/data-retention-engine`. A CLI sweep and an
unattended sweep that disagreed about a TTL would be worse than either alone.
A dry run is the identical computation with the deletion left off, so the plan
you review is the plan that runs.

## A fragment is named after its own body

`knowledge-sync` merges memories, grader fragments and prompt snippets by
content hash, so pulling twice adds nothing. A `.md` fragment whose filename
hash no longer matches its body was edited in place by somebody — it is
skipped with a warning rather than synced, because a silent sync would push
one harness's local edit into every other harness in the fleet. Redaction runs
through an injected seam, so what leaves a harness for the shared store is
tested without the redactor package.

## Why this is a package

A `packages/tool-*` may not depend on an app, and all three modules lived in
`apps/cli/src`.

## Testing

```
bun test packages/harness-lifecycle/src
```

The `/src` is load-bearing: `bun test` matches by path PREFIX, so dropping it
also collects sibling packages whose names start the same way.
