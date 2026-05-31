# AGENTS.md — Contributor compass for factory

This file is the source of truth for *how* to develop factory. The *what* lives in:

- [AI-Harness-Systems.md](https://github.com/crewhaus/docs/blob/main/AI-Harness-Systems.md) — the founding architectural thesis (north star; do not modify lightly)
- [COMPILER-ARCHITECTURE.md](https://github.com/crewhaus/docs/blob/main/COMPILER-ARCHITECTURE.md) — the meta-harness compiler walked through with file paths
- [build-roadmap.md](https://github.com/crewhaus/operations/blob/main/build-roadmap.md) — what's been built and what comes next
- [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md) — ~190 modules across 25 catalog layers

Read those for *what*. Read this for *how*.

This file follows the [agents.md](https://agents.md) vendor-neutral convention so any AI coding agent — Claude Code, Cursor, Cline, GitHub Copilot, Aider, OpenAI Codex, and others — picks it up as project memory. A `CLAUDE.md` pointer exists at the repo root for Claude Code's auto-load convention; it redirects here.

## The three architectural pillars

Every change in this repo must respect three invariants. They exist because in 2026-Q2 a critique surfaced that the implementation had drifted from the founding thesis on each axis; the remediation is documented in the corresponding sections of [build-roadmap.md](https://github.com/crewhaus/operations/blob/main/build-roadmap.md) and the invariants are codified here so future contributors stay anchored.

### Pillar 1 — The compiler is the protagonist

Crewhaus is a **meta-harness compiler**, not "yet another agent loop." Specs flow through `parseSpec → lower → applyPasses → emit` ([packages/compiler/src/index.ts](packages/compiler/src/index.ts)). The IR is a discriminated union — `IrNode = IrV0 | IrWorkflowV0 | IrChannelV0 | IrGraphV0 | IrManagedV0 | IrPipelineV0 | IrCrewV0 | IrResearchV0 | IrBatchV0 | IrVoiceV0 | IrBrowserV0 | IrEvalV0 | IrChainV0 | IrChainGameV0` ([packages/ir/src/index.ts:912](packages/ir/src/index.ts:912)) — and each target shape consumes its own IR variant.

**Contributor rules:**

1. **New target shapes start at the IR**, not at codegen. Add an `Ir<Target>V0` type to the discriminated union, add a `lower` case, add an `emit<Target>(ir: Ir<Target>V0)` function, register it in `emit()`. The `assertNever(ir)` exhaustive check at [packages/compiler/src/index.ts:878](packages/compiler/src/index.ts:878) keeps you honest.
2. **Targets receive their typed IR variant**, never the raw spec. If you reach into `spec.foo` from a target emitter, you've broken the polymorphism — push the field into the IR variant instead.
3. **IR-level optimizations live in `packages/ir-passes/`** as `(IrNode) → IrNode` functions with a type-guard for the variants they touch. See `redundantMcpServerCollapse` at [packages/ir-passes/src/index.ts:127](packages/ir-passes/src/index.ts:127) for the template.
4. **Eval-driven mutations do NOT go in `ir-passes`.** They patch the spec, not the IR — see Pillar 2.
5. **The roadmap, briefs, and recipes for a new feature must cite its IR variant.** If you find yourself documenting something without an IR variant, you're probably adding a runtime feature without first deciding where it lives in the compiler.

### Pillar 2 — Eval is active, not passive

The empirical signal that the harness layer can deliver measurable accuracy gains is DSPy's MIPRO result (+13% on five of seven multi-stage programs, cited in [AI-Harness-Systems.md](https://github.com/crewhaus/docs/blob/main/AI-Harness-Systems.md)). Crewhaus's eval stack must close the loop: eval failures must produce *spec patches*, not just HTML reports.

The active-optimization layer:

- **[packages/eval-runner](packages/eval-runner)** measures.
- **[packages/prompt-optimizer](packages/prompt-optimizer)** searches the mutation space via a `MutationProvider` interface. Two providers ship: `RuleBasedMutationProvider` (deterministic, default for tests) and `ClaudeMutationProvider` ([packages/prompt-optimizer-claude](packages/prompt-optimizer-claude), model-driven rewriting).
- **[packages/spec-patch](packages/spec-patch)** carries `SpecPatch` + `applySpecPatch(yaml, patch)`, which uses the YAML CST to preserve comments + key order on write-back.
- **[packages/eval-optimizer-orchestrator](packages/eval-optimizer-orchestrator)** wires them together.
- **`crewhaus optimize <spec>`** is the user-facing entry; default emits a patch JSON + HTML diff, `--write-back` rewrites the YAML in place.

**Contributor rules:**

1. **Spec parameters that should be optimizable** must be listed in `OPTIMIZABLE_PATHS` ([packages/spec-patch/src/index.ts](packages/spec-patch/src/index.ts)). If you add a new spec field that affects eval quality (chunkOverlap, defaultK, temperature, instructions), add the path or the optimizer can't reach it.
2. **Patches mutate the spec, never the IR.** The compiler's `lower()` does destructive normalization (sort, freeze, env-var rewriting); IR-level patches can't round-trip back to YAML.
3. **The rule-based provider stays the default in tests** so test fixtures are deterministic. The model-driven Claude provider is opt-in via `--mutator claude`. The `--budget-usd` cost-gate backed by `cost-tracker` now ships: the orchestrator threads a `cost-tracker`-priced running total through the search, estimates each call's worst-case cost before issuing it, and stops before a mutation call that would exceed the budget — composing with the `iterations` cap (whichever bound is hit first ends the run). Rule-based runs make no model calls and report `$0`.
4. **Eval reports without a patch are passive grading** — that's fine for canary gates and dashboards, but the system's promise is *active* optimization. Do not let the optimization loop fall out of date with the rest of the eval stack.

### Pillar 3 — Security is a fabric, not a perimeter

Section 18's "safety floor" is necessary but not sufficient. Untrusted content can enter the system at any boundary — MCP responses, sub-agent returns, channel inbound messages, federation peer payloads, skill bodies loaded from disk, compaction summaries that absorbed earlier attacker text — and an attacker who controls one of those boundaries can lateral-move across the system if the boundary doesn't re-verify.

The fabric has **two symmetric halves**: a source side (classify content coming in) and a sink side (classify content going out). The OpenAI 2026-05 prompt-injection paper and SACR's 2026 runtime-security report converge on the same insight: source classification is necessary but not sufficient; an attacker who controls a source AND an accessible sink can lateral-move across the agent's permissions even when every individual permission check passes. The egress fabric (recommendation A, v0.2.x) is the symmetric companion that closes that loop.

**Source-side chokepoint** — [packages/boundary-classifier](packages/boundary-classifier). It wraps `prompt-injection-detector` with `TrustOrigin` metadata (`"user" | "mcp" | "subagent" | "channel" | "federation" | "skill" | "compaction" | "tool" | "chain"`), a content-hash LRU cache, and a configurable severity policy (default: block on malicious, warn on suspicious). `RunContext.originStack` carries the origin chain so trace events record it. After a non-blocked verdict, the boundary site also calls `tagContent(ctx, content, origin)` which populates `RunContext.dataLineage` for the sink-side check.

| Source site | Origin | Where |
|---|---|---|
| MCP tool responses | `"mcp"` | [packages/tool-mcp](packages/tool-mcp) |
| Sub-agent `finalMessage` | `"subagent"` | [packages/sub-agent-spawner](packages/sub-agent-spawner) |
| Inbound channel text | `"channel"` | `packages/channel-adapter-*` |
| Federation peer payloads | `"federation"` | [packages/federation-router](packages/federation-router) |
| Skill bodies | `"skill"` | [packages/skills-registry](packages/skills-registry) |
| Compaction summaries | `"compaction"` | `packages/compaction-*` |
| Tool results | `"tool"` | [packages/runtime-core](packages/runtime-core) |
| On-chain payloads / receipts | `"chain"` | [packages/target-onchain](packages/target-onchain), [packages/target-onchain-game](packages/target-onchain-game), [packages/wallet-engine](packages/wallet-engine) |

**Sink-side chokepoint** — [packages/egress-classifier](packages/egress-classifier). On every external-scope tool call (`tool.scope === "external"`), `runtime-core` calls `classifyEgress(payload, ctx, { sinkId, sinkScope })`. The classifier scans `RunContext.dataLineage` for substring matches and folds the per-origin policy across all hits. The default policy is *permissive on `"user"` content, warn on configured sinks, block on dynamic sinks*. Three audit outcomes land in the trace bus and audit-log: `"egress-passed" | "egress-warned" | "egress-blocked"`.

| External sink | Tool | `scope` |
|---|---|---|
| HTTP fetch | [packages/tool-fetch](packages/tool-fetch) | `"external"` |
| Web search / fetch | [packages/tool-web](packages/tool-web) | `"external"` |
| MCP tool call | [packages/tool-mcp](packages/tool-mcp) | `"external"` |
| Channel send | [packages/tool-message-channel](packages/tool-message-channel) | `"external"` |
| EVM tx broadcast | [packages/tool-evm-tx](packages/tool-evm-tx) | `"external"` |
| Image generation upload | [packages/tool-image-generation](packages/tool-image-generation) | `"external"` |

**Intent gate** — orthogonal third layer. Tools that set `requireJustification: true` (default: `SendMessage`, `EvmSendTransaction`, `ImageGenerate`) demand the model supply a `justification` string with each call. `permission-engine`'s `evaluateJustification` checks it against the spec's `instructions` (the goal an attacker cannot influence) via a configurable judge — rule-based by default, LLM-backed in production. Audit kind: `permission_justification_evaluated`. SACR's three-layer model (deterministic governance → behavioral analysis → non-deterministic governance) lands its third layer here; recipe [demos/walkthroughs/53-justification-gates.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/53-justification-gates.md) walks through it.

**Contributor rules:**

1. **Any new module that ingests external content registers a `TrustOrigin`** in [packages/boundary-classifier/src/index.ts:63](packages/boundary-classifier/src/index.ts:63), calls `classifyBoundary` before the content reaches a model call or a tool result, AND calls `tagContent(ctx, content, origin)` after a non-blocked verdict so the sink-side classifier sees it.
2. **Any new tool that crosses a process or network boundary sets `scope: "external"`** in its `ToolDefinition`, and **declares `ioCapability: "network" | "process"`** (the *fact* of crossing a boundary, distinct from `scope`, the *policy*). Tools default to `"internal"` at normalization, so forgetting `scope` is silently insecure — the §41 `crewhaus doctor --philosophy-alignment` check catches it, and `crewhaus compile --strict` (FR-002) fails the build at compile time on any I/O-capable tool left non-external (both share one `auditToolScopes` implementation). The audit keys on `ioCapability` **or** an outward name, so a custom socket-opening tool that declares `ioCapability` is flagged even under a novel name; `--strict` additionally refuses any `mcp__*`/outward-named sink it cannot resolve to a `scope:"external"` tool offline. `buildTool` also infers `"external"` for the definitionally-outward built-in names (`Fetch`/`WebFetch`/`WebSearch`/`SendMessage`/`EvmSendTransaction`/`ImageGenerate`/`mcp__*`), but an explicit annotation on your tool is still required and still wins. The only residual a static check cannot reach is a tool that declares neither `ioCapability` nor an outward name — so declare one.
3. **Destructive or visible-side-effect tools should set `requireJustification: true`** — `SendMessage`, `EvmSendTransaction`, `ImageGenerate`, and federation outbound tools all do.
4. **Authentication ≠ classification.** mTLS, JWT, and signed cookies verify *who* sent something; they say nothing about *what* the content contains. Classify after authenticating.
5. **The content-hash cache must not be bypassed for performance**; if you find yourself reaching past the classifier, you've made a security regression, not an optimization.
6. **`tool-task` keeps `classifyOutput: false`** because the sub-agent's return is already classified at the spawner boundary. Don't add a second pass at the tool layer — double-classification produces double warnings and burns the cache.
7. **Severity defaults**: malicious → replace with redaction notice; suspicious → keep + log + emit `permission_decision` trace event. Override only via explicit `opts.severity` for the source side, `opts.override` for the sink side.

## Cross-cutting expectations

- **TypeScript + Bun** is the primary runtime. Python interop is reserved for slots where the ecosystem genuinely outclasses TS (today: nothing — the Claude-backed `MutationProvider` superseded the originally-deferred DSPy bridge).
- **No new package without a module brief** in [module-briefs](https://github.com/crewhaus/docs/tree/main/module-briefs). Briefs document responsibilities, depended-on / unblocks, and the catalog layer.
- **Every package owns its tests** under `__tests__/` next to `src/`. Aim for `bun test` to stay ≥ the current pre-PR count.
- **`bun run tsc -b` and `biome check` clean** before every PR. The `.github/workflows/example-corpus.yml` matrix also has to be green.
- **Run `crewhaus doctor --philosophy-alignment`** before sending a PR that touches the IR, the eval stack, or any boundary site. It audits the three pillars against the current tree and exits 1 on drift.

## Where to start reading

- **New target shape?** → `packages/ir/`, `packages/compiler/`, `packages/target-cli/` (smallest target), [COMPILER-ARCHITECTURE.md](https://github.com/crewhaus/docs/blob/main/COMPILER-ARCHITECTURE.md).
- **New eval grader?** → `packages/eval-grader/`, `packages/grader-registry/`, [recipes/34-building-custom-graders.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/34-building-custom-graders.md).
- **Canonical eval rubric?** → `packages/grader-12-metric-rubric/` ships the 12-metric framework from TDS's 100+-deployment paper with industry-validated thresholds; install it with one call: `register12MetricRubric(graderRegistry)`. See [recipes/12-eval-harness.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/12-eval-harness.md).
- **New tool?** → `packages/tool-builder/`, `packages/tool-catalog/` — remember to set `scope: "external"` if the tool crosses a network/process boundary, `requireJustification: true` if it has destructive or visible side effects. [module-briefs/047-tool-builder.md](https://github.com/crewhaus/docs/blob/main/module-briefs/047-tool-builder.md).
- **New channel?** → `packages/channel-adapter-base/`, an existing adapter like `channel-adapter-slack`, [recipes/37-channel-telegram.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/37-channel-telegram.md).
- **New trust source boundary?** → `packages/boundary-classifier/`, call `tagContent` after a non-blocked verdict so the sink side sees it, [recipes/41-security-fabric.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/41-security-fabric.md).
- **New external sink / egress check?** → `packages/egress-classifier/`, mark the tool `scope: "external"`, [recipes/51-egress-fabric.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/51-egress-fabric.md).
- **Justification-gated tool?** → `packages/permission-engine/`, set `requireJustification: true` on the tool descriptor, supply an LLM-backed `justificationJudge` to `runChatLoop` for production, [recipes/53-justification-gates.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/53-justification-gates.md).
- **Active context curation (pre-compaction)?** → `packages/compaction-curator/`, opt in via `spec.compaction.curate: true`, [recipes/52-context-curation.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/52-context-curation.md).
- **AST-aware code intelligence?** → `packages/tool-codegraph/`, install the optional peer `@colbymchenry/codegraph`, [recipes/54-codegraph-tool.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/54-codegraph-tool.md).
- **Eval-driven optimization?** → `packages/eval-optimizer-orchestrator/`, [recipes/42-active-optimization.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/42-active-optimization.md).
