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
text is what gets sent, `"none"` where the caller carries the bundle on its
own envelope and the returned text must be the answer alone — the managed
gateway's `proof`, the channel eval bridge), `sandbox` (for `smt` / `lean4`), `resolveHead`,
`onBundle`, and the test seams `judgeAdapter` / `now`. On `"stream"` the
reader watches every attempt print, so the runtime marks a rejected attempt
✗ before it re-runs the turn, and grades the turn's printed text when its
final message states nothing ("Done."): since the last attempt a pass
rejected (all of it when the final message points back at it, "See
above."), with the narration of what the agent is about to do ("Let me fetch
the policy page first.") left out. `streamed: true` says the same of a run
whose footer rides the returned text but which prints every attempt as it
goes (`crewhaus run --prompt`). The gate also names the run's own state
directories to the verifier (`runtimeStateRoots`: a relocated session root,
the proofs root, the tenant's roots, the environment's relocations), so a
path under one is never a source. On every target a
line of the answer shaped like the footer is served with
`(model-written, not the verdict)` in front of it.

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
  mean "could not replay"; a tool that declares a path among its operative
  arguments, or whose logged input names something in the workspace, is not
  re-run either — its answer was about the workspace as it was, and a golden
  updated since is not a misquoted result); one guarded HEAD per URL per session under
  `sources.resolve: head` (tool-fetch's `guardedHead`, bounded DNS included;
  the spec's allow list on the cited URL, its deny list and the private-host
  rule on every redirect hop; only answers cached — a timeout or network
  failure is asked again on the next verification — process-wide, so a
  per-turn wiring asks once; each URL screened first by the run's egress
  fabric — `ProvabilityTurn.screenEgress`, the egress classifier over the
  run's data lineage at `external-dynamic` — so a URL carrying content a tool
  read is never sent, unless an outside reader — a read-only tool that
  crosses the network: a search hit, a fetched page — handed the run that URL
  verbatim and nothing it carries reached the run any other way; a tool that
  computes inside the run (an echo, a URL normalizer), a local process tool
  (a commit, a diff of a file the model wrote) or one that writes never does,
  and a secret another tool read stays refused whoever hands it back; a refused URL is
  `unresolved`, its detail naming the egress fabric; each
  request decided recorded as an `egress_decision`, sink
  `provability.resolve`, the screen's verdict and the origins it found, host
  and outcome only, on the run's `egressAuditSink`); and, when `provability.judge` is set, one
  sentinel-wrapped yes/no categorical judge call per paraphrase miss, at
  temperature 0, metered on the turn's bus as `role: "judge"`, and skipped —
  not guessed — once the run's `budget.judge_share` is spent. `renderBundle`
  is the footer (or the JSON), `nudge` provability's `renderNudge`, `persist`
  the bundle store, and `displayPath` the footer's path rule for the run's
  live surfaces (the trace event, a halt's detail).
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

`provability.skill` is the rendered `provability` default skill
(`provabilitySkillText`, with the same substitutions the parent's skill
gets), absent when the build ships none. The gate never reads
it: runtime-core projects it, with the floor, onto the bridge as the
read-only provability seam, and the sub-agent spawner puts it in a Task
child's instructions so a researcher child cites the way the parent's gate
reads (design §8). Only the parent's final text is gated.

## One wiring, many runs: `observeProofBundles`

`deps.onBundle` sees every bundle the wiring grades. A surface that wires
once and serves concurrent runs (the managed gateway) needs the bundle of
ONE run, so it composes a per-run observer onto the shared gate for that
run's `runChatLoop`:

```ts
runChatLoop({ …, provability: observeProofBundles(gates.provability, (bundle) => { proof = bundle; }) });
```

Identity without an observer; the gate's own `onBundle` runs first; the
runtime calls `onBundle` once per graded pass, so the last call a run sees
is the standing verdict.

## `renderEvaluationWiring(ir, opts)`

The codegen twin: `{ imports, bootBlock, field, toolsRegistration, toolsExpr }`,
all empty when the IR has neither block. The boot line is
`const __gates = await wireEvaluation(<fragment JSON>, { cwd, … });`; the
fields are `evaluation: __gates.evaluation,` / `provability: __gates.provability,`
for the keys the IR has; `registerGateTools(<catalog>, __gates);` puts the
proof tools on the bundle's catalog, replacing a same-named builtin (or, in
`toolsInto: "list"` mode, `toolsExpr` wraps the run's tool list with
`mergeGateTools(…, __gates)`). `bundleObserverExpr` (the managed emitter's
`args.onProofBundle`) renders the field as
`provability: observeProofBundles(__gates.provability, <expr>),` instead.

`ProvabilityPreflight` and `ProofCheckers` are read-only and carry a builtin
`alwaysAllow` (permission-engine's bookkeeping rules), so the gate's own
nudge never parks a headless turn. So does `ProofCheck(builtin)`: the
sandbox-free checker writes one artifact under the proofs root and starts
nothing, so the honest `proven` path runs unprompted on every surface.
`ProofCheck(smt)` and `ProofCheck(lean4)` start a container and keep the mode
default; on a channel or managed harness `crewhaus lint` says so
(`provability-proofcheck-asks`), with the rule that allows them.

## The `provability` skill: `provabilitySkills(block)` / `renderGateSkills(ir)`

A gated harness advertises `@crewhaus/default-skills`' `provability` skill —
what the gate checks at each rung and how to cite so an answer passes —
rendered from the block by `provabilitySkillSubstitutions`: the floor and
checker order, and every setting that changes what this gate accepts — what
a failing answer becomes (`on_fail`, `max_retries`), how far back evidence
counts (`scope`), whether and how many assumptions pass (`assumptions`,
`max_assumptions`), how many independent sources a `grounded` claim needs —
plus the proof-tool section, kept exactly where `wantsProofCheckTools` wires
`ProofCheckers` + `ProofCheck`. Settings that only make the gate more
lenient than the text (`threshold` below 1, `bibliographic`, `replay: false`)
are left out. `provabilitySkills(ir.provability)` returns it as a
`LoadedSkill` (or `[]` without the block), and every surface passes it as a
builtin to whatever builds its skill list: `discoverSkills({ builtinSkills })`
where it discovers its own, `wireMemory(…, { builtinSkills })` where
continuity owns the surface. Lowest precedence, so a user or project skill
named `provability` replaces it, and classified like every builtin. It is a
pure function of the block rather than part of `wireEvaluation`'s result
because every surface discovers its skills before it wires the gates.
`renderGateSkills(ir)` is its codegen twin — `{ imports, expr }`, both empty
without the block, so a provability-less bundle gains no bytes and its
prompt none either. Task children get the same rendering as text
(`provabilitySkillText`).

## Known limits

- A HEAD sent through a resolver the caller built itself, without a
  `screen`, is recorded but not screened. The research shape's report gate
  screens its own HEADs against every branch's lineage (runtime-core's
  `lineageEgressScreen`), letting through only a URL its crawler already
  requested; a resumed run screens against the branches it ran itself.
- Under a managed tenant, `cited` path sources resolve against the daemon's
  workspace (where the managed file tools read too), so whether a path exists
  there shows in the verdict.
