/**
 * The versioned API's event streams (#507, #513): a run's (`runs.events`), a harness's
 * (`events.harness`) and Home's (`events.fleet`). Each resumes from a cursor, from
 * `Last-Event-ID` or `?after=` (both, and different, is refused), and says when something
 * was missed (`stream.gap`), when its records were replaced (`stream.reset`) and when it
 * stopped at a cap (`stream.pause`). Every frame's `id` is the cursor just past it.
 *
 * - A run stream follows the run's rows and, for a caller who may read the harness's
 *   content, the trace of the newest execution its rows name (or its session's events).
 *   When a later row names another execution, the stream pauses, and the reconnect reads
 *   the new trace. It ends once the run has ended and its trace is read. A supervisor's
 *   execution (`run_<16 hex>`) streams its own ledger lines and trace.
 * - A harness stream follows the registered sources (the core's: runs, commands,
 *   deployments, decisions, approvals) from now, or from its cursor.
 * - Home's stream follows the fleet's change log, delivering a frame about a harness only
 *   to a caller who may read that harness as the access records stand at that batch.
 *
 * Reads only: no stream creates or writes a file.
 */
import { join } from "node:path";
import {
  type Cursor,
  type CursorSource,
  type CursorSources,
  EXECUTION_RUN_ID_RE,
  type EventEnvelope,
  SESSION_ID_RE,
  decodeCursor,
  encodeCursor,
} from "@crewhaus/control-contract";
import {
  type LedgerRecord,
  type RecordSource,
  type ResumeCaps,
  type ResumeItem,
  type ResumeSources,
  advanceVector,
  fleetChangesLedger,
  readFleetState,
  readPage,
  resume,
  runsLedger,
  snapshotAt,
} from "@crewhaus/control-records";
import { RUN_LEDGER_NAME, readPrunedRuns } from "@crewhaus/harness-supervisor";
import type { RequestAccess } from "../access";
import type { V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import {
  type EnvelopeFields,
  type StreamSourceDecl,
  TERMINAL_RUN_STATES,
  executionLineEnds,
  executionLineEvent,
  runRowEvent,
  traceLineEvent,
} from "./event-map";
import { harnessOf, liveDirOf } from "./resolve";
import { RUN_LOOKUP_LINES, findExecution, findRun } from "./runs";
import { type StreamBatch, type StreamFrame, type StreamPlan, streamEnvelope } from "./stream";

/** What one batch of a stream reads per source. */
export const STREAM_CAPS: ResumeCaps = { maxLines: 256, maxBytes: 1024 * 1024 };

function cursorRefused(message: string): V1Error {
  return new V1Error({ status: 400, code: "invalid", reason: "cursor", message });
}

/**
 * The cursor a stream resumes from: `Last-Event-ID`, else `?after=`. Both, and different,
 * is refused; so is one that does not decode or is of another kind than this stream's.
 */
export function resumeCursor(ctx: V1Context, kind: "vector" | "fleet"): Cursor | undefined {
  const header = ctx.req.headers.get("last-event-id") ?? undefined;
  const after = ctx.query["after"];
  if (header !== undefined && after !== undefined && header !== after) {
    throw cursorRefused("Last-Event-ID and ?after= name different places; send one.");
  }
  const text = header ?? after;
  if (text === undefined) return undefined;
  const decoded = decodeCursor(text);
  if (!decoded.ok || decoded.cursor.kind !== kind) {
    throw cursorRefused("That cursor does not belong to this stream. Open it without one.");
  }
  return decoded.cursor;
}

/** The stream's own abort signal and end, from Home, or the client's alone. */
function signalOf(ctx: V1Context): { signal: AbortSignal | undefined; dispose: () => void } {
  return ctx.deps.streamSignal?.(ctx.req) ?? { signal: ctx.req.signal, dispose: () => undefined };
}

/** A run stream's place before its first frame: the start of its rows. */
const OPENING = encodeCursor({
  v: 1,
  kind: "vector",
  sources: { rows: [{ seg: 0, off: 0, tail: "" }] },
});

const encodeVector = (sources: CursorSources): string | undefined =>
  Object.keys(sources).length === 0 ? undefined : encodeCursor({ v: 1, kind: "vector", sources });

// ---------------------------------------------------------------------------
// Vector streams: a run's and a harness's
// ---------------------------------------------------------------------------

/** One source a vector stream reads, and what each of its lines sends. */
type LineSource = {
  readonly name: CursorSource;
  readonly source: RecordSource;
  /** The event a line is in this stream, or `undefined` to read past it. */
  readonly eventOf: (
    record: Readonly<Record<string, unknown>>,
    access: RequestAccess,
  ) => EnvelopeFields | undefined;
};

type VectorRead = {
  readonly frames: StreamFrame[];
  readonly vector: CursorSources;
  readonly more: boolean;
  /** Items each source yielded: lines, gaps and resets. */
  readonly yielded: ReadonlyMap<CursorSource, number>;
  /** Set when `stopAt` stopped the batch at a line. */
  readonly stopped: boolean;
};

/**
 * A reader over several sources from one vector. Each item moves the vector past it, and
 * each frame's id is the vector just past its item. A gap that does not move the vector
 * (a file that cannot be opened) is sent once per stream, not once per poll.
 */
function vectorReader(sources: readonly LineSource[], start: CursorSources | undefined) {
  const map: Record<string, RecordSource> = {};
  for (const s of sources) map[s.name] = s.source;
  const byName = new Map(sources.map((s) => [s.name, s] as const));
  let vector: CursorSources = start ?? {};
  let given: CursorSources | undefined = start;
  const stuck = new Set<string>();

  const frameOf = (fields: EnvelopeFields, id: string): StreamFrame => ({
    id,
    event: fields.type,
    data: { v: 1, id, ...fields } as EventEnvelope,
  });

  return {
    vector: () => vector,
    read(
      access: RequestAccess,
      stopAt?: (item: ResumeItem & { kind: "line" }) => boolean,
    ): VectorRead {
      const answer = resume(map as ResumeSources, given, STREAM_CAPS);
      const frames: StreamFrame[] = [];
      const yielded = new Map<CursorSource, number>();
      const at = new Date().toISOString();
      let stopped = false;
      for (const item of answer.items) {
        const before = vector;
        vector = advanceVector(vector, item);
        const id = encodeVector(vector) ?? encodeVector(answer.next);
        yielded.set(item.source, (yielded.get(item.source) ?? 0) + 1);
        if (id === undefined) continue;
        if (item.kind === "line") {
          const fields = byName.get(item.source)?.eventOf(item.record, access);
          if (fields !== undefined) frames.push(frameOf(fields, id));
          if (stopAt?.(item) === true) {
            stopped = true;
            break;
          }
        } else if (item.kind === "gap") {
          const key = `${item.source}:${item.after.seg}:${item.after.off}:${item.reason}`;
          const moved = JSON.stringify(before[item.source]) !== JSON.stringify(vector[item.source]);
          if (!moved && stuck.has(key)) continue;
          if (!moved) stuck.add(key);
          frames.push(
            streamEnvelope("stream.gap", id, at, { reason: item.reason, source: item.source }),
          );
        } else {
          const earliest =
            item.earliest === undefined
              ? undefined
              : encodeVector({ [item.source]: [item.earliest] } as CursorSources);
          frames.push(
            streamEnvelope("stream.reset", id, at, {
              reason: "diverged",
              source: item.source,
              ...(earliest !== undefined ? { earliest } : {}),
            }),
          );
        }
      }
      if (!stopped) vector = answer.next;
      given = vector;
      const more = [...yielded.values()].some((count) => count >= STREAM_CAPS.maxLines);
      return { frames, vector, more, yielded, stopped };
    },
  };
}

// ---------------------------------------------------------------------------
// The run stream
// ---------------------------------------------------------------------------

/** `.crewhaus/run/logs/<execution>.events.jsonl`, one file, never rolled. */
function traceSource(dir: string, execution: string): RecordSource {
  return {
    root: dir,
    records: { file: join(".crewhaus", "run", "logs", `${execution}.events.jsonl`) },
  };
}

/** `.crewhaus/sessions/<session>.events.jsonl`. */
function sessionSource(dir: string, session: string): RecordSource {
  return { root: dir, records: { file: join(".crewhaus", "sessions", `${session}.events.jsonl`) } };
}

/** The newest execution a run's rows (newest first) name. */
function newestExecution(rows: readonly LedgerRecord[]): string | undefined {
  for (const row of rows) {
    const execution = row["execution"];
    if (typeof execution === "string" && EXECUTION_RUN_ID_RE.test(execution)) return execution;
  }
  return undefined;
}

function newestSession(rows: readonly LedgerRecord[]): string | undefined {
  for (const row of rows) {
    const session = row["session"];
    if (typeof session === "string" && SESSION_ID_RE.test(session)) return session;
  }
  return undefined;
}

/**
 * The execution and session a run's rows named up to a cursor's rows position: the files
 * the cursor's trace and session positions were read from. A cursor with no rows position
 * named none.
 */
function followedFiles(
  dir: string,
  runId: string,
  sources: CursorSources,
): { readonly execution?: string; readonly session?: string } {
  const at = sources.rows?.[sources.rows.length - 1];
  if (at === undefined) return {};
  let rows: LedgerRecord[] = [];
  try {
    rows = readPage(runsLedger(dir), { limit: RUN_LOOKUP_LINES, before: at })
      .items.map((item) => item.record)
      .filter((record) => record["id"] === runId);
  } catch {
    rows = [];
  }
  const execution = newestExecution(rows);
  const session = execution === undefined ? newestSession(rows) : undefined;
  return {
    ...(execution !== undefined ? { execution } : {}),
    ...(session !== undefined ? { session } : {}),
  };
}

function runUnknown(): V1Error {
  return new V1Error({
    status: 404,
    code: "not_found",
    reason: "run_unknown",
    message: "This Home has no run by that id.",
    remedy: "Name its harness with `?harness=`, or run `crewhaus runs list --harness <h>`.",
  });
}

function planOf(
  ctx: V1Context,
  start: string,
  read: (access: RequestAccess) => StreamBatch,
): StreamPlan {
  const { signal, dispose } = signalOf(ctx);
  return { start, read, signal, dispose };
}

/** A canonical run's stream: its rows, and its trace for a caller who may read content. */
function canonicalRunStream(ctx: V1Context, runId: string): StreamPlan & { scrubDir: string } {
  const found = findRun(ctx.deps, runId, ctx.query["harness"]);
  if (found === undefined) throw runUnknown();
  const cursor = resumeCursor(ctx, "vector");
  const harness = found.entry.id;
  const execution = newestExecution(found.rows);
  const session = execution === undefined ? newestSession(found.rows) : undefined;
  const content = ctx.access.canReadContent(harness);
  const noTrace = execution === undefined && session === undefined;
  const traceOf = (record: Readonly<Record<string, unknown>>, access: RequestAccess) => {
    if (!access.canReadContent(harness)) return undefined;
    const owner = record["runId"];
    if (typeof owner === "string" && owner !== runId) return undefined;
    return traceLineEvent(record, harness, runId);
  };
  const sources: LineSource[] = [
    {
      name: "rows",
      source: runsLedger(found.dir),
      eventOf: (record) =>
        record["id"] === runId
          ? runRowEvent(record, harness, noTrace ? { trace: false } : {})
          : undefined,
    },
  ];
  // Without the content permission the trace is not opened at all.
  if (content && execution !== undefined) {
    sources.push({ name: "trace", source: traceSource(found.dir, execution), eventOf: traceOf });
  } else if (content && session !== undefined) {
    sources.push({ name: "session", source: sessionSource(found.dir, session), eventOf: traceOf });
  }
  // A trace or session position read from another file than the one opened now is
  // dropped: that file is read from its start, never from an offset that is not its own.
  let resumed: CursorSources | undefined;
  if (cursor?.kind === "vector") {
    const followed = followedFiles(found.dir, runId, cursor.sources);
    resumed = Object.fromEntries(
      Object.entries(cursor.sources).filter(
        ([name]) =>
          !(name === "trace" && followed.execution !== execution) &&
          !(name === "session" && followed.session !== session),
      ),
    ) as CursorSources;
  }
  const reader = vectorReader(sources, resumed);
  const start = encodeVector(reader.vector()) ?? OPENING;
  // The executions the run's rows named when the stream opened: a row naming any other is
  // a new one, and the stream pauses so the reconnect reads its trace.
  const known = new Set(
    found.rows.map((row) => row["execution"]).filter((e): e is string => typeof e === "string"),
  );
  let ended = false;
  const plan = planOf(ctx, start, (access) => {
    let moved = false;
    const batch = reader.read(access, (item) => {
      if (item.source !== "rows" || item.record["id"] !== runId) return false;
      const state = item.record["state"];
      if (typeof state === "string" && TERMINAL_RUN_STATES.has(state)) ended = true;
      const named = item.record["execution"];
      // A later row names another execution: the reconnect reads that one's trace.
      if (
        content &&
        typeof named === "string" &&
        EXECUTION_RUN_ID_RE.test(named) &&
        named !== execution &&
        !known.has(named)
      ) {
        moved = true;
        return true;
      }
      return false;
    });
    // Paused for a new execution: its trace is read from its start on the reconnect.
    const { trace: _trace, session: _session, ...rows } = batch.vector;
    const next = encodeVector(moved ? rows : batch.vector) ?? start;
    const traced = (batch.yielded.get("trace") ?? 0) + (batch.yielded.get("session") ?? 0);
    return {
      frames: batch.frames,
      next,
      more: batch.more,
      ...(moved ? { pause: "execution" as const } : {}),
      ...(!moved && ended && traced === 0 && !batch.more ? { done: true } : {}),
    };
  });
  return { ...plan, scrubDir: found.dir };
}

/** A supervisor execution's stream: its own ledger lines, then its trace. */
function executionStream(ctx: V1Context, execution: string): StreamPlan & { scrubDir: string } {
  const found = findExecution(ctx.deps, execution, ctx.query["harness"]);
  if (found === undefined) throw runUnknown();
  const cursor = resumeCursor(ctx, "vector");
  const harness = found.entry.id;
  const content = ctx.access.canReadContent(harness);
  const sources: LineSource[] = [
    {
      name: "rows",
      source: { root: found.dir, records: { file: join(".crewhaus", "run", RUN_LEDGER_NAME) } },
      eventOf: (record) =>
        record["runId"] === execution ? executionLineEvent(record, harness) : undefined,
    },
  ];
  if (content) {
    sources.push({
      name: "trace",
      source: traceSource(found.dir, execution),
      eventOf: (record, access) =>
        access.canReadContent(harness) ? traceLineEvent(record, harness, execution) : undefined,
    });
  }
  const reader = vectorReader(sources, cursor?.kind === "vector" ? cursor.sources : undefined);
  const start = encodeVector(reader.vector()) ?? OPENING;
  // Retention removed what this execution wrote: said once, before its rows.
  let evicted = cursor === undefined && found.pruned;
  let ended = false;
  const plan = planOf(ctx, start, (access) => {
    const batch = reader.read(access, (item) => {
      if (item.source === "rows" && item.record["runId"] === execution) {
        if (executionLineEnds(item.record)) ended = true;
      }
      return false;
    });
    const frames = batch.frames;
    if (evicted) {
      evicted = false;
      frames.unshift(
        streamEnvelope("stream.gap", start, new Date().toISOString(), { reason: "evicted" }),
      );
    }
    const traced = batch.yielded.get("trace") ?? 0;
    return {
      frames,
      next: encodeVector(batch.vector) ?? start,
      more: batch.more,
      ...(ended && traced === 0 && !batch.more ? { done: true } : {}),
    };
  });
  return { ...plan, scrubDir: found.dir };
}

const runEvents: V1Handler = async (ctx) => {
  const runId = String(ctx.params["run"]);
  const plan = EXECUTION_RUN_ID_RE.test(runId)
    ? executionStream(ctx, runId)
    : canonicalRunStream(ctx, runId);
  const { scrubDir, ...stream } = plan;
  return { status: 200, stream, scrubDir };
};

// ---------------------------------------------------------------------------
// The harness stream
// ---------------------------------------------------------------------------

const harnessEvents: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOf(entry);
  if (dir === undefined) {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "harness_missing",
      message: "This harness's folder is missing.",
      remedy: "Run `crewhaus harness list` to see where Home last saw it.",
    });
  }
  const cursor = resumeCursor(ctx, "vector");
  const sources: LineSource[] = ctx.streamSources.map((decl: StreamSourceDecl) => ({
    name: decl.name,
    source: decl.source(dir),
    eventOf: (record) => decl.eventOf(record, entry.id),
  }));
  const map: Record<string, RecordSource> = {};
  for (const s of sources) map[s.name] = s.source;
  // From now, unless the client says where it was.
  const opening = cursor?.kind === "vector" ? cursor.sources : snapshotAt(map as ResumeSources);
  const reader = vectorReader(sources, opening);
  const start = encodeVector(opening) as string;
  const plan = planOf(ctx, start, (access) => {
    const batch = reader.read(access);
    return { frames: batch.frames, next: encodeVector(batch.vector) ?? start, more: batch.more };
  });
  return { status: 200, stream: plan, scrubDir: dir };
};

// ---------------------------------------------------------------------------
// The fleet stream
// ---------------------------------------------------------------------------

/** How many of the change log's lines a seek walks back before it starts at the oldest. */
const FLEET_SEEK_LINES = 50_000;

type FleetPosition = {
  /** Where to resume the log; `undefined` is its start. */
  readonly vector: CursorSources | undefined;
  /** Lines between the cursor and the oldest one retained were evicted. */
  readonly evicted: boolean;
};

/** Where the log continues past `seq` in `epoch`, read from its newest end. */
function seekFleet(hangarRoot: string, epoch: number, seq: number): FleetPosition {
  const ledger = fleetChangesLedger(hangarRoot);
  let before: ReturnType<typeof readPage>["next"];
  let newer: CursorSources | undefined;
  let oldest: number | undefined;
  let walked = 0;
  let first = true;
  for (;;) {
    const page = readPage(ledger, { limit: 512, ...(before !== undefined ? { before } : {}) });
    if (first) newer = page.snapshotAt.length > 0 ? { rows: page.snapshotAt } : undefined;
    first = false;
    for (const item of page.items) {
      walked += 1;
      const lineSeq = item.record["seq"];
      if (item.record["epoch"] !== epoch || typeof lineSeq !== "number") {
        return { vector: newer, evicted: oldest !== undefined && oldest > seq + 1 };
      }
      if (lineSeq <= seq) return { vector: newer, evicted: false };
      newer = { rows: [item.at] };
      oldest = lineSeq;
    }
    if (page.next === undefined || walked >= FLEET_SEEK_LINES) break;
    before = page.next;
  }
  return { vector: newer, evicted: oldest !== undefined && oldest > seq + 1 };
}

const fleetEvents: V1Handler = async (ctx) => {
  const cursor = resumeCursor(ctx, "fleet");
  const hangarRoot = ctx.deps.hangarRoot;
  const ledger = fleetChangesLedger(hangarRoot);
  const fleetCursor = (epoch: number, seq: number): string =>
    encodeCursor({ v: 1, kind: "fleet", epoch, seq });
  // Where the stream stands: the epoch and the last seq delivered (or skipped), and where
  // the log is resumed from. Epoch 0 is "no log yet".
  let epoch = 0;
  let seq = 0;
  let vector: CursorSources | undefined;
  let opened = false;
  let pending: StreamFrame[] = [];
  const at = (): string => new Date().toISOString();

  const openAt = (fleetEpoch: number, fleetSeq: number, want: Cursor | undefined): void => {
    opened = true;
    epoch = fleetEpoch;
    if (want === undefined || want.kind !== "fleet") {
      // No cursor: from now.
      seq = fleetSeq;
      vector = seekFleet(hangarRoot, epoch, seq).vector;
      return;
    }
    if (want.epoch !== fleetEpoch || want.seq > fleetSeq) {
      seq = 0;
      vector = seekFleet(hangarRoot, epoch, 0).vector;
      pending.push(
        streamEnvelope("stream.reset", fleetCursor(epoch, 0), at(), {
          reason: want.epoch !== fleetEpoch ? "epoch" : "diverged",
        }),
      );
      return;
    }
    seq = want.seq;
    const found = seekFleet(hangarRoot, epoch, seq);
    vector = found.vector;
    if (found.evicted) {
      pending.push(
        streamEnvelope("stream.gap", fleetCursor(epoch, seq), at(), { reason: "evicted" }),
      );
    }
  };

  const first = readFleetState(hangarRoot);
  if (first.state === "present") openAt(first.fleet.epoch, first.fleet.seq, cursor);
  const start =
    cursor?.kind === "fleet" && !opened ? encodeCursor(cursor) : fleetCursor(epoch, seq);

  const plan = planOf(ctx, start, (access) => {
    const state = readFleetState(hangarRoot);
    if (state.state !== "present") {
      return { frames: [], next: fleetCursor(epoch, seq) };
    }
    if (!opened) {
      openAt(
        state.fleet.epoch,
        state.fleet.seq,
        cursor ?? { v: 1, kind: "fleet", epoch: 0, seq: 0 },
      );
      // A log that appeared after a stream with no cursor opened: from its start, quietly.
      if (cursor === undefined) pending = pending.filter((f) => f.event !== "stream.reset");
    } else if (state.fleet.epoch !== epoch) {
      // The index was deleted and started again: from the start of the new log.
      epoch = state.fleet.epoch;
      seq = 0;
      vector = seekFleet(hangarRoot, epoch, 0).vector;
      pending.push(
        streamEnvelope("stream.reset", fleetCursor(epoch, 0), at(), { reason: "epoch" }),
      );
    }
    const frames: StreamFrame[] = pending;
    pending = [];
    const answer = resume({ rows: ledger }, vector, STREAM_CAPS);
    let lines = 0;
    for (const item of answer.items) {
      if (item.kind === "reset") {
        seq = 0;
        frames.push(
          streamEnvelope("stream.reset", fleetCursor(epoch, 0), at(), { reason: "diverged" }),
        );
        continue;
      }
      lines += 1;
      if (item.kind === "gap") {
        frames.push(
          streamEnvelope("stream.gap", fleetCursor(epoch, seq), at(), { reason: item.reason }),
        );
        continue;
      }
      const { seq: lineSeq, epoch: lineEpoch, ...fields } = item.record;
      if (lineEpoch !== epoch || typeof lineSeq !== "number" || lineSeq <= seq) continue;
      seq = lineSeq;
      const harness = fields["harness"];
      // A frame about a harness reaches only a caller who may read it now.
      if (typeof harness === "string" && !access.canRead(harness)) continue;
      const id = fleetCursor(epoch, seq);
      frames.push({
        id,
        event: fields["type"] as StreamFrame["event"],
        data: { ...(fields as unknown as EnvelopeFields), v: 1, id } as EventEnvelope,
      });
    }
    vector = answer.next;
    return { frames, next: fleetCursor(epoch, seq), more: lines >= STREAM_CAPS.maxLines };
  });
  return { status: 200, stream: plan };
};

export const EVENT_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "runs.events": runEvents,
  "events.harness": harnessEvents,
  "events.fleet": fleetEvents,
};
