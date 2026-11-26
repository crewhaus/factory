/**
 * A harness's budget events on its stream (#516, #507): one content-free envelope per
 * ledger line of the period current when the stream opened, and only from those lines.
 * No read emits anything: a handler, `budget.get`, Home's status line and the sweep only
 * fold the ledger.
 *
 * - `budget.unpriced`: a settled call nothing could price, so its cost is unknown.
 * - `budget.exhausted`: the settle line at which the period's settled spend reaches its
 *   limit (the spec's cap plus the extensions recorded before it), from below.
 * - `budget.extended`: a recorded raise.
 * - `budget.renewed`: the first line of a period that follows another.
 *
 * A line belongs to the period folder the stream reads it from, and is judged by the lines
 * of that period before it: one fold per period, carried forward over each line written
 * since, so every line is read once however often lines are judged, and the same line
 * answers the same event however a stream reaches it (a replay from any cursor sends each
 * event once). The fold stops at fixed caps: past them no exhaustion and no renewal is
 * judged (a raise and an unpriced call still are, from their own line), and the budget's
 * own read still shows the period as it stands. A stream follows the period it opened in;
 * once that period renews, the next stream it opens reads the new one.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type CursorSources, EVENT_TAXONOMY, type EventType } from "@crewhaus/control-contract";
import { type RecordSource, controlPaths, positionsAtEnd, resume } from "@crewhaus/control-records";
import {
  type BudgetPeriodDef,
  budgetLedger,
  isPeriodId,
  periodOf,
} from "@crewhaus/control-records/budget";
import { declaredBudgetPeriod } from "../budget";
import { resolveContained } from "../safety";
import type { EnvelopeFields, StreamSourceDecl } from "./event-map";

/** The most of one period's ledger folded to judge a line by its neighbours. */
export const BUDGET_EVENT_CAPS = { maxLines: 20_000, maxBytes: 8 * 1024 * 1024 } as const;

/** The folder a harness with no declared period streams from: inside it, never written. */
const NO_PERIOD = "no-period";

/** The most of a spec read to find its period, as `budget.get` reads it. */
const SPEC_MAX_BYTES = 1024 * 1024;

/** The period a spec declares, read once per spec file as it stands. */
const defs = new Map<
  string,
  { readonly stamp: string; readonly def: BudgetPeriodDef | undefined }
>();

function periodDefOf(harnessDir: string): BudgetPeriodDef | undefined {
  const path = resolveContained(harnessDir, "crewhaus.yaml");
  let stamp = "absent";
  if (path !== undefined) {
    try {
      const stats = statSync(path);
      stamp = `${stats.mtimeMs}:${stats.size}`;
    } catch {
      stamp = "absent";
    }
  }
  const cached = defs.get(harnessDir);
  if (cached !== undefined && cached.stamp === stamp) return cached.def;
  let text: string | undefined;
  if (path !== undefined && stamp !== "absent") {
    try {
      const read = readFileSync(path, "utf8");
      text = read.length > SPEC_MAX_BYTES ? undefined : read;
    } catch {
      text = undefined;
    }
  }
  const def = text === undefined ? undefined : declaredBudgetPeriod(text);
  if (defs.size >= 256) defs.delete(defs.keys().next().value as string);
  defs.set(harnessDir, { stamp, def });
  return def;
}

/** The ledger the stream reads: the period current now, or a folder that holds nothing. */
export function budgetStreamSource(harnessDir: string, nowMs: number): RecordSource {
  const def = periodDefOf(harnessDir);
  if (def !== undefined) {
    try {
      const ledger = budgetLedger(harnessDir, periodOf(def, nowMs).periodId);
      return { root: ledger.root, records: ledger.records };
    } catch {
      // A period the runtime cannot place reads as none.
    }
  }
  return {
    root: harnessDir,
    records: { dir: join(controlPaths(harnessDir).budgetDir, NO_PERIOD) },
  };
}

/**
 * One period's ledger folded so far: where the fold stopped, the running spend against the
 * running limit, and only the lines whose event depends on their neighbours (each crossing
 * and the period's first line), as digests. A fold that reached the caps stops for good.
 */
type PeriodFold = {
  cursor: CursorSources | undefined;
  lines: number;
  bytes: number;
  limit: number;
  spent: number;
  readonly crossings: Set<string>;
  first?: string;
  renews: boolean;
  capped: boolean;
};

/** The folds kept, one per harness, period and declared limit. */
const FOLDS_KEPT = 32;
const folds = new Map<string, PeriodFold>();

const foldWork = { reads: 0, lines: 0 };
/** The ledger reads the folds made and the lines they read: what a test counts, never times. */
export function _budgetFoldReadsForTest(): { readonly reads: number; readonly lines: number } {
  return { ...foldWork };
}

/** Whether the harness kept a period before `periodId`. Reads one directory listing. */
function followsAnother(harnessDir: string, periodId: string): boolean {
  const dir = resolveContained(harnessDir, controlPaths(harnessDir).budgetDir);
  if (dir === undefined) return false;
  try {
    return readdirSync(dir).some(
      (name) => name === "periods.jsonl" || (isPeriodId(name) && name < periodId),
    );
  } catch {
    return false;
  }
}

const digestOf = (record: Readonly<Record<string, unknown>>): string =>
  createHash("sha256").update(JSON.stringify(record)).digest("base64url").slice(0, 22);

function freshFold(def: BudgetPeriodDef): PeriodFold {
  return {
    cursor: undefined,
    lines: 0,
    bytes: 0,
    limit: def.usdMicros,
    spent: 0,
    crossings: new Set(),
    renews: false,
    capped: false,
  };
}

/**
 * Folds the lines past the fold's cursor, up to what is left of the caps: each line is
 * read once, however many lines are judged. Answers `false` when the ledger diverged
 * from what was folded (a replaced file), so the caller folds it again from the start.
 */
function extend(
  fold: PeriodFold,
  harnessDir: string,
  periodId: string,
  source: RecordSource,
): boolean {
  const maxLines = BUDGET_EVENT_CAPS.maxLines - fold.lines;
  const maxBytes = BUDGET_EVENT_CAPS.maxBytes - fold.bytes;
  if (maxLines <= 0 || maxBytes <= 0) {
    fold.capped = true;
    return true;
  }
  foldWork.reads += 1;
  const answer = resume({ budget: source }, fold.cursor, { maxLines, maxBytes });
  for (const item of answer.items) {
    if (item.kind === "reset") return false;
    if (item.kind !== "line") continue;
    foldWork.lines += 1;
    fold.lines += 1;
    fold.bytes += Math.max(0, item.after.off - item.off);
    if (fold.first === undefined) {
      fold.first = digestOf(item.record);
      fold.renews = followsAnother(harnessDir, periodId);
    }
    const usd = item.record["usdMicros"];
    if (typeof usd !== "number" || !Number.isFinite(usd)) continue;
    if (item.record["op"] === "topup") fold.limit += usd;
    if (item.record["op"] === "settle") {
      const before = fold.spent;
      fold.spent += usd;
      if (before < fold.limit && fold.spent >= fold.limit) {
        fold.crossings.add(digestOf(item.record));
      }
    }
  }
  fold.cursor = answer.next;
  if (fold.lines >= BUDGET_EVENT_CAPS.maxLines || fold.bytes >= BUDGET_EVENT_CAPS.maxBytes) {
    fold.capped = true;
  }
  return true;
}

/** The period's fold, carried forward over any lines written since it was last read. */
function foldOf(
  harnessDir: string,
  def: BudgetPeriodDef,
  periodId: string,
): PeriodFold | undefined {
  let source: RecordSource;
  try {
    const ledger = budgetLedger(harnessDir, periodId);
    source = { root: ledger.root, records: ledger.records };
  } catch {
    return undefined;
  }
  const key = `${harnessDir}\u0000${periodId}\u0000${JSON.stringify(def)}`;
  let fold = folds.get(key);
  if (fold === undefined) {
    fold = freshFold(def);
    if (folds.size >= FOLDS_KEPT) folds.delete(folds.keys().next().value as string);
    folds.set(key, fold);
  }
  if (fold.capped) return fold;
  const sources = { budget: source };
  if (fold.cursor !== undefined && positionsAtEnd(sources, fold.cursor)) return fold;
  if (!extend(fold, harnessDir, periodId, source)) {
    fold = freshFold(def);
    folds.set(key, fold);
    extend(fold, harnessDir, periodId, source);
  }
  return fold;
}

/**
 * The period a line belongs to: the folder the stream reads it from. A settle or a
 * release lands in the period its reservation was made in, whatever its own time says,
 * so the line's time names a period only when no folder is given.
 */
function periodIdOf(
  def: BudgetPeriodDef,
  record: Readonly<Record<string, unknown>>,
  source: RecordSource | undefined,
): string | undefined {
  if (source !== undefined) {
    const records = "dir" in source.records ? source.records.dir : undefined;
    const name = records === undefined ? undefined : basename(records);
    return name !== undefined && isPeriodId(name) ? name : undefined;
  }
  const at = typeof record["at"] === "string" ? Date.parse(record["at"]) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  try {
    return periodOf(def, at).periodId;
  } catch {
    return undefined;
  }
}

function envelope(
  type: EventType,
  record: Readonly<Record<string, unknown>>,
  harness: string,
  payload: Readonly<Record<string, unknown>>,
): EnvelopeFields {
  const at = String(record["at"]);
  const run = record["run"];
  return {
    type,
    at,
    ingestedAt: at,
    harness,
    sensitivity: EVENT_TAXONOMY[type].sensitivity,
    ...(typeof run === "string" && run !== "" ? { run } : {}),
    payload,
  };
}

/**
 * A budget ledger line as its event, or `undefined` for a line that is none. `source` is
 * the ledger the stream reads the line from.
 */
export function budgetLineEvent(
  record: Readonly<Record<string, unknown>>,
  harness: string,
  harnessDir: string | undefined,
  source?: RecordSource,
): EnvelopeFields | undefined {
  if (harnessDir === undefined || record["v"] !== 1) return undefined;
  const def = periodDefOf(harnessDir);
  if (def === undefined) return undefined;
  const periodId = periodIdOf(def, record, source);
  if (periodId === undefined) return undefined;
  const fold = foldOf(harnessDir, def, periodId);
  if (fold === undefined) return undefined;
  const text = digestOf(record);
  if (fold.renews && fold.first === text) {
    return envelope("budget.renewed", record, harness, { periodId });
  }
  if (fold.crossings.has(text)) {
    return envelope("budget.exhausted", record, harness, { periodId, reason: "limit_reached" });
  }
  if (record["op"] === "topup" && typeof record["usdMicros"] === "number") {
    return envelope("budget.extended", record, harness, {
      periodId,
      usdMicros: record["usdMicros"],
      ...(typeof record["reasonCode"] === "string" ? { reasonCode: record["reasonCode"] } : {}),
    });
  }
  if (record["op"] === "settle" && record["unpriced"] === true) {
    return envelope("budget.unpriced", record, harness, { periodId });
  }
  return undefined;
}

/** The budget's source of a harness's stream. */
export const BUDGET_STREAM_SOURCE: StreamSourceDecl = {
  name: "budget",
  source: (harnessDir) => budgetStreamSource(harnessDir, Date.now()),
  eventOf: budgetLineEvent,
};
