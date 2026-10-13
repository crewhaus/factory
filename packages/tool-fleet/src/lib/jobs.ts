/**
 * Reading the manager's durable job ledger without mistaking "could not
 * read it" for "nothing ran".
 *
 * The fold itself belongs to `@crewhaus/harness-supervisor`:
 * `createFileJobStore(path).read()` is append-only JSONL folded by `jobId`,
 * last write wins, torn trailing line skipped. Nothing here parses a record.
 *
 * What is here is the part the store cannot express. Its reader is:
 *
 * ```js
 * try { text = readFileSync(path, "utf8"); } catch { return []; }
 * ```
 *
 * — so a ledger the manager is writing to but this process cannot open
 * (EACCES on a root-owned hangar, a directory where the file should be, an
 * I/O error) comes back as an empty array, indistinguishable from a fleet
 * that has never run a job. A status tool that reports that as "no jobs" is
 * the reason somebody concludes a queue is idle while it is running.
 *
 * So the path is probed first, and a ledger that exists but folded to
 * nothing is reported as exactly that rather than as an absent one.
 */
import { statSync } from "node:fs";
import type { JobRecord } from "@crewhaus/harness-supervisor";
import {
  type Loaded,
  compareStrings,
  fail,
  probeName,
  renderStorePath,
  renderText,
} from "./result";

export type LedgerState = "absent" | "ok" | "not-a-file" | "unreadable";

export type LedgerProbe = {
  readonly state: LedgerState;
  readonly path: string;
  readonly bytes?: number;
  readonly detail?: string;
};

/** What condition the job ledger is in. Read-only; opens nothing. */
export function probeLedger(path: string): LedgerProbe {
  const kind = probeName(path, path);
  if (!kind.ok) return { state: "unreadable", path, detail: kind.reason };
  if (kind.value === undefined) return { state: "absent", path };
  if (kind.value === "directory" || kind.value === "other") {
    return { state: "not-a-file", path, detail: `the ledger path is a ${kind.value}, not a file` };
  }
  try {
    return { state: "ok", path, bytes: statSync(path).size };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { state: "unreadable", path, detail: `could not be read (${code ?? "unknown error"})` };
  }
}

/** The ledger states a listing may be built from. */
export function ledgerBlockedBy(probe: LedgerProbe): Loaded<undefined> {
  if (probe.state === "ok" || probe.state === "absent") return { ok: true, value: undefined };
  return fail(
    "unreadable",
    `${probe.path}: ${probe.detail ?? probe.state}. @crewhaus/harness-supervisor's job store answers an unopenable ledger with an empty list, so this would otherwise have been reported as "no jobs".`,
  );
}

export type JobFilter = {
  /** Absolute harness directories; a record matches any of them. Both the
   *  lexical and the symlink-resolved spelling are passed, because the
   *  manager records whichever one it was given. */
  readonly harnessDirs?: readonly string[];
  readonly harnessId?: string;
  readonly jobId?: string;
  readonly kind?: string;
  readonly state?: string;
  /** ISO 8601; keeps records enqueued at or after this instant (no offset: UTC). */
  readonly sinceIso?: string;
};

/**
 * ISO 8601: a date, or a date-time with an optional `Z` or ±hh:mm offset.
 * Anchored, one pass, no nested repetition.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?)?$/;

export type ParsedInstant = {
  readonly ms: number;
  /** False when the text carried no `Z` or offset and was read as UTC. */
  readonly offsetGiven: boolean;
};

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * An ISO 8601 date or date-time as epoch milliseconds, never read in the
 * host's time zone (0.7.1 policy): a value with no `Z` or offset is read as
 * UTC, and `offsetGiven` says so. `Date.parse` reads `2026-09-26T10:00:00`
 * in the host's zone, so the same call kept a job on a UTC host and dropped
 * it in Los Angeles; it also reads forms like `Sep 26 2026` host-local,
 * which are not ISO 8601 and are not instants here.
 */
export function parseIsoInstant(text: string): ParsedInstant | undefined {
  const m = ISO_INSTANT.exec(text.trim());
  if (m === null) return undefined;
  const num = (i: number): number => (m[i] === undefined ? 0 : Number(m[i]));
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map(num) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const fraction = m[7] === undefined ? 0 : Number(`0.${m[7]}`);
  const zulu = m[8] !== undefined;
  const sign = m[9] === "-" ? -1 : 1;
  const offsetHours = num(10);
  const offsetMinutes = num(11);
  if (offsetHours > 23 || offsetMinutes > 59) return undefined;
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, Math.floor(fraction * 1000));
  const offsetMs = m[9] === undefined ? 0 : sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  return { ms: at.getTime() - offsetMs, offsetGiven: zulu || m[9] !== undefined };
}

/** {@link parseIsoInstant}'s milliseconds, or NaN, for code that sorts and compares. */
function instantMs(text: string): number {
  return parseIsoInstant(text)?.ms ?? Number.NaN;
}

/**
 * Apply the filter to already-folded records.
 *
 * `since` compares PARSED timestamps, never the strings: two valid ISO 8601
 * instants can be spelled differently (`Z` versus `+00:00`, fractional
 * seconds) and a string comparison would order them wrongly. A record whose
 * `enqueuedAt` does not parse is KEPT and flagged, never silently dropped —
 * dropping it would hide a job from a status listing on the strength of a
 * malformed field.
 */
export function filterJobs(
  records: readonly JobRecord[],
  filter: JobFilter,
): { readonly kept: JobRecord[]; readonly unparsedTimestamps: string[] } {
  const since = filter.sinceIso === undefined ? undefined : instantMs(filter.sinceIso);
  const dirs = filter.harnessDirs === undefined ? undefined : new Set(filter.harnessDirs);
  const unparsedTimestamps: string[] = [];
  const kept = records.filter((record) => {
    if (filter.jobId !== undefined && record.jobId !== filter.jobId) return false;
    if (dirs !== undefined && !dirs.has(record.harnessDir)) return false;
    if (filter.harnessId !== undefined && record.harnessId !== filter.harnessId) return false;
    if (filter.kind !== undefined && record.kind !== filter.kind) return false;
    if (filter.state !== undefined && record.state !== filter.state) return false;
    if (since !== undefined && !Number.isNaN(since)) {
      const at = instantMs(record.enqueuedAt);
      if (Number.isNaN(at)) {
        unparsedTimestamps.push(record.jobId);
        return true;
      }
      if (at < since) return false;
    }
    return true;
  });
  return { kept, unparsedTimestamps: unparsedTimestamps.sort(compareStrings) };
}

/** Newest first by enqueue time; an unparseable timestamp sorts last, and
 *  ties break on `jobId` so the order is stable rather than readdir-shaped. */
export function sortJobs(records: readonly JobRecord[]): JobRecord[] {
  const at = (record: JobRecord): number => {
    const ms = instantMs(record.enqueuedAt);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };
  return [...records].sort((a, b) => at(b) - at(a) || compareStrings(a.jobId, b.jobId));
}

/**
 * One job, shaped for a result. Every field comes from the record.
 *
 * The ledger is a machine-wide append-only file the manager writes, and an
 * `error` is whatever a failed child process said. Both are text this
 * package did not write, on their way into a model's context, so each is
 * bounded and stripped of control characters — the FILTERS above run on the
 * record's own values, never on these rendered copies.
 */
export function jobView(record: JobRecord): Record<string, unknown> {
  return {
    jobId: renderText(record.jobId, 200),
    harnessDir: renderStorePath(record.harnessDir),
    ...(record.harnessId !== undefined ? { harnessId: renderText(record.harnessId, 100) } : {}),
    kind: renderText(record.kind, 100),
    state: record.state,
    mutating: record.mutating,
    argv: record.argv.map((part) => renderText(part, 400)),
    enqueuedAt: renderText(record.enqueuedAt, 64),
    ...(record.startedAt !== undefined ? { startedAt: renderText(record.startedAt, 64) } : {}),
    ...(record.endedAt !== undefined ? { endedAt: renderText(record.endedAt, 64) } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.error !== undefined ? { error: renderText(record.error, 1000) } : {}),
    ...(record.forced === true ? { forced: true } : {}),
  };
}

/** How many jobs sit in each state, in a stable key order. */
export function countByState(records: readonly JobRecord[]): Record<string, number> {
  const counts = new Map<string, number>();
  // The KEY is a record's own `state`. The store does not validate it, so a
  // hand-edited or future ledger line puts an arbitrary string here — and it
  // becomes a field name in a count somebody acts on.
  for (const record of records) {
    const key = renderText(record.state, 60);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => compareStrings(a[0], b[0])));
}
