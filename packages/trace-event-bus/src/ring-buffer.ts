/**
 * Fixed-size circular buffer. Used by `TraceEventBus` to retain the most
 * recent N events for in-process consumers (e.g. eval-runner) without
 * unbounded memory growth.
 */
import type { RecentQuery, TraceEvent, TraceEventKind } from "./types";

export class RingBuffer {
  private readonly capacity: number;
  private readonly slots: Array<TraceEvent | undefined>;
  private nextIndex = 0;
  private filled = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer (got ${capacity})`);
    }
    this.capacity = capacity;
    this.slots = new Array(capacity);
  }

  push(event: TraceEvent): void {
    this.slots[this.nextIndex] = event;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  size(): number {
    return this.filled;
  }

  /**
   * Snapshot of stored events in chronological order, optionally filtered.
   * Returns a new array each call; safe for callers to retain.
   */
  query(q: RecentQuery = {}): TraceEvent[] {
    const out: TraceEvent[] = [];
    const start = this.filled < this.capacity ? 0 : this.nextIndex;
    const sinceMs = q.since ? Date.parse(q.since) : Number.NEGATIVE_INFINITY;
    const kindSet: Set<TraceEventKind> | undefined = q.kinds ? new Set(q.kinds) : undefined;
    for (let i = 0; i < this.filled; i += 1) {
      const ev = this.slots[(start + i) % this.capacity];
      if (!ev) continue;
      if (kindSet && !kindSet.has(ev.kind)) continue;
      if (q.since !== undefined) {
        const ts = Date.parse(ev.timestamp);
        if (Number.isNaN(ts) || ts < sinceMs) continue;
      }
      out.push(ev);
    }
    return out;
  }
}
