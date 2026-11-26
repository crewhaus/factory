/**
 * Run history, read back: the run ledger newest first, and one run's detail —
 * its ledger row, its extracted events, and the scrubbed tail of its log.
 *
 * THE CAPTURE RULE. `logs/<runId>.log` is the raw child stream and is
 * UNSCRUBBED by construction — the scrubber sits on the pump, once, on the
 * way out. So nothing here ever serves that file directly: history comes
 * from `replayRunEvents()` (events the pump already scrubbed on write) and
 * `readLogTail(logFile, scrub)` (scrubbed on read).
 *
 * The SERVING layer decides how hard to scrub. `runDetail` takes two seams —
 * `makeScrubber` (which values to replace) and `mapEvent` (what to do to each
 * event) — and defaults to the merged-spawn-env scrubber the live pump runs
 * plus a value-only {@link scrubDeep}. A server that also masks credential
 * SHAPES injects its own; `@crewhaus/hangar-server` does, through a wrapper
 * that keeps the signature `runDetail` had there. This module moved here from
 * that package, which still re-exports what it does not wrap, for one release.
 *
 * Every harness-relative read still goes through `resolveInside`. A `runId`
 * is `run_<16hex>` and therefore safe as a path segment on its face, but
 * "safe on its face" is exactly the assumption a planted symlink inside the
 * run dir defeats.
 */
import { closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openRecordFd, readAt } from "@crewhaus/control-records";
import { resolveInside } from "./containment";
import { spawnEnvScrubber } from "./harness-scrub";
import { RUN_ID_RE, readPrunedRuns, readRunLedger, readRunLedgerView } from "./runfiles";
import { type Scrubber, scrubDeep } from "./scrub";
import { RUN_INDEX_MAX_BYTES, parseRunIndex, readLogTail, replayRunEvents } from "./trace-pump";
import { LOGS_DIR_NAME, RUN_DIR_SEGMENTS, type RunLedgerEntry } from "./types";

/** Events kept per run when the caller names no cap — the same figure as the
 *  manager server's JSONL line cap, which is what it passes. */
const DEFAULT_MAX_EVENTS = 5000;

export function isSupervisorRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

/** Newest-first ledger rows, capped. */
export const MAX_LEDGER_ROWS = 200;

export type RunsView = {
  readonly runs: readonly RunLedgerEntry[];
  readonly truncated: boolean;
};

/** The run ledger, newest first. Torn lines are already tolerated by the
 *  supervisor's folding reader. `truncated` when rows past `limit` were left
 *  out, or the ledger read stopped short of its oldest bytes. */
export function runsView(harnessDir: string, limit: number = MAX_LEDGER_ROWS): RunsView {
  let all: RunLedgerEntry[];
  let capped: boolean;
  try {
    const view = readRunLedgerView(harnessDir);
    all = view.entries;
    capped = view.truncated;
  } catch {
    return { runs: [], truncated: false };
  }
  all.reverse();
  return { runs: all.slice(0, limit), truncated: capped || all.length > limit };
}

export type RunDetail = {
  readonly runId: string;
  readonly entry: RunLedgerEntry | null;
  /** Whether the run is the supervisor's CURRENT run (live feed available). */
  readonly live: boolean;
  /** Scrubbed TraceEvents the pump extracted, capped. */
  readonly events: readonly unknown[];
  readonly eventsTruncated: boolean;
  /** Scrubbed trailing prose lines from the captured log. */
  readonly proseTail: readonly string[];
};

/** One run: ledger row + scrubbed events + scrubbed prose tail. */
export function runDetail(
  harnessDir: string,
  runId: string,
  opts: {
    readonly live?: boolean;
    readonly maxEvents?: number;
    /** The manager's environment — the base layer of the spawn env, and so
     *  of the default tail scrubber. Defaults to this process's own. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Builds the ONE scrubber both halves of the payload use. Called once,
     *  and only for a run that exists. Defaults to {@link spawnEnvScrubber}
     *  over `env`. */
    readonly makeScrubber?: () => Scrubber;
    /** Applied to every event with that scrubber. Defaults to
     *  {@link scrubDeep}, which replaces values and nothing else. */
    readonly mapEvent?: (event: unknown, scrub: Scrubber) => unknown;
  } = {},
): RunDetail | undefined {
  if (!isSupervisorRunId(runId)) return undefined;
  const eventsFile = resolveInside(harnessDir, [
    ".crewhaus",
    "run",
    "logs",
    `${runId}.events.jsonl`,
  ]);
  const logFile = resolveInside(harnessDir, [".crewhaus", "run", "logs", `${runId}.log`]);
  const entry = readRunLedger(harnessDir).find((r) => r.runId === runId) ?? null;
  // A run with no ledger row AND no captured artifacts never existed here.
  if (entry === null && (eventsFile === undefined || !existsSync(eventsFile))) return undefined;
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const all = eventsFile === undefined ? [] : replayRunEvents(eventsFile);
  const events = all.slice(Math.max(0, all.length - maxEvents));
  // ONE scrubber for BOTH halves of this payload. It sat on `proseTail` alone
  // once, so the same response contradicted itself: an opaque credential this
  // manager holds came back as `«NAME»` in the tail and verbatim in the
  // events array beside it. The events were persisted by a pump that scrubbed
  // with the SPAWN env — but an adopted run's events were written by a pump
  // this process never built, so "already scrubbed" is an assumption, not a
  // guarantee, and re-scrubbing a scrubbed string costs nothing.
  const scrub =
    opts.makeScrubber !== undefined
      ? opts.makeScrubber()
      : spawnEnvScrubber(harnessDir, opts.env ?? process.env);
  const mapEvent = opts.mapEvent ?? scrubDeep;
  return {
    runId,
    entry,
    live: opts.live === true,
    events: events.map((e) => mapEvent(e, scrub)),
    eventsTruncated: all.length > events.length,
    proseTail: logFile === undefined ? [] : readLogTail(logFile, scrub).map(String),
  };
}

/** Path of a run's captured log, containment-checked. Exported for the
 *  `crewhaus daemon logs` verb, which reads it through the same scrubber. */
export function runLogFile(harnessDir: string, runId: string): string | undefined {
  if (!isSupervisorRunId(runId)) return undefined;
  return resolveInside(harnessDir, [".crewhaus", "run", "logs", `${runId}.log`]) ?? undefined;
}

/** The most bytes of an execution's events file {@link runEventsAt} reads by default. */
export const RUN_EVENTS_READ_MAX_BYTES = 8 * 1024 * 1024;

/** One persisted event and where its line starts in the events file. */
export type ExecutionEventEntry = { readonly off: number; readonly event: Record<string, unknown> };

/** One execution's persisted events, read from an offset. */
export type ExecutionEventsRead = {
  /** The events file is there and was opened. */
  readonly present: boolean;
  /** It is not there, and retention's prune record names the execution. */
  readonly pruned: boolean;
  /** Why the file was there and not read: a link at its name, or not a regular file. */
  readonly refused?: string;
  readonly entries: readonly ExecutionEventEntry[];
  /** The byte budget ran out before the end of the file. */
  readonly truncated: boolean;
  /** How many lines did not parse, the last one cut short included. */
  readonly torn: number;
  /** `index`: reading began at the run's index entry. `scan`: at the start of the file. */
  readonly from: "index" | "scan";
};

const READ_CHUNK = 256 * 1024;

/**
 * Where `run`'s first event sits in the execution's events file, from its run index:
 * the smallest offset an entry names below `size`. `undefined` with no usable entry.
 */
function indexedOffset(harnessDir: string, exec: string, run: string, size: number) {
  const rel = join(...RUN_DIR_SEGMENTS, LOGS_DIR_NAME, `${exec}.runs.jsonl`);
  const opened = openRecordFd(harnessDir, rel);
  if (!opened.ok) return undefined;
  try {
    const length = Math.min(opened.stats.size, RUN_INDEX_MAX_BYTES);
    const buf = new Uint8Array(length);
    const got = readAt(opened.fd, buf, length, 0);
    let best: number | undefined;
    for (const entry of parseRunIndex(new TextDecoder().decode(buf.subarray(0, got)))) {
      if (entry.run !== run || entry.off >= size) continue;
      if (best === undefined || entry.off < best) best = entry.off;
    }
    return best;
  } catch {
    return undefined;
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * An execution's persisted events, each with the byte offset its line starts at: the
 * events file is opened contained to the harness (a link at its name is refused, and the
 * opened descriptor is checked to lie inside), never through `<exec>.log`. With `run`, only
 * that run's events, read from the run's entry in the execution's run index when there
 * is one (`from: "index"`), else from the start (`from: "scan"`). At most `maxBytes` are
 * read (`truncated`); a line that does not parse is counted (`torn`) and skipped. Every
 * event is scrubbed again, as {@link runDetail} does. A missing file says whether
 * retention removed it (`pruned`). Reads only.
 */
export function runEventsAt(
  harnessDir: string,
  exec: string,
  opts: {
    readonly run?: string;
    readonly maxBytes?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly scrub?: Scrubber;
  } = {},
): ExecutionEventsRead {
  const none = (extra: Partial<ExecutionEventsRead> = {}): ExecutionEventsRead => ({
    present: false,
    pruned: false,
    entries: [],
    truncated: false,
    torn: 0,
    from: "scan",
    ...extra,
  });
  if (!isSupervisorRunId(exec)) return none();
  const rel = join(...RUN_DIR_SEGMENTS, LOGS_DIR_NAME, `${exec}.events.jsonl`);
  const opened = openRecordFd(harnessDir, rel);
  if (!opened.ok) {
    if (opened.code === "not-found") return none({ pruned: readPrunedRuns(harnessDir).has(exec) });
    return none({ refused: opened.reason });
  }
  const maxBytes = opts.maxBytes ?? RUN_EVENTS_READ_MAX_BYTES;
  try {
    const size = opened.stats.size;
    let start = 0;
    let from: "index" | "scan" = "scan";
    if (opts.run !== undefined) {
      const at = indexedOffset(harnessDir, exec, opts.run, size);
      if (at !== undefined) {
        start = at;
        from = "index";
      }
    }
    // An index entry the pump wrote begins a line; one that no longer does (the file was
    // cut and written again past it) begins a fragment, which is skipped, not counted.
    let first = start > 0;
    const scrub = opts.scrub ?? spawnEnvScrubber(harnessDir, opts.env ?? process.env);
    const entries: ExecutionEventEntry[] = [];
    let torn = 0;
    const limit = Math.min(size, start + maxBytes);
    let pos = start;
    let carry = new Uint8Array(0);
    let carryOff = start;
    const handle = (off: number, bytes: Uint8Array): void => {
      const fragment = first;
      first = false;
      const text = new TextDecoder().decode(bytes);
      if (text.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        if (!fragment) torn += 1;
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        if (!fragment) torn += 1;
        return;
      }
      const event = parsed as Record<string, unknown>;
      if (opts.run !== undefined && event["runId"] !== opts.run) return;
      entries.push({ off, event: scrubDeep(event, scrub) as Record<string, unknown> });
    };
    while (pos < limit) {
      const want = Math.min(READ_CHUNK, limit - pos);
      const buf = new Uint8Array(want);
      const got = readAt(opened.fd, buf, want, pos);
      if (got <= 0) break;
      pos += got;
      const data = new Uint8Array(carry.length + got);
      data.set(carry, 0);
      data.set(buf.subarray(0, got), carry.length);
      let lineStart = 0;
      for (;;) {
        const nl = data.indexOf(10, lineStart);
        if (nl === -1) break;
        handle(carryOff + lineStart, data.subarray(lineStart, nl));
        lineStart = nl + 1;
      }
      carryOff += lineStart;
      carry = data.slice(lineStart);
    }
    const truncated = pos < size;
    // A last line with no newline at the end of the file is one cut short.
    if (!truncated && carry.length > 0) torn += 1;
    return { present: true, pruned: false, entries, truncated, torn, from };
  } catch {
    return none({ present: true, refused: "the events file could not be read" });
  } finally {
    closeSync(opened.fd);
  }
}
