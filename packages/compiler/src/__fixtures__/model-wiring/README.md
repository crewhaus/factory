# `model-wiring` byte pins

0.6.0 PR 8a moved the ten emitters' hand-mirrored model-routing renderers
(`renderModelFailoverFields` in target-cli / channel / managed,
`renderStepModelFailoverFields` in workflow, `renderRoleModelFailoverFields` in
crew, `renderNodeModelFailoverFields` in graph, and the four `poolField` copies
in pipeline / research / batch / browser) onto ONE codegen twin —
`@crewhaus/model-service`'s `renderModelWiringFields` — of the `wireModels`
composition root the `crewhaus run` interpreter spreads (plan §2 stance 4, §13
row 8a, §17). The refactor's contract is that **no emitted byte changes**.

The `pre-continuity` pins prove that for specs that declare NO routing (the
renderers return `""` either way). These fixtures prove it for specs that DO
declare a pool, tiers or a failover chain, one per emitter that renders the
quartet:

| Key | Shape | Exercises |
|---|---|---|
| `cli-pool` | cli | `model_pool` on the agent block, two-space top-level call |
| `cli-tiers` | cli | `model_tiers` with a `routing` knob |
| `cli-fallbacks` | cli | `model_fallbacks` + `circuit_breaker` (the `escapeJsonString` path) |
| `cli-breaker` | cli | `circuit_breaker` alone (breaker-wraps the single primary) |
| `cli-new-keys` | cli | the plan §17 fixture: one NEW 0.6.0 key per level — a profile field (`temperature`, via `$fast`) on a candidate, a candidate-level `enabled: false`, pool-level `rules` — observable in the emitted `modelPool` literal |
| `channel-pool` | channel | eight-space `createAgent` body |
| `managed-fallbacks` | managed | four-space `runOneTurn` body, chain + breaker |
| `workflow-steps` | workflow | three steps: pool, tiers, chain + breaker, one per step call |
| `crew-roles` | crew | per-role pool and chain on the `RoleDefinition` literals |
| `graph-nodes` | graph | per-node pool and tiers (routing on nodes is itself new in 0.6.0 PR 7) |
| `pipeline-pool` | pipeline | pool on both the REPL and the eval-entry call |
| `research-pool` | research | pool-only shape |
| `batch-pool` | batch | pool-only shape |
| `browser-pool` | browser | pool-only shape |

- `<key>.spec.yaml` — the pinned spec.
- `<key>.<file>.txt` — every code file of the bundle that spec produced,
  compiled with `{ readme: false }` on the tree **immediately before PR 8a**
  (`origin/main` at `54aaca96`, the PR 7 tip — the last commit where every
  emitter rendered the quartet by hand).

`model-wiring-pin.test.ts` compiles each spec on the current tree and asserts
every bundle file equals its pin byte-for-byte; for `cli-new-keys` it also
parses the emitted `modelPool` literal and asserts it deep-equals the object
`wireModels(modelWiringFragmentFromIr(ir.agent), {})` hands to `runChatLoop` —
the bundle and the interpreter are one code path.

## Regenerating

Only when a LATER release deliberately changes what an emitter renders for
the routing quartet — never to paper over an accidental diff. From
`packages/compiler`, `compile()` each `<key>.spec.yaml` with `{ readme: false }`
via `./src/index.ts` (the workspace source, not a published
`@crewhaus/compiler`), write each bundle file to `<key>.<file>.txt`
(non-`[A-Za-z0-9_.-]` path characters replaced by `_`), and append a delta
note here saying what moved and why.
