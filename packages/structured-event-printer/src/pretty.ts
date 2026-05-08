/**
 * Pretty formatter for TraceEvent. One line per event with the kind in
 * fixed-width brackets followed by event-specific summary fields.
 */
import type { TraceEvent } from "@crewhaus/trace-event-bus";

const KIND_WIDTH = 22;

export function formatLine(ev: TraceEvent): string {
  const time = ev.timestamp;
  const kind = `[${ev.kind}]`.padEnd(KIND_WIDTH);
  const head = `${time} ${kind}`;
  return `${head} ${formatBody(ev)}`;
}

function formatBody(ev: TraceEvent): string {
  switch (ev.kind) {
    case "turn_start":
      return `turn=${ev.turn} messages=${ev.messageCount}`;
    case "turn_end":
      return `turn=${ev.turn} duration=${ev.durationMs.toFixed(0)}ms${
        ev.stopReason ? ` stop=${ev.stopReason}` : ""
      }`;
    case "model_request":
      return `model=${ev.model} messages=${ev.messageCount} tools=${ev.toolCount}${
        ev.streaming ? " streaming" : ""
      }`;
    case "model_response": {
      const usage = `in=${ev.usage.input} out=${ev.usage.output}`;
      return `model=${ev.model} stop=${ev.stopReason} ${usage} duration=${ev.durationMs.toFixed(0)}ms`;
    }
    case "model_stream_token":
      return `chunk=${ev.chunkIndex} chars=${ev.deltaChars}`;
    case "tool_call_start":
      return `tool=${ev.toolName} id=${ev.toolUseId} input=${ev.inputBytes}B`;
    case "tool_call_end":
      return `tool=${ev.toolName} id=${ev.toolUseId} ${ev.isError ? "ERROR " : ""}output=${ev.outputBytes}B duration=${ev.durationMs.toFixed(0)}ms`;
    case "tool_stream_chunk":
      return `tool=${ev.toolName} id=${ev.toolUseId} ${ev.stream}=${ev.bytes}B`;
    case "mcp_call_start":
      return `server=${ev.server} tool=${ev.toolName}`;
    case "mcp_call_end":
      return `server=${ev.server} tool=${ev.toolName} ${ev.isError ? "ERROR " : ""}duration=${ev.durationMs.toFixed(0)}ms`;
    case "hook_fired":
      return `event=${ev.event}${ev.matcher ? ` matcher=${ev.matcher}` : ""} allowed=${ev.allowed} duration=${ev.durationMs.toFixed(0)}ms${
        ev.reason ? ` reason=${ev.reason}` : ""
      }`;
    case "compaction_fired":
      return `kind=${ev.subKind} phase=${ev.phase} before=${ev.before} after=${ev.after}`;
    case "permission_decision":
      return `tool=${ev.toolName} decision=${ev.decision} mode=${ev.mode}${
        ev.outcome ? ` outcome=${ev.outcome}` : ""
      }${ev.reason ? ` reason=${ev.reason}` : ""}`;
    case "error_recovered":
      return `action=${ev.action} error=${ev.errorName} depth=${ev.depth}`;
    case "sub_agent_start":
      return `name=${ev.name} childRun=${ev.childRunId} tools=${ev.toolCount} prompt=${ev.promptBytes}B`;
    case "sub_agent_end":
      return `name=${ev.name} childRun=${ev.childRunId} ${ev.isError ? "ERROR " : ""}toolCalls=${ev.toolCallCount} finalMsg=${ev.finalMessageBytes}B duration=${ev.durationMs.toFixed(0)}ms`;
    case "role_start":
      return `role=${ev.role} activation=${ev.activation}`;
    case "role_end":
      return `role=${ev.role} activation=${ev.activation} finalMsg=${ev.finalMessageBytes}B duration=${ev.durationMs.toFixed(0)}ms`;
    case "handoff":
      return `from=${ev.from} to=${ev.to} depth=${ev.depth}${
        ev.reason ? ` reason=${ev.reason}` : ""
      }`;
    case "a2a_message":
      return `from=${ev.from} to=${ev.to} kind=${ev.messageKind} payload=${ev.payloadBytes}B`;
    case "crew_done":
      return `finalRole=${ev.finalRole} activations=${ev.totalActivations} duration=${ev.durationMs.toFixed(0)}ms`;
  }
}
