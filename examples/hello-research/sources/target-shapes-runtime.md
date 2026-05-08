# CrewHaus Factory — Target Shapes (Runtime details)

The codegen layer dispatches each `target:` to a per-shape emit function.

| Shape | Runtime spine | Codegen emits |
|---|---|---|
| cli | `runChatLoop` (REPL) | single `agent.ts` |
| workflow | `runChatLoop({ singleTurn: true })` per step | single `agent.ts` |
| channel | `Bun.serve` daemon + `runChatLoop({ singleTurn: true, resume })` | `daemon.ts` + `gateway.ts` + `session-router.ts` + `agent.ts` |
| graph | `graph-engine` + `checkpoint-store` + HITL | single `agent.ts` |
| managed | `gateway-server` + `policy-engine` + `audit-log` + `tenancy` | `daemon.ts` + `agent.ts` |
| pipeline | `pipeline-engine` (chunk → embed → store) + `Retrieve` tool | single `agent.ts` |
| crew | `crew-orchestrator` + `agent-handoff` + `a2a-protocol` | `daemon.ts` + `orchestrator.ts` + per-role `agent_<name>.ts` |

Each target's daemon writes its own JSONL transcript under
`.crewhaus/sessions/<sessionId>.jsonl` (or, for graph, checkpoints
under `.crewhaus/graphs/<runId>/`; for crew, a single shared session
across all roles; for research, state + citations under
`.crewhaus/research/<runId>/`).
