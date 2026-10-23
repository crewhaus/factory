# @crewhaus/evaluation-service

The **composition root for in-loop gates** (0.8.0 design §4.4) — the
`wireMemory` / `wireModels` precedent applied to the turn-completion gates.
One call builds the `evaluation:` judge, the `provability:` gate and the proof
tools from the lowered IR; every emitter renders that call and the
`crewhaus run` / `serve` interpreter makes it directly:

```ts
import {
  evaluationFragmentFromIr,
  registerGateTools,
  wireEvaluation,
} from "@crewhaus/evaluation-service";
import { runChatLoop } from "@crewhaus/runtime-core";

const fragment = evaluationFragmentFromIr(ir); // undefined: neither block declared
const gates = fragment
  ? await wireEvaluation(fragment, { cwd: process.cwd(), catalog: defaultCatalog, footerTarget: "stream" })
  : { tools: [], proofTools: [] };
registerGateTools(defaultCatalog, gates); // or: tools = mergeGateTools(tools, gates)

await runChatLoop({
  model, instructions, tools,
  evaluation: gates.evaluation,   // the quality judge (when declared)
  provability: gates.provability, // the proof gate (when declared)
});
```

Before this package the in-loop grader was built in four places that had to
agree — `renderEvaluation` in target-cli, target-channel-bot and
target-managed, and `buildRunEvaluation` in `apps/cli` — and the provability
gate would have been the fifth. Now there is one. runtime-core still receives
closures and stays dependency-free.

## The fragment

```ts
type EvaluationFragment = {
  specName: string;          // proofs live under .crewhaus/proofs/<proofsDirName(specName)>/
  primaryModel: string;      // the llm_judge default
  evaluation?: IrEvaluation; // lowered `evaluation:`
  provability?: IrProvability; // lowered `provability:` (absent at `off`)
};
```

`evaluationFragmentFromIr(ir)` returns `undefined` when the IR has neither
block — the signal for an emitter to render nothing, so those bundles keep
their bytes.

Any name the spec schema admits wires. The proofs directory is
`proofsDirName(specName)`: the name itself when provability's store accepts
it (`[A-Za-z0-9_.-]+`, not dots only), else its safe characters plus a short
sha256 (`support bot` → `support_bot-<12 hex>`), so a name with a space or a
`:` never fails a bundle at boot. Anything that reads the proofs tree uses
the same function.

## `wireEvaluation(fragment, deps)`

`deps`: `cwd` (required), `catalog` (where `checked` replay finds tools — a
`ToolCatalog` or a tool list), `sessionRootDir` (the root the run was given,
if any), `footerTarget` (`"stream"` on the cli, `"reply"` where the returned
text is what gets sent), `sandbox` (for `smt` / `lean4`), `resolveHead`,
`onBundle`, and the test seams `judgeAdapter` / `now`.

Returns `{ evaluation?, provability?, tools, proofTools }`:

- **`evaluation`** — exactly the judge the four retired copies built:
  `llm_judge` through `gradeWithJudgePanel` (panel, repeats, temperature,
  target, profile params; judge spend on the run bus as `role: "judge"`;
  `judgeModel` names the instrument), `contains` / `regex` pure.
- **`provability`** — `verify` runs provability's `verifyDocument` over the
  final text against an evidence index built from the session event log
  (children included) merged with the transcript, scoped by `scope`
  (`turn` = everything after the last real user message — a retry nudge
  does not start a turn); proof artifacts from the spec's proofs root;
  `checked` replay of PURE tools through the catalog (bounded, abortable),
  compared in the shape the log holds the call in — a result over the
  tool-result-store threshold against its logged preview — and never read as
  a mismatch when the tool does not reproduce (a call that left out `now`
  read the clock and is not re-run; two re-runs that disagree with each other
  mean "could not replay"); one guarded HEAD per URL per session under
  `sources.resolve: head` (tool-fetch's `guardedHead`, bounded DNS included;
  the spec's allow list on the cited URL, its deny list and the private-host
  rule on every redirect hop; only answers cached — a timeout or network
  failure is asked again on the next verification — process-wide, so a
  per-turn wiring asks once; each request decided recorded as an
  `egress_decision`, sink `provability.resolve`, host and outcome only, on
  the run's `egressAuditSink`); and, when `provability.judge` is set, one
  sentinel-wrapped yes/no categorical judge call per paraphrase miss, at
  temperature 0, metered on the turn's bus as `role: "judge"`, and skipped —
  not guessed — once the run's `budget.judge_share` is spent. `renderBundle`
  is the footer (or the JSON), `nudge` provability's `renderNudge`, `persist`
  the bundle store.
- **`tools`** — what the level adds: `ProvabilityPreflight` always;
  `ProofCheckers` + `ProofCheck` at `proven`, or when the spec chose its own
  `formal.checkers`. **`proofTools`** — all three, bound to the gate's
  configuration, proofs root and evidence builder: a proof tool the run
  already has (a spec that listed `proofCheck` at `checked`) is replaced by
  its bound twin, since the builtin instance files its artifacts where the
  gate never looks. `registerGateTools(catalog, gates)` and
  `mergeGateTools(tools, gates)` apply that rule.

Every root (proofs, session logs) is resolved per turn for the active tenant
(`@crewhaus/tenancy`), so one wiring at a managed daemon's boot serves every
tenant, fenced; the footer shows a bundle path from the tenant's own root,
never the server's layout. Nothing is opened at wiring time.

## `renderEvaluationWiring(ir, opts)`

The codegen twin: `{ imports, bootBlock, field, toolsRegistration, toolsExpr }`,
all empty when the IR has neither block. The boot line is
`const __gates = await wireEvaluation(<fragment JSON>, { cwd, … });`; the
fields are `evaluation: __gates.evaluation,` / `provability: __gates.provability,`
for the keys the IR has; `registerGateTools(<catalog>, __gates);` puts the
proof tools on the bundle's catalog, replacing a same-named builtin (or, in
`toolsInto: "list"` mode, `toolsExpr` wraps the run's tool list with
`mergeGateTools(…, __gates)`).

`ProvabilityPreflight` and `ProofCheckers` are read-only and carry a builtin
`alwaysAllow` (permission-engine's bookkeeping rules), so the gate's own
nudge never parks a headless turn; `ProofCheck` keeps the mode default.

## Known limits

- The HEAD for `sources.resolve: head` is recorded but not run through the
  egress classifier's lineage check: the gate has no view of the run's
  `dataLineage`.
- Under a managed tenant, `cited` path sources resolve against the daemon's
  workspace (where the managed file tools read too), so whether a path exists
  there shows in the verdict.
