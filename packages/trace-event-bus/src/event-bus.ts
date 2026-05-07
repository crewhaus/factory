/**
 * `TraceEventBus` — single-process publish/subscribe bus with a bounded
 * history buffer. Constructed once per `runChatLoop` invocation and exposed
 * on `RunContext`. Subscribers attach for the bus's lifetime and never see
 * exceptions thrown by other subscribers; failures are isolated.
 */
import type { Logger } from "@crewhaus/logging";
import { RingBuffer } from "./ring-buffer";
import {
  formatTraceparent,
  isValidSpanId,
  isValidTraceId,
  newSpanId,
  newTraceId,
  readEnvTraceparent,
} from "./traceparent";
import type {
  PublishOptions,
  RecentQuery,
  Span,
  Subscriber,
  TraceEvent,
  TraceEventEnvelope,
  Unsubscribe,
} from "./types";

const DEFAULT_RING_SIZE = 5000;

export type TraceEventBusOptions = {
  readonly runId: string;
  readonly sessionId: string;
  /**
   * When constructing a child bus (e.g. for a sub-agent), supply the parent's
   * `traceId` so the OTel exporter stitches both into one trace.
   */
  readonly inheritTraceId?: string;
  /**
   * The parent span to nest under. When provided alongside `inheritTraceId`,
   * the child bus's root span has this as its parentSpanId.
   */
  readonly inheritParentSpanId?: string;
  readonly ringSize?: number;
  /**
   * Optional logger used to surface subscriber errors. Without it, subscriber
   * failures are silently counted but not logged.
   */
  readonly logger?: Logger;
  /**
   * Override `process.env` (for tests).
   */
  readonly env?: NodeJS.ProcessEnv;
};

type PendingSubscriberPromise = Promise<void>;

export class TraceEventBus {
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly rootParentSpanId: string | undefined;

  private readonly subscribers = new Set<Subscriber>();
  private readonly buffer: RingBuffer;
  private readonly logger: Logger | undefined;
  private readonly pending = new Set<PendingSubscriberPromise>();
  private _currentSpanId: string;
  private _turnNumber = 0;
  private subscriberFailureCount = 0;
  private droppedEventCount = 0;

  constructor(opts: TraceEventBusOptions) {
    this.runId = opts.runId;
    this.sessionId = opts.sessionId;
    this.logger = opts.logger;
    this.buffer = new RingBuffer(opts.ringSize ?? DEFAULT_RING_SIZE);
    const inheritTrace =
      opts.inheritTraceId && isValidTraceId(opts.inheritTraceId) ? opts.inheritTraceId : undefined;
    const inheritParent =
      opts.inheritParentSpanId && isValidSpanId(opts.inheritParentSpanId)
        ? opts.inheritParentSpanId
        : undefined;
    if (inheritTrace) {
      this.traceId = inheritTrace;
      this.rootParentSpanId = inheritParent;
    } else {
      const fromEnv = readEnvTraceparent(opts.env);
      if (fromEnv) {
        this.traceId = fromEnv.traceId;
        this.rootParentSpanId = fromEnv.parentSpanId;
      } else {
        this.traceId = newTraceId();
        this.rootParentSpanId = undefined;
      }
    }
    this.rootSpanId = newSpanId();
    this._currentSpanId = this.rootSpanId;
  }

  /**
   * Most recently opened (and not-yet-ended) span id. When no spans are
   * open this equals `rootSpanId`. Sub-agents inherit this so their root
   * span nests under the parent's active tool/model span.
   */
  get currentSpanId(): string {
    return this._currentSpanId;
  }

  /**
   * Current turn number. The orchestrator calls `setTurnNumber(n)` at the
   * start of each user turn; publishers (mcp-host, hooks-engine, sub-agent-spawner)
   * read this when constructing event envelopes via `envelope()`.
   */
  get turnNumber(): number {
    return this._turnNumber;
  }

  setTurnNumber(turn: number): void {
    this._turnNumber = turn;
  }

  /**
   * Build a fresh envelope using the bus's run/session ids, current turn,
   * trace id, the bus's current span as the parent, and a fresh span id.
   * Publishers call this when emitting fire-and-forget single-point events
   * (hook_fired, permission_decision, etc.). For paired start/end events
   * publishers should reuse the same spanId across both.
   */
  envelope(now: Date = new Date()): TraceEventEnvelope {
    const spanId = newSpanId();
    return {
      runId: this.runId,
      sessionId: this.sessionId,
      turnNumber: this._turnNumber,
      traceId: this.traceId,
      spanId,
      parentSpanId: this._currentSpanId,
      timestamp: now.toISOString(),
    };
  }

  /**
   * W3C `traceparent` for the bus's *current* span. Sub-process spawners
   * (hooks, sub-agents) should set this on the child's environment so the
   * child's bus stitches into the same trace.
   */
  currentTraceparent(): string {
    return formatTraceparent(this.traceId, this._currentSpanId);
  }

  /**
   * Open a span. The returned handle's `end()` returns elapsed milliseconds.
   * If `parent` is a Span, the child span's `parentSpanId` is set to its id;
   * if it is a string, that string is used directly. With no parent, the
   * span nests under the bus's current span (which itself starts as the
   * root span).
   */
  startSpan(_name: string, parent?: Span | string): Span {
    const parentSpanId =
      typeof parent === "string" ? parent : parent ? parent.spanId : this._currentSpanId;
    const spanId = newSpanId();
    const traceId = this.traceId;
    const start = performance.now();
    const previousCurrent = this._currentSpanId;
    this._currentSpanId = spanId;
    let ended = false;
    const handle: Span = {
      spanId,
      traceId,
      parentSpanId,
      end: () => {
        if (ended) return 0;
        ended = true;
        if (this._currentSpanId === spanId) {
          this._currentSpanId = previousCurrent;
        }
        return performance.now() - start;
      },
    };
    return handle;
  }

  subscribe(handler: Subscriber): Unsubscribe {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  publish(event: TraceEvent, opts: PublishOptions = {}): void {
    if (!opts.ephemeral) {
      this.buffer.push(event);
    }
    for (const handler of this.subscribers) {
      let result: void | Promise<void>;
      try {
        result = handler(event);
      } catch (err) {
        this.recordSubscriberFailure(err);
        continue;
      }
      if (result && typeof (result as Promise<void>).then === "function") {
        const p = (result as Promise<void>).catch((err) => {
          this.recordSubscriberFailure(err);
        });
        this.pending.add(p);
        p.finally(() => {
          this.pending.delete(p);
        });
      }
    }
  }

  recent(query: RecentQuery = {}): ReadonlyArray<TraceEvent> {
    return this.buffer.query(query);
  }

  /**
   * Wait for any in-flight async subscriber promises to settle. Does not
   * flush downstream subscribers' own buffers — each subscriber owns its own
   * flush mechanism (e.g. OTel BatchSpanProcessor). Call this from the
   * orchestrator's `finally` block before exiting `runChatLoop`.
   */
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.all(this.pending);
  }

  /**
   * Diagnostic counters. Useful for tests and `flush_failed` log messages.
   */
  stats(): { subscribers: number; buffered: number; subscriberFailures: number; dropped: number } {
    return {
      subscribers: this.subscribers.size,
      buffered: this.buffer.size(),
      subscriberFailures: this.subscriberFailureCount,
      dropped: this.droppedEventCount,
    };
  }

  private recordSubscriberFailure(err: unknown): void {
    this.subscriberFailureCount += 1;
    if (this.logger) {
      const message = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "UnknownError";
      this.logger.error("subscriber.failed", { name, message });
    }
  }
}
