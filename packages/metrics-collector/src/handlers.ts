/**
 * Pure event-to-registry handler. Stateful only for `model_ttft_seconds`,
 * which needs to remember the timestamp of the most recent `model_request`
 * per traceId so the first `model_stream_token` can compute time-to-first-token.
 */
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import type { Registry } from "./registry";

export class EventToMetrics {
  private readonly registry: Registry;
  /** traceId → ms timestamp of the most recent model_request that has not seen a token yet. */
  private readonly modelRequestStarts = new Map<string, number>();
  /** Tracks whether we already observed TTFT for the current model_request — only the first chunk counts. */
  private readonly modelTtftSeen = new Set<string>();

  constructor(registry: Registry) {
    this.registry = registry;
  }

  handle(ev: TraceEvent): void {
    switch (ev.kind) {
      case "turn_end":
        this.registry.turnsTotal.inc();
        this.registry.turnDurationSeconds.observe(ev.durationMs / 1000);
        return;
      case "tool_call_end":
        this.registry.toolCallsTotal.inc({ tool: ev.toolName });
        this.registry.toolDurationSeconds.observe(ev.durationMs / 1000, { tool: ev.toolName });
        return;
      case "model_request":
        this.modelRequestStarts.set(ev.traceId, Date.parse(ev.timestamp));
        this.modelTtftSeen.delete(ev.traceId);
        return;
      case "model_stream_token": {
        if (this.modelTtftSeen.has(ev.traceId)) return;
        const startMs = this.modelRequestStarts.get(ev.traceId);
        if (startMs === undefined) return;
        const tokenMs = Date.parse(ev.timestamp);
        if (Number.isNaN(tokenMs)) return;
        const ttftSec = Math.max(0, (tokenMs - startMs) / 1000);
        this.registry.modelTtftSeconds.observe(ttftSec);
        this.modelTtftSeen.add(ev.traceId);
        return;
      }
      case "model_response":
        this.registry.tokensTotal.inc({ direction: "in" }, ev.usage.input);
        this.registry.tokensTotal.inc({ direction: "out" }, ev.usage.output);
        // Clear tracking — the request is complete.
        this.modelRequestStarts.delete(ev.traceId);
        this.modelTtftSeen.delete(ev.traceId);
        return;
      case "error_recovered":
        this.registry.errorsTotal.inc({ kind: ev.errorName });
        return;
      default:
        return;
    }
  }
}
