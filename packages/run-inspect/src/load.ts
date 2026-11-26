/**
 * Resolve a run or a session to its records and read them: bounded, contained to the
 * harness's session root, read-only. The folds take what this answers and never touch
 * the filesystem.
 */
import { closeSync } from "node:fs";
import {
  CANONICAL_RUN_ID_RE,
  type CursorPosition,
  SESSION_ID_RE,
} from "@crewhaus/control-contract";
import { readPage, runsLedger } from "@crewhaus/control-records";
import {
  type DecisionLogLine,
  containedSessionRoot,
  readDecisionLog,
} from "@crewhaus/session-store";
import { type ExecutionRead, readExecution } from "./exec";
import {
  type ReadObserver,
  type SessionLine,
  WAKE_LOOK_BEHIND_BYTES,
  linesFromText,
  openContained,
  readForward,
  scanBackForWakeMarkers,
} from "./lines";
import { type InspectGap, type InspectRefusal, type InspectSubject, refusal } from "./model";

/** The most bytes of one session log a read takes by default. */
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The most run-ledger rows one load reads, newest first: past it the older rows are left
 * unread and a `truncated` gap says so. The decision log's read takes as many.
 */
export const LEDGER_SCAN_MAX_ROWS = 100_000;

/** How many run-ledger rows one page of the scan reads. */
const LEDGER_PAGE_ROWS = 1000;

/** One run-ledger row, as written. */
export type RunRow = Readonly<Record<string, unknown>>;

/** One decision-log line of the inspected session, with its id `d:<segment>:<offset>`. */
export type DecisionEntry = { readonly id: string; readonly line: DecisionLogLine };

/**
 * How the run's lines are told apart: by their `run` field; by position between run
 * rows when run records were off; or not at all, for a session written before them.
 * `unread`: no line was read (the log is gone, or holds nothing from the run's place
 * on), so there is nothing to tell apart.
 */
export type RunMode = "stamped" | "records-off" | "legacy" | "unread";

/** A run's records, read. Build one with {@link loadRun} or {@link loadedRunFromText}. */
export type LoadedRun = {
  readonly ok: true;
  readonly subject: InspectSubject;
  readonly session: string;
  readonly run?: string;
  readonly mode: RunMode;
  /**
   * The byte range of the session log that is the run's, when lines carry no `run`;
   * `previous` is where the session's run before it starts, when one is recorded.
   */
  readonly window: { readonly from: number; readonly to?: number; readonly previous?: number };
  /** Every line read, in file order. */
  readonly lines: readonly SessionLine[];
  /** Wake-marker candidates the look-behind found below the read. */
  readonly markers: readonly SessionLine[];
  /** The run's ledger rows, oldest first. */
  readonly rows: readonly RunRow[];
  /** The newest row of the run that continues this one, when one does. */
  readonly continuation?: {
    readonly id: string;
    readonly state: string;
    readonly failureClass?: string;
  };
  /** The runs the session's lines and rows name, in order. */
  readonly sessionRuns: readonly string[];
  readonly decisions: readonly DecisionEntry[];
  /** The supervised execution's events for the run, when an execution is named and read. */
  readonly executionEvents?: ExecutionRead;
  /** What the read could not take in. */
  readonly gaps: readonly InspectGap[];
  /** Where reading the session log started. */
  readonly readFrom: number;
  /** Where the session log was read up to. */
  readonly readTo: number;
  readonly now: number;
};

export type LoadRunInput = {
  readonly harnessDir: string;
  /** A canonical run id, or a session id. */
  readonly ref: string;
  /** With a session id: which of its runs. */
  readonly run?: string;
  /**
   * The harness's env-file variables (`readHarnessEnvFiles(harnessDir).vars` in
   * harness-supervisor). They say where the session root is.
   */
  readonly envVars: Readonly<Record<string, string | undefined>>;
  /** Epoch ms, for the run's effective state. */
  readonly now: number;
  readonly maxBytes?: number;
  /** Told of every read of the session log. */
  readonly onRead?: ReadObserver;
  /** The most run-ledger rows to read; {@link LEDGER_SCAN_MAX_ROWS} when absent. */
  readonly ledgerScanMaxRows?: number;
  /**
   * The run rows the load needs, grouped by run, oldest first, when the caller already
   * holds them (a caught-up read model): the run ledger is then not read at all.
   */
  readonly byRun?: ReadonlyMap<string, readonly RunRow[]>;
};

type LedgerScan = {
  readonly byRun: ReadonlyMap<string, readonly RunRow[]>;
  readonly unreadable: number;
  /** Older rows were left unread at the cap. */
  readonly truncated: boolean;
};

/** A row a run enters the ledger with: nothing about the run is older. */
function isEntryRow(row: RunRow): boolean {
  const state = row["state"];
  return (
    state === "queued" ||
    state === "preparing" ||
    state === "running" ||
    typeof row["sessionAt"] === "number"
  );
}

/**
 * The run rows, grouped by run, oldest first, read newest first a page at a time, at most
 * `maxRows`. For a run id, reading stops once the run's oldest row is read and a whole
 * page after it holds no row of the run's session: the rows a load of that run needs are
 * all newer.
 */
function scanLedger(harnessDir: string, maxRows: number, run: string | undefined): LedgerScan {
  const ledger = runsLedger(harnessDir);
  const newestFirst: RunRow[] = [];
  let unreadable = 0;
  let truncated = false;
  let before: CursorPosition | undefined;
  let session: string | undefined;
  let sawOldest = false;
  for (;;) {
    const room = maxRows - newestFirst.length;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const page = readPage(ledger, {
      limit: Math.min(LEDGER_PAGE_ROWS, room),
      ...(before !== undefined ? { before } : {}),
    });
    const settledBefore = sawOldest;
    let sessionRows = 0;
    for (const item of page.items) {
      const row = item.record;
      newestFirst.push(row);
      if (run === undefined) continue;
      if (row["id"] === run) {
        if (session === undefined && typeof row["session"] === "string") session = row["session"];
        if (isEntryRow(row)) sawOldest = true;
      } else if (session !== undefined && row["session"] === session) {
        sessionRows += 1;
      }
    }
    unreadable += page.gaps.length;
    if (page.next === undefined) break;
    before = page.next;
    if (settledBefore && sessionRows === 0) break;
  }
  const byRun = new Map<string, RunRow[]>();
  for (const row of newestFirst.reverse()) {
    const id = row["id"];
    if (typeof id !== "string") continue;
    const rows = byRun.get(id) ?? [];
    rows.push(row);
    byRun.set(id, rows);
  }
  return { byRun, unreadable, truncated };
}

function sessionOf(rows: readonly RunRow[]): string | undefined {
  for (const row of rows) {
    const session = row["session"];
    if (typeof session === "string" && SESSION_ID_RE.test(session)) return session;
  }
  return undefined;
}

function sessionAtOf(rows: readonly RunRow[]): number | undefined {
  for (const row of rows) {
    const at = row["sessionAt"];
    if (typeof at === "number" && Number.isInteger(at) && at >= 0) return at;
  }
  return undefined;
}

function payloadOf(line: SessionLine): Record<string, unknown> {
  const payload = line.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/** The run a `run_stamp` line stamps. */
function stampedRun(line: SessionLine): string | undefined {
  if (line.kind !== "run_stamp") return undefined;
  const run = payloadOf(line)["run"] ?? line.run;
  return typeof run === "string" ? run : undefined;
}

/** The runs the lines name, in order of first appearance, then those only rows name. */
function runsOf(
  lines: readonly SessionLine[],
  rowRuns: ReadonlyArray<{ readonly run: string; readonly at: number }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const run = line.run ?? stampedRun(line);
    if (run === undefined || seen.has(run)) continue;
    seen.add(run);
    out.push(run);
  }
  for (const { run } of [...rowRuns].sort((a, b) => a.at - b.at)) {
    if (seen.has(run)) continue;
    seen.add(run);
    out.push(run);
  }
  return out;
}

/** The newest run that no other run of this session started. */
function defaultRun(lines: readonly SessionLine[], runs: readonly string[]): string | undefined {
  const parents = new Map<string, string>();
  for (const line of lines) {
    const run = stampedRun(line);
    const parent = payloadOf(line)["parent"];
    if (run !== undefined && typeof parent === "string") parents.set(run, parent);
  }
  const inSession = new Set(runs);
  for (const run of [...runs].reverse()) {
    const parent = parents.get(run);
    if (parent === undefined || !inSession.has(parent)) return run;
  }
  return runs.at(-1);
}

type Assembled = {
  readonly session: string;
  readonly run: string | undefined;
  readonly lines: readonly SessionLine[];
  readonly rows: readonly RunRow[];
  readonly byRun: ReadonlyMap<string, readonly RunRow[]>;
  readonly sessionRuns: readonly string[];
};

/** Where the session's runs other than `run` start, from their rows. */
function otherStarts(input: Assembled): number[] {
  const out: number[] = [];
  for (const [other, otherRows] of input.byRun) {
    if (other === input.run || sessionOf(otherRows) !== input.session) continue;
    const at = sessionAtOf(otherRows);
    if (at !== undefined) out.push(at);
  }
  return out;
}

/**
 * Which run, how its lines are told apart, and its byte window. A run is stamped when any
 * line read carries its id, its own stamp or not; `unread` when no line was read.
 */
function shape(input: Assembled): {
  readonly mode: RunMode;
  readonly window: { readonly from: number; readonly to?: number; readonly previous?: number };
} {
  const { run, lines, rows } = input;
  if (run === undefined) return { mode: "legacy", window: { from: 0 } };
  const from = sessionAtOf(rows) ?? 0;
  if (lines.length === 0) return { mode: "unread", window: { from } };
  if (lines.some((line) => line.run === run || stampedRun(line) === run)) {
    return { mode: "stamped", window: { from } };
  }
  let to: number | undefined;
  let previous: number | undefined;
  for (const at of otherStarts(input)) {
    if (at > from && (to === undefined || at < to)) to = at;
    if (at < from && (previous === undefined || at > previous)) previous = at;
  }
  return {
    mode: "records-off",
    window: {
      from,
      ...(to !== undefined ? { to } : {}),
      ...(previous !== undefined ? { previous } : {}),
    },
  };
}

/** The row's trigger, as the summary reads it: the newest row's, else the first's. */
function rowTriggerOf(rows: readonly RunRow[]): Readonly<Record<string, unknown>> | undefined {
  const trigger = rows.at(-1)?.["trigger"] ?? rows[0]?.["trigger"];
  return typeof trigger === "object" && trigger !== null && !Array.isArray(trigger)
    ? (trigger as Readonly<Record<string, unknown>>)
    : undefined;
}

/** The supervised execution a run's stamp or rows name: a supervisor's run id. */
function executionNamed(
  run: string | undefined,
  lines: readonly SessionLine[],
  rows: readonly RunRow[],
): string | undefined {
  if (run === undefined) return undefined;
  const stamp = lines.find((line) => stampedRun(line) === run);
  const fromStamp = stamp !== undefined ? payloadOf(stamp)["execution"] : undefined;
  if (typeof fromStamp === "string") return fromStamp;
  for (const row of rows) {
    const execution = row["execution"];
    if (typeof execution === "string") return execution;
  }
  return undefined;
}

function continuationOf(
  run: string | undefined,
  byRun: ReadonlyMap<string, readonly RunRow[]>,
): LoadedRun["continuation"] {
  if (run === undefined) return undefined;
  for (const [id, rows] of byRun) {
    if (!rows.some((row) => row["continues"] === run)) continue;
    const newest = rows.at(-1);
    const state = newest?.["state"];
    if (typeof state !== "string") continue;
    const failureClass = newest?.["failureClass"];
    return { id, state, ...(typeof failureClass === "string" ? { failureClass } : {}) };
  }
  return undefined;
}

/**
 * Read a run's records: its rows from the run ledger (newest first, at most
 * {@link LEDGER_SCAN_MAX_ROWS}, or none when the caller hands them in), its session log
 * from the row's `sessionAt` (a session id reads the whole log), the decision log of the
 * session root, and, when the run names a supervised execution, that execution's events
 * for the run. The session root is the one `containedSessionRoot` answers for the
 * harness; a root outside the harness is refused, and the session log is opened only as
 * a file proven inside it.
 *
 * A run whose stamp (or, with run records off, whose row) says an operator's wake started
 * it, read from `sessionAt`, also gets a look-behind: at most 64 KiB backward from
 * `sessionAt`, stopping at the previous `run_stamp`, keeping only wake markers. No other
 * run reads below `sessionAt`.
 */
export function loadRun(input: LoadRunInput): LoadedRun | InspectRefusal {
  const { harnessDir, ref, now } = input;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const byRunRef = CANONICAL_RUN_ID_RE.test(ref);
  if (!byRunRef && !SESSION_ID_RE.test(ref)) {
    return refusal(
      "invalid",
      `"${ref.slice(0, 80)}" is not a run or a session: name a run (run_ and 26 letters and digits) or a session (sess_ and 16 hex)`,
      "crewhaus runs list",
    );
  }
  if (input.run !== undefined && !CANONICAL_RUN_ID_RE.test(input.run)) {
    return refusal(
      "invalid",
      "--run names a run: run_ and 26 letters and digits",
      "crewhaus runs list",
    );
  }
  if (byRunRef && input.run !== undefined && input.run !== ref) {
    return refusal("invalid", "--run goes with a session id, not a run id");
  }
  const root = containedSessionRoot(harnessDir, input.envVars);
  if (root === undefined) {
    return refusal(
      "unsupported",
      "this harness's sessions folder lies outside the harness directory, so its records are not read",
      "CREWHAUS_SESSION_DIR",
    );
  }
  const ledger: LedgerScan =
    input.byRun !== undefined
      ? { byRun: input.byRun, unreadable: 0, truncated: false }
      : scanLedger(
          harnessDir,
          input.ledgerScanMaxRows ?? LEDGER_SCAN_MAX_ROWS,
          byRunRef ? ref : undefined,
        );
  const gaps: InspectGap[] = [];
  if (ledger.unreadable > 0) gaps.push({ reason: "torn", count: ledger.unreadable });
  if (ledger.truncated) gaps.push({ reason: "truncated" });

  let session: string;
  let readFrom = 0;
  let pinnedRun: string | undefined;
  if (byRunRef) {
    const rows = ledger.byRun.get(ref) ?? [];
    if (rows.length === 0) {
      return refusal(
        "not_found",
        `no run ${ref} is recorded for this harness`,
        `crewhaus runs inspect <sess_…> --run ${ref}`,
      );
    }
    const found = sessionOf(rows);
    if (found === undefined) {
      return refusal(
        "not_found",
        `run ${ref} names no session, so it has no transcript to read`,
        `crewhaus runs show ${ref}`,
      );
    }
    session = found;
    readFrom = sessionAtOf(rows) ?? 0;
    pinnedRun = ref;
  } else {
    session = ref;
  }

  const rowRuns: Array<{ readonly run: string; readonly at: number }> = [];
  for (const [id, rows] of ledger.byRun) {
    if (sessionOf(rows) === session) rowRuns.push({ run: id, at: sessionAtOf(rows) ?? 0 });
  }

  const opened = openContained(root, `${session}.jsonl`);
  let lines: readonly SessionLine[] = [];
  let markers: readonly SessionLine[] = [];
  let readTo = readFrom;
  if (!opened.ok) {
    if (!opened.missing) return refusal("unsupported", opened.reason);
    if (rowRuns.length === 0) {
      return refusal(
        "not_found",
        `no session ${session} in this harness's sessions folder`,
        "crewhaus runs list",
      );
    }
    gaps.push({ reason: "evicted" });
  } else {
    try {
      const from = Math.min(readFrom, opened.size);
      const forward = readForward(opened.fd, opened.size, from, maxBytes, input.onRead);
      lines = forward.lines;
      gaps.push(...forward.gaps);
      readTo = forward.end;
      const own = pinnedRun ?? input.run;
      const stamp = lines.find((line) => stampedRun(line) === own);
      // The stamp's trigger; with run records off, the row's.
      const trigger = (
        stamp !== undefined
          ? payloadOf(stamp)["trigger"]
          : rowTriggerOf(own !== undefined ? (ledger.byRun.get(own) ?? []) : [])
      ) as { synthetic?: unknown } | undefined;
      if (from > 0 && trigger?.synthetic === true) {
        markers = scanBackForWakeMarkers(opened.fd, from, WAKE_LOOK_BEHIND_BYTES, input.onRead);
      }
    } finally {
      closeSync(opened.fd);
    }
  }

  const sessionRuns = runsOf(lines, rowRuns);
  let run: string | undefined = pinnedRun;
  if (run === undefined) {
    if (input.run !== undefined) {
      if (!sessionRuns.includes(input.run)) {
        return refusal(
          "not_found",
          `session ${session} holds no run ${input.run}`,
          `crewhaus runs inspect ${session}`,
        );
      }
      run = input.run;
    } else {
      run = defaultRun(lines, sessionRuns);
    }
  }
  const rows = run !== undefined ? (ledger.byRun.get(run) ?? []) : [];
  const shaped = shape({ session, run, lines, rows, byRun: ledger.byRun, sessionRuns });

  const decisionRead = readDecisionLog(root);
  if (decisionRead.skipped > 0) gaps.push({ reason: "torn", count: decisionRead.skipped });
  if (decisionRead.truncated) gaps.push({ reason: "truncated" });
  const decisions = decisionRead.lines
    .filter((entry) => entry.line.sessionId === session)
    .map((entry) => ({ id: `d:${entry.at.seg}:${entry.at.off}`, line: entry.line }));

  const continuation = continuationOf(run, ledger.byRun);
  const execution = executionNamed(run, lines, rows);
  const executionEvents =
    execution !== undefined && run !== undefined
      ? readExecution(harnessDir, execution, run)
      : undefined;
  return {
    ok: true,
    subject: run !== undefined ? { kind: "run", run, session } : { kind: "legacy", session },
    session,
    ...(run !== undefined ? { run } : {}),
    mode: shaped.mode,
    window: shaped.window,
    lines,
    markers,
    rows,
    ...(continuation !== undefined ? { continuation } : {}),
    sessionRuns,
    decisions,
    ...(executionEvents !== undefined ? { executionEvents } : {}),
    gaps,
    readFrom,
    readTo,
    now,
  };
}

/**
 * A run's records from any session-log-shaped JSONL text (an eval sample's
 * `transcript.jsonl`, for one), with rows and decision-log lines when the caller has
 * them. `run` picks a run; without it, the newest run no other run started.
 */
export function loadedRunFromText(
  text: string,
  options: {
    readonly now: number;
    readonly session?: string;
    readonly run?: string;
    readonly rows?: readonly RunRow[];
    readonly decisions?: readonly DecisionEntry[];
  },
): LoadedRun | InspectRefusal {
  const read = linesFromText(text);
  const session = options.session ?? "";
  const byRun = new Map<string, RunRow[]>();
  for (const row of options.rows ?? []) {
    const id = row["id"];
    if (typeof id !== "string") continue;
    byRun.set(id, [...(byRun.get(id) ?? []), row]);
  }
  const rowRuns = [...byRun].map(([run, rows]) => ({ run, at: sessionAtOf(rows) ?? 0 }));
  const sessionRuns = runsOf(read.lines, rowRuns);
  if (options.run !== undefined && !sessionRuns.includes(options.run)) {
    return refusal("not_found", `the transcript holds no run ${options.run}`);
  }
  const run = options.run ?? defaultRun(read.lines, sessionRuns);
  const rows = run !== undefined ? (byRun.get(run) ?? []) : [];
  const shaped = shape({ session, run, lines: read.lines, rows, byRun, sessionRuns });
  const continuation = continuationOf(run, byRun);
  return {
    ok: true,
    subject: run !== undefined ? { kind: "run", run, session } : { kind: "legacy", session },
    session,
    ...(run !== undefined ? { run } : {}),
    mode: shaped.mode,
    window: shaped.window,
    lines: read.lines,
    markers: [],
    rows,
    ...(continuation !== undefined ? { continuation } : {}),
    sessionRuns,
    decisions: options.decisions ?? [],
    gaps: read.gaps,
    readFrom: 0,
    readTo: read.end,
    now: options.now,
  };
}
