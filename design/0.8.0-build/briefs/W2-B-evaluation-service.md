# W2-B — `@crewhaus/evaluation-service`: one composition root for both in-loop gates (design §4.4, §5.1–§5.2, §6.2, §8; PR train 2 + the provability wiring)

You own: `packages/evaluation-service/**`; the evaluation/provability wiring regions of
`packages/target-cli/src/index.ts`, `packages/target-channel-bot/src/index.ts`,
`packages/target-managed/src/index.ts` (and their tests); `apps/cli/src/loop-contract.ts` (+
test) and the two `evaluationRunOptions(ir)` call sites in `apps/cli/src/index.ts` (~4830,
~5956) and the catalog registration lines next to them. Another builder already ran the
tool-wiring script over target-cli's BUILTIN_TOOL_MAP and apps/cli loadToolMap — leave those.

Read design §4.4, §5.1, §5.2, §6.2, §7 (tools), §8; AGENTS.md's model-service paragraph (the
"every new routing feature lands in model-service, never in an emitter's codegen" rule — the same
rule now applies to in-loop gates); `packages/memory-service` (`wireMemory` +
`memoryFragmentFromIr` + how target-cli renders the call) and `packages/model-service`
(`renderModelWiringFields`, `JUDGE_PANEL_IMPORT`, `renderJudgePanelFields`, `judgeInstrumentId`)
as the two precedents. Read all three `renderEvaluation` copies and `buildRunEvaluation` in
`apps/cli/src/loop-contract.ts` — the loop-contract file calls them "the three renderEvaluation
copies". Built in earlier waves: `@crewhaus/provability` (verifyDocument, evidence, stores,
renderers), `@crewhaus/proof-checker` (createDefaultCheckers), `@crewhaus/tool-proof`
(createProofTools). The runtime seam types `RunEvaluation` / `RunProvability` are in
runtime-core (another builder implements the gate itself in parallel — you only BUILD the
closures).

## The package
- `EvaluationFragment = { specName, primaryModel, evaluation?: IrEvaluation, provability?:
  IrProvability }`; `evaluationFragmentFromIr(ir)` → undefined when NEITHER block is present.
- `wireEvaluation(fragment, deps) → Promise<{ evaluation?: RunEvaluation; provability?:
  RunProvability; tools: RegisteredTool[] }>` with
  `deps = { cwd, catalog?, sessionRootDir?, footerTarget?: "stream" | "reply", sandbox?,
  resolveHead?, now? }`.
  - `evaluation`: EXACTLY today's behaviour of `buildRunEvaluation` (llm_judge through
    `gradeWithJudgePanel` + `inLoopRunResult` + `judgeInstrumentId`, contains, regex — read the
    three emitter copies too and make sure the one implementation covers every knob they render:
    panel, repeats, temperature, target, params, escalateTo, graderType, judgeModel id).
  - `provability`: a `RunProvability` from the IR block: `verify(turn)` builds the evidence
    index from `evidenceFromSessionLog({ sessionId: turn.sessionId, rootDir: sessionRootDir })`
    merged with `evidenceFromMessages(turn.messages)` (`scope: "turn"`: only records from the
    current turn — derive them from the messages after the last NON-synthetic user message
    (`turn.isSynthetic`) — document it); artifacts = the file artifact store under
    `proofsRoot(cwd, specName)`; replay = execute the tool from `deps.catalog` with the logged
    input (find how a RegisteredTool executes and what minimal ctx it needs; pure = readOnly &&
    concurrencySafe && !destructive && scope !== "external"); `resolveHead` = deps.resolveHead
    or a guarded HEAD built on tool-fetch's SSRF-guarded fetch if it exports one (read
    packages/tool-fetch; NEVER a raw fetch — the private-address classifier must apply; if no
    guarded primitive is exported, add `resolve: head` support by exporting a minimal guarded
    HEAD from tool-fetch and report it); judgeWaiver only when `provability.judge` is set: one
    sentinel-hardened yes/no judge call through `@crewhaus/eval-judge` (categorical or scalar —
    read the package) at temperature 0, published on `turn.bus` with `role: "judge"` so it is
    metered under `budget.judge_share` (the same mechanism `gradeWithJudgePanel` uses); level,
    onFail, maxRetries, threshold, escalateTo, render straight from the IR; `renderBundle` =
    provability's footer (render "footer") / JSON (render "json"); `nudge` = `renderNudge`;
    `persist` = the bundle store under `proofsRoot`; `footerTarget` from deps.
  - `tools`: when provability is present, `createProofTools({ config, specName, proofsRoot,
    checkers: createDefaultCheckers(...formal...), evidence: same builder as verify })` →
    always `provabilityPreflight`; plus `proofCheckers` + `proofCheck` when `level === "proven"`
    or `formal.checkers` is non-default — decide and document (the default skill tells the model
    to use them at `proven`).
- `renderEvaluationWiring(ir, { catalogVar, cwdExpr, footerTarget, indent })` — the codegen
  twin every emitter calls instead of its own `renderEvaluation`: returns `{ imports, bootBlock,
  field, toolsRegistration }`. EMPTY strings when the IR has neither block, so those bundles
  stay BYTE-IDENTICAL (prove it: the existing byte/snapshot tests stay green). Otherwise
  `import { wireEvaluation } from "@crewhaus/evaluation-service";`, a boot line
  `const __gates = await wireEvaluation(<JSON fragment>, { cwd: …, catalog: …, footerTarget: … });`,
  a registration line for `__gates.tools` into the bundle's catalog (find how memory tools are
  registered in each emitter), and the runChatLoop fields `evaluation: __gates.evaluation,`
  and/or `provability: __gates.provability,` (only the keys the IR has).
- footerTarget: cli → "stream"; channel → "reply" (the reply text is what the bot sends);
  managed → "reply".

## Emitters + interpreter
Replace the three `renderEvaluation` functions with `renderEvaluationWiring`. Bundles WITH
`evaluation:` change form (one `wireEvaluation` call) with identical behaviour: update the
emitter tests that pinned the old inline code to pin the new call, and keep a behavioural test
(compile a spec with each grader type, run the produced `evaluate` against fixed inputs through
the emitted module or through `wireEvaluation` directly, assert the same verdicts as before).
The bundle's package.json is derived by scanning imports (`apps/cli/src/bundle-manifest.ts
collectCrewhausDeps`) — confirm `@crewhaus/evaluation-service` lands in it.
Interpreter: `evaluationRunOptions(ir)` becomes async (or a new `gateRunOptions`) using
`wireEvaluation`, and both call sites in apps/cli/src/index.ts pass `provability` too and
register the returned tools into the run's catalog. Keep `loop-contract.test.ts` green (update
for async; keep every behavioural assertion).

## Tests (`packages/evaluation-service/src/*.test.ts`)
Fragment from IR (each shape; neither block → undefined); evaluation parity for all three grader
types incl. panel knobs; provability verify end-to-end with a temp session log + messages
(grounded pass/fail), scope turn, replay with a fake pure tool, judge waiver metered on the bus
(fake adapter), artifacts root shared with createProofTools, tools returned per level,
renderEvaluationWiring output (empty when absent; exact strings when present) for each emitter's
options. Compile tests in the three target packages updated; one new compile test per emitter
with `provability:` that asserts the boot line, the field and the tool registration.

Verify: `bunx tsc -b` in evaluation-service, the three targets, apps/cli; `bun test` in
evaluation-service, target-cli, target-channel-bot, target-managed (full), and in apps/cli
`bun test src/loop-contract.test.ts src/hybrid-parity.test.ts src/hybrid-bundle-smoke.test.ts
src/bundle-manifest.test.ts` plus any apps/cli test that greps emitted evaluation code
(`grep -l "gradeWithJudgePanel\|renderEvaluation" apps/cli/src/*.test.ts`). biome.
