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
| **8a (this cut)** | `wireModels`, the fragment, and `renderModelWiringFields` — wrapping today's emitted routing fragments **byte-identically**. Nothing is constructed at runtime yet: `runChatLoop` still resolves candidate adapters, opens the scoreboard and builds the `PolicyRouter` from these four options exactly as before. |
| 8b | the `Consult` / `Escalate` tools (`@crewhaus/tool-consult`) registered under `strategy.model_directed` |
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
  modelOverride?: string;  // a caller-forced primary (the interpreter's --model)
};
```

A flag-forced model is an explicit routing decision and the spec's chain,
tiers and pool were authored against the spec's primary, so under an override
they are dropped; `circuitBreaker` is kept — declared alone it breaker-wraps
whichever primary serves. Adapters, the scoreboard root, the bus and the tool
catalog join the deps as the root starts constructing them.

### The output

A `Pick<RunChatLoopOptions, "modelFallbacks" | "circuitBreaker" | "modelTiers"
| "modelPool">` — runtime-core's own option names, so a rename there fails the
build here. Spread-return-`{}`: an empty fragment yields `{}`, values are
carried by reference, keys come out in the order every emitter has always
written them (`MODEL_WIRING_KEYS`).

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
