/**
 * Catalog R-observability `structured-event-printer` — pretty/JSON-Lines
 * printer for `TraceEvent`. Subscribed to a `TraceEventBus` based on the
 * `CREWHAUS_TRACE` env var.
 *
 *   CREWHAUS_TRACE=pretty   color-coded events on stderr (default when var set)
 *   CREWHAUS_TRACE=json     JSON Lines on stdout (use only in non-interactive mode)
 *
 * `model_stream_token` events are collapsed into a single rolling line in
 * pretty mode so a 10k-token response does not flood the terminal; the
 * collapser uses `\r` rewrites when stderr is a TTY and prints a single
 * summary line otherwise.
 */
import type { TraceEvent, TraceEventBus, Unsubscribe } from "@crewhaus/trace-event-bus";
import { colorEnabled, colorize } from "./colors";
import { formatJsonLine } from "./json";
import { formatLine } from "./pretty";
import { type CollapserOptions, StreamCollapser } from "./stream-collapser";

export { formatJsonLine } from "./json";
export { formatLine } from "./pretty";
export { StreamCollapser } from "./stream-collapser";

export type EventPrinterFormat = "pretty" | "json";

export type EventPrinterOptions = {
  format: EventPrinterFormat;
  /** Sink for pretty/json output. Defaults to stderr (pretty) or stdout (json). */
  sink?: (chunk: string) => void;
  /** Whether to apply ANSI colors. Defaults: TTY-detected for the chosen sink. */
  color?: boolean;
  /** Override TTY detection used by the stream collapser. */
  isTty?: boolean;
};

export type AttachedPrinter = {
  unsubscribe: Unsubscribe;
  /** Force the rolling stream-collapser line to terminate (called from flush). */
  finalize(): void;
};

export function attachEventPrinter(bus: TraceEventBus, opts: EventPrinterOptions): AttachedPrinter {
  const isPretty = opts.format === "pretty";
  const defaultSink: (chunk: string) => void = isPretty
    ? (c) => process.stderr.write(c)
    : (c) => process.stdout.write(c);
  const sink = opts.sink ?? defaultSink;
  const color = opts.color ?? (isPretty ? colorEnabled(process.stderr) : false);

  const collapserOpts: CollapserOptions = {
    sink,
    ...(opts.isTty !== undefined ? { isTty: opts.isTty } : {}),
  };
  const collapser = isPretty ? new StreamCollapser(collapserOpts) : null;

  const handler = (ev: TraceEvent) => {
    if (isPretty) {
      if (collapser?.consume(ev)) return;
      const line = formatLine(ev);
      sink(`${colorize(ev.kind, line, color)}\n`);
      return;
    }
    sink(formatJsonLine(ev));
  };

  const unsubscribe = bus.subscribe(handler);
  return {
    unsubscribe,
    finalize() {
      collapser?.finalize();
    },
  };
}

/**
 * Read `CREWHAUS_TRACE` and attach the printer if it's set. Returns
 * `undefined` when the env var is absent so the caller can skip flush
 * bookkeeping.
 */
export function attachIfEnvSet(
  bus: TraceEventBus,
  env: NodeJS.ProcessEnv = process.env,
): AttachedPrinter | undefined {
  const raw = env["CREWHAUS_TRACE"];
  if (raw !== "pretty" && raw !== "json") return undefined;
  return attachEventPrinter(bus, { format: raw });
}
