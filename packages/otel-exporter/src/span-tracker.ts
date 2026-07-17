/**
 * SpanTracker — pairs `*_start` events with their matching `*_end` events
 * and emits OTLP spans. The orchestrator publishes events in lifecycle order
 * so this tracker just needs to remember the most recent start per logical
 * key (turn / model / tool / etc) until its end arrives.
 */
import type {
  A2AMessageEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  CircuitStateChangedEvent,
  CompactionFiredEvent,
  CostAccrualEvent,
  CoverageReportEvent,
  ErrorRecoveredEvent,
  HandoffEvent,
  HookFiredEvent,
  JanitorActionEvent,
  McpCallEndEvent,
  McpCallStartEvent,
  ModelFailoverEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ModelStreamTokenEvent,
  ModelTierRouteEvent,
  PermissionDecisionEvent,
  ProgramOutputEvent,
  ResponseRatedEvent,
  RoleEndEvent,
  RoleStartEvent,
  RunFailedEvent,
  SanitizerReportEvent,
  SubAgentEndEvent,
  SubAgentStartEvent,
  TestVerdictEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  TraceEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@crewhaus/trace-event-bus";

// See gen-ai-mapping.ts: these two union members are not re-exported by name
// from the trace-event-bus index barrel, so derive them from `TraceEvent`.
type AlertRaisedEvent = Extract<TraceEvent, { kind: "alert_raised" }>;
type ModelRouteEvent = Extract<TraceEvent, { kind: "model_route" }>;
import {
  type StartedMcp,
  type StartedModel,
  type StartedRole,
  type StartedSubAgent,
  type StartedTool,
  type StartedTurn,
  buildA2AMessageSpan,
  buildAlertRaisedSpan,
  buildApprovalRequestedSpan,
  buildApprovalResolvedSpan,
  buildCircuitStateChangedSpan,
  buildCompactionSpan,
  buildCostAccrualSpan,
  buildCoverageReportSpan,
  buildErrorRecoveredSpan,
  buildGenericSpan,
  buildHandoffSpan,
  buildHookSpan,
  buildJanitorActionSpan,
  buildMcpSpan,
  buildModelFailoverSpan,
  buildModelRouteSpan,
  buildModelSpan,
  buildModelTierRouteSpan,
  buildPermissionSpan,
  buildProgramOutputSpan,
  buildResponseRatedSpan,
  buildRoleSpan,
  buildRunFailedSpan,
  buildSanitizerReportSpan,
  buildStreamTokenEvent,
  buildSubAgentSpan,
  buildTestVerdictSpan,
  buildToolSpan,
  buildTurnSpan,
} from "./gen-ai-mapping";
import type { OtelSpan } from "./types";

function isoToNano(iso: string): string {
  return `${BigInt(Date.parse(iso))}000000`;
}

export class SpanTracker {
  private turn: StartedTurn | undefined;
  private model: StartedModel | undefined;
  private readonly tools = new Map<string, StartedTool>();
  /** server::toolName key — MCP can have one in flight per server. */
  private readonly mcps = new Map<string, StartedMcp>();
  /** name::childRunId key. */
  private readonly subAgents = new Map<string, StartedSubAgent>();
  /** role::activation key — one crew role activation in flight per key. */
  private readonly roles = new Map<string, StartedRole>();
  private readonly emit: (span: OtelSpan) => void;

  constructor(emit: (span: OtelSpan) => void) {
    this.emit = emit;
  }

  ingest(ev: TraceEvent): void {
    switch (ev.kind) {
      case "turn_start":
        this.turn = { startNano: isoToNano(ev.timestamp), ev: ev as TurnStartEvent };
        return;
      case "turn_end":
        if (this.turn) {
          this.emit(buildTurnSpan(this.turn, ev as TurnEndEvent));
          this.turn = undefined;
        }
        return;
      case "model_request":
        this.model = {
          startNano: isoToNano(ev.timestamp),
          ev: ev as ModelRequestEvent,
          streamEvents: [],
        };
        return;
      case "model_stream_token":
        if (this.model) {
          this.model.streamEvents.push(buildStreamTokenEvent(ev as ModelStreamTokenEvent));
        }
        return;
      case "model_response":
        if (this.model) {
          this.emit(buildModelSpan(this.model, ev as ModelResponseEvent));
          this.model = undefined;
        }
        return;
      case "tool_call_start":
        this.tools.set((ev as ToolCallStartEvent).toolUseId, {
          startNano: isoToNano(ev.timestamp),
          ev: ev as ToolCallStartEvent,
        });
        return;
      case "tool_call_end": {
        const e = ev as ToolCallEndEvent;
        const start = this.tools.get(e.toolUseId);
        if (start) {
          this.emit(buildToolSpan(start, e));
          this.tools.delete(e.toolUseId);
        }
        return;
      }
      case "mcp_call_start": {
        const e = ev as McpCallStartEvent;
        this.mcps.set(`${e.server}::${e.toolName}`, {
          startNano: isoToNano(ev.timestamp),
          ev: e,
        });
        return;
      }
      case "mcp_call_end": {
        const e = ev as McpCallEndEvent;
        const key = `${e.server}::${e.toolName}`;
        const start = this.mcps.get(key);
        if (start) {
          this.emit(buildMcpSpan(start, e));
          this.mcps.delete(key);
        }
        return;
      }
      case "hook_fired":
        this.emit(buildHookSpan(ev as HookFiredEvent));
        return;
      case "compaction_fired":
        this.emit(buildCompactionSpan(ev as CompactionFiredEvent));
        return;
      case "permission_decision": {
        const e = ev as PermissionDecisionEvent;
        // Item 14 added a second `permission_decision` publish carrying the
        // ask RESOLUTION (`askOutcome` set) after the pre-prompt publish
        // (`decision: "ask"` with no `askOutcome`). Mirror the advisor
        // persistence subscriber's de-dupe (runtime-core/observability.ts):
        // skip the pre-prompt publish and emit only the resolved form, so
        // an ask still produces exactly one span — now the more informative
        // one, carrying the actual approved/denied outcome. Allow/deny
        // decisions have no `askOutcome` and are unaffected.
        if (e.decision === "ask" && e.askOutcome === undefined) return;
        this.emit(buildPermissionSpan(e));
        return;
      }
      case "response_rated":
        this.emit(buildResponseRatedSpan(ev as ResponseRatedEvent));
        return;
      case "error_recovered":
        this.emit(buildErrorRecoveredSpan(ev as ErrorRecoveredEvent));
        return;
      case "sub_agent_start": {
        const e = ev as SubAgentStartEvent;
        this.subAgents.set(`${e.name}::${e.childRunId}`, {
          startNano: isoToNano(ev.timestamp),
          ev: e,
        });
        return;
      }
      case "sub_agent_end": {
        const e = ev as SubAgentEndEvent;
        const key = `${e.name}::${e.childRunId}`;
        const start = this.subAgents.get(key);
        if (start) {
          this.emit(buildSubAgentSpan(start, e));
          this.subAgents.delete(key);
        }
        return;
      }
      // G58 — crew role activation, `role_start` → `role_end`.
      case "role_start": {
        const e = ev as RoleStartEvent;
        this.roles.set(`${e.role}::${e.activation}`, {
          startNano: isoToNano(ev.timestamp),
          ev: e,
        });
        return;
      }
      case "role_end": {
        const e = ev as RoleEndEvent;
        const key = `${e.role}::${e.activation}`;
        const start = this.roles.get(key);
        if (start) {
          this.emit(buildRoleSpan(start, e));
          this.roles.delete(key);
        }
        return;
      }
      // G58 — point-in-time spans (no start/end pairing).
      case "handoff":
        this.emit(buildHandoffSpan(ev as HandoffEvent));
        return;
      case "a2a_message":
        this.emit(buildA2AMessageSpan(ev as A2AMessageEvent));
        return;
      case "cost_accrual":
        this.emit(buildCostAccrualSpan(ev as CostAccrualEvent));
        return;
      case "run_failed":
        this.emit(buildRunFailedSpan(ev as RunFailedEvent));
        return;
      case "circuit_state_changed":
        this.emit(buildCircuitStateChangedSpan(ev as CircuitStateChangedEvent));
        return;
      case "model_failover":
        this.emit(buildModelFailoverSpan(ev as ModelFailoverEvent));
        return;
      case "model_tier_route":
        this.emit(buildModelTierRouteSpan(ev as ModelTierRouteEvent));
        return;
      case "model_route":
        this.emit(buildModelRouteSpan(ev as ModelRouteEvent));
        return;
      case "janitor_action":
        this.emit(buildJanitorActionSpan(ev as JanitorActionEvent));
        return;
      case "alert_raised":
        this.emit(buildAlertRaisedSpan(ev as AlertRaisedEvent));
        return;
      case "test_verdict":
        this.emit(buildTestVerdictSpan(ev as TestVerdictEvent));
        return;
      case "program_output":
        this.emit(buildProgramOutputSpan(ev as ProgramOutputEvent));
        return;
      case "coverage_report":
        this.emit(buildCoverageReportSpan(ev as CoverageReportEvent));
        return;
      case "sanitizer_report":
        this.emit(buildSanitizerReportSpan(ev as SanitizerReportEvent));
        return;
      case "approval_requested":
        this.emit(buildApprovalRequestedSpan(ev as ApprovalRequestedEvent));
        return;
      case "approval_resolved":
        this.emit(buildApprovalResolvedSpan(ev as ApprovalResolvedEvent));
        return;
      // G58 — never silently drop: any TraceEvent kind without a dedicated
      // mapping (e.g. `eval_graded`, `judge_verdict`, or a kind added after
      // this exporter) still produces a generic `crewhaus.<kind>` span. The
      // `*_start` events tracked above intentionally never reach here (they are
      // paired with their `*_end` and emit on the end), so this default carries
      // only genuinely-standalone events.
      default:
        this.emit(buildGenericSpan(ev));
        return;
    }
  }
}
