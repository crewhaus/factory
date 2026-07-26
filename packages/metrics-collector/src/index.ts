/**
 * Catalog R-observability `metrics-collector` — counters and histograms
 * derived from the in-process `TraceEventBus`. Sinks are pluggable; the
 * orchestrator selects one based on the `CREWHAUS_METRICS` env var.
 *
 *   CREWHAUS_METRICS=stdout              JSON dump on flush() (default for CLI)
 *   CREWHAUS_METRICS=textfile            Prometheus exposition to the default path
 *   CREWHAUS_METRICS=textfile:/var/p.prom Prometheus exposition to a custom path
 *   CREWHAUS_METRICS=http:8765           Pull-based /metrics endpoint on port 8765
 */
import type { TraceEventBus, Unsubscribe } from "@crewhaus/trace-event-bus";
import { EventToMetrics } from "./handlers";
import { Registry } from "./registry";
import { type Sink, httpServer, prometheusTextfile, stdoutJson } from "./sinks";

export { Registry, Counter, Gauge, Histogram } from "./registry";
export type { Labels, RegistryJsonSnapshot } from "./registry";
export { EventToMetrics } from "./handlers";
// E51 — offline eval run summaries reach the sinks through this recorder
// (a run summary exists only after the last per-sample event, so it is not
// a bus event; see ./eval-run.ts).
export { recordEvalRunSummary, type EvalRunMetricsSummary } from "./eval-run";
export {
  httpServer,
  prometheusTextfile,
  stdoutJson,
  type HttpSink,
  type Sink,
} from "./sinks";

const DEFAULT_PROM_PATH = "/var/run/crewhaus/metrics.prom";

export type SinkSpec =
  | { kind: "stdout" }
  | { kind: "textfile"; path?: string }
  | { kind: "http"; port: number };

export type MetricsCollectorOptions = {
  sink: SinkSpec;
  /** Override `process.stdout.write` for tests of the stdout sink. */
  stdoutWrite?: (chunk: string) => void;
};

export type AttachedMetrics = {
  registry: Registry;
  unsubscribe: Unsubscribe;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  /** For HTTP sink only: the bound port (in case 0 was passed). */
  port?: number;
};

export async function attachMetricsCollector(
  bus: TraceEventBus,
  opts: MetricsCollectorOptions,
): Promise<AttachedMetrics> {
  const registry = new Registry();
  const dispatch = new EventToMetrics(registry);
  const unsubscribe = bus.subscribe((ev) => dispatch.handle(ev));
  let sink: Sink;
  let port: number | undefined;
  switch (opts.sink.kind) {
    case "stdout":
      sink = stdoutJson(
        registry,
        opts.stdoutWrite !== undefined ? { write: opts.stdoutWrite } : {},
      );
      break;
    case "textfile":
      sink = prometheusTextfile(registry, opts.sink.path ?? DEFAULT_PROM_PATH);
      break;
    case "http": {
      const httpSink = await httpServer(registry, opts.sink.port);
      sink = httpSink;
      port = httpSink.port;
      break;
    }
  }
  return {
    registry,
    unsubscribe,
    flush: () => sink.flush(),
    shutdown: () => sink.shutdown(),
    ...(port !== undefined ? { port } : {}),
  };
}

export function parseEnv(value: string | undefined): SinkSpec | undefined {
  if (!value) return undefined;
  if (value === "stdout") return { kind: "stdout" };
  if (value === "textfile") return { kind: "textfile" };
  if (value.startsWith("textfile:")) {
    const path = value.slice("textfile:".length);
    return path.length > 0 ? { kind: "textfile", path } : undefined;
  }
  if (value.startsWith("http:")) {
    const portStr = value.slice("http:".length);
    if (portStr.length === 0) return undefined;
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 0) return undefined;
    return { kind: "http", port };
  }
  return undefined;
}

export async function attachIfEnvSet(
  bus: TraceEventBus,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AttachedMetrics | undefined> {
  const spec = parseEnv(env["CREWHAUS_METRICS"]);
  if (!spec) return undefined;
  return attachMetricsCollector(bus, { sink: spec });
}
