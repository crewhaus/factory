/**
 * Publishing a work item from Home or the CLI (#516, #514, #513, module brief 333), and what
 * Home does with a steward's workspaces between runs.
 *
 * - {@link workspaceCommands}' `publish` is a receipted command with an external effect. It
 *   never calls a model: it publishes only the exact change a run of the harness already
 *   judged and passed, through the same engine, with that run's words. Its binding is the one
 *   the harness's last boot wrote, and its token comes from the harness's own environment
 *   files, never from this process's environment.
 * - {@link trackHarnessOutcomes} and {@link closeFinishedWorkspaces} are the passes Home's tick
 *   makes: attempts a stopped process left and the pull request tracker, then worktrees of
 *   closed items.
 * - {@link WORKSPACE_REVOKER} closes a retired harness's worktrees, keeping uncommitted work
 *   as a commit on its branch.
 */
import { type CommandReceipt, type ErrorCode, starterOf } from "@crewhaus/control-contract";
import {
  type LeaseProbe,
  readApproverProjection,
  readHarnessIdentity,
} from "@crewhaus/control-records";
import { loadEnvChain, readHarnessEnvFiles } from "@crewhaus/harness-supervisor";
import { containedSessionRoot, createPendingApprovalStore } from "@crewhaus/session-store";
import {
  type FoldedAttempt,
  type WorkActor,
  openWorkStore,
  readAttempts,
  readWorkspaces,
} from "@crewhaus/tool-work/work-items";
import {
  type EngineDeps,
  type SyncAnswer,
  WorkspaceConfigError,
  type WorkspaceEngine,
  createWorkspaceEngine,
  overLimitsPort,
  readBindings,
  syncOutcomes,
} from "@crewhaus/tool-work/workspace";
import type { Reconciliation, RetireRevoker, Settlement } from "./executor";
import { outcomeOf } from "./refusal";
import {
  type WorkCaller,
  type WorkCommandRefusal,
  type WorkHead,
  workActorFor,
  workRefOf,
} from "./work";

/** Ports a test replaces; a head lends only its clock and probe. */
export type WorkspaceHomeDeps = {
  readonly now?: () => number;
  readonly probe?: LeaseProbe;
  readonly engine?: Partial<EngineDeps>;
};

const TRACKER_ACTOR: WorkActor = { by: "sys:runtime", via: "system", role: "system" };

/** Home's page for an item, from the harness's identity and the Home it answers to. */
function homeLink(harnessDir: string): (wi: string) => string | undefined {
  return (wi) => {
    try {
      const identity = readHarnessIdentity(harnessDir);
      const home = readApproverProjection(harnessDir);
      if (identity.state !== "present" || home.state !== "present") return undefined;
      const base = home.projection.homeUrl;
      return base === undefined
        ? undefined
        : `${base}/#/h/${identity.identity.id}/work/items/${wi}`;
    } catch {
      return undefined;
    }
  };
}

/**
 * The engine Home works a harness with: the bindings its last boot wrote, the environment
 * files its daemon is started with, and no check runner, because Home runs no project code.
 */
export function homeWorkspaceEngine(
  harnessDir: string,
  deps: WorkspaceHomeDeps = {},
): WorkspaceEngine {
  const identity = readHarnessIdentity(harnessDir);
  const name = identity.state === "present" ? identity.identity.slug : undefined;
  return createWorkspaceEngine({
    harnessDir,
    bindings: () => readBindings(harnessDir),
    env: loadEnvChain(harnessDir).vars,
    checkRunner: null,
    homeLink: homeLink(harnessDir),
    ...(name !== undefined ? { name } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
    ...deps.engine,
  });
}

/** What publishing answers: the attempt it made, or why none was finished. */
export type WorkspacePublishValue = {
  readonly attempt?: FoldedAttempt;
  readonly problem?: string;
};

export type WorkspacePublishPlan =
  | { readonly ok: false; readonly refusal: WorkCommandRefusal }
  | {
      readonly ok: true;
      readonly effect: (
        receipt: CommandReceipt,
      ) => Promise<{ readonly settle: Settlement; readonly value: WorkspacePublishValue }>;
    };

function refused(
  code: ErrorCode,
  reason: string,
  message: string,
  more: Omit<WorkCommandRefusal, "code" | "reason" | "message"> = {},
): WorkspacePublishPlan {
  return { ok: false, refusal: { code, reason, message, ...more } };
}

/** The newest attempt a receipt made. */
function attemptOf(harnessDir: string, wi: string, cmd: string): FoldedAttempt | undefined {
  return [...(readAttempts(harnessDir).get(wi) ?? [])].reverse().find((a) => a.cmd === cmd);
}

/** The attempt a receipt made, whichever item it was for. */
function attemptByReceipt(harnessDir: string, cmd: string): FoldedAttempt | undefined {
  for (const list of readAttempts(harnessDir).values()) {
    const found = [...list].reverse().find((a) => a.cmd === cmd);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The workspace commands, planned: every refusal the records can decide comes first. */
export function workspaceCommands(deps: WorkspaceHomeDeps = {}) {
  return {
    /** `work.publish`: publish the change a run of the harness judged, or say why not. */
    publish(head: WorkHead, caller: WorkCaller, wi: string): WorkspacePublishPlan {
      const { harnessDir } = head;
      const now = head.now ?? deps.now;
      const read = openWorkStore(harnessDir, now !== undefined ? { now } : {}).get(wi);
      if ("ok" in read) return refused(read.code, read.reason, read.message);
      if (read.item.state !== "open") {
        return refused(
          "conflict",
          "not_accepted",
          read.item.state === "proposed"
            ? "This work item has not been accepted, so there is nothing to publish."
            : "This work item is closed. Reopen it to publish its change.",
          { current: read.item.state },
        );
      }
      const ws = readWorkspaces(harnessDir).get(wi);
      if (ws === undefined || ws.state !== "open") {
        return refused(
          "conflict",
          "no_workspace",
          "This item has no open workspace. A run of the harness opens one and makes the change.",
          { verb: `crewhaus work start ${wi}` },
        );
      }
      try {
        if (readBindings(harnessDir) === undefined) {
          return refused(
            "unavailable",
            "no_bindings",
            "This harness has written no repository bindings. Start it once with a build that declares repositories.",
          );
        }
      } catch (err) {
        if (!(err instanceof WorkspaceConfigError)) throw err;
        return refused("unavailable", "no_bindings", err.message);
      }
      return {
        ok: true,
        effect: async (receipt) => {
          const engine = homeWorkspaceEngine(harnessDir, {
            ...deps,
            ...(now !== undefined ? { now } : {}),
          });
          const root = containedSessionRoot(harnessDir, readHarnessEnvFiles(harnessDir).vars);
          const starter = starterOf(receipt.via);
          const answer = await engine.publish({
            wi,
            mode: "home",
            actor: workActorFor(receipt, caller),
            ...(root !== undefined
              ? {
                  limits: overLimitsPort(
                    harnessDir,
                    { store: createPendingApprovalStore({ rootDir: root }), surface: "home" },
                    { runId: receipt.id, ...(starter !== undefined ? { starter } : {}) },
                  ),
                }
              : {}),
          });
          const attempt = attemptOf(harnessDir, wi, receipt.id);
          const value = attempt !== undefined ? { attempt } : {};
          if (answer.ok) {
            return answer.state === "done"
              ? {
                  settle: {
                    state: "succeeded",
                    effects: [
                      { kind: "work", ref: workRefOf(head.harness, wi), status: "done" as const },
                    ],
                  },
                  value,
                }
              : { settle: { state: "unknown" }, value };
          }
          return {
            settle: {
              state: "failed",
              outcome: outcomeOf(
                answer.code === "credential_unavailable" || answer.code === "unsupported_host"
                  ? "unavailable"
                  : "precondition_failed",
              ),
            },
            value: { ...value, problem: answer.message },
          };
        },
      };
    },
  };
}

export type WorkspaceCommands = ReturnType<typeof workspaceCommands>;

/**
 * What became of a `work.publish` command: its attempt, settled against the code host when
 * nobody knows. Nothing here publishes.
 */
export async function reconcilePublish(
  receipt: CommandReceipt,
  harnessDir: string,
  deps: WorkspaceHomeDeps = {},
): Promise<Reconciliation> {
  const made = attemptByReceipt(harnessDir, receipt.id);
  if (made === undefined) return "unknown";
  let attempt: FoldedAttempt | undefined = made;
  if (made.state === "started" || made.state === "pushed" || made.state === "unknown") {
    try {
      attempt = await homeWorkspaceEngine(harnessDir, deps).settle(made.wi, {
        actor: TRACKER_ACTOR,
      });
    } catch {
      return "unknown";
    }
    if (attempt?.id !== made.id) {
      attempt = readAttempts(harnessDir)
        .get(made.wi)
        ?.find((a) => a.id === made.id);
    }
  }
  if (attempt?.state === "done") return "done";
  if (attempt?.state === "failed" || attempt?.state === "not-done") return "not-done";
  return "unknown";
}

export type SettleAnswer = {
  /** Attempts a stopped process left that were settled. */
  readonly settled: number;
  readonly problem?: string;
};

/** Settle each attempt nobody is making. Nothing is asked for a harness that has none. */
export async function settleAttempts(
  harnessDir: string,
  deps: WorkspaceHomeDeps = {},
): Promise<SettleAnswer> {
  let settled = 0;
  let problem: string | undefined;
  let engine: WorkspaceEngine | undefined;
  for (const [wi, list] of readAttempts(harnessDir)) {
    const last = list.at(-1);
    if (last?.state !== "started" && last?.state !== "pushed" && last?.state !== "unknown") {
      continue;
    }
    try {
      engine ??= homeWorkspaceEngine(harnessDir, deps);
      const after = await engine.settle(wi, { actor: TRACKER_ACTOR });
      if (after !== undefined && after.state !== last.state) settled += 1;
    } catch (err) {
      problem = (err as Error).message;
    }
  }
  return { settled, ...(problem !== undefined ? { problem } : {}) };
}

export type TrackAnswer = SyncAnswer & { readonly settled: number };

/**
 * One harness's publishes, read from the code host and recorded: an attempt a stopped process
 * left is settled first, then each delivered pull request is looked at.
 */
export async function trackHarnessOutcomes(
  harnessDir: string,
  deps: WorkspaceHomeDeps = {},
): Promise<TrackAnswer> {
  const { settled, problem } = await settleAttempts(harnessDir, deps);
  const synced = await syncOutcomes(harnessDir, {
    env: loadEnvChain(harnessDir).vars,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.engine?.provider !== undefined ? { provider: deps.engine.provider } : {}),
  });
  return { ...(problem !== undefined ? { problem } : {}), ...synced, settled };
}

export type CloseAnswer = {
  /** Worktrees of closed items that were closed. */
  readonly closed: number;
  readonly problem?: string;
};

/** Close the worktrees of closed items, keeping uncommitted work on each branch. */
export async function closeFinishedWorkspaces(
  harnessDir: string,
  deps: WorkspaceHomeDeps = {},
): Promise<CloseAnswer> {
  let closed = 0;
  let problem: string | undefined;
  let engine: WorkspaceEngine | undefined;
  const store = openWorkStore(harnessDir);
  for (const ws of readWorkspaces(harnessDir).values()) {
    if (ws.state !== "open") continue;
    const read = store.get(ws.id);
    if ("ok" in read || read.item.state !== "closed") continue;
    try {
      engine ??= homeWorkspaceEngine(harnessDir, deps);
      if ((await engine.close(ws.id, { actor: TRACKER_ACTOR })).closed) closed += 1;
    } catch (err) {
      problem = (err as Error).message;
    }
  }
  return { closed, ...(problem !== undefined ? { problem } : {}) };
}

/** Closes a retired harness's worktrees. The managed clone stays, with every branch. */
export const WORKSPACE_REVOKER: RetireRevoker = {
  name: "workspaces",
  async plan({ harnessDir }) {
    const open = [...readWorkspaces(harnessDir).values()].filter((w) => w.state === "open");
    return open.map((w) => ({
      kind: "workspace",
      status: "planned" as const,
      note: `${w.binding}: ${w.branch}`,
    }));
  },
  async revoke({ harnessDir, actor, cmd }) {
    const open = [...readWorkspaces(harnessDir).values()].filter((w) => w.state === "open");
    if (open.length === 0) return [];
    const engine = homeWorkspaceEngine(harnessDir);
    let done = 0;
    for (const ws of open) {
      const answer = await engine.close(ws.id, {
        actor: {
          by: actor,
          via: "system",
          role: "system",
          ...(cmd !== undefined ? { cmd } : {}),
        },
      });
      if (answer.closed) done += 1;
    }
    return [
      {
        kind: "retire.workspaces",
        status: done === open.length ? "done" : "failed",
        observed: `${done} of ${open.length} closed`,
      },
    ];
  },
};
