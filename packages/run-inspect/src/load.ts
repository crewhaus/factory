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

/** One run-ledger row, as written. */
export type RunRow = Readonly<Record<string, unknown>>;

/** One decision-log line of the inspected session, with its id `d:<segment>:<offset>`. */
export type DecisionEntry = { readonly id: string; readonly line: DecisionLogLine };

/**
 * How the run's lines are told apart: by their `run` stamp; by position between run
 * rows when run records were off; or not at all, for a session written before them.
 */
export type RunMode = "stamped" | "records-off" | "legacy";

/** A run's records, read. Build one with {@link loadRun} or {@link loadedRunFromText}. */
export type LoadedRun = {
  readonly ok: true;
  readonly subject: InspectSubject;
  readonly session: string;
  readonly run?: string;
  readonly mode: RunMode;
  /** The byte range of the session log that is the run's, when lines carry no `run`. */
  readonly window: { readonly from: number; readonly to?: number };
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
};

type LedgerScan = {
  readonly byRun: ReadonlyMap<string, RunRow[]>;
  readonly unreadable: number;
};

/** Every run row, grouped by run, oldest first. */
function scanLedger(harnessDir: string): LedgerScan {
  const ledger = runsLedger(harnessDir);
  const newestFirst: RunRow[] = [];
  let unreadable = 0;
  let before: CursorPosition | undefined;
  for (;;) {
    const page = readPage(ledger, { limit: 1000, ...(before !== undefined ? { before } : {}) });
    for (const item of page.items) newestFirst.push(item.record);
    unreadable += page.gaps.length;
    if (page.next === undefined) break;
    before = page.next;
  }
  const byRun = new Map<string, RunRow[]>();
  for (const row of newestFirst.reverse()) {
    const id = row["id"];
    if (typeof id !== "string") continue;
    const rows = byRun.get(id) ?? [];
    rows.push(row);
    byRun.set(id, rows);
  }
  return { byRun, unreadable };
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
  readonly byRun: ReadonlyMap<string, RunRow[]>;
  readonly sessionRuns: readonly string[];
};

/** Which run, how its lines are told apart, and its byte window. */
function shape(input: Assembled): {
  readonly mode: RunMode;
  readonly window: { readonly from: number; readonly to?: number };
} {
  const { run, lines, rows } = input;
  if (run === undefined) return { mode: "legacy", window: { from: 0 } };
  if (lines.some((line) => stampedRun(line) === run)) {
    return { mode: "stamped", window: { from: sessionAtOf(rows) ?? 0 } };
  }
  const from = sessionAtOf(rows) ?? 0;
  let to: number | undefined;
  for (const [other, otherRows] of input.byRun) {
    if (other === run || sessionOf(otherRows) !== input.session) continue;
    const at = sessionAtOf(otherRows);
    if (at !== undefined && at > from && (to === undefined || at < to)) to = at;
  }
  return { mode: "records-off", window: { from, ...(to !== undefined ? { to } : {}) } };
}

function continuationOf(
  run: string | undefined,
  byRun: ReadonlyMap<string, RunRow[]>,
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
 * Read a run's records: its rows from the run ledger, its session log from the row's
 * `sessionAt` (a session id reads the whole log), and the decision log of the session
 * root. The session root is the one `containedSessionRoot` answers for the harness; a
 * root outside the harness is refused.
 *
 * A run whose stamp says an operator's wake started it, read from `sessionAt`, also gets
 * a look-behind: at most 64 KiB backward from `sessionAt`, stopping at the previous
 * `run_stamp`, keeping only wake markers. No other run reads below `sessionAt`.
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
  const ledger = scanLedger(harnessDir);
  const gaps: InspectGap[] = [];
  if (ledger.unreadable > 0) gaps.push({ reason: "torn", count: ledger.unreadable });

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
      const trigger = payloadOf(stamp ?? ({ payload: {} } as SessionLine))["trigger"] as
        | { synthetic?: unknown }
        | undefined;
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
