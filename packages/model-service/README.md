# @crewhaus/model-service

The **composition root for model routing** (0.6.0 design §2 stance 4, module
brief 308) — the `wireMemory` precedent applied to models. Every consumer of
the model-routing IR makes one stable call instead of hand-mirroring the
`runChatLoop` fields per emitter:

```ts
import { modelWiringFragmentFromIr, wireModels } from "@crewhaus/model-service";
import { runChatLoop } from "@crewhaus/runtime-core";

const routing = wireModels(modelWiringFragmentFromIr(ir.agent), {});

await runChatLoop({
  model, instructions, tools,
  ...routing, // modelFallbacks / circuitBreaker / modelTiers / modelPool
});
```

Before this package, ten emitters (cli, channel, managed, workflow, crew,
graph, pipeline, research, batch, browser) and two `crewhaus run` interpreter
sites each rendered the same four fields with a "keep the N copies in sync"
comment — and two of those copies had already drifted. Emitters now emit
through **one** renderer (typed IR in, one call out — Pillar 1), the
interpreter spreads **one** call, and runtime-core keeps receiving plain
options. Every later routing feature lands here, not in codegen.

## What lands when

| PR | This package gains |
|---|---|
| **8a** | `wireModels`, the fragment, and `renderModelWiringFields` — wrapping today's emitted routing fragments **byte-identically**. `runChatLoop` still resolves candidate adapters, opens the scoreboard and builds the `PolicyRouter` from these four options exactly as before. |
| **8b (this cut)** | the `Consult` / `Escalate` tools (`@crewhaus/tool-consult`) constructed under `strategy.model_directed` and returned as the `hybridTools` / `escalation` options; the Consult runner is a nested single-turn `runChatLoop` on a child run context whose model events are re-published on the parent bus (see below) |
| 9a–9d | per-candidate plans, the `preRoute` inputs, cascade wiring, the guide / shadow / committee side-call closures with their child buses |
| 10 | candidate adapter resolution with per-profile chains and breakers, the scoreboard and priors, the router built with rules / classifier / eligibility, judge metering on the run bus |

## `wireModels(fragment, deps)`

### The fragment

The model-routing slice of one lowered model-bearing block — an `IrV0` agent,
a workflow step, a crew role, a graph node, or a pooled single-agent block.
Every such IR block satisfies the shape structurally, so callers pass the
block itself; `modelWiringFragmentFromIr(block)` picks the slice exactly as
the retired renderers read it (an empty `modelFallbacks` is absent).

```ts
type ModelWiringFragment = {
  modelFallbacks?: readonly string[];   // spec model_fallbacks
  circuitBreaker?: IrCircuitBreaker;    // spec circuit_breaker
  modelTiers?: IrModelTiers;            // spec model_tiers
  modelPool?: IrModelPool;              // spec model_pool — carried WHOLE
};
```

`modelPool` is the whole `IrModelPool`, not an allow-list of its keys. The
pool travels to runtime as one blob (`JSON.stringify(modelPool)` in a bundle,
the object itself in the interpreter), so every per-candidate setting, rule,
strategy and reward key the compiler lowers reaches `runChatLoop` verbatim.
The test suite pins one new key per level (profile → candidate → pool) as
observable on the option object, so a later PR cannot drop a key silently.

### The deps

```ts
type WireModelsDeps = {
  modelOverride?: string;    // a caller-forced primary (the interpreter's --model)
  sessionName?: string;      // label for the nested consult loops' sessions (<name>:consult)
  sessionRootDir?: string;   // where those loops persist session / event-log files
  _consultAdapters?: ReadonlyMap<string, ProviderAdapter>;  // test injection, keyed by spec model string
  _consultRunner?: ConsultRunner;                           // test injection: a scripted side call
};
```

A flag-forced model is an explicit routing decision and the spec's chain,
tiers and pool were authored against the spec's primary, so under an override
they are dropped (and with the pool, its hybrid tools); `circuitBreaker` is
kept — declared alone it breaker-wraps whichever primary serves. The
adapters, the scoreboard root, the bus and the tool catalog join the deps as
the root starts constructing them.

### The output

```ts
type ModelWiringRunOptions = {
  modelFallbacks?: readonly string[];
  circuitBreaker?: IrCircuitBreaker;
  modelTiers?: IrModelTiers;
  modelPool?: IrModelPool;
  hybridTools?: ReadonlyArray<RegisteredTool>;  // Consult + Escalate, under strategy.model_directed
  escalation?: EscalationLatch;                 // the Escalate tool's latch the loop consumes
};
```

The `runChatLoop` options fragment under runtime-core's own option names.
Since PR 8b this package depends on `@crewhaus/runtime-core` (the Consult
runner is a nested `runChatLoop`), so the type is pinned assignable to
`Pick<RunChatLoopOptions, keyof ModelWiringRunOptions>` right in `src/` — a
rename or reshaping in runtime-core fails `tsc -b` here — and the cli's
`modelRoutingRunOptions` carries the same pin at the interpreter seam.
Spread-return-`{}`: an empty fragment yields `{}`, values are carried by
reference, keys come out in the order every emitter has always written them
(`MODEL_WIRING_KEYS`), followed by `HYBRID_WIRING_KEYS` when constructed.

## The model-directed pair (`strategy.model_directed: true`)

`wireModelDirected(pool, deps)` builds the two tools from
[`@crewhaus/tool-consult`](../tool-consult):

- the **roster** is the pool's enabled candidates (`enabled: false` never
  becomes a Consult target);
- the **escalation target** is `strategy.cascade.escalate_to` resolved
  against the roster (a tag, a profile, or a model string), else the
  strongest candidate (first `routing.strongTag`-tagged, else the last
  declared — the router's `escalation()` convention); `strategy.
  max_escalations` (default 1) bounds the latch;
- the **Consult runner** (`buildConsultRunner`) runs the target through
  `runChatLoop({ singleTurn: true, tools: [], sessionTarget: "consult",
  modelRole: "consult" })` — never `adapter.stream` — on a **child**
  `RunContext` whose `TraceEventBus` inherits the parent's trace, and whose
  `model_request` / `model_response` events are re-published on the parent
  bus under the parent's envelope with `role: "consult"`. That is what makes
  the parent's cost-tracker price the call, its budget meter count it under
  `budget.judge_share`, and its session mirror persist it. The child is
  minted rather than shared because the singleTurn path mutates
  `runContext.turnNumber`; sharing would inject phantom turns into the parent.
  The reply text is returned raw — classification at TrustOrigin `"consult"`
  (`classifyBoundary` + `tagContent`) happens exactly once, inside the tool.

runtime-core appends `hybridTools` to the effective tool list (first-party
wins a name collision) and consumes `escalation` at its next model call: the
rest of the turn is served by the request's target when it is a roster
candidate, else the strongest; the `model_route` line names the receipt. The
clean-prompt re-run (`runOneTurn(messages, { force })`) lands with the
cascade (PR 9c) on the same seam.

## The side calls (`strategy.guide` / `strategy.shadow` / `strategy.committee`) — PR 9d

`wireSideCalls(pool, deps)` builds the closures runtime-core consumes through
`RunChatLoopOptions.sideCalls` (plan §7.4, §7.6, §7.8); `wireModels` appends
the `sideCalls` key after the routing and hybrid keys when the pool's strategy
declares one of the three, and nothing otherwise. runtime-core owns each
closure's **lifecycle** (when it runs, what its text does, the `model_stage`
events, the scoreboard fold); this package owns the **model calls**, all of
which go through one nested runner, `runNestedSingleTurn`: a tool-less
`runChatLoop({ singleTurn: true })` on the target, on its own child
`RunContext` and child bus, with its `model_request` / `model_response`
re-published on the parent bus under the side call's `role` / `stage`, and
with `persistSession: false` (§16 Q6) — no child session file, no child event
log. The Consult runner rides the same runner.

- **guide** — a bounded call on the guide model (`max_tokens`, default 400;
  `budget_usd` caps the guide's own spend inside the run) that reads the
  executor's instructions and the text-only transcript and returns guidance;
  runtime-core appends it as a `<guide>` block in the volatile system region
  (after the continuity tail, after the cache marker), classified at
  TrustOrigin `"consult"` and lineage-tagged. `every: first_turn` is
  plan-execute: the block stays for the run and the plan is written to the
  continuity plan store when `continuity.savePlan` is wired.
- **shadow** — the same request on the shadow candidate after the primary has
  answered, graded blind with `judgePairwise` (order-swapped) against the
  primary's text on `grade_with` (default: the strongest roster member);
  returns only the verdict. runtime-core samples turns deterministically at
  `sample_rate`, never changes the served text, and records both arms under
  `shadow:<scope>/<band>` (`@crewhaus/routing-store`'s `shadowRouteKey`).
- **committee** (single-turn hosts only) — members run one after another
  (never a parallel `runOneTurn`), `judgeSelect` (`@crewhaus/eval-judge`, two
  order-controlled calls for any N) picks; on disagreement the
  `escalate_on_disagreement` member answers as the tie-breaker, else the
  strongest survivor's answer stands with the disagreement recorded; a failed
  member is excluded, a lone survivor stands, none surviving throws (runtime-
  core then runs the plain turn). The run's total cap gates every call the
  committee makes: runtime-core gates the committee before it starts, and the
  closure re-reads `SideCallTurnContext.budgetGate` before every member and
  before the tie-breaker — past the cap the calls not yet made are excluded
  (`skipped`, cause `budget`), never opened.

The codegen twin `renderSideCallWiringFields(fragment, indent, sessionName)`
renders `...wireSideCalls(<pool blob>, { sessionName }),` onto a pooled
workflow step or graph node whose strategy declares one of the three (the
bundle imports this package); `""` otherwise. Crew roles reach the same
closures through the orchestrator's `composeSideCalls`.

## `renderModelWiringFields(fragment, indent)` — the codegen twin

What an emitter writes into a generated `runChatLoop({...})` call (or a crew
`RoleDefinition`): byte-for-byte the strings the ten emitters used to build
by hand —

```
\n<indent>modelFallbacks: ["a", "b"],
\n<indent>circuitBreaker: {"failureThreshold":2},
\n<indent>modelTiers: {"fast":"…","default":"…"},
\n<indent>modelPool: {"candidates":[…],"policy":"heuristic"},
```

— and `""` when the fragment declares nothing, so pre-existing bundles stay
byte-identical. Parsing the rendered fields back yields exactly
`wireModels(fragment, {})`; the test suite pins that equivalence, which is
what makes a compiled bundle and the interpreter one code path rather than a
mirror.

## Equivalence guarantees (the PR 8a refactor contract)

- Every existing spec compiles to a **byte-identical** bundle (the compiler's
  `pre-continuity` pins plus the new per-shape `model-wiring` pins, generated
  on the pre-refactor tree, all pass unchanged; the demos corpus was diffed
  end to end when the PR landed).
- The `crewhaus run` interpreter spreads the same call at both of its
  routing sites. One drift closed in passing: the single-turn (`serve`)
  path previously dropped `circuitBreaker` under `--model` while the REPL
  path kept it; both now keep it.

See the 0.6.0 design in `design/` and module brief 308 in
[crewhaus/docs](https://github.com/crewhaus/docs).
