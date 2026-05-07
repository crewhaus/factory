# `crewhaus-factory` — Module Catalog Plan

## Context

`crewhaus-factory` is a **modular meta-harness tool** — a compiler + control plane that compiles a single high-level harness spec into multiple runtime targets (graph, event-driven workflow, pipeline DAG, managed runtime, CLI bundle, channel bot, eval task, batch worker, voice service, browser-driver, research-runner). The repo is currently in design phase: 38KB ecosystem analysis, two architecture deep-dives (Claude Code + OpenClaw), and 17 reference harnesses cloned locally.

This plan delivers the **complete module catalog** that `crewhaus-factory` must implement and compose. Each module entry pins down **what to study** (reference impls in `reference-repos/`) and **what to test** (which test layers apply, with concrete scenarios). The catalog is organized into factory-level modules (the meta-harness itself) and composable runtime modules (the building blocks of generated harnesses).

The goal of this plan is to lock in the catalog before any implementation, so individual modules can then be specced, researched, and built independently.

---

## Implementation status

Modules in the per-layer tables below are prefixed with status markers:

- ✅ — implemented and tested (has `src/` + tests + at least one consumer)
- 🚧 — in progress (open PR)
- *(unmarked)* — not started

### Implemented (✅)

| Module | Layer | Notes |
|---|---|---|
| `spec-schema` | F1 | Discriminated union over `target`: `cli` (agent + optional tools[]) and `workflow` (top-level model + steps[] with optional per-step model/tools). PR #2, expanded in PR #7 and PR #11. |
| `spec-parser` | F1 | YAML → Zod-validated spec. PR #2. |
| `spec-validator` | F1 | Bundled with parser via Zod (`.strict()`). PR #2. |
| `ir-model` | F1 | `IrV0` (cli) carries name, agent, tools; `IrWorkflowV0` carries name and steps[] with each step's `model` resolved at lower-time. Exported as `IrNode` discriminated union. PR #2, expanded in PR #7 and PR #11. |
| `compiler-core` | F2 | Pipeline: parse → lower → emit; `lower()`/`emit()` dispatch on target (`cli` → target-cli, `workflow` → target-workflow). PR #2, expanded in PR #7 and PR #11. |
| `target-cli-bundle` | F2 | Single-file `agent.ts` codegen for CLI target; emits grouped tool imports + `defaultCatalog.register()` when `ir.tools` is non-empty. PR #2, expanded in PR #7. |
| `target-workflow` | F2 | Single-file `agent.ts` codegen for workflow target; emits sequential `runChatLoop({ singleTurn: true })` calls with per-step instructions, model, tools, and the prior step's terminal text threaded forward as a synthetic user message. PR #11. |
| `codegen-templates` | F2 | Inline string templates in target-cli and target-workflow. PR #2, expanded in PR #11. |
| `spec-cli` | F4 | `compile`, `init`, `run`, `doctor` subcommands; deploy/eval/watch pending. PR #2, expanded in PR #10. |
| `runtime-orchestrator` | R1 | Streaming chat REPL with state-machine-driven inner loop, `tool_use` execution, and pre-turn compaction (snip → autocompact). Single-shot `singleTurn` + `seedMessages` mode added for workflow target. PR #2, #7, #9, #11. |
| `model-adapter` | R2 | Anthropic-only via `@anthropic-ai/sdk`. PR #2. |
| `error-types` | F-foundations | Typed `CrewhausError` hierarchy + `toJSON`. PR #3. Extended with `"tool"` code in PR #6. |
| `logging` | F-foundations | `pretty/json` formats, level filtering, `child()` bindings. PR #3. |
| `infra-utils` | F-foundations | `escapeJsonString`, `parseArgs`, `assertNever`. |
| `tool-catalog` | R3 | `ToolDefinition`/`RegisteredTool` interfaces, `ToolCatalog` registry, `defaultCatalog` singleton. PR #6. |
| `tool-builder` | R3 | `buildTool()` factory with fail-closed safety defaults. PR #6. |
| `tool-validate` | R3 | `validateToolInput()` returning typed `ValidationResult`; `ToolValidationError` with Zod issues. PR #6. |
| `tool-permission-matcher` | R3 | `compilePattern()` + `matchesPattern()`; supports `Bash(git *)`, `Read`, `Write(**/src/**)` glob syntax. PR #6. |
| `tool-executor` | R3 | `executeTool()`: validate → permission-check → invoke → normalized `ToolResult`. PR #6. |
| `tool-fs` | R4 | `Read`/`Write`/`Edit`/`Glob`/`Grep` sandboxed to `process.cwd()`; atomic writes via temp + rename; `ToolPermissionError` for traversal. PR #8. |
| `tool-bash` | R4 | `Bash` via `Bun.spawn` with default 30s timeout (max 10min); captures stdout + stderr; returns formatted exit/timeout report. PR #8. |
| `tool-todo` | R4 | `TodoWrite` over a per-process module-level list; renders a markdown checklist with status/priority. PR #8. |
| `turn-state-machine` | R1 | Pure state machine: `NeedModel`/`NeedTools`/`NeedCompaction`/`NeedRecovery`/`Done`; exhaustive transition tests over the (state, event) cartesian product. PR #9. |
| `run-context` | R1 | `RunContext` type (`runId`, `sessionId`, `turnNumber`, `abortSignal`, `logger`) + `createRunContext()` factory; logger child-bound to run/session ids. PR #9. |
| `token-budget` | R2 | `estimateTokens()` (char/4 heuristic over text, tool_use, tool_result blocks) + `TokenBudget` class with `add()` / `isApproachingLimit()` (default threshold 0.85). PR #9. |
| `compaction-snip` | R6 | Pure middle-message removal with `[Context compacted: N messages removed]` marker; tool-use/result orphan defense walks boundaries until pairs are intact. PR #9. |
| `compaction-autocompact` | R6 | Model-summarize-then-replace; returns `[user-marker, assistant-summary]` pair so the next user input appends naturally. PR #9. |
| `recovery-engine` | R1 | Pure decision function `recover(error, state) → RecoveryAction` over the Anthropic taxonomy: `prompt_too_long → compact`, `max_output_tokens → continue`, `overloaded/5xx → retry` (exp backoff 1–30 s), `invalid_request → tombstone`, with per-turn budgets. T4 fixture replay over 10 representative SDK error shapes. PR #12. |
| `permission-engine` | R8 | Modes `default`/`plan`/`auto`/`bypass` over a 5-source `RuleSet` (flag → settings → yaml → hooks → builtin). `evaluate(call, mode, rules) → "allow" \| "deny" \| "ask"`. `parsePermissionsConfig` rejects `mode: bypass` from any non-flag source (T8 security test). PR #12. |
| `abort-controller` | R1 | Parent/child abort tree with WeakRef cascade so abandoned children don't pin parents; sibling-independent. T3 spawns `sleep 30` and verifies SIGTERM cascade. Wired into runtime-core for SIGINT (first cancels turn, second exits). PR #12. |
| `tool-orchestrator` | R3 | `partitionToolCalls(calls, lookup) → { concurrent: ToolUse[][], serial: ToolUse[] }` splits calls into concurrent (`concurrencySafe && readOnly && !destructive`) batches and a serial list. T9 property test fuzzes 100 random tool/flag mixes. PR #13. |
| `tool-loop-detection` | R3 | `detectLoop(history, windowSize=10, threshold=3)` over a sliding window of canonical-JSON `(toolName, input)` signatures; runtime injects a one-shot warning user message per signature. PR #13. |
| `tool-result-store` | R3 | `storeAndPreview(result, opts)` persists outputs >10 KB to `.crewhaus/tool-results/<runId>/<toolUseId>.txt` (write-exclusive flag for idempotent retry); preview = first 100 lines + `[truncated, full output at <fullPath>]`. Path-traversal guards on `runId`/`toolUseId`. PR #13. |
| `streaming-tool-executor` | R3 | `executeStreaming(stream, opts)` dispatches `tool_use` blocks during the SDK stream via the `contentBlock` event with a concurrent-safe `canExecute()` gate; sibling-abort on destructive failure. Accepts a `runTool` callback so the runtime can plumb permission + abort + result-store through. T7 load test with 50 partial blocks. PR #13. |
| `mcp-host` | R5 | `McpClient` / `McpHost` shell over `@modelcontextprotocol/sdk` (stdio + SSE transports); exp-backoff reconnect (1 s → 30 s cap, ±10% jitter, no max attempts) with proactive `onclose` detection and a queue-capped (16) `connectedDeferred` for in-flight calls. `addServer()` is synchronous; `connect()` runs inside `registerMcpServer()`. Reduces `tools/call` content blocks (text/image/audio/resource) to a single string. Section 9. |
| `tool-mcp` | R4 | `registerMcpServer(host, serverName, catalog, opts?)` lists remote tools and registers each via `@crewhaus/tool-builder` under `<serverName>__<toolName>`. `inputSchema: z.unknown()` paired with `jsonSchema` carrying the server's JSON Schema verbatim (runtime-core forwards it to the model). Per-tool flag overrides via `opts.perTool`. Remote tool names validated against `[a-zA-Z0-9_-]+`. Section 9. |
| `state-store` | R7 | Tiny zustand-style `createStore<T>(initial)` returning `{ get, set, subscribe, select }`. `set` shallow-merges (functional or partial form); root listeners fire on every actual change, `select(selector)` returns a derived view whose listeners fire only when `Object.is(selector(next), selector(prev)) === false`. Listener exceptions isolated via `console.error`. Per-`runChatLoop` instance; consumed by hooks/skills/tools in Section 11+. T9 property test fuzzes 100 random `set` sequences. Section 10. |
| `session-store` | R7 | File-backed JSON metadata at `.crewhaus/sessions/<id>.json`. Session shape `{ id, createdAt, updatedAt, name, target, model, lastTurnIndex }` with id format `sess_<16 hex>`. Atomic writes via `<id>.json.tmp` + `rename`. `list()` evicts (`unlink`s `.json` AND sibling `.jsonl`) any file whose **mtime** is older than `ttlDays * 86_400_000` ms (default 30 days) — mtime-keyed so `touch -t YYYYMMDD0000 <id>.json` forces expiry from the shell. Path-traversal guard rejects malformed ids before any I/O. T3 integration test backdates mtime + asserts eviction over a `mkdtempSync` root. Section 10. |
| `event-log` | R7 | Append-only JSONL transcript at `.crewhaus/sessions/<sessionId>.jsonl`. `openEventLog(sessionId, opts)` returns `{ append, read, close }`. Each event line: `{ ts, version: 1, kind, payload }` where `kind` ∈ `user_message | assistant_message | tool_use | tool_result | error | compaction`. Append uses `appendFileSync(..., { mode: 0o600 })` (owner-only, mirroring `claude-code/utils/sessionStorage.ts`). Read streams via `fs.createReadStream` + `node:readline`, supports `since`/`until` filtering. Replay walks `user_message`+`assistant_message` events back into a `MessageParam[]`; the rest are audit-only. T7 load test: 10 K appends round-trip in <1 s. Section 10. |

**Total**: 39 of ~190 modules.

### In progress (🚧)

*none*

---

## Target harness shapes (11)

The catalog must support producing all of these shapes from a single spec:

| Code | Shape | Reference style | Distinguishing needs |
|---|---|---|---|
| **CLI** | CLI coding agent | Claude Code, gstack | TUI, file/bash tools, hooks, skills, slash commands, MCP, plan mode |
| **CHN** | Channel-based assistant | OpenClaw | Telegram/Slack/Discord/WhatsApp/iMessage adapters, cron, heartbeats, gateway, daemon |
| **CRW** | Multi-agent crew | CrewAI, AutoGen, ADK | Roles, handoffs, structured event flows, A2A |
| **RAG** | RAG pipeline | Haystack, LlamaIndex | Components/pipelines, retrievers, rankers, doc loaders, chunkers, KGs |
| **EVAL** | Evaluation harness | HELM, Ragas, lm-evaluation-harness | Datasets, graders, replay, benchmarks, trajectory grading |
| **MGD** | Enterprise/managed runtime | MAF, ADK, Anthropic Managed | Graph workflows, OTel, A2A/MCP, audit, tenancy, durable execution |
| **GRPH** | Stateful graph runtime | LangGraph | Checkpointing, time-travel, durable execution, HITL |
| **RES** | Autonomous research agent | Deep Research, Manus | Long-horizon execution (hours), citations, branch exploration, report synthesis |
| **VOICE** | Voice-first / realtime | OpenAI Realtime, Vapi | VAD, barge-in, streaming audio, call lifecycle, telephony |
| **BROW** | Browser / computer-use | Operator | Screen capture, mouse/keyboard, vision-grounded actions, DOM/AX tree |
| **BATCH** | Batch / queue worker | none mainstream | Queue consumer, idempotency, retry, rate limit, no live UI |

---

## Test layer templates

Every module entry references one or more of these standard test layers (defined in `docs/AI-Harness-Systems.md` §test layer matrix):

| Code | Layer | What it proves |
|---|---|---|
| **T1** | Unit | Pure logic correct (schema validation, branching, parsing) |
| **T2** | Contract | Adapter honors model/tool/protocol schemas (MCP, A2A, function-call JSON) |
| **T3** | Integration | Module wires correctly with neighbors (orchestrator + tools + permission) |
| **T4** | Replay | Deterministic replay of recorded traces does not regress behavior |
| **T5** | Golden | Fixed dataset → expected metrics within thresholds (eval-graded) |
| **T6** | Trace-grading | Trajectory quality — tool choices, handoffs, approvals, safety |
| **T7** | Load/soak | Concurrency, long-run, resume-after-failure, storage pressure |
| **T8** | Security | Prompt injection, tool-escape, policy bypass, PII exfil, sandbox abuse |
| **T9** | Property | Randomized property-based testing (fuzz inputs, invariants) |

---

# PART A — Factory-Level Modules (the meta-harness itself)

These live in `crewhaus-factory` and produce/operate generated harnesses. They are **not** embedded in the generated artifact.

### Layer F1 — Spec & IR

| Module | Responsibility | Refs (`reference-repos/`) | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| ✅ **`spec-schema`** | Define user-facing harness spec DSL (YAML/TS): agents, tools, channels, workflow, eval, deploy. Versioned, JSON Schema-backed. Currently a `z.discriminatedUnion("target", [cli, workflow])` — CLI carries `agent` + optional `tools[]`; workflow carries top-level `model` + `steps[]` (each with `name`, `instructions`, optional `model` override, optional `tools[]`). | `agent-framework/python/.../declarative/`, `adk-python/cli/`, `openclaw.yaml` schema, `crewAI/.../agent` configs, `claude-code/.../settings.ts` | All | DSL design tradeoffs (YAML vs TS); how MAF declarative format vs ADK YAML differ; LangGraph imperative vs declarative split | T1, T9 |
| ✅ **`spec-parser`** | Parse, lint, resolve includes/macros/overlays → AST. | `langgraph/_validate.py`, `haystack` pipeline YAML loader, `crewAI/.../flow_serializer.py` | All | Include/import semantics; cyclic detection; overlay merging | T1, T9 |
| ✅ **`spec-validator`** | Type-check, resolve refs, verify tool/agent/model existence, profile constraints. | `agent-framework/.../_validation.py`, `langgraph/_validate.py`, `haystack/.../Pipeline.validate` | All | Cross-module ref resolution; profile constraint propagation | T1, T2, T9 |
| ✅ **`ir-model`** | Canonical typed IR: agents, nodes, edges, events, tools, policies, memory, evals, channels, schedule. Runtime-agnostic. `IrV0` (cli) carries name, agent, and tools; `IrWorkflowV0` carries name and `steps[]` where each step has its `model` resolved at lower-time (`step.model ?? workflow.model`). Exported as `IrNode = IrV0 \| IrWorkflowV0`. | `AI-Harness-Systems.md` §IR schema; `agent-framework/.../_workflow_builder.py`; LangGraph graph IR; ADK declarative IR | All | Single IR vs multiple? Event encoding (envelope vs typed message); type system depth | T1 |
| **`ir-passes`** | Optimization passes: dead-tool elimination, profile pruning, edge fusion, prompt-cache prefix sorting, redundancy collapse. | `claude-code/.../services/compact/grouping.ts` (sort pattern); `dspy/.../teleprompt/` pass style | All | Pass ordering; idempotence; pluggable pass registry | T1, T4 |
| **`spec-registry`** | Persist spec templates, versions, migration metadata, ownership, environment overlays, tenant isolation. | `openclaw/config/`, `claude-code/.../migrations/`, `adk-python/cli/` | All | Storage backend (FS / SQL / object); multi-tenant isolation | T1, T3 |
| **`migration-engine`** | Versioned schema migrations across IR versions (template upgrade paths). | `claude-code/.../migrations/` (`CURRENT_MIGRATION_VERSION = 11`); LangGraph checkpoint version migrations | All | Forward + backward migration paths; deprecation policy | T1, T4 |

### Layer F2 — Compiler & Codegen

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| ✅ **`compiler-core`** | Orchestrate frontend (parse → validate → IR) and dispatch to target backends; emit deployment bundle. `lower()` and `emit()` switch on `target` (`cli` → target-cli, `workflow` → target-workflow); workflow lowering resolves per-step model overrides against the workflow default. | LangChain LCEL → LangGraph compile path; MAF `_workflow_builder.py`; ADK declarative-config compilation | All | Pipeline composition; error reporting; partial compilation | T1, T3 |
| **`target-graph`** | Codegen for stateful graph runtime (LangGraph-shape) — node/edge/checkpoint config, durability mode. | `langgraph/.../pregel/`, `agent-framework/.../_workflows/_workflow.py` | **GRPH**, MGD, CRW | Pregel vs imperative; checkpoint scheme | T1, T4 |
| ✅ **`target-workflow`** | Codegen for sequential workflow target. v0 emits an `agent.ts` that runs each step via `runChatLoop({ singleTurn: true })` with per-step instructions, model (override or workflow default), tools, and the prior step's terminal assistant text threaded forward as a synthetic user message. Async event semantics, pub/sub channels, parallel/conditional steps still pending. | `crewAI/.../flow/`, `llama_index/.../workflow`, `adk-python/.../flows/` | **CRW**, MGD, RES | Async event semantics; pub/sub vs typed channels | T1, T3 |
| **`target-pipeline`** | Codegen for pipeline DAG. | `haystack/.../core/`, `haystack/components/` | **RAG** | Component decorator; DAG scheduling | T1, T3 |
| **`target-managed`** | Codegen for managed runtime bundles (Anthropic Managed Agents, OpenAI Codex App Server, AgentCore, Foundry, Agent Engine). | Anthropic Managed Agents docs; OpenAI App Server JSON-RPC; AWS AgentCore; ADK platform | **MGD** | Manifest format diversity; deploy artifact shape | T1, T3 |
| ✅ **`target-cli-bundle`** | Codegen for CLI coding agent: entry, REPL, tools, hooks, settings.json, MCP config. Emits grouped tool imports + `defaultCatalog.register()` calls + `tools: defaultCatalog.list()` for any spec with non-empty `tools`; unknown names fail at compile time via `TargetEmitError`. Hooks/settings/MCP still pending. | `claude-code/main.tsx`, `claude-code/cli/`, `claude-code/entrypoints/` | **CLI** | Bundling (Bun/Node); side-effect imports | T1, T3, T7 |
| **`target-channel-bot`** | Codegen for channel assistant: gateway, channel adapters, cron, daemon. | `openclaw/gateway/`, `openclaw/daemon/`, `openclaw/channels/` | **CHN** | Service shape; multi-channel orchestration | T1, T3 |
| **`target-eval-bundle`** | Codegen for eval harness: dataset loader, runner, graders, report writer. | `lm-evaluation-harness/lm_eval/`, `helm/benchmark/`, `ragas/.../evaluate.py` | **EVAL** | Task spec format; reproducibility | T1, T5 |
| **`target-research-bundle`** | Codegen for autonomous research agent: planner, crawler, citation tracker, report writer. | `gstack-main/.../autoplan/`; CrewAI research flows; ADK research samples | **RES** | Long-horizon resumability; checkpoint-per-stage | T1, T4, T7 |
| **`target-voice`** | Codegen for voice/realtime service: realtime API client, telephony adapter, call lifecycle. | `openai-agents/.../realtime/`, `openai-agents/.../voice/`, `openclaw/realtime-voice/`, `claude-code/voice/` | **VOICE** | Realtime API model differences; PCM/Opus framing | T1, T2, T7 |
| **`target-browser-driver`** | Codegen for computer-use/browser-only agent: screen-grab loop, action driver, vision grounding. | `mcp__computer-use__*`, `mcp__Claude_in_Chrome__*`, OpenAI Operator-style refs | **BROW** | Action latency budget; screenshot frequency | T1, T3 |
| **`target-batch-worker`** | Codegen for queue/batch worker: queue consumer, dedup, retry, rate limit, observability. | None mainstream — design from primitives. Loose ref: `dramatiq/`/`celery/`/`temporal` patterns; `claude-code/.../tools/MonitorTool` (background loop pattern) | **BATCH** | Queue protocol abstraction; idempotency keys | T1, T3, T7 |
| **`bundle-packager`** | Package compiled artifacts to deployable form (Docker/OCI/npm/pypi/manifest.json). | OpenAI Codex container packaging; `agent-framework/.../foundry_hosting/`; `adk-python/.../platform/` | All | OCI vs language-native packaging; layered caching | T1, T3 |
| ✅ **`codegen-templates`** | Templates per target (e.g. Bun + Ink CLI, FastAPI service, Rust microservice). | `gstack-main/.../templates/`; `claude-code/.../components/` Ink templates | All | Template engine choice (Handlebars/Jinja/string); diff-friendly emit | T1 |

### Layer F3 — Deployment & Operations

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`deployment-controller`** | Deploy bundles to local / self-hosted / managed / hybrid. | LangSmith Deployment; ADK Cloud Run / Agent Engine; AgentCore; CrewAI AMP; Foundry | All | Common deploy abstraction across radically different platforms | T1, T3 |
| **`deployment-profiles`** | Profile defs (local-dev, k8s, lambda, agent-engine, foundry, agentcore, hybrid-vpc). | `AI-Harness-Systems.md` §implementation blueprint | All | Config schema per profile; secret resolution per profile | T1 |
| **`canary-controller`** | Shadow traffic / subset routing / rollback on eval or latency regressions. | `AI-Harness-Systems.md` §canary; production patterns | MGD, CHN, GRPH | Routing strategy (header / cookie / hash); rollback triggers | T3, T5, T7 |
| **`migration-runner`** | Run schema/state migrations across deployed runtime versions. | `claude-code/.../migrations/`; LangGraph checkpoint migrations | GRPH, MGD | Online vs offline migrations; rollback safety | T1, T4 |
| **`upgrade-controller`** | In-place runtime upgrades, gradual rollout, version pinning. | `claude-code/.../utils/autoUpdater.ts` | CLI, CHN, MGD | Update channels; pinning semantics | T1, T3 |

### Layer F4 — Studio & Authoring UX

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`studio-ui`** | Visual editor: graph layout, tool wiring, channel binding, eval suite editor. | `agent-framework/.../devui/`; OpenAI Agent Builder; LangSmith Studio; CrewAI AMP UI | All (authoring) | Graph layout algos; collaborative edit OT/CRDT | T1, T3 |
| **`studio-server`** | Backend (project mgmt, multi-user collab, preview runs). | LangSmith control plane; OpenAI Agent Builder backend | All (authoring) | Auth, project model, collab session | T1, T3 |
| **`trace-viewer`** | Visualize traces/runs/replays; trajectory grading UI. | OpenAI Trace UI; LangSmith; `agent-framework/.../devui/`; Haystack tracing UIs | All | Trace data model; flame/swim-lane rendering | T1, T3 |
| **`graph-visualizer`** | Render IR or live workflow graph (mermaid/d3/xyflow). | LangGraph viz; MAF `_viz.py`; `openai-agents/.../visualization.py` | GRPH, CRW, RAG, MGD | Layout for typed graphs; live updates | T1, T3 |
| ✅ **`spec-cli`** | Command-line: `crewhaus compile / init / run / doctor` shipped (PR #2 + PR #10); `deploy / eval / watch` pending. `run` parses spec, lowers in-memory, and dispatches to `runChatLoop` with lazily-resolved tools; `doctor` reports auth, Bun version, and project-spec presence. | `claude-code/cli/`; `adk-python/cli/`; `openclaw/cli/`; gstack CLI | All | Subcommand discovery; help generation; shell completions | T1, T3 |
| **`wizard`** | First-run profile selection, channel/auth setup. | `openclaw/wizard/`; gstack `setup`; `claude-code/.../screens/` | CLI, CHN | State machine; backtracking; resumability | T1, T3 |
| **`scaffold-templates`** | Built-in spec templates per target shape. | gstack slash-commands as ref; `openclaw` profiles | All | Template parameterization; conventions | T1 |

### Layer F5 — Plugin SDK & Extension

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`plugin-sdk`** | Public typed surface for third-party tools, channels, models, graders, target backends. | `openclaw/plugin-sdk/`; `claude-code/.../plugins/`; LangChain integration; Haystack component decorator | All | Stable contract surface; semver | T1, T2 |
| **`plugin-registry`** | Discovery, version pinning, signature verification, capability declaration. | `openclaw/plugins/`; `agent-framework` integrations | All | Signature trust; capability gating | T1, T2, T8 |
| **`plugin-loader`** | Runtime activation, sandboxed import, capability gating. | `openclaw/.../plugins/activation-planner.ts`; `claude-code/.../services/plugins/` | All | Lazy loading; sandboxing JS/Py imports | T1, T3, T8 |
| **`module-marketplace`** | Optional remote registry for sharing modules (tools/skills/channels/graders). | npm/PyPI; HuggingFace Hub; OpenAI tool registry | All | Federation; trust; metadata schema | T1, T2 |

---

# PART B — Composable Runtime Modules

These ship as **selectable building blocks** the factory wires into a generated harness based on the spec.

### Layer R1 — Runtime Core (the agent loop)

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| ✅ **`runtime-orchestrator`** | The main agent/run loop: state-machine-driven inner loop (NeedModel/NeedTools/NeedCompaction/NeedRecovery/Done) with pre-turn compaction (snip → autocompact at 0.85 of context). `runChatLoop` runs as a stdin REPL by default; `singleTurn: true` + `seedMessages` runs one turn from a pre-built history and returns the terminal assistant text (used by target-workflow). Reactive 413-recovery + max-tokens recovery still pending. | `claude-code/query.ts` (1730-line async-gen loop); `langgraph/.../pregel/_loop.py`; `agent-framework/.../_runner.py`; `openai-agents/.../runner.py` | All | Async-gen vs reactive vs callback; state-machine vs free-form | T1, T3, T4 |
| **`query-engine`** | SDK/headless wrapper over orchestrator (`submitMessage()` async-gen). | `claude-code/QueryEngine.ts` | All | SDK message normalization | T1, T3 |
| ✅ **`turn-state-machine`** | Transitions: need_model / need_tools / need_compaction / need_recovery / done. Pure FSM; exhaustive transition tests. | `claude-code/query.ts` `State`/`Continue` pattern | All | Transition diagram; invariant checks | T1, T9 |
| ✅ **`recovery-engine`** | Pure decision function: `recover(error, state) → RecoveryAction`. Taxonomy: `prompt_too_long → compact`, `max_output_tokens → continue`, `overloaded/5xx → retry` (exp backoff capped at 30 s + jitter), `invalid_request → tombstone`, `user-aborted/unknown → fail`. Per-turn budgets (max 5 retries, 1 compact, 3 continues, 1 tombstone). Integrated into `runtime-core` via try/catch around the model stream call. | `claude-code/query.ts` recovery branches; `agent-framework/.../_runner.py` retry | CLI, CHN, CRW, GRPH, MGD, RES | Recovery taxonomy; idempotence under retry | T1, T4 |
| **`stream-runtime`** | Generator composition: provider stream → orchestrator → consumer. | `claude-code/.../services/tools/StreamingToolExecutor.ts`; `openai-agents/.../stream_events.py`; `langgraph/.../streaming` | All | Backpressure; multi-consumer fanout | T1, T3, T7 |
| ✅ **`abort-controller`** | Parent/child `AbortTree` with WeakRef-backed cascade (parent aborts cancel children; siblings/children stay independent). Listener limit raised to 50 per signal. Wired into `runtime-core`: each turn gets a child of the run signal; each tool exec gets a grandchild; first SIGINT aborts the active turn, second exits the process. | `claude-code/.../utils/abortController.ts` | All | AbortSignal threading; cleanup ordering | T1, T3 |
| **`scheduler`** | Concurrency primitives: bounded parallelism, queue, priority lanes (UI vs background vs cron). | `openclaw/.../cron/isolated-agent` lane mgmt | All | Lane isolation; starvation prevention | T1, T7 |
| **`durability-mode`** | Configurable durability: `exit` / `async` / `sync` checkpoint write. | `langgraph/.../checkpoint` durability modes | GRPH, MGD, CHN, RES | Async write semantics; loss-window analysis | T1, T4, T7 |
| ✅ **`run-context`** | Per-run context object threaded through orchestrator/tools/policy. `runId`, `sessionId`, `turnNumber`, `abortSignal`, `logger` — logger child-bound by default. Tool-executor threading is a follow-up. | `claude-code/.../Tool.ts` `ToolUseContext`; `openai-agents/.../run_context.py` | All | What goes in context; immutability vs mutation | T1, T3 |

### Layer R2 — Model Layer

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| ✅ **`model-adapter`** | Protocol over vendor SDKs (Anthropic/OpenAI/Gemini/Bedrock/local). Normalizes messages, tools, structured output. | `openai-agents/.../models/`; `agent-framework/.../openai/`,`anthropic/`,`gemini/`; `dspy/.../clients/`; `crewAI/.../llms/` | All | Common message schema; cross-provider feature gaps | T1, T2 |
| **`model-router`** | Route by policy: cost/quality/latency, alias resolution, regional routing. | `openclaw/.../agents/anthropic-vertex-stream.ts`; `crewAI/.../llm.py`; `AI-Harness-Systems.md` §model_policy | All | Policy DSL; failover topology | T1, T2, T7 |
| ✅ **`token-budget`** | `estimateTokens()` (char/4 heuristic) + `TokenBudget` class with `add()` and `isApproachingLimit(threshold = 0.85)`. Handles tool_use/tool_result content shapes; image/document blocks ignored. Auto-continue thresholds + diminishing-returns logic deferred. | `claude-code/.../query/tokenBudget.ts` (+500k auto-continue); `claude-code/.../utils/tokenEstimation.ts` | All | Tokenizer parity across providers | T1, T9 |
| **`prompt-cache-manager`** | Prompt-cache stability: contiguous tool prefixes, cache-friendly system prompts, cache breakpoints. | `claude-code/tools.ts` (built-ins prefix); Anthropic prompt-caching docs | All | Provider cache semantics; breakpoint placement | T1, T4 |
| **`response-format-coercion`** | Force structured/JSON output; schema validation; retry-on-malformed. | `dspy/.../predict/`; `openai-agents/.../agent_output.py`; `openclaw/.../agents/anthropic-payload-policy.ts` | All | Provider-native vs prompted JSON; coercion ladders | T1, T2, T9 |
| **`reasoning-controller`** | Thinking modes / extended thinking, effort levels, reasoning visibility. | `claude-code/.../state/AppStateStore.ts` (`thinkingConfig`,`effortValue`); `openclaw/auto-reply/` | CLI, CHN, CRW, GRPH, RES | When to expose chain-of-thought; cost vs quality | T1, T5 |
| **`speculation-engine`** | Speculative decoding / pre-fetch of likely-next-tool. | `claude-code/.../state/AppStateStore.ts` `speculation` | CLI, RES | Speculation hit-rate; rollback cost | T1, T7 |
| **`cost-tracker`** | Estimate $/run, attribute to tenant/agent/tool. | `claude-code/.../cost-tracker.ts`; `ragas/.../cost.py`; `AI-Harness-Systems.md` §cost | All | Provider price tables; granular attribution | T1, T7 |
| **`auth-profiles`** | Multi-provider creds (API keys, OAuth, IAM roles); profile switching; rotation. | `openclaw/.../agents/auth-profiles/`; `claude-code/.../utils/auth.ts`; `claude-code/.../services/oauth/` | All | Secure storage; OAuth flow framework | T1, T2, T8 |
| **`embedding-adapter`** | Embedding model adapter (separate from chat models). | `haystack/.../embedders/`; `llama_index/.../embeddings/`; `dspy/.../embeddings/` | RAG, RES, CHN, MGD | Pooling; batch sizing; quantization | T1, T2 |

### Layer R3 — Tool Layer (core)

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| ✅ **`tool-catalog`** | Registry of tools w/ metadata (concurrency-safe, read-only, destructive, defer, profile). | `claude-code/Tool.ts` + `tools.ts`; `openclaw/.../agents/tool-catalog.ts`; `openai-agents/.../tool.py` | CLI, CHN, CRW, MGD, GRPH, RES, BROW, BATCH | Metadata schema; profile membership | T1 |
| ✅ **`tool-builder`** | Factory `buildTool()` w/ fail-closed defaults. | `claude-code/.../Tool.ts` `buildTool` factory | All | Default safety posture | T1, T9 |
| ✅ **`tool-orchestrator`** | Partition tool calls into concurrent/serial batches. | `claude-code/.../services/tools/toolOrchestration.ts` (`partitionToolCalls`); `agent-framework/.../_executor.py` | CLI, CHN, CRW, MGD, GRPH, RES | Concurrency-safety classification | T1, T3, T7 |
| ✅ **`tool-executor`** | Execute single tool: validate → permission → invoke → format result. | `claude-code/.../services/tools/toolExecution.ts`; `openai-agents/.../agent.py` tool exec | CLI, CHN, CRW, MGD, GRPH, RES, BROW | Error normalization; timeout handling | T1, T3 |
| ✅ **`streaming-tool-executor`** | Execute tools while model still streaming. | `claude-code/.../services/tools/StreamingToolExecutor.ts` | CLI, CHN, RES | Partial-args parsing; sibling abort | T1, T3, T7 |
| ✅ **`tool-result-store`** | Persist large tool outputs to disk; preview to model. | `claude-code/.../utils/toolResultStorage.ts` | CLI, CHN, RES | Preview shape; addressing scheme | T1, T3 |
| ✅ **`tool-loop-detection`** | Detect repeated tool calls; prevent runaway. | `openclaw/.../agents/tool-loop-detection.ts` | CLI, CHN, CRW, GRPH, RES | Hash window; false-positive rate | T1, T9 |
| **`tool-search`** | Deferred tool loading by keyword (saves tokens). | `claude-code/.../tools/ToolSearchTool/`; `Tool.ts` `shouldDefer` | CLI, CHN, RES | Index strategy; recall quality | T1, T5 |
| **`tool-display`** | Render tool calls/results in TUI/UI (React/Ink). | `openclaw/.../agents/tool-display.ts`; `claude-code/Tool.ts` `renderToolUseMessage` | CLI, CHN | Render perf; long-output truncation | T1, T3 |
| ✅ **`tool-permission-matcher`** | Pattern matchers for permission rules (`Bash(git *)`). | `claude-code/.../utils/permissions/preparePermissionMatcher` | All | Glob vs regex; pattern composition | T1, T9 |
| ✅ **`tool-validate`** | Pre-permission input validation per tool (Zod/Pydantic). | `claude-code/.../Tool.ts` `validateInput`; `openai-agents/.../tool.py` schema | All | Schema-validation error mapping | T1, T2 |

### Layer R4 — Built-in Tool Implementations

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| ✅ **`tool-fs`** | `read`/`write`/`edit`/`apply_patch`/glob/grep over workspace; FS policy enforcement. Slice ships `Read`/`Write`/`Edit`/`Glob`/`Grep` sandboxed to `process.cwd()`; atomic writes via temp + rename; `ToolPermissionError` on traversal. `apply_patch` and policy hooks pending. PR #8. | `claude-code/.../tools/FileReadTool` etc.; `openclaw/.../agents/bash-tools.*`; `openclaw/.../agents/tool-fs-policy.ts`; `openai-agents/.../sandbox/files.py` | CLI, CHN, CRW, RES, BATCH | Atomic edit; path traversal defense | T1, T3, T8 |
| ✅ **`tool-bash`** | Shell exec, background process mgmt, kill-tree. Slice ships foreground exec via `Bun.spawn` with default 30s timeout (max 10min). Background process / kill-tree pending. PR #8. | `claude-code/.../tools/BashTool`; `openclaw/.../process/exec.ts`,`kill-tree.ts` | CLI, CHN, BATCH, RES | Sandboxing; timeout; output buffering | T1, T3, T8 |
| **`tool-process`** | Long-running background processes; monitoring; log capture. | `openclaw/.../agents/bash-tools.process.ts`; `claude-code/.../utils/Shell.ts` | CLI, CHN, BATCH | PID tracking; reap policy | T1, T3, T7 |
| **`tool-code-execution`** | Sandboxed Python/JS REPL. | `claude-code/.../tools/REPLTool`; OpenAI Code Interpreter; Foundry CI; `adk-python/.../code_executors/` | CLI, MGD, EVAL, RES, BATCH | Container vs micro-VM; warm pool | T1, T3, T7, T8 |
| **`tool-web-search`** | Brave/Bing/Google/X/Tavily providers. | `openclaw/web-search/`; `claude-code/.../tools/WebSearchTool`; `openai-agents/.../extensions/` | CLI, CHN, CRW, RAG, RES | Provider fallback; result normalization | T1, T2 |
| **`tool-web-fetch`** | URL fetch, content extraction, link understanding. | `openclaw/.../web-fetch/`; `openclaw/.../link-understanding/`; `claude-code/.../tools/WebFetchTool` | CLI, CHN, CRW, RAG, RES | Robots.txt; sniff; redirect cycles | T1, T2, T8 |
| **`tool-browser`** | Stateful browser automation (Playwright/Chromium). | `claude-code/.../tools/WebBrowserTool`; `openclaw/.../canvas-host/`; OpenAI Agents browser | CLI, CHN, CRW, RES, BROW | Session pooling; isolation | T1, T3, T7, T8 |
| ✅ **`tool-mcp`** | Wrapper presenting external MCP tools as native tools. Slice ships `registerMcpServer(host, serverName, catalog, opts?)` building one `RegisteredTool` per remote tool with namespaced name `<serverName>__<toolName>`; per-tool flag overrides via `opts.perTool`. JSON Schema forwarded verbatim via `RegisteredTool.jsonSchema` (runtime-core honours it over `zodToJsonSchema`). Section 9. | `claude-code/.../services/mcp/`; `crewAI/.../tools/mcp_native_tool.py`; `openclaw/mcp/` | CLI, CHN, MGD, RES, BROW | Stdio vs SSE; auth handoff | T1, T2, T3 |
| **`tool-image-generation`** | Image gen (DALL-E/Flux). | `openclaw/.../image-generation/`; `openclaw/.../agents/tool-images.ts` | CHN, CRW, RES | Provider abstraction; safety filters | T1, T2 |
| **`tool-tts-stt`** | TTS + speech-to-text tools. | `openclaw/tts/`; `openai-agents/.../voice/`; `openclaw/.../realtime-voice/`,`realtime-transcription/` | CHN, VOICE | Codec choice; streaming | T1, T2, T7 |
| ✅ **`tool-todo`** | Todo-list tool for plan tracking. Module-level per-process list; `TodoWrite` overwrites the list and renders a markdown checklist with status/priority. PR #8. | `claude-code/.../tools/TodoWriteTool` | CLI, CRW, RES | Diff-friendly output | T1 |
| **`tool-skill`** | Read SKILL.md → context. | `claude-code/.../tools/SkillTool`; `openclaw/.../agents/skills/serialize.ts` | CLI, CHN, RES | Frontmatter schema; conflict resolution | T1, T3 |
| **`tool-ask-user`** | Interactive question prompting. | `claude-code/.../tools/AskUserQuestionTool` | CLI, CHN, CRW, VOICE | Multi-select UX; preview rendering | T1, T3 |
| **`tool-cron`** | Cron-job CRUD tool. | `claude-code/.../tools/ScheduleCronTool`; `openclaw/cron/` | CLI, CHN | Cron-expression parsing | T1, T3 |
| **`tool-task`** | Task lifecycle tool (create/get/list/update/stop). | `claude-code/.../tools/Task*Tool/`; `openclaw/tasks/` | CLI, CHN, CRW, RES | Task state model | T1, T3 |
| **`tool-team`** | Team/teammate management. | `claude-code/.../tools/TeamCreateTool`,`TeamDeleteTool` | CLI, CRW | Team invite flow | T1, T3 |
| **`tool-agent`** | Subagent spawn (`AgentTool`). | `claude-code/.../tools/AgentTool/`; `adk-python/.../agents/`; `openai-agents/.../_agent.py` | CLI, CRW, MGD, RES | Context filtering; tool restriction | T1, T3, T6 |
| **`tool-message-channel`** | Send messages to other channels/sessions/users. | `openclaw/.../agents/channel-tools.ts`; `claude-code/.../tools/SendMessageTool` | CHN | Cross-channel addressing | T1, T2, T8 |
| **`tool-memory`** | Memory get/search tool. | `crewAI/.../memory/`; `openai-agents/.../memory/`; `agent-framework/.../mem0/`; `openclaw/.../agents/memory/` | CHN, CRW, GRPH, RES | Recall ranking | T1, T5 |
| **`tool-plan-mode`** | Plan-mode entry/exit (read-only planning). | `claude-code/.../tools/EnterPlanModeTool`,`ExitPlanModeV2Tool` | CLI, RES | Plan file persistence | T1, T3 |
| **`tool-worktree`** | Git worktree management. | `claude-code/.../tools/EnterWorktreeTool`,`ExitWorktreeTool` | CLI | Cleanup safety | T1, T3 |
| **`tool-lsp`** | Language-server queries (defs, refs, diagnostics). | `claude-code/.../tools/LSPTool/`; `claude-code/.../services/lsp/` | CLI | LSP capability discovery | T1, T2, T3 |
| **`tool-monitor`** | Stream lines from long-running process as notifications. | `claude-code/.../tools/MonitorTool` | CLI, CHN, BATCH | Backpressure | T1, T3, T7 |
| **`tool-sleep`** | Schedule a wakeup. | `claude-code/.../tools/SleepTool` | CLI, CHN, RES | Drift handling | T1 |
| **`tool-notebook-edit`** | Jupyter notebook edits. | `claude-code/.../tools/NotebookEditTool` | CLI, RAG | nbformat compatibility | T1, T3 |
| **`tool-notification`** | Push notification (slack/email/webhook to user). | `claude-code/.../tools/PushNotification`; `openclaw/.../agents/announce-idempotency.ts` | CHN, RES, BATCH | Dedup; quiet hours | T1, T3 |
| **`tool-remote-trigger`** | Trigger external URL/webhook with payload. | `claude-code/.../tools/RemoteTriggerTool` | CHN, CRW, BATCH | Auth; idempotency keys | T1, T2, T8 |
| **`tool-canvas`** | UI-canvas-as-tool (rich-content surface). | `openclaw/canvas-host/` | CHN | Canvas widget vocabulary | T1, T3 |
| **`tool-citations`** | Manage citation/source-attribution metadata in tool calls. | `agent-framework/.../citations/`; `openclaw/.../citations/` (if present); `claude-code/.../citations/` | RAG, RES, CHN | Span vs doc-level; cross-source merging | T1, T5 |
| **`tool-screen-capture`** | Take screenshots / screen video. | `mcp__computer-use__screenshot`; `claude-code/.../tools/screenshot` | BROW, CLI | Frame rate; diff detection | T1, T3 |
| **`tool-mouse-keyboard`** | Pixel-level mouse/keyboard input. | `mcp__computer-use__left_click` etc.; CC keyboard tools | BROW | Coordinate normalization; key chord encoding | T1, T3 |
| **`tool-vision-grounding`** | Find on-screen elements by description (vision model + heuristics). | `mcp__Claude_in_Chrome__find`; OpenAI Operator-style | BROW, CLI | Element-locator robustness | T1, T5, T6 |
| **`tool-dom-inspector`** | DOM/AX-tree-based element queries (when in browser). | `mcp__Claude_in_Chrome__read_page`,`get_page_text` | BROW | DOM snapshot diffing | T1, T2, T3 |

### Layer R5 — MCP & Protocol Hosts

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| ✅ **`mcp-host`** | MCP client manager: stdio + SSE transports, reconnect, server registry. Slice ships `McpHost.addServer()` / `getClient()` / `disconnectAll()` and `McpClient` over `@modelcontextprotocol/sdk` with exp-backoff reconnect (1–30 s, ±10% jitter, no max attempts), proactive `onclose` detection, queue-capped (16) `connectedDeferred` for in-flight calls, and reduced text/image/audio/resource result blocks. T2 contract test gated behind `CREWHAUS_RUN_MCP_CONTRACT=1`. WebSocket / OAuth pending. Section 9. | `claude-code/.../services/mcp/`; `openclaw/mcp/`; `agent-framework/.../_mcp.py`; `openai-agents/.../mcp/`; `adk-python/.../tools/` MCP support | All except pure RAG/EVAL | Transport handshake; reconnection backoff | T1, T2, T7, T8 |
| **`mcp-server-host`** | Expose harness's tools as an MCP server. | `openclaw/.../canvas-host/server.ts`; LangSmith MCP exposure | CHN, MGD | Surface filtering; auth | T1, T2, T8 |
| **`a2a-protocol`** | Agent-to-Agent protocol client/server (Google A2A). | `agent-framework/.../a2a/`; `crewAI/.../a2a/`; `adk-python/.../a2a/` | CRW, MGD | A2A message envelope; capability discovery | T1, T2 |
| **`acp-protocol`** | Agent Control Plane protocol (session policy, approvals, spawning). | `openclaw/acp/` | CHN, MGD | Control vs data plane split | T1, T2 |
| **`ag-ui-protocol`** | Agent-UI protocol streaming UI events (Codex App Server-style JSON-RPC). | `agent-framework/.../ag_ui/`; OpenAI Codex App Server JSON-RPC; `openclaw/.../canvas-host/a2ui*` | CLI, CHN, MGD | Bidirectional event vocabulary | T1, T2, T3 |
| **`webhook-host`** | Inbound webhook receiver (for tools, channels, integrations). | `openclaw/.../gateway/server-webhooks.ts`; CC custom hooks | CHN, BATCH, MGD | Verification; replay defense | T1, T2, T8 |

### Layer R6 — Context & Memory

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`context-engine`** | Pluggable context-management interface (bootstrap/maintain/ingest/assemble/compact). | `openclaw/context-engine/`; `claude-code/context.ts` | CLI, CHN, CRW, GRPH, RES | Interface stability; named impls | T1, T3 |
| ✅ **`compaction-snip`** | Pure middle-message removal with `[Context compacted: N messages removed]` marker. Boundary defense walks `headEnd`/`tailStart` until tool_use/tool_result pairs are intact. | `claude-code/.../services/compact/snipCompact.ts` | CLI, CHN, RES | Snip thresholds | T1, T9 |
| **`compaction-microcompact`** | Cached per-tool-use-id compaction. | `claude-code/.../services/compact/microCompact.ts`,`apiMicrocompact.ts` | CLI, CHN, RES | Cache key design | T1, T4 |
| **`compaction-context-collapse`** | Read-time projection over full history. | `claude-code/.../services/contextCollapse/` | CLI, CHN, GRPH, RES | Projection schema | T1, T4 |
| ✅ **`compaction-autocompact`** | Calls the model to summarize the conversation; returns `[user-marker, assistant-summary]` pair. Circuit breaker, session-memory promotion, cache-safe params deferred. | `claude-code/.../services/compact/autoCompact.ts` | CLI, CHN, CRW, GRPH, MGD, RES | Summary fidelity vs cost | T1, T5 |
| **`compaction-reactive`** | Emergency compaction on 413 / prompt-too-long. | `claude-code/query.ts` reactive-compact branch | CLI, CHN, CRW, GRPH, MGD, RES | Recovery loop bound | T1, T4 |
| **`compaction-tool-result-budget`** | Per-message aggregate-tool-result budget; persist overflow. | `claude-code/.../utils/toolResultStorage.ts` | CLI, CHN, RES | Budget allocation strategy | T1, T9 |
| **`compaction-session-memory`** | Promote insights to session memory at compaction. | `claude-code/.../services/compact/sessionMemoryCompact.ts` | CLI, CHN | Promotion criteria | T1, T5 |
| **`bootstrap-files`** | Workspace-file injection (CLAUDE.md/AGENTS.md/TOOLS.md/USER.md/SOUL.md/HEARTBEAT.md), budget, caching. | `openclaw/.../agents/bootstrap-files.ts`,`bootstrap-cache.ts`,`bootstrap-budget.ts`; `claude-code/context.ts` | CLI, CHN, RES | Walk semantics; budget allocation | T1, T3, T9 |
| **`system-prompt-builder`** | Composable sections (identity/tooling/safety/skills/messaging/runtime/extras), token-budget-aware. | `openclaw/.../agents/system-prompt.ts` (anti-pattern: 720-line god fn); `claude-code/context.ts` | All | Section composition; per-section budget | T1, T9 |
| **`memory-service`** | Long-term memory (key-value, vector, episodic, declarative). | `crewAI/.../memory/`; `openai-agents/.../memory/`; `agent-framework/.../mem0/`; `adk-python/.../memory/`; `openclaw/.../agents/memory/`; `claude-code/memdir/` | CHN, CRW, GRPH, RES | Recall vs precision; namespace model | T1, T3, T5 |
| **`memory-extraction`** | Auto-extract memories from conversations. | `claude-code/.../services/extractMemories/` | CHN, CLI, RES | Extraction quality; PII | T1, T5, T8 |
| **`personalization-store`** | User preference + identity store. | `openclaw/secrets/`; `openclaw/.../agents/auth-profiles/` | CHN | Schema; consent | T1, T8 |
| **`vector-store`** | Vector index over memory/docs (FAISS/qdrant/pinecone/weaviate/local). | `haystack/.../document_stores/`; `llama_index/.../vector_stores/` | RAG, CHN, CRW, RES | Backend abstraction; metadata filtering | T1, T2, T7 |

### Layer R7 — State, Sessions, Persistence

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| ✅ **`session-store`** | Short-term session state, identity, lifecycle. v0 file-backed JSON at `.crewhaus/sessions/<id>.json`; id format `sess_<16 hex>`; atomic writes via tmp + rename; `list()` evicts files whose **mtime** is older than `ttlDays` (default 30) days, unlinking the `.json` AND the sibling `.jsonl` event log. Path-traversal guard on every read path. Section 10. | `openclaw/sessions/`; `claude-code/.../utils/sessionStorage.ts`; `agent-framework/.../_sessions.py`; `adk-python/.../sessions/`; `openai-agents/.../memory/session.py` | All | TTL; eviction; identity model | T1, T3, T7 |
| ✅ **`event-log`** | Append-only event/transcript history (JSONL). v0 ships `openEventLog(sessionId, opts)` → `{ append, read, close }`; events `{ ts, version: 1, kind, payload }` with kind ∈ `user_message | assistant_message | tool_use | tool_result | error | compaction`. Append uses `appendFileSync` mode `0o600`; read streams via `node:readline` with optional `since`/`until` filtering; malformed lines throw `RuntimeError` carrying the line number. Replay (`replayMessageHistory` in runtime-core) walks `user_message`+`assistant_message` events into a `MessageParam[]`. Section 10. | `claude-code/.../utils/sessionStorage.ts`; `AI-Harness-Systems.md` §append-only event history; OpenClaw transcripts | All | Schema versioning; GC | T1, T4, T7 |
| **`checkpoint-store`** | Resumable state snapshots (graph node state, branches, time-travel). | `langgraph/.../checkpoint/`; `agent-framework/.../_checkpoint.py`,`_checkpoint_encoding.py`; ADK sessions | GRPH, MGD, CHN, RES | Encoding; partial save | T1, T4, T7 |
| ✅ **`state-store`** | In-process state container (zustand-style); referential equality, listeners. v0 ships `createStore<T>(initial)` → `{ get, set, subscribe, select }`; root listeners fire on every actual change, `select(selector)` listeners fire only when `Object.is(selector(next), selector(prev)) === false`. ~50 lines, no dependencies. Per-`runChatLoop` instance; consumed by hooks/skills in Section 11+. Section 10. | `claude-code/.../state/store.ts` (40 lines) | All | Observers; immutability | T1, T9 |
| **`app-state-store`** | Monolithic typed `AppState` for running harness. | `claude-code/.../state/AppStateStore.ts` | CLI, CHN | State tree shape | T1, T3 |
| **`global-state-singleton`** | Process-global registry (`Symbol.for(...)`). | `openclaw/global-state.ts`; `claude-code/.../bootstrap/state.ts` | CLI, CHN | Test isolation | T1, T3 |
| **`branch-history`** | Time-travel / branch / fork session histories. | `langgraph` time-travel; `agent-framework/.../_checkpoint.py`; `claude-code/buddy/` | GRPH, MGD, RES | Branch identity; merge semantics | T1, T4 |
| **`artifact-store`** | Persist files, screenshots, patches, generated docs, reports. | OpenAI artifact APIs; `adk-python/.../artifacts/`; `openclaw/blob-store.ts` | All except RAG-only | Content addressing; GC | T1, T3 |
| **`session-router`** | Resolve session keys (`agent:<id>:main`/`:subagent:<uuid>`/`:cron:<jobId>`). | `openclaw/routing/`; `openclaw/.../sessions/session-id.ts` | CHN, CLI | Key grammar; collision | T1, T9 |
| **`session-binding`** | Bind session ↔ channel ↔ thread ↔ user. | `openclaw/bindings/` | CHN | Multi-tenant | T1, T3 |
| **`replay-store`** | Recorded runs for replay tests + regression. | `openai-agents/tracing/`; `dspy/cache.py` | EVAL, all CI | Determinism guarantees | T1, T4 |

### Layer R8 — Permission, Policy, Safety

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| ✅ **`permission-engine`** | Modes (`default`/`plan`/`auto`/`bypass`); 5-source `RuleSet` walked in priority order `flag → settings → yaml → hooks → builtin`; rule types `alwaysAllow`/`alwaysDeny`/`alwaysAsk`. Built on `tool-permission-matcher` patterns. SECURITY: `mode: bypass` is rejected at parse time from yaml/settings sources (only the `--permission-mode` flag may select it). Integrated into `runtime-core` so each tool call evaluates before exec; in REPL mode `ask` prompts via stdin. | `claude-code/.../utils/permissions/` (14 files); `AI-Harness-Systems.md` §Policy engine | CLI, CHN, CRW, MGD, BATCH | Layered evaluation; precedence | T1, T3, T8 |
| **`approval-classifier`** | ML auto-approve for safe ops (yolo classifier). | `claude-code/.../utils/permissions/yoloClassifier.ts`; `openclaw/.../acp/approval-classifier.ts` | CLI, CHN | Calibration; abstain rate | T1, T5, T8 |
| **`denial-tracking`** | Count consecutive denials; fall back to ask. | `claude-code/.../utils/permissions/denialTracking.ts`; `claude-code/.../utils/autoModeDenials.ts` | CLI, CHN | Threshold tuning | T1, T9 |
| **`guardrails`** | Input/output guardrails (PII, jailbreak, secret leak, NSFW). | `openai-agents/.../guardrail.py`,`tool_guardrails.py`; `AI-Harness-Systems.md` §guardrails | CHN, CRW, MGD, RES, VOICE | Cost/latency; false positive | T1, T3, T8 |
| **`policy-engine`** | Side-effect classification, allowlists, regulated ops, audit. | `AI-Harness-Systems.md` §PolicyEngine; `openclaw/.../security/exec-policy.ts`; `openclaw/.../agents/auth-mode-policy.ts` | CLI, CHN, MGD, BATCH | Policy DSL; compile vs runtime | T1, T3, T8 |
| **`secrets-manager`** | Read/decrypt secrets (env / keychain / vault / cloud KMS). | `openclaw/secrets/`; `claude-code/.../utils/auth.ts`; `agent-framework/.../_settings.py` | All | Backend abstraction; rotation | T1, T2, T8 |
| **`sandbox`** | Containerized exec environment (Docker/firecracker/wasm/chroot). | `openai-agents/.../sandbox/`; `openclaw/.../security/exec-policy.ts`; OpenAI Codex sandboxes | CLI, CHN, MGD, EVAL, BATCH | VM startup latency; warm pool | T1, T3, T7, T8 |
| **`safety-prompt-injector`** | Inject safety/system-policy text. | `claude-code/context.ts`; `AI-Harness-Systems.md` §safety | All | Section ordering | T1, T8 |
| **`hitl-engine`** | Human-in-the-loop interrupt/resume; approval gates. | `langgraph` HITL; `haystack/.../human_in_the_loop/`; `agent-framework/.../_request_info_mixin.py`; `crewAI/.../flow/human_feedback.py` | GRPH, MGD, CRW, RES | Resumption tokens; UI hooks | T1, T3, T4 |
| **`pii-redactor`** | Detect/redact PII in inputs, outputs, logs. | `openai-agents/guardrails`; common DLP libs | CHN, MGD, VOICE | Recall vs precision | T1, T5, T8 |
| **`prompt-injection-detector`** | Detect/mitigate prompt injection in tool outputs. | `gstack-main/.../prompt-injection-defense/`; `AI-Harness-Systems.md` §security | All | Injection taxonomy; mitigation cost | T1, T8 |

### Layer R9 — Hooks, Skills, Slash Commands

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`hooks-engine`** | Lifecycle hooks (pre-tool/post-tool/stop/compact/session-start/etc.). | `openclaw/hooks/`; `claude-code/hooks/`; `agent-framework/.../_middleware.py`; `crewAI/.../hooks/` | CLI, CHN, CRW, GRPH, MGD, RES, BATCH | Hook lifecycle; user vs system hooks | T1, T3 |
| **`hook-loader`** | Discover hooks from settings.json, plugins, project files. | `claude-code/hooks/` | CLI, CHN | Discovery order | T1, T3 |
| **`skills-registry`** | Skills catalog (lazy-loaded SKILL.md from workspace, plugins, bundled). | `openclaw/.../agents/skills/`; `claude-code/skills/` | CLI, CHN, RES | Lazy-loading; conflict | T1, T3 |
| **`skills-serializer`** | Render skills list into system prompt. | `openclaw/.../agents/skills/serialize.ts`; `claude-code/.../skills/loadSkillsDir.ts` | CLI, CHN, RES | Token budget for skill list | T1, T9 |
| **`slash-commands`** | Define, parse, route, render slash commands. | `openclaw/commands/`; `claude-code/commands.ts`,`commands/`; gstack slash-command catalog | CLI, CHN | Arg parsing; help | T1, T3 |
| **`output-styles`** | Output-style/persona overlays. | `claude-code/outputStyles/` | CLI, CHN, VOICE | Style composition | T1, T5 |
| **`autoreply-policy`** | Should agent respond? (mention-gating, batch debounce, heartbeat suppression). | `openclaw/auto-reply/`; `openclaw/.../cron/heartbeat-policy.ts` | CHN | Decision tree | T1, T9 |

### Layer R10 — Multi-Agent / Coordination

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`subagent-runtime`** | Spawn subagents w/ filtered tool sets and forked context. | `claude-code/.../tools/AgentTool/`; `claude-code/.../utils/agentContext.ts`; `openclaw/.../agents/pi-embedded-runner/`; `crewAI/.../agent`; `openai-agents/.../_agent.py`; `adk-python/.../agents/` | CLI, CRW, MGD, RES | Context filter rules; isolation | T1, T3, T6 |
| **`coordinator`** | Centralized coordinator (manager → workers). | `claude-code/.../coordinator/`; `crewAI/.../process.py`; `autogen/.../magentic-one`; `agent-framework/.../orchestrations/` | CRW, CLI, RES | Task assignment; aggregation | T1, T3, T6 |
| **`swarm-runtime`** | Decentralized peer-to-peer team (tmux/iTerm/in-process/network). | `claude-code/.../utils/swarm/`; `openclaw/.../tasks/detached-task-runtime.ts` | CRW, CLI | Discovery; consensus | T1, T3 |
| **`handoff-engine`** | Structured agent-to-agent handoff w/ filters. | `openai-agents/.../handoffs/`,`handoff_filters.py`,`handoff_prompt.py`; `crewAI/.../process.py`; `agent-framework/.../orchestrations/` | CRW, MGD, GRPH | Handoff envelope; filter DSL | T1, T3, T6 |
| **`role-system`** | Role definitions (CrewAI-style: backstory/goal/agent-type), team composition. | `crewAI/.../agent`; `crewAI/.../crew.py`; `crewAI/crews/` | CRW | Role schema; conflict | T1, T6 |
| **`task-engine`** | Task lifecycle (create/run/track/result), dependency wiring. | `openclaw/tasks/`; `claude-code/Task.ts`,`tasks.ts`; `crewAI/.../task.py`,`tasks/` | CRW, CLI, MGD, BATCH, RES | DAG semantics | T1, T3, T7 |
| **`pairing-engine`** | Pair/teammate model (operator + agent, multi-host). | `claude-code/buddy/`; `openclaw/pairing/` | CLI, CHN | Cross-process state sync | T1, T3 |

### Layer R11 — Workflow / Graph / Pipeline Engines

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`graph-engine`** | Stateful graph runtime: nodes, edges, conditional edges, persistence, time-travel. | `langgraph/.../pregel/`; `agent-framework/.../_workflow.py`,`_workflow_builder.py`,`_executor.py` | GRPH, MGD | Pregel-style supersteps; deterministic stepping | T1, T3, T4 |
| **`workflow-engine`** | Async-event workflow runtime; pub/sub event bus, step decorators. | `crewAI/.../flow/`; `llama_index/.../workflow`; `adk-python/.../flows/` | CRW, MGD, RES, BATCH | Event semantics; backpressure | T1, T3, T7 |
| **`pipeline-engine`** | Component pipeline DAG. | `haystack/.../core/`; `haystack/components/`; `llama_index/.../query_engine/` | RAG | DAG validation; type-flow | T1, T3 |
| **`durable-execution`** | Long-running, recoverable execution (durable functions / activities). | `agent-framework/.../durabletask/`; `langgraph` durability modes | GRPH, MGD, BATCH, RES | Activity replay; idempotence | T1, T4, T7 |
| **`workflow-checkpointer`** | Workflow-specific checkpointing. | `agent-framework/.../_checkpoint.py` | GRPH, MGD, RES | Encoding format | T1, T4 |
| **`event-bus`** | Internal event publishing for workflow/agents. | `crewAI/.../events/`; `llama_index/.../instrumentation/` | CRW, MGD, GRPH | Topic taxonomy; subscriber model | T1, T3, T7 |
| **`checkpoint-encoder`** | Versioned encoding/decoding of checkpoint payloads. | `agent-framework/.../_checkpoint_encoding.py`; LangGraph serializers | GRPH, MGD, RES | Schema evolution; size | T1, T4 |

### Layer R12 — RAG / Retrieval / Knowledge

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`document-store`** | Document storage abstraction (in-mem/FAISS/qdrant/pinecone/weaviate). | `haystack/.../document_stores/`; `llama_index/.../indices/` | RAG, CHN, CRW, RES | Backend selection; metadata filter | T1, T2, T7 |
| **`retriever`** | Retrieve docs by similarity / BM25 / hybrid / structured-query. | `haystack/.../retrievers/`; `llama_index/.../retrievers/`; `dspy/.../retrievers/`; `crewAI/.../rag/` | RAG, CHN, CRW, RES | Hybrid scoring; recency | T1, T5 |
| **`ranker`** | Rerank retrieved docs (cross-encoder/LLM/fusion). | `haystack/.../rankers/` | RAG, RES | Cost vs uplift | T1, T5 |
| **`reader-extractor`** | Extract spans/answer from retrieved docs. | `haystack/.../readers`; `llama_index/.../extractors/` | RAG | Extractive vs abstractive | T1, T5 |
| **`query-router`** | Conditional pipeline branching (query type / language / topic). | `haystack/.../routers/`; `llama_index/.../selectors/` | RAG, MGD | Classifier choice | T1, T3 |
| **`generator`** | LLM call inside pipeline (with retrieved context). | `haystack/.../generators/`; `llama_index/.../llms/` | RAG | Wraps `model-adapter` | T1, T2 |
| **`document-loader`** | Read PDF/DOCX/HTML/Notion/Drive into Documents. | `haystack/.../readers`; `llama_index/.../readers/`; `openclaw/markdown/` | RAG, CHN, RES | Format coverage | T1, T2 |
| **`chunker`** | Split docs into chunks. | `haystack/.../preprocessors`; `llama_index/.../node_parser/` | RAG | Chunk size/overlap study | T1, T5 |
| **`knowledge-graph`** | Optional KG layer over docs. | `crewAI/.../knowledge/`; `llama_index/.../graph_stores/` | RAG, CRW, RES | Triple extraction quality | T1, T5 |
| **`ingestion-pipeline`** | Crawl → load → chunk → embed → store. | `llama_index/.../ingestion/`; `haystack` pipelines | RAG, RES | Incremental update; dedup | T1, T3, T7 |
| **`citation-tracker`** | Track sources, quotes, evidence per claim. | `agent-framework/.../citations/`; OpenClaw citation refs | RAG, RES | Span-level vs doc-level | T1, T5, T6 |

### Layer R13 — Channels & Messaging

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`channel-registry`** | Register channel adapters by id; normalize ids. | `openclaw/.../channels/registry.ts`,`ids.ts` | CHN | Plugin loader integration | T1 |
| **`channel-adapter-base`** | Abstract channel adapter interface. | `openclaw/.../channels/types.ts` | CHN | Capability model (text/media/buttons/threads) | T1, T2 |
| **`channel-telegram`** | Telegram adapter. | `openclaw/.../channels/plugins/telegram*` | CHN | Long polling vs webhook | T1, T2, T3 |
| **`channel-slack`** | Slack adapter. | `openclaw/.../channels/plugins/slack*` | CHN | Socket mode; Block Kit | T1, T2, T3 |
| **`channel-discord`** | Discord adapter. | `openclaw/.../channels/plugins/discord*` | CHN | Slash command interop | T1, T2, T3 |
| **`channel-whatsapp`** | WhatsApp adapter (cloud API + linked devices). | `openclaw/.../channels/plugins/whatsapp*` | CHN | Cloud API vs Business | T1, T2, T3 |
| **`channel-signal`** | Signal adapter. | `openclaw/.../channels/plugins/signal*` | CHN | Signal-CLI integration | T1, T2, T3 |
| **`channel-bluebubbles`** | iMessage via BlueBubbles. | `openclaw/.../channels/plugins/bluebubbles*` | CHN | Mac dependency | T1, T2, T3 |
| **`channel-imessage-native`** | Native macOS iMessage. | `openclaw/.../channels/plugins/imessage*` | CHN | AppleScript bridge | T1, T2, T3 |
| **`channel-email`** | Email (IMAP/SMTP). | TBD ref | CHN, BATCH | Threading; reply-to | T1, T2 |
| **`channel-sms`** | SMS via Twilio/Vonage. | TBD ref | CHN | Length splits | T1, T2 |
| **`channel-web`** | Web chat widget. | `openclaw/.../channels/web/`; `openclaw/.../canvas-host/` | CHN | Streaming over WS | T1, T2, T3 |
| **`channel-transport`** | Stall watchdog, retries, batching. | `openclaw/.../channels/transport/` | CHN | Watchdog timeouts | T1, T7 |
| **`channel-binding`** | Session ↔ channel-conversation mapping. | `openclaw/bindings/` | CHN | Identity collisions | T1, T3 |
| **`channel-router`** | Outbound message routing (which channel for which session). | `openclaw/routing/` | CHN | Fallback/preferences | T1, T3 |
| **`channel-features`** | Cross-channel features (typing, edit-in-place, mention-gate, allowlist, model-override, debounce, threads). | `openclaw/.../channels/plugins/` features | CHN | Capability-based feature gating | T1, T3 |
| **`directory-adapters`** | Contact/group resolution per channel. | `openclaw/.../channels/plugins/directory-adapters.ts` | CHN | Caching | T1, T3 |
| **`media-payload`** | Per-channel media limits, format conversion, payload framing. | `openclaw/.../channels/plugins/media-limits.ts`,`media-payload.ts` | CHN | Transcoding | T1, T2 |
| **`pairing-flow`** | Device pairing for mobile channels. | `openclaw/pairing/`; `openclaw/.../channels/plugins/pairing.ts` | CHN | UX for QR pairing | T1, T3 |
| **`message-actions`** | Reactions, edits, deletes, inline buttons. | `openclaw/.../channels/plugins/message-actions.ts` | CHN | Per-channel feature matrix | T1, T2 |

### Layer R14 — Scheduling & Background

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`scheduler-cron`** | Cron service: at/every/cron schedules, persistence, run/wake/enqueue. | `openclaw/.../cron/service.ts`,`service/ops.ts`,`types.ts` | CHN, CLI, RES | Drift; missed-fire policy | T1, T7 |
| **`heartbeat-engine`** | Periodic system event for "anything to do?"; HEARTBEAT_OK suppression. | `openclaw/.../cron/heartbeat-policy.ts` | CHN | Suppression logic | T1, T3 |
| **`isolated-agent-runner`** | Run a one-shot agent for cron/heartbeat in own session. | `openclaw/.../cron/isolated-agent/` | CHN | Session reaping | T1, T3 |
| **`session-reaper`** | Cleanup expired/orphaned sessions. | `openclaw/.../cron/isolated-agent/` reaper | CHN, MGD | Eviction policy | T1, T7 |
| **`background-housekeeping`** | Cache eviction, log rotation, FS GC. | `claude-code/.../utils/backgroundHousekeeping.ts` | All | Cadence; pause-resume | T1, T7 |
| **`task-scheduler`** | One-off scheduled tasks. | `openclaw/tasks/`; `mcp__scheduled-tasks` | CHN, CLI, RES | Persistence | T1, T3 |
| **`queue-consumer`** | Pull from queue (SQS/Redis/RabbitMQ/NATS/etc.). | None directly — reference `temporal`/`celery`/`dramatiq` patterns | BATCH | Backend abstraction; ack/nack | T1, T2, T3, T7 |
| **`idempotency-store`** | Track processed message ids; exactly-once-ish semantics. | Common patterns; `temporal` workflow ids | BATCH, CHN | TTL; collision | T1, T7 |
| **`rate-limiter`** | Token-bucket / leaky-bucket outbound limiting per provider/tool. | Common patterns | All except EVAL | Per-tenant fairness | T1, T7 |
| **`retry-policy`** | Backoff strategies (exp/jitter/circuit-breaker). | `agent-framework/.../_retry.py`; common patterns | All | Failure taxonomy | T1, T7 |
| **`dead-letter-queue`** | Quarantine failed items. | Common patterns | BATCH, CHN | Replay UX | T1, T3, T7 |
| **`batch-progress-tracker`** | Track batch progress for long-running jobs. | None — design | BATCH, RES | Reporting cadence | T1, T3 |

### Layer R15 — Telemetry, Tracing, Eval

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`telemetry-engine`** | Structured logging, metrics, OpenTelemetry spans. | `agent-framework/.../observability.py`,`_telemetry.py`; `openai-agents/.../tracing/`; `openclaw/logging/`; `claude-code/.../services/internalLogging.ts`; `haystack/.../tracing/` | All | Span vocabulary; sampling | T1, T7 |
| **`otel-exporter`** | OTLP exporter to backends (Jaeger/Honeycomb/DataDog/Azure Monitor/Cloud Trace). | `agent-framework/.../observability.py`; `AI-Harness-Systems.md` §OTel | All | Backend matrix | T1, T2 |
| **`trace-recorder`** | Persist spans/traces locally (replay, grading). | `openai-agents/tracing/`; `agent-framework/.../foundry/` traces | All | Storage size; rotation | T1, T7 |
| **`metrics-collector`** | Counters, histograms, p50/p95 latency, error rate, cost. | `agent-framework/.../observability.py` | All | Dimension cardinality | T1, T7 |
| **`replay-engine`** | Deterministic replay of recorded runs (fixtures + traces). | `dspy/cache.py`; `openai-agents/.../tracing/` replay | EVAL, CLI, CHN, all CI | Determinism boundaries | T1, T4 |
| **`eval-service`** | Run eval suites: dataset → run → grade → report. | `dspy/.../evaluate/`; `helm/benchmark/`; `lm-evaluation-harness/lm_eval/.../evaluator.py`; `ragas/.../evaluation.py`; `haystack/.../evaluation/`; `crewAI/.../experimental/` evals; `adk-python/.../evaluation/` | EVAL, MGD, GRPH (CI), RES | Suite composition; threshold gating | T1, T3, T5 |
| **`dataset-registry`** | Dataset abstractions, loaders, splits, golden sets. | `helm/benchmark/scenarios/`; `lm-evaluation-harness/lm_eval/tasks/`; `dspy/.../datasets/`; `ragas/.../dataset.py`,`testset/` | EVAL | Split semantics | T1, T2 |
| **`grader-registry`** | Pluggable graders (exact-match/llm-judge/ragas-faithfulness/custom). | `helm/.../metrics/`; `lm-evaluation-harness/lm_eval/api/metrics.py`; `dspy/.../evaluate/metrics.py`; `ragas/metrics/`; OpenAI graders | EVAL | Composition; calibration | T1, T5 |
| **`benchmark-runner`** | Multi-task benchmark orchestration. | `helm/benchmark/`; lm-evaluation-harness runner | EVAL | Reproducibility | T1, T7 |
| **`trajectory-grading`** | Grade tool choices / handoffs / approvals / safety on full trajectory. | `AI-Harness-Systems.md` §trace grading; `openclaw/trajectory/`; OpenAI trace grading | EVAL, MGD, RES | Step-level vs run-level | T1, T6 |
| **`canary-router`** | Live A/B traffic split for runtime comparison. | `AI-Harness-Systems.md` §canary | MGD | Routing strategies | T1, T3 |
| **`prompt-optimizer`** | DSPy-style automatic prompt optimization (MIPRO, BootstrapFewShot). | `dspy/.../teleprompt/`,`dspy/.../predict/`,`dspy/.../optimization/`; `adk-python/.../optimization/` | EVAL, CLI (advanced) | Optimizer choice; budget | T1, T5 |
| **`cost-attribution`** | Attribute cost across run/agent/tool/tenant. | `AI-Harness-Systems.md` §cost | All | Dimension model | T1, T7 |

### Layer R16 — UI / TUI / Voice / Media

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`tui-runtime`** | Terminal UI (React/Ink): REPL, message rendering, input, modals. | `claude-code/main.tsx`,`screens/`,`components/`,`ink/`; `openclaw/tui/`,`terminal/` | CLI, CHN | Render perf; modal stack | T1, T3 |
| **`tui-keybindings`** | Customizable keybindings (chord support). | `claude-code/.../keybindings/`; `~/.claude/keybindings.json` | CLI | Chord parser | T1, T9 |
| **`repl-launcher`** | Launch interactive REPL or headless print. | `claude-code/.../replLauncher.tsx`,`main.tsx`; `openai-agents/.../repl.py` | CLI | Mode detection | T1, T3 |
| **`web-ui`** | Web client for the harness (DevUI / Studio runtime view). | `agent-framework/.../devui/`; OpenAI Agent Builder; LangSmith Studio | CHN, MGD, studio | Streaming over WS | T1, T3 |
| **`gateway-server`** | HTTP+WebSocket+JSON-RPC server (App Server). | `openclaw/gateway/`; OpenAI Codex App Server JSON-RPC; `claude-code/.../server/`; `agent-framework/.../foundry_hosting/` | CHN, MGD, BATCH | Auth; rate limit | T1, T2, T7, T8 |
| **`gateway-protocol`** | Wire protocol (REST routes, WS messages, JSON-RPC methods). | `openclaw/.../gateway/protocol/`; OpenAI App Server protocol | CHN, MGD | Versioning | T1, T2 |
| **`voice-runtime`** | Realtime voice loop (audio in/out, VAD, speech sessions). | `claude-code/voice/`; `openai-agents/.../voice/`,`realtime/`; `openclaw/realtime-voice/` | VOICE | Provider abstraction | T1, T2, T7 |
| **`vad-engine`** | Voice activity detection. | OpenAI Realtime VAD; `webrtcvad`; Silero VAD | VOICE | Latency vs accuracy | T1, T5, T7 |
| **`barge-in-controller`** | Handle user interruption mid-speech. | `openai-agents/.../realtime/`; common voice agent patterns | VOICE | Cancel + roll-back | T1, T3 |
| **`audio-stream`** | Audio I/O streaming (PCM/Opus); buffering. | OpenAI Realtime; common patterns | VOICE | Codec; framing | T1, T2, T7 |
| **`call-session`** | Call lifecycle: ring/answer/hold/transfer/hangup. | Twilio Voice; Vonage; Agora | VOICE | State machine | T1, T3 |
| **`telephony-adapter`** | Telephony provider integration (Twilio/Vonage/Plivo/SIP). | TBD ref | VOICE | SIP vs HTTP webhook | T1, T2, T3 |
| **`dtmf-handler`** | DTMF (keypress) handling. | Twilio Voice docs | VOICE | Detection threshold | T1, T2 |
| **`prosody-controller`** | Voice/speed/pause/SSML directives. | `openclaw/.../tts/directives.ts` | VOICE, CHN | SSML support | T1, T2 |
| **`media-service`** | Image/audio/video handling, thumbnails, format conversion. | `openclaw/media/`,`media-understanding/`; `openclaw/.../agents/tool-images.ts` | CHN, CRW, VOICE | Codec matrix | T1, T2, T7 |
| **`canvas-host`** | Canvas/A2UI rich-content surface server. | `openclaw/canvas-host/`; `agent-framework/.../ag_ui/` | CHN | Widget vocabulary | T1, T2, T3 |
| **`notifications-service`** | Cross-app notifications (system tray, OS, push). | `claude-code/.../services/notifier.ts`,`hooks/notifs/` | CLI, CHN, RES, BATCH | OS abstraction | T1, T3 |

### Layer R17 — Infrastructure & Cross-Cutting

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`config-loader`** | YAML/JSON/TS config loading, schema, env-var expansion, overlays. | `openclaw/config/`; `claude-code/.../services/settingsSync/`; `agent-framework/.../_settings.py` | All | Layered merge | T1, T9 |
| **`settings-sync`** | Multi-source settings merge (project/user/enterprise/policy). | `claude-code/.../services/settingsSync/`,`remoteManagedSettings/`,`policyLimits/` | CLI, CHN, MGD | Precedence rules | T1, T3 |
| **`i18n`** | Internationalization, locale, translations. | `openclaw/i18n/`; `crewAI/translations/` | CHN, VOICE | Locale negotiation | T1, T9 |
| ✅ **`logging`** | Structured logger interface. | `openclaw/logging/`; `claude-code/.../services/internalLogging.ts`; `haystack/logging.py` | All | Field schema | T1 |
| ✅ **`error-types`** | Typed error hierarchy, classification. | `openclaw/.../infra/errors/`; `agent-framework/.../exceptions.py`; `haystack/errors.py` | All | Recovery hint mapping | T1 |
| ✅ **`infra-utils`** | Common: paths, env, fs, json, retry, time, ids. | `openclaw/.../infra/`,`shared/`,`utils/`; `claude-code/.../utils/`; `agent-framework/.../utils/` | All | API stability | T1 |
| **`feature-flags`** | Build-time + runtime flags (dead-code elimination). | `claude-code/main.tsx` `bun:bundle feature()` pattern | All | Build-time elim | T1 |
| **`runtime-migrations`** | Versioned runtime data migrations. | `claude-code/.../migrations/` | All | Forward/back migrations | T1, T4 |
| **`daemon-process`** | Long-running process manager, IPC, supervisor. | `openclaw/daemon/` | CHN, BATCH | Crash recovery | T1, T7 |
| **`node-host`** | Multi-host execution (run agent on phone/server/laptop). | `openclaw/node-host/`,`pairing/` | CHN | Cross-host RPC | T1, T3 |
| **`proxy-capture`** | HTTP proxy for capturing/replaying tool traffic. | `openclaw/.../proxy-capture/`; `openclaw/.../security/proxy-server.ts` | EVAL, CLI | Cert installation | T1, T8 |
| **`bootstrap-runtime`** | First-run trust prompts, telemetry consent, settings init. | `claude-code/main.tsx` `init()`; `openclaw/bootstrap/` | CLI, CHN, VOICE | Consent flows | T1, T3 |
| **`startup-profiler`** | Startup-time profiling, deferred prefetches, eager loads. | `claude-code/main.tsx` `profileCheckpoint()`,`startDeferredPrefetches()` | CLI, CHN | Critical path | T1, T7 |
| **`update-channel`** | Auto-update / version channel selection. | `claude-code/.../utils/autoUpdater.ts`; `claude-code/.../utils/binaryCheck.ts` | CLI | Channel semantics | T1, T3 |
| **`tenancy`** | Multi-tenant isolation (tenant-id, quotas, billing). | `AI-Harness-Systems.md` §`tenant_id`; AgentCore tenant model | MGD | Quota model | T1, T3, T8 |
| **`audit-log`** | Tamper-evident audit trail (separate from event log). | AWS AgentCore observability; `openclaw/.../security/audit*.ts` | MGD | Signing; rotation | T1, T8 |

### Layer R18 — Specialized / Advanced

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`computer-use-driver`** | Mouse/keyboard/screenshot drivers. | `mcp__computer-use__*`; OpenAI Operator | BROW, CLI | Cross-OS abstraction | T1, T2, T3 |
| **`browser-extension-bridge`** | Bridge to browser extension MCP. | `mcp__Claude_in_Chrome__*` | BROW, CLI | Extension lifecycle | T1, T2, T3 |
| **`lsp-host`** | LSP client for code-tools. | `claude-code/.../services/lsp/` | CLI | Server pooling | T1, T2, T3 |
| **`sandbox-fs-overlay`** | Copy-on-write workspace for safe edits + rollback. | `openai-agents/.../sandbox/files.py`; `openclaw/.../scripts/` worktree | CLI, EVAL | Diff materialization | T1, T3 |
| **`structured-output-tools`** | Tools that emit typed structured output (graders, classifiers). | `dspy/.../predict/`; `claude-code/.../tools/SyntheticOutputTool` | EVAL, MGD | Schema reuse | T1, T2 |
| **`autoplan-engine`** | Plan-then-act: dedicated planning model produces plan consumed by executor. | `gstack-main/.../autoplan/`; `claude-code/.../tools/EnterPlanModeTool` | CLI, CRW, RES | Plan format | T1, T6 |
| **`auto-classifier`** | Content classifier (`yoloClassifier`). | `claude-code/.../utils/permissions/yoloClassifier.ts` | CLI, CHN | Calibration | T1, T5 |
| **`fingerprint`** | Run/agent fingerprinting (deterministic build IDs, content-hashes). | `crewAI/.../security/fingerprint.py`; `claude-code/.../utils/attribution.ts` | EVAL, MGD | Hash granularity | T1, T4 |
| **`activity-manager`** | Track user/idle/active state for UI hints, away-summaries. | `claude-code/.../utils/activityManager.ts`,`awaySummary.ts` | CLI, CHN | Idle thresholds | T1, T3 |
| **`speculation-cache`** | Cached predictions for speculative execution. | `claude-code/.../state/AppStateStore.ts` `speculation` | CLI | Hit rate | T1, T7 |
| **`commitments-engine`** | Track agent commitments/promises across sessions. | `openclaw/commitments/` | CHN | Promise schema | T1, T3 |

### Layer R19 — Research-Agent Specific

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`research-planner`** | Decompose research goal into ordered sub-questions; revise plan as evidence accrues. | `gstack-main/autoplan/`; `claude-code/.../tools/EnterPlanModeTool`; ADK research flows | RES | Plan revision policy | T1, T5, T6 |
| **`crawler`** | Autonomous multi-page web crawl beyond simple fetch (frontier, dedup, polite). | `llama_index/.../readers/` web; common crawler patterns | RES, RAG | Politeness; cycle detection | T1, T3, T7 |
| **`branch-explorer`** | Explore multiple research branches in parallel; rank/prune. | `langgraph` branching; subagent fan-out | RES | Branch budget; ranking | T1, T3, T6 |
| **`evidence-store`** | Accumulate evidence with metadata (source, timestamp, claim, support level). | `agent-framework/.../citations/`; KG-style stores | RES, RAG | Dedup; conflict resolution | T1, T5 |
| **`report-synthesizer`** | Compose long-form structured report from evidence (markdown/PDF/docx). | `anthropic-skills:docx`; `anthropic-skills:pdf`; `dspy/.../predict/` long-form | RES | Outline generation; section budgeting | T1, T5, T6 |
| **`progress-streamer`** | Long-run progress reporting (since runs can be hours). | None directly — design | RES, BATCH | Reporting cadence | T1, T3 |
| **`research-checkpointer`** | Stage-level checkpoints for hours-long runs (resume after crash/preempt). | `agent-framework/.../_checkpoint.py` (ref); `langgraph` durability | RES | Stage granularity | T1, T4, T7 |
| **`source-quality-scorer`** | Score source credibility (domain authority, recency, citations). | TBD; common search QA patterns | RES, RAG | Score model | T1, T5 |

### Layer R20 — Batch-Worker Specific

| Module | Responsibility | Refs | Targets | Research focus | Tests |
|---|---|---|---|---|---|
| **`batch-runner`** | Drive worker loop: pull → process → ack → repeat. | `temporal`/`celery`/`dramatiq` patterns | BATCH | Concurrency; back-off | T1, T3, T7 |
| **`batch-job-spec`** | Per-item job spec (input schema, output schema, timeout, retries). | None directly | BATCH | Schema design | T1, T2 |
| **`fan-out-fan-in`** | Split a large job into many tasks; aggregate results. | `agent-framework/.../orchestrations/`; `temporal` workflows | BATCH, CRW | Aggregation guarantees | T1, T3, T7 |
| **`output-sink`** | Write results to destination (DB / S3 / file / webhook). | TBD | BATCH | Sink abstraction | T1, T2, T3 |
| **`batch-eval-loop`** | Tie batch worker to eval-service for online metric tracking. | `eval-service` | BATCH, EVAL | Metric streaming | T1, T5 |

---

# PART C — Module Group Aggregations (coarse composition)

For ergonomic spec authoring, expose grouped bundles so users can compose at a coarser level. Each group is a stable selector that pulls in its constituent modules with sensible defaults.

| Group | Includes | When to enable |
|---|---|---|
| **Tool Layer (full)** | tool-catalog · tool-builder · tool-orchestrator · tool-executor · streaming-tool-executor · tool-result-store · tool-loop-detection · tool-search · tool-display · tool-permission-matcher · tool-validate | Any agent that calls tools |
| **MCP Bundle** | mcp-host · tool-mcp · mcp-server-host (optional) | Agents needing external/portable tools |
| **Compaction Stack** | compaction-snip · microcompact · context-collapse · autocompact · reactive · tool-result-budget · session-memory | Long-running chat/agent harnesses |
| **Permission Stack** | permission-engine · approval-classifier · denial-tracking · policy-engine · safety-prompt-injector · guardrails · prompt-injection-detector · pii-redactor | Production-grade safety |
| **Observability Stack** | telemetry-engine · otel-exporter · trace-recorder · metrics-collector · replay-engine · cost-tracker · cost-attribution · audit-log | Any production deployment |
| **Eval Stack** | eval-service · dataset-registry · grader-registry · benchmark-runner · trajectory-grading · prompt-optimizer · replay-engine | EVAL target or CI for any target |
| **Channel Stack** | channel-registry · channel-adapter-base · channel-{telegram,slack,discord,whatsapp,signal,bluebubbles,imessage-native,email,sms,web} · channel-transport · channel-binding · channel-router · channel-features · directory-adapters · media-payload · pairing-flow · message-actions | Channel-based assistants |
| **Scheduling Stack** | scheduler-cron · heartbeat-engine · isolated-agent-runner · session-reaper · task-scheduler · background-housekeeping | Always-on assistants |
| **Multi-Agent Stack** | subagent-runtime · coordinator · swarm-runtime · handoff-engine · role-system · task-engine · pairing-engine | Crews / supervised agents |
| **State & Persistence Stack** | session-store · event-log · checkpoint-store · state-store · app-state-store · branch-history · artifact-store · session-router · session-binding · replay-store | All harnesses (subset minimum) |
| **RAG Stack** | document-store · embedding-adapter · retriever · ranker · reader-extractor · query-router · generator · document-loader · chunker · knowledge-graph · ingestion-pipeline · citation-tracker · vector-store | Retrieval-heavy harnesses |
| **CLI Front-end Stack** | tui-runtime · tui-keybindings · repl-launcher · spec-cli · slash-commands · output-styles · skills-{registry,serializer} · hooks-engine | CLI coding agent |
| **Channel Front-end Stack** | gateway-server · gateway-protocol · channel stack · daemon-process · node-host · web-ui · canvas-host · voice-runtime (optional) · notifications-service · pairing-flow | Channel assistant |
| **Memory Stack** | memory-service · memory-extraction · personalization-store · bootstrap-files · system-prompt-builder · vector-store | Stateful long-horizon agents |
| **Voice Stack** | voice-runtime · vad-engine · barge-in-controller · audio-stream · call-session · telephony-adapter · dtmf-handler · prosody-controller · tool-tts-stt | Voice/telephony harnesses |
| **Computer-Use Stack** | computer-use-driver · browser-extension-bridge · tool-screen-capture · tool-mouse-keyboard · tool-vision-grounding · tool-dom-inspector · tool-browser | Browser/desktop driving harnesses |
| **Research Stack** | research-planner · crawler · branch-explorer · evidence-store · report-synthesizer · progress-streamer · research-checkpointer · source-quality-scorer · citation-tracker · autoplan-engine | Long-horizon research agents |
| **Batch Stack** | batch-runner · batch-job-spec · queue-consumer · idempotency-store · rate-limiter · retry-policy · dead-letter-queue · batch-progress-tracker · fan-out-fan-in · output-sink · batch-eval-loop | Queue/batch workers |

---

# PART D — Mapping: Module → Target Shape Requirements

Condensed which-shapes-need-what so the compiler can pick a base set per target.

| Shape | Always-on layers | Frequently-on | Rarely needed |
|---|---|---|---|
| **CLI** | Runtime Core, Tool Layer, Tool Impls (fs/bash/web), Permission, Compaction, State, Telemetry, MCP, Hooks, Skills, Slash, TUI, Bootstrap | Subagent, Coordinator, Swarm, LSP, Worktree, Plan-mode, Replay, Voice (light) | Channels, RAG, Eval (CI only), Pipeline engine |
| **CHN** | Runtime Core, Tool Layer (light), Permission, Compaction, State, Telemetry, MCP, Hooks, Channels, Scheduling, Gateway, Memory, Auto-reply | Subagent, Voice, Media, Skills, Slash, Browser, Web, ACP | RAG (unless KB), Eval, Pipeline, LSP |
| **CRW** | Runtime Core, Tool Layer, Multi-Agent (roles/handoff/coordinator/tasks), Workflow Engine, State, Telemetry, Permission, Hooks, Memory | Channels (out), MCP, A2A, Subagent, Knowledge | TUI, Voice, Pairing, Cron, Media |
| **RAG** | Pipeline Engine, RAG Stack, Telemetry, Eval (light), Model Layer, State (light) | Tool Layer (limited), MCP, Workflow Engine, Memory | Channels, Permission (full), TUI, Voice, Cron, Multi-agent |
| **EVAL** | Eval Stack, Dataset Registry, Grader Registry, Benchmark Runner, Replay, Telemetry, Model Layer | Sandbox, Tool Layer, Pipeline Engine, Trajectory Grading, Prompt Optimizer | Channels, TUI, Cron, Multi-agent (unless evaluating crews), Hooks |
| **MGD** | Runtime Core, Tool Layer, Permission, Policy, Telemetry, Checkpoint, Audit, Tenancy, MCP, A2A, Gateway, OTel, Sandbox | Workflow Engine, Graph Engine, HITL, Eval, Multi-agent, Memory, Canary, Durable Execution | TUI, Channels (often), Voice, Cron (often) |
| **GRPH** | Graph Engine, Checkpoint Store, Branch History, Durable Execution, Runtime Core, State, Telemetry, HITL, Recovery | Tool Layer, Permission, Memory, Replay, Eval, Subagent | TUI, Channels, Voice, Cron, RAG (unless knowledge node), Pipeline engine |
| **RES** | Research Stack, Runtime Core, Tool Layer, Web tools, Compaction, Memory, Citation, Checkpoint, Telemetry | Subagent, Browser, Branch-Explorer, Skill, Eval (online), Workflow Engine | Channels, TUI, Voice, Pipeline engine |
| **VOICE** | Voice Stack, Runtime Core, Telemetry, Channels (telephony), Permission (light), State (call-shaped) | Memory, Skills, Tool Layer (limited) | TUI, RAG, Eval, Browser/Computer-use, Multi-agent |
| **BROW** | Computer-Use Stack, Tool Layer (limited), Runtime Core, Telemetry, Sandbox | MCP, Subagent, Memory, Eval (replay) | Channels, RAG, Voice, TUI, Cron |
| **BATCH** | Batch Stack, Runtime Core, Telemetry, Permission, Tool Layer (specific to job), State (job-shaped) | Sandbox, MCP, Eval (online), Memory, Multi-agent | TUI, Channels (unless notification), Voice, Browser |

---

# PART E — Cross-Cutting IR-Level Switches

These shape multiple modules and must surface as explicit spec-level options. The compiler reads these to select/configure runtime modules.

1. **Durability mode** (`exit | async | sync | none`) — drives `checkpoint-store`, `durability-mode`, `event-log` flush policy.
2. **Streaming mode** (`pull | push | none`) — drives `stream-runtime`, `gateway-protocol`, `tui-runtime`.
3. **Permission mode** (`default | plan | auto | bypass`) — drives `permission-engine`, `approval-classifier`, `hitl-engine`.
4. **Compaction policy** (`summary-plus-artifacts | snip-only | tool-result-only | full-stack`) — drives compaction-stack composition.
5. **Runtime topology** (`graph | workflow | pipeline | conversation | managed | batch | research`) — selects engine module + IR target.
6. **Multi-agent topology** (`single | central | decentralized | none`) — coordinator vs swarm.
7. **Deployment profile** (`local | self-hosted | managed | hybrid`) — drives `deployment-controller`, `secrets-manager`, `tenancy`.
8. **Channel set** (`none | one | multi`) — drives the channel stack inclusion.
9. **Eval class** (`offline | online | trace-graded | none`) — drives eval-stack composition.
10. **Tool profile** (`minimal | coding | messaging | rag | research | batch | full`) — drives `tool-catalog` filtering.
11. **Voice mode** (`none | tts-only | full-realtime | telephony`) — drives voice-stack inclusion.
12. **Vision mode** (`none | multimodal-input | screen-driver`) — drives computer-use-stack and media-service.
13. **Compute envelope** (`local-process | container | sandbox-vm | edge-device`) — drives `sandbox`, `node-host`, `bundle-packager`.

---

# PART F — Anti-Patterns to Bake In as Constraints

The factory should *prevent* these by design, drawn from the architecture studies:

1. **God-function system prompt** (OpenClaw's 720-line `system-prompt.ts`). `system-prompt-builder` must be section-composable with token budget per section.
2. **Tool description double-counting** (OpenClaw embeds tool descs in prose AND tool schemas). Pick one channel.
3. **Channel-specific guidance leaking into non-channel sessions**. Sections must be gated by active modules.
4. **Backward-compat proxy bloat** (OpenClaw context-engine 200-line sessionKey compat). `migration-engine` produces clean rewrites, not runtime adapters.
5. **Monolithic agent directories** (OpenClaw's 280-file `agents/`). Codegen splits outputs into the layer groups defined here.
6. **No token-budget awareness in prompt assembly**. `prompt-cache-manager` and `system-prompt-builder` enforce budgets.
7. **Heartbeat sending full prompt every tick** (OpenClaw default). `heartbeat-engine` defaults to lightweight bootstrap.
8. **Random temp-file paths breaking prompt cache**. Use content-hash paths (Claude Code pattern).
9. **Ad-hoc subagent context filtering**. `subagent-runtime` exposes a documented context filter API.
10. **Eval as a dashboard afterthought**. `eval-service` is first-class and gates deployment.

---

# PART G — Module-build dependency order (rough)

Phases for implementation sequencing. Earlier phases unblock later ones.

1. **Foundations** — `infra-utils`, `error-types`, `logging`, `config-loader`, `state-store`, `global-state-singleton`, `feature-flags`, `runtime-migrations`.
2. **IR & Compiler** — `spec-schema`, `spec-parser`, `spec-validator`, `ir-model`, `ir-passes`, `migration-engine`, `compiler-core`, `bundle-packager`.
3. **Model & Tool primitives** — `model-adapter`, `model-router`, `token-budget`, `prompt-cache-manager`, `auth-profiles`, `secrets-manager`, `tool-catalog`, `tool-builder`, `tool-validate`, `tool-permission-matcher`.
4. **Runtime core** — `runtime-orchestrator`, `query-engine`, `turn-state-machine`, `recovery-engine`, `stream-runtime`, `abort-controller`, `scheduler`, `run-context`.
5. **Tool execution** — `tool-orchestrator`, `tool-executor`, `streaming-tool-executor`, `tool-result-store`, `tool-loop-detection`, `tool-search`, `tool-display`.
6. **State & persistence** — `session-store`, `event-log`, `checkpoint-store`, `app-state-store`, `branch-history`, `artifact-store`.
7. **Permission/policy** — `permission-engine`, `policy-engine`, `safety-prompt-injector`, `guardrails`, `hitl-engine`, `approval-classifier`, `denial-tracking`, `pii-redactor`, `prompt-injection-detector`.
8. **Context & memory** — `context-engine`, compaction stack, `bootstrap-files`, `system-prompt-builder`, `memory-service`, `vector-store`, `embedding-adapter`.
9. **Telemetry & eval** — `telemetry-engine`, `otel-exporter`, `trace-recorder`, `metrics-collector`, `replay-engine`, `cost-tracker`, `eval-service`, `dataset-registry`, `grader-registry`, `benchmark-runner`, `trajectory-grading`, `prompt-optimizer`.
10. **MCP/protocol** — `mcp-host`, `mcp-server-host`, `webhook-host`, `a2a-protocol`, `acp-protocol`, `ag-ui-protocol`.
11. **Built-in tool implementations** — `tool-fs`, `tool-bash`, `tool-process`, `tool-code-execution`, `tool-web-*`, `tool-mcp`, `tool-todo`, `tool-skill`, `tool-ask-user`, `tool-cron`, `tool-task`, `tool-team`, `tool-agent`, `tool-message-channel`, `tool-memory`, `tool-plan-mode`, `tool-worktree`, `tool-lsp`, `tool-monitor`, `tool-sleep`, `tool-notebook-edit`, `tool-notification`, `tool-remote-trigger`, `tool-canvas`, `tool-citations`, `tool-screen-capture`, `tool-mouse-keyboard`, `tool-vision-grounding`, `tool-dom-inspector`.
12. **Multi-agent & engines** — `subagent-runtime`, `coordinator`, `swarm-runtime`, `handoff-engine`, `role-system`, `task-engine`, `graph-engine`, `workflow-engine`, `pipeline-engine`, `durable-execution`, `event-bus`, `checkpoint-encoder`.
13. **Hooks/skills/commands** — `hooks-engine`, `hook-loader`, `skills-registry`, `skills-serializer`, `slash-commands`, `output-styles`.
14. **RAG layer** — `document-store`, `retriever`, `ranker`, `reader-extractor`, `query-router`, `generator`, `document-loader`, `chunker`, `knowledge-graph`, `ingestion-pipeline`, `citation-tracker`.
15. **Channels** — `channel-registry`, `channel-adapter-base`, individual `channel-*`, `channel-transport`, `channel-binding`, `channel-router`, `channel-features`, `directory-adapters`, `media-payload`, `pairing-flow`, `message-actions`, `gateway-server`, `gateway-protocol`.
16. **Scheduling** — `scheduler-cron`, `heartbeat-engine`, `isolated-agent-runner`, `session-reaper`, `task-scheduler`, `background-housekeeping`, `queue-consumer`, `idempotency-store`, `rate-limiter`, `retry-policy`, `dead-letter-queue`, `batch-progress-tracker`.
17. **UI/TUI/Voice/Media** — `tui-runtime`, `tui-keybindings`, `repl-launcher`, `web-ui`, `voice-runtime`, `vad-engine`, `barge-in-controller`, `audio-stream`, `call-session`, `telephony-adapter`, `dtmf-handler`, `prosody-controller`, `media-service`, `canvas-host`, `notifications-service`.
18. **Deployment & studio** — `deployment-controller`, `deployment-profiles`, `canary-controller`, `migration-runner`, `upgrade-controller`, `studio-ui`, `studio-server`, `trace-viewer`, `graph-visualizer`, `spec-cli`, `wizard`, `scaffold-templates`.
19. **Plugin SDK** — `plugin-sdk`, `plugin-registry`, `plugin-loader`, `module-marketplace`.
20. **Specialized + per-shape final modules** — research stack, batch stack, computer-use stack, voice-specific extras.

---

# PART H — Verification

End-to-end tests for the catalog itself (independent of any single module):

1. **Catalog completeness check** — for each of the 11 target shapes, build a "canonical example spec" and verify the compiler picks a non-empty, type-checked module set covering all required layers from PART D.
2. **Shape coverage matrix** — automated test that confirms every required layer × shape cell has at least one module that satisfies it, by walking PART D against PART B.
3. **Reference reproduction** — produce minimal harnesses that mimic Claude Code (CLI), OpenClaw (CHN), Haystack RAG (RAG), and verify generated modules map onto the originals' module list (≥80% overlap of layer-coverage).
4. **Cross-cutting switch matrix** — for each PART E switch, assert at least one IR pass adjusts module selection accordingly.
5. **Anti-pattern lint** — codegen lint that fails when an output violates a PART F constraint (e.g. `system-prompt-builder` produces a single string > N tokens; `subagent-runtime` invocation lacks a context filter spec).
6. **Per-module test plan present** — every module entry has at least one applicable test layer from T1–T9 (this plan asserts that, and a CI lint maintains it as modules evolve).

---

# PART I - Module Briefs

One-page build briefs now live in [`docs/module-briefs/README.md`](module-briefs/README.md).
They follow the dependency order from PART G, expand shorthand entries such as
`tool-web-*`, `channel-*`, and the named stacks, and include catalog modules that
PART G implies by layer but does not name directly.

---

## Critical files for implementation reference

- `docs/AI-Harness-Systems.md` — IR schema, reference architecture, test layers, deployment profiles, OTel dimensions, cross-cutting tradeoffs.
- `docs/architecture studies/openclaw-architecture.md` — channel, cron, skills, context-engine, plugin patterns; tool catalog + profiles; system-prompt anti-patterns.
- `docs/architecture studies/cc-architecture.md` — Tool interface + buildTool; query loop; multi-layer compaction; permission system; streaming; subagents.
- `reference-repos/claude-code/src/Tool.ts` — Tool interface contract.
- `reference-repos/claude-code/src/query.ts` — async-generator agent loop reference.
- `reference-repos/claude-code/src/services/compact/` — multi-layer compaction reference.
- `reference-repos/claude-code/src/utils/permissions/` — layered permission system.
- `reference-repos/openclaw/src/context-engine/` — pluggable context-engine interface.
- `reference-repos/openclaw/src/cron/` — cron + heartbeat + isolated-agent.
- `reference-repos/openclaw/src/channels/plugins/` — channel adapter pattern.
- `reference-repos/agent-framework/python/packages/core/agent_framework/_workflows/_workflow_builder.py` — declarative workflow IR + builder.
- `reference-repos/langgraph/libs/langgraph/langgraph/pregel/` — Pregel-style stateful graph runtime.
- `reference-repos/haystack/haystack/core/` — pipeline + component decorator pattern.
- `reference-repos/dspy/dspy/teleprompt/` — prompt program optimization.
- `reference-repos/lm-evaluation-harness/lm_eval/evaluator.py` — benchmark runner.
- `reference-repos/ragas/src/ragas/evaluation.py` — RAG-specific evaluation.
- `reference-repos/openai-agents-python/src/agents/` — handoffs, guardrails, sessions, voice, realtime.

---

## Module count summary

- **Factory-level**: ~35 modules across F1–F5
- **Runtime composable**: ~155 modules across R1–R20
- **Total**: ~190 modules (exceeds the 120–150 target — pruning will happen as similar adjacent modules collapse during specing; this catalog errs comprehensive)
- **Grouped bundles**: 18 coarse aggregations in PART C for ergonomic spec authoring

Each module has a research focus pointing to specific files in `reference-repos/` and a test layer assignment from T1–T9. The next phase is to write a one-page module brief for each entry, in dependency order from PART G.
