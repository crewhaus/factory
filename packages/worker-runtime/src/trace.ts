/**
 * @crewhaus/worker-runtime — the trace vocabulary the loop emits.
 *
 * The loop speaks the SAME `TraceEvent` vocabulary as the Node runtime
 * (`@crewhaus/trace-event-bus`), but it cannot construct that bus: the bus's
 * traceparent generation reaches for `node:crypto`, and — more
 * fundamentally — envelope correlation (run/session/trace/span ids, agent
 * identity, monotonic timestamps) is a HOST concern, not a loop concern.
 *
 * So the loop emits the CORE of each event — the `kind` discriminant plus its
 * payload, WITHOUT the {@link TraceEventEnvelope} — to an injected
 * {@link TraceSink}. The Node side wraps each core event in a fresh
 * `bus.envelope()` and republishes it on the real bus; a stateless cf-worker
 * serialises it straight onto the `/chat` SSE `trace` frames the studio host
 * already reads. Either way the payload shapes are pinned to
 * `@crewhaus/trace-event-bus` by construction (below), so the two surfaces
 * cannot drift.
 *
 * Type-only imports → erased at build → no runtime dependency on the bus, so
 * this module stays node-free.
 */
import type {
  CostAccrualEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  RunFailedEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  TraceEventEnvelope,
  TurnEndEvent,
  TurnStartEvent,
} from "@crewhaus/trace-event-bus";

/** Strip the host-stamped envelope from a canonical trace event, leaving the
 *  `kind` + payload the loop is responsible for. */
type Core<E> = Omit<E, keyof TraceEventEnvelope>;

/**
 * The subset of the canonical trace vocabulary this v1 loop emits: the turn
 * lifecycle, the model round-trip, per-tool spans, cost accrual, and a
 * classified terminal failure. Each arm is a `Core<…>` of the matching
 * `@crewhaus/trace-event-bus` type, so adding a field there surfaces here as
 * a type error rather than silent drift.
 */
export type WorkerTraceEvent =
  | Core<TurnStartEvent>
  | Core<TurnEndEvent>
  | Core<ModelRequestEvent>
  | Core<ModelResponseEvent>
  | Core<ToolCallStartEvent>
  | Core<ToolCallEndEvent>
  | Core<CostAccrualEvent>
  | Core<RunFailedEvent>;

/**
 * Where the loop hands its core trace events. Synchronous and best-effort:
 * the loop never awaits a sink and a throwing sink must not sever the run
 * (callers wrap I/O-backed sinks accordingly). Default: a no-op.
 */
export type TraceSink = (event: WorkerTraceEvent) => void;

/** A sink that drops everything — the default when the caller wants no trace. */
export const noopTraceSink: TraceSink = () => {};
