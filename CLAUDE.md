# CLAUDE.md — Contributor compass for factory

This file is the source of truth for *how* to develop factory. The *what* lives in:

- [docs/AI-Harness-Systems.md](docs/AI-Harness-Systems.md) — the founding architectural thesis (north star; do not modify lightly)
- [docs/COMPILER-ARCHITECTURE.md](docs/COMPILER-ARCHITECTURE.md) — the meta-harness compiler walked through with file paths
- [docs/build-roadmap.md](docs/build-roadmap.md) — what's been built and what comes next
- [docs/MODULE-CATALOG.md](docs/MODULE-CATALOG.md) — ~190 modules across 25 catalog layers

Read those for *what*. Read this for *how*.

## The three architectural pillars

Every change in this repo must respect three invariants. They exist because in 2026-Q2 a critique surfaced that the implementation had drifted from the founding thesis on each axis; the remediation is documented in the corresponding sections of [docs/build-roadmap.md](docs/build-roadmap.md) and the invariants are codified here so future contributors stay anchored.

### Pillar 1 — The compiler is the protagonist

Crewhaus is a **meta-harness compiler**, not "yet another agent loop." Specs flow through `parseSpec → lower → applyPasses → emit` ([packages/compiler/src/index.ts](packages/compiler/src/index.ts)). The IR is a discriminated union — `IrNode = IrV0 | IrWorkflowV0 | IrChannelV0 | IrGraphV0 | IrManagedV0 | IrPipelineV0 | IrCrewV0 | IrResearchV0 | IrBatchV0 | IrVoiceV0 | IrBrowserV0 | IrEvalV0` ([packages/ir/src/index.ts:537](packages/ir/src/index.ts:537)) — and each target shape consumes its own IR variant.

**Contributor rules:**

1. **New target shapes start at the IR**, not at codegen. Add an `Ir<Target>V0` type to the discriminated union, add a `lower` case, add an `emit<Target>(ir: Ir<Target>V0)` function, register it in `emit()`. The `assertNever(ir)` exhaustive check at [packages/compiler/src/index.ts:529](packages/compiler/src/index.ts:529) keeps you honest.
2. **Targets receive their typed IR variant**, never the raw spec. If you reach into `spec.foo` from a target emitter, you've broken the polymorphism — push the field into the IR variant instead.
3. **IR-level optimizations live in `packages/ir-passes/`** as `(IrNode) → IrNode` functions with a type-guard for the variants they touch. See `redundantMcpServerCollapse` at [packages/ir-passes/src/index.ts:113](packages/ir-passes/src/index.ts:113) for the template.
4. **Eval-driven mutations do NOT go in `ir-passes`.** They patch the spec, not the IR — see Pillar 2.
5. **The roadmap, briefs, and recipes for a new feature must cite its IR variant.** If you find yourself documenting something without an IR variant, you're probably adding a runtime feature without first deciding where it lives in the compiler.

### Pillar 2 — Eval is active, not passive

The empirical signal that the harness layer can deliver measurable accuracy gains is DSPy's MIPRO result (+13% on five of seven multi-stage programs, cited in [docs/AI-Harness-Systems.md](docs/AI-Harness-Systems.md)). Crewhaus's eval stack must close the loop: eval failures must produce *spec patches*, not just HTML reports.

The active-optimization layer:

- **[packages/eval-runner](packages/eval-runner)** measures.
- **[packages/prompt-optimizer](packages/prompt-optimizer)** searches the mutation space via a `MutationProvider` interface. Two providers ship: `RuleBasedMutationProvider` (deterministic, default for tests) and `ClaudeMutationProvider` ([packages/prompt-optimizer-claude](packages/prompt-optimizer-claude), model-driven rewriting).
- **[packages/spec-patch](packages/spec-patch)** carries `SpecPatch` + `applySpecPatch(yaml, patch)`, which uses the YAML CST to preserve comments + key order on write-back.
- **[packages/eval-optimizer-orchestrator](packages/eval-optimizer-orchestrator)** wires them together.
- **`crewhaus optimize <spec>`** is the user-facing entry; default emits a patch JSON + HTML diff, `--write-back` rewrites the YAML in place.

**Contributor rules:**

1. **Spec parameters that should be optimizable** must be listed in `OPTIMIZABLE_PATHS` ([packages/spec-patch/src/index.ts](packages/spec-patch/src/index.ts)). If you add a new spec field that affects eval quality (chunkOverlap, defaultK, temperature, instructions), add the path or the optimizer can't reach it.
2. **Patches mutate the spec, never the IR.** The compiler's `lower()` does destructive normalization (sort, freeze, env-var rewriting); IR-level patches can't round-trip back to YAML.
3. **The rule-based provider stays the default in tests** so test fixtures are deterministic. The Claude provider is opt-in via `--mutator claude` and is cost-gated via `--budget-usd`.
4. **Eval reports without a patch are passive grading** — that's fine for canary gates and dashboards, but the system's promise is *active* optimization. Do not let the optimization loop fall out of date with the rest of the eval stack.

### Pillar 3 — Security is a fabric, not a perimeter

Section 18's "safety floor" is necessary but not sufficient. Untrusted content can enter the system at any boundary — MCP responses, sub-agent returns, channel inbound messages, federation peer payloads, skill bodies loaded from disk, compaction summaries that absorbed earlier attacker text — and an attacker who controls one of those boundaries can lateral-move across the system if the boundary doesn't re-verify.

The fabric: **[packages/boundary-classifier](packages/boundary-classifier)** is the single chokepoint. It wraps `prompt-injection-detector` with `TrustOrigin` metadata (`"user" | "mcp" | "subagent" | "channel" | "federation" | "skill" | "compaction" | "tool"`), a content-hash LRU cache, and a configurable severity policy (default: block on malicious, warn on suspicious). `RunContext.originStack` carries the origin chain so trace events record it.

Every site that pulls externally-controlled content into the model's context must classify before injecting. The complete inventory:

| Site | Origin | Where |
|---|---|---|
| MCP tool responses | `"mcp"` | [packages/tool-mcp](packages/tool-mcp) |
| Sub-agent `finalMessage` | `"subagent"` | [packages/sub-agent-spawner](packages/sub-agent-spawner) |
| Inbound channel text | `"channel"` | `packages/channel-adapter-*` |
| Federation peer payloads | `"federation"` | [packages/federation-router](packages/federation-router) |
| Skill bodies | `"skill"` | [packages/skills-registry](packages/skills-registry) |
| Compaction summaries | `"compaction"` | `packages/compaction-*` |
| Tool results | `"tool"` | [packages/runtime-core](packages/runtime-core) |

**Contributor rules:**

1. **Any new module that ingests external content registers a `TrustOrigin`** in `packages/boundary-classifier/src/origins.ts` and calls `classifyBoundary` before the content reaches a model call or a tool result.
2. **Authentication ≠ classification.** mTLS, JWT, and signed cookies verify *who* sent something; they say nothing about *what* the content contains. Classify after authenticating.
3. **The content-hash cache must not be bypassed for performance**; if you find yourself reaching past the classifier, you've made a security regression, not an optimization.
4. **`tool-task` keeps `classifyOutput: false`** because the sub-agent's return is already classified at the spawner boundary. Don't add a second pass at the tool layer — double-classification produces double warnings and burns the cache.
5. **Severity defaults**: malicious → replace with redaction notice; suspicious → keep + log + emit `permission_decision` trace event. Override only via explicit `opts.severity`.

## Cross-cutting expectations

- **TypeScript + Bun** is the primary runtime. Python interop is reserved for slots where the ecosystem genuinely outclasses TS (today: nothing — the Claude-backed `MutationProvider` superseded the originally-deferred DSPy bridge).
- **No new package without a module brief** in [docs/module-briefs](docs/module-briefs). Briefs document responsibilities, depended-on / unblocks, and the catalog layer.
- **Every package owns its tests** under `__tests__/` next to `src/`. Aim for `bun test` to stay ≥ the current pre-PR count.
- **`bun run tsc -b` and `biome check` clean** before every PR. The `.github/workflows/example-corpus.yml` matrix also has to be green.
- **Run `crewhaus doctor --philosophy-alignment`** before sending a PR that touches the IR, the eval stack, or any boundary site. It audits the three pillars against the current tree and exits 1 on drift.

## Where to start reading

- **New target shape?** → `packages/ir/`, `packages/compiler/`, `packages/target-cli/` (smallest target), [docs/COMPILER-ARCHITECTURE.md](docs/COMPILER-ARCHITECTURE.md).
- **New eval grader?** → `packages/eval-grader/`, `packages/grader-registry/`, [docs/recipes/34-building-custom-graders.md](docs/recipes/34-building-custom-graders.md).
- **New tool?** → `packages/tool-builder/`, `packages/tool-catalog/`, [docs/module-briefs/047-tool-builder.md](docs/module-briefs/047-tool-builder.md).
- **New channel?** → `packages/channel-adapter-base/`, an existing adapter like `channel-adapter-slack`, [docs/recipes/37-channel-telegram.md](docs/recipes/37-channel-telegram.md).
- **New trust boundary?** → `packages/boundary-classifier/`, [docs/recipes/41-security-fabric.md](docs/recipes/41-security-fabric.md).
- **Eval-driven optimization?** → `packages/eval-optimizer-orchestrator/`, [docs/recipes/42-active-optimization.md](docs/recipes/42-active-optimization.md).
