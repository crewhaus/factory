/**
 * Budget periods (`@crewhaus/control-records/budget`, #516): a harness's spend
 * across processes, sub-agents, evals, optimizer calls and rehearsals, per
 * day, week or month in an IANA zone.
 *
 * Spenders append content-free `reserve`, `settle` and `release` lines to the
 * current period's ledger, `.crewhaus/run/control/budget/<periodId>/NNNNNN.jsonl`,
 * and a raise appends a `topup`. A reservation is taken under the budget's own
 * lock (`control/budget/lock`, never the shared control lock); settle and
 * release append without it. A reservation counts until it is settled or
 * released, or until its holder is provably dead AND its lease has passed, so
 * a crash leaks nothing and needs no reaper write. A refusal because the
 * period's cap is used up writes `control/budget-state.json`, which
 * `intakeVerdict` reads as an independent reason; renewal needs no write.
 *
 * Nothing here reads the spec or the clock on its own: the definition and the
 * time come from the caller. No new dependency.
 */
import { createHash } from "node:crypto";
import { closeSync, lstatSync, readdirSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  appendContained,
  ensureDirContained,
  resolveContained,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import { decodeStrict, openRecordFd, parseObject, readAt, readRecordFile } from "./io";
import { type LeaseProbe, defaultLeaseProbe, holderProvablyDead } from "./lease";
import { append, withLedgerLock } from "./ledger";
import { type Ledger, controlPaths } from "./paths";
import { retainedSegments, segmentRel } from "./segments";

// ---------------------------------------------------------------------------
// Period identity
// ---------------------------------------------------------------------------

export type BudgetEvery = "day" | "week" | "month";

/** A declared period, as the IR carries it. */
export type BudgetPeriodDef = {
  readonly every: BudgetEvery;
  readonly usdMicros: number;
  /** ISO date (`YYYY-MM-DD`): the anchor periods are counted from. */
  readonly starts?: string;
  /** IANA zone; UTC when absent. */
  readonly timezone?: string;
};

export type BudgetPeriod = {
  /** `month-2026-11-01`; a definition with a declared anchor or zone carries a short digest of it. */
  readonly periodId: string;
  readonly startsAt: string;
  readonly renewsAt: string;
};

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
/** Monday 1970-01-05: the default week grid, aligned to the epoch's first Monday. */
const DEFAULT_WEEK_ANCHOR = 4;

type LocalDate = { readonly y: number; readonly m: number; readonly d: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether `Intl` knows this zone. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of `ms` in `timeZone`. */
function wallClock(ms: number, timeZone: string): LocalDate & { h: number; mi: number; s: number } {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    y: parts["year"] ?? 1970,
    m: parts["month"] ?? 1,
    d: parts["day"] ?? 1,
    h: parts["hour"] ?? 0,
    mi: parts["minute"] ?? 0,
    s: parts["second"] ?? 0,
  };
}

/** The zone's offset from UTC at `ms`, in ms (wall clock minus UTC). */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant local midnight starts `date` in `timeZone`. */
function localMidnight(date: LocalDate, timeZone: string): number {
  const naive = Date.UTC(date.y, date.m - 1, date.d);
  let guess = naive - offsetAt(naive, timeZone);
  // Twice more: the offset at the guess can differ across a DST change.
  for (let i = 0; i < 2; i++) {
    const next = naive - offsetAt(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** Days since 1970-01-01 of a calendar date (no zone involved). */
function dayNumber(date: LocalDate): number {
  return Math.floor(Date.UTC(date.y, date.m - 1, date.d) / DAY_MS);
}

function dateOfDayNumber(n: number): LocalDate {
  const at = new Date(n * DAY_MS);
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

function addMonths(date: LocalDate, months: number): LocalDate {
  const index = date.y * 12 + (date.m - 1) + months;
  return { y: Math.floor(index / 12), m: (index % 12) + 1, d: date.d };
}

function isoDate(date: LocalDate): string {
  return `${String(date.y).padStart(4, "0")}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
}

function parseIsoDate(text: string): LocalDate | undefined {
  const match = ISO_DATE_RE.exec(text);
  if (match === null) return undefined;
  const date = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  return isoDate(dateOfDayNumber(dayNumber(date))) === text ? date : undefined;
}

/**
 * Why a period definition cannot be used, or `undefined` when it can: an
 * unknown zone, an anchor that is not a calendar date, a monthly anchor past
 * the 28th (no month is clamped), a cap that is not a positive amount.
 */
export function budgetPeriodProblem(def: BudgetPeriodDef): string | undefined {
  if (!(Number.isSafeInteger(def.usdMicros) && def.usdMicros > 0)) {
    return "the period's amount must be a positive number of dollars";
  }
  if (def.timezone !== undefined && !isKnownTimeZone(def.timezone)) {
    return `timezone ${JSON.stringify(def.timezone)} is not a zone this system knows`;
  }
  if (def.starts !== undefined) {
    const anchor = parseIsoDate(def.starts);
    if (anchor === undefined) return `starts ${JSON.stringify(def.starts)} is not a date`;
    if (def.every === "month" && anchor.d > 28) {
      return "a monthly period starts on day 1 to 28, so every month has that day";
    }
  }
  return undefined;
}

/**
 * The short digest a definition carries in its period id when its grid is not
 * the default one. Only what changes the grid counts: the zone when it is not
 * UTC (an explicit `UTC` is the default), a monthly anchor day other than the
 * 1st, a weekly anchor off the Monday grid. A daily period ignores `starts`.
 */
function definitionTag(def: BudgetPeriodDef): string {
  const tz = def.timezone ?? "UTC";
  const anchor = def.starts !== undefined ? parseIsoDate(def.starts) : undefined;
  let grid = "";
  if (anchor !== undefined && def.every === "month" && anchor.d !== 1) grid = `d${anchor.d}`;
  if (anchor !== undefined && def.every === "week") {
    const shift = (((dayNumber(anchor) - DEFAULT_WEEK_ANCHOR) % 7) + 7) % 7;
    if (shift !== 0) grid = `w${shift}`;
  }
  if (tz === "UTC" && grid === "") return "";
  const text = `${def.every}|${grid}|${tz}`;
  return `-${createHash("sha256").update(text).digest("hex").slice(0, 6)}`;
}

/**
 * The period `nowMs` falls in. Days start at local midnight; weeks run seven
 * days from the anchor date (default: Mondays); months start on the anchor's
 * day of the month (default: the 1st). A changed definition yields a new id,
 * so its spend starts afresh and the old ledger stays as history. Throws on a
 * definition {@link budgetPeriodProblem} refuses.
 */
export function periodOf(def: BudgetPeriodDef, nowMs: number): BudgetPeriod {
  const problem = budgetPeriodProblem(def);
  if (problem !== undefined) throw new Error(`budget period: ${problem}`);
  const tz = def.timezone ?? "UTC";
  const anchor = def.starts !== undefined ? parseIsoDate(def.starts) : undefined;
  const today = wallClock(nowMs, tz);
  let start: LocalDate;
  let next: LocalDate;
  if (def.every === "day") {
    start = { y: today.y, m: today.m, d: today.d };
    next = dateOfDayNumber(dayNumber(start) + 1);
  } else if (def.every === "week") {
    const anchorDay = anchor !== undefined ? dayNumber(anchor) : DEFAULT_WEEK_ANCHOR;
    const k = Math.floor((dayNumber(today) - anchorDay) / 7);
    start = dateOfDayNumber(anchorDay + 7 * k);
    next = dateOfDayNumber(anchorDay + 7 * (k + 1));
  } else {
    const d = anchor?.d ?? 1;
    const thisMonth = { y: today.y, m: today.m, d };
    start = today.d >= d ? thisMonth : addMonths(thisMonth, -1);
    next = addMonths(start, 1);
  }
  return {
    periodId: `${def.every}-${isoDate(start)}${definitionTag(def)}`,
    startsAt: new Date(localMidnight(start, tz)).toISOString(),
    renewsAt: new Date(localMidnight(next, tz)).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PERIOD_ID_RE = /^(day|week|month)-\d{4}-\d{2}-\d{2}(?:-[0-9a-f]{6})?$/;

/** Whether `periodId` has the shape {@link periodOf} gives. */
export function isPeriodId(periodId: string): boolean {
  return PERIOD_ID_RE.test(periodId);
}

/** The budget's names under the control directory, relative to the harness. */
export function budgetPaths(harnessDir: string): {
  readonly budgetDir: string;
  readonly budgetLockFile: string;
  readonly budgetStateFile: string;
  readonly periodsFile: string;
} {
  const paths = controlPaths(harnessDir);
  return {
    budgetDir: paths.budgetDir,
    budgetLockFile: paths.budgetLockFile,
    budgetStateFile: paths.budgetStateFile,
    periodsFile: join(paths.budgetDir, "periods.jsonl"),
  };
}

/** The period's ledger: its own segments, on the budget's own lock. */
export function budgetLedger(harnessDir: string, periodId: string): Ledger {
  if (!isPeriodId(periodId)) throw new Error(`not a budget period: ${JSON.stringify(periodId)}`);
  const paths = controlPaths(harnessDir);
  return {
    root: harnessDir,
    records: { dir: join(paths.budgetDir, periodId) },
    lock: paths.budgetLockFile,
    claims: paths.claimsDir,
  };
}

// ---------------------------------------------------------------------------
// Lines and the fold
// ---------------------------------------------------------------------------

/** What started the spend: a run's trigger kind, or the optimizer. */
export type BudgetTrigger = string;

/** One ledger line. Content-free: amounts, ids, model names, the spending process. */
export type BudgetLine = {
  readonly v: 1;
  readonly at: string;
  readonly op: "reserve" | "settle" | "release" | "topup";
  readonly id?: string;
  readonly run?: string;
  readonly root?: string;
  readonly role?: string;
  readonly model?: string;
  readonly trigger?: BudgetTrigger;
  readonly usdMicros: number | null;
  readonly unpriced?: true;
  readonly holder?: { readonly pid: number; readonly startedAt?: number; readonly host: string };
  readonly leaseUntil?: string;
  /** A top-up's receipt id. */
  readonly cmd?: string;
  /** Who raised the limit: a `prn_` id or `local:#<digest>`, never a raw local id. */
  readonly by?: string;
  /** A top-up's reason code. */
  readonly reasonCode?: string;
};

/** The fold of one period, as Home's spend view and the CLI read it. */
export type BudgetFold = {
  readonly periodId: string;
  readonly every: BudgetEvery;
  /**
   * The IANA zone the period starts and renews in (`UTC` when the spec names
   * none). A renewal date is read in this zone: a period that renews at local
   * midnight renews on that local day.
   */
  readonly timezone: string;
  readonly startsAt: string;
  readonly renewsAt: string;
  readonly capUsdMicros: number;
  readonly extensionsUsdMicros: number;
  readonly spentUsdMicros: number;
  readonly reservedUsdMicros: number;
  /** Settled calls nothing could price: their cost is unknown, not $0. */
  readonly unknownCalls: number;
  readonly exhausted: boolean;
  readonly asOf: string;
  /** Lines past the read caps were left out, so the totals are lower bounds. */
  readonly truncated: boolean;
  /** Complete lines that did not parse, counted, never guessed at. */
  readonly gaps: number;
};

type Active = {
  readonly usdMicros: number;
  readonly holder?: BudgetLine["holder"];
  readonly leaseUntilMs?: number;
};

type FoldState = {
  spent: number;
  extensions: number;
  unknownCalls: number;
  gaps: number;
  truncated: boolean;
  readonly active: Map<string, Active>;
};

function emptyFold(): FoldState {
  return { spent: 0, extensions: 0, unknownCalls: 0, gaps: 0, truncated: false, active: new Map() };
}

function applyLine(state: FoldState, line: Record<string, unknown>): void {
  const op = line["op"];
  const id = typeof line["id"] === "string" ? line["id"] : undefined;
  const micros = line["usdMicros"];
  const amount = typeof micros === "number" && Number.isFinite(micros) && micros >= 0 ? micros : 0;
  if (op === "reserve" && id !== undefined) {
    const holder = line["holder"];
    const lease =
      typeof line["leaseUntil"] === "string" ? Date.parse(line["leaseUntil"]) : Number.NaN;
    state.active.set(id, {
      usdMicros: amount,
      ...(holder !== null && typeof holder === "object"
        ? { holder: holder as BudgetLine["holder"] }
        : {}),
      ...(Number.isFinite(lease) ? { leaseUntilMs: lease } : {}),
    });
  } else if (op === "settle") {
    if (id !== undefined) state.active.delete(id);
    if (typeof micros === "number") state.spent += amount;
    else state.unknownCalls += 1;
  } else if (op === "release") {
    if (id !== undefined) state.active.delete(id);
  } else if (op === "topup") {
    state.extensions += amount;
  } else {
    state.gaps += 1;
  }
}

/**
 * Where a reservation stands: `live` inside its lease; `held` past its lease
 * while its holder is not provably dead (it still counts, but nothing can be
 * waited for); `gone` once its holder is provably dead and its lease has
 * passed (it no longer counts).
 */
function standing(
  r: Active,
  nowMs: number,
  probe: LeaseProbe,
  host: string,
): "live" | "held" | "gone" {
  const leaseLive = r.leaseUntilMs === undefined || nowMs < r.leaseUntilMs;
  if (leaseLive) return "live";
  if (r.holder === undefined || typeof r.holder.pid !== "number") return "gone";
  const dead = holderProvablyDead(
    {
      pid: r.holder.pid,
      ...(typeof r.holder.startedAt === "number" ? { startedAtMs: r.holder.startedAt } : {}),
      host: typeof r.holder.host === "string" ? r.holder.host : "",
    },
    probe,
    host,
  );
  return dead ? "gone" : "held";
}

/** Whether a reservation still counts: until its holder is provably dead AND its lease has passed. */
function stillCounts(r: Active, nowMs: number, probe: LeaseProbe, host: string): boolean {
  return standing(r, nowMs, probe, host) !== "gone";
}

/** Bytes a fold reads per segment at most; past it the fold reports `truncated`. */
const MAX_SEGMENT_READ_BYTES = 16 * 1024 * 1024;

/**
 * An incremental reader of one period's segments: it remembers how far it
 * read each segment, so a reserve folds only the lines appended since. A torn
 * final line is left for the next read; a malformed complete line is a gap.
 */
type PeriodReader = { read(): FoldState };

function periodReader(ledger: Ledger): PeriodReader {
  const state = emptyFold();
  const offsets = new Map<number, number>();
  return {
    read() {
      const segs = retainedSegments(ledger);
      if (!segs.ok) {
        state.truncated = true;
        return state;
      }
      for (const seg of segs.segs) {
        const opened = openRecordFd(ledger.root, segmentRel(ledger.records, seg));
        if (!opened.ok) {
          if (opened.code !== "not-found") state.truncated = true;
          continue;
        }
        try {
          const from = offsets.get(seg) ?? 0;
          const size = opened.stats.size;
          if (size <= from) continue;
          const length = Math.min(size - from, MAX_SEGMENT_READ_BYTES);
          if (length < size - from) state.truncated = true;
          const buf = Buffer.allocUnsafe(length);
          const got = readAt(opened.fd, buf, length, from);
          let consumed = 0;
          for (;;) {
            const nl = buf.indexOf(0x0a, consumed);
            if (nl === -1 || nl >= got) break;
            const text = decodeStrict(buf.subarray(consumed, nl));
            consumed = nl + 1;
            if (text === undefined) {
              state.gaps += 1;
              continue;
            }
            if (text.trim() === "") continue;
            const record = parseObject(text);
            if (record === undefined) state.gaps += 1;
            else applyLine(state, record);
          }
          offsets.set(seg, from + consumed);
        } finally {
          closeSync(opened.fd);
        }
      }
      return state;
    },
  };
}

function summarize(
  def: BudgetPeriodDef,
  period: BudgetPeriod,
  state: FoldState,
  nowMs: number,
  probe: LeaseProbe,
  host: string,
): BudgetFold {
  let reserved = 0;
  for (const r of state.active.values()) {
    if (stillCounts(r, nowMs, probe, host)) reserved += r.usdMicros;
  }
  return {
    periodId: period.periodId,
    every: def.every,
    timezone: def.timezone ?? "UTC",
    startsAt: period.startsAt,
    renewsAt: period.renewsAt,
    capUsdMicros: def.usdMicros,
    extensionsUsdMicros: state.extensions,
    spentUsdMicros: state.spent,
    reservedUsdMicros: reserved,
    unknownCalls: state.unknownCalls,
    exhausted: state.spent >= def.usdMicros + state.extensions,
    asOf: new Date(nowMs).toISOString(),
    truncated: state.truncated,
    gaps: state.gaps,
  };
}

/**
 * The current period's totals. Reads only: it creates no file, and an absent
 * ledger folds to zero spend.
 *
 * First consumers: Home's spend view, `crewhaus budget show` and the harness signal.
 */
export function foldBudget(
  harnessDir: string,
  def: BudgetPeriodDef,
  nowMs: number,
  options: { readonly probe?: LeaseProbe; readonly host?: string } = {},
): BudgetFold {
  const period = periodOf(def, nowMs);
  const state = periodReader(budgetLedger(harnessDir, period.periodId)).read();
  return summarize(
    def,
    period,
    state,
    nowMs,
    options.probe ?? defaultLeaseProbe,
    options.host ?? hostname(),
  );
}

/**
 * The day a period renews, as a person reads it: `1 Dec 2026` (`1 Dec` with
 * `year: false`), in the period's own zone, so a period that renews at local
 * midnight names that local day. An unknown zone reads in UTC; an instant that
 * does not parse answers `undefined`.
 *
 * First consumers: `crewhaus budget`, the CLI's refusal line.
 */
export function renewalDay(
  renewsAt: string | undefined,
  timezone: string | undefined,
  options: { readonly year?: boolean } = {},
): string | undefined {
  const at = renewsAt === undefined ? Number.NaN : Date.parse(renewsAt);
  if (!Number.isFinite(at)) return undefined;
  const timeZone = timezone !== undefined && isKnownTimeZone(timezone) ? timezone : "UTC";
  return new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(options.year === false ? {} : { year: "numeric" as const }),
    timeZone,
  });
}

// ---------------------------------------------------------------------------
// Exhaustion state
// ---------------------------------------------------------------------------

export type BudgetState = {
  readonly v: 1;
  readonly periodId: string;
  readonly exhaustedAt: string;
  readonly renewsAt: string;
  /** The zone the period renews in, when the spec names one: a reader shows the renewal day in it. */
  readonly timezone?: string;
};

export type BudgetStateRead =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly record: BudgetState }
  | { readonly state: "unreadable"; readonly reason: string };

const STATE_MAX_BYTES = 16 * 1024;

/** `control/budget-state.json`, read tolerantly. Creates nothing. */
export function readBudgetState(harnessDir: string): BudgetStateRead {
  let read: ReturnType<typeof readRecordFile>;
  try {
    read = readRecordFile(harnessDir, controlPaths(harnessDir).budgetStateFile, STATE_MAX_BYTES);
  } catch (err) {
    return { state: "unreadable", reason: (err as Error).message };
  }
  if (!read.ok) {
    return read.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", reason: read.reason };
  }
  const text = read.truncated ? undefined : decodeStrict(read.bytes);
  const body = text === undefined ? undefined : parseObject(text);
  const periodId = body?.["periodId"];
  const exhaustedAt = body?.["exhaustedAt"];
  const renewsAt = body?.["renewsAt"];
  if (
    body?.["v"] !== 1 ||
    typeof periodId !== "string" ||
    typeof exhaustedAt !== "string" ||
    typeof renewsAt !== "string" ||
    !Number.isFinite(Date.parse(renewsAt))
  ) {
    return { state: "unreadable", reason: "the budget state is not a budget state record" };
  }
  const timezone = body["timezone"];
  return {
    state: "present",
    record: {
      v: 1,
      periodId,
      exhaustedAt,
      renewsAt,
      ...(typeof timezone === "string" && isKnownTimeZone(timezone) ? { timezone } : {}),
    },
  };
}

export type BudgetStateWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Write the exhaustion record whole, atomically, at `0600`. Never throws. */
export function writeBudgetState(harnessDir: string, record: BudgetState): BudgetStateWrite {
  try {
    const rel = controlPaths(harnessDir).budgetStateFile;
    const dir = ensureDirContained(harnessDir, dirname(rel), { mode: 0o700 });
    if (!dir.ok) return { ok: false, reason: dir.reason };
    const body: BudgetState = {
      v: 1,
      periodId: record.periodId,
      exhaustedAt: record.exhaustedAt,
      renewsAt: record.renewsAt,
      ...(record.timezone !== undefined ? { timezone: record.timezone } : {}),
    };
    const written = writeFileSafe(harnessDir, rel, `${JSON.stringify(body)}\n`, {
      overwrite: true,
      mode: 0o600,
    });
    return written.ok ? { ok: true } : { ok: false, reason: written.reason };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Remove the exhaustion record (a raise took the period back under its cap). Never throws. */
export function clearBudgetState(harnessDir: string): BudgetStateWrite {
  const at = resolveContained(harnessDir, controlPaths(harnessDir).budgetStateFile, {
    followLeaf: false,
  });
  if (!at.ok) return at.code === "not-found" ? { ok: true } : { ok: false, reason: at.reason };
  try {
    rmSync(at.real, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// The ledger port
// ---------------------------------------------------------------------------

/** How a refusal answers, matching the spend meter's admission. */
export type BudgetAdmission =
  | { readonly admit: true }
  /**
   * The period's cap is reached. `held` says it is reached only because of
   * reservations past their lease whose holders are not provably dead: they
   * still count, but no settle can be waited for, so the answer is final.
   */
  | { readonly admit: false; readonly on: "spent"; readonly held?: true }
  | { readonly admit: false; readonly on: "others"; readonly settled: Promise<void> };

/** What a reservation names, content-free. */
export type BudgetReserveMeta = {
  readonly run?: string;
  readonly root?: string;
  readonly role?: string;
  readonly model?: string;
};

export type BudgetLedgerOptions = {
  /** What started the spend: the run's trigger kind, or `optimize`. */
  readonly trigger?: BudgetTrigger;
  readonly now?: () => number;
  readonly probe?: LeaseProbe;
  readonly host?: string;
  readonly pid?: number;
  /** How long a reservation counts without its holder, in ms. Default 15 minutes. */
  readonly leaseMs?: number;
  /**
   * How long a refusal on other processes' reservations waits before the
   * caller asks again, in ms. Default 250: another process's settle has no
   * in-process signal to wait on.
   */
  readonly retryMs?: number;
};

/** The port the spend meter reserves the period through (cost-tracker's `SpendLedgerPort`). */
export type BudgetLedgerPort = {
  /** The period a reserve made now lands in. */
  readonly periodId: string;
  reserve(entry: {
    readonly id: string;
    readonly usdMicros: number;
    readonly meta?: BudgetReserveMeta;
  }): Promise<BudgetAdmission>;
  settle(entry: {
    readonly id: string;
    readonly usdMicros: number | null;
    readonly meta?: BudgetReserveMeta;
  }): Promise<void>;
  release(id: string): Promise<void>;
  fold(): BudgetFold;
};

const DEFAULT_LEASE_MS = 15 * 60_000;
const DEFAULT_RETRY_MS = 250;

/** One period's ledger as a spending process holds it. */
type OpenPeriod = {
  readonly period: BudgetPeriod;
  readonly ledger: Ledger;
  readonly reader: PeriodReader;
};

/**
 * Open the period ledger for one spending process. Each reserve lands in the
 * period the clock is in when it is made, so a process that runs across a
 * renewal reserves into the new period; a settle or release goes to the
 * period its reservation was made in. A reserve refused on the period cap
 * writes `budget-state.json`.
 *
 * A reservation records its holder's pid, host and (when the probe can tell)
 * start time, so a recycled pid is provably another process. A refusal that
 * only reservations past their lease stand in the way of is final
 * (`on: "spent"`, `held: true`): nothing would ever settle them, so waiting
 * could not end.
 *
 * First consumers: runtime-core's spend meter and the optimizer's mutation calls.
 */
export function openBudgetLedger(
  harnessDir: string,
  def: BudgetPeriodDef,
  options: BudgetLedgerOptions = {},
): BudgetLedgerPort {
  const now = options.now ?? Date.now;
  const probe = options.probe ?? defaultLeaseProbe;
  const host = options.host ?? hostname();
  const pid = options.pid ?? process.pid;
  const startedAt = probe.startTimeMs(pid);
  const holder = { pid, ...(startedAt !== undefined ? { startedAt } : {}), host };
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  let open: OpenPeriod | undefined;
  /** The period in effect at `nowMs`: a new ledger and reader once the period renews. */
  const periodAt = (nowMs: number): OpenPeriod => {
    const period = periodOf(def, nowMs);
    if (open === undefined || open.period.periodId !== period.periodId) {
      const ledger = budgetLedger(harnessDir, period.periodId);
      open = { period, ledger, reader: periodReader(ledger) };
    }
    return open;
  };
  /** Each open reservation's period, so its settle or release lands where it was made. */
  const reservedIn = new Map<string, OpenPeriod>();
  const at = (): string => new Date(now()).toISOString();
  const lineOf = (
    op: BudgetLine["op"],
    id: string,
    usdMicros: number | null,
    meta: BudgetReserveMeta | undefined,
  ): BudgetLine => ({
    v: 1,
    at: at(),
    op,
    id,
    ...(meta?.run !== undefined ? { run: meta.run } : {}),
    ...(meta?.root !== undefined ? { root: meta.root } : {}),
    ...(meta?.role !== undefined ? { role: meta.role } : {}),
    ...(meta?.model !== undefined ? { model: meta.model } : {}),
    ...(options.trigger !== undefined ? { trigger: options.trigger } : {}),
    usdMicros,
    ...(op === "settle" && usdMicros === null ? { unpriced: true as const } : {}),
  });
  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, retryMs);
      (timer as { unref?: () => void }).unref?.();
    });
  /** Append a settle or release to the period `id` was reserved in (the current one if unknown). */
  const appendFor = (id: string, line: BudgetLine): void => {
    const where = reservedIn.get(id) ?? periodAt(now());
    reservedIn.delete(id);
    const written = append(where.ledger, line);
    if (!written.ok) throw new Error(`budget ledger: ${written.reason}`);
  };

  return {
    get periodId() {
      return periodAt(now()).period.periodId;
    },
    async reserve({ id, usdMicros, meta }) {
      const target = periodAt(now());
      const { period, ledger, reader } = target;
      const answer = await withLedgerLock(ledger, (lockedAppend): BudgetAdmission => {
        const state = reader.read();
        const nowMs = now();
        const fold = summarize(def, period, state, nowMs, probe, host);
        const cap = fold.capUsdMicros + fold.extensionsUsdMicros;
        if (fold.spentUsdMicros >= cap) {
          writeBudgetState(harnessDir, {
            v: 1,
            periodId: period.periodId,
            exhaustedAt: new Date(nowMs).toISOString(),
            renewsAt: period.renewsAt,
            ...(def.timezone !== undefined ? { timezone: def.timezone } : {}),
          });
          return { admit: false, on: "spent" };
        }
        let live = 0;
        let held = 0;
        for (const [rid, r] of state.active) {
          if (rid === id) continue;
          const where = standing(r, nowMs, probe, host);
          if (where === "live") live += r.usdMicros;
          else if (where === "held") held += r.usdMicros;
        }
        if (fold.spentUsdMicros + live + held >= cap) {
          // A reservation inside its lease settles, releases or passes its lease, so
          // the wait is bounded by the leases; past them only `held` ones are left.
          if (live > 0) {
            return { admit: false, on: "others", settled: wait() };
          }
          return { admit: false, on: "spent", held: true };
        }
        const written = lockedAppend({
          ...lineOf("reserve", id, Math.max(0, usdMicros), meta),
          holder,
          leaseUntil: new Date(nowMs + leaseMs).toISOString(),
        });
        if (!written.ok) throw new Error(`budget ledger: ${written.reason}`);
        return { admit: true };
      });
      if ("admit" in answer) {
        if (answer.admit) reservedIn.set(id, target);
        return answer;
      }
      throw new Error(`budget ledger: ${answer.reason}`);
    },
    async settle({ id, usdMicros, meta }) {
      appendFor(id, lineOf("settle", id, usdMicros, meta));
    },
    async release(id) {
      appendFor(id, lineOf("release", id, null, undefined));
    },
    fold() {
      const nowMs = now();
      const { period, reader } = periodAt(nowMs);
      return summarize(def, period, reader.read(), nowMs, probe, host);
    },
  };
}

/**
 * A maintainer's raise of the current period: one `topup` line, under the
 * budget lock, applied only when `expect` still names the current period (a
 * stale `expect` answers `stale`). The exhaustion record is cleared when the
 * raised cap is above the spend, and kept otherwise.
 *
 * First consumers: `crewhaus budget extend` and `budget.extend`.
 */
export async function extendBudget(
  harnessDir: string,
  def: BudgetPeriodDef,
  input: {
    readonly usdMicros: number;
    readonly reasonCode: string;
    readonly expect: string;
    /** The receipt id. */
    readonly cmd: string;
    /** `prn_…` or `local:#<digest>`. */
    readonly by: string;
    readonly nowMs: number;
  },
): Promise<
  | { readonly ok: true; readonly fold: BudgetFold }
  | { readonly ok: false; readonly reason: "stale"; readonly periodId: string }
  | { readonly ok: false; readonly reason: "refused"; readonly detail: string }
> {
  const period = periodOf(def, input.nowMs);
  if (input.expect !== period.periodId) {
    return { ok: false, reason: "stale", periodId: period.periodId };
  }
  if (!(Number.isSafeInteger(input.usdMicros) && input.usdMicros > 0)) {
    return { ok: false, reason: "refused", detail: "a raise is a positive amount" };
  }
  const ledger = budgetLedger(harnessDir, period.periodId);
  const done = await withLedgerLock(ledger, (lockedAppend) =>
    lockedAppend({
      v: 1,
      at: new Date(input.nowMs).toISOString(),
      op: "topup",
      usdMicros: input.usdMicros,
      cmd: input.cmd,
      by: input.by,
      reasonCode: input.reasonCode,
    } satisfies BudgetLine),
  );
  if (!done.ok) return { ok: false, reason: "refused", detail: done.reason };
  const fold = foldBudget(harnessDir, def, input.nowMs);
  const state = readBudgetState(harnessDir);
  if (!fold.exhausted && state.state === "present") clearBudgetState(harnessDir);
  return { ok: true, fold };
}

// ---------------------------------------------------------------------------
// Closed periods
// ---------------------------------------------------------------------------

/** One closed period's summary line in `budget/periods.jsonl`. */
export type BudgetPeriodSummary = {
  readonly v: 1;
  readonly periodId: string;
  readonly closedAt: string;
  readonly spentUsdMicros: number;
  readonly extensionsUsdMicros: number;
  readonly unknownCalls: number;
  readonly truncated: boolean;
};

/** The closed-period summaries, oldest first. Reads only. */
export function readBudgetPeriods(harnessDir: string): {
  readonly periods: readonly BudgetPeriodSummary[];
  readonly gaps: number;
} {
  const rel = budgetPaths(harnessDir).periodsFile;
  const read = readRecordFile(harnessDir, rel, 4 * 1024 * 1024);
  if (!read.ok) return { periods: [], gaps: 0 };
  const text = decodeStrict(read.bytes) ?? "";
  const periods: BudgetPeriodSummary[] = [];
  let gaps = 0;
  const lines = text.split("\n");
  // A last line without its `\n` is still landing: it waits.
  if (!text.endsWith("\n")) lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const body = parseObject(line);
    if (
      body?.["v"] === 1 &&
      typeof body["periodId"] === "string" &&
      typeof body["spentUsdMicros"] === "number"
    ) {
      periods.push(body as unknown as BudgetPeriodSummary);
    } else {
      gaps += 1;
    }
  }
  return { periods, gaps };
}

/** When a period id's period started, and roughly how long it lasts (from its id alone). */
function periodSpan(periodId: string): { startMs: number; spanDays: number } | undefined {
  const match = /^(day|week|month)-(\d{4}-\d{2}-\d{2})/.exec(periodId);
  if (match === null) return undefined;
  const start = parseIsoDate(match[2] as string);
  if (start === undefined) return undefined;
  const spanDays = match[1] === "day" ? 1 : match[1] === "week" ? 7 : 31;
  return { startMs: Date.UTC(start.y, start.m - 1, start.d), spanDays };
}

/**
 * The sweep over closed periods: one summary line per closed period in
 * `budget/periods.jsonl`, and a closed period's segments removed once its
 * summary exists and the period after it has also closed. The current period
 * is never touched. Returns what it did.
 *
 * First consumer: control-service's runtime sweep.
 */
export function sweepBudgetPeriods(
  harnessDir: string,
  def: BudgetPeriodDef,
  nowMs: number,
): { readonly summarized: readonly string[]; readonly removed: readonly string[] } {
  const current = periodOf(def, nowMs).periodId;
  const paths = budgetPaths(harnessDir);
  // The budget directory itself, followed and still inside the harness.
  const at = resolveContained(harnessDir, paths.budgetDir);
  if (!at.ok) return { summarized: [], removed: [] };
  let names: string[];
  try {
    if (!lstatSync(at.real).isDirectory()) return { summarized: [], removed: [] };
    names = readdirSync(at.real);
  } catch {
    return { summarized: [], removed: [] };
  }
  const known = new Set(readBudgetPeriods(harnessDir).periods.map((p) => p.periodId));
  const summarized: string[] = [];
  const removed: string[] = [];
  for (const name of names.sort()) {
    if (!isPeriodId(name) || name === current) continue;
    // Only a real directory is a period: a link, or anything else, is never read or emptied.
    if (!isPlainDirectory(join(at.real, name))) continue;
    const span = periodSpan(name);
    if (span === undefined) continue;
    // Closed: the period cannot still be running (a generous bound, never early).
    const closedBy = span.startMs + (span.spanDays + 1) * DAY_MS;
    if (nowMs < closedBy) continue;
    if (!known.has(name)) {
      const ledger = budgetLedger(harnessDir, name);
      const state = periodReader(ledger).read();
      const line: BudgetPeriodSummary = {
        v: 1,
        periodId: name,
        closedAt: new Date(nowMs).toISOString(),
        spentUsdMicros: state.spent,
        extensionsUsdMicros: state.extensions,
        unknownCalls: state.unknownCalls,
        truncated: state.truncated,
      };
      const dir = ensureDirContained(harnessDir, paths.budgetDir, { mode: 0o700 });
      if (!dir.ok) continue;
      const written = appendContained(harnessDir, paths.periodsFile, `${JSON.stringify(line)}\n`, {
        mode: 0o600,
        hardLinks: "refuse",
      });
      if (written.ok) {
        known.add(name);
        summarized.push(name);
      }
      continue;
    }
    // Summarized: its segments go once the period after it has closed too.
    if (nowMs < span.startMs + (2 * span.spanDays + 1) * DAY_MS) continue;
    if (removePeriodDir(harnessDir, paths.budgetDir, at.real, name)) removed.push(name);
  }
  return { summarized, removed };
}

/** Whether `abs` is a directory itself, not a link to one. */
function isPlainDirectory(abs: string): boolean {
  try {
    const st = lstatSync(abs);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Remove one closed period's directory: only when it is a real directory that
 * resolves inside the harness, and only its regular files, each judged without
 * following it. Anything else is left, and so is the directory.
 */
function removePeriodDir(
  harnessDir: string,
  budgetRel: string,
  budgetReal: string,
  name: string,
): boolean {
  const lexical = join(budgetReal, name);
  if (!isPlainDirectory(lexical)) return false;
  const followed = resolveContained(harnessDir, join(budgetRel, name));
  if (!followed.ok || followed.real !== lexical) return false;
  try {
    for (const file of readdirSync(lexical)) {
      const entry = join(lexical, file);
      if (!lstatSync(entry).isFile()) continue;
      unlinkSync(entry);
    }
    rmdirSync(lexical);
    return true;
  } catch {
    // Left for the next sweep.
    return false;
  }
}
