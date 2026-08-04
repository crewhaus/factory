/**
 * Run history + the live run feed.
 *
 * THE CAPTURE RULE. `logs/<runId>.log` is the raw child stream and is
 * UNSCRUBBED by construction — the scrubber sits on the pump, once, on the
 * way out. So nothing here ever serves that file directly: history comes
 * from `replayRunEvents()` (events the pump already scrubbed on write) and
 * `readLogTail(logFile, scrub)` (scrubbed on read), and the live feed comes
 * from `supervisor.subscribe()`, whose `output` events are scrubbed before
 * they are emitted.
 *
 * Every harness-relative read still goes through `resolveInside`. A `runId`
 * is `run_<16hex>` and therefore safe as a path segment on its face, but
 * "safe on its face" is exactly the assumption a planted symlink inside the
 * run dir defeats.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type ExitClassification,
  RUN_ID_RE,
  type RunLedgerEntry,
  type Scrubber,
  type SupervisorEvent,
  createEnvScrubber,
  loadEnvChain,
  readLogTail,
  readRunLedger,
  replayRunEvents,
} from "@crewhaus/harness-supervisor";
import { MAX_JSONL_LINES } from "./constants";
import { maskDeep } from "./mask";
import { resolveInside } from "./safety";

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

/** A scrubber built from the harness's own `.env` chain — the same default
 *  the supervisor uses, so an adopted run (whose spawn env this process never
 *  built) is scrubbed identically. */
export function harnessScrubber(harnessDir: string): Scrubber {
  return createEnvScrubber(loadEnvChain(harnessDir).vars);
}

/** One run: ledger row + scrubbed events + scrubbed prose tail. */
export function runDetail(
  harnessDir: string,
  runId: string,
  opts: { readonly live?: boolean; readonly maxEvents?: number } = {},
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
  const maxEvents = opts.maxEvents ?? MAX_JSONL_LINES;
  const all = eventsFile === undefined ? [] : replayRunEvents(eventsFile);
  const events = all.slice(Math.max(0, all.length - maxEvents));
  return {
    runId,
    entry,
    live: opts.live === true,
    // maskDeep on top of the pump's env scrubbing: the scrubber knows the
    // harness's own credential VALUES, the masker knows credential SHAPES.
    events: events.map((e) => maskDeep(e)),
    eventsTruncated: all.length > events.length,
    proseTail:
      logFile === undefined ? [] : readLogTail(logFile, harnessScrubber(harnessDir)).map(String),
  };
}

/** Whether a runId names a run that produced captured artifacts. */
export function runArtifactsExist(harnessDir: string, runId: string): boolean {
  if (!isSupervisorRunId(runId)) return false;
  const p = resolveInside(harnessDir, [".crewhaus", "run", "logs", `${runId}.events.jsonl`]);
  return p !== undefined && existsSync(p);
}

// ---------------------------------------------------------------------------
// SSE — the live run feed
// ---------------------------------------------------------------------------

/** The SSE event names this server emits. Named here (and in the route map)
 *  so the UI and the server cannot drift on them. */
export const SSE_EVENTS = ["state", "output", "exit", "replay", "done"] as const;
export type SseEventName = (typeof SSE_EVENTS)[number];

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-content-type-options": "nosniff",
};

function frame(event: SseEventName, data: unknown): string {
  // One JSON object per frame; newlines inside the payload are impossible
  // because JSON.stringify escapes them, so a single `data:` line is safe.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export type RunStreamOptions = {
  readonly harnessDir: string;
  readonly runId: string;
  /** The run's durable history, replayed as the first frame. */
  readonly replay: RunDetail;
  /** Present only when this run is the supervisor's current run. */
  readonly subscribe?: (listener: (event: SupervisorEvent) => void) => () => void;
  /** Live only when the supervisor is actually on this run. */
  readonly live: boolean;
  /** Cap on live frames before the stream closes itself (a runaway daemon
   *  must not be able to hold a browser connection open forever). */
  readonly maxFrames?: number;
  readonly signal?: AbortSignal;
};

export const MAX_SSE_FRAMES = 5_000;

/**
 * Bridge `supervisor.subscribe()` onto an SSE body.
 *
 * The stream ALWAYS opens with a `replay` frame (durable history) and ALWAYS
 * ends with `done` — including immediately, when the run is already closed.
 * A terminal frame is what lets the client distinguish "finished" from
 * "connection dropped", and it is what makes this endpoint testable without
 * a live process.
 */
export function runEventStream(options: RunStreamOptions): Response {
  const maxFrames = options.maxFrames ?? MAX_SSE_FRAMES;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let frames = 0;
      let closed = false;
      // `finish` closes over this BEFORE the subscription exists — a send
      // during the replay frame can already finish the stream — so the
      // binding has to be declared ahead of its assignment.
      // biome-ignore lint/style/useConst: forward-referenced by finish()
      let unsubscribe: (() => void) | undefined;

      const send = (event: SseEventName, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame(event, data)));
        } catch {
          // The client went away mid-write; finish() cleans up.
          finish("client-gone");
          return;
        }
        frames += 1;
        if (frames >= maxFrames) finish("frame-cap");
      };

      const finish = (reason: string): void => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        try {
          controller.enqueue(encoder.encode(frame("done", { runId: options.runId, reason })));
          controller.close();
        } catch {
          // Already closed by the runtime — nothing left to do.
        }
      };

      send("replay", options.replay);

      if (!options.live || options.subscribe === undefined) {
        finish("closed");
        return;
      }

      unsubscribe = options.subscribe((event) => {
        switch (event.type) {
          case "state":
            send("state", { snapshot: event.snapshot });
            if (
              event.snapshot.runId === options.runId &&
              event.snapshot.state !== "running" &&
              event.snapshot.state !== "draining" &&
              event.snapshot.state !== "starting"
            ) {
              finish("state-terminal");
            }
            break;
          case "output":
            if (event.runId !== options.runId) return;
            send("output", {
              runId: event.runId,
              prose: event.prose,
              events: event.events.map((e) => maskDeep(e)),
            });
            break;
          case "exit":
            if (event.runId !== options.runId) return;
            send("exit", {
              runId: event.runId,
              classification: event.classification satisfies ExitClassification,
            });
            finish("exit");
            break;
        }
      });

      options.signal?.addEventListener("abort", () => finish("aborted"), { once: true });
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** Path of a run's captured log, containment-checked. Exported for the
 *  `crewhaus daemon logs` verb, which reads it through the same scrubber. */
export function runLogFile(harnessDir: string, runId: string): string | undefined {
  if (!isSupervisorRunId(runId)) return undefined;
  return resolveInside(harnessDir, [".crewhaus", "run", "logs", `${runId}.log`]) ?? undefined;
}

/** `.crewhaus/run` under a harness, containment-checked. */
export function runDirOf(harnessDir: string): string {
  return join(harnessDir, ".crewhaus", "run");
}
