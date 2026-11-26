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
import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { CANONICAL_RUN_ID_RE } from "@crewhaus/control-contract";
import { appendRecord, openRecordFd, readAt } from "@crewhaus/control-records";
import { startTimesMatch } from "./process-ops";
import { type Scrubber, noopScrubber, scrubDeep } from "./scrub";
import { START_TIME_TOLERANCE_MS } from "./types";

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
    const text = readSmallRecord(path);
    if (text === undefined) return undefined;
    const raw = JSON.parse(text) as Record<string, unknown>;
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
  /**
   * Whether this pump holds the run's pump lease. One that does not consumed nothing and
   * wrote nothing; it tries again on its next call.
   */
  readonly held: boolean;
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
  /** The run's pump lease (`<run>.pump.lock`). Default: beside the cursor file. */
  readonly lockFile?: string;
  /** Judges a lease's holder; default: `kill(pid, 0)`, with no start time. */
  readonly probe?: LeaseProbe;
  /** The pid this pump records as its holder. Default: this process. */
  readonly pid?: number;
  /** The host this pump records as its holder's. Default: this machine. */
  readonly host?: string;
  /**
   * The holder's command line as the OS shows it, recorded on the lease so another pump
   * can tell this process from another program that later took its pid. Default:
   * {@link ownCommandArgv}.
   */
  readonly argv?: readonly string[];
  /**
   * The execution's run index (`<exec>.runs.jsonl`): where each canonical run's first event
   * sits in the events file. Default: beside the events file.
   */
  readonly runIndexFile?: string;
  /**
   * The folder the run index must stay inside (the harness): it is written and read only
   * as a file proven inside it, never through a link. Default: the index's own folder.
   */
  readonly root?: string;
};

export const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// The pump lease
// ---------------------------------------------------------------------------

/** How a lease's holder is judged. `undefined` is "the platform would not say". */
export type LeaseProbe = {
  readonly isAlive: (pid: number) => boolean | undefined;
  readonly startTimeMs: (pid: number) => number | undefined;
  /** The running process's command line; absent or `undefined` when it cannot be told. */
  readonly commandLine?: (pid: number) => string | undefined;
};

/** One run's pump lease: who holds it. No field is named like a credential. */
export type PumpLease = {
  readonly v: 1;
  readonly pid: number;
  readonly pidStartTimeMs?: number;
  readonly host: string;
  readonly at: string;
  /** This pump's own id, so two pumps in one process are told apart. */
  readonly pump: string;
  /** The holder's command line, as the OS shows it (see {@link ownCommandArgv}). */
  readonly argv?: readonly string[];
};

/**
 * This process's command line as the OS shows it: the executable's name, then the
 * arguments after the script. A compiled `crewhaus` reads `bun` and an embedded path for
 * its first two `process.argv` entries, neither of which the OS command line holds, so the
 * whole of `process.argv` would never match; the executable's name and the arguments
 * after the script appear, in order, for a compiled manager and a Bun-run one alike.
 */
export function ownCommandArgv(): readonly string[] {
  return commandArgvOf(process.execPath, process.argv);
}

/** {@link ownCommandArgv} for a process with this executable path and `process.argv`. */
export function commandArgvOf(execPath: string, argv: readonly string[]): readonly string[] {
  return [basename(execPath), ...argv.slice(2)];
}

/** How many command-line words a lease records, at most. */
const LEASE_ARGV_MAX = 64;

/** A lease that cannot be read is a writer mid-write for at most this long. */
export const PUMP_LEASE_TORN_GRACE_MS = 60_000;

/**
 * How long a supervisor's pump may find its run's lease held by another process before
 * the supervisor says so: a warning, and `traceCapture: "held-elsewhere"` on the
 * execution's ledger row, which the run's event stream reports.
 */
export const PUMP_HELD_REPORT_MS = 30_000;

/** The default probe: `kill(pid, 0)` decides life; no start time is known. */
export const PUMP_LEASE_PROBE: LeaseProbe = {
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "ESRCH") return false;
      return code === "EPERM" ? true : undefined;
    }
  },
  startTimeMs: () => undefined,
  commandLine: () => undefined,
};

/** The lease file a pump uses when none is named: `<run>.pump.lock` beside its cursor. */
export function pumpLockPathFor(cursorFile: string): string {
  return cursorFile.endsWith(".cursor")
    ? `${cursorFile.slice(0, -".cursor".length)}.pump.lock`
    : `${cursorFile}.pump.lock`;
}

/** A lease or cursor is a few hundred bytes; anything past this is not one. */
const SMALL_RECORD_MAX_BYTES = 64 * 1024;

const READ_SMALL_FLAGS =
  constants.O_RDONLY |
  ((constants as Record<string, number | undefined>)["O_NOFOLLOW"] ?? 0) |
  ((constants as Record<string, number | undefined>)["O_NONBLOCK"] ?? 0);

/**
 * A small record file's text: opened without following a link at its name and without
 * waiting on a FIFO, read only when it is a regular file of at most `maxBytes`.
 * `undefined` for anything else.
 */
export function readSmallRecord(
  path: string,
  maxBytes = SMALL_RECORD_MAX_BYTES,
): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, READ_SMALL_FLAGS);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > maxBytes) return undefined;
    const buf = Buffer.alloc(stats.size);
    let done = 0;
    while (done < buf.length) {
      const got = readSync(fd, buf, done, buf.length - done, done);
      if (got === 0) break;
      done += got;
    }
    return buf.subarray(0, done).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read a pump lease. Absent or not a lease reads as `undefined`. */
export function readPumpLease(lockFile: string): PumpLease | undefined {
  let raw: unknown;
  try {
    const text = readSmallRecord(lockFile);
    if (text === undefined) return undefined;
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const pid = r["pid"];
  if (typeof pid !== "number" || !Number.isInteger(pid)) return undefined;
  if (typeof r["host"] !== "string" || typeof r["pump"] !== "string") return undefined;
  if (typeof r["at"] !== "string") return undefined;
  const start = r["pidStartTimeMs"];
  const argv = r["argv"];
  const words =
    Array.isArray(argv) &&
    argv.length <= LEASE_ARGV_MAX &&
    argv.every((word): word is string => typeof word === "string")
      ? argv
      : undefined;
  return {
    v: 1,
    pid,
    ...(typeof start === "number" && Number.isFinite(start) ? { pidStartTimeMs: start } : {}),
    host: r["host"],
    at: r["at"],
    pump: r["pump"],
    ...(words !== undefined ? { argv: words } : {}),
  };
}

/**
 * Whether a lease may be broken: a lease is kept only while a crewhaus manager provably
 * holds it. That is, the lease names this host; its pid is alive (or the platform would
 * not say); it records the holder's start time and a manager's command line (`crewhaus`
 * or `bun`, then a manager verb, {@link MANAGER_VERBS}); and the process now running
 * under that pid started at that time and runs that command, word for word
 * ({@link commandLineRuns}), as far as the platform can tell. A lease that records no
 * start time or no manager's command line, another host's lease (it cannot be probed from
 * here), a pid that now has another start time, and a pid that now runs another program
 * may all be broken. When the platform would not say the start time or the command line,
 * that check is passed: two live managers must never both write. Its age never frees it:
 * a pump runs as long as its run does.
 */
export function pumpLeaseUnproven(
  lease: PumpLease,
  probe: LeaseProbe,
  host: string = hostname(),
  toleranceMs: number = START_TIME_TOLERANCE_MS,
): boolean {
  if (lease.host !== host) return true;
  if (probe.isAlive(lease.pid) === false) return true;
  if (lease.pidStartTimeMs === undefined) return true;
  const argv = wordsOf(lease.argv ?? []);
  if (!namesManager(argv)) return true;
  const observed = probe.startTimeMs(lease.pid);
  if (observed !== undefined && !startTimesMatch(observed, lease.pidStartTimeMs, toleranceMs)) {
    return true;
  }
  const line = probe.commandLine?.(lease.pid);
  if (line !== undefined && !commandLineRuns(line, argv)) return true;
  return false;
}

/** The executables a crewhaus manager runs as: the compiled CLI, or Bun running its source. */
export const MANAGER_EXECUTABLES: ReadonlySet<string> = new Set([
  "crewhaus",
  "crewhaus.exe",
  "bun",
  "bun.exe",
]);

/** The CLI verbs whose process supervises runs and pumps their traces. */
export const MANAGER_VERBS: ReadonlySet<string> = new Set(["hangar", "daemon"]);

/** A command line's words: split on whitespace, each without the quotes a shell or Windows adds. */
function wordsOf(parts: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    for (const word of part.split(/\s+/)) {
      const bare = word.replace(/^"+|"+$/g, "");
      if (bare !== "") out.push(bare);
    }
  }
  return out;
}

/** The last path segment of a word, by either separator. */
function baseName(word: string): string {
  const parts = word.split(/[\\/]/);
  return parts[parts.length - 1] ?? word;
}

/** Whether recorded words name a crewhaus manager: its executable, then a manager verb. */
function namesManager(argv: readonly string[]): boolean {
  const [exe, ...rest] = argv;
  if (exe === undefined || !MANAGER_EXECUTABLES.has(exe)) return false;
  return rest.some((word) => MANAGER_VERBS.has(word));
}

/**
 * Whether the command line the OS shows runs the recorded words, by whole words: the
 * first recorded word is the name of an observed word (the executable, shown by its
 * path), and the rest follow it as consecutive whole words, the script a Bun-run manager
 * names allowed between the two.
 */
export function commandLineRuns(commandLine: string, argv: readonly string[]): boolean {
  const seen = wordsOf([commandLine]);
  const words = wordsOf(argv);
  const [exe, ...rest] = words;
  if (exe === undefined) return false;
  for (let i = 0; i < seen.length; i++) {
    if (baseName(seen[i] as string) !== exe) continue;
    if (rest.length === 0) return true;
    for (let j = i + 1; j + rest.length <= seen.length; j++) {
      if (rest.every((word, k) => seen[j + k] === word)) return true;
    }
  }
  return false;
}

/**
 * Whether the lease file may be removed: there is none, no live crewhaus manager provably
 * holds it ({@link pumpLeaseUnproven}), or it cannot be read and is older than {@link PUMP_LEASE_TORN_GRACE_MS} (no writer is
 * still writing it).
 */
export function pumpLeaseBreakable(
  lockFile: string,
  probe: LeaseProbe,
  now: number,
  host: string = hostname(),
): boolean {
  const lease = readPumpLease(lockFile);
  if (lease !== undefined) return pumpLeaseUnproven(lease, probe, host);
  try {
    return now - statSync(lockFile).mtimeMs > PUMP_LEASE_TORN_GRACE_MS;
  } catch {
    return true;
  }
}

/** Create the lease, exclusively, at `0600`. `false` when one is already there. */
function createPumpLease(lockFile: string, lease: PumpLease): boolean {
  let fd: number;
  try {
    mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
    fd = openSync(lockFile, "wx", 0o600);
  } catch {
    return false;
  }
  try {
    writeSync(fd, `${JSON.stringify(lease)}\n`);
  } catch {
    // Held either way; its contents only decide whether it may be broken.
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * The per-token stream events: they reach the live feed and are never persisted, so a
 * long answer does not fill the events file one token at a time.
 */
export const EPHEMERAL_EVENT_KINDS: ReadonlySet<string> = new Set([
  "model_stream_token",
  "tool_stream_chunk",
]);

/** The run index beside an events file: `<exec>.events.jsonl` → `<exec>.runs.jsonl`. */
export function runIndexPathFor(eventsFile: string): string {
  return eventsFile.endsWith(".events.jsonl")
    ? `${eventsFile.slice(0, -".events.jsonl".length)}.runs.jsonl`
    : `${eventsFile}.runs.jsonl`;
}

/** A run index is a line per run; past this it is not one. */
export const RUN_INDEX_MAX_BYTES = 4 * 1024 * 1024;

/** One run index line: a canonical run, and where its first event sits in the events file. */
export type RunIndexEntry = { readonly run: string; readonly off: number; readonly at: string };

/** A run index's text parsed: well-formed entries only, in file order. */
export function parseRunIndex(text: string): RunIndexEntry[] {
  const out: RunIndexEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const run = r["run"];
    const off = r["off"];
    if (typeof run !== "string" || !CANONICAL_RUN_ID_RE.test(run)) continue;
    if (typeof off !== "number" || !Number.isSafeInteger(off) || off < 0) continue;
    out.push({ run, off, at: typeof r["at"] === "string" ? r["at"] : "" });
  }
  return out;
}

/** Where a run index sits for the contained reads and writes: its root, and its path there. */
type IndexPlace = { readonly root: string; readonly rel: string };

function indexPlace(runIndexFile: string, root: string | undefined): IndexPlace | undefined {
  if (root === undefined) return { root: dirname(runIndexFile), rel: basename(runIndexFile) };
  const rel = relative(root, runIndexFile);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? { root, rel } : undefined;
}

/** The runs an index names below `eventsBytes`: what is already indexed and still there. */
function indexedRuns(place: IndexPlace | undefined, eventsBytes: number): Set<string> {
  const out = new Set<string>();
  if (place === undefined) return out;
  const opened = openRecordFd(place.root, place.rel);
  if (!opened.ok) return out;
  let text: string;
  try {
    if (opened.stats.size > RUN_INDEX_MAX_BYTES) return out;
    const buf = Buffer.alloc(opened.stats.size);
    const got = readAt(opened.fd, buf, buf.length, 0);
    text = buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(opened.fd);
  }
  for (const entry of parseRunIndex(text)) if (entry.off < eventsBytes) out.add(entry.run);
  return out;
}

/**
 * This process's start, from its own clock: asking the OS can mean starting a helper
 * program, which can time out, and the clock's answer is within the start-time tolerance
 * of what any probe later reads for this pid.
 */
const OWN_START_MS = Date.now() - process.uptime() * 1000;

export type LogPump = {
  /** Consume everything new, persist events, advance the cursor. */
  pumpOnce(): PumpResult;
  /** Release any held-back partial as prose (end of run). */
  flush(): PumpResult;
  cursor(): PumpCursor;
  /** Truncate the events file back to the cursor's recorded size. Called on
   *  adoption so events written after the last cursor write are re-emitted
   *  exactly once instead of duplicated. Only while this pump holds the lease:
   *  without it, it truncates nothing. */
  reconcile(): void;
  /** Release the lease, when this pump holds it. Calling it again does nothing. */
  close(): void;
};

/**
 * Create a pump over one run's captured log. Nothing is read on
 * construction; `pumpOnce()` is the only I/O, so a caller can drive it from
 * a timer, a watcher, or a test loop.
 *
 * Only the pump that holds the run's lease (`<run>.pump.lock`, an exclusive
 * create naming its pid, start time, command line, host and its own id) appends
 * events and writes the cursor, so two managers over one run never write an event
 * twice. A lease is kept only while a crewhaus manager provably holds it (see
 * {@link pumpLeaseUnproven}). A pump that takes the lease reads the cursor file
 * again first: another pump may have moved it since.
 *
 * Per-token stream events (`model_stream_token`, `tool_stream_chunk`) reach the
 * caller's live feed but are not persisted. The first persisted event of each
 * canonical run (`run_` and 26 characters) gets a line in the execution's run index
 * (`<exec>.runs.jsonl`, `{run, off, at}`), `off` being its byte offset in the events
 * file; the set of indexed runs is read back from the index whenever the lease is
 * taken, counting only entries below the events file's size.
 */
export function createLogPump(options: LogPumpOptions): LogPump {
  const scrub = options.scrub ?? noopScrubber;
  const now = options.now ?? Date.now;
  const maxChunk = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  const lockFile = options.lockFile ?? pumpLockPathFor(options.cursorFile);
  const probe = options.probe ?? PUMP_LEASE_PROBE;
  const ownPid = options.pid ?? process.pid;
  const ownHost = options.host ?? hostname();
  const ownArgv = (options.argv ?? ownCommandArgv()).slice(0, LEASE_ARGV_MAX);
  const runIndexFile = options.runIndexFile ?? runIndexPathFor(options.eventsFile);
  const indexAt = indexPlace(runIndexFile, options.root);
  const ownId = randomBytes(8).toString("hex");
  let held = false;
  /** The canonical runs the index already names, read back when the lease is taken. */
  let indexed = new Set<string>();
  let cursor: PumpCursor = readCursor(options.cursorFile) ?? {
    logOffset: 0,
    eventsBytes: 0,
    updatedAt: "",
  };

  /** Hold the lease, taking it when it is free or no live manager provably holds it. */
  const holdLease = (): boolean => {
    if (held) {
      // Still ours? A holder whose lease was broken stops writing at once.
      if (readPumpLease(lockFile)?.pump === ownId) return true;
      held = false;
    }
    // This process's own start comes from its clock; the probe answers for other pids.
    const started = ownPid === process.pid ? OWN_START_MS : probe.startTimeMs(ownPid);
    const lease: PumpLease = {
      v: 1,
      pid: ownPid,
      ...(started !== undefined ? { pidStartTimeMs: started } : {}),
      host: ownHost,
      at: new Date(now()).toISOString(),
      pump: ownId,
      argv: ownArgv,
    };
    let taken = createPumpLease(lockFile, lease);
    if (!taken && pumpLeaseBreakable(lockFile, probe, now(), ownHost)) {
      try {
        rmSync(lockFile, { force: true });
      } catch {
        return false;
      }
      taken = createPumpLease(lockFile, lease);
    }
    if (!taken) return false;
    held = true;
    // Another pump may have advanced the cursor since this one read it.
    cursor = readCursor(options.cursorFile) ?? cursor;
    indexed = indexedRuns(indexAt, currentEventsBytes());
    return true;
  };

  const releaseLease = (): void => {
    if (!held) return;
    held = false;
    if (readPumpLease(lockFile)?.pump !== ownId) return;
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // Gone already, or not ours to remove: either way this pump holds nothing.
    }
  };

  const persistEvents = (events: ReadonlyArray<Record<string, unknown>>): number => {
    const kept = events.filter((e) => !EPHEMERAL_EVENT_KINDS.has(String(e["kind"])));
    if (kept.length === 0) return currentEventsBytes();
    mkdirSync(dirname(options.eventsFile), { recursive: true, mode: 0o700 });
    // When the line reached the events file: a reader's clock for what it was handed.
    const ingestedAt = new Date(now()).toISOString();
    const base = currentEventsBytes();
    const lines: string[] = [];
    const firsts: string[] = [];
    let off = base;
    for (const e of kept) {
      const line = `${JSON.stringify({ ...e, ingestedAt })}\n`;
      const run = e["runId"];
      if (typeof run === "string" && CANONICAL_RUN_ID_RE.test(run) && !indexed.has(run)) {
        indexed.add(run);
        firsts.push(`${JSON.stringify({ run, off, at: ingestedAt })}\n`);
      }
      lines.push(line);
      off += Buffer.byteLength(line, "utf8");
    }
    appendFileSync(options.eventsFile, lines.join(""), { mode: 0o600 });
    // Written only as a file proven inside the root; when it is refused, a reader without
    // an index entry scans the events file instead.
    if (firsts.length > 0 && indexAt !== undefined) {
      try {
        appendRecord(indexAt.root, indexAt.rel, firsts.join(""));
      } catch {
        // As refused.
      }
    }
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

  const emptyResult = (restarted = false, holding = true): PumpResult => ({
    prose: "",
    events: [],
    consumedBytes: 0,
    restarted,
    held: holding,
  });

  const run = (force: boolean): PumpResult => {
    if (!holdLease()) return emptyResult(false, false);
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
      held: true,
    };
  };

  return {
    pumpOnce: () => run(false),
    flush: () => run(true),
    cursor: () => cursor,
    reconcile: () => {
      // Only the holder may cut the file: a live original pump may still be writing it.
      if (!holdLease()) return;
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
      // Index entries past the cut no longer count: their runs are indexed again as their
      // events are derived again.
      indexed = indexedRuns(indexAt, cursor.eventsBytes);
    },
    close: releaseLease,
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

/** How a caller sizes a tail read. */
export type LogTailOptions = {
  /** Bytes read from the END of the file. Default 64 KiB. */
  readonly maxBytes?: number;
  /** Lines kept from that window. Default {@link LOG_TAIL_LINES} (8) — the
   *  forensics tail. `daemon logs --tail N` passes N. */
  readonly lines?: number;
};

/**
 * Read the tail of a captured log, scrubbed.
 *
 * Two independent budgets, and BOTH matter: `maxBytes` bounds the read (a
 * multi-GB log must not be slurped), `lines` bounds the result. The default
 * line budget is the 8-line crash tail every forensics caller wants, which
 * is why a caller that widened only the byte window used to still get 8
 * lines — pass `lines` (or `{ maxBytes, lines }`) to ask for more.
 *
 * The third argument stays positional-compatible: a bare number is the BYTE
 * budget, as it always was.
 */
export function readLogTail(
  logFile: string,
  scrub: Scrubber = noopScrubber,
  sizing: number | LogTailOptions = 64 * 1024,
  lines?: number,
): string[] {
  const maxBytes = (typeof sizing === "number" ? sizing : sizing.maxBytes) ?? 64 * 1024;
  const keepLines =
    lines ?? (typeof sizing === "number" ? undefined : sizing.lines) ?? LOG_TAIL_LINES;
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
  return tailLines(scrub(text), keepLines);
}

/**
 * `readLogTail` with the LINE budget in the obvious place — for `daemon logs
 * --tail N`, where passing N as the third argument would silently mean N
 * BYTES. The byte budget defaults to 512 KiB, enough for any plausible N.
 */
export function readLogTailLines(
  logFile: string,
  scrub: Scrubber = noopScrubber,
  lines: number = LOG_TAIL_LINES,
  maxBytes = 512 * 1024,
): string[] {
  return readLogTail(logFile, scrub, maxBytes, lines);
}

// ---------------------------------------------------------------------------
// The control-plane boot announcement
// ---------------------------------------------------------------------------

/**
 * The boot line a control-serving daemon prints on stdout:
 *
 * ```
 * [control] crewhaus.control.v1 listening on http://127.0.0.1:41234 (token: …)
 * ```
 *
 * The manager passes `CREWHAUS_CONTROL_PORT=0` (kernel-assigned) so it never
 * has to reserve a number in advance, which makes THIS line the only way to
 * learn the port. It is matched off the log pump's prose, which is why it
 * lives in the supervision layer: whoever is pumping the log — the console,
 * `crewhaus daemon start`, or a manager that adopted the run — records the
 * port in the runfile, and every other head reads it back from there.
 */
export const CONTROL_ANNOUNCE_RE =
  /\[control\]\s+crewhaus\.control\.v1\s+listening\s+on\s+https?:\/\/[^\s/:]+:(\d{1,5})/;

/** The control port a chunk of captured daemon output announces, if any. */
export function parseAnnouncedControlPort(text: string): number | undefined {
  const m = text.match(CONTROL_ANNOUNCE_RE);
  if (m === null) return undefined;
  const port = Number(m[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}
