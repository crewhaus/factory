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
 *
 * All three are opt-in. With no env vars set this function returns a no-op
 * `flushAll` so observability adds zero output and zero overhead.
 */
import type { RunContext } from "@crewhaus/run-context";
import {
  type AttachedPrinter,
  attachIfEnvSet as attachPrinterIfEnvSet,
} from "@crewhaus/structured-event-printer";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

export type AttachedSubscribers = {
  printer: AttachedPrinter | undefined;
  metrics: AttachedMetrics | undefined;
  otel: AttachedOtelExporter | undefined;
  flushAll(): Promise<void>;
  shutdownAll(): Promise<void>;
};

export async function attachDefaultSubscribers(
  bus: TraceEventBus,
  runContext: RunContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AttachedSubscribers> {
  const printer = attachPrinterIfEnvSet(bus, env);
  const metrics = await attachMetricsIfEnvSet(bus, env);
  const otel = attachOtelIfEnvSet(bus, env);
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
  };
  return { printer, metrics, otel, flushAll, shutdownAll };
}

function logFlushError(runContext: RunContext, name: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  runContext.logger.error("observability.flush_failed", { name, message });
}
