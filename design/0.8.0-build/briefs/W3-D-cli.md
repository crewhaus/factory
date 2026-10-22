# W3-D — `crewhaus provability`, doctor, and the Hangar endpoint (design §10, §11, §12 item 5; PR train 12 code)

You own: a new `apps/cli/src/provability-cli.ts` (+ test), the command dispatch for
`provability` in `apps/cli/src/index.ts`, `apps/cli/src/arg-schemas.ts`,
`apps/cli/src/usage-text.ts` (shared with other builders — re-read before each edit, keep edits
minimal), the doctor philosophy-alignment collector and the doctor probe code in
`apps/cli/src/index.ts`/`doctor-*.ts`, and `packages/hangar-server/**` (one new route).
Read design §10–§12. `@crewhaus/provability` (stores, renderers, verifyDocument, evidence) and
`@crewhaus/proof-checker` (createDefaultCheckers) exist — read their exports. Follow how an
existing command family is structured (e.g. the `watchme` or `dream` command: pure module with
injected fs/clock seams + thin dispatch; `--json` output; exit codes).

Commands (each with `--help`, declared flags in arg-schemas, usage text):
- `crewhaus provability show [<spec.yaml>] [--session <id>] [--turn N] [--json]` — render a
  persisted bundle (default: the latest one) in long form: floor, verdict, score, achieved, every
  claim with status/best rung/bindings/reasons/excerpts, assumptions, checkers.
- `crewhaus provability check <answer.md> --level <rung> [--evidence <dir>] [--session <id>]
  [--spec <spec.yaml>] [--json]` — the OFFLINE gate over any document: evidence from a session
  log (`--session`), from a directory of fetched bodies (`--evidence <dir>`: define the layout —
  e.g. each file is a body and its origin is given by a sidecar or a `URL:` first line — and
  document it), and/or workspace files the document cites by path (read directly for this
  offline command — say so); config from `--spec`'s lowered provability block, else defaults at
  `--level`. Exit 0 on pass, 1 on fail, so a generated report can be gated in CI.
- `crewhaus provability audit [<spec.yaml>] [--since 7d] [--json]` — roll-up across persisted
  bundles and `provability_graded` event-log lines: achieved-rung distribution, unmet-reason
  counts, assumption rate, judge-waiver rate, and gaming signals (one evidence ref bound to many
  unrelated claims; replay mismatches; proof statements near-identical to the prose).
- `crewhaus provability checkers [--json]` — every checker, `available()` with reason (sandbox
  backend + image health), its language paragraph.
- `crewhaus provability prune --older-than 90d [--dry-run]` — bundle housekeeping via the store.
Doctor:
- `crewhaus doctor` (the probe section): run the checkers' availability probe when the spec in
  cwd declares `provability` with sandbox checkers.
- `doctor --philosophy-alignment` gains three findings (design §10): the citation-marker regex
  has exactly ONE definition in the tree (it now lives in `packages/claim-ledger` — grep the
  tree for the marker pattern / its constant name and fail when a second copy appears);
  `packages/provability` imports no model adapter package (scan its package.json deps + src
  imports for `adapter-*`, `eval-judge`, `model-router`); `["provability","level"]` is absent
  from `OPTIMIZABLE_PATHS`. Give each a stable `(class, file, symbol)` identity like the
  existing findings (the drift-watch baseline reads them).
Hangar:
- `GET /api/runs/:id/proof` in `packages/hangar-server` (follow `inspect.ts` / `evals-ops.ts`
  routing, auth and path-containment rules): returns the bundle(s) persisted for that run/session,
  404 when none. Contract test in the style of `contract.test.ts` / `cli-twins.test.ts` (if a
  CLI-twin rule exists, `provability show --json` is its twin).

Tests for every command (temp dirs, injected clock), the three doctor findings (pass + a
seeded failure each), the hangar route (200/404/auth/traversal refusal).

Verify: `bunx tsc -b` in apps/cli and hangar-server; `bun test src/provability-cli.test.ts` and
the doctor/arg-schemas/usage tests you touched in apps/cli (`grep -l "philosophy" apps/cli/src/*.test.ts`,
`arg-schemas.test.ts`, any usage-text pin); `bun test` in hangar-server; biome.
