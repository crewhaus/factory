/**
 * The inspection area through the API (#518): a run explained from its records, served
 * over `crewhaus.hangar.v1` from `@crewhaus/run-inspect` (module brief 332 in
 * `crewhaus/docs`). Every operation is a read, of one run (`{run}`), one session
 * (`{h}/sessions/{sess}`) or one work item (`work/{ref}`), and every answer says how each
 * field is known and names what is missing.
 *
 * - **One request, one load.** The run is found as `runs.get` finds it; a run the caller
 *   may not see is `not_found`. Its records are read once, through `loadRun`, from the
 *   harness's live folder only, and the fold the operation names answers.
 * - **Content needs its right.** Without `h.read.content`, what was asked, the outcome,
 *   an operator wake's words, every timeline entry's detail and the request's input are
 *   left out, and the answer says so (`hidden: ["content"]` and a `no-access` gap), never
 *   an empty string in their place.
 * - **One masker.** Before an answer leaves, `beforeMask` takes control and format
 *   characters out of every string and replaces a JSON text's credential-named values;
 *   the router's one exit then scrubs the harness's env values and masks by key name and
 *   token shape. Nothing here masks on its own.
 * - **The read model.** `inspect` keeps, per harness, the content-free skeleton of each
 *   run (its session, execution, parent, work item and state); a summary takes a run's
 *   children from it and, when it is caught up, the rows it would read the ledger for. A
 *   read never writes it: the projector's pass does.
 */
import { join } from "node:path";
import {
  CONTEXT_CALL_RE,
  ERROR_CODES,
  type ErrorCode,
  INSPECTION_CAPABILITY_KEYS,
  WHY_ACTION_RE,
} from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import {
  type LedgerRecord,
  controlPaths,
  readPage,
  readRecordFile,
  runsLedger,
} from "@crewhaus/control-records";
import { type Projection, caughtUpModel } from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { readRunLedgerView } from "@crewhaus/harness-supervisor";
import {
  type InspectGap,
  type InspectModel,
  type InspectRefusal,
  type InspectSummary,
  type LoadedRun,
  type RunRow,
  type SessionLine,
  type TimelineEntry,
  type TimelinePage,
  beforeMask,
  childrenFromModel,
  emptyInspectModel,
  foldContext,
  foldInspectModel,
  foldSummary,
  foldTimeline,
  foldWhy,
  loadRun,
  rowsFromModel,
  runLinesOf,
  runsOfWork,
  timelineAll,
} from "@crewhaus/run-inspect";
import { REDACTED_VALUE, isCredentialKey } from "@crewhaus/spec-patch";
import { readHarnessEnvFiles } from "../env-file";
import type { HomeAreaRuntime } from "./areas";
import { readCompiledWith } from "./compiler";
import type { CapabilityProvider, V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import { harnessOf, liveDirOr409 } from "./resolve";
import { type RunFound, runOf } from "./runs";
import { locate as locateWorkItem } from "./work";

/** The most entries an export holds. */
export const EXPORT_MAX_ENTRIES = 20_000;

/** The most bytes of serialized entries an export holds. */
export const EXPORT_MAX_BYTES = 64 * 1024 * 1024;

/** How many raw lines one page shows. */
export const RAW_PAGE_LINES = 200;

/** How many of a work item's runs `inspect.work` shows. */
export const WORK_RUNS_MAX = 50;

/** A request's input is shown up to the API's own body cap. */
const REQUEST_INPUT_MAX_BYTES = 256 * 1024;

/** How many of the ledger's newest rows a work item's runs are looked for in, without a model. */
const WORK_SCAN_ROWS = 20_000;

/** The inspector's read model, as Home's projector keeps it: one file per harness. */
export const INSPECT_PROJECTION: Projection<InspectModel> = {
  name: "inspect",
  empty: emptyInspectModel,
  fold: foldInspectModel,
  sources: (dir) => ({ runs: runsLedger(dir) }),
};

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** A load's refusal as the API's error, with its code's own status. */
function refusalError(refusal: InspectRefusal): V1Error {
  const status = (ERROR_CODES as Readonly<Record<string, { statuses: readonly number[] }>>)[
    refusal.code
  ]?.statuses[0];
  return new V1Error({
    status: status ?? 500,
    code: refusal.code as ErrorCode,
    reason: refusal.code === "unsupported" ? "inspect_unsupported" : `inspect_${refusal.code}`,
    message: refusal.message,
    ...(refusal.verb !== undefined ? { verb: refusal.verb } : {}),
  });
}

/** An answer as it leaves: made ready for the router's one masker, with the harness to scrub. */
function answer(dir: string, view: unknown, headers?: Readonly<Record<string, string>>) {
  return {
    status: 200,
    body: beforeMask(view, { isSecretName: isCredentialKey, redacted: REDACTED_VALUE }),
    scrubDir: dir,
    ...(headers !== undefined ? { headers } : {}),
  };
}

/** The harness's caught-up read model, or `undefined` when there is none or it is behind. */
function freshModel(ctx: V1Context, entry: HangarHarnessEntry, dir: string) {
  try {
    const model = caughtUpModel(
      ctx.deps.hangarRoot,
      entry.id,
      dir,
      INSPECT_PROJECTION,
      ctx.deps.now(),
    );
    return model === undefined || model.stale ? undefined : model.state;
  } catch {
    return undefined;
  }
}

/** Load a run's records once, or answer the load's refusal. */
function load(
  dir: string,
  ref: string,
  ctx: V1Context,
  byRun?: ReadonlyMap<string, readonly RunRow[]>,
): LoadedRun {
  const loaded = loadRun({
    harnessDir: dir,
    ref,
    envVars: readHarnessEnvFiles(dir).vars,
    now: ctx.deps.now(),
    ...(byRun !== undefined ? { byRun } : {}),
  });
  if (!loaded.ok) throw refusalError(loaded);
  return loaded;
}

/** The run `{run}` names, its live folder, and whether the caller may read its content. */
function located(ctx: V1Context): {
  readonly found: RunFound & { readonly runId: string };
  readonly dir: string;
  readonly content: boolean;
} {
  const found = runOf(ctx);
  const dir = liveDirOr409(found.entry);
  return { found, dir, content: ctx.access.canReadContent(found.entry.id) };
}

const NO_ACCESS: InspectGap = { reason: "no-access" };

/** A summary without its content fields, saying they were left out. */
function summaryShown(summary: InspectSummary, content: boolean): Record<string, unknown> {
  if (content) return summary;
  const { asked: _asked, outcome: _outcome, wake: _wake, ...rest } = summary;
  return { ...rest, hidden: ["content"], gaps: [...summary.gaps, NO_ACCESS] };
}

/** A timeline page without its entries' details, saying they were left out. */
function pageShown(page: TimelinePage, content: boolean): Record<string, unknown> {
  if (content) return page;
  return {
    ...page,
    entries: page.entries.map(({ detail: _detail, ...entry }) => entry),
    hidden: ["content"],
    gaps: [...page.gaps, NO_ACCESS],
  };
}

function invalidQuery(field: string, message: string): V1Error {
  return new V1Error({
    status: 400,
    code: "invalid",
    reason: "query_invalid",
    message,
    details: { field },
  });
}

/** The query parsed by the operation's own schema; a bad value is 400 naming its field. */
function parsedQuery(ctx: V1Context): Record<string, unknown> {
  const schema = (SCHEMAS as Readonly<Record<string, { safeParse(v: unknown): unknown }>>)[
    ctx.op.request
  ];
  // `harness` names where a `{run}` is, for the router; the schema takes the rest.
  const { harness: _harness, ...query } = ctx.query;
  const checked = schema?.safeParse(query) as
    | { success: true; data: Record<string, unknown> }
    | { success: false; error: { issues?: ReadonlyArray<{ path?: readonly unknown[] }> } }
    | undefined;
  if (checked === undefined) return {};
  if (checked.success) return checked.data;
  const field = String(checked.error.issues?.[0]?.path?.[0] ?? "query");
  throw invalidQuery(field, `The query's ${field} is not one this operation takes.`);
}

// ---------------------------------------------------------------------------
// Reads of one run
// ---------------------------------------------------------------------------

const summary: V1Handler = async (ctx) => {
  const { found, dir, content } = located(ctx);
  const model = freshModel(ctx, found.entry, dir);
  const byRun = model !== undefined ? rowsFromModel(model, found.runId) : undefined;
  const view = foldSummary(load(dir, found.runId, ctx, byRun));
  // The runs it started that only their own rows name.
  const listed = new Set(view.children.map((child) => child.run));
  const extra =
    model === undefined
      ? []
      : childrenFromModel(model, found.runId)
          .filter((run) => !listed.has(run))
          .map((run) => {
            const session = model.runs[run]?.session;
            return { run, ...(session !== undefined ? { session } : {}), via: "row" as const };
          });
  const withChildren: InspectSummary = { ...view, children: [...view.children, ...extra] };
  return answer(dir, summaryShown(withChildren, content));
};

const timeline: V1Handler = async (ctx) => {
  const { found, dir, content } = located(ctx);
  const query = parsedQuery(ctx);
  if (query["before"] !== undefined && query["after"] !== undefined) {
    throw invalidQuery("after", "Page the timeline before an entry or after one, not both.");
  }
  const page = foldTimeline(load(dir, found.runId, ctx), {
    view: (query["view"] as "key" | "full" | undefined) ?? "key",
    ...(typeof query["limit"] === "number" ? { limit: query["limit"] } : {}),
    ...(typeof query["before"] === "string" ? { before: query["before"] } : {}),
    ...(typeof query["after"] === "string" ? { after: query["after"] } : {}),
  });
  if ("ok" in page) throw refusalError(page);
  return answer(dir, pageShown(page, content));
};

const why: V1Handler = async (ctx) => {
  const { found, dir } = located(ctx);
  const action = String(ctx.params["action"]);
  if (!WHY_ACTION_RE.test(action)) throw invalidQuery("action", "That names no step of a run.");
  const record = foldWhy(load(dir, found.runId, ctx), action);
  if ("ok" in record) throw refusalError(record);
  return answer(dir, record);
};

const context: V1Handler = async (ctx) => {
  const { found, dir } = located(ctx);
  const raw = String(ctx.params["call"]);
  if (!CONTEXT_CALL_RE.test(raw)) throw invalidQuery("call", "That names no model call.");
  const call = raw === "all" ? "all" : Number(raw);
  const view = foldContext(load(dir, found.runId, ctx), call);
  if ("ok" in view) throw refusalError(view);
  // One shape for both: the calls named, and what is missing.
  const body = "calls" in view ? view : { calls: [view], gaps: [] };
  return answer(dir, body);
};

/** A receipt as the request view shows it: what it was, who asked, and how it ended. */
function receiptView(found: RunFound, ctx: V1Context, cmd: string) {
  const receipt = ctx.deps.control.commands.get({ harness: found.dir }, cmd);
  if (receipt === undefined) return undefined;
  return {
    id: receipt.id,
    operation: receipt.kind,
    actor: receipt.actor,
    via: receipt.via,
    state: receipt.state,
    acceptedAt: receipt.acceptedAt,
    retried: receipt.retry,
    ...(receipt.outcome !== undefined ? { outcome: receipt.outcome } : {}),
  };
}

/** The run's input file's input, while the file is there: a view, read whole up to the cap. */
function inputFileText(dir: string, run: string): string | undefined {
  const inputs = controlPaths(dir).inputsDir;
  for (const [name, json] of [
    [`${run}.json`, true],
    [`${run}.txt`, false],
  ] as const) {
    const read = readRecordFile(dir, join(inputs, name), REQUEST_INPUT_MAX_BYTES);
    if (!read.ok) continue;
    if (!json) return read.text;
    try {
      const input = (JSON.parse(read.text) as { readonly input?: unknown } | null)?.input;
      if (typeof input === "string") return input;
    } catch {
      // A damaged input file shows nothing from it.
    }
  }
  return undefined;
}

const request: V1Handler = async (ctx) => {
  const { found, dir, content } = located(ctx);
  // The row it entered with: a queued row names the receipt that queued it.
  const queued = found.rows.find((row) => row["state"] === "queued");
  const cmd = queued?.["cmd"];
  if (typeof cmd !== "string") {
    return answer(dir, {
      present: false,
      note: "This run was not started through the API, so there is no request to show.",
      verb: null,
    });
  }
  const receipt = receiptView(found, ctx, cmd);
  let input: { source: "input-file" | "reconstructed"; text: string } | null = null;
  if (content) {
    const file = inputFileText(dir, found.runId);
    if (file !== undefined) input = { source: "input-file", text: file };
    else {
      // A run whose transcript cannot be read shows no input, never a refusal.
      const loaded = loadRun({
        harnessDir: dir,
        ref: found.runId,
        envVars: readHarnessEnvFiles(dir).vars,
        now: ctx.deps.now(),
      });
      const asked = loaded.ok ? foldSummary(loaded).asked.value : undefined;
      if (asked !== undefined) input = { source: "reconstructed", text: asked };
    }
  }
  return answer(dir, {
    present: true,
    note:
      input === null && content
        ? "The run's input file is gone and its transcript holds no message to show."
        : input?.source === "reconstructed"
          ? "The run's input file is gone: this is the first message its transcript records."
          : "The request that started this run.",
    verb: `crewhaus commands show ${cmd}`,
    ...(receipt !== undefined ? { receipt } : {}),
    ...(content ? { input } : { hidden: ["content"], gaps: [NO_ACCESS] }),
  });
};

const exportRun: V1Handler = async (ctx) => {
  const { found, dir } = located(ctx);
  const loaded = load(dir, found.runId, ctx);
  const view = foldSummary(loaded);
  // The whole timeline, built once and cut here.
  const all = timelineAll(loaded, "full");
  const entries: TimelineEntry[] = [];
  let bytes = 0;
  let truncated = all.truncated;
  for (const entry of all.entries) {
    bytes += JSON.stringify(entry).length;
    if (entries.length >= EXPORT_MAX_ENTRIES || bytes > EXPORT_MAX_BYTES) {
      truncated = true;
      break;
    }
    entries.push(entry);
  }
  return answer(
    dir,
    {
      v: 1,
      run: found.runId,
      summary: view,
      timeline: entries,
      why: null,
      gaps: view.gaps,
      truncated,
    },
    {
      "content-disposition": `attachment; filename="${found.runId}.json"`,
      "x-content-type-options": "nosniff",
    },
  );
};

/** The model's thinking blocks inside a raw line: where each is, and what kind. */
function thinkingIn(line: SessionLine) {
  if (line.kind !== "assistant_message") return [];
  const payload = line.payload as { readonly content?: unknown } | null;
  const blocks = payload?.content;
  if (!Array.isArray(blocks)) return [];
  const out: Array<{ id: string; path: (string | number)[]; label: string }> = [];
  blocks.forEach((block, i) => {
    const type = (block as { readonly type?: unknown } | null)?.type;
    if (type === "thinking" || type === "redacted_thinking") {
      out.push({
        id: line.id,
        path: ["payload", "content", i],
        label: type === "thinking" ? "thinking" : "redacted-thinking",
      });
    }
  });
  return out;
}

/** A session line as recorded. */
function rawLine(line: SessionLine): Record<string, unknown> {
  return {
    ts: line.ts,
    kind: line.kind,
    payload: line.payload,
    ...(line.run !== undefined ? { run: line.run } : {}),
    ...(line.span !== undefined ? { span: line.span } : {}),
  };
}

const raw: V1Handler = async (ctx) => {
  const { found, dir } = located(ctx);
  const query = parsedQuery(ctx);
  const loaded = load(dir, found.runId, ctx);
  const lines = [...runLinesOf(loaded)].reverse();
  let start = 0;
  const before = query["before"];
  if (typeof before === "string") {
    const at = lines.findIndex((line) => line.id === before);
    if (at === -1) throw invalidQuery("before", "That names no line of this run.");
    start = at + 1;
  }
  const page = lines.slice(start, start + RAW_PAGE_LINES);
  const last = page.at(-1);
  return answer(dir, {
    entries: page.map((line) => ({ id: line.id, line: rawLine(line) })),
    annotations: page.flatMap(thinkingIn),
    ...(lines.length > start + RAW_PAGE_LINES && last !== undefined ? { next: last.id } : {}),
    truncated: loaded.gaps.some((gap) => gap.reason === "truncated"),
    gaps: loaded.gaps,
  });
};

// ---------------------------------------------------------------------------
// A session, and a work item
// ---------------------------------------------------------------------------

const session: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const content = ctx.access.canReadContent(entry.id);
  const loaded = load(dir, String(ctx.params["sess"]), ctx);
  return answer(dir, {
    summary: summaryShown(foldSummary(loaded), content),
    sessionRuns: loaded.sessionRuns,
  });
};

/** A run of a work item as the list shows it: its read model skeleton. */
type WorkRun = Readonly<Record<string, unknown>> & { readonly run: string };

/** A work item's runs from the ledger's newest rows, when no read model is caught up. */
function workRunsScanned(dir: string, wi: string): { runs: WorkRun[]; truncated: boolean } {
  const ledger = runsLedger(dir);
  const newestFirst: LedgerRecord[] = [];
  let before: Parameters<typeof readPage>[1]["before"];
  let truncated = false;
  for (;;) {
    const page = readPage(ledger, { limit: 1000, ...(before !== undefined ? { before } : {}) });
    newestFirst.push(...page.items.map((item) => item.record));
    if (page.next === undefined) break;
    if (newestFirst.length >= WORK_SCAN_ROWS) {
      truncated = true;
      break;
    }
    before = page.next;
  }
  const model = newestFirst
    .reverse()
    .map((record, i) => ({
      kind: "line" as const,
      source: "runs" as const,
      seg: 0,
      off: i,
      record,
      after: { seg: 0, off: i + 1, tail: "" },
    }))
    .reduce(foldInspectModel, emptyInspectModel());
  return { runs: workRunsOf(model, wi), truncated };
}

function workRunsOf(model: InspectModel, wi: string): WorkRun[] {
  return runsOfWork(model, wi, WORK_RUNS_MAX).map((run) => ({ run, ...model.runs[run] }));
}

const work: V1Handler = async (ctx) => {
  const found = locateWorkItem(ctx);
  const model = freshModel(ctx, found.entry, found.dir);
  const read =
    model !== undefined
      ? { runs: workRunsOf(model, found.wi), truncated: false }
      : workRunsScanned(found.dir, found.wi);
  return answer(found.dir, {
    runs: read.runs,
    ...(read.truncated ? { truncated: true } : {}),
    ...(read.runs.length === 0
      ? {
          empty: {
            reason: "no-data",
            note: "No run has served this work item yet.",
            verb: `crewhaus work show ${found.wi}`,
          },
        }
      : {}),
  });
};

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Whether a `major.minor…` version is at least 0.9; `undefined` when it cannot be read. */
function atLeast09(version: string | undefined): boolean | undefined {
  const match = version === undefined ? null : /^(\d+)\.(\d+)/.exec(version);
  if (match === null) return undefined;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 0 || minor >= 9;
}

const RECORDS: CapabilityProvider = {
  key: "inspect.records",
  answer: async (entry) => {
    // A cli harness runs through the interpreter, which records them.
    if (entry.target === "cli") return { supported: true };
    const built = atLeast09(readCompiledWith(entry));
    if (built === undefined) {
      return {
        supported: "unknown",
        reason:
          "This harness has no build to read, so whether its runs keep inspection records is unknown.",
      };
    }
    return built
      ? { supported: true }
      : {
          supported: false,
          reason: "This build is older than inspection records. Compile it again to keep them.",
          verb: "crewhaus compile",
        };
  },
};

const TRACE: CapabilityProvider = {
  key: "inspect.trace",
  answer: async (entry) => {
    let supervised = false;
    try {
      supervised = entry.missingSince === null && readRunLedgerView(entry.dir).entries.length > 0;
    } catch {
      supervised = false;
    }
    return supervised
      ? { supported: true }
      : {
          supported: false,
          reason:
            "Detailed traces are captured for runs Home supervises. Start this harness's daemon with `crewhaus daemon start`.",
          verb: "crewhaus daemon start",
        };
  },
};

// The two keys this area declares, in its module's order.
const PROVIDERS: readonly CapabilityProvider[] = INSPECTION_CAPABILITY_KEYS.map((key) =>
  key === "inspect.records" ? RECORDS : TRACE,
);

export const INSPECTION_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "inspect.summary": summary,
  "inspect.timeline": timeline,
  "inspect.why": why,
  "inspect.context": context,
  "inspect.request": request,
  "inspect.export": exportRun,
  "inspect.raw": raw,
  "inspect.session": session,
  "inspect.work": work,
};

/** The inspection area's Home entry. */
export const HOME_INSPECTION: HomeAreaRuntime = {
  area: "inspection",
  handlers: INSPECTION_HANDLERS,
  capabilityProviders: PROVIDERS,
  projections: [INSPECT_PROJECTION as Projection<unknown>],
};
