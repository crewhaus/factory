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
import { existsSync } from "node:fs";
import { resolveInside } from "./containment";
import { spawnEnvScrubber } from "./harness-scrub";
import { RUN_ID_RE, readRunLedger } from "./runfiles";
import { type Scrubber, scrubDeep } from "./scrub";
import { readLogTail, replayRunEvents } from "./trace-pump";
import type { RunLedgerEntry } from "./types";

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
 *  supervisor's folding reader. */
export function runsView(harnessDir: string, limit: number = MAX_LEDGER_ROWS): RunsView {
  let all: RunLedgerEntry[];
  try {
    all = readRunLedger(harnessDir);
  } catch {
    return { runs: [], truncated: false };
  }
  all.reverse();
  return { runs: all.slice(0, limit), truncated: all.length > limit };
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
