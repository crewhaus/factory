/**
 * Runs through the API (#507, #513): a harness's runs and one run, read from its run
 * ledger (content-free), how a run ended, and the run commands, each carried out by the
 * control service's run adapter for the harness's shape. A command is planned first, so
 * every refusal (an operator record, an old build, a daemon that is not there, a run that
 * ended) is answered before anything is written; its effect runs once the receipt is.
 *
 * A service that started a run may read, list and cancel its own runs without reading the
 * whole harness (`creating-service`). A run whose records name a person's records answers
 * its result with `hidden: ["people"]` and no content unless the people domain releases it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CANONICAL_RUN_ID_RE,
  type CommandReceipt,
  type CursorPosition,
  ERROR_CODES,
  EXECUTION_RUN_ID_RE,
  type ErrorCode,
  mintRunId,
  parseRef,
} from "@crewhaus/control-contract";
import {
  type LedgerRecord,
  type RecordSource,
  readPage,
  runsLedger,
} from "@crewhaus/control-records";
import {
  RUNS_PROJECTION,
  type RunHome,
  type RunPlan,
  type RunRefusal,
  caughtUpModel,
  harnessesOfRun,
  runAdapterFor,
  runRefOf,
} from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { RUN_LEDGER_NAME, readPrunedRuns, runEventsPath } from "@crewhaus/harness-supervisor";
import type { V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { emptyOf, nextCursor, pagingOf, snapshotCursor } from "./lists";
import { entryOf, harnessOf, liveDirOf, liveDirOr409 } from "./resolve";
import { type Submitted, acceptedAnswer, replayedCommand, submitCommand } from "./submit";

/** A ledger's own fields, never part of a run as served. */
const BOOKKEEPING = new Set(["claim", "gen", "repaired"]);

const TERMINAL = new Set(["interrupted", "succeeded", "failed", "cancelled"]);

/** How many of a harness's newest run ledger lines a run's harness is looked for in. */
export const RUN_LOOKUP_LINES = 1000;

/** A run as the API serves it: its newest row, the ledger's own fields left out. */
function servedRun(record: LedgerRecord, harness: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record)) {
    if (!BOOKKEEPING.has(name)) out[name] = value;
  }
  return { ...out, harness };
}

/** One run's rows among a harness's newest lines, newest first, and who started it. */
type RunFound = {
  readonly entry: HangarHarnessEntry;
  readonly dir: string;
  readonly rows: readonly LedgerRecord[];
  readonly by?: string;
};

/** A run's rows in one harness's newest lines, newest first; empty when none is there. */
function rowsIn(dir: string, runId: string): LedgerRecord[] {
  try {
    return readPage(runsLedger(dir), { limit: RUN_LOOKUP_LINES })
      .items.map((item) => item.record)
      .filter((record) => record["id"] === runId);
  } catch {
    return [];
  }
}

function byOf(rows: readonly LedgerRecord[]): string | undefined {
  // The row it entered with names who asked for it.
  const entry = [...rows]
    .reverse()
    .find((row) => row["state"] === "queued" || row["state"] === "running");
  const by = entry?.["by"];
  return typeof by === "string" ? by : undefined;
}

/**
 * The registered harness whose run ledger holds `runId`: the `?harness=` hint's, else the
 * one harness among the registered ones whose newest lines name it. Two that both do, or
 * none, is `undefined`. Reads only.
 */
export function findRun(
  deps: V1Context["deps"],
  runId: string,
  hint: string | undefined,
): RunFound | undefined {
  // A canonical run's rows only: an execution id is never looked up in a run ledger.
  if (!CANONICAL_RUN_ID_RE.test(runId)) return undefined;
  const at = (entry: HangarHarnessEntry): RunFound | undefined => {
    const dir = liveDirOf(entry);
    if (dir === undefined) return undefined;
    const rows = rowsIn(dir, runId);
    if (rows.length === 0) return undefined;
    const by = byOf(rows);
    return { entry, dir, rows, ...(by !== undefined ? { by } : {}) };
  };
  if (hint !== undefined) {
    const hinted = entryOf(deps, hint);
    return hinted === undefined ? undefined : at(hinted);
  }
  // The read models' index first; the scan below when it does not settle it.
  const indexed = harnessesOfRun(deps.hangarRoot, runId);
  if (indexed !== undefined) {
    const hits = indexed
      .map((id) => deps.registry.get(id))
      .filter(
        (entry): entry is HangarHarnessEntry => entry !== undefined && entry.archived === undefined,
      )
      .map(at)
      .filter((hit): hit is RunFound => hit !== undefined);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return undefined;
  }
  const found: RunFound[] = [];
  for (const entry of deps.registry.list()) {
    if (entry.archived !== undefined) continue;
    const here = at(entry);
    if (here !== undefined) found.push(here);
    if (found.length > 1) return undefined;
  }
  return found[0];
}

/** A supervisor execution found in one harness: its ledger names it, or its prune does. */
export type ExecutionFound = {
  readonly entry: HangarHarnessEntry;
  readonly dir: string;
  /** Retention removed its files, and its prune is on record. */
  readonly pruned: boolean;
  /** Its supervisor ledger lines among the newest ones, newest first. */
  readonly rows: readonly LedgerRecord[];
};

/** The supervisor ledger, `.crewhaus/run/runs.jsonl`, as one record file. */
export function supervisorLedgerOf(dir: string): RecordSource {
  return { root: dir, records: { file: join(".crewhaus", "run", RUN_LEDGER_NAME) } };
}

/** Execution `id`'s lines among a harness's newest supervisor ledger lines, newest first. */
function executionRowsIn(dir: string, id: string): LedgerRecord[] {
  try {
    return readPage(supervisorLedgerOf(dir), { limit: RUN_LOOKUP_LINES })
      .items.map((item) => item.record)
      .filter((record) => record["runId"] === id);
  } catch {
    return [];
  }
}

/**
 * The registered harness whose supervisor ledger (or prune record) names execution `id`
 * among its newest lines: the `?harness=` hint's, else the one harness that does. Two, or
 * none, is `undefined`. Each record is read contained and bounded. Reads only.
 */
export function findExecution(
  deps: V1Context["deps"],
  id: string,
  hint: string | undefined,
): ExecutionFound | undefined {
  if (!EXECUTION_RUN_ID_RE.test(id)) return undefined;
  const at = (entry: HangarHarnessEntry): ExecutionFound | undefined => {
    const dir = liveDirOf(entry);
    if (dir === undefined) return undefined;
    const rows = executionRowsIn(dir, id);
    const pruned = readPrunedRuns(dir).has(id) && !existsSync(runEventsPath(dir, id));
    if (pruned || rows.length > 0) return { entry, dir, pruned, rows };
    return undefined;
  };
  if (hint !== undefined) {
    const hinted = entryOf(deps, hint);
    return hinted === undefined ? undefined : at(hinted);
  }
  const found: ExecutionFound[] = [];
  for (const entry of deps.registry.list()) {
    if (entry.archived !== undefined) continue;
    const here = at(entry);
    if (here !== undefined) found.push(here);
    if (found.length > 1) return undefined;
  }
  return found[0];
}

/**
 * Whether `by` started a run recorded among a harness's newest run-ledger lines: what
 * lets a service list that harness's runs (its own only) without reading the harness.
 * Reads only.
 */
export function startedRunIn(entry: HangarHarnessEntry, by: string): boolean {
  const dir = liveDirOf(entry);
  if (dir === undefined) return false;
  try {
    return readPage(runsLedger(dir), { limit: RUN_LOOKUP_LINES }).items.some(
      (item) => item.record["by"] === by,
    );
  } catch {
    return false;
  }
}

function notFound(): V1Error {
  return new V1Error({
    status: 404,
    code: "not_found",
    reason: "run_unknown",
    message: "This Home has no run by that id.",
    remedy: "Name its harness with `?harness=`, or run `crewhaus runs list --harness <h>`.",
  });
}

/** The run the request's `{run}` names, or 404. An execution id names no run here. */
function runOf(ctx: V1Context): RunFound & { readonly runId: string } {
  const runId = String(ctx.params["run"]);
  if (EXECUTION_RUN_ID_RE.test(runId)) throw notFound();
  const found = findRun(ctx.deps, runId, ctx.query["harness"]);
  if (found === undefined) throw notFound();
  return { ...found, runId };
}

/** Whether the caller may see the whole harness, or only the runs it started itself. */
function ownOnly(ctx: V1Context, harness: string): boolean {
  if (ctx.access.canRead(harness)) return false;
  return ctx.access.caller.via === "service";
}

/** A plan's refusal as the API's error. */
function refusalError(refusal: RunRefusal): V1Error {
  const status = (ERROR_CODES as Readonly<Record<string, { statuses: readonly number[] }>>)[
    refusal.code
  ]?.statuses[0];
  return new V1Error({
    status: status ?? 500,
    code: refusal.code as ErrorCode,
    reason: refusal.reason,
    message: refusal.message,
    ...(refusal.verb !== undefined ? { verb: refusal.verb } : {}),
    ...(refusal.remedy !== undefined ? { remedy: refusal.remedy } : {}),
  });
}

/** What Home lends a run command for one harness. */
async function homeFor(ctx: V1Context, entry: HangarHarnessEntry): Promise<RunHome> {
  const deps = ctx.deps;
  const target = deps.controlTarget === undefined ? undefined : await deps.controlTarget(entry);
  const startRunJob = deps.startRunJob;
  const stopRunJob = deps.stopRunJob;
  return {
    ...(startRunJob !== undefined
      ? { startRunJob: (_dir: string, apiRun) => startRunJob(entry, apiRun) }
      : {}),
    ...(stopRunJob !== undefined
      ? { stopRunJob: (_dir: string, runId: string) => stopRunJob(entry, runId) }
      : {}),
    ...(deps.controlClient !== undefined ? { controlClient: deps.controlClient } : {}),
    ...(target !== undefined ? { controlTarget: () => target } : {}),
    now: deps.now,
  };
}

/** The run a receipt's run effect names, for a replay. */
function runOfReceipt(receipt: CommandReceipt): string | undefined {
  for (const effect of receipt.effects) {
    if (effect.kind !== "run" || typeof effect.ref !== "string") continue;
    const parsed = parseRef(effect.ref);
    if (!("error" in parsed) && parsed.kind === "run") return parsed.id;
  }
  const target = parseRef(receipt.target);
  return !("error" in target) && target.kind === "run" ? target.id : undefined;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const list: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOf(entry);
  const paging = pagingOf(ctx.query, "runs");
  if (dir === undefined) {
    return {
      status: 200,
      body: {
        items: [],
        snapshotAt: snapshotCursor("runs", []),
        empty: { reason: "unreachable", remedy: "The harness folder is missing." },
      },
    };
  }
  const own = ownOnly(ctx, entry.id) ? ctx.access.caller.principal : undefined;
  const ledger = runsLedger(dir);
  // Newest first, each run once, at the line it entered with.
  const entries: Array<{
    readonly id: string;
    readonly record: LedgerRecord;
    readonly at: CursorPosition;
  }> = [];
  let snapshotAt: readonly CursorPosition[] | undefined;
  let gaps = 0;
  let before = paging.before;
  let next: CursorPosition | undefined;
  const seen = new Set<string>();
  outer: for (;;) {
    const page = readPage(ledger, {
      limit: Math.max(paging.limit, 64),
      ...(before !== undefined ? { before } : {}),
    });
    snapshotAt ??= page.snapshotAt;
    gaps += page.gaps.length;
    for (const item of page.items) {
      const id = item.record["id"];
      if (typeof id !== "string") continue;
      const state = String(item.record["state"]);
      if (seen.has(id) || (state !== "queued" && state !== "running")) continue;
      if (own !== undefined && item.record["by"] !== own) continue;
      seen.add(id);
      entries.push({ id, record: item.record, at: item.at });
      if (entries.length === paging.limit) {
        next = item.at;
        break outer;
      }
    }
    if (page.next === undefined) break;
    before = page.next;
  }
  // Each listed run as it stands now, from the run read model or the whole ledger: never
  // from this page's lines alone.
  const newest = newestRowsOf(ctx, entry.id, dir, entries);
  const items = entries.map((e) => servedRun(newest.rows.get(e.id) ?? e.record, entry.id));
  const verb = `crewhaus runs list --harness ${entry.id}`;
  return {
    status: 200,
    body: {
      items,
      ...(next !== undefined ? { next: nextCursor("runs", next) } : {}),
      snapshotAt: snapshotCursor("runs", snapshotAt ?? []),
      asOf: new Date(ctx.deps.now()).toISOString(),
      stale: newest.stale,
      freshness: newest.freshness,
      ...(gaps > 0
        ? { truncated: { reason: "unreadable_lines", verb } }
        : newest.capped
          ? { truncated: { reason: "fold_capped", verb } }
          : {}),
      ...emptyOf(
        items,
        own !== undefined ? "filtered" : "no-data",
        own !== undefined
          ? "This service has started no run here that is still recorded."
          : "No run is recorded here yet. Start one with `crewhaus runs create <harness> --input-file <path>`.",
      ),
    },
    scrubDir: dir,
  };
};

/** How many ledger lines the fold from the end reads before it stops short. */
export const NEWEST_FOLD_LINES = 20_000;

/** The ledger position `a` is older than or at `b`. */
function atOrBefore(a: CursorPosition, b: CursorPosition): boolean {
  return a.seg < b.seg || (a.seg === b.seg && a.off <= b.off);
}

/**
 * The newest row of each listed run: from the harness's run read model, caught up; for an
 * id it does not hold (or with no model), from the ledger read from its end, newest first,
 * down to the oldest listed entry or {@link NEWEST_FOLD_LINES} lines (`capped`).
 */
function newestRowsOf(
  ctx: V1Context,
  hrn: string,
  dir: string,
  entries: ReadonlyArray<{ readonly id: string; readonly at: CursorPosition }>,
): {
  readonly rows: ReadonlyMap<string, LedgerRecord>;
  readonly capped: boolean;
  readonly freshness: "projection" | "direct-fold";
  /** The read model's own catch-up stopped at its caps. */
  readonly stale: boolean;
} {
  const rows = new Map<string, LedgerRecord>();
  const model = caughtUpModel(ctx.deps.hangarRoot, hrn, dir, RUNS_PROJECTION, ctx.deps.now());
  const wanted = new Set<string>();
  for (const { id } of entries) {
    const row = model?.state.rows[id];
    if (row !== undefined) rows.set(id, row);
    else wanted.add(id);
  }
  const freshness = model === undefined ? ("direct-fold" as const) : ("projection" as const);
  const stale = model?.stale ?? false;
  const oldest = entries.at(-1)?.at;
  if (wanted.size === 0 || oldest === undefined) return { rows, capped: false, freshness, stale };
  const ledger = runsLedger(dir);
  let before: CursorPosition | undefined;
  let walked = 0;
  for (;;) {
    const page = readPage(ledger, { limit: 512, ...(before !== undefined ? { before } : {}) });
    for (const item of page.items) {
      if (atOrBefore(item.at, oldest)) return { rows, capped: false, freshness, stale };
      walked += 1;
      const id = item.record["id"];
      if (typeof id === "string" && wanted.has(id) && !rows.has(id)) rows.set(id, item.record);
      if (walked >= NEWEST_FOLD_LINES) return { rows, capped: true, freshness, stale };
    }
    if (page.next === undefined) return { rows, capped: false, freshness, stale };
    before = page.next;
  }
}

const get: V1Handler = async (ctx) => {
  const found = runOf(ctx);
  const newest = found.rows[0] as LedgerRecord;
  return { status: 200, body: servedRun(newest, found.entry.id), scrubDir: found.dir };
};

/** The most sensitive content a run's rows name. */
export function sensitivityOf(rows: readonly LedgerRecord[]): "internal" | "restricted" | "people" {
  if (rows.some((row) => row["peopleProjection"] !== undefined)) return "people";
  if (rows.some((row) => row["restrictedEvidence"] !== undefined)) return "restricted";
  return "internal";
}

/** Where a run opens in Home, absolute: the owner's address, else the request's own origin. */
function inspectionUrlOf(ctx: V1Context, ref: string): string {
  const base = ctx.deps.baseUrl ?? ctx.url.origin;
  return `${base.replace(/\/+$/, "")}/#/i/${ref}`;
}

const result: V1Handler = async (ctx) => {
  const found = runOf(ctx);
  const newest = found.rows[0] as LedgerRecord;
  const state = String(newest["state"]);
  const ref = runRefOf(found.entry.id, found.runId);
  const sensitivity = sensitivityOf(found.rows);
  const base = { run: found.runId, state, sensitivity, inspectionUrl: inspectionUrlOf(ctx, ref) };
  if (!TERMINAL.has(state)) return { status: 200, body: base, scrubDir: found.dir };
  if (sensitivity === "people" && !ctx.access.peopleAllowed({ ref, sensitivity })) {
    return { status: 200, body: { ...base, hidden: ["people"] }, scrubDir: found.dir };
  }
  const session = found.rows
    .map((row) => row["session"])
    .find((value) => typeof value === "string");
  // A cost only when a row carries one: an unpriced run is never `$0`.
  const cost = found.rows
    .map((row) => row["cost"])
    .find((value) => typeof value === "object" && value !== null);
  return {
    status: 200,
    body: {
      ...base,
      ...(typeof session === "string" ? { outputRef: `${found.entry.id}/session/${session}` } : {}),
      ...(cost !== undefined ? { cost } : {}),
    },
    scrubDir: found.dir,
  };
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const create: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const input = String(ctx.body["input"]);
  const subject = typeof ctx.body["subject"] === "string" ? ctx.body["subject"] : undefined;
  const admission = ctx.body["admission"] === "queue" ? "queue" : "reject";
  if (
    subject !== undefined &&
    !ctx.access.authorize("h.subject.assert", { harness: entry.id }).allow
  ) {
    throw new V1Error({
      status: 403,
      code: "forbidden",
      reason: "permission",
      needs: "h.subject.assert",
      message: "Naming who a run serves needs h.subject.assert on this harness.",
    });
  }
  if (ctx.body["work"] !== undefined) {
    throw new V1Error({
      status: 501,
      code: "unsupported",
      reason: "not_served",
      message: "Starting a run for a work item is not served yet.",
    });
  }
  // The harness is the target: a repeat under the same key fingerprints alike.
  const command = { target: `home/harness/${entry.id}`, ledger: { harness: dir } } as const;
  // A retry is answered with the run it started, whatever would be refused now.
  const replay = await replayedCommand(ctx, command);
  if (replay !== undefined) return createdReplay(replay, entry, dir);
  const runId = mintRunId();
  const plan = await runAdapterFor(entry.target).createRun({
    harnessDir: dir,
    harness: entry.id,
    target: entry.target,
    runId,
    input,
    ...(subject !== undefined ? { subject } : {}),
    admission,
    home: await homeFor(ctx, entry),
  });
  if (!plan.ok) throw refusalError(plan.refusal);
  const submitted = await submitCommand(ctx, {
    ...command,
    effect: async (receipt) => plan.effect(receipt),
  });
  if (submitted.replayed) return createdReplay(submitted, entry, dir);
  const value = submitted.value;
  if (value?.run === undefined) {
    throw new V1Error({
      status: 503,
      code: "unavailable",
      reason: "not_started",
      message: `The run was not started: ${value?.problem ?? "it could not be recorded"}.`,
      details: { receipt: submitted.receipt.id },
    });
  }
  return {
    status: 202,
    body: {
      run: servedRun(value.run as LedgerRecord, entry.id),
      receipt: submitted.receipt,
      ...(value.warnings.length > 0 ? { warnings: value.warnings } : {}),
    },
    scrubDir: dir,
  };
};

/** A replayed `runs.create`: 202 with the first run, as it is recorded now. */
function createdReplay(
  submitted: Submitted<unknown>,
  entry: HangarHarnessEntry,
  dir: string,
): ReturnType<typeof acceptedAnswer> {
  const first = runOfReceipt(submitted.receipt);
  const rows = first === undefined ? [] : rowsIn(dir, first);
  // Newest first: the row it was queued with, as the first answer served it.
  const run = rows.at(-1);
  return {
    ...acceptedAnswer(submitted, run !== undefined ? { run: servedRun(run, entry.id) } : {}, dir),
    status: 202,
  };
}

function runCommand(kind: "runs.cancel" | "runs.resume"): V1Handler {
  return async (ctx) => {
    const found = runOf(ctx);
    const dir = liveDirOr409(found.entry);
    const command = {
      target: runRefOf(found.entry.id, found.runId),
      ledger: { harness: dir },
    } as const;
    // A retry is answered with the receipt it repeats: a cancel that succeeded is not
    // refused because the run it cancelled has ended.
    const replay = await replayedCommand(ctx, command);
    if (replay !== undefined) return acceptedAnswer(replay, {}, dir);
    const request = {
      harnessDir: dir,
      harness: found.entry.id,
      target: found.entry.target,
      runId: found.runId,
      home: await homeFor(ctx, found.entry),
    };
    const adapter = runAdapterFor(found.entry.target);
    const plan: RunPlan<unknown> =
      kind === "runs.cancel" ? await adapter.cancelRun(request) : await adapter.resumeRun(request);
    if (!plan.ok) throw refusalError(plan.refusal);
    const submitted = await submitCommand(ctx, {
      ...command,
      effect: async (receipt) => plan.effect(receipt),
    });
    return acceptedAnswer(submitted, {}, dir);
  };
}

export const RUN_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "runs.list": list,
  "runs.get": get,
  "runs.create": create,
  "runs.result": result,
  "runs.cancel": runCommand("runs.cancel"),
  "runs.resume": runCommand("runs.resume"),
};
