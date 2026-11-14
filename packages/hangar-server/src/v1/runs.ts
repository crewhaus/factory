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
import {
  type CommandReceipt,
  type CursorPosition,
  ERROR_CODES,
  type ErrorCode,
  mintRunId,
  parseRef,
} from "@crewhaus/control-contract";
import { type LedgerRecord, readPage, runsLedger } from "@crewhaus/control-records";
import {
  type RunHome,
  type RunPlan,
  type RunRefusal,
  runAdapterFor,
  runRefOf,
} from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import type { V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { emptyOf, nextCursor, pagingOf, snapshotCursor } from "./lists";
import { entryOf, harnessOf, liveDirOf, liveDirOr409 } from "./resolve";
import { acceptedAnswer, submitCommand } from "./submit";

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
  const found: RunFound[] = [];
  for (const entry of deps.registry.list()) {
    if (entry.archived !== undefined) continue;
    const here = at(entry);
    if (here !== undefined) found.push(here);
    if (found.length > 1) return undefined;
  }
  return found[0];
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

/** The run the request's `{run}` names, or 404. */
function runOf(ctx: V1Context): RunFound & { readonly runId: string } {
  const runId = String(ctx.params["run"]);
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
  // Newest first, each run once, at the line it entered with, served as its newest row.
  const newest = new Map<string, LedgerRecord>();
  const items: Record<string, unknown>[] = [];
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
      if (!newest.has(id)) newest.set(id, item.record);
      const state = String(item.record["state"]);
      if (seen.has(id) || (state !== "queued" && state !== "running")) continue;
      if (own !== undefined && item.record["by"] !== own) continue;
      seen.add(id);
      items.push(servedRun(newest.get(id) ?? item.record, entry.id));
      if (items.length === paging.limit) {
        next = item.at;
        break outer;
      }
    }
    if (page.next === undefined) break;
    before = page.next;
  }
  return {
    status: 200,
    body: {
      items,
      ...(next !== undefined ? { next: nextCursor("runs", next) } : {}),
      snapshotAt: snapshotCursor("runs", snapshotAt ?? []),
      ...(gaps > 0
        ? {
            truncated: {
              reason: "unreadable_lines",
              verb: `crewhaus runs list --harness ${entry.id}`,
            },
          }
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
  // The harness is the target: a repeat under the same key fingerprints alike.
  const submitted = await submitCommand(ctx, {
    target: `home/harness/${entry.id}`,
    ledger: { harness: dir },
    effect: async (receipt) => plan.effect(receipt),
  });
  if (submitted.replayed) {
    const first = runOfReceipt(submitted.receipt);
    const rows = first === undefined ? [] : rowsIn(dir, first);
    const run = rows.at(-1);
    return {
      ...acceptedAnswer(submitted, run !== undefined ? { run: servedRun(run, entry.id) } : {}, dir),
      status: 202,
    };
  }
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

function runCommand(kind: "runs.cancel" | "runs.resume"): V1Handler {
  return async (ctx) => {
    const found = runOf(ctx);
    const dir = liveDirOr409(found.entry);
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
      target: runRefOf(found.entry.id, found.runId),
      ledger: { harness: dir },
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
