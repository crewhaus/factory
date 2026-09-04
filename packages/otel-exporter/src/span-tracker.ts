/**
 * SpanTracker — pairs `*_start` events with their matching `*_end` events
 * and emits OTLP spans. The orchestrator publishes events in lifecycle order
 * so this tracker just needs to remember the most recent start per logical
 * key (turn / model / tool / etc) until its end arrives.
 */
import type {
  A2AMessageEvent,
  AlertRaisedEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  CircuitStateChangedEvent,
  CompactionFiredEvent,
  CostAccrualEvent,
  CoverageReportEvent,
  ErrorRecoveredEvent,
  EvalGradedEvent,
  HandoffEvent,
  HookFiredEvent,
  JanitorActionEvent,
  JudgeVerdictEvent,
  McpCallEndEvent,
  McpCallStartEvent,
  ModelFailoverEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ModelRouteEvent,
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
  buildEvalGradedSpan,
  buildGenericSpan,
  buildHandoffSpan,
  buildHookSpan,
  buildJanitorActionSpan,
  buildJudgeVerdictSpan,
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
  /**
   * 0.6.0 (design §8.4) — in-flight model calls keyed by the request's
   * `spanId`. runtime-core publishes each `model_response` with the SAME
   * spanId as its `model_request` (`modelStartEnv.spanId`), which is the
   * pairing key; a hybrid turn can have a draft, a judge and a shadow call in
   * flight at once, and the single-slot tracker this replaced would have
   * paired a draft's request with a shadow's response. Insertion order is
   * preserved so the LIFO fallback below can serve publishers that mint a
   * fresh envelope for the response (an older or third-party publisher).
   */
  private readonly models = new Map<string, StartedModel>();
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

  /** Number of model calls awaiting their `model_response` (diagnostic). */
  inFlightModelCalls(): number {
    return this.models.size;
  }

  private latestModelKey(): string | undefined {
    let last: string | undefined;
    for (const key of this.models.keys()) last = key;
    return last;
  }

  private latestModel(): StartedModel | undefined {
    const key = this.latestModelKey();
    return key !== undefined ? this.models.get(key) : undefined;
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
        this.models.set(ev.spanId, {
          startNano: isoToNano(ev.timestamp),
          ev: ev as ModelRequestEvent,
          streamEvents: [],
        });
        return;
      case "model_stream_token": {
        // Stream tokens are published with their own fresh envelope, so they
        // attach to the most recent in-flight call — the only one that can be
        // streaming on a single-writer bus (runtime-core never runs two
        // `runOneTurn`s in parallel; side calls are non-streaming).
        const started = this.latestModel();
        if (started) {
          started.streamEvents.push(buildStreamTokenEvent(ev as ModelStreamTokenEvent));
        }
        return;
      }
      case "model_response": {
        // Exact pairing on the request's spanId; LIFO fallback when the
        // response was published under a fresh envelope (never the case for
        // runtime-core, but the tracker used to tolerate it and still does).
        const key = this.models.has(ev.spanId) ? ev.spanId : this.latestModelKey();
        const started = key !== undefined ? this.models.get(key) : undefined;
        if (started && key !== undefined) {
          this.emit(buildModelSpan(started, ev as ModelResponseEvent));
          this.models.delete(key);
        }
        return;
      }
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
      // E51 / NEW-E-2 — in-loop quality verdicts. These used to reach the
      // generic `crewhaus.<kind>` fallback below, which carried the score
      // only as an untyped JSON blob; they now get dedicated attributes and
      // an ERROR status on a fail so trace backends can alert on them.
      case "eval_graded":
        this.emit(buildEvalGradedSpan(ev as EvalGradedEvent));
        return;
      case "judge_verdict":
        this.emit(buildJudgeVerdictSpan(ev as JudgeVerdictEvent));
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
      // mapping (a kind added after this exporter, or a low-traffic
      // lifecycle event) still produces a generic `crewhaus.<kind>` span. The
      // `*_start` events tracked above intentionally never reach here (they are
      // paired with their `*_end` and emit on the end), so this default carries
      // only genuinely-standalone events.
      default:
        this.emit(buildGenericSpan(ev));
        return;
    }
  }
}
