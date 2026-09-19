# @crewhaus/spec-changelog

A spec's version history, and the upgrade that writes the next entry.

| Module | Answers |
|---|---|
| `spec-changelog` | what changed between two registered versions, as a per-spec `CHANGELOG.md` |
| `upgrade` | what a spec needs to run on a newer CrewHaus, and the migrated YAML |

## Registration is content-addressed, so it is safe to run on every compile

`autoRegisterSpecVersion` hashes the spec's content and registers the next
`vN` only when no registered version already has that content. Recompiling an
unchanged spec is therefore a no-op, which is what lets `compile`,
`optimize --write-back` and `spec put` all call it without a human deciding
each time whether a version is due.

The changelog is a real `CHANGELOG.md` written **beside** the registry
manifest, not inside it: the registry's own on-disk format is untouched, and
the file stays readable by a person months later. Each entry carries the
version, the date, the field-level YAML diff against the previous version and
— where the content was stamped by a write-back — the run, mutator, score and
rationale that produced it.

## An upgrade is a diff you read before you take it

`upgrade` reports the migrated YAML and the per-path diff that produced it, so
the change can be reviewed rather than trusted, and a dry run is the default
shape of the command. The migration keeps the author's comments and key order
where its steps allow, and sets `commentsPreserved: false` when a step could
not — an honest flag beats a silently reformatted file.

## Why this is a package

A `packages/tool-*` may not depend on an app, and both modules lived in
`apps/cli/src`.

## Testing

```
bun test packages/spec-changelog/src
```

The `/src` is load-bearing: `bun test` matches by path PREFIX, so dropping it
also collects sibling packages whose names start the same way.
