import { type CostTracker, createCostTracker, formatUsdMicros } from "@crewhaus/cost-tracker";
import type { EventLog } from "@crewhaus/event-log";
import {
  type AttachedMetrics,
  attachIfEnvSet as attachMetricsIfEnvSet,
} from "@crewhaus/metrics-collector";
import {
  type AttachedOtelExporter,
  attachIfEnvSet as attachOtelIfEnvSet,
} from "@crewhaus/otel-exporter";
/**
 * Section 15 — attach the default observability subscribers to a
 * `TraceEventBus` based on environment variables. Returns a single `flushAll`
 * the orchestrator awaits in its `finally` block.
 *
 *   CREWHAUS_TRACE=pretty|json    → structured-event-printer
 *   CREWHAUS_METRICS=stdout|...   → metrics-collector (buffered stdout JSON / textfile / http)
 *   OTEL_EXPORTER_OTLP_ENDPOINT   → otel-exporter (OTLP/HTTP, gen_ai/* attributes)
 *   CREWHAUS_COST_TRACKING=1      → cost-tracker (Section 27 — emits cost_accrual events)
 *   CREWHAUS_COST_INLINE=1        → CLI inline cost line per turn (requires CREWHAUS_COST_TRACKING)
 *
 * All are opt-in. With no env vars set this function returns a no-op
 * `flushAll` so observability adds zero output and zero overhead.
 */
import type { RunContext } from "@crewhaus/run-context";
import {
  type AttachedPrinter,
  attachIfEnvSet as attachPrinterIfEnvSet,
} from "@crewhaus/structured-event-printer";
import type {
  CostAccrualEvent,
  TraceEvent,
  TraceEventBus,
  Unsubscribe,
} from "@crewhaus/trace-event-bus";

export type AttachedSubscribers = {
  printer: AttachedPrinter | undefined;
  metrics: AttachedMetrics | undefined;
  otel: AttachedOtelExporter | undefined;
  costTracker: CostTracker | undefined;
  costInlineUnsubscribe: Unsubscribe | undefined;
  flushAll(): Promise<void>;
  shutdownAll(): Promise<void>;
};

/**
 * Format a single `cost_accrual` event as a one-line CLI status:
 *   `[💸 $0.0042 · 12.3k in / 1.1k out · model=claude-sonnet-4-6]`
 *
 * Exported so target-cli's emitted bundle can render the same format
 * without re-implementing it.
 */
export function formatCostInlineLine(ev: CostAccrualEvent): string {
  const cost = formatUsdMicros(ev.costUsdMicros);
  const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  return `[💸 ${cost} · ${fmtTokens(ev.inputTokens)} in / ${fmtTokens(ev.outputTokens)} out · model=${ev.modelId}]`;
}

export async function attachDefaultSubscribers(
  bus: TraceEventBus,
  runContext: RunContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AttachedSubscribers> {
  const printer = attachPrinterIfEnvSet(bus, env);
  const metrics = await attachMetricsIfEnvSet(bus, env);
  const otel = attachOtelIfEnvSet(bus, env);
  const costTracker =
    env["CREWHAUS_COST_TRACKING"] === "1" || env["CREWHAUS_COST_TRACKING"] === "true"
      ? createCostTracker(bus, {
          ...(env["CREWHAUS_TENANT_ID"] !== undefined
            ? { tenantId: env["CREWHAUS_TENANT_ID"] }
            : {}),
        })
      : undefined;
  // CLI inline cost line — opt-in via CREWHAUS_COST_INLINE=1. Subscribes to
  // the `cost_accrual` events that cost-tracker emits, prints one tidy line
  // per accrual, and stays out of the trace bus's main printer surface so
  // it doesn't double-print when CREWHAUS_TRACE=pretty is also set.
  const costInlineEnabled =
    (env["CREWHAUS_COST_INLINE"] === "1" || env["CREWHAUS_COST_INLINE"] === "true") &&
    costTracker !== undefined;
  let costInlineUnsubscribe: Unsubscribe | undefined;
  if (costInlineEnabled) {
    const handler = (event: TraceEvent): void => {
      if (event.kind !== "cost_accrual") return;
      process.stdout.write(`${formatCostInlineLine(event as CostAccrualEvent)}\n`);
    };
    costInlineUnsubscribe = bus.subscribe(handler);
  }
  const flushAll = async (): Promise<void> => {
    printer?.finalize();
    const tasks: Promise<void>[] = [];
    if (metrics)
      tasks.push(metrics.flush().catch((err) => logFlushError(runContext, "metrics", err)));
    if (otel) tasks.push(otel.flush().catch((err) => logFlushError(runContext, "otel", err)));
    tasks.push(bus.flush().catch((err) => logFlushError(runContext, "bus", err)));
    await Promise.all(tasks);
  };
  const shutdownAll = async (): Promise<void> => {
    printer?.unsubscribe();
    if (metrics) {
      await metrics.shutdown().catch((err) => logFlushError(runContext, "metrics", err));
    }
    if (otel) {
      await otel.shutdown().catch((err) => logFlushError(runContext, "otel", err));
    }
    costTracker?.unsubscribe();
    costInlineUnsubscribe?.();
  };
  return { printer, metrics, otel, costTracker, costInlineUnsubscribe, flushAll, shutdownAll };
}

function logFlushError(runContext: RunContext, name: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  runContext.logger.error("observability.flush_failed", { name, message });
}

// -------- advisor signal persistence (item 14 groundwork) --------

export type AttachedAdvisorPersistence = {
  unsubscribe: Unsubscribe;
};

/**
 * Advisor groundwork (items 14/15/17) — mirror the runtime signals that were
 * previously trace-bus-only into the session JSONL, through the SAME
 * `event-log` append path the run already writes its transcript with:
 *
 *   error_recovered      → `recovery`   { errorName, action, depth }
 *   tool_call_end        → `tool_stats` { toolName, durationMs, isError }
 *   permission_decision  → `permission` { toolName, decision, askOutcome }
 *   model_response       → `model_meta` { stopReason, model }
 *
 * Unlike the other `attach*IfEnvSet` subscribers this one is DEFAULT-ON:
 * the lines are tiny (see the granularity note on the `tool_stats` kind in
 * `@crewhaus/event-log`) and they are the food `crewhaus advise` mines, so
 * opting in would starve the advisor on exactly the runs that need it.
 * Disable with `CREWHAUS_ADVISOR_EVENTS=0` (or `false`).
 *
 * Permission mapping detail: a `decision: "ask"` event WITHOUT `askOutcome`
 * is the pre-prompt publish — skipped here so each ask persists exactly once,
 * as its resolution (`askOutcome: "approved" | "denied"`). Allow/deny
 * decisions (including the justification-gate and egress verdicts, which
 * publish additional `permission_decision` events per call) persist with
 * `askOutcome: null`.
 *
 * `append()` failures must never abort a turn, so — like the cost_accrual
 * persistence path — the promise result is logged rather than thrown.
 */
export function attachAdvisorPersistence(
  bus: TraceEventBus,
  eventLog: EventLog,
  runContext: RunContext,
  env: NodeJS.ProcessEnv = process.env,
): AttachedAdvisorPersistence | undefined {
  const gate = env["CREWHAUS_ADVISOR_EVENTS"];
  if (gate === "0" || gate === "false") return undefined;

  const persist = (
    kind: "recovery" | "tool_stats" | "permission" | "model_meta",
    payload: unknown,
  ): void => {
    void eventLog.append({ kind, payload }).catch((err) => {
      runContext.logger.error("advisor_event.persist_failed", {
        kind,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const unsubscribe = bus.subscribe((event: TraceEvent): void => {
    switch (event.kind) {
      case "error_recovered": {
        persist("recovery", {
          errorName: event.errorName,
          action: event.action,
          depth: event.depth,
        });
        return;
      }
      case "tool_call_end": {
        persist("tool_stats", {
          toolName: event.toolName,
          // Whole milliseconds — performance.now() floats add line bytes
          // without adding advisory signal.
          durationMs: Math.round(event.durationMs),
          isError: event.isError,
        });
        return;
      }
      case "permission_decision": {
        // Pre-prompt ask publish — the resolution (askOutcome set) follows.
        if (event.decision === "ask" && event.askOutcome === undefined) return;
        persist("permission", {
          toolName: event.toolName,
          decision: event.decision,
          askOutcome: event.askOutcome ?? null,
        });
        return;
      }
      case "model_response": {
        persist("model_meta", { stopReason: event.stopReason, model: event.model });
        return;
      }
      default:
        return;
    }
  });

  return { unsubscribe };
}
