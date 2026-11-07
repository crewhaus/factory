# Adding a spec key

A key lands in the pull request that wires what reads it, unless it is authoring only by design and
says so ([#514](https://github.com/crewhaus/factory/issues/514)). Each key adds files and one-line
hooks, so the large modules stay easy to merge.

| Piece | Where | Hook | Skip when |
|---|---|---|---|
| The zod block and its cross-field check | `packages/spec/src/blocks/<block>.ts`, exporting `<block>Block` and `<block>Issues(data, custom)` | One placement line per schema that carries the key, in `packages/spec/src/index.ts`. Put it on the line after `version: versionField,` when every shape carries it. The schemas are strict, so a shape without the line rejects the key. | never |
| Its place in the check order | `DELTA_090_ISSUES` in `blocks/delta-090.ts` | Append one entry. It runs after every older check, so no existing spec's first error moves. Never reorder. | the key has no cross-field check |
| The IR fragment | `packages/ir/src/<fragment>.ts` | One re-export in `packages/ir/src/index.ts`, and one optional field per IR variant that carries it. | the key is authoring only |
| The lowering | `packages/compiler/src/lower/<block>.ts`, returning `{}` or `{key: fragment}` | One spread line in each shape's case in `lower()`, the way `provability` lowers, so a spec without the key compiles to the same bytes. | the key is authoring only |
| The owner row | `DELTA_090_KEYS` in `packages/spec-patch/src/owner-keys.ts` | None. The optimizer's refusals, its human-owned reasons, the spec editor's security surfaces, the classification test and `crewhaus doctor --philosophy-alignment` all read this table. Never copy a row by hand into those lists. | never |
| Warning codes | The code, at the place that raises it | Classify each new code on purpose in `apps/cli/src/compile-warnings.ts`: informational, or failing `compile --strict`. A shape that accepts the key and ignores it gets an `ACCEPTED_BUT_UNWIRED` row with `since`; rows may name a dotted path. | the key raises no warning |
| The present golden | `packages/compiler/src/__fixtures__/delta-090/<block>.present.*` | A golden of the key's output with a key-order guard. | the key changes no compiled byte |

Every key leaves the absent corpus unchanged (`packages/compiler/src/__fixtures__/delta-090/README.md`):
a spec that does not declare it compiles to the same bytes on every shape.
