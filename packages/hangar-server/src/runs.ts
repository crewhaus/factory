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
 * HISTORY IS SCRUBBED TO THE SAME STANDARD AS THE LIVE FEED, and that takes
 * BOTH layers, on BOTH paths:
 *   - the env scrubber is built from the MERGED spawn env (`.env` chain
 *     UNDER the manager's own environment), because that is the record the
 *     pump scrubbed the live frames with — a key exported into the shell
 *     that launched `crewhaus hangar` is in the daemon's env and therefore
 *     in its log, but in no `.env` file;
 *   - `maskDeep` runs on the serialized detail, because a credential with no
 *     env entry at all (an OAuth token echoed back by a tool) can only be
 *     caught by SHAPE.
 * `runEventStream` masks the `replay` frame and the live `output` prose for
 * the same reason, so the stream and `GET /runs/:runId` cannot drift.
 *
 * Every harness-relative read still goes through `resolveInside`. A `runId`
 * is `run_<16hex>` and therefore safe as a path segment on its face, but
 * "safe on its face" is exactly the assumption a planted symlink inside the
 * run dir defeats.
 *
 * WHERE THE HISTORY READERS LIVE. The ledger view, run detail, the log-path
 * lookup and the two env scrubbers moved to `@crewhaus/harness-supervisor`
 * (run detail is its `./run-detail` subpath), so `crewhaus daemon` reads run
 * history without depending on this HTTP server. They are re-exported here,
 * as the same bindings, for one release. `runDetail` is the exception: it
 * stays a wrapper, because the masker stays at this server's exit — it
 * injects {@link safeSpawnEnvScrubber} and `maskDeep` into the moved reader.
 * Exit masking (the spec-credential scrubber and the Hangar allow-list) and
 * the SSE bridge stay here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExitClassification,
  type SupervisionState,
  type SupervisorEvent,
  createEnvScrubber,
  harnessScrubber,
  spawnEnvScrubber,
} from "@crewhaus/harness-supervisor";
import {
  MAX_LEDGER_ROWS,
  type RunDetail,
  type RunsView,
  isSupervisorRunId,
  runDetail as readRunDetail,
  runLogFile,
  runsView,
} from "@crewhaus/harness-supervisor/run-detail";
import { REDACTED_VALUE, isCredentialKey } from "@crewhaus/spec-patch";
import { MAX_JSONL_LINES } from "./constants";
import { mergedSpawnEnv } from "./env-file";
import { hasLineBreak } from "./linear-mask";
import { type TextScrubber, maskDeep, maskText } from "./mask";
import { resolveInside } from "./safety";

export {
  harnessScrubber,
  isSupervisorRunId,
  MAX_LEDGER_ROWS,
  runLogFile,
  runsView,
  spawnEnvScrubber,
  type RunDetail,
  type RunsView,
};

/**
 * Credential VALUES written as literals in the harness's own spec, keyed by
 * the spec key that held them.
 *
 * The `.env` scrubber covers what the harness keeps in `.env`. It cannot
 * cover an INLINE literal — `channels.slack.signingSecret: <value>` — and
 * key-based redaction only fires where the value sits under its key. The
 * same value quoted in an agent's `instructions`, echoed into a memory fact,
 * or copied into a continuity note has no key and (below the opaque-token
 * threshold) no shape, so nothing catches it.
 *
 * The manager DOES hold the value: it read the spec. So it belongs in the
 * scrub set for exactly the reason `.env` values do. Detection is by key —
 * `isCredentialKey` — not by shape, so a short literal is caught too.
 */
export function specCredentialValues(harnessDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(join(harnessDir, SPEC_FILENAME), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    // A line holding a `\r` or a U+2028 cannot match: `(.*)$` stops at it.
    // The pattern finds that out only after giving back the run before the
    // value one character at a time, quadratic in the run, and a model writes
    // this text too (`crewhaus init`, an optimizer write-back of
    // `agent.instructions`) while this runs for every response served.
    const m = hasLineBreak(line) ? null : line.match(SPEC_SCALAR_LINE_RE);
    if (m === null) continue;
    const [, key = "", rawValue = ""] = m;
    const value = unquote(rawValue.trim());
    // A `$VAR` reference is a NAME, not a value — and is the shape we WANT
    // operators to see. Empty and `[redacted]` are not secrets either.
    if (value === "" || value.startsWith("$") || value === REDACTED_VALUE) continue;
    if (!isCredentialKey(key)) continue;
    out[key] = value;
  }
  return out;
}

const SPEC_FILENAME = "crewhaus.yaml";
const SPEC_SCALAR_LINE_RE = /^[ \t]*(?:- )?([A-Za-z0-9_.-]+):[ \t]*(.*)$/;

function unquote(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Operational variables Hangar's payloads quote, on top of
 * harness-supervisor's `NON_SECRET_ENV_KEYS`: `CREWHAUS_TENANTS_ROOT` is a
 * directory, as `CREWHAUS_SESSION_DIR` (exempt there) is, and the proof
 * route's rows and CLI twins name it (0.8.0 §12 item 5) — masked to
 * `«CREWHAUS_TENANTS_ROOT»`, a twin would not run when pasted.
 */
const HANGAR_NON_SECRET_KEYS: readonly string[] = ["CREWHAUS_TENANTS_ROOT"];

/**
 * {@link spawnEnvScrubber} widened with {@link specCredentialValues}, and
 * degrading to the identity scrubber rather than throwing: an unreadable
 * `.env` chain must not take a read down, and the shape masker still runs
 * underneath whatever this returns.
 */
export function safeSpawnEnvScrubber(
  harnessDir: string,
  processEnv: Readonly<Record<string, string | undefined>>,
): TextScrubber {
  try {
    // Env first, and a spec value added ONLY when no env entry already
    // carries it: the placeholder an operator sees is the NAME the scrubber
    // found the value under, and the env name is the one they set. Merging
    // the other way silently renamed «PLANTED_SECRET» to «HELPER_TOKEN» for
    // a value that happened to appear under both.
    const env = mergedSpawnEnv(processEnv, harnessDir).env;
    const known = new Set(Object.values(env).filter((v): v is string => typeof v === "string"));
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") merged[key] = value;
    }
    for (const [key, value] of Object.entries(specCredentialValues(harnessDir))) {
      if (!known.has(value)) merged[key] = value;
    }
    return createEnvScrubber(merged, { allowKeys: HANGAR_NON_SECRET_KEYS });
  } catch {
    try {
      return createEnvScrubber(specCredentialValues(harnessDir));
    } catch {
      return (text) => text;
    }
  }
}

/**
 * One run: ledger row + scrubbed events + scrubbed prose tail.
 *
 * The reader is `@crewhaus/harness-supervisor/run-detail`'s; this wrapper
 * keeps the signature it had before the reader moved, and supplies the two
 * things that stay at this server's exit: {@link safeSpawnEnvScrubber} (the
 * spawn env widened with the spec's own credential values) and `maskDeep`, so
 * `GET /runs/:runId` and the SSE `replay` frame are byte-identical to what
 * they were.
 */
export function runDetail(
  harnessDir: string,
  runId: string,
  opts: {
    readonly live?: boolean;
    readonly maxEvents?: number;
    /** The manager's environment — the base layer of the spawn env, and so
     *  of the tail scrubber. Defaults to this process's own. */
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): RunDetail | undefined {
  return readRunDetail(harnessDir, runId, {
    ...(opts.live !== undefined ? { live: opts.live } : {}),
    maxEvents: opts.maxEvents ?? MAX_JSONL_LINES,
    makeScrubber: () => safeSpawnEnvScrubber(harnessDir, opts.env ?? process.env),
    // maskDeep on top of the env scrubbing: the scrubber knows the harness's
    // own credential VALUES, the masker knows credential SHAPES.
    mapEvent: maskDeep,
  });
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
 *  so the UI and the server cannot drift on them. `auth.expired` and
 *  `auth.revoked` come just before `done` when the session that opened the
 *  stream ends: the console takes them as it takes a 401. */
export const SSE_EVENTS = [
  "state",
  "output",
  "exit",
  "replay",
  "done",
  "auth.expired",
  "auth.revoked",
] as const;
export type SseEventName = (typeof SSE_EVENTS)[number];

/** An abort reason that names the event a stream closes with. */
const CLOSING_EVENTS: ReadonlySet<string> = new Set(["auth.expired", "auth.revoked"]);

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-content-type-options": "nosniff",
};

/**
 * The supervision states in which the pump is still serving this run — the
 * window the live feed must stay open for.
 *
 * `draining` is the one that matters: a drain runs the control call, then
 * waits out the stop grace, then a SIGTERM grace on top — up to ~30 s during
 * which the operator has just clicked Drain and asked to watch it finish.
 * Gating the feed on `running` alone answers that click with "stream closed".
 */
export const LIVE_FEED_STATES: ReadonlySet<SupervisionState> = new Set<SupervisionState>([
  "starting",
  "running",
  "draining",
]);

export function isLiveFeedState(state: SupervisionState): boolean {
  return LIVE_FEED_STATES.has(state);
}

/**
 * How often a live stream emits a `: ping` comment frame.
 *
 * Two things kill a quiet SSE connection, and one interval answers both: the
 * server's own socket idle timeout (Bun's default is 10 s — see
 * `SSE_IDLE_TIMEOUT_SECONDS`), and any proxy in between that buffers a
 * response until it sees bytes. A heartbeat-shaped daemon can be silent for
 * a minute at a time, which is precisely the case the live console exists
 * for, so silence must not read as death.
 */
export const SSE_HEARTBEAT_MS = 15_000;

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
  /** The harness's env scrubber, so the stream masks to the same standard
   *  `GET /runs/:runId` does. Defaults to the identity scrubber, which leaves
   *  only the SHAPE layer — never pass nothing on a real request. */
  readonly scrub?: TextScrubber;
  /** Cap on live frames before the stream closes itself (a runaway daemon
   *  must not be able to hold a browser connection open forever). */
  readonly maxFrames?: number;
  /** Keep-alive cadence; see {@link SSE_HEARTBEAT_MS}. Tests shorten it. */
  readonly heartbeatMs?: number;
  /** Closes the stream. An abort whose `reason` is `"auth.expired"` or
   *  `"auth.revoked"` writes that event, with `{}`, before `done`. */
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
  const scrub: TextScrubber = options.scrub ?? ((text) => text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let frames = 0;
      let closed = false;
      // `finish` closes over these BEFORE they exist — a send during the
      // replay frame can already finish the stream — so the bindings have to
      // be declared ahead of their assignment.
      // biome-ignore lint/style/useConst: forward-referenced by finish()
      let unsubscribe: (() => void) | undefined;
      // biome-ignore lint/style/useConst: forward-referenced by finish()
      let heartbeat: ReturnType<typeof setInterval> | undefined;

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
        if (heartbeat !== undefined) clearInterval(heartbeat);
        try {
          if (CLOSING_EVENTS.has(reason)) {
            controller.enqueue(encoder.encode(frame(reason as SseEventName, {})));
          }
          controller.enqueue(encoder.encode(frame("done", { runId: options.runId, reason })));
          controller.close();
        } catch {
          // Already closed by the runtime — nothing left to do.
        }
      };

      // maskDeep on the way out: `replay` carries the run's prose tail, which
      // is the one payload built from the raw capture file rather than from
      // the pump's already-masked events. The env scrubber rides with it, or
      // the stream serves in cleartext what `GET /runs/:runId` hides.
      send("replay", maskDeep(options.replay, scrub));

      if (!options.live || options.subscribe === undefined) {
        finish("closed");
        return;
      }

      // A COMMENT frame, not an event: it keeps the socket (and any buffering
      // proxy) awake without appearing in the client's `onmessage` or
      // counting against `maxFrames`.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          finish("client-gone");
        }
      }, options.heartbeatMs ?? SSE_HEARTBEAT_MS);
      // Never hold the process open for a keep-alive.
      (heartbeat as { unref?: () => void }).unref?.();

      unsubscribe = options.subscribe((event) => {
        switch (event.type) {
          case "state":
            send("state", { snapshot: event.snapshot });
            if (event.snapshot.runId === options.runId && !isLiveFeedState(event.snapshot.state)) {
              finish("state-terminal");
            }
            break;
          case "output":
            if (event.runId !== options.runId) return;
            send("output", {
              runId: event.runId,
              // The pump's env scrubber already ran; re-running ours is free
              // and covers an ADOPTED pump this process never configured,
              // and then the SHAPE layer, so a credential in no env file
              // cannot ride the live feed out while history (maskDeep'd)
              // hides it.
              prose: maskText(scrub(event.prose)),
              events: event.events.map((e) => maskDeep(e, scrub)),
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

      const onAbort = (): void => {
        const why = options.signal?.reason;
        finish(typeof why === "string" && CLOSING_EVENTS.has(why) ? why : "aborted");
      };
      if (options.signal?.aborted === true) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** `.crewhaus/run` under a harness, containment-checked. */
export function runDirOf(harnessDir: string): string {
  return join(harnessDir, ".crewhaus", "run");
}
