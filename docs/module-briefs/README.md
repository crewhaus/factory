# Module Briefs

These briefs continue [`docs/MODULE-CATALOG.md`](../MODULE-CATALOG.md) by turning the catalog rows into one-page build briefs. The order follows the historical build-phase sequencing (Foundations → IR & Compiler → Model & Tool primitives → Runtime core → …); shorthand entries such as `tool-web-*`, `channel-*`, and named stacks are expanded to concrete modules. Catalog rows that are not named directly in the build phases are included in the phase implied by their layer.

Each brief is intentionally compact: purpose, boundary, inputs/outputs, first slice, and validation plan. The catalog remains the source of truth for the complete matrix.

## Phase 1: Foundations

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 1 | [`infra-utils`](001-infra-utils.md) | implemented and tested | R17 - Infrastructure & Cross-Cutting | named in Part G |
| 2 | [`error-types`](002-error-types.md) | implemented and tested | R17 - Infrastructure & Cross-Cutting | named in Part G |
| 3 | [`logging`](003-logging.md) | implemented and tested | R17 - Infrastructure & Cross-Cutting | named in Part G |
| 4 | [`config-loader`](004-config-loader.md) | planned | R17 - Infrastructure & Cross-Cutting | named in Part G |
| 5 | [`state-store`](005-state-store.md) | planned | R7 - State, Sessions, Persistence | named in Part G |
| 6 | [`global-state-singleton`](006-global-state-singleton.md) | planned | R7 - State, Sessions, Persistence | named in Part G |
| 7 | [`feature-flags`](007-feature-flags.md) | planned | R17 - Infrastructure & Cross-Cutting | named in Part G |
| 8 | [`runtime-migrations`](008-runtime-migrations.md) | planned | R17 - Infrastructure & Cross-Cutting | named in Part G |
| 9 | [`settings-sync`](009-settings-sync.md) | planned | R17 - Infrastructure & Cross-Cutting | inferred from catalog layer R17 |
| 10 | [`i18n`](010-i18n.md) | planned | R17 - Infrastructure & Cross-Cutting | inferred from catalog layer R17 |
| 11 | [`daemon-process`](011-daemon-process.md) | planned | R17 - Infrastructure & Cross-Cutting | inferred from catalog layer R17 |
| 12 | [`node-host`](012-node-host.md) | planned | R17 - Infrastructure & Cross-Cutting | inferred from catalog layer R17 |
| 13 | [`proxy-capture`](013-proxy-capture.md) | planned | R17 - Infrastructure & Cross-Cutting | inferred from catalog layer R17 |
| 14 | [`bootstrap-runtime`](014-bootstrap-runtime.md) | planned | R17 - Infrastructure & Cross-Cutting | inferred from catalog layer R17 |
| 15 | [`startup-profiler`](015-startup-profiler.md) | planned | R17 - Infrastructure & Cross-Cutting | inferred from catalog layer R17 |
| 16 | [`update-channel`](016-update-channel.md) | planned | R17 - Infrastructure & Cross-Cutting | inferred from catalog layer R17 |
| 17 | [`tenancy`](017-tenancy.md) | planned | R17 - Infrastructure & Cross-Cutting | inferred from catalog layer R17 |
| 18 | [`audit-log`](018-audit-log.md) | planned | R17 - Infrastructure & Cross-Cutting | inferred from catalog layer R17 |

## Phase 2: IR & Compiler

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 19 | [`spec-schema`](019-spec-schema.md) | implemented and tested | F1 - Spec & IR | named in Part G |
| 20 | [`spec-parser`](020-spec-parser.md) | implemented and tested | F1 - Spec & IR | named in Part G |
| 21 | [`spec-validator`](021-spec-validator.md) | implemented and tested | F1 - Spec & IR | named in Part G |
| 22 | [`ir-model`](022-ir-model.md) | implemented and tested | F1 - Spec & IR | named in Part G |
| 23 | [`ir-passes`](023-ir-passes.md) | planned | F1 - Spec & IR | named in Part G |
| 24 | [`migration-engine`](024-migration-engine.md) | planned | F1 - Spec & IR | named in Part G |
| 25 | [`compiler-core`](025-compiler-core.md) | implemented and tested | F2 - Compiler & Codegen | named in Part G |
| 26 | [`bundle-packager`](026-bundle-packager.md) | planned | F2 - Compiler & Codegen | named in Part G |
| 27 | [`spec-registry`](027-spec-registry.md) | planned | F1 - Spec & IR | inferred from catalog layer F1 |
| 28 | [`target-graph`](028-target-graph.md) | planned | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 29 | [`target-workflow`](029-target-workflow.md) | planned | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 30 | [`target-pipeline`](030-target-pipeline.md) | planned | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 31 | [`target-managed`](031-target-managed.md) | planned | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 32 | [`target-cli-bundle`](032-target-cli-bundle.md) | implemented and tested | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 33 | [`target-channel-bot`](033-target-channel-bot.md) | planned | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 34 | [`target-eval-bundle`](034-target-eval-bundle.md) | planned | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 35 | [`target-research-bundle`](035-target-research-bundle.md) | planned | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 36 | [`target-voice`](036-target-voice.md) | planned | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 37 | [`target-browser-driver`](037-target-browser-driver.md) | planned | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 38 | [`target-batch-worker`](038-target-batch-worker.md) | planned | F2 - Compiler & Codegen | inferred from catalog layer F2 |
| 39 | [`codegen-templates`](039-codegen-templates.md) | implemented and tested | F2 - Compiler & Codegen | inferred from catalog layer F2 |

## Phase 3: Model & Tool primitives

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 40 | [`model-adapter`](040-model-adapter.md) | implemented and tested | R2 - Model Layer | named in Part G |
| 41 | [`model-router`](041-model-router.md) | planned | R2 - Model Layer | named in Part G |
| 42 | [`token-budget`](042-token-budget.md) | planned | R2 - Model Layer | named in Part G |
| 43 | [`prompt-cache-manager`](043-prompt-cache-manager.md) | planned | R2 - Model Layer | named in Part G |
| 44 | [`auth-profiles`](044-auth-profiles.md) | planned | R2 - Model Layer | named in Part G |
| 45 | [`secrets-manager`](045-secrets-manager.md) | planned | R8 - Permission, Policy, Safety | named in Part G |
| 46 | [`tool-catalog`](046-tool-catalog.md) | implemented and tested | R3 - Tool Layer (core) | named in Part G |
| 47 | [`tool-builder`](047-tool-builder.md) | implemented and tested | R3 - Tool Layer (core) | named in Part G |
| 48 | [`tool-validate`](048-tool-validate.md) | implemented and tested | R3 - Tool Layer (core) | named in Part G |
| 49 | [`tool-permission-matcher`](049-tool-permission-matcher.md) | implemented and tested | R3 - Tool Layer (core) | named in Part G |
| 50 | [`response-format-coercion`](050-response-format-coercion.md) | planned | R2 - Model Layer | inferred from catalog layer R2 |
| 51 | [`reasoning-controller`](051-reasoning-controller.md) | planned | R2 - Model Layer | inferred from catalog layer R2 |
| 52 | [`speculation-engine`](052-speculation-engine.md) | planned | R2 - Model Layer | inferred from catalog layer R2 |

## Phase 4: Runtime core

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 53 | [`runtime-orchestrator`](053-runtime-orchestrator.md) | implemented and tested | R1 - Runtime Core (the agent loop) | named in Part G |
| 54 | [`query-engine`](054-query-engine.md) | planned | R1 - Runtime Core (the agent loop) | named in Part G |
| 55 | [`turn-state-machine`](055-turn-state-machine.md) | planned | R1 - Runtime Core (the agent loop) | named in Part G |
| 56 | [`recovery-engine`](056-recovery-engine.md) | planned | R1 - Runtime Core (the agent loop) | named in Part G |
| 57 | [`stream-runtime`](057-stream-runtime.md) | planned | R1 - Runtime Core (the agent loop) | named in Part G |
| 58 | [`abort-controller`](058-abort-controller.md) | planned | R1 - Runtime Core (the agent loop) | named in Part G |
| 59 | [`scheduler`](059-scheduler.md) | planned | R1 - Runtime Core (the agent loop) | named in Part G |
| 60 | [`run-context`](060-run-context.md) | planned | R1 - Runtime Core (the agent loop) | named in Part G |
| 61 | [`durability-mode`](061-durability-mode.md) | planned | R1 - Runtime Core (the agent loop) | inferred from catalog layer R1 |

## Phase 5: Tool execution

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 62 | [`tool-orchestrator`](062-tool-orchestrator.md) | planned | R3 - Tool Layer (core) | named in Part G |
| 63 | [`tool-executor`](063-tool-executor.md) | implemented and tested | R3 - Tool Layer (core) | named in Part G |
| 64 | [`streaming-tool-executor`](064-streaming-tool-executor.md) | planned | R3 - Tool Layer (core) | named in Part G |
| 65 | [`tool-result-store`](065-tool-result-store.md) | planned | R3 - Tool Layer (core) | named in Part G |
| 66 | [`tool-loop-detection`](066-tool-loop-detection.md) | planned | R3 - Tool Layer (core) | named in Part G |
| 67 | [`tool-search`](067-tool-search.md) | planned | R3 - Tool Layer (core) | named in Part G |
| 68 | [`tool-display`](068-tool-display.md) | planned | R3 - Tool Layer (core) | named in Part G |

## Phase 6: State & persistence

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 69 | [`session-store`](069-session-store.md) | planned | R7 - State, Sessions, Persistence | named in Part G |
| 70 | [`event-log`](070-event-log.md) | planned | R7 - State, Sessions, Persistence | named in Part G |
| 71 | [`checkpoint-store`](071-checkpoint-store.md) | planned | R7 - State, Sessions, Persistence | named in Part G |
| 72 | [`app-state-store`](072-app-state-store.md) | planned | R7 - State, Sessions, Persistence | named in Part G |
| 73 | [`branch-history`](073-branch-history.md) | planned | R7 - State, Sessions, Persistence | named in Part G |
| 74 | [`artifact-store`](074-artifact-store.md) | planned | R7 - State, Sessions, Persistence | named in Part G |
| 75 | [`session-router`](075-session-router.md) | planned | R7 - State, Sessions, Persistence | inferred from catalog layer R7 |
| 76 | [`session-binding`](076-session-binding.md) | planned | R7 - State, Sessions, Persistence | inferred from catalog layer R7 |
| 77 | [`replay-store`](077-replay-store.md) | planned | R7 - State, Sessions, Persistence | inferred from catalog layer R7 |

## Phase 7: Permission/policy

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 78 | [`permission-engine`](078-permission-engine.md) | planned | R8 - Permission, Policy, Safety | named in Part G |
| 79 | [`policy-engine`](079-policy-engine.md) | planned | R8 - Permission, Policy, Safety | named in Part G |
| 80 | [`safety-prompt-injector`](080-safety-prompt-injector.md) | planned | R8 - Permission, Policy, Safety | named in Part G |
| 81 | [`guardrails`](081-guardrails.md) | planned | R8 - Permission, Policy, Safety | named in Part G |
| 82 | [`hitl-engine`](082-hitl-engine.md) | planned | R8 - Permission, Policy, Safety | named in Part G |
| 83 | [`approval-classifier`](083-approval-classifier.md) | planned | R8 - Permission, Policy, Safety | named in Part G |
| 84 | [`denial-tracking`](084-denial-tracking.md) | planned | R8 - Permission, Policy, Safety | named in Part G |
| 85 | [`pii-redactor`](085-pii-redactor.md) | planned | R8 - Permission, Policy, Safety | named in Part G |
| 86 | [`prompt-injection-detector`](086-prompt-injection-detector.md) | planned | R8 - Permission, Policy, Safety | named in Part G |
| 87 | [`sandbox`](087-sandbox.md) | planned | R8 - Permission, Policy, Safety | inferred from catalog layer R8 |

## Phase 8: Context & memory

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 88 | [`context-engine`](088-context-engine.md) | planned | R6 - Context & Memory | named in Part G |
| 89 | [`compaction-snip`](089-compaction-snip.md) | planned | R6 - Context & Memory | expanded from compaction stack |
| 90 | [`compaction-microcompact`](090-compaction-microcompact.md) | planned | R6 - Context & Memory | expanded from compaction stack |
| 91 | [`compaction-context-collapse`](091-compaction-context-collapse.md) | planned | R6 - Context & Memory | expanded from compaction stack |
| 92 | [`compaction-autocompact`](092-compaction-autocompact.md) | planned | R6 - Context & Memory | expanded from compaction stack |
| 93 | [`compaction-reactive`](093-compaction-reactive.md) | planned | R6 - Context & Memory | expanded from compaction stack |
| 94 | [`compaction-tool-result-budget`](094-compaction-tool-result-budget.md) | planned | R6 - Context & Memory | expanded from compaction stack |
| 95 | [`compaction-session-memory`](095-compaction-session-memory.md) | planned | R6 - Context & Memory | expanded from compaction stack |
| 96 | [`bootstrap-files`](096-bootstrap-files.md) | planned | R6 - Context & Memory | named in Part G |
| 97 | [`system-prompt-builder`](097-system-prompt-builder.md) | planned | R6 - Context & Memory | named in Part G |
| 98 | [`memory-service`](098-memory-service.md) | planned | R6 - Context & Memory | named in Part G |
| 99 | [`vector-store`](099-vector-store.md) | planned | R6 - Context & Memory | named in Part G |
| 100 | [`embedding-adapter`](100-embedding-adapter.md) | planned | R2 - Model Layer | named in Part G |
| 101 | [`memory-extraction`](101-memory-extraction.md) | planned | R6 - Context & Memory | inferred from catalog layer R6 |
| 102 | [`personalization-store`](102-personalization-store.md) | planned | R6 - Context & Memory | inferred from catalog layer R6 |

## Phase 9: Telemetry & eval

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 103 | [`telemetry-engine`](103-telemetry-engine.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 104 | [`otel-exporter`](104-otel-exporter.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 105 | [`trace-recorder`](105-trace-recorder.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 106 | [`metrics-collector`](106-metrics-collector.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 107 | [`replay-engine`](107-replay-engine.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 108 | [`cost-tracker`](108-cost-tracker.md) | planned | R2 - Model Layer | named in Part G |
| 109 | [`eval-service`](109-eval-service.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 110 | [`dataset-registry`](110-dataset-registry.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 111 | [`grader-registry`](111-grader-registry.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 112 | [`benchmark-runner`](112-benchmark-runner.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 113 | [`trajectory-grading`](113-trajectory-grading.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 114 | [`prompt-optimizer`](114-prompt-optimizer.md) | planned | R15 - Telemetry, Tracing, Eval | named in Part G |
| 115 | [`canary-router`](115-canary-router.md) | planned | R15 - Telemetry, Tracing, Eval | inferred from catalog layer R15 |
| 116 | [`cost-attribution`](116-cost-attribution.md) | planned | R15 - Telemetry, Tracing, Eval | inferred from catalog layer R15 |

## Phase 10: MCP/protocol

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 117 | [`mcp-host`](117-mcp-host.md) | planned | R5 - MCP & Protocol Hosts | named in Part G |
| 118 | [`mcp-server-host`](118-mcp-server-host.md) | planned | R5 - MCP & Protocol Hosts | named in Part G |
| 119 | [`webhook-host`](119-webhook-host.md) | planned | R5 - MCP & Protocol Hosts | named in Part G |
| 120 | [`a2a-protocol`](120-a2a-protocol.md) | planned | R5 - MCP & Protocol Hosts | named in Part G |
| 121 | [`acp-protocol`](121-acp-protocol.md) | planned | R5 - MCP & Protocol Hosts | named in Part G |
| 122 | [`ag-ui-protocol`](122-ag-ui-protocol.md) | planned | R5 - MCP & Protocol Hosts | named in Part G |

## Phase 11: Built-in tool implementations

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 123 | [`tool-fs`](123-tool-fs.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 124 | [`tool-bash`](124-tool-bash.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 125 | [`tool-process`](125-tool-process.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 126 | [`tool-code-execution`](126-tool-code-execution.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 127 | [`tool-web-search`](127-tool-web-search.md) | planned | R4 - Built-in Tool Implementations | expanded from tool-web-* |
| 128 | [`tool-web-fetch`](128-tool-web-fetch.md) | planned | R4 - Built-in Tool Implementations | expanded from tool-web-* |
| 129 | [`tool-mcp`](129-tool-mcp.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 130 | [`tool-todo`](130-tool-todo.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 131 | [`tool-skill`](131-tool-skill.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 132 | [`tool-ask-user`](132-tool-ask-user.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 133 | [`tool-cron`](133-tool-cron.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 134 | [`tool-task`](134-tool-task.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 135 | [`tool-team`](135-tool-team.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 136 | [`tool-agent`](136-tool-agent.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 137 | [`tool-message-channel`](137-tool-message-channel.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 138 | [`tool-memory`](138-tool-memory.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 139 | [`tool-plan-mode`](139-tool-plan-mode.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 140 | [`tool-worktree`](140-tool-worktree.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 141 | [`tool-lsp`](141-tool-lsp.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 142 | [`tool-monitor`](142-tool-monitor.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 143 | [`tool-sleep`](143-tool-sleep.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 144 | [`tool-notebook-edit`](144-tool-notebook-edit.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 145 | [`tool-notification`](145-tool-notification.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 146 | [`tool-remote-trigger`](146-tool-remote-trigger.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 147 | [`tool-canvas`](147-tool-canvas.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 148 | [`tool-citations`](148-tool-citations.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 149 | [`tool-screen-capture`](149-tool-screen-capture.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 150 | [`tool-mouse-keyboard`](150-tool-mouse-keyboard.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 151 | [`tool-vision-grounding`](151-tool-vision-grounding.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 152 | [`tool-dom-inspector`](152-tool-dom-inspector.md) | planned | R4 - Built-in Tool Implementations | named in Part G |
| 153 | [`tool-image-generation`](153-tool-image-generation.md) | planned | R4 - Built-in Tool Implementations | inferred from catalog layer R4 |

## Phase 12: Multi-agent & engines

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 154 | [`subagent-runtime`](154-subagent-runtime.md) | planned | R10 - Multi-Agent / Coordination | named in Part G |
| 155 | [`coordinator`](155-coordinator.md) | planned | R10 - Multi-Agent / Coordination | named in Part G |
| 156 | [`swarm-runtime`](156-swarm-runtime.md) | planned | R10 - Multi-Agent / Coordination | named in Part G |
| 157 | [`handoff-engine`](157-handoff-engine.md) | planned | R10 - Multi-Agent / Coordination | named in Part G |
| 158 | [`role-system`](158-role-system.md) | planned | R10 - Multi-Agent / Coordination | named in Part G |
| 159 | [`task-engine`](159-task-engine.md) | planned | R10 - Multi-Agent / Coordination | named in Part G |
| 160 | [`graph-engine`](160-graph-engine.md) | planned | R11 - Workflow / Graph / Pipeline Engines | named in Part G |
| 161 | [`workflow-engine`](161-workflow-engine.md) | planned | R11 - Workflow / Graph / Pipeline Engines | named in Part G |
| 162 | [`pipeline-engine`](162-pipeline-engine.md) | planned | R11 - Workflow / Graph / Pipeline Engines | named in Part G |
| 163 | [`durable-execution`](163-durable-execution.md) | planned | R11 - Workflow / Graph / Pipeline Engines | named in Part G |
| 164 | [`event-bus`](164-event-bus.md) | planned | R11 - Workflow / Graph / Pipeline Engines | named in Part G |
| 165 | [`checkpoint-encoder`](165-checkpoint-encoder.md) | planned | R11 - Workflow / Graph / Pipeline Engines | named in Part G |
| 166 | [`pairing-engine`](166-pairing-engine.md) | planned | R10 - Multi-Agent / Coordination | inferred from catalog layer R10 |
| 167 | [`workflow-checkpointer`](167-workflow-checkpointer.md) | planned | R11 - Workflow / Graph / Pipeline Engines | inferred from catalog layer R11 |

## Phase 13: Hooks/skills/commands

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 168 | [`hooks-engine`](168-hooks-engine.md) | planned | R9 - Hooks, Skills, Slash Commands | named in Part G |
| 169 | [`hook-loader`](169-hook-loader.md) | planned | R9 - Hooks, Skills, Slash Commands | named in Part G |
| 170 | [`skills-registry`](170-skills-registry.md) | planned | R9 - Hooks, Skills, Slash Commands | named in Part G |
| 171 | [`skills-serializer`](171-skills-serializer.md) | planned | R9 - Hooks, Skills, Slash Commands | named in Part G |
| 172 | [`slash-commands`](172-slash-commands.md) | planned | R9 - Hooks, Skills, Slash Commands | named in Part G |
| 173 | [`output-styles`](173-output-styles.md) | planned | R9 - Hooks, Skills, Slash Commands | named in Part G |
| 174 | [`autoreply-policy`](174-autoreply-policy.md) | planned | R9 - Hooks, Skills, Slash Commands | inferred from catalog layer R9 |

## Phase 14: RAG layer

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 175 | [`document-store`](175-document-store.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |
| 176 | [`retriever`](176-retriever.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |
| 177 | [`ranker`](177-ranker.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |
| 178 | [`reader-extractor`](178-reader-extractor.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |
| 179 | [`query-router`](179-query-router.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |
| 180 | [`generator`](180-generator.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |
| 181 | [`document-loader`](181-document-loader.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |
| 182 | [`chunker`](182-chunker.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |
| 183 | [`knowledge-graph`](183-knowledge-graph.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |
| 184 | [`ingestion-pipeline`](184-ingestion-pipeline.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |
| 185 | [`citation-tracker`](185-citation-tracker.md) | planned | R12 - RAG / Retrieval / Knowledge | named in Part G |

## Phase 15: Channels

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 186 | [`channel-registry`](186-channel-registry.md) | planned | R13 - Channels & Messaging | named in Part G |
| 187 | [`channel-adapter-base`](187-channel-adapter-base.md) | planned | R13 - Channels & Messaging | named in Part G |
| 188 | [`channel-telegram`](188-channel-telegram.md) | planned | R13 - Channels & Messaging | expanded from channel-* |
| 189 | [`channel-slack`](189-channel-slack.md) | planned | R13 - Channels & Messaging | expanded from channel-* |
| 190 | [`channel-discord`](190-channel-discord.md) | planned | R13 - Channels & Messaging | expanded from channel-* |
| 191 | [`channel-whatsapp`](191-channel-whatsapp.md) | planned | R13 - Channels & Messaging | expanded from channel-* |
| 192 | [`channel-signal`](192-channel-signal.md) | planned | R13 - Channels & Messaging | expanded from channel-* |
| 193 | [`channel-bluebubbles`](193-channel-bluebubbles.md) | planned | R13 - Channels & Messaging | expanded from channel-* |
| 194 | [`channel-imessage-native`](194-channel-imessage-native.md) | planned | R13 - Channels & Messaging | expanded from channel-* |
| 195 | [`channel-email`](195-channel-email.md) | planned | R13 - Channels & Messaging | expanded from channel-* |
| 196 | [`channel-sms`](196-channel-sms.md) | planned | R13 - Channels & Messaging | expanded from channel-* |
| 197 | [`channel-web`](197-channel-web.md) | planned | R13 - Channels & Messaging | expanded from channel-* |
| 198 | [`channel-transport`](198-channel-transport.md) | planned | R13 - Channels & Messaging | named in Part G |
| 199 | [`channel-binding`](199-channel-binding.md) | planned | R13 - Channels & Messaging | named in Part G |
| 200 | [`channel-router`](200-channel-router.md) | planned | R13 - Channels & Messaging | named in Part G |
| 201 | [`channel-features`](201-channel-features.md) | planned | R13 - Channels & Messaging | named in Part G |
| 202 | [`directory-adapters`](202-directory-adapters.md) | planned | R13 - Channels & Messaging | named in Part G |
| 203 | [`media-payload`](203-media-payload.md) | planned | R13 - Channels & Messaging | named in Part G |
| 204 | [`pairing-flow`](204-pairing-flow.md) | planned | R13 - Channels & Messaging | named in Part G |
| 205 | [`message-actions`](205-message-actions.md) | planned | R13 - Channels & Messaging | named in Part G |
| 206 | [`gateway-server`](206-gateway-server.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 207 | [`gateway-protocol`](207-gateway-protocol.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |

## Phase 16: Scheduling

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 208 | [`scheduler-cron`](208-scheduler-cron.md) | planned | R14 - Scheduling & Background | named in Part G |
| 209 | [`heartbeat-engine`](209-heartbeat-engine.md) | planned | R14 - Scheduling & Background | named in Part G |
| 210 | [`isolated-agent-runner`](210-isolated-agent-runner.md) | planned | R14 - Scheduling & Background | named in Part G |
| 211 | [`session-reaper`](211-session-reaper.md) | planned | R14 - Scheduling & Background | named in Part G |
| 212 | [`task-scheduler`](212-task-scheduler.md) | planned | R14 - Scheduling & Background | named in Part G |
| 213 | [`background-housekeeping`](213-background-housekeeping.md) | planned | R14 - Scheduling & Background | named in Part G |
| 214 | [`queue-consumer`](214-queue-consumer.md) | planned | R14 - Scheduling & Background | named in Part G |
| 215 | [`idempotency-store`](215-idempotency-store.md) | planned | R14 - Scheduling & Background | named in Part G |
| 216 | [`rate-limiter`](216-rate-limiter.md) | planned | R14 - Scheduling & Background | named in Part G |
| 217 | [`retry-policy`](217-retry-policy.md) | planned | R14 - Scheduling & Background | named in Part G |
| 218 | [`dead-letter-queue`](218-dead-letter-queue.md) | planned | R14 - Scheduling & Background | named in Part G |
| 219 | [`batch-progress-tracker`](219-batch-progress-tracker.md) | planned | R14 - Scheduling & Background | named in Part G |

## Phase 17: UI/TUI/Voice/Media

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 220 | [`tui-runtime`](220-tui-runtime.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 221 | [`tui-keybindings`](221-tui-keybindings.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 222 | [`repl-launcher`](222-repl-launcher.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 223 | [`web-ui`](223-web-ui.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 224 | [`voice-runtime`](224-voice-runtime.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 225 | [`vad-engine`](225-vad-engine.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 226 | [`barge-in-controller`](226-barge-in-controller.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 227 | [`audio-stream`](227-audio-stream.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 228 | [`call-session`](228-call-session.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 229 | [`telephony-adapter`](229-telephony-adapter.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 230 | [`dtmf-handler`](230-dtmf-handler.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 231 | [`prosody-controller`](231-prosody-controller.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 232 | [`media-service`](232-media-service.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 233 | [`canvas-host`](233-canvas-host.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |
| 234 | [`notifications-service`](234-notifications-service.md) | planned | R16 - UI / TUI / Voice / Media | named in Part G |

## Phase 18: Deployment & studio

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 235 | [`deployment-controller`](235-deployment-controller.md) | planned | F3 - Deployment & Operations | named in Part G |
| 236 | [`deployment-profiles`](236-deployment-profiles.md) | planned | F3 - Deployment & Operations | named in Part G |
| 237 | [`canary-controller`](237-canary-controller.md) | planned | F3 - Deployment & Operations | named in Part G |
| 238 | [`migration-runner`](238-migration-runner.md) | planned | F3 - Deployment & Operations | named in Part G |
| 239 | [`upgrade-controller`](239-upgrade-controller.md) | planned | F3 - Deployment & Operations | named in Part G |
| 240 | [`studio-ui`](240-studio-ui.md) | planned | F4 - Studio & Authoring UX | named in Part G |
| 241 | [`studio-server`](241-studio-server.md) | planned | F4 - Studio & Authoring UX | named in Part G |
| 242 | [`trace-viewer`](242-trace-viewer.md) | planned | F4 - Studio & Authoring UX | named in Part G |
| 243 | [`graph-visualizer`](243-graph-visualizer.md) | planned | F4 - Studio & Authoring UX | named in Part G |
| 244 | [`spec-cli`](244-spec-cli.md) | implemented and tested | F4 - Studio & Authoring UX | named in Part G |
| 245 | [`wizard`](245-wizard.md) | planned | F4 - Studio & Authoring UX | named in Part G |
| 246 | [`scaffold-templates`](246-scaffold-templates.md) | planned | F4 - Studio & Authoring UX | named in Part G |

## Phase 19: Plugin SDK

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 247 | [`plugin-sdk`](247-plugin-sdk.md) | planned | F5 - Plugin SDK & Extension | named in Part G |
| 248 | [`plugin-registry`](248-plugin-registry.md) | planned | F5 - Plugin SDK & Extension | named in Part G |
| 249 | [`plugin-loader`](249-plugin-loader.md) | planned | F5 - Plugin SDK & Extension | named in Part G |
| 250 | [`module-marketplace`](250-module-marketplace.md) | planned | F5 - Plugin SDK & Extension | named in Part G |

## Phase 20: Specialized + per-shape final modules

| # | Module | Status | Catalog layer | Origin |
|---:|---|---|---|---|
| 251 | [`research-planner`](251-research-planner.md) | planned | R19 - Research-Agent Specific | expanded from research stack |
| 252 | [`crawler`](252-crawler.md) | planned | R19 - Research-Agent Specific | expanded from research stack |
| 253 | [`branch-explorer`](253-branch-explorer.md) | planned | R19 - Research-Agent Specific | expanded from research stack |
| 254 | [`evidence-store`](254-evidence-store.md) | planned | R19 - Research-Agent Specific | expanded from research stack |
| 255 | [`report-synthesizer`](255-report-synthesizer.md) | planned | R19 - Research-Agent Specific | expanded from research stack |
| 256 | [`progress-streamer`](256-progress-streamer.md) | planned | R19 - Research-Agent Specific | expanded from research stack |
| 257 | [`research-checkpointer`](257-research-checkpointer.md) | planned | R19 - Research-Agent Specific | expanded from research stack |
| 258 | [`source-quality-scorer`](258-source-quality-scorer.md) | planned | R19 - Research-Agent Specific | expanded from research stack |
| 259 | [`autoplan-engine`](259-autoplan-engine.md) | planned | R18 - Specialized / Advanced | expanded from research stack |
| 260 | [`batch-runner`](260-batch-runner.md) | planned | R20 - Batch-Worker Specific | expanded from batch stack |
| 261 | [`batch-job-spec`](261-batch-job-spec.md) | planned | R20 - Batch-Worker Specific | expanded from batch stack |
| 262 | [`fan-out-fan-in`](262-fan-out-fan-in.md) | planned | R20 - Batch-Worker Specific | expanded from batch stack |
| 263 | [`output-sink`](263-output-sink.md) | planned | R20 - Batch-Worker Specific | expanded from batch stack |
| 264 | [`batch-eval-loop`](264-batch-eval-loop.md) | planned | R20 - Batch-Worker Specific | expanded from batch stack |
| 265 | [`computer-use-driver`](265-computer-use-driver.md) | planned | R18 - Specialized / Advanced | expanded from computer-use stack |
| 266 | [`browser-extension-bridge`](266-browser-extension-bridge.md) | planned | R18 - Specialized / Advanced | expanded from computer-use stack |
| 267 | [`tool-browser`](267-tool-browser.md) | planned | R4 - Built-in Tool Implementations | expanded from computer-use stack |
| 268 | [`tool-tts-stt`](268-tool-tts-stt.md) | planned | R4 - Built-in Tool Implementations | expanded from voice-specific extras |
| 269 | [`lsp-host`](269-lsp-host.md) | planned | R18 - Specialized / Advanced | inferred from catalog layer R18 |
| 270 | [`sandbox-fs-overlay`](270-sandbox-fs-overlay.md) | planned | R18 - Specialized / Advanced | inferred from catalog layer R18 |
| 271 | [`structured-output-tools`](271-structured-output-tools.md) | planned | R18 - Specialized / Advanced | inferred from catalog layer R18 |
| 272 | [`auto-classifier`](272-auto-classifier.md) | planned | R18 - Specialized / Advanced | inferred from catalog layer R18 |
| 273 | [`fingerprint`](273-fingerprint.md) | planned | R18 - Specialized / Advanced | inferred from catalog layer R18 |
| 274 | [`activity-manager`](274-activity-manager.md) | planned | R18 - Specialized / Advanced | inferred from catalog layer R18 |
| 275 | [`speculation-cache`](275-speculation-cache.md) | planned | R18 - Specialized / Advanced | inferred from catalog layer R18 |
| 276 | [`commitments-engine`](276-commitments-engine.md) | planned | R18 - Specialized / Advanced | inferred from catalog layer R18 |

