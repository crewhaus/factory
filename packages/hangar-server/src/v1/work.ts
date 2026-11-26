/**
 * Work items through the API (#516, #514, #513, module brief 333): the runtime area's Home
 * entry. The reads (`work.list`, `work.feed`, `work.get`) fold the harness's work log and
 * write nothing; every change is a receipted command whose effect is control-service's
 * work command, the same one the CLI runs.
 *
 * - A caller without `h.read.content` sees items' titles, states and refs, never their
 *   goals, criteria, assessments, notes or the feed's goals and tasks.
 * - Accepting, declining and correcting the ranking are a person's acts: a service
 *   credential is refused before a receipt (`human_only`).
 * - The feed reads the harness's Thredz tasks with one call, through the port Home lends;
 *   a harness that declares no `thredz:` says so, and a failure shows nothing.
 *
 * The runtime area's contract module, its control-service runtime and this entry each
 * compose a work half from its own file, so a later half lands beside it as one line.
 */
import {
  type CursorPosition,
  ERROR_CODES,
  EVENT_TAXONOMY,
  type ErrorCode,
  type EventType,
  MACHINES,
  type WorkCreateRequest,
  type WorkDeclineRequest,
  type WorkRankRequest,
  type WorkUpdateRequest,
  canTransition,
  isId,
  mintRunId,
  parseRef,
} from "@crewhaus/control-contract";
import { readPage } from "@crewhaus/control-records";
import {
  type Projection,
  type WorkCaller,
  type WorkCommandRefusal,
  type WorkCommandValue,
  type WorkCommands,
  type WorkHead,
  type WorkPlan,
  commandsLedgerOf,
  isServiceActor,
  workCommands,
  workRefOf,
} from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { openForReadSync } from "@crewhaus/tool-safety/fs";
import {
  type AdoptRead,
  type ThredzTasksPort,
  type WorkJob,
  type WorkSpecFacts,
  itemDetail,
  itemViews,
  openWorkStore,
  viewContext,
  workFeed,
  workLedger,
  workSpecFacts,
} from "@crewhaus/tool-work/work-items";
import { declaredCadences } from "../schedulers";
import { readYamlLoose } from "../yaml-scan";
import type { HomeAreaRuntime } from "./areas";
import { BUDGET_HOME } from "./budget";
import type { CapabilityProvider, RefResolver, V1Context, V1Handler } from "./context";
import { V1Error } from "./errors";
import type { EnvelopeFields, StreamSourceDecl } from "./event-map";
import { emptyOf, nextCursor, pagingOf, snapshotCursor } from "./lists";
import { entryOf, harnessOf, liveDirOf, liveDirOr409, visibleHarnesses } from "./resolve";
import { homeFor } from "./runs";
import { acceptedAnswer, replayedCommand, submitCommand } from "./submit";
import {
  type SpecRead,
  callerOf,
  headOf,
  humanOnly,
  locate,
  missingItem,
  refusalError,
  workSpecOf,
} from "./work-shared";
import { WORKSPACES_HOME } from "./workspaces";

export { workSpecOf };

/** One item as a list shows it, ranked among the rest. */
function viewOfItem(dir: string, wi: string, weights: SpecRead["config"]) {
  const store = openWorkStore(dir);
  const fold = store.fold();
  if (!fold.ok) return undefined;
  const item = fold.items.get(wi);
  if (item === undefined) return undefined;
  const siblings = [...fold.items.values()].filter((other) => other.state === item.state);
  const views = itemViews(store, siblings, viewContext(dir, fold, weights?.ranking?.weights));
  return views.find((view) => view.id === wi);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const list: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOf(entry);
  const paging = pagingOf(ctx.query, "work");
  if (dir === undefined) {
    return {
      status: 200,
      body: {
        items: [],
        snapshotAt: snapshotCursor("work", []),
        empty: { reason: "unreachable", remedy: "The harness folder is missing." },
      },
    };
  }
  // Newest first, each item once, at the line it opened with; its state from the whole log.
  const ledger = workLedger(dir);
  const opened: Array<{ readonly id: string; readonly at: CursorPosition }> = [];
  let snapshotAt: readonly CursorPosition[] | undefined;
  let gaps = 0;
  let before = paging.before;
  let next: CursorPosition | undefined;
  outer: for (;;) {
    const page = readPage(ledger, {
      limit: Math.max(paging.limit, 64),
      ...(before !== undefined ? { before } : {}),
    });
    snapshotAt ??= page.snapshotAt;
    gaps += page.gaps.length;
    for (const item of page.items) {
      const id = item.record["id"];
      if (typeof id !== "string" || item.record["event"] !== "opened") continue;
      if (opened.some((o) => o.id === id)) continue;
      opened.push({ id, at: item.at });
      if (opened.length === paging.limit) {
        next = item.at;
        break outer;
      }
    }
    if (page.next === undefined) break;
    before = page.next;
  }
  const store = openWorkStore(dir);
  const fold = store.fold();
  const spec = workSpecOf(dir);
  const items =
    fold.ok && opened.length > 0
      ? (() => {
          const all = itemViews(
            store,
            [...fold.items.values()],
            viewContext(dir, fold, spec.config?.ranking?.weights),
          );
          const byId = new Map(all.map((view) => [view.id, view]));
          return opened.flatMap((o) => {
            const view = byId.get(o.id);
            return view === undefined ? [] : [view];
          });
        })()
      : [];
  const verb = `crewhaus work list --harness ${entry.id}`;
  return {
    status: 200,
    body: {
      items,
      ...(next !== undefined ? { next: nextCursor("work", next) } : {}),
      snapshotAt: snapshotCursor("work", snapshotAt ?? []),
      ...(gaps > 0 || !fold.ok ? { truncated: { reason: "unreadable_lines", verb } } : {}),
      ...emptyOf(
        items,
        spec.tools || items.length > 0 ? "no-data" : "unsupported",
        spec.tools
          ? "Nothing to do yet. Add work, or let the harness propose some."
          : "This harness doesn't keep a work list. Turn on the Work tools in Setup.",
      ),
    },
    scrubDir: dir,
  };
};

/** The harness's job receipts that are queued or running, newest first, from its commands ledger. */
function jobsOf(dir: string): readonly WorkJob[] {
  const ledger = commandsLedgerOf(dir);
  const newest = new Map<string, Readonly<Record<string, unknown>>>();
  let before: CursorPosition | undefined;
  let read = 0;
  for (;;) {
    const page = readPage(ledger, { limit: 500, ...(before !== undefined ? { before } : {}) });
    for (const item of page.items) {
      const id = item.record["id"];
      if (typeof id === "string" && !newest.has(id)) newest.set(id, item.record);
    }
    read += page.items.length;
    if (page.next === undefined || read >= 5000) break;
    before = page.next;
  }
  const out: WorkJob[] = [];
  for (const [id, row] of newest) {
    const state = String(row["state"]);
    const effects = Array.isArray(row["effects"]) ? (row["effects"] as unknown[]) : [];
    const job = effects.some(
      (e) => typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "job",
    );
    if (!job || (state !== "accepted" && state !== "running")) continue;
    out.push({ id, kind: String(row["kind"]), state });
  }
  return out;
}

function thredzPortOf(ctx: V1Context, entry: HangarHarnessEntry): ThredzTasksPort | undefined {
  const read = ctx.deps.thredzTasks;
  if (read === undefined) return undefined;
  return async () => {
    const answer = await read(entry);
    if (answer.state !== "ok") return answer;
    return {
      state: "ok",
      tasks: answer.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        ...(task.status !== undefined ? { status: task.status } : {}),
      })),
    };
  };
}

const feed: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const spec = workSpecOf(dir);
  const thredz = thredzPortOf(ctx, entry);
  const body = await workFeed(dir, {
    now: ctx.deps.now,
    specName: entry.specName,
    tools: spec.tools,
    schedules: spec.schedules,
    content: ctx.access.canReadContent(entry.id),
    ...(spec.config?.ranking !== undefined ? { weights: spec.config.ranking.weights } : {}),
    ...(thredz !== undefined ? { thredz } : {}),
    jobs: () => jobsOf(dir),
  });
  return { status: 200, body, scrubDir: dir };
};

const get: V1Handler = async (ctx) => {
  const found = locate(ctx);
  const store = openWorkStore(found.dir);
  const fold = store.fold();
  if (!fold.ok) {
    throw new V1Error({
      status: 503,
      code: "unavailable",
      reason: fold.reason,
      message: fold.message,
    });
  }
  const item = fold.items.get(found.wi);
  if (item === undefined) throw missingItem();
  const spec = workSpecOf(found.dir);
  const body = itemDetail(
    store,
    item,
    fold,
    viewContext(found.dir, fold, spec.config?.ranking?.weights),
    { content: ctx.access.canReadContent(found.entry.id) },
  );
  return { status: 200, body, scrubDir: found.dir };
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Read one Thredz task from the workspace's task list, at origin `mcp`. */
function thredzTaskSource(
  read: (() => ReturnType<NonNullable<V1Context["deps"]["thredzTasks"]>>) | undefined,
  id: string,
): AdoptRead {
  return async () => {
    if (read === undefined) {
      return {
        ok: false,
        code: "unavailable",
        reason: "thredz_unreachable",
        message: "Couldn't reach Thredz from this Home.",
      };
    }
    const answer = await read();
    if (answer.state === "unsupported") {
      return {
        ok: false,
        code: "unsupported",
        reason: "thredz_absent",
        message: answer.remedy ?? "This harness declares no Thredz workspace.",
      };
    }
    if (answer.state === "unreachable") {
      return {
        ok: false,
        code: "unavailable",
        reason: "thredz_unreachable",
        message: answer.remedy,
      };
    }
    const task = answer.tasks.find((t) => t.id === id);
    if (task === undefined) {
      return {
        ok: false,
        code: "not_found",
        reason: "task_unknown",
        message: "That task is not among the workspace's open tasks.",
      };
    }
    return {
      title: task.title,
      ...(task.description !== undefined ? { goal: task.description } : {}),
      kind: "request",
      origin: "mcp",
    };
  };
}

/** The work commands for one request: an adoption reads Thredz through this harness's port. */
function commandsFor(ctx: V1Context, entry: HangarHarnessEntry): WorkCommands {
  const deps = ctx.deps.thredzTasks;
  const read = deps === undefined ? undefined : () => deps(entry);
  return workCommands({ thredzTask: (_head, id) => thredzTaskSource(read, id) });
}

type CommandSpec = {
  readonly entry: HangarHarnessEntry;
  readonly dir: string;
  readonly target: string;
  readonly wi?: string;
};

/** Plan, submit and answer one work command, replays first. */
async function receipted(
  ctx: V1Context,
  spec: CommandSpec,
  plan: (work: WorkCommands, head: WorkHead) => WorkPlan | Promise<WorkPlan>,
) {
  const command = { target: spec.target, ledger: { harness: spec.dir } } as const;
  const replay = await replayedCommand(ctx, command);
  if (replay !== undefined) return acceptedAnswer(replay, {}, spec.dir);
  const planned = await plan(commandsFor(ctx, spec.entry), headOf(ctx, spec.entry, spec.dir));
  if (!planned.ok) throw refusalError(planned.refusal);
  const effect = planned.effect;
  const submitted = await submitCommand<WorkCommandValue>(ctx, {
    ...command,
    effect: async (receipt) => effect(receipt),
  });
  const value = submitted.value;
  const wi = value?.item?.id ?? spec.wi;
  const item = wi === undefined ? undefined : viewOfItem(spec.dir, wi, workSpecOf(spec.dir).config);
  return acceptedAnswer(
    submitted,
    {
      ...(item !== undefined ? { item } : {}),
      ...(value?.run !== undefined ? { run: value.run } : {}),
      ...(value !== undefined && value.warnings.length > 0 ? { warnings: value.warnings } : {}),
      ...(value?.problem !== undefined ? { problem: value.problem } : {}),
    },
    spec.dir,
  );
}

function onHarness(ctx: V1Context): CommandSpec {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  return { entry, dir, target: `home/harness/${entry.id}` };
}

function onItem(ctx: V1Context): CommandSpec {
  const found = locate(ctx);
  liveDirOr409(found.entry);
  return {
    entry: found.entry,
    dir: found.dir,
    target: workRefOf(found.entry.id, found.wi),
    wi: found.wi,
  };
}

const create: V1Handler = async (ctx) => {
  const spec = onHarness(ctx);
  return receipted(ctx, spec, (w, head) =>
    w.create(head, callerOf(ctx), ctx.body as unknown as WorkCreateRequest),
  );
};

const update: V1Handler = async (ctx) => {
  const spec = onItem(ctx);
  return receipted(ctx, spec, (w, head) =>
    w.update(head, callerOf(ctx), spec.wi as string, ctx.body as unknown as WorkUpdateRequest),
  );
};

const accept: V1Handler = async (ctx) => {
  humanOnly(ctx, "Accepting work");
  const spec = onItem(ctx);
  return receipted(ctx, spec, (w, head) => w.accept(head, callerOf(ctx), spec.wi as string));
};

const decline: V1Handler = async (ctx) => {
  humanOnly(ctx, "Declining work");
  const spec = onItem(ctx);
  return receipted(ctx, spec, (w, head) =>
    w.decline(head, callerOf(ctx), spec.wi as string, ctx.body as unknown as WorkDeclineRequest),
  );
};

const reopen: V1Handler = async (ctx) => {
  humanOnly(ctx, "Reopening work");
  const spec = onItem(ctx);
  return receipted(ctx, spec, (w, head) => w.reopen(head, callerOf(ctx), spec.wi as string));
};

const cancel: V1Handler = async (ctx) => {
  const spec = onItem(ctx);
  const home = await homeFor(ctx, spec.entry);
  return receipted(ctx, spec, (w, head) => w.cancel(head, callerOf(ctx), spec.wi as string, home));
};

const rank: V1Handler = async (ctx) => {
  humanOnly(ctx, "Correcting the ranking");
  const spec = onItem(ctx);
  return receipted(ctx, spec, (w, head) =>
    w.rank(head, callerOf(ctx), spec.wi as string, ctx.body as unknown as WorkRankRequest),
  );
};

const start: V1Handler = async (ctx) => {
  const spec = onItem(ctx);
  const home = await homeFor(ctx, spec.entry);
  return receipted(ctx, spec, (w, head) =>
    w.start(head, callerOf(ctx), spec.wi as string, home, mintRunId()),
  );
};

const adopt: V1Handler = async (ctx) => {
  const spec = onHarness(ctx);
  return receipted(ctx, spec, (w, head) =>
    w.adopt(head, callerOf(ctx), String(ctx.body["source"])),
  );
};

export const WORK_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "work.list": list,
  "work.feed": feed,
  "work.get": get,
  "work.create": create,
  "work.update": update,
  "work.accept": accept,
  "work.decline": decline,
  "work.reopen": reopen,
  "work.cancel": cancel,
  "work.rank": rank,
  "work.start": start,
  "work.adopt": adopt,
};

// ---------------------------------------------------------------------------
// Refs, capabilities, the read model and the stream
// ---------------------------------------------------------------------------

const resolveWork: RefResolver = async (ctx, ref) => {
  const entry = entryOf(ctx.deps, ref.scope);
  const dir = entry === undefined ? undefined : liveDirOf(entry);
  if (entry === undefined || dir === undefined || !isId("wi", ref.id)) {
    throw new V1Error({
      status: 404,
      code: "not_found",
      reason: "ref_unknown",
      message: "This Home has no work item by that ref.",
    });
  }
  const read = openWorkStore(dir).get(ref.id);
  if ("ok" in read) {
    throw new V1Error({
      status: 404,
      code: "not_found",
      reason: "ref_unknown",
      message: "This Home has no work item by that ref.",
    });
  }
  const href = `/#/h/${entry.id}/work/items/${ref.id}`;
  const base = ctx.deps.baseUrl;
  return {
    status: 200,
    body: {
      kind: "work",
      href,
      ...(base !== undefined ? { url: `${base.replace(/\/+$/, "")}${href}` } : {}),
      rev: String(read.item.rev),
      summary: `A ${read.item.state} work item`,
    },
    scrubDir: dir,
  };
};

/** `work.items`: whether this harness keeps a work list, by whether its spec lists a Work tool. */
export const WORK_ITEMS_CAPABILITY: CapabilityProvider = {
  key: "work.items",
  async answer(entry) {
    const dir = liveDirOf(entry);
    if (dir === undefined)
      return { supported: "unknown", reason: "The harness folder is missing." };
    const spec = workSpecOf(dir);
    if (!spec.read) {
      return { supported: "unknown", reason: "The harness's spec could not be read." };
    }
    return spec.tools
      ? { supported: true }
      : {
          supported: false,
          reason: "This harness doesn't keep a work list. Turn on the Work tools in Setup.",
          verb: null,
        };
  },
};

/** At most this many items are kept by the read model; past it the oldest-seen go first. */
export const WORK_MODEL_MAX = 5000;

export type WorkModelState = {
  /** Items by state. */
  counts: { proposed: number; open: number; closed: number };
  /** Log lines the machine refused. */
  anomalies: number;
  /** Each item's state, by id, oldest-seen first. */
  states: Record<string, string>;
  /** Some items were dropped past {@link WORK_MODEL_MAX}: counts are of the rest. */
  truncated?: true;
};

const STATES = ["proposed", "open", "closed"] as const;
type CountedState = (typeof STATES)[number];

function counted(state: string): state is CountedState {
  return (STATES as readonly string[]).includes(state);
}

/** `work`: items by state and the log's anomalies, folded from the work log's lines alone. */
export const WORK_PROJECTION: Projection<WorkModelState> = {
  name: "work",
  overview: true,
  empty: () => ({ counts: { proposed: 0, open: 0, closed: 0 }, anomalies: 0, states: {} }),
  sources: (dir) => ({ work: workLedger(dir) }),
  fold(state, item) {
    if (item.kind !== "line") return state;
    const record = item.record;
    const id = record["id"];
    const to = record["state"];
    if (typeof id !== "string" || typeof to !== "string") return state;
    const from = state.states[id];
    const legal =
      from === undefined
        ? record["event"] === "opened" && (MACHINES.work.entry as readonly string[]).includes(to)
        : record["event"] !== "opened" && canTransition("work", from, to);
    if (!legal) {
      // A repeated claim line, or a line for an item pushed out past the cap, is no anomaly.
      if (from === undefined && state.truncated === true) return state;
      if (from !== undefined && record["event"] === "opened" && record["claim"] !== undefined) {
        return state;
      }
      state.anomalies += 1;
      return state;
    }
    if (from !== undefined && counted(from)) state.counts[from] -= 1;
    if (counted(to)) state.counts[to] += 1;
    if (from === undefined) {
      const keys = Object.keys(state.states);
      if (keys.length >= WORK_MODEL_MAX) {
        const oldest = keys[0] as string;
        const gone = state.states[oldest];
        if (gone !== undefined && counted(gone)) state.counts[gone] -= 1;
        delete state.states[oldest];
        state.truncated = true;
      }
    }
    state.states[id] = to;
    return state;
  },
};

/** A work log line as its event: ids, states and codes only, never an item's text. */
export function workLineEvent(
  record: Readonly<Record<string, unknown>>,
  harness: string,
): EnvelopeFields | undefined {
  const id = record["id"];
  const event = record["event"];
  if (typeof id !== "string" || typeof event !== "string") return undefined;
  const type = `work.${event}`;
  if (!Object.hasOwn(EVENT_TAXONOMY, type)) return undefined;
  const at =
    typeof record["at"] === "string" && !Number.isNaN(Date.parse(record["at"]))
      ? record["at"]
      : new Date().toISOString();
  const run = record["run"];
  return {
    type: type as EventType,
    at,
    ingestedAt: at,
    harness,
    sensitivity: EVENT_TAXONOMY[type as EventType].sensitivity,
    work: id,
    ...(typeof run === "string" ? { run } : {}),
    payload: {
      state: record["state"],
      ...(typeof record["rev"] === "number" ? { rev: record["rev"] } : {}),
      ...(typeof record["outcome"] === "string" ? { outcome: record["outcome"] } : {}),
      ...(typeof record["reasonCode"] === "string" ? { reasonCode: record["reasonCode"] } : {}),
      ...(typeof record["scope"] === "string" ? { scope: record["scope"] } : {}),
    },
  };
}

export const WORK_STREAM_SOURCE: StreamSourceDecl = {
  name: "work",
  source: workLedger,
  eventOf: workLineEvent,
};

/** The work half of the runtime area's Home entry. */
export const WORK_HOME = {
  handlers: WORK_HANDLERS,
  refResolvers: { work: resolveWork },
  capabilityProviders: [WORK_ITEMS_CAPABILITY],
  projections: [WORK_PROJECTION as Projection<unknown>],
  streamSources: [WORK_STREAM_SOURCE],
} as const;

/** The runtime area's slot in Home, one half per file. */
export const HOME_RUNTIME: HomeAreaRuntime = {
  area: "runtime",
  sweeps: [
    ...WORKSPACES_HOME.sweeps,

    ...BUDGET_HOME.sweeps,
  ],
  handlers: {
    ...WORK_HOME.handlers,

    ...WORKSPACES_HOME.handlers,

    ...BUDGET_HOME.handlers,
  },
  refResolvers: {
    ...WORK_HOME.refResolvers,

    // ...BUDGET_HOME.refResolvers,
  },
  capabilityProviders: [
    ...WORK_HOME.capabilityProviders,

    ...WORKSPACES_HOME.capabilityProviders,

    ...BUDGET_HOME.capabilityProviders,
  ],
  projections: [
    ...WORK_HOME.projections,

    // ...BUDGET_HOME.projections,
  ],
  streamSources: [
    ...WORK_HOME.streamSources,

    ...WORKSPACES_HOME.streamSources,

    ...BUDGET_HOME.streamSources,
  ],
};
