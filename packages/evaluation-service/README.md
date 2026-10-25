# @crewhaus/evaluation-service

The **composition root for in-loop gates**, the `wireMemory` / `wireModels` precedent applied to
the turn-completion gates. One call builds the `evaluation:` judge, the `provability:` gate and
the proof tools from the lowered IR; every emitter that carries the gates renders that call, and
the `crewhaus run` / `serve` interpreter and `crewhaus eval` make it directly:

```ts
import {
  evaluationFragmentFromIr,
  registerGateTools,
  wireEvaluation,
} from "@crewhaus/evaluation-service";
import { runChatLoop } from "@crewhaus/runtime-core";
import { defaultCatalog } from "@crewhaus/tool-catalog";

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

Before this package the in-loop grader was built in four places that had to agree knob for
knob: `renderEvaluation` in target-cli, target-channel-bot and target-managed, and
`buildRunEvaluation` in `apps/cli`. The provability gate would have been the fifth. Now there is
one, and the rule from 0.6.0 covers gates too: a new in-loop gate lands here, never in an
emitter's codegen. runtime-core still receives closures (`RunEvaluation`, `RunProvability`) and
stays dependency-free.

## The fragment

```ts
type EvaluationFragment = {
  specName: string;            // where proofs are filed (see proofsDirName)
  primaryModel: string;        // the llm_judge default
  evaluation?: IrEvaluation;   // lowered `evaluation:`
  provability?: IrProvability; // lowered `provability:` (absent at `off`)
};
```

`evaluationFragmentFromIr(ir)` returns `undefined` when the IR has neither block, the signal for
an emitter to render nothing, so those bundles keep their bytes. The fragment is plain data: an
emitter serializes it into the boot line and the interpreter builds the same object, so a
compiled bundle and `crewhaus run` hand the root the identical input.

Any name the spec schema admits wires. The proofs directory is `proofsDirName(specName)`: the
name itself when provability's store accepts it (`[A-Za-z0-9_.-]+`, not dots only), else its safe
characters plus 12 hex digits of its sha256 (`support bot` → `support_bot-<12 hex>`). Anything
that reads the proofs tree (`crewhaus provability`) uses the same function.

## `wireEvaluation(fragment, deps): Promise<WiredGates>`

```ts
type WireEvaluationDeps = {
  cwd: string;                        // the workspace: path sources resolve here, proofs live under it
  catalog?: GateCatalog;              // where `checked` replay finds tools (a catalog or a tool list); absent ⇒ no replay
  sessionRootDir?: string;            // the root the run was given, if any
  footerTarget?: "stream" | "reply" | "none";
  streamed?: boolean;                 // the reader watches every attempt print (`crewhaus run --prompt`)
  sandbox?: SandboxLike;              // for `smt` / `lean4`; absent ⇒ chosen per run from what the run wires
  resolveHead?: (url, signal?) => Promise<number | undefined>; // default: tool-fetch's guardedHead
  headDeadlineMs?: number;            // one verification's HEAD budget (default 15 s)
  onBundle?: (bundle, bundlePath?) => void;
  proofsRoot?: string;                // the eval runner's per-sample proofs tree
  judgeAdapter?; now?;                // test seams
};

type WiredGates = {
  evaluation?: RunEvaluation;   // present iff the fragment carries `evaluation`
  provability?: RunProvability; // present iff it carries `provability`
  tools: RegisteredTool[];      // what the level adds to every run
  proofTools: RegisteredTool[]; // every proof tool, bound to this gate
};
```

Nothing is opened at wiring time: no directory, log, sandbox or socket. A malformed fragment (no
valid `provability.level`, a non-string `specName`) is refused at boot with
`EvaluationServiceError`.

**`evaluation`** is exactly the judge the four retired copies built: `llm_judge` through
`gradeWithJudgePanel` (panel, repeats, temperature, target, profile params; judge spend on the run
bus as `role: "judge"`; `judgeModel` names the instrument), `contains` / `regex` pure.

**`provability`** carries the IR's resolved `level`, `onFail`, `maxRetries`, `threshold`,
`escalateTo` and `render`, plus the closures runtime-core calls. runtime-core owns the gate (when
it runs, the retry, halt, note and escalate ladder, the trace and audit lines) and runs it before
the `evaluation:` judge, each gate with its own `on_fail` and `max_retries`:

- `verify(turn)` runs provability's `verifyDocument` over the turn's final text against an
  evidence index built from the session event log (children included) merged with the
  transcript. Under `scope: turn` the turn is everything after the last real user message (a
  retry nudge does not start one), and the index holds the whole session with the turn marked
  (`turnNumbers`), so grounding reads the turn while the self-written trace still sees a file an
  earlier turn wrote. It also wires: proof artifacts from the spec's proofs root, with the
  builtin checker re-checking a stored builtin proof (tool-proof's `proofRecheck`); the run's
  own state directories as never-a-source (`runtimeStateRoots`); MCP origins read by the input
  schemas of the run's own catalog; `checked` replay; the HEAD; and the waiver judge.
- `renderBundle` (the footer, or the JSON under `render: json`; absent under `render: none`),
  `displayPath`, `nudge` (provability's `renderNudge`), `persist` (the bundle store, mode 0600),
  `onBundle`, and `skill` (below).

**Replay** (`catalogReplay`) re-runs only a PURE tool (provability's `isPureTool`), parsed through
its own schema, bounded by `REPLAY_TIMEOUT_MS` (10 s) and the turn's signal, and compared in the
shape the log holds it in: a result over the tool-result-store threshold against its logged
preview. It is never read as a mismatch when the tool does not reproduce: a call that left out a
`now` its schema offers read the real clock, so it is not re-run; two re-runs that disagree with
each other mean "could not replay"; and a tool that declares a path among its operative
arguments, or whose logged input names something in the workspace, is not re-run either,
because its answer was about the workspace as it was.

**The HEAD** behind `sources.resolve: head` (`createHeadResolver`) goes through tool-fetch's
`guardedHead`: the spec's allow list on the cited URL, its deny list and the private-host rule on
every redirect hop, DNS bounded. One per URL per session; only answers are cached (a timeout or
network failure is asked again on the next verification), process-wide for the default request
(`SHARED_HEAD_CACHE`), so a per-turn wiring asks once. Before it is sent, each URL goes through
the run's egress fabric (`ProvabilityTurn.screenEgress`, the egress classifier over the run's
data lineage at `external-dynamic`): a URL carrying content a tool read is never sent, unless an
outside reader (a network-reading tool's search hit or fetched page) handed the run that URL
verbatim and nothing it carries reached the run any other way. A refused URL is `unresolved`.
Each request decided is recorded as an `egress_decision` (sink `provability.resolve`, host and
outcome only, never the URL) on the run's `egressAuditSink`.

**The waiver judge** (`createWaiverJudge`), when `provability.judge` is set: one sentinel-wrapped,
two-label categorical call per waivable paraphrase miss, at temperature 0, metered on the turn's
bus as `role: "judge"`, and skipped (not guessed) once the run's `budget.judge_share` is spent.

## Footer targets

`"stream"` on the cli (written after the answer), `"reply"` where the returned text is what gets
sent (channel bots), `"none"` where the caller carries the bundle on its own envelope and the
returned text must be the answer alone (the managed gateway's `proof`, the eval bridges). On
`"stream"`, and wherever `streamed: true` says the reader watches every attempt print, the
runtime marks a rejected attempt ✗ before it re-runs the turn, and when the final message states
nothing ("Done.") it grades the turn's printed text instead: everything since the last attempt a
pass rejected, with narration of what the agent is about to do left out ("Let me fetch the
policy page first.") unless it states something past its announcement or brings a figure of its
own. On every target, a line of the answer shaped like the footer is served with
`(model-written, not the verdict)` in front of it.

## The proof tools

`tools` is what the level adds: `ProvabilityPreflight` always; `ProofCheckers` + `ProofCheck` at
`proven`, or when the lowered `formal.checkers` is not the default `[builtin, smt]`
(`wantsProofCheckTools`).
`proofTools` is every proof tool, built by `@crewhaus/tool-proof`'s `createProofTools` over the
gate's configuration, proofs root and evidence builder. A proof tool the run already has (a spec that
listed `proofCheck` at `checked`) is replaced by its bound twin, since the builtin instance files
its artifacts where the gate never looks. `registerGateTools(catalog, gates)` (call it after the
builtin registrations and before the plugin ones) and `mergeGateTools(tools, gates)` apply that
rule.

`ProvabilityPreflight` and `ProofCheckers` are read-only and carry a builtin `alwaysAllow`
(permission-engine's bookkeeping rules), so the gate's own nudge never parks a headless turn. So
does `ProofCheck(builtin)`: the sandbox-free checker writes one artifact and starts nothing.
`ProofCheck(smt)` and `ProofCheck(lean4)` start a container and keep the mode's default; on a
channel or managed harness `crewhaus lint` says so (`provability-proofcheck-asks`), with the rule
that allows them.

## Tenancy

Every root (proofs, session logs, spilled results) is resolved per turn, and per call for the
tools, for the active tenant (`@crewhaus/tenancy`), and fenced: a root outside the tenant's fails
closed. One wiring at a managed daemon's boot serves every tenant, and the footer shows a bundle
path from the tenant's own root, never the server's layout. `gateProofsRoot`, `gateSessionRoot`,
`fencedDir` and `activeTenant` resolve them through the same tool-proof functions the tools use
(`defaultProofsRoot`, `defaultSessionRoot`), so an artifact the tools file resolves at the gate.

## One wiring, many runs: `observeProofBundles`

`deps.onBundle` sees every bundle the wiring grades. A surface that wires once and serves
concurrent runs (the managed gateway) needs the bundle of one run, so it composes a per-run
observer onto the shared gate for that run's `runChatLoop`:

```ts
runChatLoop({ …, provability: observeProofBundles(gates.provability, (bundle) => { proof = bundle; }) });
```

Identity without an observer; the gate's own `onBundle` runs first; the runtime calls `onBundle`
once per graded pass, so the last call a run sees is the standing verdict.

## `renderEvaluationWiring(ir, opts)`

The codegen twin: `{ imports, bootBlock, field, toolsRegistration, toolsExpr }`, all empty when
the IR has neither block. The boot line is `const __gates = await wireEvaluation(<fragment JSON>,
{ cwd, … });`; the fields are `evaluation: __gates.evaluation,` / `provability:
__gates.provability,` for the keys the IR has; `registerGateTools(<catalog>, __gates);` puts the
proof tools on the bundle's catalog, or in `toolsInto: "list"` mode `toolsExpr` wraps the run's
tool list with `mergeGateTools(…, __gates)`. `bundleObserverExpr` (the managed emitter's
per-run observer) renders the field as `provability: observeProofBundles(__gates.provability,
<expr>),` instead. The cli, channel and managed emitters render it; the research shape imports
`createHeadResolver` and `createWaiverJudge` for its report gate.

## The `provability` skill: `provabilitySkills(block)` / `renderGateSkills(ir)`

A gated harness advertises `@crewhaus/default-skills`' `provability` skill: what the gate checks
at each rung and how to cite so an answer passes. `provabilitySkillSubstitutions` renders it from
the block: the floor and checker order, and every setting that changes what this gate accepts
(`on_fail` and `max_retries`, `scope`, `assumptions` and `max_assumptions`, how many independent
sources a `grounded` claim needs), plus the proof-tool section exactly where
`wantsProofCheckTools` wires the pair. Settings that only make the gate more lenient than the
text (`threshold` below 1, `bibliographic`, `replay: false`) are left out.

`provabilitySkills(ir.provability)` returns it as a `LoadedSkill` (or `[]` without the block),
and every surface passes it as a builtin to whatever builds its skill list:
`discoverSkills({ builtinSkills })`, or `wireMemory(…, { builtinSkills })` where continuity owns
the surface. Lowest precedence, so a user or project skill named `provability` replaces it, and
classified like every builtin. It is a pure function of the block rather than part of
`wireEvaluation`'s result because every surface discovers its skills before it wires the gates.
`renderGateSkills(ir)` is its codegen twin, `{ imports, expr }`, both empty without the block.

`RunProvability.skill` is the same rendering as text (`provabilitySkillText`). The gate never
reads it: runtime-core projects it, with the floor, onto the bridge, and the sub-agent spawner
puts it in a Task child's instructions, so a researcher child cites the way the parent's gate
reads. Only the parent's final text is gated.

## Granular entry points

`wireEvaluation` composes these, and each is exported for a caller that needs one piece:

- `buildRunEvaluation(evaluation, primaryModel, opts?)`: the `RunEvaluation` for a lowered
  `evaluation:` block alone.
- `buildRunProvability(provability, opts)`: the `RunProvability` alone, without the proof tools.
  Its options (`ProvabilityGateOptions`) are `WireEvaluationDeps` without `sandbox`, plus the
  `specName`.
- `gateEvidenceScoped(input)`: the evidence the gate and the preflight both verify against, as
  `{ index, turnNumbers? }` (`turnNumbers` under `scope: turn` only). `gateEvidence(input)` is the
  index alone. The input (`GateEvidenceInput`) names the scope, the session and its log root, the
  workspace, the spill root, the transcript when there is one, and the input-schema lookup MCP
  origins are read by. `currentTurnMessages` and `startsTurnMessage` are the turn rule over a
  transcript: a turn starts at a user message the human sent, never one the runtime injected or
  one carrying only tool results.
- `gateTools(opts)`: the bound proof tools for one configuration, `{ tools, proofTools }` as
  `WiredGates` carries them; `wantsProofCheckTools(config)` and `DEFAULT_FORMAL_CHECKERS`
  (`builtin`, `smt`) decide what `tools` holds.
- Replay: `catalogReplay(catalog, opts?)`, `lookupTool(catalog, name)` over either catalog form,
  `resultText(result)` (a tool result's text blocks joined, as the evidence index reads one),
  `REPLAY_TIMEOUT_MS` and `REPLAY_RECHECK_MS` (the pause before a disagreeing replay runs again).
- The HEAD: `createHeadResolver(sources, head?, cache?)`, `sourceHostPolicy(sources)` (the spec's
  source policy as a host test) and `hopPolicy(sources)` (that policy on the cited URL, the
  private-host rule and `deny` on every redirect hop), `SHARED_HEAD_CACHE`,
  `HEAD_CACHE_ENTRIES` (the most answers one cache keeps) and `RESOLVE_SINK_ID`
  (`provability.resolve`).
- The waiver: `createWaiverJudge(opts)`, its rubric `WAIVER_RUBRIC` and its two labels,
  `WAIVER_SUPPORTED` and `WAIVER_NOT_SUPPORTED`.
- `GATES_VAR` (`__gates`), the variable `renderEvaluationWiring`'s boot line binds.

## Known limits

- A HEAD sent through a resolver the caller built itself, without a `screen`, is recorded but not
  screened. The research report gate screens its own HEADs against every branch's lineage
  (runtime-core's `lineageEgressScreen`), letting through only a URL its crawler already
  requested; a resumed run screens against the branches it ran itself.
- Under a managed tenant, `cited` path sources resolve against the daemon's workspace (where the
  managed file tools read too), so whether a path exists there shows in the verdict.

## Tests

```sh
bun test src
```

`acceptance.test.ts` runs the design's three scenarios through the live loop (`runChatLoop` with
a scripted model, `wireEvaluation`, the real verifier and session event log), the model
misbehaving each time: the fabricated citation at `grounded`, the hand-computed total at
`checked` with the real `MoneyAdd`, and the overlap claim at `proven` with the builtin checker.
`loop.test.ts` runs the honest and self-correcting paths, `acceptance-text.test.ts` holds the
scenarios against the extractor's harder shapes (a claim joined to a follow-up question, written
as a heading), and `provenance-loop.test.ts` holds the self-written and MCP-origin rules in the
loop. No test needs a network, a model or Docker.

Design: [design/0.8.0-provability-release.md](../../design/0.8.0-provability-release.md) §4.4,
§5, §8.
