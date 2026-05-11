# Module Catalog

> A navigation map for the ~190 modules that compose `crewhaus-factory`. This document is structured so **you don't read it cover-to-cover**. You pick a reading path that matches what you're trying to do, and the path tells you which 5–15 modules to focus on, which pillar to internalise, and which recipes and briefs to follow.

## How to use this document

1. **Start with the [foundations](#foundations-required-reading-for-every-contributor) once.** They're required reading regardless of which path you follow — the three architectural pillars sit underneath every module in the catalog, and the meta-harness compiler thesis explains *why* the catalog has its shape.
2. **Jump to the [reading path](#reading-paths) for your task.** Each path is self-contained: pillar callout, layers to focus on, entry-point packages, recipes, and module briefs.
3. **Use the [layer index](#layer-index) only when you need the full matrix.** It's a reference appendix, not the main body of the document.

The catalog is the architectural shape of the system. Implementation status, in-flight work, and the v1.3 backlog live in [MODULE-CATALOG-STATUS.md](MODULE-CATALOG-STATUS.md). Per-module build briefs (one page each) live in [module-briefs/](module-briefs/README.md). Section-by-section history lives in [build-roadmap.md](build-roadmap.md).

---

## Foundations (required reading for every contributor)

Before you follow any reading path, internalise these three documents. The pillars are non-negotiable; every reading path below presupposes you've read them.

| Document | What it gives you |
|---|---|
| **[CLAUDE.md](../CLAUDE.md)** | The three architectural pillars: (1) the compiler is the protagonist, (2) eval is active not passive, (3) security is a fabric not a perimeter. Each pillar codifies an invariant the project will not violate. |
| **[AI-Harness-Systems.md](AI-Harness-Systems.md)** | The founding thesis. Why a meta-harness; what primitives are universal across harnesses (state, typed tools, approvals, compaction, checkpointing, streaming, OTel, eval). |
| **[COMPILER-ARCHITECTURE.md](COMPILER-ARCHITECTURE.md)** | The compiler pipeline walked through with file paths. `parseSpec → lower → applyPasses → emit`. The IR is a discriminated union; each target shape consumes its own variant. |

### The three pillars in one paragraph each

- **Pillar 1 — Compiler as protagonist.** Specs flow through `parseSpec → lower → applyPasses → emit`. The IR is the contract; a target shape's IR variant is the *only* thing that holds its semantics. Adding a new target starts at the IR, not at codegen. Reaching past the IR into the raw spec from an emitter is a polymorphism break. Read this pillar before any work in F1, F2, or any package named `target-*`. ([CLAUDE.md → Pillar 1](../CLAUDE.md#pillar-1--the-compiler-is-the-protagonist))
- **Pillar 2 — Eval is active.** Eval failures must produce *spec patches*, not just HTML reports. The DSPy MIPRO result (+13% on five of seven multi-stage programs) is the empirical evidence that the harness layer can deliver measurable accuracy gains; the active-optimization stack (`eval-runner` → `prompt-optimizer` → `spec-patch` → `eval-optimizer-orchestrator`) is how crewhaus delivers them. Patches mutate the spec, never the IR — `lower()` does destructive normalization that can't round-trip. Read this pillar before any work in R15, F-eval, or any package named `eval-*` / `*-optimizer` / `spec-patch`. ([CLAUDE.md → Pillar 2](../CLAUDE.md#pillar-2--eval-is-active-not-passive))
- **Pillar 3 — Security is a fabric.** Untrusted content can enter the system at any boundary — MCP, sub-agents, channels, federation peers, skill bodies, compaction summaries, tool results. The `@crewhaus/boundary-classifier` is the single chokepoint; every site that pulls externally-controlled content into the model's context must classify before injecting. Authentication ≠ classification: mTLS and JWTs verify *who*, not *what*. Read this pillar before any work in R8, R5 (MCP), R10 (sub-agents), R13 (channels), R6 (compaction), R9 (skills), or any code path that reads bytes you didn't generate. ([CLAUDE.md → Pillar 3](../CLAUDE.md#pillar-3--security-is-a-fabric-not-a-perimeter))

---

## Reading paths

Pick the path that matches your task. Each path lists the pillar most relevant to your work *plus* the catalog layers, entry-point packages, recipes, and module briefs you'll need. **Every path assumes you've read all three pillars** — the "primary pillar" callout names the one your work most directly touches.

### If you are adding a new target shape

You are the protagonist's protagonist. Adding a target shape is the most architecturally weighty change you can make.

- **Primary pillar:** [Pillar 1 — Compiler as protagonist](../CLAUDE.md#pillar-1--the-compiler-is-the-protagonist). Required re-read.
- **Layers:** F1 (spec / IR), F2 (compiler + emitter).
- **What you must NOT do:** reach into `spec.foo` from your emitter; bypass `assertNever(ir)`; document a new feature without an IR variant.
- **Entry-point packages:** [packages/spec](../packages/spec), [packages/ir](../packages/ir), [packages/compiler](../packages/compiler), an existing `packages/target-*` to template from.
- **Smallest existing target to copy:** [packages/target-cli](../packages/target-cli). **Most complex:** [packages/target-managed](../packages/target-managed).
- **Process:** the four-step walkthrough in [COMPILER-ARCHITECTURE.md → Adding a new target shape](COMPILER-ARCHITECTURE.md#adding-a-new-target-shape). Add the IR variant → add the lowering case → add the spec branch → add the emitter → register in `emit()`. The compiler's `assertNever(ir)` keeps you honest.
- **Recipes:** [01-cli-coding-agent](recipes/01-cli-coding-agent.md), [02-sequential-workflow](recipes/02-sequential-workflow.md), [05-stateful-graph](recipes/05-stateful-graph.md) — read one matching the closest existing shape.
- **Module briefs to read:** 019–025 (spec / IR / compiler / migration-engine), 028–038 (every existing target emitter), 039 (codegen-templates).
- **Stop at:** runtime modules. Your target's job is to emit an `agent.ts` that consumes existing runtime-core primitives. If you find yourself adding new runtime primitives, that's a separate change that should ship first.

### If you are adding a new tool

Tools are the unit of capability the model can invoke. Anything that reads external bytes is a trust boundary.

- **Primary pillar:** [Pillar 3 — Security is a fabric](../CLAUDE.md#pillar-3--security-is-a-fabric-not-a-perimeter) if your tool ingests external content (MCP responses, web fetches, file reads, sub-agent output). Required re-read. If the tool is pure compute, focus on Pillar 1.
- **Layers:** R3 (tool framework), R4 (tool implementations), R8 (permissions / policy) for any tool with side effects.
- **Entry-point packages:** [packages/tool-builder](../packages/tool-builder), [packages/tool-catalog](../packages/tool-catalog), [packages/tool-executor](../packages/tool-executor), an existing tool like [packages/tool-fs](../packages/tool-fs) or [packages/tool-fetch](../packages/tool-fetch).
- **Safety floor:** `buildTool()` defaults are fail-closed. Set `destructive: true` on anything that writes / sends / mutates. Set `requiresSandbox: true` on anything that runs untrusted code. Set `classifyOutput: false` only when the output is already classified upstream.
- **Recipes:** [28-sub-agents-and-task](recipes/28-sub-agents-and-task.md), [29-permissions-deep-dive](recipes/29-permissions-deep-dive.md), [30-sandboxed-code-execution](recipes/30-sandboxed-code-execution.md).
- **Module briefs:** 047 (tool-builder), the relevant tool-* briefs in the R4 row of the brief index.
- **Stop at:** anything outside the tool's own surface. If you need a new permission rule type, that's `permission-engine`. If you need a new sandbox backend, that's `sandbox`. Tools compose; they don't extend infrastructure.

### If you are adding a new channel adapter

Channels are inbound boundaries. Every inbound message is potentially attacker-controlled.

- **Primary pillar:** [Pillar 3 — Security is a fabric](../CLAUDE.md#pillar-3--security-is-a-fabric-not-a-perimeter). Required re-read. Inbound channel content is classified at `TrustOrigin: "channel"` before it reaches the model.
- **Layers:** R13 (channels). Adjacent: R8 (permissions), R7 (sessions / event log), R5 (`webhook-host`).
- **Entry-point packages:** the `ChannelAdapter` interface lives in [packages/channel-adapter-slack](../packages/channel-adapter-slack); existing adapters [channel-adapter-telegram](../packages/channel-adapter-telegram), [channel-adapter-discord](../packages/channel-adapter-discord), [channel-adapter-whatsapp](../packages/channel-adapter-whatsapp), [channel-adapter-imessage](../packages/channel-adapter-imessage) are templates.
- **Mandatory contract:** verify signatures or shared secrets in constant time, return a tagged union from `parseInbound` (`event` / `challenge` / `skip`), surface an `idempotencyKey` so the gateway dedups generically. Authentication checks who; classification checks what — *do both*.
- **Recipes:** [03-slack-bot](recipes/03-slack-bot.md), [37-channel-telegram](recipes/37-channel-telegram.md), [38-channel-discord](recipes/38-channel-discord.md), [39-channel-whatsapp](recipes/39-channel-whatsapp.md), [40-channel-imessage](recipes/40-channel-imessage.md).
- **Module briefs:** look up the channel-adapter-* numbered briefs in the R13 row of the brief index.
- **Don't forget:** wiring the spec / IR / compiler. The channel IR slot is part of `IrChannelV0`; each new adapter extends the discriminated union.

### If you are wiring evaluation or driving optimization

Eval is the empirical signal that the harness layer can move accuracy. Active eval means closing the loop with spec patches.

- **Primary pillar:** [Pillar 2 — Eval is active](../CLAUDE.md#pillar-2--eval-is-active-not-passive). Required re-read. Eval that produces only HTML reports is passive grading — fine for canary gates, but not what the system is *for*.
- **Layers:** R15 (telemetry / eval) and the F-eval sub-layer (optimizer / orchestrator / spec-patch under F2).
- **Entry-point packages:** [packages/eval-runner](../packages/eval-runner), [packages/eval-grader](../packages/eval-grader), [packages/eval-judge](../packages/eval-judge), [packages/prompt-optimizer](../packages/prompt-optimizer), [packages/spec-patch](../packages/spec-patch), [packages/eval-optimizer-orchestrator](../packages/eval-optimizer-orchestrator).
- **CLI surface:** `crewhaus eval` runs a suite. `crewhaus optimize <spec>` runs the active loop; default emits a patch JSON + HTML diff, `--write-back` rewrites YAML in place. `--mutator claude` swaps the default rule-based provider for a model-driven one (cost-gated via `--budget-usd`).
- **Mandatory contract:** if you add a new spec field that affects eval quality, list it in `OPTIMIZABLE_PATHS` (`packages/spec-patch/src/index.ts`) or the optimizer can't reach it. Patches mutate spec, not IR.
- **Recipes:** [12-eval-harness](recipes/12-eval-harness.md), [34-building-custom-graders](recipes/34-building-custom-graders.md), [42-active-optimization](recipes/42-active-optimization.md).
- **Module briefs:** the eval-* briefs in the R15 / F-eval rows; the `grader-registry` and `dataset-registry` briefs.

### If you are hardening a trust boundary

The boundary classifier is a single chokepoint, but new boundary sites are the kind of thing that can land in a PR without anyone noticing.

- **Primary pillar:** [Pillar 3 — Security is a fabric](../CLAUDE.md#pillar-3--security-is-a-fabric-not-a-perimeter). Required re-read. The complete inventory of boundary sites is in CLAUDE.md; if you've added a new site, register a `TrustOrigin` in `packages/boundary-classifier/src/origins.ts` and call `classifyBoundary` before content reaches a model call or a tool result.
- **Layers:** R8 (permission / policy / safety). Adjacent: R5 (MCP), R10 (sub-agents), R13 (channels), R6 (compaction), R9 (skills) — every boundary site lives in a layer.
- **Entry-point packages:** [packages/boundary-classifier](../packages/boundary-classifier), [packages/prompt-injection-detector](../packages/prompt-injection-detector), [packages/permission-engine](../packages/permission-engine), [packages/policy-engine](../packages/policy-engine), [packages/sandbox](../packages/sandbox).
- **Mandatory contract:** classify *after* authenticating. Don't bypass the content-hash cache for performance. `tool-task` keeps `classifyOutput: false` because the sub-agent's return is already classified at the spawner boundary — don't double-classify.
- **Severity defaults:** malicious → replace with redaction notice; suspicious → keep + log + emit `permission_decision` trace event. Override only via explicit `opts.severity`.
- **Recipes:** [41-security-fabric](recipes/41-security-fabric.md), [29-permissions-deep-dive](recipes/29-permissions-deep-dive.md), [30-sandboxed-code-execution](recipes/30-sandboxed-code-execution.md), [22-compliance-and-audit](recipes/22-compliance-and-audit.md), [23-pii-redaction-and-encryption](recipes/23-pii-redaction-and-encryption.md).

### If you are adding a new model provider

The provider adapter is small but conformance-critical — every spec routes through `model-router`, every adapter must honour the canonical `ProviderRequest` / `StreamEvent` shapes.

- **Primary pillar:** [Pillar 1 — Compiler as protagonist](../CLAUDE.md#pillar-1--the-compiler-is-the-protagonist). Required re-read. The `model-router` prefix grammar (`claude-*` / `openai/*` / `gemini/*` / `bedrock/*` / `local/<model>@<url>`) is part of the spec contract.
- **Layers:** R2 (model layer).
- **Entry-point packages:** [packages/adapter-anthropic](../packages/adapter-anthropic) owns the shared `ProviderAdapter` interface and the canonical event shapes. Other adapters: [adapter-openai](../packages/adapter-openai), [adapter-gemini](../packages/adapter-gemini), [adapter-bedrock](../packages/adapter-bedrock). [model-router](../packages/model-router) lazy-loads them.
- **Mandatory contract:** declare `features = { caching, tool_use, vision, thinking, web_search }` accurately — `prompt-cache-manager` and `model-router` route based on these. The `local/<model>@<url>` path reuses the OpenAI client against any OpenAI-compatible local server.
- **Recipes:** [18-multi-provider-fallback](recipes/18-multi-provider-fallback.md), [32-local-models](recipes/32-local-models.md), [33-prompt-caching](recipes/33-prompt-caching.md).
- **Module briefs:** 040–046 cover the model-adapter / model-router / token-budget / prompt-cache / response-format-coercion / reasoning-controller surface.

### If you are working on multi-agent crews / handoffs

Crews are roles that hand off to each other via in-band tools (`Handoff`, A2A `SendMessage`) — they share one `RunContext` and one trace id.

- **Primary pillar:** [Pillar 1 — Compiler as protagonist](../CLAUDE.md#pillar-1--the-compiler-is-the-protagonist) — the crew target's `IrCrewV0` variant is the contract; emitter touches that, not raw spec.
- **Layers:** R10 (multi-agent / coordination), R5 (`a2a-protocol` for in-crew peer messaging). Adjacent: R3 (`tool-task` for sub-agents), R7 (sessions, event log).
- **Entry-point packages:** [packages/target-crew](../packages/target-crew), [packages/crew-orchestrator](../packages/crew-orchestrator), [packages/agent-handoff](../packages/agent-handoff), [packages/a2a-protocol](../packages/a2a-protocol), [packages/agent-context-isolation](../packages/agent-context-isolation), [packages/sub-agent-spawner](../packages/sub-agent-spawner), [packages/sub-agent-permission-inheritance](../packages/sub-agent-permission-inheritance).
- **Mandatory contract:** crew refusal-loop guard trips at depth 2; A2A recursion capped at depth 3; total activations capped at 16. SendMessage in a crew is *not* SendMessage to a channel — they're two different tools at different layers.
- **Recipes:** [04-multi-agent-crew](recipes/04-multi-agent-crew.md), [28-sub-agents-and-task](recipes/28-sub-agents-and-task.md).

### If you are working on memory, RAG, or research

Memory and retrieval feed model context; research is the long-horizon shape that combines retrieval with branch exploration and citation tracking.

- **Primary pillar:** Re-read all three. RAG involves untrusted document content (Pillar 3), pipelines are an IR variant (Pillar 1), and recall-vs-precision is the kind of metric the optimizer can move (Pillar 2).
- **Layers:** R6 (context / memory / compaction), R12 (RAG / retrieval / knowledge), R19 (research-agent-specific).
- **Entry-point packages:** [packages/chunker](../packages/chunker), [packages/embedder](../packages/embedder), [packages/vector-store](../packages/vector-store), [packages/tool-retrieve](../packages/tool-retrieve), [packages/pipeline-engine](../packages/pipeline-engine), [packages/target-pipeline](../packages/target-pipeline) for RAG; [packages/target-research-bundle](../packages/target-research-bundle), [packages/citation-tracker](../packages/citation-tracker), [packages/crawler](../packages/crawler), [packages/planner](../packages/planner), [packages/report-writer](../packages/report-writer) for research.
- **Mandatory contract:** crawler is citation-tracker-backed; re-fetches go through the content cache; citation numbering is by URL of first appearance (not emit order) so re-runs produce byte-identical citation blocks.
- **Recipes:** [06-rag-pipeline](recipes/06-rag-pipeline.md), [07-autonomous-research](recipes/07-autonomous-research.md).

### If you are working on deployment, multi-tenancy, or operations

Deployment is where target shapes meet production constraints. Multi-tenancy is where the security fabric earns its keep.

- **Primary pillar:** [Pillar 3 — Security is a fabric](../CLAUDE.md#pillar-3--security-is-a-fabric-not-a-perimeter) (tenancy / audit) and [Pillar 1 — Compiler as protagonist](../CLAUDE.md#pillar-1--the-compiler-is-the-protagonist) (canary / migration patch the IR not the runtime). Required re-read of both.
- **Layers:** F3 (deployment / operations), R17 (infrastructure / cross-cutting), R16 (`gateway-server`), R14 (rate-limiter / retry-policy / DLQ).
- **Entry-point packages:** [packages/deployment-controller](../packages/deployment-controller), [packages/canary-controller](../packages/canary-controller), [packages/migration-runner](../packages/migration-runner), [packages/spec-registry](../packages/spec-registry), [packages/tenancy](../packages/tenancy), [packages/audit-log](../packages/audit-log), [packages/gateway-server](../packages/gateway-server), [packages/cost-tracker](../packages/cost-tracker), [packages/rate-limiter](../packages/rate-limiter), [packages/circuit-breaker](../packages/circuit-breaker), [packages/secrets-manager](../packages/secrets-manager).
- **Packaging artifacts:** [docker/](../docker), [helm/](../helm), [packages/single-binary-cli](../packages/single-binary-cli), [packages/crewhaus-cloud](../packages/crewhaus-cloud).
- **Mandatory contract:** audit-log is hash-chained — `crewhaus audit verify <tenant>` re-walks the chain. Cross-tenant reads throw at every storage layer (sessions, evals, tool-results, audit). Canary gate calls `regression-runner.gate()` — promotion / auto-rollback both audit-log under kind `deployment_action`.
- **Recipes:** [11-managed-multitenant](recipes/11-managed-multitenant.md), [21-deployment-and-canary](recipes/21-deployment-and-canary.md), [22-compliance-and-audit](recipes/22-compliance-and-audit.md), [24-docker-and-helm](recipes/24-docker-and-helm.md), [36-cloud-deploy](recipes/36-cloud-deploy.md), [27-federation](recipes/27-federation.md).

### If you are working on Studio, IDE integration, or developer experience

Studio is the visual front door; the IDE plugins make spec authoring feel native; the playground is the in-browser REPL.

- **Primary pillar:** [Pillar 1 — Compiler as protagonist](../CLAUDE.md#pillar-1--the-compiler-is-the-protagonist) — Studio compiles + runs specs, IDE plugins schema-validate them. The spec is the user-facing contract; the IR is internal.
- **Layers:** F4 (studio / authoring UX), F5 (plugin SDK).
- **Entry-point packages:** [packages/studio-server](../packages/studio-server), [packages/studio-ui](../packages/studio-ui), [packages/trace-viewer](../packages/trace-viewer), [packages/graph-visualizer](../packages/graph-visualizer), [packages/wizard](../packages/wizard), [packages/scaffold-templates](../packages/scaffold-templates), [packages/plugin-sdk](../packages/plugin-sdk), [packages/vscode-extension](../packages/vscode-extension), [packages/jetbrains-plugin](../packages/jetbrains-plugin), [packages/crewhaus-playground](../packages/crewhaus-playground).
- **Mandatory contract:** the VSCode + JetBrains plugins consume the same `schemas/spec.json` JSON Schema; a drift test asserts the schema covers every `TARGET_SHAPES` entry. Plugin sandbox isolation (`isFsAllowed` / `isNetAllowed`) is fail-closed.
- **Recipes:** [25-vscode-and-jetbrains](recipes/25-vscode-and-jetbrains.md), [26-template-marketplace](recipes/26-template-marketplace.md), [35-studio-walkthrough](recipes/35-studio-walkthrough.md).

### If you are working on voice or realtime audio

Voice has the deepest dependency chain in the catalog — every module is critical-path, every adapter is provider-specific.

- **Primary pillar:** [Pillar 1 — Compiler as protagonist](../CLAUDE.md#pillar-1--the-compiler-is-the-protagonist) — `IrVoiceV0` carries VAD + barge-in + telephony slots no other variant uses.
- **Layers:** R16 (UI / TUI / voice / media).
- **Entry-point packages:** [packages/voice-runtime](../packages/voice-runtime), [packages/vad-engine](../packages/vad-engine), [packages/barge-in-controller](../packages/barge-in-controller), [packages/call-session](../packages/call-session), [packages/target-voice](../packages/target-voice). Telephony adapters under [packages/call-session-*](../packages).
- **Mandatory contract:** every adapter normalises to PCM 16-bit mono at 24kHz. Barge-in uses hysteresis on speech-frame count (default 4 frames in 200ms). VAD framing convention is 30ms.
- **Recipes:** [09-voice-agent](recipes/09-voice-agent.md).

### If you are working on browser / computer-use

The browser target is a single-binary daemon that drives a real Chromium (or host OS) via a `Driver` interface; every input tool is `destructive: true`.

- **Primary pillar:** [Pillar 3 — Security is a fabric](../CLAUDE.md#pillar-3--security-is-a-fabric-not-a-perimeter) — every browser action is fail-closed under the permission engine; vision-grounded actions classify the model's bbox output as untrusted.
- **Layers:** R18 (specialized / advanced), R4 (`tool-screen-capture` / `tool-mouse-keyboard` / `tool-vision-grounding`).
- **Entry-point packages:** [packages/computer-use-driver](../packages/computer-use-driver), [packages/tool-screen-capture](../packages/tool-screen-capture), [packages/tool-mouse-keyboard](../packages/tool-mouse-keyboard), [packages/tool-vision-grounding](../packages/tool-vision-grounding), [packages/target-browser-driver](../packages/target-browser-driver).
- **Mandatory contract:** `Click` / `Type` / `Key` / `Scroll` are `destructive: true` — the permission engine refuses to grant `allow` in default mode without an explicit `alwaysAllow` rule. Driver errors are caught and surfaced as tool-result strings so the model can recover.
- **Recipes:** [10-browser-agent](recipes/10-browser-agent.md).

### If you are reading to understand the architecture (no code change)

You're here to learn the shape of the system, not to ship a PR.

- **Read:** the three pillars (CLAUDE.md), then [AI-Harness-Systems.md](AI-Harness-Systems.md), then [COMPILER-ARCHITECTURE.md](COMPILER-ARCHITECTURE.md).
- **Then:** [GETTING-STARTED.md](GETTING-STARTED.md) — run the hello-cli example, read the generated `agent.ts`. About fifty lines, no surprises.
- **Then:** browse [recipes/](recipes/INDEX.md) — task-oriented walkthroughs that show the catalog in action.
- **Last:** come back here, scan the [layer index](#layer-index), and follow the cross-links into module-briefs for the modules that interest you.

---

## Mental model

The catalog has two halves:

- **Factory-level** (`F1`–`F5`) — the meta-harness compiler itself: spec / IR / lowering / target emitters / deployment / studio / plugins. These modules **do not** end up inside the generated bundle; they produce it.
- **Composable runtime** (`R1`–`R20`) — the building blocks that the compiler wires into the generated `agent.ts`. These modules **do** end up inside the bundle, selected per target shape.

The compiler reads the spec, lowers it into an `IrNode` (one of 12 discriminated-union variants), applies IR-level optimization passes, and dispatches to the target emitter. The emitter writes a `Bundle` of files — typically a single `agent.ts` for simple shapes (cli / workflow / eval), or a daemon + agent + gateway tree for complex shapes (channel / managed / crew / voice). The bundle imports `@crewhaus/runtime-core`, which composes the runtime modules.

```
SPEC (YAML)
    ↓ parseSpec (Zod)
SPEC (typed discriminated union)
    ↓ lower
IR (typed discriminated union — IrV0 | IrWorkflowV0 | … | IrEvalV0)
    ↓ applyPasses (IR-level optimizations)
IR (optimised)
    ↓ emit (target-specific codegen)
BUNDLE (file[])
    ↓ writeFileSync
agent.ts on disk
    ↓ bun
generated agent runs
```

A target shape's IR variant *is* its contract. If a field isn't on the variant, the target can't read it. New target shapes start at the IR, never at codegen.

---

## Target harness shapes

The compiler ships 12 target shapes today. The spec's `target:` field is the discriminator.

| Code | Shape | Reference style | Distinguishing IR fields |
|---|---|---|---|
| `cli` | CLI coding agent | Claude Code, gstack | `agent` + optional `tools` + optional `mcp_servers` + optional `permissions` |
| `workflow` | Sequential workflow | CrewAI Flows, LlamaIndex Workflows | Top-level `model` + `steps[]` with per-step model overrides |
| `channel` | Channel-based assistant | OpenClaw | `channels.{slack,telegram,discord,whatsapp,imessage}` + `routing.sessionKey` |
| `crew` | Multi-agent crew | CrewAI, AutoGen, ADK | `roles{}` + `entry` + optional `routing` |
| `pipeline` | RAG pipeline | Haystack, LlamaIndex | `agent` + `indexing` + `retrieve` |
| `eval` | Evaluation harness | HELM, Ragas, lm-evaluation-harness | `agent` + `dataset` + `graders` + `concurrency` |
| `managed` | Multi-tenant managed runtime | MAF, ADK, Anthropic Managed | `agent` + per-tenant `budgets` + `gateway` config |
| `graph` | Stateful graph runtime | LangGraph | `entry` + `nodes{}` + `edges[]` + optional checkpoint adapter |
| `research` | Autonomous research agent | Deep Research, Manus | `agent` + `branching` + `crawler.config` |
| `voice` | Voice-first / realtime | OpenAI Realtime, Vapi | `agent` + `vad` + `barge_in` + telephony slots |
| `browser` | Browser / computer-use | Operator | `agent` + `startUrl` + driver config |
| `batch` | Batch / queue worker | none mainstream | `agent` + `queue` adapter config |

For the canonical IR-variant ↔ lowering ↔ emit ↔ section ↔ recipe ↔ example mapping, see [COMPILER-ARCHITECTURE.md → IR variant table](COMPILER-ARCHITECTURE.md#ir-variant--lowering--emit--section--recipe--example).

---

## Pillars ↔ layers ↔ build-roadmap sections

This is the navigation cross-reference that ties together the three pillars, the catalog layers, and the section history.

| Pillar | Owns layers | Owns build-roadmap sections | Anchored doc |
|---|---|---|---|
| **Pillar 1 — compiler is the protagonist** | F1 (spec / IR), F2 (compiler / codegen / target emitters), F3 (deployment / migration) | §1–§5 (cli core), §6 (workflow), §12 (channel), §19 (graph), §20 (managed), §21 (pipeline), §22 (crew), §23 (research+batch), §24 (voice), §25 (browser), §28 (ir-passes + deploy), §29 (eval target) | [COMPILER-ARCHITECTURE.md](COMPILER-ARCHITECTURE.md) |
| **Pillar 2 — eval is active** | R15 (telemetry / eval), F-eval (optimizer / orchestrator / spec-patch — sub-layers under F2) | §16 (eval stack), §29 (eval depth), §38 (production graders), §46 (active IR-patch optimizer) | [recipes/42-active-optimization.md](recipes/42-active-optimization.md) |
| **Pillar 3 — security is a fabric** | R8 (permissions / policy / safety), R5 (MCP host — boundary site), R10 (sub-agent — boundary site), R13 (channels — boundary site), R6 (compaction — boundary site), R9 (skills — boundary site) | §7 (permissions), §9 (MCP), §11 (skills), §13 (sub-agents), §18 (safety floor primitive), §29 (compaction), §33 (channel breadth), §34 (federation) | [recipes/41-security-fabric.md](recipes/41-security-fabric.md) |

---

## Layer index

This section is a reference appendix. **You do not read it cover-to-cover.** Each layer table lists every module with a one-sentence responsibility, its target shapes, applicable test layers, and direct dependencies. For implementation status, see [MODULE-CATALOG-STATUS.md](MODULE-CATALOG-STATUS.md). For one-page build briefs, see [module-briefs/](module-briefs/README.md).

Status markers used below: ✅ = shipped, 🚧 = in progress, 🔴 / 🟡 = unbuilt with critical-path / moderate risk, *(no marker)* = unbuilt or low-risk.

Test layer codes (defined in [AI-Harness-Systems.md](AI-Harness-Systems.md)):

| Code | Layer | What it proves |
|---|---|---|
| T1 | Unit | Pure logic correct (schema validation, branching, parsing) |
| T2 | Contract | Adapter honors model/tool/protocol schemas (MCP, A2A, function-call JSON) |
| T3 | Integration | Module wires correctly with neighbors |
| T4 | Replay | Deterministic replay of recorded traces does not regress behavior |
| T5 | Golden | Fixed dataset → expected metrics within thresholds (eval-graded) |
| T6 | Trace-grading | Trajectory quality — tool choices, handoffs, approvals, safety |
| T7 | Load/soak | Concurrency, long-run, resume-after-failure, storage pressure |
| T8 | Security | Prompt injection, tool-escape, policy bypass, PII exfil, sandbox abuse |
| T9 | Property | Randomized property-based testing (fuzz inputs, invariants) |

### Factory-level modules (the meta-harness itself)

These live in `crewhaus-factory` and **produce or operate** generated harnesses. They are not embedded in the generated artifact.

#### F1 — Spec & IR

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `spec-schema` | YAML/TS DSL: agents, tools, channels, workflow, eval, deploy. Versioned, JSON Schema-backed. | All | T1, T9 | — |
| ✅ `spec-parser` | Parse, lint, resolve includes/macros/overlays → AST. | All | T1, T9 | `spec-schema` |
| ✅ `spec-validator` | Type-check, resolve refs, verify tool/agent/model existence, profile constraints. | All | T1, T2, T9 | `spec-schema`, `ir-model` |
| ✅ `ir-model` | Canonical typed IR — discriminated union over 12 target variants. Runtime-agnostic. | All | T1 | — |
| ✅ `ir-passes` | Idempotent IR-level optimization passes (dead-tool elimination, MCP collapse, permission canonicalize). | All | T1, T4 | `ir-model` |
| ✅ `spec-registry` | Multi-version spec storage with environment pinning + tenant overlays. | All | T1, T3 | `ir-model`, `migration-engine` |
| ✅ `migration-engine` | Versioned schema migrations across IR versions; round-trip safe. | All | T1, T4 | `ir-model` |

#### F2 — Compiler & Codegen

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `compiler-core` | Orchestrate parse → validate → lower → applyPasses → emit; dispatch to target backends. | All | T1, T3 | `spec-parser`, `spec-validator`, `ir-model` |
| ✅ `target-cli-bundle` | Codegen for `cli` target — single-file `agent.ts` with tools/MCP/permissions/extensions. | CLI | T1, T3, T7 | `compiler-core`, `codegen-templates`, `runtime-orchestrator` |
| ✅ `target-workflow` | Codegen for `workflow` target — sequential `runChatLoop({singleTurn})` per step. | CRW, MGD, RES | T1, T3 | `compiler-core`, `codegen-templates`, `runtime-orchestrator` |
| ✅ `target-channel-bot` | Multi-file codegen for `channel` target — daemon + gateway + session-router + agent. | CHN | T1, T3 | `compiler-core`, `channel-adapter-base`, `session-store`, `event-log` |
| ✅ `target-graph` | Codegen for `graph` target — `createGraph` builder with HITL + checkpoint resume. | GRPH, MGD, CRW | T1, T4 | `compiler-core`, `graph-engine`, `checkpoint-store` |
| ✅ `target-managed` | Codegen for `managed` target — daemon + gateway-server + tenant + audit-log wiring. | MGD | T1, T3 | `compiler-core`, `bundle-packager`, `audit-log`, `tenancy` |
| ✅ `target-pipeline` | Codegen for `pipeline` target — chunk → embed → store indexing + Retrieve tool. | RAG | T1, T3 | `compiler-core`, `pipeline-engine` |
| ✅ `target-crew` | Codegen for `crew` target — daemon + orchestrator + per-role agent files. | CRW | T1 | `compiler-core`, `crew-orchestrator`, `agent-handoff`, `a2a-protocol` |
| ✅ `target-research-bundle` | Codegen for `research` target — planner / crawler / citation-tracker / branch loop. | RES | T1, T4, T7 | `compiler-core`, `planner`, `crawler`, `citation-tracker`, `report-writer` |
| ✅ `target-batch-worker` | Codegen for `batch` target — queue-consumer driving `runChatLoop` per pulled job. | BATCH | T1, T3, T7 | `compiler-core`, `queue-consumer`, `idempotency-keys` |
| ✅ `target-voice` | Codegen for `voice` target — RealtimeAdapter + VAD + barge-in + call-session. | VOICE | T1, T2, T7 | `compiler-core`, `voice-runtime`, `vad-engine`, `barge-in-controller`, `call-session` |
| ✅ `target-browser-driver` | Codegen for `browser` target — Chromium driver + screenshot/click/type/vision tools. | BROW | T1, T3 | `compiler-core`, `computer-use-driver`, `tool-screen-capture`, `tool-vision-grounding` |
| ✅ `target-eval-bundle` | Codegen for `eval` target — dataset loader, runner, graders, report. | EVAL | T1, T5 | `compiler-core`, `eval-runner`, `dataset-registry`, `grader-registry` |
| 🟡 `bundle-packager` | Package compiled artifacts (Docker/OCI/npm/pypi/manifest). | All | T1, T3 | `compiler-core`, target-* |
| ✅ `codegen-templates` | Templates per target (Bun + Ink CLI, FastAPI service, …). | All | T1 | — |

#### F3 — Deployment & Operations

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `deployment-controller` | Promote / rollback env pins; audit-log every action. | All | T1, T3 | `compiler-core`, `bundle-packager`, `secrets-manager` |
| 🟡 `deployment-profiles` | Profile definitions (local-dev / k8s / lambda / agent-engine / foundry / agentcore / hybrid-vpc). | All | T1 | `deployment-controller`, `secrets-manager`, `tenancy` |
| ✅ `canary-controller` | Stable-hash percent-of-traffic rollout; gate eval-driven auto-promotion / rollback. | MGD, CHN, GRPH | T3, T5, T7 | `deployment-controller`, `eval-service`, `gateway-server` |
| ✅ `migration-runner` | Run schema migrations across all specs in the registry; dry-run + validate-hook. | GRPH, MGD | T1, T4 | `migration-engine`, `checkpoint-store` |
| 🟡 `upgrade-controller` | In-place runtime upgrades, gradual rollout, version pinning. | CLI, CHN, MGD | T1, T3 | `deployment-controller`, `update-channel` |
| ✅ `docker-images` / `helm-chart` / `single-binary-cli` / `crewhaus-cloud` | Packaging artifacts under `docker/`, `helm/`, and dedicated packages. | All | T1, T2 | per-row |
| ✅ Cloud-deploy adapters | `cloud-adapter-{render,flyio,railway,heroku}` (v1.3 §44 — partially landed). | All daemon shapes | T2, T8 | `bundle-packager`, `secrets-manager` |

#### F4 — Studio & Authoring UX

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `studio-ui` | Visual editor: graph layout, tool wiring, channel binding, eval suite editor. | All (authoring) | T1, T3 | `studio-server`, `graph-visualizer`, `trace-viewer` |
| ✅ `studio-server` | Backend: project mgmt, multi-user collab, preview runs, plugin sandbox. | All (authoring) | T1, T3 | `spec-registry`, `eval-service`, `gateway-server` |
| ✅ `trace-viewer` | Visualise traces / runs / replays; trajectory grading UI. Gantt + drilldown. | All | T1, T3 | `trace-event-bus`, `otel-exporter` |
| ✅ `graph-visualizer` | Render IR or live workflow graph (BFS layout + live state via SSE). | GRPH, CRW, RAG, MGD | T1, T3 | `ir-model`, `graph-engine` |
| ✅ `spec-cli` | Command-line: `crewhaus compile / init / run / doctor / eval / optimize / audit / …`. | All | T1, T3 | `compiler-core`, `runtime-orchestrator` |
| ✅ `wizard` | First-run profile + channel/auth setup; 5-question state machine. | CLI, CHN | T1, T3 | `spec-cli`, `scaffold-templates`, `secrets-manager` |
| ✅ `scaffold-templates` | 10 built-in spec templates, one per target shape. | All | T1 | `spec-schema` |
| ✅ `vscode-extension` / `jetbrains-plugin` / `crewhaus-playground` | IDE integration + browser REPL (§35). | All (authoring) | T1, T3 | per-row |
| ✅ `template-registry` / `template-marketplace-client` | Sigstore-signed template marketplace (§40). | All (authoring) | T1, T8, T9 | `spec-registry`, `secrets-manager` |

#### F5 — Plugin SDK & Extension

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `plugin-sdk` (v1; v2 in §41) | Public typed surface for third-party tools, channels, models, graders, target backends. | All | T1, T2 | `tool-catalog`, `channel-adapter-base`, `model-adapter`, `grader-registry` |
| 🔴 `plugin-loader` (v1.3) | Runtime activation, sandboxed import, capability gating. | All | T1, T3, T8 | `plugin-sdk`, `plugin-registry`, `sandbox` |
| 🟡 `plugin-registry` (v1.3) | Discovery, version pinning, signature verification, capability declaration. | All | T1, T2, T8 | `plugin-sdk`, `secrets-manager` |
| 🟡 `module-marketplace-client` (v1.3) | Remote registry for sharing modules (tools / skills / channels / graders). | All | T1, T2 | `plugin-registry`, `secrets-manager` |

### Composable runtime modules (the building blocks)

These ship as **selectable building blocks** the factory wires into a generated harness based on the spec.

#### R1 — Runtime Core (the agent loop)

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `runtime-orchestrator` | Main agent / run loop; state-machine inner loop with pre-turn compaction. | All | T1, T3, T4 | `model-adapter`, `turn-state-machine`, `recovery-engine`, `abort-controller`, `run-context`, `tool-executor` |
| 🟡 `query-engine` | SDK/headless wrapper over orchestrator (`submitMessage()` async-gen). | All | T1, T3 | `runtime-orchestrator` |
| ✅ `turn-state-machine` | Pure FSM: NeedModel / NeedTools / NeedCompaction / NeedRecovery / Done. | All | T1, T9 | — |
| ✅ `recovery-engine` | Decision function `recover(error, state) → RecoveryAction` over Anthropic taxonomy. | CLI, CHN, CRW, GRPH, MGD, RES | T1, T4 | `error-types` |
| 🟡 `stream-runtime` | Generator composition: provider stream → orchestrator → consumer. | All | T1, T3, T7 | `runtime-orchestrator`, `streaming-tool-executor` |
| ✅ `abort-controller` | Parent/child AbortTree with WeakRef cascade. | All | T1, T3 | — |
| 🟡 `scheduler` | Concurrency primitives: bounded parallelism, queue, priority lanes. | All | T1, T7 | `run-context`, `abort-controller` |
| 🔴 `durability-mode` | Configurable durability: `exit` / `async` / `sync` checkpoint write. | GRPH, MGD, CHN, RES | T1, T4, T7 | `checkpoint-store`, `event-log`, `runtime-orchestrator` |
| ✅ `run-context` | Per-run context: runId, sessionId, turnNumber, abortSignal, logger. | All | T1, T3 | `logging`, `abort-controller` |

#### R2 — Model Layer

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `adapter-anthropic` | Owns the shared ProviderAdapter interface + canonical StreamEvent shapes. | All | T1, T2 | — |
| ✅ `adapter-openai` | OpenAI Chat Completions adapter; also drives `local/<model>@<url>`. | All | T1, T2 | `adapter-anthropic` |
| ✅ `adapter-gemini` | Google Gemini adapter via `@google/genai`. | All | T1, T2 | `adapter-anthropic` |
| ✅ `adapter-bedrock` | AWS Bedrock adapter (Anthropic / Llama / Mistral families). | All | T1, T2 | `adapter-anthropic` |
| ✅ `model-router` | Parse `agent.model`, lazy-load matching adapter. Strict prefix grammar. | All | T1, T7 | `adapter-anthropic` |
| ✅ `token-budget` | `estimateTokens` + `TokenBudget` with `isApproachingLimit`. | All | T1, T9 | — |
| ✅ `prompt-cache-manager` | Rotate Anthropic `cache_control` markers; skip for OpenAI auto / Bedrock non-Anthropic. | All | T1, T3, T9 | `model-adapter` |
| 🟡 `response-format-coercion` | Force structured JSON output; schema validation; retry-on-malformed. | All | T1, T2, T9 | `model-adapter`, `recovery-engine` |
| 🟡 `reasoning-controller` | Thinking modes / extended thinking, effort levels. | CLI, CHN, CRW, GRPH, RES | T1, T5 | `model-adapter` |
| 🟡 `speculation-engine` | Speculative decoding / pre-fetch of likely-next-tool. | CLI, RES | T1, T7 | `model-adapter`, `runtime-orchestrator` |
| ✅ `cost-tracker` | Subscribe to `model_response`, emit `cost_accrual`. Per-run + per-tenant USD aggregation. | All | T1, T3, T7, T9 | `trace-event-bus` |
| 🟡 `auth-profiles` | Multi-provider creds; profile switching; rotation. | All | T1, T2, T8 | `secrets-manager` |
| ✅ `embedder` | Embedding model adapter — OpenAI / Voyage / Cohere / local. | RAG, RES, CHN, MGD | T1, T2 | `model-adapter` |

#### R3 — Tool Layer (core)

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `tool-catalog` | Registry of tools w/ metadata (concurrency-safe, read-only, destructive, defer). | Most | T1 | — |
| ✅ `tool-builder` | Factory `buildTool()` w/ fail-closed safety defaults. | All | T1, T9 | `tool-catalog` |
| ✅ `tool-orchestrator` | Partition tool calls into concurrent + serial batches. | Most | T1, T3, T7 | `tool-catalog` |
| ✅ `tool-executor` | Execute single tool: validate → permission → invoke → format result. | Most | T1, T3 | `tool-catalog`, `tool-validate`, `permission-engine` |
| ✅ `streaming-tool-executor` | Execute tools while model still streaming. | CLI, CHN, RES | T1, T3, T7 | `tool-executor`, `abort-controller` |
| ✅ `tool-result-store` | Persist large tool outputs to disk; preview to model. | CLI, CHN, RES | T1, T3 | `infra-utils` |
| ✅ `tool-loop-detection` | Detect repeated tool calls; prevent runaway. | CLI, CHN, CRW, GRPH, RES | T1, T9 | — |
| 🟡 `tool-search` | Deferred tool loading by keyword (saves tokens). | CLI, CHN, RES | T1, T5 | `tool-catalog`, `embedder` |
| 🟡 `tool-display` | Render tool calls/results in TUI/UI. | CLI, CHN | T1, T3 | `tool-catalog`, `tui-runtime` |
| ✅ `tool-permission-matcher` | Pattern matchers for permission rules (`Bash(git *)`, glob, etc). | All | T1, T9 | — |
| ✅ `tool-validate` | Pre-permission input validation per tool (Zod). | All | T1, T2 | `tool-catalog`, `error-types` |

#### R4 — Built-in Tool Implementations

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `tool-fs` | Read / Write / Edit / Glob / Grep sandboxed to cwd. Atomic writes. | CLI, CHN, CRW, RES, BATCH | T1, T3, T8 | `tool-builder` |
| ✅ `tool-bash` | Shell exec via `Bun.spawn`, default 30s timeout. Host trust level (operator escape hatch). | CLI, CHN, BATCH, RES | T1, T3, T8 | `tool-builder`, `abort-controller` |
| 🟡 `tool-process` | Long-running background processes; monitoring; log capture. | CLI, CHN, BATCH | T1, T3, T7 | `tool-bash`, `scheduler` |
| ✅ `tool-code-execution` | Sandboxed Python / JavaScript / Shell REPL tools. | CLI, MGD, EVAL, RES, BATCH | T1, T3, T7, T8 | `tool-builder`, `sandbox` |
| ✅ `tool-web-search` | Brave / Tavily search providers via env. | CLI, CHN, CRW, RAG, RES | T1, T2 | `tool-builder`, `secrets-manager` |
| ✅ `tool-web-fetch` | URL fetch + HTML→markdown via cheerio/turndown. Allow-list capable. | CLI, CHN, CRW, RAG, RES | T1, T2, T8 | `tool-builder` |
| 🔴 `tool-browser` | Stateful browser automation (Playwright/Chromium). | CLI, CHN, CRW, RES, BROW | T1, T3, T7, T8 | `tool-builder`, `sandbox`, `computer-use-driver` |
| ✅ `tool-mcp` | Wrapper presenting external MCP tools as native tools. | CLI, CHN, MGD, RES, BROW | T1, T2, T3 | `mcp-host`, `tool-builder`, `tool-catalog` |
| ✅ `tool-image` | Read image inputs and present as Anthropic content blocks. Magic-byte sniff. | CLI, CHN, CRW | T1, T8 | `tool-builder` |
| ✅ `tool-fetch` | Generic HTTP escape hatch with fail-closed allow-list + SSRF guard. | CLI, CHN, CRW, MGD | T1, T8 | `tool-builder` |
| 🔴 `tool-tts-stt` | TTS + speech-to-text tools. | CHN, VOICE | T1, T2, T7 | `tool-builder`, `voice-runtime`, `audio-stream` |
| ✅ `tool-todo` | TodoWrite over a per-process list; markdown checklist render. | CLI, CRW, RES | T1 | `tool-builder` |
| ✅ `tool-skill` | Read SKILL.md → context. | CLI, CHN, RES | T1, T3 | `tool-builder`, `skills-registry` |
| 🟡 `tool-ask-user` | Interactive question prompting. | CLI, CHN, CRW, VOICE | T1, T3 | `tool-builder`, `hitl-engine` |
| 🟡 `tool-cron` | Cron-job CRUD tool. | CLI, CHN | T1, T3 | `tool-builder`, `scheduler-cron` |
| ✅ `tool-task` | Spawn sub-agent in isolated context; child catalog filtered to allowed tools. | CLI, CHN, CRW, RES | T1, T3 | `tool-builder`, `sub-agent-spawner`, `sub-agent-permission-inheritance` |
| 🟡 `tool-message-channel` | `SendMessage(channel, text)` — destructive, fail-closed, requires explicit alwaysAllow. | CHN | T1, T2, T8 | `tool-builder`, `channel-adapter-base`, `permission-engine` |
| 🟡 `tool-memory` | Memory get / search tool. | CHN, CRW, GRPH, RES | T1, T5 | `tool-builder`, `memory-service` |
| ✅ `tool-retrieve` | Embed query → vector-store query → top-k citations. | RAG, CRW, CHN, RES | T1, T8 | `tool-builder`, `embedder`, `vector-store` |
| `tool-plan-mode` | Plan-mode entry/exit (read-only planning). | CLI, RES | T1, T3 | `tool-builder`, `autoplan-engine` |
| `tool-worktree` | Git worktree management. | CLI | T1, T3 | `tool-builder`, `tool-bash` |
| 🟡 `tool-lsp` | Language-server queries (defs, refs, diagnostics). | CLI | T1, T2, T3 | `tool-builder`, `lsp-host` |
| 🟡 `tool-monitor` | Stream lines from long-running process as notifications. | CLI, CHN, BATCH | T1, T3, T7 | `tool-builder`, `tool-process` |
| `tool-sleep` | Schedule a wakeup. | CLI, CHN, RES | T1 | `tool-builder`, `scheduler` |
| `tool-notebook-edit` | Jupyter notebook edits. | CLI, RAG | T1, T3 | `tool-builder`, `tool-fs` |
| 🟡 `tool-notification` / `tool-remote-trigger` / `tool-canvas` / `tool-citations` | Cross-cutting outbound + content tools. | varies | T1+ | per-row |
| ✅ `tool-screen-capture` | `Screenshot()` returning Anthropic image block. | BROW, CLI | T1, T3 | `tool-builder`, `computer-use-driver` |
| ✅ `tool-mouse-keyboard` | Click / Type / Key / Scroll — all `destructive: true`. | BROW | T1, T3 | `tool-builder`, `computer-use-driver` |
| ✅ `tool-vision-grounding` | `FindElement(description)` → vision-model bbox lookup. | BROW, CLI | T1, T5, T6 | `tool-builder`, `tool-screen-capture`, `model-adapter` |
| 🟡 `tool-dom-inspector` | DOM/AX-tree-based element queries (when in browser). | BROW | T1, T2, T3 | `tool-builder`, `browser-extension-bridge` |

#### R5 — MCP & Protocol Hosts

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `mcp-host` | MCP client manager: stdio + SSE, reconnect, server registry. | Most | T1, T2, T7, T8 | `error-types`, `infra-utils` |
| 🟡 `mcp-server-host` | Expose harness's tools as an MCP server. | CHN, MGD | T1, T2, T8 | `tool-catalog`, `mcp-host`, `gateway-server` |
| ✅ `a2a-protocol` | In-crew agent-to-agent peer messaging; traceparent-propagating envelope. | CRW (MGD future) | T1, T2, T9 | `agent-context-isolation`, `tool-builder`, `trace-event-bus` |
| 🟡 `acp-protocol` | Agent Control Plane protocol (session policy, approvals, spawning). | CHN, MGD | T1, T2 | `permission-engine`, `hooks-engine`, `gateway-server` |
| 🟡 `ag-ui-protocol` | Agent-UI protocol streaming UI events. | CLI, CHN, MGD | T1, T2, T3 | `trace-event-bus`, `gateway-server` |
| 🟡 `webhook-host` | Inbound webhook receiver. | CHN, BATCH, MGD | T1, T2, T8 | `secrets-manager`, `gateway-server`, `idempotency-keys` |

#### R6 — Context & Memory

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| 🟡 `context-engine` | Pluggable context-management interface (bootstrap/maintain/ingest/assemble/compact). | CLI, CHN, CRW, GRPH, RES | T1, T3 | `ir-model`, `runtime-orchestrator`, `token-budget` |
| ✅ `compaction-snip` | Middle-message removal with marker; tool-use/result boundary defense. | CLI, CHN, RES | T1, T9 | `token-budget` |
| 🟡 `compaction-microcompact` / `compaction-context-collapse` / `compaction-reactive` / `compaction-tool-result-budget` / `compaction-session-memory` | Compaction-stack variants for different windows + triggers. | CLI, CHN, RES, GRPH, MGD | T1, T4–T5 | per-row |
| ✅ `compaction-autocompact` | Model-summarize-then-replace; returns marker pair. | CLI, CHN, CRW, GRPH, MGD, RES | T1, T5 | `model-adapter`, `token-budget` |
| 🟡 `bootstrap-files` | Workspace-file injection (CLAUDE.md / AGENTS.md / …), budget, caching. | CLI, CHN, RES | T1, T3, T9 | `context-engine`, `token-budget`, `tool-fs` |
| 🟡 `system-prompt-builder` | Composable sections with per-section token budgets. | All | T1, T9 | `context-engine`, `token-budget` |
| 🔴 `memory-service` | Long-term memory (key-value, vector, episodic, declarative). | CHN, CRW, GRPH, RES | T1, T3, T5 | `vector-store`, `embedder`, `session-store` |
| 🟡 `memory-extraction` | Auto-extract memories from conversations. | CHN, CLI, RES | T1, T5, T8 | `memory-service`, `model-adapter`, `pii-redactor` |
| 🟡 `personalization-store` | User preference + identity store. | CHN | T1, T8 | `secrets-manager`, `session-store` |
| ✅ `vector-store` | Vector index (in-memory default; Lance / Qdrant / Pinecone / Weaviate backends). | RAG, CHN, CRW, RES | T1, T2, T7 | `embedder`, `secrets-manager` |

#### R7 — State, Sessions, Persistence

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `session-store` | Short-term session state, identity, lifecycle. File-backed JSON; mtime-based eviction. | All | T1, T3, T7 | `infra-utils`, `error-types` |
| ✅ `event-log` | Append-only JSONL transcript; `appendFileSync` mode 0o600. | All | T1, T4, T7 | `session-store`, `infra-utils` |
| ✅ `checkpoint-store` | File-backed JSON checkpoints under `.crewhaus/graphs/<grun>/<ckpt>.json`. | GRPH, MGD, CHN, RES | T1, T4, T7 | `event-log`, `state-store` |
| ✅ `state-store` | In-process zustand-style state container; referential-equality selectors. | All | T1, T9 | — |
| 🟡 `app-state-store` | Monolithic typed AppState for running harness. | CLI, CHN | T1, T3 | `state-store` |
| `global-state-singleton` | Process-global registry (`Symbol.for`). | CLI, CHN | T1, T3 | — |
| ✅ `branch-history` | Time-travel over `checkpoint-store`: `branchAt`, `diff(runA, runB)`. | GRPH, MGD, RES | T1, T4 | `checkpoint-store`, `event-log` |
| 🟡 `artifact-store` | Persist files, screenshots, patches, generated docs, reports. | Most | T1, T3 | `infra-utils`, `secrets-manager` |
| 🟡 `session-router` / `session-binding` | Resolve session keys; bind session ↔ channel ↔ thread ↔ user. | CHN, CLI | T1, T3, T9 | `session-store`, `channel-binding` |
| 🟡 `replay-store` | Recorded runs for replay tests + regression. | EVAL, all CI | T1, T4 | `event-log`, `trace-recorder` |
| ✅ `idempotency-keys` | `idempotencyKey(jobId, attempt)` SHA-256-trunc + in-memory TTL store. | BATCH, CHN | T1, T9 | `infra-utils` |

#### R8 — Permission, Policy, Safety

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `permission-engine` | Modes (default/plan/auto/bypass); 5-source RuleSet; `bypass` only via flag. | CLI, CHN, CRW, MGD, BATCH | T1, T3, T8 | `tool-permission-matcher`, `error-types` |
| 🟡 `approval-classifier` | ML auto-approve for safe ops. | CLI, CHN | T1, T5, T8 | `permission-engine`, `model-adapter` |
| `denial-tracking` | Count consecutive denials; fall back to ask. | CLI, CHN | T1, T9 | `permission-engine` |
| 🟡 `guardrails` | Input/output guardrails (PII, jailbreak, secret leak, NSFW). | CHN, CRW, MGD, RES, VOICE | T1, T3, T8 | `model-adapter`, `permission-engine`, `pii-redactor` |
| ✅ `policy-engine` | Side-effect classification + audit; composes with `permission-engine`. | CLI, CHN, MGD, BATCH | T1, T3, T8 | `permission-engine`, `audit-log`, `tool-permission-matcher` |
| ✅ `secrets-manager` | Read/decrypt secrets (env / file / vault); rotation; audit on access. | All | T1, T2, T8 | `infra-utils`, `error-types` |
| ✅ `sandbox` | Containerised exec environment (docker / podman / noop). | CLI, CHN, MGD, EVAL, BATCH | T1, T3, T7, T8 | `infra-utils`, `policy-engine` |
| `safety-prompt-injector` | Inject safety/system-policy text. | All | T1, T8 | `system-prompt-builder` |
| 🟡 `hitl-engine` | Human-in-the-loop interrupt/resume; approval gates. | GRPH, MGD, CRW, RES | T1, T3, T4 | `permission-engine`, `runtime-orchestrator`, `checkpoint-store` |
| ✅ `pii-redactor` | Detect/redact PII in inputs, outputs, logs. Regex + classifier + policy allow-list. | CHN, MGD, VOICE | T1, T5, T8 | `model-adapter` |
| ✅ `prompt-injection-detector` | 3-layer classifier (regex + structural + optional LLM). Wired into post-tool path. | All | T1, T8 | `tool-result-store`, `model-adapter` |
| ✅ `boundary-classifier` | Pillar 3 chokepoint — wraps `prompt-injection-detector` with TrustOrigin + content-hash cache. | All | T1, T8 | `prompt-injection-detector` |
| ✅ `sandbox-image-{python,javascript,shell,go,rust,java,ruby,r,dotnet,php}` | Polyglot sandbox image registry. | All sandbox-using | T1, T2, T7, T8 | `sandbox` |
| ✅ `audit-encryption` | Envelope encryption (AES-256-GCM) for audit-log payloads; per-tenant DEK. | MGD | T1, T2, T8 | `secrets-manager` |
| ✅ `data-retention-engine` | GDPR-shaped retention; purge / export / sweep with cross-tenant guard. | MGD | T1, T8, T9 | `audit-log`, `secrets-manager` |
| ✅ `compliance-controls` | SOC 2 / ISO 27001 / HIPAA evidence collection; `crewhaus compliance evidence` CLI. | MGD | T1, T3 | `audit-log` |

#### R9 — Hooks, Skills, Slash Commands

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `hooks-engine` | Lifecycle hooks fired at every runtime moment; restricted env spawn. | Most | T1, T3, T8 | `infra-utils`, `error-types` |
| `hook-loader` | Discover hooks from settings.json, plugins, project files. | CLI, CHN | T1, T3 | `hooks-engine`, `config-loader` |
| ✅ `skills-registry` | Lazy-loaded SKILL.md catalog; synthetic `Skill(name)` tool. | CLI, CHN, RES | T1, T3 | `tool-builder`, `infra-utils` |
| `skills-serializer` | Render skills list into system prompt. | CLI, CHN, RES | T1, T9 | `skills-registry`, `system-prompt-builder` |
| ✅ `slash-commands` | Markdown-templated user-input shortcuts; `pre-slash` hook integration. | CLI, CHN | T1, T9 | `infra-utils` |
| 🟡 `output-styles` | Output-style / persona overlays. | CLI, CHN, VOICE | T1, T5 | `system-prompt-builder`, `hooks-engine` |
| 🟡 `autoreply-policy` | Should agent respond? (mention-gating, batch debounce, heartbeat suppression). | CHN | T1, T9 | `channel-adapter-base`, `scheduler-cron` |

#### R10 — Multi-Agent / Coordination

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| 🟡 `subagent-runtime` | Broader runtime contract that absorbs the §13 isolation + spawner primitives. | CLI, CRW, MGD, RES | T1, T3, T6 | `agent-context-isolation`, `sub-agent-spawner` |
| ✅ `agent-context-isolation` | `createIsolatedContext` — fresh RunContext, child EventLog, isolated state, abort tree. | CLI, CHN, CRW, RES | T1 | `run-context`, `state-store`, `event-log`, `abort-controller` |
| ✅ `sub-agent-spawner` | `spawnSubAgent` — wires isolated context + child runChatLoop + transcript replay. | CLI, CHN, CRW, RES | T1, T3, T7 | `agent-context-isolation`, `runtime-orchestrator` |
| ✅ `sub-agent-permission-inheritance` | Modes inherit / scoped / replace; bypass non-propagation enforced. | CLI, CHN, CRW, RES | T8, T9 | `permission-engine`, `tool-permission-matcher` |
| 🟡 `coordinator` | Centralized coordinator (manager → workers). | CRW, CLI, RES | T1, T3, T6 | `sub-agent-spawner`, `runtime-orchestrator`, `task-engine` |
| 🟡 `swarm-runtime` | Decentralized peer-to-peer team. | CRW, CLI | T1, T3 | `sub-agent-spawner`, `abort-controller`, `node-host` |
| 🟡 `handoff-engine` | Structured agent-to-agent handoff w/ filters (richer than v0). | CRW, MGD, GRPH | T1, T3, T6 | `agent-handoff`, `crew-orchestrator` |
| ✅ `agent-handoff` | `createHandoffTool` builds in-band Handoff tool; refusal-loop guard. | CRW | T1, T8 | `agent-context-isolation`, `tool-builder` |
| ✅ `crew-orchestrator` | Role-based dispatcher; one shared RunContext across roles. | CRW | T1, T3, T8, T9 | `agent-handoff`, `a2a-protocol`, `runtime-orchestrator` |
| 🟡 `role-system` | Role definitions (CrewAI-style backstory/goal/agent-type). | CRW | T1, T6 | `ir-model`, `system-prompt-builder`, `crew-orchestrator` |
| 🟡 `task-engine` | Task lifecycle (create/run/track/result), dependency wiring. | CRW, CLI, MGD, BATCH, RES | T1, T3, T7 | `tool-task`, `state-store`, `durable-execution` |
| 🟡 `pairing-engine` | Pair/teammate model (operator + agent, multi-host). | CLI, CHN | T1, T3 | `state-store`, `channel-adapter-base`, `node-host` |
| ✅ `federation-protocol` / `federation-discovery` / `federation-router` | Cross-deployment A2A — mTLS + cert-pinning + DNS SRV / `.well-known` discovery. | MGD, CHN | T2, T7, T8 | `secrets-manager`, `audit-log`, `a2a-protocol` |

#### R11 — Workflow / Graph / Pipeline Engines

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `graph-engine` | Node/edge runtime with HITL pause + checkpoint resume + parallel groups. | GRPH, MGD | T1, T3, T4 | `state-store`, `run-context`, `recovery-engine`, `abort-controller`, `checkpoint-store` |
| 🔴 `workflow-engine` | Async-event workflow runtime; pub/sub event bus, step decorators. | CRW, MGD, RES, BATCH | T1, T3, T7 | `state-store`, `run-context`, `event-bus`, `sub-agent-spawner` |
| ✅ `pipeline-engine` | Component DAG runtime; Kahn-topological scheduler. | RAG | T1, T3 | `ir-model`, `model-adapter`, `run-context` |
| ✅ `durable-execution` | Idempotency-keyed exactly-once node execution under crash. | GRPH, MGD, BATCH, RES | T1, T4, T7 | `checkpoint-store`, `run-context`, `idempotency-keys` |
| 🟡 `workflow-checkpointer` / `event-bus` / `checkpoint-encoder` | Workflow-specific persistence + topic taxonomy + versioned encoding. | GRPH, MGD, RES | T1, T3, T4 | per-row |

#### R12 — RAG / Retrieval / Knowledge

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| 🟡 `document-store` / `retriever` / `ranker` / `reader-extractor` / `query-router` / `generator` | Haystack-style component pipeline parts. | RAG, RES (subset) | T1, T2, T5, T7 | per-row |
| `document-loader` / ✅ `chunker` | Read PDF/DOCX/HTML/Notion/Drive → Documents; split into chunks. | RAG, RES | T1, T5, T9 | `infra-utils` |
| 🟡 `knowledge-graph` | Optional KG layer over docs. | RAG, CRW, RES | T1, T5 | `document-store`, `model-adapter` |
| 🟡 `ingestion-pipeline` | Crawl → load → chunk → embed → store. | RAG, RES | T1, T3, T7 | `document-loader`, `chunker`, `embedder`, `document-store` |
| ✅ `citation-tracker` | Per-research-run JSONL with content-cache; idempotent record/dedup. | RAG, RES | T1, T4 | `tool-result-store`, `model-adapter` |

#### R13 — Channels & Messaging

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| `channel-registry` | Register channel adapters by id; normalize ids. | CHN | T1 | `ir-model`, `channel-adapter-base` |
| ✅ `channel-adapter-base` | `ChannelAdapter` interface; tagged-union `parseInbound`; adapter-supplied idempotencyKey. | CHN | T1, T2 | — |
| ✅ `channel-slack` / `channel-adapter-telegram` / `channel-adapter-discord` / `channel-adapter-whatsapp` / `channel-adapter-imessage` | Concrete adapters with constant-time signature verify. | CHN | T1, T2, T3, T8 | `channel-adapter-base`, `secrets-manager` |
| 🟡 `channel-{signal,bluebubbles,email,sms,web}` | Additional adapters (v1.3 §45 long-tail). | CHN | T1, T2, T3 | `channel-adapter-base`, `secrets-manager` |
| `channel-transport` | Stall watchdog, retries, batching. | CHN | T1, T7 | `infra-utils`, `retry-policy` |
| `channel-binding` / 🟡 `channel-router` / `channel-features` / `directory-adapters` / 🟡 `media-payload` / 🟡 `pairing-flow` / `message-actions` | Channel-cross-cutting features and routing. | CHN | T1+ | per-row |

#### R14 — Scheduling & Background

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| 🟡 `scheduler-cron` | Cron service: at/every/cron schedules, persistence. | CHN, CLI, RES | T1, T7 | `state-store`, `event-log` |
| 🟡 `heartbeat-engine` / 🟡 `isolated-agent-runner` / `session-reaper` / `background-housekeeping` / 🟡 `task-scheduler` | Always-on assistant supporting modules. | CHN, MGD, CLI, RES | T1+ | per-row |
| ✅ `queue-protocol` / ✅ `queue-consumer` | Abstract queue + long-running pull loop with sidecar visibility extension. | BATCH | T1, T2, T3, T7 | `secrets-manager`, `retry-policy`, `infra-utils` |
| ✅ Queue backends | `createSqsAdapter`, `createRedisStreamsAdapter`, `createPostgresAdapter`. | BATCH | T2, T8 | `queue-protocol` |
| `rate-limiter` | Token-bucket / leaky-bucket; multi-dimensional keys; partial-failure refunds. | All except EVAL | T1, T7, T8 | `infra-utils` |
| `retry-policy` / 🟡 `dead-letter-queue` / `batch-progress-tracker` | Backoff strategies; quarantine failed items; progress streaming. | BATCH, CHN | T1, T3, T7 | per-row |

#### R15 — Telemetry, Tracing, Eval

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| 🟡 `telemetry-engine` | Structured logging, metrics, OpenTelemetry spans coordinator. | All | T1, T7 | `trace-event-bus`, `otel-exporter`, `metrics-collector`, `logging` |
| ✅ `trace-event-bus` | In-process pub/sub bus; 15-kind discriminated union; W3C traceparent propagation. | All | T1, T7, T9 | `infra-utils` |
| ✅ `otel-exporter` | OTLP/JSON exporter using GenAI semconv (`gen_ai.system`, `gen_ai.request.model`, …). | All | T1, T2 | `trace-event-bus`, `infra-utils` |
| 🟡 `trace-recorder` | Persist spans/traces locally (replay, grading). | All | T1, T7 | `trace-event-bus`, `event-log` |
| ✅ `metrics-collector` | Counters + histograms with three sinks (Prometheus textfile / stdout JSON / HTTP). | All | T1, T3, T7 | `trace-event-bus`, `infra-utils` |
| ✅ `structured-event-printer` | Pretty / JSON Lines printer subscribed to trace bus. | All | T1 | `trace-event-bus` |
| 🟡 `replay-engine` | Deterministic replay of recorded runs (fixtures + traces). | EVAL, all CI | T1, T4 | `trace-recorder`, `model-adapter`, `event-log` |
| ✅ `eval-dataset` | JSONL / CSV / YAML / HTTP dataset loaders; lazy AsyncIterable. | EVAL | T1 | `errors`, `yaml`, `zod` |
| ✅ `eval-grader` | exact_match / contains / regex / json_path / schema / tool_call_sequence + composers. | EVAL | T1, T9 | `eval-dataset` |
| ✅ `eval-judge` | LLM-as-judge with sentinel-token prompt-injection defense. | EVAL | T1, T8 | `eval-grader`, `runtime-core` |
| ✅ `eval-runner` | Per-sample fresh RunContext; concurrency; SIGINT-flushes results.json. | EVAL | T3, T7 | `eval-dataset`, `eval-grader`, `eval-judge`, `runtime-core` |
| ✅ `eval-report` | HTML + JSON renderer; aggregates; diff mode. | EVAL | T1 | `eval-runner` (types only) |
| ✅ `dataset-registry` | Versioned + split-aware dataset storage; split-leak guard. | EVAL | T1, T8, T9 | `eval-dataset`, `infra-utils` |
| ✅ `grader-registry` | Global registry of named graders + plugin discovery. | EVAL | T1, T8 | `eval-grader`, `eval-judge`, `model-adapter` |
| 🟡 `benchmark-runner` / 🟡 `trajectory-grading` / 🟡 `canary-router` / 🟡 `cost-attribution` | Eval / observability orchestration. | EVAL, MGD, RES | T1+ | per-row |
| ✅ `regression-runner` | Diff-based pass/fail flip detection between runs; canary gate source-of-truth. | EVAL, MGD | T1, T9 | `eval-runner`, `eval-report` |
| ✅ `prompt-optimizer` | DSPy-style search over candidate mutations; deterministic seeded. | EVAL, CLI (advanced) | T3, T9 | `eval-runner`, `model-adapter`, `system-prompt-builder` |
| ✅ Vendor exporters | `exporter-datadog` / `-honeycomb` / `-splunk` / `-newrelic` with credential-leak guards. | All | T1, T2, T8 | `otel-exporter` |
| ✅ Production graders | `grader-nlg-metrics` / `-semantic-similarity` / `-safety-classifiers` / `-multimodal`. | EVAL | T1, T8, T9 | `grader-registry`, `embedder` |

#### R16 — UI / TUI / Voice / Media

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| 🟡 `tui-runtime` / `tui-keybindings` / 🟡 `repl-launcher` / 🟡 `web-ui` | Terminal + web client front-ends. | CLI, CHN, MGD | T1, T3 | per-row |
| 🔴 `gateway-server` / 🟡 `gateway-protocol` | HTTP+WebSocket+JSON-RPC server; versioned wire protocol. | CHN, MGD, BATCH | T1, T2, T7, T8 | `secrets-manager`, `runtime-orchestrator`, `permission-engine` |
| ✅ `voice-runtime` | Provider-agnostic realtime audio adapter (OpenAI / Vapi). PCM 16-bit mono 24kHz. | VOICE | T1, T2, T7 | `model-adapter`, `audio-stream` |
| ✅ `vad-engine` | Energy + ZCR heuristic VAD over PCM 16-bit frames. | VOICE | T1, T5, T7 | `audio-stream` |
| ✅ `barge-in-controller` | Hysteresis-gated coordinator (VAD + RealtimeAdapter). Default 4 frames in 200ms. | VOICE | T1, T3 | `voice-runtime`, `vad-engine` |
| 🔴 `audio-stream` | PCM/Opus I/O streaming; buffering. | VOICE | T1, T2, T7 | `infra-utils` |
| ✅ `call-session` | Call lifecycle state machine; pluggable TelephonyAdapter. | VOICE | T1, T3 | `voice-runtime`, `channel-adapter-base` |
| ✅ Telephony adapters | `createTwilioTelephonyAdapter` / `createLiveKitSipAdapter` (§30). | VOICE | T2 | `call-session` |
| 🟡 `dtmf-handler` / 🟡 `prosody-controller` / 🟡 `media-service` / 🟡 `canvas-host` / 🟡 `notifications-service` | Voice + media + canvas surface. | VOICE, CHN | T1+ | per-row |
| ✅ `secrets-manager` | (See R8 — R16 consumers wire it for telephony/canvas secrets.) | All | T1, T2, T8 | — |

#### R17 — Infrastructure & Cross-Cutting

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| `config-loader` | YAML/JSON/TS config; schema; env-var expansion; overlays. | All | T1, T9 | `infra-utils`, `error-types` |
| 🟡 `settings-sync` | Multi-source settings merge (project / user / enterprise / policy). | CLI, CHN, MGD | T1, T3 | `config-loader` |
| `i18n` | Internationalization, locale, translations. | CHN, VOICE | T1, T9 | `infra-utils` |
| ✅ `logging` | Structured logger interface. | All | T1 | — |
| ✅ `error-types` | Typed error hierarchy + classification. | All | T1 | — |
| ✅ `infra-utils` | Common: paths, env, fs, json, retry, time, ids. | All | T1 | — |
| `feature-flags` | Build-time + runtime flags. | All | T1 | `config-loader` |
| 🟡 `runtime-migrations` | Versioned runtime data migrations. | All | T1, T4 | `migration-engine` |
| 🟡 `daemon-process` / 🟡 `node-host` / 🟡 `proxy-capture` / 🟡 `bootstrap-runtime` / `startup-profiler` / 🟡 `update-channel` | Long-running process supervision, cross-host RPC, capture/replay, first-run trust, profiling, auto-update. | varies | T1+ | per-row |
| ✅ `tenancy` | Per-tenant isolation (sessionRoot / evalRoot / toolResultRoot / policyOverrides / budget). | MGD | T1, T3, T8 | `secrets-manager`, `audit-log`, `gateway-server` |
| ✅ `audit-log` | Append-only hash-chained audit trail; `crewhaus audit verify`. | MGD | T1, T8 | `event-log`, `secrets-manager` |

#### R18 — Specialized / Advanced

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `computer-use-driver` | Mouse/keyboard/screenshot driver; Chromium backend via Playwright. | BROW, CLI | T1, T2, T3 | `infra-utils` |
| 🔴 `browser-extension-bridge` | Bridge to browser extension MCP. | BROW, CLI | T1, T2, T3 | `mcp-host`, `gateway-server` |
| 🟡 `lsp-host` | LSP client for code-tools. | CLI | T1, T2, T3 | `infra-utils`, `scheduler` |
| 🟡 `sandbox-fs-overlay` | Copy-on-write workspace for safe edits + rollback. | CLI, EVAL | T1, T3 | `tool-fs`, `infra-utils` |
| 🟡 `structured-output-tools` / 🟡 `autoplan-engine` / 🟡 `auto-classifier` / `fingerprint` / `activity-manager` / `speculation-cache` / 🟡 `commitments-engine` | Advanced patterns: structured output, plan-then-act, classifiers, fingerprinting, idle tracking, commitment tracking. | varies | T1+ | per-row |

#### R19 — Research-Agent Specific

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `planner` | Decompose research goal into ordered sub-questions via LLM. | RES | T1, T5 | `model-adapter` |
| ✅ `crawler` | Citation-tracker-backed fetcher (https + file); origin allow-list; redirect cap. | RES, RAG | T1, T3, T7 | `citation-tracker`, `tool-fetch`, `idempotency-keys` |
| 🔴 `branch-explorer` | Explore multiple research branches in parallel; rank/prune. | RES | T1, T3, T6 | `sub-agent-spawner`, `run-context`, `branch-history` |
| 🟡 `evidence-store` | Accumulate evidence with metadata (source, timestamp, claim, support level). | RES, RAG | T1, T5 | `document-store`, `citation-tracker` |
| ✅ `report-writer` | Markdown + JSON report assembly; URL-first-appearance citation numbering. | RES | T1, T5 | `model-adapter`, `citation-tracker` |
| 🟡 `progress-streamer` / 🟡 `source-quality-scorer` | Long-run progress reporting; source credibility scoring. | RES | T1+ | per-row |
| ✅ `research-checkpointer` | Stage-level checkpoints for hours-long runs. (Realised via `checkpoint-store` + JSONL state.) | RES | T1, T4, T7 | `checkpoint-store`, `durable-execution` |

#### R20 — Batch-Worker Specific

| Module | Responsibility | Targets | Tests | Depends on |
|---|---|---|---|---|
| ✅ `batch-runner` | Drive worker loop: pull → process → ack → repeat. (Realised via `queue-consumer` + `runChatLoop`.) | BATCH | T1, T3, T7 | `queue-consumer`, `retry-policy`, `runtime-orchestrator` |
| 🟡 `batch-job-spec` | Per-item job spec (input schema, output schema, timeout, retries). | BATCH | T1, T2 | `ir-model` |
| 🟡 `fan-out-fan-in` | Split a large job into many tasks; aggregate results. | BATCH, CRW | T1, T3, T7 | `batch-runner`, `sub-agent-spawner` |
| 🟡 `output-sink` | Write results to destination (DB / S3 / file / webhook). | BATCH | T1, T2, T3 | `infra-utils`, `secrets-manager` |
| 🟡 `batch-eval-loop` | Tie batch worker to eval-service for online metric tracking. | BATCH, EVAL | T1, T5 | `batch-runner`, `eval-service`, `trace-event-bus` |

---

## Module groups

For ergonomic spec authoring, the catalog exposes 18 grouped bundles. Each group is a stable selector that pulls in its constituent modules with sensible defaults.

| Group | Includes | When to enable |
|---|---|---|
| **Tool Layer (full)** | tool-catalog · tool-builder · tool-orchestrator · tool-executor · streaming-tool-executor · tool-result-store · tool-loop-detection · tool-search · tool-display · tool-permission-matcher · tool-validate | Any agent that calls tools |
| **MCP Bundle** | mcp-host · tool-mcp · mcp-server-host (optional) | Agents needing external/portable tools |
| **Compaction Stack** | compaction-snip · microcompact · context-collapse · autocompact · reactive · tool-result-budget · session-memory | Long-running chat/agent harnesses |
| **Permission Stack** | permission-engine · approval-classifier · denial-tracking · policy-engine · safety-prompt-injector · guardrails · prompt-injection-detector · boundary-classifier · pii-redactor | Production-grade safety |
| **Observability Stack** | telemetry-engine · otel-exporter · trace-recorder · metrics-collector · replay-engine · cost-tracker · cost-attribution · audit-log | Any production deployment |
| **Eval Stack** | eval-runner · eval-grader · eval-judge · eval-report · dataset-registry · grader-registry · regression-runner · prompt-optimizer · replay-engine | EVAL target or CI for any target |
| **Channel Stack** | channel-registry · channel-adapter-base · channel-{slack,telegram,discord,whatsapp,imessage,…} · channel-transport · channel-binding · channel-router · channel-features · directory-adapters · media-payload · pairing-flow · message-actions | Channel-based assistants |
| **Scheduling Stack** | scheduler-cron · heartbeat-engine · isolated-agent-runner · session-reaper · task-scheduler · background-housekeeping | Always-on assistants |
| **Multi-Agent Stack** | subagent-runtime · coordinator · swarm-runtime · handoff-engine · role-system · task-engine · pairing-engine · agent-handoff · a2a-protocol · crew-orchestrator | Crews / supervised agents |
| **State & Persistence Stack** | session-store · event-log · checkpoint-store · state-store · app-state-store · branch-history · artifact-store · session-router · session-binding · replay-store | All harnesses (subset minimum) |
| **RAG Stack** | document-store · embedder · retriever · ranker · reader-extractor · query-router · generator · document-loader · chunker · knowledge-graph · ingestion-pipeline · citation-tracker · vector-store · tool-retrieve | Retrieval-heavy harnesses |
| **CLI Front-end Stack** | tui-runtime · tui-keybindings · repl-launcher · spec-cli · slash-commands · output-styles · skills-{registry,serializer} · hooks-engine | CLI coding agent |
| **Channel Front-end Stack** | gateway-server · gateway-protocol · channel stack · daemon-process · node-host · web-ui · canvas-host · voice-runtime (optional) · notifications-service · pairing-flow | Channel assistant |
| **Memory Stack** | memory-service · memory-extraction · personalization-store · bootstrap-files · system-prompt-builder · vector-store | Stateful long-horizon agents |
| **Voice Stack** | voice-runtime · vad-engine · barge-in-controller · audio-stream · call-session · telephony-adapter · dtmf-handler · prosody-controller · tool-tts-stt | Voice/telephony harnesses |
| **Computer-Use Stack** | computer-use-driver · browser-extension-bridge · tool-screen-capture · tool-mouse-keyboard · tool-vision-grounding · tool-dom-inspector · tool-browser | Browser/desktop driving harnesses |
| **Research Stack** | planner · crawler · branch-explorer · evidence-store · report-writer · progress-streamer · research-checkpointer · source-quality-scorer · citation-tracker · autoplan-engine | Long-horizon research agents |
| **Batch Stack** | batch-runner · batch-job-spec · queue-consumer · queue-protocol · idempotency-keys · rate-limiter · retry-policy · dead-letter-queue · batch-progress-tracker · fan-out-fan-in · output-sink · batch-eval-loop | Queue/batch workers |

---

## Target shape → layer requirements

The compiler reads this matrix to pick the base set per target. Use it when you're scoping which layers your work touches.

| Shape | Always-on layers | Frequently-on | Rarely needed |
|---|---|---|---|
| **CLI** | Runtime Core, Tool Layer, Tool Impls (fs/bash/web), Permission, Compaction, State, Telemetry, MCP, Hooks, Skills, Slash, TUI, Bootstrap | Subagent, Coordinator, Swarm, LSP, Worktree, Plan-mode, Replay, Voice (light) | Channels, RAG, Eval (CI only), Pipeline engine |
| **CHN** | Runtime Core, Tool Layer (light), Permission, Compaction, State, Telemetry, MCP, Hooks, Channels, Scheduling, Gateway, Memory, Auto-reply | Subagent, Voice, Media, Skills, Slash, Browser, Web, ACP | RAG (unless KB), Eval, Pipeline, LSP |
| **CRW** | Runtime Core, Tool Layer, Multi-Agent (roles / handoff / coordinator / tasks), Workflow Engine, State, Telemetry, Permission, Hooks, Memory | Channels (out), MCP, A2A, Subagent, Knowledge | TUI, Voice, Pairing, Cron, Media |
| **RAG** | Pipeline Engine, RAG Stack, Telemetry, Eval (light), Model Layer, State (light) | Tool Layer (limited), MCP, Workflow Engine, Memory | Channels, Permission (full), TUI, Voice, Cron, Multi-agent |
| **EVAL** | Eval Stack, Dataset Registry, Grader Registry, Benchmark Runner, Replay, Telemetry, Model Layer | Sandbox, Tool Layer, Pipeline Engine, Trajectory Grading, Prompt Optimizer | Channels, TUI, Cron, Multi-agent (unless evaluating crews), Hooks |
| **MGD** | Runtime Core, Tool Layer, Permission, Policy, Telemetry, Checkpoint, Audit, Tenancy, MCP, A2A, Gateway, OTel, Sandbox | Workflow Engine, Graph Engine, HITL, Eval, Multi-agent, Memory, Canary, Durable Execution | TUI, Channels (often), Voice, Cron (often) |
| **GRPH** | Graph Engine, Checkpoint Store, Branch History, Durable Execution, Runtime Core, State, Telemetry, HITL, Recovery | Tool Layer, Permission, Memory, Replay, Eval, Subagent | TUI, Channels, Voice, Cron, RAG (unless knowledge node), Pipeline engine |
| **RES** | Research Stack, Runtime Core, Tool Layer, Web tools, Compaction, Memory, Citation, Checkpoint, Telemetry | Subagent, Browser, Branch-Explorer, Skill, Eval (online), Workflow Engine | Channels, TUI, Voice, Pipeline engine |
| **VOICE** | Voice Stack, Runtime Core, Telemetry, Channels (telephony), Permission (light), State (call-shaped) | Memory, Skills, Tool Layer (limited) | TUI, RAG, Eval, Browser/Computer-use, Multi-agent |
| **BROW** | Computer-Use Stack, Tool Layer (limited), Runtime Core, Telemetry, Sandbox | MCP, Subagent, Memory, Eval (replay) | Channels, RAG, Voice, TUI, Cron |
| **BATCH** | Batch Stack, Runtime Core, Telemetry, Permission, Tool Layer (specific to job), State (job-shaped) | Sandbox, MCP, Eval (online), Memory, Multi-agent | TUI, Channels (unless notification), Voice, Browser |

---

## Cross-cutting IR-level switches

These spec-level options shape multiple modules. The compiler reads them to select / configure runtime modules.

1. **Durability mode** (`exit | async | sync | none`) — drives `checkpoint-store`, `durability-mode`, `event-log` flush policy.
2. **Streaming mode** (`pull | push | none`) — drives `stream-runtime`, `gateway-protocol`, `tui-runtime`.
3. **Permission mode** (`default | plan | auto | bypass`) — drives `permission-engine`, `approval-classifier`, `hitl-engine`.
4. **Compaction policy** (`summary-plus-artifacts | snip-only | tool-result-only | full-stack`) — drives compaction-stack composition.
5. **Runtime topology** (`graph | workflow | pipeline | conversation | managed | batch | research`) — selects engine module + IR target.
6. **Multi-agent topology** (`single | central | decentralized | none`) — coordinator vs swarm.
7. **Deployment profile** (`local | self-hosted | managed | hybrid`) — drives `deployment-controller`, `secrets-manager`, `tenancy`.
8. **Channel set** (`none | one | multi`) — drives channel-stack inclusion.
9. **Eval class** (`offline | online | trace-graded | none`) — drives eval-stack composition.
10. **Tool profile** (`minimal | coding | messaging | rag | research | batch | full`) — drives `tool-catalog` filtering.
11. **Voice mode** (`none | tts-only | full-realtime | telephony`) — drives voice-stack inclusion.
12. **Vision mode** (`none | multimodal-input | screen-driver`) — drives computer-use-stack and `media-service`.
13. **Compute envelope** (`local-process | container | sandbox-vm | edge-device`) — drives `sandbox`, `node-host`, `bundle-packager`.

---

## Anti-patterns the factory prevents by design

Drawn from the architecture studies. The codegen / IR pipeline refuses to produce harnesses that violate these.

1. **God-function system prompt.** `system-prompt-builder` must be section-composable with per-section token budgets. (Anti-pattern: OpenClaw's 720-line `system-prompt.ts`.)
2. **Tool description double-counting.** Pick one channel — schemas *or* prose, not both.
3. **Channel-specific guidance leaking into non-channel sessions.** Sections must be gated by active modules.
4. **Backward-compat proxy bloat.** `migration-engine` produces clean rewrites, not runtime adapters.
5. **Monolithic agent directories.** Codegen splits outputs into the layer groups defined here.
6. **No token-budget awareness in prompt assembly.** `prompt-cache-manager` and `system-prompt-builder` enforce budgets.
7. **Heartbeat sending full prompt every tick.** `heartbeat-engine` defaults to lightweight bootstrap.
8. **Random temp-file paths breaking prompt cache.** Use content-hash paths.
9. **Ad-hoc subagent context filtering.** `sub-agent-spawner` exposes a documented context-filter API.
10. **Eval as a dashboard afterthought.** `eval-runner` is first-class and gates deployment via `regression-runner` + `canary-controller`.

---

## Verification

End-to-end tests for the catalog itself (independent of any single module):

1. **Catalog completeness check** — for each of the 12 target shapes, the compiler picks a non-empty, type-checked module set covering all required layers from the target-shape matrix above.
2. **Shape coverage matrix** — automated test confirms every required layer × shape cell has at least one module that satisfies it.
3. **Reference reproduction** — minimal harnesses that mimic Claude Code (CLI), OpenClaw (CHN), Haystack RAG (RAG) emit module lists that overlap ≥ 80% with the originals' layer coverage.
4. **Cross-cutting switch matrix** — for each IR-level switch above, at least one IR pass adjusts module selection accordingly.
5. **Anti-pattern lint** — codegen lint fails when an output violates an anti-pattern constraint (e.g. `system-prompt-builder` produces a single string > N tokens; sub-agent invocation lacks a context-filter spec).
6. **Per-module test plan present** — every module entry has at least one applicable test layer from T1–T9.
7. **Example-corpus matrix CI** — `.github/workflows/example-corpus.yml` compiles every `examples/*/crewhaus.yaml` and runs `bun build --no-bundle` against the entry as a syntax-and-imports check.
8. **`crewhaus doctor --philosophy-alignment`** — audits the three pillars against the current tree and exits 1 on drift.

---

## Where to read next

- **One-page brief per module** — [module-briefs/](module-briefs/README.md). The briefs continue the catalog by turning rows into per-module purpose / boundary / inputs-outputs / first-slice / validation plan.
- **Implementation status & v1.3 backlog** — [MODULE-CATALOG-STATUS.md](MODULE-CATALOG-STATUS.md).
- **Section-by-section history with PR refs** — [build-roadmap.md](build-roadmap.md).
- **Task-oriented walkthroughs** — [recipes/](recipes/INDEX.md). Start with [01-cli-coding-agent](recipes/01-cli-coding-agent.md), then jump to the recipe most relevant to your reading path.
- **First-time setup** — [GETTING-STARTED.md](GETTING-STARTED.md).

---

## Critical files for implementation reference

- [docs/AI-Harness-Systems.md](AI-Harness-Systems.md) — IR schema, reference architecture, test layers, deployment profiles, OTel dimensions, cross-cutting tradeoffs.
- [docs/COMPILER-ARCHITECTURE.md](COMPILER-ARCHITECTURE.md) — the compiler walked through with file paths.
- [docs/architecture studies/openclaw-architecture.md](architecture%20studies/openclaw-architecture.md) — channel, cron, skills, context-engine, plugin patterns; tool catalog + profiles; system-prompt anti-patterns.
- [docs/architecture studies/cc-architecture.md](architecture%20studies/cc-architecture.md) — Tool interface + buildTool; query loop; multi-layer compaction; permission system; streaming; subagents.
- [reference-repos/claude-code/src/Tool.ts](../reference-repos/claude-code/src/Tool.ts) — Tool interface contract.
- [reference-repos/claude-code/src/query.ts](../reference-repos/claude-code/src/query.ts) — async-generator agent loop reference.
- [reference-repos/claude-code/src/services/compact/](../reference-repos/claude-code/src/services/compact/) — multi-layer compaction reference.
- [reference-repos/claude-code/src/utils/permissions/](../reference-repos/claude-code/src/utils/permissions/) — layered permission system.
- [reference-repos/openclaw/src/context-engine/](../reference-repos/openclaw/src/context-engine/) — pluggable context-engine interface.
- [reference-repos/openclaw/src/cron/](../reference-repos/openclaw/src/cron/) — cron + heartbeat + isolated-agent.
- [reference-repos/openclaw/src/channels/plugins/](../reference-repos/openclaw/src/channels/plugins/) — channel adapter pattern.
- [reference-repos/agent-framework/python/packages/core/agent_framework/_workflows/_workflow_builder.py](../reference-repos/agent-framework/python/packages/core/agent_framework/_workflows/_workflow_builder.py) — declarative workflow IR + builder.
- [reference-repos/langgraph/libs/langgraph/langgraph/pregel/](../reference-repos/langgraph/libs/langgraph/langgraph/pregel/) — Pregel-style stateful graph runtime.
- [reference-repos/haystack/haystack/core/](../reference-repos/haystack/haystack/core/) — pipeline + component decorator pattern.
- [reference-repos/dspy/dspy/teleprompt/](../reference-repos/dspy/dspy/teleprompt/) — prompt program optimization.
- [reference-repos/lm-evaluation-harness/lm_eval/evaluator.py](../reference-repos/lm-evaluation-harness/lm_eval/evaluator.py) — benchmark runner.
- [reference-repos/ragas/src/ragas/evaluation.py](../reference-repos/ragas/src/ragas/evaluation.py) — RAG-specific evaluation.
- [reference-repos/openai-agents-python/src/agents/](../reference-repos/openai-agents-python/src/agents/) — handoffs, guardrails, sessions, voice, realtime.
