# W1-B — the `provability:` spec block, its lowering, and its lint (design §3, §4.2–§4.3, §11 lint rules; PR train 3)

You own: `packages/spec/**`, `packages/compiler/**`, `apps/cli/src/lint.ts`,
`apps/cli/src/lint.test.ts`, `apps/cli/src/model-plan-lint.ts` (+ its test). Read design §3 and
§4.2–§4.3 and the committed `IrProvability` type (packages/ir/src/index.ts, search "0.8.0") —
the IR is the contract; lower into exactly that shape.

## Spec (`packages/spec/src/index.ts`)

Model the block on `watchmeBlock` / `continuityBlock` / `evaluationBlock` (read them and how
`watchme:` is attached to the cli/channel/managed schemas). `.strict()` everywhere, `.describe()`
on every field (the JSON-schema generator and the VS Code forms read the descriptions).

```yaml
provability: grounded          # string shorthand ≡ { level: grounded }  (enum off|cited|grounded|checked|proven)
provability:
  level: grounded              # off | cited | grounded | checked | proven
  on_fail: retry               # retry | halt | note | escalate
  max_retries: 1               # int 0..5
  threshold: 1.0               # 0..1
  scope: session               # session | turn
  assumptions: allow           # allow | forbid
  max_assumptions: 3           # int >= 0, optional
  render: footer               # footer | none | json
  sources: { allow: [globs], deny: [globs], bibliographic: false, resolve: off|head }
  grounded: { coverage: 0..1, window_tokens: 4..2000, independent: 1..5 }
  execution: { allow: [tool keys or all-<category> / -exclusion grammar], replay: bool, max_replays: 1..200 }
  formal: { checkers: [builtin|smt|lean4] (min 1, unique), image: string, forbid: [string], timeout_ms: 1000..600000 }
  judge: { model: string ($profile ok), allow_self_judge: true }   # optional
```
Attach to: cli, channel, managed, research, crew. NOT to graph/workflow/pipeline/batch/voice/
browser/eval/onchain/onchain-game (strict schemas reject it). Export `SpecProvabilityBlock`.

Parse-time hard errors (append to the END of `crossFieldIssues()` — order is load-bearing,
read its docblock — these THROW at parse, so only genuine contradictions):
- `on_fail: escalate` without `agent.model_pool` (copy the `evaluation.on_fail: escalate` check's
  wording pattern at ~line 4541) — cli/channel/managed.
NOT parse errors (they would reject valid specs) — make them `crewhaus lint` findings and/or
compile warnings instead (see below): no source-reading tool at `level >= grounded`; sandbox-only
checkers; an inert `level: off` block with other keys.

Also update every spec test that enumerates top-level keys / the JSON schema (`json-schema.test.ts`)
and add `packages/spec/src/provability.test.ts`: shorthand, full object, every enum, bounds,
unknown sub-key rejection, rejection on graph/workflow/pipeline, the escalate-without-pool error.

## Compiler (`packages/compiler/src/index.ts`)

`lowerProvability(spec, ctx): { provability?: IrProvability }` next to `lowerWatchme`
(spread-return-`{}`): absent block or `level: off` → `{}`. Defaults (IR doc lists them):
on_fail retry, max_retries 1, threshold 1, scope session, assumptions allow, render footer,
sources {allow:[], deny:[], bibliographic:false, resolve:"off"}, grounded {coverage 0.8,
windowTokens 60, independent 1}, execution {allow: expansion of ["all-compute","all-verify"],
replay true, maxReplays 20}, formal {checkers ["builtin","smt"], forbid ["sorry","axiom",
"native_decide"], timeoutMs 30000}. Expand `execution.allow` with the SAME category expansion
`tools:` uses at lower time (find it — `@crewhaus/tool-categories`), so the IR carries concrete
keys only; an unknown category or a no-op exclusion fails the compile the same way `tools:` does.
Resolve `judge.model` with `resolveAuxSlot(..., "provability.judge.model")` (watchme precedent).
Resolve `escalateTo` exactly as `IrEvaluation.escalateTo` is resolved (find that code). Thread the
result into the cli, channel, managed, research and crew IR builders.

- research: `on_fail: retry | escalate` are not supported on this shape in 0.8.0 — lower them to
  `"note"` and emit a CompileWarning (code `provability-on-fail-degraded`, path
  `provability.on_fail`, message saying the research report gate supports halt|note).
- crew: add an `unwired("provability", "crew", "…")` row to the ACCEPTED-BUT-UNWIRED table
  (read the table's docblock and the warnings tests that pin it) — the orchestrator's synthesis
  turn is a deferred seam (design §12 item 2).
- `level: off` with any other key set: CompileWarning code `provability-inert-block`.
- `crewhaus compile --strict`: refuse `level: checked|proven` when `execution.allow` names a key
  the builtin catalog cannot resolve offline (find how `--strict` / `auditToolScopes` resolves
  keys; reuse that). Add a test.
- Absent = byte-identical: the existing compile snapshot/byte tests must stay green unchanged.

Tests: `packages/compiler/src/provability-lowering.test.ts` — defaults, every field, shorthand,
off → no key, expansion (category, exclusion, unknown category error), judge aux slot incl.
`$profile`, escalateTo, research degrade + warning, crew unwired warning, inert warning, strict.
Update any test that pins the carriage table or the IR key set.

## Lint (`apps/cli/src/lint.ts`, `model-plan-lint.ts`)

Add rules (warnings, not errors) with tests in `lint.test.ts`:
- `provability-no-source-tool`: `level >= grounded` and the lowered tools contain nothing that can
  read a source (no web/fetch/read/retrieve key, no `mcp_servers`, no `knowledge:`), so no claim
  could ever ground. (Work on the lowered IR so categories are expanded.)
- `provability-sandbox-only-checkers`: `formal.checkers` without `builtin`.
- `provability-inert-block`: `level: off` with other keys.
- `provability-self-judge`: `judge.model` resolves to the agent's own serving model, unless
  `allow_self_judge: true` — reuse the existing judge-independence rule's machinery (search
  `judge-independence` / `allowSelfJudge`).

Verify: `bunx tsc -b` in spec, compiler, apps/cli; `bun test` in packages/spec and
packages/compiler (both full), and in apps/cli the lint tests plus any test file that pins spec
keys or compile output you touched. biome on your files.
