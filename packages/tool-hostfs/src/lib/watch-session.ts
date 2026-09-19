/**
 * The live half of `WatchPath`: attach a watcher, stamp what arrives, and
 * stop at whichever bound comes first.
 *
 * This file decides WHEN to stop. It never decides WHAT happened — that is
 * `./coalesce`, which the fixture tests drive directly with no timers at all.
 * Keeping the two apart is what makes the reported event count the same
 * number in a test and on a real machine.
 *
 * Three things here exist because of a platform, not a preference:
 *
 *   - THE SNAPSHOT. `created` versus `modified` cannot be read off a
 *     notification (macOS calls both `rename`), so the paths that already
 *     existed are recorded before the watcher is attached and the answer is
 *     derived from that. The walk is bounded, and a truncated walk is
 *     reported, because an unbounded one on a `node_modules` tree is a
 *     several-second stall before anything is even being watched.
 *   - THE ENOSPC REFUSAL. On Linux every watched directory costs an inotify
 *     watch, and a big tree exhausts `fs.inotify.max_user_watches`. Node
 *     reports that as a throw at attach time; swallowed, it would look
 *     exactly like a directory where nothing ever happens — a silent
 *     non-delivery. It is surfaced as a named failure instead.
 *   - THE RECURSIVE CAVEAT. On Linux a file created inside a directory that
 *     was itself created during the watch is missed (recorded in
 *     `../fixtures.ts`: the `createNested` capture reports the new directory
 *     and nothing inside it). The result says so rather than letting the
 *     caller assume the tree was covered.
 */
import { type Dirent, readdirSync, watch } from "node:fs";
import * as path from "node:path";
import { type PathFacts, monotonicNow, probePath } from "../host";
import { type CoalesceResult, EventCoalescer, type EventKind, type StopReason } from "./coalesce";

/**
 * A directory larger than this is not reconciled: the read is meant to cost
 * one `readdir` of an ordinary source directory, not a walk of `node_modules`
 * in the middle of a watch.
 */
export const RECONCILE_MAX_ENTRIES = 2_000;

export type WatchEmitter = (eventType: string, filename: string | null) => void;
export type WatchHandle = { close(): void };
export type WatchFactory = (
  target: string,
  options: { readonly recursive: boolean },
  emit: WatchEmitter,
) => WatchHandle;

let factoryOverride: WatchFactory | undefined;

/**
 * Test seam. The default is `fs.watch`; a test supplies a factory that emits
 * a recorded sequence, so the suite never depends on how fast the machine
 * flushes an inotify queue.
 */
export function _setWatchFactory(factory: WatchFactory | undefined): void {
  factoryOverride = factory;
}

export function _watchFactoryInstalled(): boolean {
  return factoryOverride !== undefined;
}

const defaultFactory: WatchFactory = (target, options, emit) => {
  const watcher = watch(target, { recursive: options.recursive }, (eventType, filename) => {
    emit(eventType, typeof filename === "string" ? filename : null);
  });
  // A watcher that keeps the process alive past the deadline is a harness
  // that will not exit; the deadline is the tool's promise, so let the loop
  // close without waiting for it.
  watcher.unref?.();
  return { close: () => watcher.close() };
};

/** What a path looked like the last time this session looked at it. */
export type EntryState = {
  readonly changeStamp: string;
  readonly sizeBytes: number;
};

/** Did anything about the path actually change since it was last seen? */
function differs(before: EntryState | undefined, facts: PathFacts | undefined): boolean {
  if (facts === undefined || before === undefined) return true;
  return before.changeStamp !== facts.changeStamp || before.sizeBytes !== facts.sizeBytes;
}

export type SnapshotResult = {
  /** Slash-relative path → what it looked like. `""` is the watched path itself. */
  readonly entries: ReadonlyMap<string, EntryState>;
  readonly truncated: boolean;
};

/**
 * What exists under `rootAbs` right now, and what it looks like.
 *
 * The NAMES are what tell `created` from `modified`. The mtime and size are
 * for the reconciliation below: on a runtime that drops an event, comparing
 * against these is the only way to notice that a file changed anyway.
 *
 * Bounded by `maxEntries`, and the bound is reported: with a truncated
 * snapshot a modification of an unseen file is indistinguishable from its
 * creation, and a caller should be told that rather than shown a confident
 * `created`.
 */
export function snapshotTree(
  rootAbs: string,
  recursive: boolean,
  maxEntries: number,
): SnapshotResult {
  const entries = new Map<string, EntryState>();
  const facts = probePath(rootAbs);
  if (facts === undefined) return { entries, truncated: false };
  if (!facts.isDirectory) {
    // A watched FILE is its own single entry, named "" the way events for it
    // are named.
    entries.set("", { changeStamp: facts.changeStamp, sizeBytes: facts.sizeBytes });
    return { entries, truncated: false };
  }
  // The watched DIRECTORY is an entry too, under the same `""` a file gets.
  //
  // Not bookkeeping: a notification the OS could not attribute to a child
  // arrives with a null filename and is recorded against `""`. Without the
  // directory in the known set that event reads as "a path that did not exist
  // before and exists now" — so the tool reported `created` for the very
  // directory it had been watching all along, and a `kinds: ["modified"]`
  // filter dropped the only signal the platform gave. Worse, if the directory
  // had just been removed the same event became `deleted` + `transient` (never
  // seen to exist, gone now) and was dropped by default. We know perfectly
  // well that it existed — we stat'd it to start the watch.
  entries.set("", { changeStamp: facts.changeStamp, sizeBytes: facts.sizeBytes });
  const queue: string[] = [""];
  let truncated = false;
  while (queue.length > 0) {
    const relative = queue.shift() as string;
    let dirEntries: Dirent[];
    try {
      dirEntries = readdirSync(relative === "" ? rootAbs : path.join(rootAbs, relative), {
        withFileTypes: true,
      });
    } catch {
      // An unreadable directory is not a reason to abandon the watch; it just
      // contributes nothing to what was known beforehand.
      continue;
    }
    for (const entry of dirEntries) {
      if (entries.size >= maxEntries) {
        truncated = true;
        return { entries, truncated };
      }
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const childFacts = probePath(path.join(rootAbs, ...childRelative.split("/")));
      entries.set(childRelative, {
        changeStamp: childFacts?.changeStamp ?? "",
        sizeBytes: childFacts?.sizeBytes ?? 0,
      });
      // `isDirectory()` is false for a symlink to a directory, which is what
      // is wanted: following one would walk out of the watched tree.
      if (recursive && entry.isDirectory()) queue.push(childRelative);
    }
  }
  return { entries, truncated };
}

export type WatchSessionOptions = {
  readonly rootAbs: string;
  readonly isDirectory: boolean;
  readonly recursive: boolean;
  readonly timeoutMs: number;
  readonly settleMs: number;
  readonly maxEvents: number;
  readonly maxRawEvents: number;
  readonly known: ReadonlyMap<string, EntryState>;
  readonly kinds?: ReadonlySet<EventKind>;
  readonly matches?: (path: string) => boolean;
  readonly dropTransient?: boolean;
  readonly signal?: AbortSignal;
};

export type WatchSessionOutcome = {
  readonly result: CoalesceResult;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  /** Set when the watcher itself failed; the events are whatever arrived first. */
  readonly watchError?: string;
  /** How many events came from reconciliation rather than from a notification. */
  readonly reconciledEvents: number;
  /** Notifications about a path that turned out to be unchanged. */
  readonly staleNotifications: number;
  /**
   * Times the temp-file signature asked for a directory re-read and the read
   * could not be done — too many entries, or the directory could not be read.
   *
   * Counted rather than shrugged off: on the runtime this package is compiled
   * for, the re-read is the ONLY way the commonest event ("my file was
   * saved") is seen at all. Skipping it silently returns "nothing happened"
   * for a save that did.
   */
  readonly reconcileSkipped: number;
};

/**
 * Watch until the deadline, the event cap, an abort, or a watcher failure.
 *
 * Every one of those four is reported by name. A caller that cannot tell a
 * timeout from a satisfied wait will eventually treat one as the other.
 */
export async function runWatchSession(options: WatchSessionOptions): Promise<WatchSessionOutcome> {
  const factory = factoryOverride ?? defaultFactory;
  const coalescer = new EventCoalescer({
    settleMs: options.settleMs,
    maxEvents: options.maxEvents,
    maxRawEvents: options.maxRawEvents,
    // The coalescer only needs the NAMES: mtime is for reconciliation, and
    // classification stays a question of existence.
    known: new Set(options.known.keys()),
    ...(options.kinds !== undefined ? { kinds: options.kinds } : {}),
    ...(options.matches !== undefined ? { matches: options.matches } : {}),
    ...(options.dropTransient !== undefined ? { dropTransient: options.dropTransient } : {}),
  });
  const startedAtMs = monotonicNow();

  let handle: WatchHandle | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let watchError: string | undefined;
  let reconciledEvents = 0;
  let staleNotifications = 0;
  let reconcileSkipped = 0;
  /**
   * What each path looked like the last time this session looked at it,
   * seeded from the pre-watch snapshot. Only the reconciliation below reads
   * it; the classification uses existence, not mtime.
   */
  const lastSeen = new Map<string, EntryState>(options.known);
  /** Directories already reconciled in this window, so one save costs one readdir. */
  let reconciledDirs = new Set<string>();

  return await new Promise<WatchSessionOutcome>((resolve) => {
    const settle = (reason: StopReason): void => {
      if (finished) return;
      finished = true;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        handle?.close();
      } catch {
        // Closing a watcher that already failed throws on some platforms;
        // the events collected so far are still the answer.
      }
      const endedAtMs = monotonicNow();
      resolve({
        result: coalescer.finish(endedAtMs, reason),
        startedAtMs,
        endedAtMs,
        reconciledEvents,
        staleNotifications,
        reconcileSkipped,
        ...(watchError !== undefined ? { watchError } : {}),
      });
    };

    function onAbort(): void {
      settle("aborted");
    }

    if (options.signal?.aborted === true) {
      // An already-aborted signal never fires `abort` again; without this the
      // call would wait out its whole deadline after the turn was cancelled.
      settle("aborted");
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    /**
     * Close any group that has gone quiet, then stop if the cap is full.
     * Re-armed after every event, so the cap can end the watch the moment the
     * last event settles rather than at the deadline.
     */
    const scheduleSettleCheck = (): void => {
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (finished) return;
        coalescer.advanceTo(monotonicNow());
        // A new window: a directory may be worth looking at again.
        reconciledDirs = new Set<string>();
        if (coalescer.capReached()) settle("eventCap");
      }, options.settleMs + 1);
    };

    /** Push one event and keep `lastSeen` in step with what was observed. */
    const record = (relative: string, eventType: string): void => {
      const absolute = relative === "" ? options.rootAbs : path.join(options.rootAbs, relative);
      const facts = probePath(absolute);
      if (facts === undefined) {
        lastSeen.delete(relative);
      } else {
        lastSeen.set(relative, { changeStamp: facts.changeStamp, sizeBytes: facts.sizeBytes });
      }
      coalescer.push({
        atMs: monotonicNow(),
        eventType,
        path: relative,
        existsNow: facts !== undefined,
      });
    };

    /**
     * Look at one directory and report what changed without being told.
     *
     * THIS EXISTS BECAUSE A RUNTIME DROPS THE EVENT THAT MATTERS. Recorded on
     * macOS 15.6: `fs.watch` on a DIRECTORY under Bun 1.3.14 reports an
     * editor's temp file appearing and vanishing, and reports NOTHING for the
     * rename that puts it over the target — where Node on the same machine
     * reports both. So the single most common case a caller watches for, "my
     * file was saved", arrives as two events about a file they never asked
     * about and no event about the one they did.
     *
     * No amount of processing recovers an event that never arrived, but the
     * filesystem still holds the evidence: the target's mtime and size have
     * moved since the snapshot. So when a path we never knew about vanishes —
     * the exact signature of a temp file — the containing directory is read
     * once and anything that differs from what this session last saw becomes
     * an event, tagged `reconciled` so the caller can see where it came from.
     *
     * Bounded on both sides: once per directory per settle window, and only
     * for a directory small enough that the read is cheap.
     */
    const reconcileDirectory = (relativeDir: string): void => {
      if (reconciledDirs.has(relativeDir)) return;
      reconciledDirs.add(relativeDir);
      const absoluteDir =
        relativeDir === ""
          ? options.rootAbs
          : path.join(options.rootAbs, ...relativeDir.split("/"));
      let entries: Dirent[];
      try {
        entries = readdirSync(absoluteDir, { withFileTypes: true });
      } catch {
        // The directory could not be read — it was removed under us, or its
        // permissions do not allow it. Either way this is "could not look",
        // not "nothing had changed".
        reconcileSkipped += 1;
        return;
      }
      if (entries.length > RECONCILE_MAX_ENTRIES) {
        reconcileSkipped += 1;
        return;
      }
      for (const entry of entries) {
        const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
        const facts = probePath(path.join(absoluteDir, entry.name));
        if (facts === undefined) continue;
        if (!differs(lastSeen.get(relative), facts)) continue;
        reconciledEvents += 1;
        record(relative, "reconciled");
      }
    };

    const emit: WatchEmitter = (eventType, filename) => {
      if (finished) return;
      // A null filename means the OS did not say which entry changed; it is
      // attributed to the watched path itself rather than dropped, because
      // "something happened here" is still the answer to the question asked.
      const relative = options.isDirectory ? toPosix(filename ?? "") : "";
      const absolute = relative === "" ? options.rootAbs : path.join(options.rootAbs, relative);
      // Defensive: a `..` in a reported filename would name a path outside
      // the watched tree, which this tool never reports.
      if (absolute !== options.rootAbs && !absolute.startsWith(`${options.rootAbs}${path.sep}`)) {
        return;
      }
      const facts = probePath(absolute);
      const vanished = facts === undefined;
      // Measured against the PRE-WATCH snapshot, not against what this
      // session has seen since. A temp file can arrive as one event (macOS
      // coalesces the create and the delete) or as two (Linux reports them
      // separately); keying on `lastSeen` would recognise the first shape and
      // miss the second, because by the second event the path is something
      // this session has already seen.
      const wasUnknown = !options.known.has(relative);

      // A notification about a path that is demonstrably unchanged — same
      // change stamp, same size as when this session last looked — is not a
      // change. macOS delivers exactly this: a write made moments
      // BEFORE the watch was attached arrives as the watch's first event
      // (observed on macOS 15.6 under Bun 1.3.14), so a caller who writes a
      // file and then waits for the next change is told at once that it
      // changed. The one blind spot is a change that preserves all three,
      // which takes deliberate effort to produce.
      //
      // A notification with NO filename is exempt: it says only "something
      // happened here", so there is nothing to compare and dropping it would
      // lose the only signal the platform gave.
      if (filename !== null && !vanished && !differs(lastSeen.get(relative), facts)) {
        staleNotifications += 1;
        return;
      }
      record(relative, eventType);
      // The temp-file signature: something we never knew about is already
      // gone again. That is when an editor has just finished a save the
      // runtime may not have told us about.
      if (options.isDirectory && vanished && wasUnknown && !coalescer.capReached()) {
        const slash = relative.lastIndexOf("/");
        reconcileDirectory(slash === -1 ? "" : relative.slice(0, slash));
      }
      if (coalescer.capReached()) {
        settle("eventCap");
        return;
      }
      scheduleSettleCheck();
    };

    try {
      handle = factory(options.rootAbs, { recursive: options.recursive }, emit);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      watchError =
        code === "ENOSPC"
          ? "the kernel refused another watch (ENOSPC): on Linux this is the per-user inotify limit, fs.inotify.max_user_watches, which a large tree exhausts — watch a subdirectory, or raise the limit"
          : `the watcher could not be attached: ${err instanceof Error ? err.message : String(err)}`;
      settle("watchError");
      return;
    }

    // NOT unref'd, deliberately. This timer is the only thing guaranteed to
    // keep the event loop alive while nothing is happening on disk; unref it
    // and a quiet watch lets the process exit with the promise unresolved —
    // a tool call that never returns at all.
    deadlineTimer = setTimeout(() => settle("deadline"), options.timeoutMs);
  });
}

function toPosix(value: string): string {
  return path.sep === "/" ? value : value.split(path.sep).join("/");
}
