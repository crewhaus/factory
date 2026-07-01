/**
 * SpanTracker — pairs `*_start` events with their matching `*_end` events
 * and emits OTLP spans. The orchestrator publishes events in lifecycle order
 * so this tracker just needs to remember the most recent start per logical
 * key (turn / model / tool / etc) until its end arrives.
 */
import type {
  CompactionFiredEvent,
  ErrorRecoveredEvent,
  HookFiredEvent,
  McpCallEndEvent,
  McpCallStartEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ModelStreamTokenEvent,
  PermissionDecisionEvent,
  ResponseRatedEvent,
  SubAgentEndEvent,
  SubAgentStartEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  TraceEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@crewhaus/trace-event-bus";
import {
  type StartedMcp,
  type StartedModel,
  type StartedSubAgent,
  type StartedTool,
  type StartedTurn,
  buildCompactionSpan,
  buildErrorRecoveredSpan,
  buildHookSpan,
  buildMcpSpan,
  buildModelSpan,
  buildPermissionSpan,
  buildResponseRatedSpan,
  buildStreamTokenEvent,
  buildSubAgentSpan,
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
      case "permission_decision":
        this.emit(buildPermissionSpan(ev as PermissionDecisionEvent));
        return;
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
    }
  }
}
