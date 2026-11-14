# Absent corpus

`absent-corpus.digests.json` holds the SHA-256 of every file that `compile()` emits, README included,
for each spec in [`../../absent-corpus.ts`](../../absent-corpus.ts): one minimal spec per target shape.
It pins the rule from [#514](https://github.com/crewhaus/factory/issues/514) that a spec which does not
declare a new key compiles to the same bytes. `delta-090-absent.test.ts` holds it.

## The schedule object form

`schedule-object.digests.json` pins the same thing for six specs in
[`../../schedule-corpus.ts`](../../schedule-corpus.ts): the channel, managed and batch specs above, each
with a cron `schedule:` object (timezone, jitter and instructions) and an interval one. It was
generated before `schedule:` took a list, so the list form cannot move a byte of a spec that keeps the
object form. `schedule-lanes.test.ts` holds it. Regenerate it under the same rule as the absent corpus.

## The schedule list form

`schedule-lanes.present.digests.json` pins what the list form compiles to: the same three specs, each
with two named lanes declared out of name order (`weekly-report`, a cron lane whose instructions hold a
quote, a backtick, `${x}` and a newline; then `discovery`, an interval lane). Unlike the files above it
pins a feature that is present, so a deliberate change to how named lanes are emitted moves it:
regenerate it in that pull request and add a delta note below. A change that moves it while touching
nothing about named lanes is the same bug as above.

## The plugins name list

`plugins-strings.digests.json` pins the same thing for two specs in
[`../../plugins-corpus.ts`](../../plugins-corpus.ts): the cli and channel specs above, each with a
`plugins:` list of plain names (one listed twice). It was generated before `plugins:` took a
`{name, tools}` entry, so that form cannot move a byte of a spec that lists plain names.
`plugins-entries.test.ts` holds it. Regenerate it under the same rule as the absent corpus.

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

**Webhook body limit delta — `channel`'s `gateway.ts` and `daemon.ts` only.** The gateway reads a
webhook body through `readRequestBodyCapped` (`@crewhaus/gateway-protocol/body-limit`) on its events
and actions routes, so a body over the limit is answered 413 before `verify()`, and its config gains an
optional `maxBodyBytes`. The daemon resolves the limit once from `CHANNEL_WEBHOOK_MAX_BYTES` (1 MiB when
unset) and passes it to the gateway and to the public port's `Bun.serve` as `maxRequestBodySize`. No
other digest moves.

**Managed runs delta — `managed`'s `daemon.ts` only.** The `crewhaus.v1` handler, the run-event
registry and the signing-secret bootstrap delegate to `@crewhaus/gateway-server/managed-runs`
(`createManagedRuns`, `resolveGatewaySecret`); the emitted code keeps only the turn itself, and the
daemon starts and stops the queued-run follower with the gateway. Imports follow. The tenants-root
check is emitted only for a spec that declares a tool that works on files, which the managed spec here
does not. No other digest moves.

**Channel delegation delta — `channel`'s `gateway.ts` only.** The gateway hands its actions route to
`createApprovalActions(…).handle(interaction, actionAdapter)` after its capped read, `verify()` and
`parseInteraction`, and its events route to `handleInboundEvent(parsed.event, adapter, {dedup,
sessionRouter})` after its handshake, capped read, `verify()` and `parseInbound`, both from
`@crewhaus/channel-adapter-base`; it imports nothing from `@crewhaus/permission-engine`. No other
digest moves.
