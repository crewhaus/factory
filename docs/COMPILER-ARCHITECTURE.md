# Compiler architecture

Crewhaus is a **meta-harness compiler**. A single high-level YAML spec compiles into one of twelve target shapes (CLI agent, sequential workflow, channel bot, stateful graph, managed multi-tenant daemon, RAG pipeline, multi-agent crew, autonomous research bundle, batch worker, voice agent, browser-driving agent, eval bundle). The intent is not "yet another agent loop." It is a typed compiler whose IR is the *only* thing that holds the agent's semantics, and whose backends are swappable codegen functions over that IR.

This doc walks the compiler with file paths so contributors can navigate from a YAML key all the way to the line that emits the corresponding TypeScript.

The thesis itself lives in [docs/AI-Harness-Systems.md §reference-architecture-for-a-harness-creator-tool](AI-Harness-Systems.md). This doc is the implementation map.

## The pipeline at a glance

```mermaid
flowchart LR
    YAML[crewhaus.yaml] --> P[parseSpec]
    P --> S[Spec discriminated union]
    S --> L[lower]
    L --> IR[IrNode discriminated union]
    IR --> AP[applyPasses]
    AP --> IR2[IrNode optimised]
    IR2 --> E[emit]
    E --> B[Bundle: file[]]
    B --> W[writeFileSync]
    W --> AGENT[dist/agent.ts + package.json + ...]
```

Each stage corresponds to a function with a stable signature; nothing in the pipeline reaches around it.

| Stage | Function | File |
|---|---|---|
| Parse + Zod-validate YAML → typed `Spec` | `parseSpec(yaml: string)` | [packages/spec/src/index.ts](../packages/spec/src/index.ts) |
| Lower `Spec` → `IrNode` (the variant matching `spec.target`) | `lower(spec)` | [packages/compiler/src/index.ts:245](../packages/compiler/src/index.ts) |
| Apply IR-level optimisation passes | `applyPasses(ir)` | [packages/ir-passes/src/index.ts:46](../packages/ir-passes/src/index.ts) |
| Dispatch to target emitter | `emit(ir)` | [packages/compiler/src/index.ts:502](../packages/compiler/src/index.ts) |
| Top-level convenience | `compile(yamlText, opts)` | [packages/compiler/src/index.ts:77](../packages/compiler/src/index.ts) |
| CLI entry point | `runCompile(args)` | [apps/cli/src/index.ts](../apps/cli/src/index.ts) |

The CLI does not branch on `spec.target`. The discriminator lives in the YAML and is honoured polymorphically by `lower()` and `emit()`. Adding a new target therefore never touches the CLI.

## The IR is a discriminated union

```ts
// packages/ir/src/index.ts:537
export type IrNode =
  | IrV0          // CLI agent
  | IrWorkflowV0  // Sequential workflow
  | IrChannelV0   // Channel bot daemon
  | IrGraphV0     // Stateful graph runtime
  | IrManagedV0   // Multi-tenant managed daemon
  | IrPipelineV0  // RAG / pipeline
  | IrCrewV0      // Multi-agent crew
  | IrResearchV0  // Autonomous research bundle
  | IrBatchV0     // Queue-driven batch worker
  | IrVoiceV0     // Voice / realtime agent
  | IrBrowserV0   // Computer-use / browser-driving agent
  | IrEvalV0;     // Eval bundle (bootable artefact)
```

Each variant is a separate Zod-validated type with a `target` discriminator. Variants only carry the fields they need: `IrPipelineV0` has `indexing` and `retrieve` blocks but no `tools` array; `IrGraphV0` has `nodes` and `edges` but no `agent`; `IrVoiceV0` has `vad` and `barge_in` settings that no other variant needs. There is no shared mega-shape that targets cherry-pick from.

This is the meta-harness thesis incarnate: **the IR variant *is* the target's contract**. Anything not on the variant cannot be expressed in that target shape.

## IR variant ↔ lowering ↔ emit ↔ section ↔ recipe ↔ example

This is the canonical mapping. Use this table when you need to navigate from a YAML target to its implementation, or vice versa.

| `target` | IR variant | `lower` case | `emit<Target>` | Target package | Build-roadmap | Recipe | Example |
|---|---|---|---|---|---|---|---|
| `cli` | `IrV0` | [compiler L246](../packages/compiler/src/index.ts) | `emitCli` | [packages/target-cli](../packages/target-cli) | §1–§5 | [01](recipes/01-cli-coding-agent.md) | [hello-cli](../examples/hello-cli) |
| `workflow` | `IrWorkflowV0` | [compiler L263](../packages/compiler/src/index.ts) | `emitWorkflow` | [packages/target-workflow](../packages/target-workflow) | §6 | [02](recipes/02-sequential-workflow.md) | [hello-workflow](../examples/hello-workflow) |
| `channel` | `IrChannelV0` | [compiler L279](../packages/compiler/src/index.ts) | `emitChannelBot` | [packages/target-channel-bot](../packages/target-channel-bot) | §12 | [03](recipes/03-slack-bot.md) | [hello-channel](../examples/hello-channel) |
| `graph` | `IrGraphV0` | [compiler L297](../packages/compiler/src/index.ts) | `emitGraph` | [packages/target-graph](../packages/target-graph) | §19 | [05](recipes/05-stateful-graph.md) | [hello-graph](../examples/hello-graph) |
| `managed` | `IrManagedV0` | [compiler L317](../packages/compiler/src/index.ts) | `emitManaged` | [packages/target-managed](../packages/target-managed) | §20 | [11](recipes/11-managed-multitenant.md) | [hello-managed](../examples/hello-managed) |
| `pipeline` | `IrPipelineV0` | [compiler L333](../packages/compiler/src/index.ts) | `emitPipeline` | [packages/target-pipeline](../packages/target-pipeline) | §21 | [06](recipes/06-rag-pipeline.md) | [hello-rag](../examples/hello-rag) |
| `crew` | `IrCrewV0` | [compiler L357](../packages/compiler/src/index.ts) | `emitCrew` | [packages/target-crew](../packages/target-crew) | §22 | [04](recipes/04-multi-agent-crew.md) | [hello-crew](../examples/hello-crew) |
| `research` | `IrResearchV0` | [compiler L379](../packages/compiler/src/index.ts) | `emitResearchBundle` | [packages/target-research-bundle](../packages/target-research-bundle) | §23 | [07](recipes/07-autonomous-research.md) | [hello-research](../examples/hello-research) |
| `batch` | `IrBatchV0` | [compiler L407](../packages/compiler/src/index.ts) | `emitBatchWorker` | [packages/target-batch-worker](../packages/target-batch-worker) | §23 | [08](recipes/08-batch-worker.md) | [hello-batch](../examples/hello-batch) |
| `voice` | `IrVoiceV0` | [compiler L425](../packages/compiler/src/index.ts) | `emitVoice` | [packages/target-voice](../packages/target-voice) | §24 | [09](recipes/09-voice-agent.md) | [hello-voice](../examples/hello-voice) |
| `browser` | `IrBrowserV0` | [compiler L450](../packages/compiler/src/index.ts) | `emitBrowserDriver` | [packages/target-browser-driver](../packages/target-browser-driver) | §25 | [10](recipes/10-browser-agent.md) | [hello-browser](../examples/hello-browser) |
| `eval` | `IrEvalV0` | [compiler L478](../packages/compiler/src/index.ts) | `emitEval` | [packages/target-eval-bundle](../packages/target-eval-bundle) | §29 | [12](recipes/12-eval-harness.md) | [hello-eval](../examples/hello-eval) |

The exact `lower` line numbers may shift as the compiler grows; the table is best-effort. The contract that *does* hold: `emit(ir: IrNode): Bundle` at [packages/compiler/src/index.ts:502](../packages/compiler/src/index.ts) is an exhaustive switch ending in `assertNever(ir)`. Add a variant without registering it here and `tsc` fails.

## Adding a new target shape

Four steps, in order. Skip a step and the compiler will stop you.

### 1. Add the IR variant

Add an `Ir<Target>V0` type to [packages/ir/src/index.ts](../packages/ir/src/index.ts). Append the variant to the `IrNode` union at the bottom of the file. Set `readonly target: "<target>"` so the discriminator works.

The variant should contain *only* what your target needs. If two targets need the same nested type (e.g. `IrPermissions`, `IrMcpServers`), reuse the existing types — those live near the top of `packages/ir/src/index.ts`.

### 2. Add the lowering case

Open [packages/compiler/src/index.ts](../packages/compiler/src/index.ts) and add a case to the `lower(spec: Spec)` switch (around line 245). The case takes `spec.target === "<target>"` and returns a value of your new IR variant. Use the existing `lowerPermissions`, `lowerMcpServers`, `lowerSubAgents`, `lowerSecret`, `lowerToolConfigs` helpers when your variant needs those nested shapes — duplicating the helper logic is a bug.

The output of `lower` is intentionally **lossy** and **canonical**: sub-agent maps become arrays, role names become alphabetically sorted, secrets are rewritten to env-var refs, permission rules are de-duped and re-ordered. This is fine for the IR (its job is to feed codegen) but is the reason eval-driven mutations patch the *spec*, not the IR — see [Pillar 2 in CLAUDE.md](../CLAUDE.md).

### 3. Add the spec branch

Add a Zod schema for the new target to [packages/spec/src/index.ts](../packages/spec/src/index.ts) and append it to the `Spec` discriminated union. The Zod schema is the source of truth for what the YAML may contain; if it isn't in the schema, your `lower` case can't read it.

### 4. Add the target emitter

Create `packages/target-<target>/` with a `src/index.ts` exporting `emit<Target>(ir: Ir<Target>V0): Bundle`. The `Bundle` type lives in [packages/compiler/src/index.ts](../packages/compiler/src/index.ts); it's `{ files: ReadonlyArray<{path, content}> }`. Existing targets are the right templates:

- Smallest: [packages/target-cli](../packages/target-cli) — single `agent.ts` + `package.json`.
- Most complex: [packages/target-managed](../packages/target-managed) — daemon entrypoint + per-tenant config + audit-log wiring.
- Streaming-heavy: [packages/target-voice](../packages/target-voice) — VAD, barge-in, audio adapter.

Then register the emitter in `emit()` at [packages/compiler/src/index.ts:502](../packages/compiler/src/index.ts). The `assertNever(ir)` at the end of the switch will refuse to typecheck until you do.

### 5. Wire the periphery

- Add a recipe to [docs/recipes/](recipes/) and reserve its slot in [docs/recipes/INDEX.md](recipes/INDEX.md).
- Add an example under [examples/hello-<target>/](../examples) with a `crewhaus.yaml` and a smoke script in [scripts/](../scripts).
- Add a row to the IR-variant table above so future contributors can find your target the same way they find the existing ones.
- Add a section to [docs/build-roadmap.md](build-roadmap.md) annotated with `IR variant: Ir<Target>V0 · Catalog layer: F2 · Compiler stage: emit`.

## Adding an IR-level optimisation pass

IR passes are pure `(IrNode) → IrNode` functions. They run between `lower` and `emit`. They are *not* the place for eval-driven mutation (those patch the spec — see Pillar 2); they are for codegen-time optimisations that are safe regardless of runtime evaluation.

Use `redundantMcpServerCollapse` ([packages/ir-passes/src/index.ts:113](../packages/ir-passes/src/index.ts)) as the template. The pattern:

```ts
export function myPass(ir: IrNode): IrNode {
  // 1. Type-guard the variants this pass touches.
  const carriesField = (n: IrNode): n is IrV0 | IrChannelV0 =>
    n.target === "cli" || n.target === "channel";
  if (!carriesField(ir)) return ir;

  // 2. Read the field; bail if there's nothing to do.
  const field = (ir as { field?: SomeShape }).field;
  if (!field || ...trivial-case...) return ir;

  // 3. Transform.
  const newField = transform(field);

  // 4. Bail if nothing changed (preserves referential equality for downstream
  //    passes that short-circuit on `===`).
  if (newField === field) return ir;

  // 5. Return a frozen copy.
  return { ...ir, field: Object.freeze(newField) } as IrNode;
}
```

Then append your pass to `DEFAULT_PIPELINE` at [packages/ir-passes/src/index.ts:198](../packages/ir-passes/src/index.ts). The pipeline order matters; document why your pass goes where it does in the comment above `DEFAULT_PIPELINE`.

Passes must be **idempotent**: applying a pass twice must produce the same result as applying it once. Tests should include a fixed-point assertion (`pass(pass(ir)) === pass(ir)`).

## The lossy lower, and how `crewhaus optimize` writes back

`lower()` is intentionally lossy. The IR is sorted, frozen, deduped, env-var-rewritten — codegen wants those properties, but the path from the IR back to the user's hand-authored YAML is therefore one-way. That asymmetry is what Pillar 2 has to bridge: when an eval failure produces a mutation that should land in the source spec, the optimizer cannot patch the IR (no round-trip) and cannot regenerate the YAML from the IR (would erase the user's comments and key order). The only honest option is to patch the YAML itself.

The mechanism is simpler than it sounds, because spec patches are addressed by **field paths** (`["agent", "instructions"]`), and those paths exist identically in the source YAML and in any structural representation of it. The `yaml` package's [`parseDocument`](https://eemeli.org/yaml/#documents) parses to a **concrete syntax tree (CST)** — the Document AST — whose API operates on the live tree:

```ts
// packages/spec-patch/src/index.ts
import { parseDocument } from "yaml";

const doc = parseDocument(yamlText);   // CST: keeps comments, key order, indentation
doc.setIn(["agent", "instructions"], newPrompt);
const newYaml = doc.toString();        // renders back; only the touched bytes change
```

That's it. No source map. No node-id table. No reverse mapping from IR back to YAML. Patches are addressed by spec path; the CST is addressed by spec path; the parser maintains the original surface form of every node it does not touch. A `--write-back` run leaves your comments where you put them, your indentation as you typed it, and your unrelated keys in the order you wrote them.

### Why this is enough — and where the boundary lives

The reason this works without an elaborate mapping table is that **`OPTIMIZABLE_PATHS` deliberately whitelists only fields whose lowering is field-preserving** ([packages/spec-patch/src/index.ts:186](../packages/spec-patch/src/index.ts)). The whitelist for the CLI target, for example:

```ts
cli: [
  ["agent", "instructions"],     // string — survives lowering 1:1
  ["compaction", "threshold"],   // number — survives lowering 1:1
]
```

`agent.instructions` is a string in the spec, a string in the IR, and a string in the generated bundle. The patch path matches the spec path matches the CST path. Patching is safe.

What is **deliberately excluded** from `OPTIMIZABLE_PATHS` for every target:

- `permissions.rules` — deduped + reordered during `lowerPermissions`. The lowered order is not the source order, so a patch that targeted "rule 3" in the IR would land on the wrong line in the CST. The fix is not a smarter mapping; it is "don't autotune this field." Permission rules are security policy; they require human review anyway.
- `permissions.mode` — security policy.
- `mcp_servers.*` — host/transport config, security-sensitive.
- `subAgents` (raw spec map) — lowered to an array sorted by name; the index path is not stable.
- Anything secret-bearing — `lowerSecret` rewrites `$VAR` → `{kind:"env", name:"VAR"}`; the source string and the IR value have different shapes by design.

The whitelist is the answer to "what happens if the optimizer tries to patch a rule that was deduped during lowering?" — it does not. `validatePatch` ([packages/spec-patch/src/index.ts:157](../packages/spec-patch/src/index.ts)) refuses any path that isn't in `OPTIMIZABLE_PATHS` for the spec's target. Adding a path to the whitelist is the explicit signal that "this field's lower is field-preserving and it is safe to autotune"; if you ever extend the optimisation surface, you owe a test that round-trips a comment-bearing YAML through `applySpecPatch` for the new path.

### The contract, end to end

| Stage | What it does | Why it cannot do the write-back |
|---|---|---|
| `parseSpec` | YAML → typed `Spec` (Zod-validated) | Discards comments / indentation; not invertible. |
| `lower` | `Spec` → `IrNode` (sorted, frozen, deduped, env-rewritten) | Order-canonical; intentionally lossy. |
| `applyPasses` | `IrNode` → optimised `IrNode` | Operates on a derivative of a derivative. |
| `emit` | `IrNode` → `Bundle` (TypeScript source) | Pure codegen target. |
| `applySpecPatch` | `(yamlText, SpecPatch)` → `{yaml, spec}` via the `yaml` CST | The only stage that touches the user's source bytes; preserves comments + key order. |

When the eval optimizer produces a `SpecPatch` and the user runs `crewhaus optimize --write-back`, the pipeline that fires is: existing source YAML → `applySpecPatch` → mutated source YAML on disk. Re-running the compiler on the mutated source then runs the full lossy pipeline again — but the user's source remains the source of truth. See [recipes/42-active-optimization.md §What `--write-back` actually does](recipes/42-active-optimization.md) for a worked before/after.

## What lives where, summarised

| Concern | Lives in |
|---|---|
| YAML schema | [packages/spec](../packages/spec) |
| IR types | [packages/ir](../packages/ir) |
| Spec → IR lowering | [packages/compiler](../packages/compiler) `lower()` |
| IR optimisations | [packages/ir-passes](../packages/ir-passes) |
| IR → Bundle emission | [packages/target-*](../packages) (one per target shape) |
| Generated bundles import this at runtime | [packages/runtime-core](../packages/runtime-core) |
| Eval-driven *spec* mutation | [packages/spec-patch](../packages/spec-patch) (Pillar 2) |
| Trust-boundary classification | [packages/boundary-classifier](../packages/boundary-classifier) (Pillar 3) |

If you're adding a feature and you can't find where it goes, the answer is almost always one of: (a) IR variant, (b) IR pass, (c) target emitter, (d) runtime-core utility consumed by emitted code. Cross-cutting concerns that span multiple targets belong in `packages/runtime-core/` or in a dedicated package referenced by every target's emitter.

## Why this architecture matters

[docs/AI-Harness-Systems.md](AI-Harness-Systems.md) surveys the harness landscape and concludes that no single brand wins; what matters is having "explicit state, typed tools, approvals, compaction, checkpointing, streaming events, OpenTelemetry traces, and first-class eval datasets" available behind a single composable surface. The meta-harness compiler is how crewhaus delivers all of those without locking the user into one harness brand: a pipeline spec lowers into the same `runtime-core` primitives a CLI spec lowers into, but emitted as a Haystack-style component DAG; a graph spec lowers into a LangGraph-style stateful runtime; a managed spec lowers into something closer to Anthropic Managed Agents.

That polymorphism is only honest if the IR variant is the contract. Every drift toward "the cli target reads a thing the IR doesn't expose" is a drift back toward "yet another agent loop with eleven flavours." The contract this document codifies is what keeps the project on the meta-harness side of that line.
