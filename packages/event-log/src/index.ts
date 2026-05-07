/**
 * Catalog R7 `event-log` — append-only JSONL transcript per session.
 *
 * One event per line at `<rootDir>/<sessionId>.jsonl` (default rootDir
 * `.crewhaus/sessions`). Every line is a self-describing JSON object:
 * `{ ts, version: 1, kind, payload }`. The schema-version field is
 * stamped onto every event so future migrations can fan out on it.
 *
 * Append semantics: each `append()` calls `appendFileSync(...)` with
 * mode 0o600 (owner-only) per the
 * `claude-code/utils/sessionStorage.ts` precedent. Synchronous append on
 * POSIX is atomic per line (when `len < PIPE_BUF`), so concurrent runs
 * cannot interleave partial JSON. The API is async to keep the door open
 * for a future buffered-writer optimisation; today it resolves
 * immediately.
 *
 * Read semantics: `read({ since?, until? })` opens a fresh read stream
 * via `node:readline`, parses each line as JSON, and yields events in
 * insertion order (filtered by epoch `ts` if either bound is supplied).
 * Missing files yield zero events. A malformed line throws
 * `RuntimeError` carrying the line number — event logs must round-trip
 * cleanly.
 *
 * Reference: `claude-code/utils/sessionStorage.ts`,
 * `AI-Harness-Systems.md` §append-only event history.
 */
import { appendFileSync, createReadStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { RuntimeError } from "@crewhaus/errors";

export const DEFAULT_ROOT_DIR = ".crewhaus/sessions";
const ID_REGEX = /^sess_[0-9a-f]{16}$/;

export type EventKind =
  | "user_message"
  | "assistant_message"
  | "tool_use"
  | "tool_result"
  | "error"
  | "compaction"
  | "sub_agent_start"
  | "sub_agent_end";

export type Event = {
  readonly ts: number;
  readonly version: 1;
  readonly kind: EventKind;
  readonly payload: unknown;
};

export type AppendEvent = Pick<Event, "kind" | "payload">;

export type OpenEventLogOptions = {
  readonly rootDir?: string;
  readonly now?: () => number;
};

export interface EventLog {
  append(event: AppendEvent): Promise<void>;
  read(opts?: { since?: number; until?: number }): AsyncIterable<Event>;
  close(): Promise<void>;
}

function validateId(sessionId: string): void {
  if (!ID_REGEX.test(sessionId)) {
    throw new RuntimeError(`event-log: invalid sessionId "${sessionId}" — expected sess_<16 hex>`);
  }
}

/**
 * Open (or implicitly create) the JSONL log for `sessionId`. Creates the
 * parent directory on demand. Subsequent `append()` calls write
 * synchronously to the file; `read()` opens its own read stream so it
 * sees a consistent snapshot of the bytes already on disk.
 */
export async function openEventLog(
  sessionId: string,
  opts: OpenEventLogOptions = {},
): Promise<EventLog> {
  validateId(sessionId);
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const now = opts.now ?? (() => Date.now());
  const fullPath = join(rootDir, `${sessionId}.jsonl`);
  mkdirSync(rootDir, { recursive: true });

  return {
    async append(event: AppendEvent): Promise<void> {
      const wire: Event = {
        ts: now(),
        version: 1,
        kind: event.kind,
        payload: event.payload,
      };
      const line = `${JSON.stringify(wire)}\n`;
      appendFileSync(fullPath, line, { mode: 0o600 });
    },

    read(readOpts: { since?: number; until?: number } = {}): AsyncIterable<Event> {
      return readEvents(fullPath, readOpts);
    },

    async close(): Promise<void> {
      // No persistent handle today; reserved for a future buffered writer.
    },
  };
}

async function* readEvents(
  fullPath: string,
  opts: { since?: number; until?: number },
): AsyncIterable<Event> {
  if (!existsSync(fullPath)) return;
  const stream = createReadStream(fullPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  try {
    for await (const raw of rl) {
      lineNumber += 1;
      if (raw === "") continue;
      let parsed: Event;
      try {
        parsed = JSON.parse(raw) as Event;
      } catch (err) {
        throw new RuntimeError(
          `event-log: malformed JSON on line ${lineNumber} of ${fullPath}`,
          err,
        );
      }
      if (opts.since !== undefined && parsed.ts < opts.since) continue;
      if (opts.until !== undefined && parsed.ts > opts.until) continue;
      yield parsed;
    }
  } finally {
    rl.close();
    stream.close();
  }
}
