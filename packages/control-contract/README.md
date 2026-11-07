# @crewhaus/control-contract

The one description of the control plane that every surface shares: what each id looks like, which
states a run, a command, a decision and a deployment can be in, what each permission is called, and
what every operation of the `crewhaus.hangar.v1` API takes and returns.

A grant made in Slack, shown in Home and listed by the CLI is one decision with one id and one state
only if all three read it through the same shapes. This package is where those shapes live. It holds
types, data, minters and a few pure functions. It opens no file and makes no network call.

The design is in [module brief 322](https://github.com/crewhaus/docs/blob/main/module-briefs/322-control-contract.md),
[#507](https://github.com/crewhaus/factory/issues/507) and
[#513](https://github.com/crewhaus/factory/issues/513).

## Entries

| Entry | Holds | Depends on |
|---|---|---|
| `@crewhaus/control-contract` | ids, refs, `MACHINES`, permissions, `OPERATIONS`, twins, errors, lists, receipts, capabilities, events, cursors, `verifyDecision` | nothing |
| `@crewhaus/control-contract/schemas` | one zod schema per shape, by name and in `SCHEMAS` | zod |

The main entry imports no package and no `node:` module, not even for types, and uses relative `.js`
specifiers only. `zero-deps.test.ts` and `nodenext.test.ts` hold that. The package itself targets
Bun, like every workspace package.

```ts
import { classifyRunId, mintRunId, parseRef, verifyDecision } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";

const id = mintRunId();
classifyRunId(id); // { family: "canonical", refKinds: ["run"] }
```

## What it does not do

It never reads or writes anything. Record formats, locks, claims and tail readers belong to the
control records layer. Principals and `authorize()` belong to access control. Executors, recovery and
ref resolution belong to the control service. Routes, handlers and masking belong to `hangar-server`.
The contract holds the permission vocabulary and the role matrix as data, and decides nothing.

Pure functions never throw on a malformed record. They answer the safe way: a time that cannot be
read counts as passed, and a check that cannot be made refuses. Minters and `format*` functions may
throw, because a bad argument there is a programmer error.

## Ids are opaque

Read an id with `parseId` or `isId`. Never read its length, and never decode a time from it: a
`<prefix>_<ulid>` happens to sort by mint time, and an attention item's `att_` id is a digest that
only looks like one. A `run_<16 hex>` is an execution, an eval run, a research run or a job log, and
the grammar alone cannot say which, so `classifyRunId` answers `hex16` and lists the ref kinds to try.

## Adding an area

A feature area is static data: one `AreaModule` in `src/areas/<area>.ts`, with its operations, ref
kinds, event families, state machines, command kinds and permissions. Every vocabulary this package
exports is the union of `AREA_MODULES`, so it stays closed per build. The tests walk the composition,
so they cover a new area by construction. The literal pins read `CORE_MODULE`, so an area never edits
one. `simulated-area.test.ts` adds an area this way to a copy of the package and runs its tests.

1. Write the module, `as const satisfies AreaModule`, and its schemas in `src/schemas/<area>.ts`,
   exporting `<AREA>_SCHEMAS`.
2. Add one minimal valid value per schema in `src/__test__/<area>.examples.ts`, exporting `EXAMPLES`,
   and hold each schema to its type in `src/schemas/<area>.type-checks.ts`, with `Expect` and `Same`
   from `./type-checks.js`. Both are found by their file names.
3. Uncomment the area's two lines in `src/areas/index.ts` and its two in `src/schemas/areas.ts`.
   Touch nothing else there. Each placeholder sits between blank lines so two areas never conflict;
   `areas.test.ts` proves it with `git merge-file`.
4. An area's state machines are `MACHINES` entries checked by `canTransition()`, never a separate
   transition export. A `people.*` permission has floor `none`: no role implies it.

`PATH_PARAMS`, `CLI_VERBS` and `TWIN_PLACEHOLDERS` are closed lists outside the modules. An area that
needs a new path parameter or a new CLI verb adds it there, with its pin, on purpose.

## Field names survive the masker

Hangar masks every response by key name, so a field named like a credential comes back
`[redacted]`. Name around it: `environment`, `dedupeRef`, `credentialRef`, `prefixHint`, `signIn` and
`deviceJwk`, never `env`, `…Key`, `…Token`, `auth` or `publicKey`. `field-names.test.ts` walks every
field of every schema through `isCredentialKey` and fails on a hit, unless an operation lists that
field in `secretFields`. The matcher is never widened or narrowed.

Values are safe too, and `scripts/contract-masker-safety.test.ts` shows it in volume, with one
caveat: a `knowledge` ref's id is a free segment until that area registers an opaque grammar, so one
that spells `-key` followed by 32 more characters comes back altered. Every other ref is safe.

## Known copies

`sess_` and `appr_` grammars are copied by hand in many packages, and in code the compiler emits.
`scripts/id-grammar-copies.test.ts` holds each known copy equal to the contract's text, with a count
per file. There is no "a second definition fails" gate, because there are too many copies for one
today. Migrate a copy when you next touch its package, and take its line off the list.
