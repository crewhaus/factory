/**
 * Turning a stream of raw filesystem notifications into the events a caller
 * actually meant to count.
 *
 * Two things make this harder than it looks, and both are visible in the
 * recorded fixtures in `../fixtures.ts`:
 *
 * 1. THE PLATFORM'S EVENT TYPE IS NOT THE ANSWER. On macOS, appending one
 *    byte to a file arrives as `rename` — every scenario captured on macOS
 *    15.6 reports `rename`, including a plain append. On Linux the same
 *    append arrives as `change`. A tool that filtered on the raw type would
 *    return nothing on macOS for the exact case it exists to catch. So the
 *    raw type is carried as evidence and never used to classify: the KIND is
 *    derived from whether the path existed before and whether it exists now,
 *    which is a fact about the filesystem rather than about the notifier.
 *
 * 2. ONE LOGICAL CHANGE IS SEVERAL EVENTS. An editor saving a file writes it
 *    two or three times (recorded: three `change` events on Linux for one
 *    save), and most editors save atomically — write `doc.md.tmp12345`, then
 *    rename it over `doc.md` — which produces events for a filename the
 *    caller never asked about. A caller counting saves would count four. So
 *    events for the same path within a settle window fold into one, and the
 *    fold reports how many raw notifications it absorbed.
 *
 * This module holds no timers and reads no clock: every timestamp arrives
 * from outside. That is what lets the fixtures drive it exactly, and it is
 * the same code the live watcher runs — the live loop only decides WHEN to
 * call `advanceTo` and `finish`, never what the answer is.
 */

/** What happened to a path, derived from the filesystem rather than the notifier. */
export type EventKind = "created" | "modified" | "deleted";

export type RawWatchEvent = {
  /** Epoch ms, from the injected clock. */
  readonly atMs: number;
  /** The platform's own string (`rename`, `change`), kept as evidence only. */
  readonly eventType: string;
  /** Slash-separated path relative to the watch root; `""` is the watched path itself. */
  readonly path: string;
  /** Whether the path existed when this notification was handled. */
  readonly existsNow: boolean;
};

export type CoalescedEvent = {
  readonly path: string;
  readonly kind: EventKind;
  /** How many raw notifications folded into this one event. */
  readonly rawCount: number;
  readonly firstAtMs: number;
  readonly lastAtMs: number;
  /** The raw platform types seen, sorted and de-duplicated. Evidence, not classification. */
  readonly eventTypes: readonly string[];
  /**
   * The path was never observed to exist: it appeared and was gone again
   * inside one window. This is what an atomic save's temp file looks like,
   * and a caller filtering for real work wants to drop it.
   */
  readonly transient?: true;
};

/** Which bound ended the watch. Always reported, never inferred by the caller. */
export type StopReason = "deadline" | "eventCap" | "aborted" | "watchError";

export type CoalesceOptions = {
  /** Quiet period after which a path's pending events fold into one event. */
  readonly settleMs: number;
  /** Stop after this many COALESCED events — the number a caller counts. */
  readonly maxEvents: number;
  /** Hard ceiling on retained raw notifications, so a busy tree cannot grow without bound. */
  readonly maxRawEvents: number;
  /** Paths that already existed when the watch started, so `created` means created. */
  readonly known?: ReadonlySet<string>;
  /** Only these kinds count towards the cap and appear in the result. */
  readonly kinds?: ReadonlySet<EventKind>;
  /** Only paths matching this predicate count towards the cap and appear. */
  readonly matches?: (path: string) => boolean;
  /** Fold transient paths away entirely (default: report them, flagged). */
  readonly dropTransient?: boolean;
};

export type CoalesceResult = {
  readonly events: readonly CoalescedEvent[];
  readonly stoppedBy: StopReason;
  /** Raw notifications handled, including those folded away. */
  readonly rawCount: number;
  /** Coalesced events that did not match the filters. */
  readonly filteredOut: number;
  /** Paths that appeared and vanished inside one window — an editor's temp file. */
  readonly transientDropped: number;
  /** Coalesced events discarded because the cap was already full. */
  readonly droppedByCap: number;
  /** Raw notifications dropped because the retention ceiling was hit. */
  readonly rawDropped: number;
};

type OpenGroup = {
  readonly path: string;
  readonly existedBefore: boolean;
  firstAtMs: number;
  lastAtMs: number;
  rawCount: number;
  existsAfter: boolean;
  readonly eventTypes: Set<string>;
};

/**
 * The fold, as a reducer the live watcher and the fixture tests both drive.
 *
 * Deliberately one implementation: a "what would have happened" preview that
 * re-derived the answer a second way is a preview that drifts from the real
 * one, and the whole value of this tool is that its count is trustworthy.
 */
export class EventCoalescer {
  private readonly options: CoalesceOptions;
  private readonly open = new Map<string, OpenGroup>();
  private readonly closed: CoalescedEvent[] = [];
  /** Last known existence per path, so `created` vs `modified` is not a guess. */
  private readonly lastKnown = new Map<string, boolean>();
  private rawCount = 0;
  private rawDropped = 0;
  private filteredOut = 0;
  private transientDropped = 0;
  private droppedByCap = 0;
  private capHit = false;

  constructor(options: CoalesceOptions) {
    this.options = options;
    for (const path of options.known ?? []) this.lastKnown.set(path, true);
  }

  /** True once the cap has ended collection; the live loop stops watching here. */
  capReached(): boolean {
    return this.capHit;
  }

  /** How many events have settled and been kept so far. */
  keptCount(): number {
    return this.closed.length;
  }

  /**
   * Record one raw notification.
   *
   * Advancing to the event's own timestamp FIRST is what makes a fold a fold:
   * anything that has been quiet for longer than the settle window is closed
   * before this event opens or extends a group, so two saves a second apart
   * are two events while three writes 10ms apart are one.
   */
  push(event: RawWatchEvent): void {
    if (this.capHit) {
      this.rawDropped += 1;
      return;
    }
    if (this.rawCount >= this.options.maxRawEvents) {
      this.rawDropped += 1;
      return;
    }
    this.advanceTo(event.atMs);
    if (this.capHit) {
      this.rawDropped += 1;
      return;
    }
    this.rawCount += 1;
    const existing = this.open.get(event.path);
    if (existing !== undefined) {
      existing.lastAtMs = event.atMs;
      existing.rawCount += 1;
      existing.existsAfter = event.existsNow;
      existing.eventTypes.add(event.eventType);
      return;
    }
    this.open.set(event.path, {
      path: event.path,
      existedBefore: this.lastKnown.get(event.path) ?? false,
      firstAtMs: event.atMs,
      lastAtMs: event.atMs,
      rawCount: 1,
      existsAfter: event.existsNow,
      eventTypes: new Set([event.eventType]),
    });
  }

  /**
   * Let time pass to `nowMs`, closing every group that has gone quiet.
   *
   * The live watcher calls this from a timer; the fixture tests call it with
   * a number. Neither can tell the difference, which is the point.
   */
  advanceTo(nowMs: number): void {
    if (this.capHit) return;
    // Sorted by when the group went quiet, so the order events are reported
    // in is a property of the recording rather than of Map insertion order.
    const due = [...this.open.values()]
      .filter((group) => group.lastAtMs + this.options.settleMs <= nowMs)
      .sort((a, b) => a.lastAtMs - b.lastAtMs || (a.path < b.path ? -1 : 1));
    for (let i = 0; i < due.length; i += 1) {
      const group = due[i] as OpenGroup;
      this.open.delete(group.path);
      this.closeGroup(group);
      if (this.capHit) {
        // Everything still pending when the cap closed is discarded, but it
        // is COUNTED: a report that silently lost events is the failure this
        // whole module exists to prevent.
        //
        // `this.open` alone is the right count. A group is only removed from
        // it when it closes, so the not-yet-closed tail of `due` is still IN
        // `open` — adding both numbers counted those groups twice.
        this.droppedByCap += this.open.size;
        this.open.clear();
        return;
      }
    }
  }

  /**
   * End the watch and report.
   *
   * `reason` is the bound the live loop hit. It is overridden only when the
   * cap ended collection first, because the answer to "which bound ended it"
   * has to be the one that actually did.
   */
  finish(endAtMs: number, reason: StopReason): CoalesceResult {
    if (!this.capHit) {
      this.advanceTo(endAtMs);
      // Whatever is still open at the deadline is real and still unreported:
      // flush it rather than lose the last save to the settle window.
      const remaining = [...this.open.values()].sort(
        (a, b) => a.firstAtMs - b.firstAtMs || (a.path < b.path ? -1 : 1),
      );
      this.open.clear();
      for (let i = 0; i < remaining.length; i += 1) {
        this.closeGroup(remaining[i] as OpenGroup);
        // The cap can still bite during the final flush; the events it cuts
        // are counted rather than quietly missing from the total.
        if (this.capHit) {
          this.droppedByCap += remaining.length - (i + 1);
          break;
        }
      }
    }
    const events = [...this.closed].sort(
      (a, b) => a.firstAtMs - b.firstAtMs || (a.path < b.path ? -1 : 1),
    );
    return {
      events,
      stoppedBy: this.capHit ? "eventCap" : reason,
      rawCount: this.rawCount,
      filteredOut: this.filteredOut,
      transientDropped: this.transientDropped,
      droppedByCap: this.droppedByCap,
      rawDropped: this.rawDropped,
    };
  }

  /**
   * Fold one group into an event, classify it, and apply the filters.
   *
   * A filtered-out event does NOT count towards the cap: `maxEvents: 1` with
   * a `*.ts` filter means "the first TypeScript change", not "give up after
   * the first temp file in the directory".
   */
  private closeGroup(group: OpenGroup): void {
    this.lastKnown.set(group.path, group.existsAfter);
    const event = classify(group);
    if (event.transient === true && this.options.dropTransient === true) {
      // Counted separately from the other filters: "an editor wrote a temp
      // file" is a different fact from "nothing you asked about happened",
      // and a caller debugging a watch that saw nothing needs to tell them
      // apart.
      this.transientDropped += 1;
      return;
    }
    if (this.options.kinds !== undefined && !this.options.kinds.has(event.kind)) {
      this.filteredOut += 1;
      return;
    }
    if (this.options.matches !== undefined && !this.options.matches(event.path)) {
      this.filteredOut += 1;
      return;
    }
    if (this.closed.length >= this.options.maxEvents) {
      this.droppedByCap += 1;
      this.capHit = true;
      return;
    }
    this.closed.push(event);
    if (this.closed.length >= this.options.maxEvents) this.capHit = true;
  }
}

/**
 * The kind of a folded group, from what the filesystem said rather than from
 * what the notifier called it.
 *
 * The fourth case is the interesting one: a path that was never observed to
 * exist and does not exist now came and went inside one window. That is an
 * editor's temp file — `doc.md.tmp12345` in the recorded atomic-save fixture
 * — and reporting it as a plain deletion of a file nobody created reads as a
 * data loss event when it is the opposite.
 */
function classify(group: OpenGroup): CoalescedEvent {
  const base = {
    path: group.path,
    rawCount: group.rawCount,
    firstAtMs: group.firstAtMs,
    lastAtMs: group.lastAtMs,
    eventTypes: [...group.eventTypes].sort(),
  };
  if (group.existedBefore && group.existsAfter) return { ...base, kind: "modified" };
  if (group.existedBefore && !group.existsAfter) return { ...base, kind: "deleted" };
  if (!group.existedBefore && group.existsAfter) return { ...base, kind: "created" };
  return { ...base, kind: "deleted", transient: true };
}

/**
 * Replay a recorded timeline through the reducer, the way the live watcher
 * would have. Used by every fixture test in this package: same class, same
 * method calls, no timers.
 */
export function coalesceTimeline(
  events: readonly RawWatchEvent[],
  options: CoalesceOptions & { readonly endAtMs: number; readonly reason?: StopReason },
): CoalesceResult {
  const coalescer = new EventCoalescer(options);
  for (const event of events) {
    if (coalescer.capReached()) break;
    coalescer.push(event);
  }
  return coalescer.finish(options.endAtMs, options.reason ?? "deadline");
}
