/**
 * JSON Lines formatter — emits one JSON object per event terminated by `\n`.
 */
import type { TraceEvent } from "@crewhaus/trace-event-bus";

export function formatJsonLine(ev: TraceEvent): string {
  return `${JSON.stringify(ev)}\n`;
}
