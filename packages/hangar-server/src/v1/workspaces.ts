/**
 * A steward's workspaces through the API (#516, #514, #513, module brief 333): the workspace
 * half of the runtime area's Home entry. `workspaces.list` and `workspaces.get` fold the
 * harness's records and write nothing, and fetch nothing; `work.publish` is a receipted
 * command whose effect is control-service's, the same one the CLI runs.
 *
 * Check logs and the acceptance check's reasons are content: a caller without
 * `h.read.content` gets the branch, the SHAs, the checks' words and the pull request's state.
 *
 * Its sweeps run in Home's tick: `work-outcomes` reads each delivered pull request from the
 * code host, and `work-cleanup` settles attempts a stopped process left and closes the
 * worktrees of closed items.
 */
import { EVENT_TAXONOMY, type EventType } from "@crewhaus/control-contract";
import { readPage } from "@crewhaus/control-records";
import {
  type WorkspaceHomeDeps,
  settleWorkspaces,
  syncHarnessOutcomes,
  workRefOf,
  workspaceCommands,
} from "@crewhaus/control-service";
import { outcomesLedger, publishLedger, workspacesLedger } from "@crewhaus/tool-work/work-items";
import {
  attemptView,
  readBindings,
  workspaceSummaries,
  workspaceView,
} from "@crewhaus/tool-work/workspace";
import type { Sweep } from "../scheduler-host";
import type { HomePorts } from "../sweeps";
import type { HomeAreaRuntime } from "./areas";
import type { CapabilityProvider, V1Handler } from "./context";
import { V1Error } from "./errors";
import type { EnvelopeFields, StreamSourceDecl } from "./event-map";
import { emptyOf, pagingOf, snapshotCursor } from "./lists";
import { harnessOf, liveDirOf, liveDirOr409 } from "./resolve";
import { acceptedAnswer, replayedCommand, submitCommand } from "./submit";
import { callerOf, headOf, locate, refusalError } from "./work-shared";

/** How often the code host is asked about delivered pull requests. */
export const OUTCOMES_EVERY_MS = 10 * 60 * 1000;
/** How often workspaces are tidied. */
export const CLEANUP_EVERY_MS = 60 * 60 * 1000;

const NO_REPOSITORIES =
  "This harness delivers no work to a repository. Declare one under repositories in its crewhaus.yaml.";

/** The bindings the harness's last boot wrote; unreadable reads as none. */
function bindingsOf(dir: string) {
  try {
    return readBindings(dir);
  } catch {
    return undefined;
  }
}

const list: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOf(entry);
  const paging = pagingOf(ctx.query, "workspaces");
  const snapshot =
    dir === undefined ? [] : readPage(workspacesLedger(dir), { limit: 1 }).snapshotAt;
  const all = dir === undefined ? [] : workspaceSummaries(dir);
  const items = all.slice(0, paging.limit);
  const declares = dir !== undefined && bindingsOf(dir) !== undefined;
  return {
    status: 200,
    body: {
      items,
      snapshotAt: snapshotCursor("workspaces", snapshot),
      ...(all.length > items.length
        ? {
            truncated: {
              reason: "more_items",
              verb: `crewhaus workspace list --harness ${entry.id}`,
            },
          }
        : {}),
      ...(dir === undefined
        ? emptyOf(items, "unreachable", "The harness folder is missing.")
        : emptyOf(
            items,
            declares ? "no-data" : "unsupported",
            declares
              ? "No workspace yet. A run opens one when it starts on an accepted item."
              : NO_REPOSITORIES,
          )),
    },
    ...(dir !== undefined ? { scrubDir: dir } : {}),
  };
};

const get: V1Handler = async (ctx) => {
  const found = locate(ctx);
  const bindings = bindingsOf(found.dir);
  const view = workspaceView(found.dir, found.wi, {
    content: ctx.access.canReadContent(found.entry.id),
    ...(bindings !== undefined ? { bindings } : {}),
  });
  if (view === undefined) {
    throw new V1Error({
      status: 404,
      code: "not_found",
      reason: "no_workspace",
      message: "This item has no workspace yet. A run opens one when it starts on the item.",
    });
  }
  return { status: 200, body: { workspace: view }, scrubDir: found.dir };
};

const publish: V1Handler = async (ctx) => {
  const found = locate(ctx);
  liveDirOr409(found.entry);
  const command = {
    target: workRefOf(found.entry.id, found.wi),
    ledger: { harness: found.dir },
  } as const;
  const replay = await replayedCommand(ctx, command);
  if (replay !== undefined) return acceptedAnswer(replay, {}, found.dir);
  const planned = workspaceCommands().publish(
    headOf(ctx, found.entry, found.dir),
    callerOf(ctx),
    found.wi,
  );
  if (!planned.ok) throw refusalError(planned.refusal);
  const { effect } = planned;
  const submitted = await submitCommand(ctx, {
    ...command,
    effect: async (receipt) => effect(receipt),
  });
  const { value } = submitted;
  return acceptedAnswer(
    submitted,
    {
      ...(value?.attempt !== undefined ? { attempt: attemptView(value.attempt) } : {}),
      ...(value?.problem !== undefined ? { problem: value.problem } : {}),
    },
    found.dir,
  );
};

export const WORKSPACE_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "work.publish": publish,
  "workspaces.list": list,
  "workspaces.get": get,
};

/** `work.workspaces`: whether this harness delivers work to a repository. */
export const WORK_WORKSPACES_CAPABILITY: CapabilityProvider = {
  key: "work.workspaces",
  async answer(entry) {
    const dir = liveDirOf(entry);
    if (dir === undefined) {
      return { supported: "unknown", reason: "The harness folder is missing." };
    }
    return bindingsOf(dir) !== undefined
      ? { supported: true }
      : { supported: false, reason: NO_REPOSITORIES, verb: null };
  },
};

type Line = Readonly<Record<string, unknown>>;

function envelope(
  type: string,
  record: Line,
  harness: string,
  work: string,
  payload: Readonly<Record<string, unknown>>,
): EnvelopeFields | undefined {
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
    work,
    ...(typeof run === "string" ? { run } : {}),
    payload,
  };
}

const text = (record: Line, key: string): Readonly<Record<string, string>> =>
  typeof record[key] === "string" ? { [key]: record[key] as string } : {};
const num = (record: Line, key: string): Readonly<Record<string, number>> =>
  typeof record[key] === "number" ? { [key]: record[key] as number } : {};

/** A publish attempt line as its event: states, codes, SHAs and counts only. */
export function publishLineEvent(record: Line, harness: string): EnvelopeFields | undefined {
  const wi = record["wi"];
  const state = record["state"];
  if (typeof wi !== "string" || typeof state !== "string") return undefined;
  return envelope(`work.publish.${state}`, record, harness, wi, {
    ...num(record, "attempt"),
    ...num(record, "pr"),
    ...text(record, "code"),
    ...text(record, "headSha"),
    ...num(record, "files"),
    ...num(record, "lines"),
  });
}

/** A pull request outcome line as its event. */
export function outcomeLineEvent(record: Line, harness: string): EnvelopeFields | undefined {
  const wi = record["id"];
  if (typeof wi !== "string") return undefined;
  return envelope("work.outcome", record, harness, wi, {
    ...num(record, "pr"),
    ...text(record, "state"),
    ...text(record, "review"),
  });
}

/** A workspace line that opens or closes one, as its event; a check or a refresh is none. */
export function workspaceLineEvent(record: Line, harness: string): EnvelopeFields | undefined {
  const wi = record["id"];
  const event = record["event"];
  if (typeof wi !== "string" || typeof event !== "string") return undefined;
  return envelope(`workspace.${event}`, record, harness, wi, {
    ...text(record, "binding"),
    ...text(record, "baseSha"),
  });
}

export const WORKSPACE_STREAM_SOURCES: readonly StreamSourceDecl[] = [
  { name: "publish", source: publishLedger, eventOf: publishLineEvent },
  { name: "outcomes", source: outcomesLedger, eventOf: outcomeLineEvent },
  { name: "workspaces", source: workspacesLedger, eventOf: workspaceLineEvent },
];

/** The sweeps, over the ports a test replaces. */
export function workspaceSweeps(
  deps: WorkspaceHomeDeps = {},
): readonly [Sweep<HomePorts>, Sweep<HomePorts>] {
  const each = async (
    ctx: Parameters<Sweep<HomePorts>["run"]>[0],
    what: string,
    fn: (dir: string) => Promise<{ readonly problem?: string }>,
  ): Promise<void> => {
    for (const harness of ctx.home.liveHarnesses()) {
      try {
        const done = await fn(harness.dir);
        if (done.problem !== undefined) ctx.warn(`${what} of ${harness.id}: ${done.problem}`);
      } catch (err) {
        ctx.warn(`${what} of ${harness.id}: ${(err as Error).message}`);
      }
    }
  };
  return [
    {
      name: "work-outcomes",
      everyMs: OUTCOMES_EVERY_MS,
      run: (ctx) =>
        each(ctx, "the pull requests", (dir) =>
          syncHarnessOutcomes(dir, { now: () => ctx.now, ...deps }),
        ),
    },
    {
      name: "work-cleanup",
      everyMs: CLEANUP_EVERY_MS,
      run: (ctx) =>
        each(ctx, "the workspaces", (dir) =>
          settleWorkspaces(dir, { now: () => ctx.now, ...deps }),
        ),
    },
  ];
}

/** The workspace half of the runtime area's Home entry; `./work.ts` composes the area's slot. */
export const WORKSPACES_HOME = {
  handlers: WORKSPACE_HANDLERS,
  capabilityProviders: [WORK_WORKSPACES_CAPABILITY],
  streamSources: WORKSPACE_STREAM_SOURCES,
  sweeps: workspaceSweeps(),
} as const satisfies Omit<HomeAreaRuntime, "area">;
