# `model-readme` byte pins

0.6.0 PR 7 changed the generated bundle `README.md` — and only `README.md` — for
every spec that declares a `model_pool`, `model_tiers`, `model_fallbacks` or an
auxiliary model (judge / compaction / degrade / security / watchme): the
README's `collectModels` now lists every model a run can route to, and renders a
"Model profiles" section when a `models:` registry is declared (plan §4.3).
Measured against the demos corpus when the PR landed, 64 of 252 bundles gained
README lines; `agent.ts` and every other emitted file were byte-identical (the
`pre-continuity` pins cover those).

These fixtures pin the NEW README output so the next change to it is caught:

| Key | Spec shape | Exercises |
|---|---|---|
| `pooled` | 0.5.x-shaped cli with a two-candidate `model_pool` | candidates listed beside the serving model |
| `judged` | 0.5.x-shaped cli with `model_tiers`, an explicit judge model and a compaction model | tiers + auxiliary slots listed |
| `profiled` | opted-in cli with a `models:` registry and a judge without `model` | the "Model profiles" section and the §6.2 judge-default flip (`strongest` → the `strong` profile) |

`model-readme-pin.test.ts` compiles each `<key>.spec.yaml` with
`{ today: "2026-09-04" }` and asserts `README.md` equals `<key>.README.md.txt`
byte-for-byte.

## Regenerating

Only when a LATER release deliberately changes the README again — never to
paper over an accidental diff. From `packages/compiler`, `compile()` each
`<key>.spec.yaml` via `./src/index.ts` (the workspace source, not a published
`@crewhaus/compiler`), write the `README.md` file to `<key>.README.md.txt`, and
append a delta note here saying what moved and why.
