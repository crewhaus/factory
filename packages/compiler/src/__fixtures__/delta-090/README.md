# Absent corpus

`absent-corpus.digests.json` holds the SHA-256 of every file that `compile()` emits, README included,
for each spec in [`../../absent-corpus.ts`](../../absent-corpus.ts): one minimal spec per target shape.
It pins the rule from [#514](https://github.com/crewhaus/factory/issues/514) that a spec which does not
declare a new key compiles to the same bytes. `delta-090-absent.test.ts` holds it.

## When to regenerate

Only for a deliberate emitter change, and never to quiet a failure you cannot explain. A pull request
that adds a key changes nothing here: if it does, the key reaches a spec that does not use it, and that
is the bug. Append a note to "Delta notes" below saying what changed and why.

```sh
bun packages/compiler/src/__fixtures__/delta-090/regenerate.ts
```

The version bump in a release moves no digest: `compile()` emits no `package.json`.

## Delta notes

**Managed secret delta — `managed`'s `daemon.ts` only.** A generated signing secret is saved to
`.crewhaus/run/gateway-jwt-secret` (0600), beside a `.gitignore` holding `*`, and the log names the
path; the imports gain `lstatSync`, `mkdirSync`, `rmSync`, `writeFileSync` and `dirname`. The boot
lines about where `CREWHAUS_TENANTS_ROOT` belongs are emitted only for a spec that declares a tool that
may work on files, or `provability:`, and the managed spec here declares neither. No other digest
moves.
