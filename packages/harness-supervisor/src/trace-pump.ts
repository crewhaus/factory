/**
 * Log capture + TraceEvent pump.
 *
 * A harness run with `CREWHAUS_TRACE=json` writes structured TraceEvent JSON
 * to stdout — but so does everything else it prints: the assistant's answer,
 * banners, MCP boot chatter, provider errors. There is no framing to rely on,
 * and `model_stream_token` events carry no text, so BOTH halves matter. The
 * splitter below pulls balanced JSON objects out of the raw stream and treats
 * the bytes between them as prose, and it never stalls on prose that happens
 * to contain a brace. It is the same drain / scanBalanced / looksLikeEvent
 * algorithm the public `@crewhaus/ui` host uses, so the manager's live feed
 * and the shape UIs agree byte for byte.
 *
 * The pump on top of it is PULL-based and stateless between calls except for
 * a cursor file, which is what makes adoption after a manager restart exact:
 *
 *   - the cursor records the byte offset of the last FULLY CONSUMED text and
 *     the size of the durable events file at that moment;
 *   - every pump re-reads from that offset to EOF, so an in-flight event or
 *     a torn line is simply re-read rather than lost;
 *   - on resume the events file is truncated back to the recorded size, so
 *     events persisted after the last cursor write are re-emitted exactly
 *     once instead of being duplicated.
 *
 * Zero loss and zero duplication are therefore properties of the cursor, not
 * of the manager staying alive.
 */
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Scrubber, noopScrubber, scrubDeep } from "./scrub";

// ---------------------------------------------------------------------------
// The splitter
// ---------------------------------------------------------------------------

/**
 * Crew orchestration events are streamed without a `runId` or `timestamp`
 * (they carry `{kind, role|from|to, …}`). They are still structured events
 * the crew panels want, and no other shape emits these kinds, so recognizing
 * them here is safe and shape-agnostic.
 */
export const RUNIDLESS_EVENT_KINDS: ReadonlySet<string> = new Set([
  "role_start",
  "role_end",
  "handoff",
  "crew_done",
  "a2a_message",
]);

/** A parsed object counts as a TraceEvent when it has a `kind` plus one of
 *  the envelope fields — or is one of the run-id-less crew kinds. */
export function looksLikeEvent(o: unknown): o is Record<string, unknown> {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  if (typeof r["kind"] !== "string") return false;
  return (
    typeof r["runId"] === "string" ||
    typeof r["timestamp"] === "string" ||
    RUNIDLESS_EVENT_KINDS.has(r["kind"] as string)
  );
}

/** Index of the `}` matching the `{` at `start`, respecting strings and
 *  escapes; -1 when the object is not yet complete. */
export function scanBalanced(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A complete event opening we are still waiting on. */
const EVENT_OPENING_RE = /^\{\s*"(runId|kind|sessionId|timestamp)"/;

/**
 * A tail so short it could still GROW into an event opening — `{`, `{"`,
 * `{"kin`. The upstream splitter only holds back a recognizable opening, so
 * a read boundary landing inside the key name would leak half an event into
 * the prose channel and lose the other half. Holding these back costs at
 * most one pump of latency for prose that happens to end in `{word`, and
 * `flush()` releases it unconditionally at end of run.
 */
const PARTIAL_OPENING_RE = /^\{\s*"?[A-Za-z]{0,12}"?$/;
const MAX_HELD_PARTIAL = 32;

export type Drained = {
  /** Everything between events, in order. */
  readonly text: string;
  readonly events: ReadonlyArray<Record<string, unknown>>;
  /** Text the caller must re-present next time (an in-flight event). */
  readonly rest: string;
};

/** Pull complete events + flushed prose out of an accumulated buffer. */
export function drain(buf: string): Drained {
  let text = "";
  const events: Array<Record<string, unknown>> = [];
  let i = 0;
  let textStart = 0;
  while (i < buf.length) {
    if (buf[i] === "{") {
      const end = scanBalanced(buf, i);
      if (end === -1) {
        // Possibly an in-flight event OR prose with an unbalanced brace.
        const tail = buf.slice(i);
        const peek = tail.slice(0, 12);
        if (
          EVENT_OPENING_RE.test(peek) ||
          (tail.length <= MAX_HELD_PARTIAL && PARTIAL_OPENING_RE.test(tail))
        ) {
          text += buf.slice(textStart, i);
          return { text, events, rest: tail };
        }
        i++;
        continue;
      }
      const candidate = buf.slice(i, end + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        parsed = undefined;
      }
      if (looksLikeEvent(parsed)) {
        text += buf.slice(textStart, i);
        events.push(parsed as Record<string, unknown>);
        i = end + 1;
        textStart = i;
        continue;
      }
      i++;
    } else {
      i++;
    }
  }
  text += buf.slice(textStart);
  return { text, events, rest: "" };
}

// ---------------------------------------------------------------------------
// UTF-8 boundary handling
// ---------------------------------------------------------------------------

/**
 * Length of the longest prefix of `buf` that ends on a complete UTF-8
 * sequence. Reading a byte RANGE out of a log can split a multi-byte
 * character; decoding the split half would emit a replacement character AND
 * desynchronise the byte accounting the cursor depends on.
 */
export function completeUtf8Length(buf: Uint8Array): number {
  const end = buf.length;
  // A continuation byte is 10xxxxxx; walk back over at most 3 of them to
  // find the lead byte, then check whether the sequence it announces fits.
  for (let back = 0; back < 4 && end - back > 0; back++) {
    const idx = end - back - 1;
    const byte = buf[idx] as number;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue; // continuation
    let need = 1;
    if ((byte & 0b1000_0000) === 0) need = 1;
    else if ((byte & 0b1110_0000) === 0b1100_0000) need = 2;
    else if ((byte & 0b1111_0000) === 0b1110_0000) need = 3;
    else if ((byte & 0b1111_1000) === 0b1111_0000) need = 4;
    else return end; // invalid lead byte — let the decoder deal with it
    return idx + need <= end ? end : idx;
  }
  return end;
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

export type PumpCursor = {
  /** Bytes of the log file fully consumed AND flushed. */
  readonly logOffset: number;
  /** Size of the durable events file at that moment. */
  readonly eventsBytes: number;
  readonly updatedAt: string;
};

export function readCursor(path: string): PumpCursor | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const logOffset = raw["logOffset"];
    const eventsBytes = raw["eventsBytes"];
    if (typeof logOffset !== "number" || logOffset < 0) return undefined;
    return {
      logOffset,
      eventsBytes: typeof eventsBytes === "number" && eventsBytes >= 0 ? eventsBytes : 0,
      updatedAt: typeof raw["updatedAt"] === "string" ? raw["updatedAt"] : "",
    };
  } catch {
    return undefined;
  }
}

export function writeCursor(path: string, cursor: PumpCursor): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

export type PumpOutput = {
  readonly prose: string;
  readonly events: ReadonlyArray<Record<string, unknown>>;
};

export type PumpResult = PumpOutput & {
  /** Bytes newly consumed from the log. */
  readonly consumedBytes: number;
  /** True when the log shrank under us (an external rotation) and the pump
   *  restarted from byte 0 rather than reading garbage. */
  readonly restarted: boolean;
};

export type LogPumpOptions = {
  /** The captured log to tail. */
  readonly logFile: string;
  /** Where extracted events are persisted (JSON lines, already scrubbed). */
  readonly eventsFile: string;
  /** Where the resume cursor lives. */
  readonly cursorFile: string;
  /** Applied to prose and to every string inside every event BEFORE either
   *  leaves this process. Defaults to a no-op — pass a real one. */
  readonly scrub?: Scrubber;
  readonly now?: () => number;
  /** Max bytes to consume per pump (a burst-logging daemon must not stall
   *  the manager). The remainder is picked up by the next pump. */
  readonly maxChunkBytes?: number;
};

export const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;

export type LogPump = {
  /** Consume everything new, persist events, advance the cursor. */
  pumpOnce(): PumpResult;
  /** Release any held-back partial as prose (end of run). */
  flush(): PumpResult;
  cursor(): PumpCursor;
  /** Truncate the events file back to the cursor's recorded size. Called on
   *  adoption so events written after the last cursor write are re-emitted
   *  exactly once instead of duplicated. */
  reconcile(): void;
};

/**
 * Create a pump over one run's captured log. Nothing is read on
 * construction; `pumpOnce()` is the only I/O, so a caller can drive it from
 * a timer, a watcher, or a test loop.
 */
export function createLogPump(options: LogPumpOptions): LogPump {
  const scrub = options.scrub ?? noopScrubber;
  const now = options.now ?? Date.now;
  const maxChunk = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  let cursor: PumpCursor = readCursor(options.cursorFile) ?? {
    logOffset: 0,
    eventsBytes: 0,
    updatedAt: "",
  };

  const persistEvents = (events: ReadonlyArray<Record<string, unknown>>): number => {
    if (events.length === 0) return currentEventsBytes();
    mkdirSync(dirname(options.eventsFile), { recursive: true, mode: 0o700 });
    const text = events.map((e) => `${JSON.stringify(e)}\n`).join("");
    appendFileSync(options.eventsFile, text, { mode: 0o600 });
    return currentEventsBytes();
  };

  const currentEventsBytes = (): number => {
    try {
      return statSync(options.eventsFile).size;
    } catch {
      return 0;
    }
  };

  const readRange = (from: number, to: number): Uint8Array => {
    const take = to - from;
    if (take <= 0) return new Uint8Array(0);
    const fd = openSync(options.logFile, "r");
    try {
      const buf = Buffer.alloc(take);
      const read = readSync(fd, buf, 0, take, from);
      return buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  };

  const emptyResult = (restarted = false): PumpResult => ({
    prose: "",
    events: [],
    consumedBytes: 0,
    restarted,
  });

  const run = (force: boolean): PumpResult => {
    let size: number;
    try {
      size = statSync(options.logFile).size;
    } catch {
      return emptyResult();
    }
    let restarted = false;
    if (size < cursor.logOffset) {
      // The log shrank: it was rotated or replaced out from under us. Start
      // over rather than read from a nonsensical offset.
      cursor = { logOffset: 0, eventsBytes: cursor.eventsBytes, updatedAt: cursor.updatedAt };
      restarted = true;
    }
    if (size === cursor.logOffset && !force) return emptyResult(restarted);

    const end = Math.min(size, cursor.logOffset + maxChunk);
    const raw = readRange(cursor.logOffset, end);
    const decodable = raw.subarray(0, completeUtf8Length(raw));
    const text = new TextDecoder("utf-8").decode(decodable);
    if (text === "") return emptyResult(restarted);

    const drained = drain(text);
    // `force` (flush) releases the held-back partial as prose.
    const rest = force ? "" : drained.rest;
    const prose = force ? drained.text + drained.rest : drained.text;
    const consumedChars = text.length - rest.length;
    const consumedBytes = Buffer.byteLength(text.slice(0, consumedChars), "utf8");

    const scrubbedEvents = drained.events.map(
      (e) => scrubDeep(e, scrub) as Record<string, unknown>,
    );
    const eventsBytes = persistEvents(scrubbedEvents);
    cursor = {
      logOffset: cursor.logOffset + consumedBytes,
      eventsBytes,
      updatedAt: new Date(now()).toISOString(),
    };
    writeCursor(options.cursorFile, cursor);
    return {
      prose: scrub(prose),
      events: scrubbedEvents,
      consumedBytes,
      restarted,
    };
  };

  return {
    pumpOnce: () => run(false),
    flush: () => run(true),
    cursor: () => cursor,
    reconcile: () => {
      // Drop anything the previous manager appended after its last cursor
      // write — those bytes will be re-derived from the log.
      if (!existsSync(options.eventsFile)) return;
      let size: number;
      try {
        size = statSync(options.eventsFile).size;
      } catch {
        return;
      }
      if (size <= cursor.eventsBytes) return;
      const fd = openSync(options.eventsFile, "r+");
      try {
        ftruncateSync(fd, cursor.eventsBytes);
      } finally {
        closeSync(fd);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Durable replay + forensics
// ---------------------------------------------------------------------------

/** Read a run's persisted events (already scrubbed at pump time). Torn
 *  lines are skipped — a manager killed mid-append must not break replay. */
export function replayRunEvents(eventsFile: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(eventsFile, "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null)
        out.push(parsed as Record<string, unknown>);
    } catch {
      // torn line — skip
    }
  }
  return out;
}

/** How many trailing log lines ride along on a crash record. */
export const LOG_TAIL_LINES = 8;
/** Per-line cap so one pathological line cannot bloat the forensics blob. */
export const LOG_TAIL_MAX_CHARS = 400;

/** The trailing non-blank lines of a text blob, capped per line. */
export function tailLines(
  text: string,
  lines: number = LOG_TAIL_LINES,
  maxChars: number = LOG_TAIL_MAX_CHARS,
): string[] {
  const kept: string[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trimEnd();
    if (trimmed.trim() === "") continue;
    kept.push(trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)} …` : trimmed);
    if (kept.length > lines) kept.shift();
  }
  return kept;
}

/** Read the tail of a captured log, scrubbed, for a crash card. Reads at
 *  most `maxBytes` from the END of the file. */
export function readLogTail(
  logFile: string,
  scrub: Scrubber = noopScrubber,
  maxBytes = 64 * 1024,
): string[] {
  let size: number;
  try {
    size = statSync(logFile).size;
  } catch {
    return [];
  }
  const from = Math.max(0, size - maxBytes);
  let text: string;
  const fd = openSync(logFile, "r");
  try {
    const buf = Buffer.alloc(size - from);
    const read = readSync(fd, buf, 0, size - from, from);
    const slice = buf.subarray(0, read);
    // A window taken from the END can start mid-character; drop the leading
    // continuation bytes rather than emit replacement characters.
    let start = 0;
    while (start < slice.length && ((slice[start] as number) & 0b1100_0000) === 0b1000_0000) {
      start++;
    }
    text = new TextDecoder("utf-8").decode(slice.subarray(start));
  } finally {
    closeSync(fd);
  }
  return tailLines(scrub(text));
}
