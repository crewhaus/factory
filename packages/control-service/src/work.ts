/**
 * Work items through the control plane (#516, #514, #513, module brief 333): add, edit,
 * accept, decline, reopen, cancel, rank, start and adopt, each a receipted command carried
 * out through `@crewhaus/tool-work/work-items`' store, for Home and the CLI alike.
 *
 * Each command is planned first: every refusal the records can decide (an unknown item,
 * a move its state does not allow, a stale revision, a caller the rules do not let make
 * it, a field out of bounds) is decided before the command is accepted, so a refusal
 * writes neither a receipt nor a log line. The plan's effect runs once the receipt is
 * written; the store decides again under its lock, and a move that lost a race settles
 * the receipt `rejected` with the store's reason.
 *
 * Every line an effect writes records the receipt's id (`cmd`), which is what the
 * runtime area's executors and reconcilers observe.
 *
 * - `work.cancel` closes an open item as cancelled and cancels each of its linked runs
 *   that has not ended, through the run adapter of the harness's shape.
 * - `work.start` starts a run for an open item through `runs.create`'s adapter, with a
 *   seed that copies only what a person or an API caller wrote (`workSeed`).
 * - `work.adopt` reads its source through a port each head lends: a continuity goal on
 *   every head, a Thredz task in Home only. An issue is not adopted this way yet.
 */
import {
  type CommandReceipt,
  DECLINE_REASONS,
  type ErrorCode,
  MACHINES,
  type ReceiptEffect,
  type ReceiptVia,
  type WorkAssessment,
  type WorkCreateRequest,
  type WorkDeclineRequest,
  type WorkRankRequest,
  type WorkUpdateRequest,
} from "@crewhaus/control-contract";
import { foldStates, runsLedger } from "@crewhaus/control-records";
import {
  type AdoptRead,
  type FoldedWorkItem,
  type WorkActor,
  type WorkMove,
  type WorkRefusal,
  type WorkRevision,
  type WorkStore,
  type WorkVia,
  type WorkWrite,
  continuityGoalSource,
  mayMove,
  openWorkStore,
  parseAssessment,
  workFieldsProblem,
  workSeed,
} from "@crewhaus/tool-work/work-items";
import type { Settlement } from "./executor";
import { outcomeOf } from "./refusal";
import { type RunHome, runAdapterFor, runRefOf } from "./runs";

/** The harness a work command acts on, as the head found it. */
export type WorkHead = {
  readonly harnessDir: string;
  /** The harness id (`hrn_…`), for the refs a receipt names. */
  readonly harness: string;
  /** The spec's `target`, which picks the run adapter. */
  readonly target: string;
  /** The spec's name, for its continuity goals. */
  readonly specName?: string;
  /** Whether the spec lists a Work tool; `undefined` when it could not be read. */
  readonly tools?: boolean;
  readonly now?: () => number;
};

/** Who asks, as the store's rules take them: a person (Home, the CLI, Slack) or a service. */
export type WorkCaller = { readonly role: "person" | "service" };

/** A work command refused before it was accepted. Nothing was written. */
export type WorkCommandRefusal = {
  readonly code: ErrorCode;
  readonly reason: string;
  readonly message: string;
  /** The item's state or revision, when the refusal is about it. */
  readonly current?: string | number;
  readonly field?: string;
  /** The command that fills what is missing; `null` when there is none. */
  readonly verb?: string | null;
};

/** What a work command's effect answers. */
export type WorkCommandValue = {
  /** The item as the log says it is after the command. */
  readonly item?: FoldedWorkItem;
  /** The run `work.start` started. */
  readonly run?: string;
  /** Why the command did not do what it asked, when it did not. */
  readonly problem?: string;
  readonly warnings: readonly string[];
};

export type WorkPlan =
  | { readonly ok: false; readonly refusal: WorkCommandRefusal }
  | {
      readonly ok: true;
      readonly effect: (
        receipt: CommandReceipt,
      ) => Promise<{ readonly settle: Settlement; readonly value: WorkCommandValue }>;
    };

/** The ports a head lends adoption: where a Thredz task's words come from. */
export type WorkSourcePorts = {
  /** Read one Thredz task of the harness's workspace. Home lends it; the CLI does not. */
  readonly thredzTask?: (head: WorkHead, id: string) => AdoptRead;
};

/** A work item's ref, as a receipt's target and effects name it. */
export function workRefOf(harness: string, wi: string): string {
  return `${harness}/work/${wi}`;
}

const ADOPT_SOURCE_RE = /^(thredz-task|continuity-goal|github-issue):(.+)$/;

/** Why adopting an issue answers 501 for now. */
export const ISSUE_ADOPTION_NOT_SERVED = "Adopting an issue needs a repository connection.";

/** Why the CLI cannot adopt a Thredz task: Home holds the Thredz session. */
export const THREDZ_ADOPTION_NEEDS_HOME =
  "Adopting a Thredz task needs Home, which holds the harness's Thredz session.";

function refused(
  code: ErrorCode,
  reason: string,
  message: string,
  more: Omit<WorkCommandRefusal, "code" | "reason" | "message"> = {},
): WorkPlan {
  return { ok: false, refusal: { code, reason, message, ...more } };
}

function fromStore(refusal: WorkRefusal): WorkPlan {
  return refused(refusal.code, refusal.reason, refusal.message, {
    ...(refusal.current !== undefined ? { current: refusal.current } : {}),
    ...(refusal.field !== undefined ? { field: refusal.field } : {}),
  });
}

function viaOf(via: ReceiptVia): WorkVia {
  return via === "home" || via === "cli" || via === "sdk" || via === "slack" ? via : "system";
}

/** Who a receipt says wrote, as the store records it. */
export function workActorFor(receipt: CommandReceipt, caller: WorkCaller): WorkActor {
  return { by: receipt.actor, via: viaOf(receipt.via), role: caller.role, cmd: receipt.id };
}

function storeOf(head: WorkHead): WorkStore {
  return openWorkStore(head.harnessDir, head.now !== undefined ? { now: head.now } : {});
}

/** The item `wi` names, folded whole; a refusal when there is none or the log is unreadable. */
function itemOf(head: WorkHead, wi: string): FoldedWorkItem | WorkCommandRefusal {
  const read = storeOf(head).get(wi);
  if ("ok" in read) {
    return {
      code: read.code,
      reason: read.reason,
      message: read.message,
      ...(read.current !== undefined ? { current: read.current } : {}),
    };
  }
  return read.item;
}

function isRefusal(value: unknown): value is WorkCommandRefusal {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

function forbidden(caller: WorkCaller, move: WorkMove): WorkPlan {
  return refused(
    "forbidden",
    caller.role === "service" ? "human_only" : "actor_not_allowed",
    caller.role === "service"
      ? "A service credential cannot do this to a work item: a person does."
      : "This caller cannot do this to a work item.",
  );
}

function stateRefusal(item: FoldedWorkItem, reason: string, message: string): WorkPlan {
  return refused("conflict", reason, message, { current: item.state });
}

/** The receipt's effect for an item it wrote. */
function itemEffect(head: WorkHead, wi: string): ReceiptEffect {
  return { kind: "work", ref: workRefOf(head.harness, wi), status: "done" };
}

/** Settle a store write: done, or refused by what the store found under its lock. */
function settled(
  head: WorkHead,
  written: WorkWrite,
  warnings: readonly string[] = [],
): { readonly settle: Settlement; readonly value: WorkCommandValue } {
  if (written.ok) {
    return {
      settle: { state: "succeeded", effects: [itemEffect(head, written.item.id)] },
      value: { item: written.item, warnings },
    };
  }
  return {
    settle:
      written.code === "unavailable"
        ? { state: "failed", outcome: outcomeOf("unavailable") }
        : { state: "rejected", outcome: outcomeOf(written.code) },
    value: { problem: written.message, warnings },
  };
}

/** Check an assessment as the store would, before the receipt. */
function assessmentProblem(raw: WorkAssessment | undefined, at: string): WorkRefusal | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseAssessment(raw, at);
  return parsed.ok
    ? undefined
    : {
        ok: false,
        code: "invalid",
        reason: parsed.code,
        message: parsed.message,
        field: parsed.field,
      };
}

const RUN_TERMINAL: ReadonlySet<string> = new Set(MACHINES.run.terminal);

/** The linked runs that have not ended, newest state from the run ledger. */
function activeRunsOf(head: WorkHead, item: FoldedWorkItem): readonly string[] {
  const fold = foldStates(runsLedger(head.harnessDir));
  if (!fold.ok) return [];
  return item.runs.filter((run) => {
    const state = fold.objects.get(run)?.state;
    return state !== undefined && !RUN_TERMINAL.has(state);
  });
}

/** The work commands, planned per kind. Every refusal is decided before the receipt. */
export function workCommands(ports: WorkSourcePorts = {}) {
  const stamp = (head: WorkHead): string => new Date((head.now ?? Date.now)()).toISOString();

  return {
    /** `work.create`: a person or a service adds an open item. */
    create(head: WorkHead, caller: WorkCaller, body: WorkCreateRequest): WorkPlan {
      if (!mayMove(caller.role, "open")) return forbidden(caller, "open");
      const problem = workFieldsProblem(body) ?? assessmentProblem(body.assessment, stamp(head));
      if (problem !== undefined) return fromStore(problem);
      return {
        ok: true,
        effect: async (receipt) =>
          settled(head, await storeOf(head).create(body, workActorFor(receipt, caller))),
      };
    },

    /** `work.update`: an edit or a note, compare-and-set on the revision the caller read. */
    update(head: WorkHead, caller: WorkCaller, wi: string, body: WorkUpdateRequest): WorkPlan {
      const item = itemOf(head, wi);
      if (isRefusal(item)) return { ok: false, refusal: item };
      const { expect, note, ...fields } = body;
      const editing = Object.values(fields).some((v) => v !== undefined);
      if (!editing && note === undefined) {
        return refused("invalid", "nothing_to_change", "Say what changes: a field or a note.");
      }
      if (!mayMove(caller.role, editing ? "edit" : "note")) {
        return forbidden(caller, editing ? "edit" : "note");
      }
      if (expect !== item.rev) {
        return refused(
          "precondition_failed",
          "stale_revision",
          `This item is at revision ${item.rev}; read it again before you change it.`,
          { current: item.rev },
        );
      }
      const problem =
        workFieldsProblem({ ...fields, ...(note !== undefined ? { note } : {}) }) ??
        assessmentProblem(fields.assessment, stamp(head));
      if (problem !== undefined) return fromStore(problem);
      return {
        ok: true,
        effect: async (receipt) =>
          settled(head, await storeOf(head).update(wi, body, workActorFor(receipt, caller))),
      };
    },

    /** `work.accept`: a person accepts a proposal; it is up next. */
    accept(head: WorkHead, caller: WorkCaller, wi: string): WorkPlan {
      if (!mayMove(caller.role, "accept")) return forbidden(caller, "accept");
      const item = itemOf(head, wi);
      if (isRefusal(item)) return { ok: false, refusal: item };
      if (item.state !== "proposed") {
        return stateRefusal(item, "not_proposed", "Only a proposed item is accepted.");
      }
      return {
        ok: true,
        effect: async (receipt) =>
          settled(
            head,
            await storeOf(head).transition(wi, "open", {}, workActorFor(receipt, caller)),
          ),
      };
    },

    /** `work.decline`: a person declines a proposal, with a reason. */
    decline(head: WorkHead, caller: WorkCaller, wi: string, body: WorkDeclineRequest): WorkPlan {
      if (!mayMove(caller.role, "decline")) return forbidden(caller, "decline");
      if (!(DECLINE_REASONS as readonly string[]).includes(body.reason)) {
        return refused(
          "invalid",
          "invalid_field",
          `A decline gives a reason: ${DECLINE_REASONS.join(", ")}.`,
          { field: "reason" },
        );
      }
      const item = itemOf(head, wi);
      if (isRefusal(item)) return { ok: false, refusal: item };
      if (item.state !== "proposed") {
        return stateRefusal(item, "not_proposed", "Only a proposed item is declined.");
      }
      if (body.supersededBy !== undefined) {
        const other = itemOf(head, body.supersededBy);
        if (isRefusal(other) || other.id === wi) {
          return refused(
            "invalid",
            "invalid_field",
            "supersededBy names another work item of this harness.",
            { field: "supersededBy" },
          );
        }
      }
      const note = body.note !== undefined ? workFieldsProblem({ note: body.note }) : undefined;
      if (note !== undefined) return fromStore(note);
      return {
        ok: true,
        effect: async (receipt) =>
          settled(
            head,
            await storeOf(head).transition(
              wi,
              "closed",
              {
                reasonCode: body.reason,
                ...(body.note !== undefined ? { note: body.note } : {}),
                ...(body.supersededBy !== undefined ? { supersededBy: body.supersededBy } : {}),
              },
              workActorFor(receipt, caller),
            ),
          ),
      };
    },

    /** `work.reopen`: a person reopens a closed item. */
    reopen(head: WorkHead, caller: WorkCaller, wi: string): WorkPlan {
      if (!mayMove(caller.role, "reopen")) return forbidden(caller, "reopen");
      const item = itemOf(head, wi);
      if (isRefusal(item)) return { ok: false, refusal: item };
      if (item.state !== "closed") {
        return stateRefusal(item, "not_closed", "Only a closed item is reopened.");
      }
      return {
        ok: true,
        effect: async (receipt) =>
          settled(
            head,
            await storeOf(head).transition(wi, "open", {}, workActorFor(receipt, caller)),
          ),
      };
    },

    /**
     * `work.cancel`: an open item closes as cancelled, and each of its linked runs that has
     * not ended is cancelled the way `runs.cancel` cancels it. A run that could not be
     * cancelled is named in the answer's warnings; the item stays cancelled.
     */
    async cancel(head: WorkHead, caller: WorkCaller, wi: string, home: RunHome): Promise<WorkPlan> {
      if (!mayMove(caller.role, "cancel")) return forbidden(caller, "cancel");
      const item = itemOf(head, wi);
      if (isRefusal(item)) return { ok: false, refusal: item };
      if (item.state !== "open") {
        return stateRefusal(
          item,
          item.state === "proposed" ? "not_accepted" : "already_closed",
          item.state === "proposed"
            ? "A proposal is declined, not cancelled."
            : "This item is closed already.",
        );
      }
      const adapter = runAdapterFor(head.target);
      const cancels = await Promise.all(
        activeRunsOf(head, item).map(async (run) => ({
          run,
          plan: await adapter.cancelRun({
            harnessDir: head.harnessDir,
            harness: head.harness,
            target: head.target,
            runId: run,
            home,
          }),
        })),
      );
      return {
        ok: true,
        effect: async (receipt) => {
          const written = await storeOf(head).transition(
            wi,
            "closed",
            { outcome: "cancelled" },
            workActorFor(receipt, caller),
          );
          if (!written.ok) return settled(head, written);
          const warnings: string[] = [];
          const effects: ReceiptEffect[] = [itemEffect(head, wi)];
          for (const { run, plan } of cancels) {
            if (!plan.ok) {
              warnings.push(`run ${run} was not cancelled: ${plan.refusal.message}`);
              continue;
            }
            const done = await plan.effect(receipt);
            if (done.settle.state === "succeeded") {
              effects.push({ kind: "run", ref: runRefOf(head.harness, run), status: "done" });
            } else {
              warnings.push(
                `run ${run} was not cancelled${done.value.problem !== undefined ? `: ${done.value.problem}` : ""}`,
              );
            }
          }
          return {
            settle: { state: "succeeded", effects },
            value: { item: written.item, warnings },
          };
        },
      };
    },

    /** `work.rank`: a person moves an item ahead of another, as far as the scope reaches. */
    rank(head: WorkHead, caller: WorkCaller, wi: string, body: WorkRankRequest): WorkPlan {
      if (!mayMove(caller.role, "rank")) return forbidden(caller, "rank");
      const item = itemOf(head, wi);
      if (isRefusal(item)) return { ok: false, refusal: item };
      if (body.below === wi) {
        return refused("invalid", "invalid_field", "below names another work item.", {
          field: "below",
        });
      }
      const below = itemOf(head, body.below);
      if (isRefusal(below)) {
        return refused("not_found", "work_unknown", "There is no such item to move it above.", {
          field: "below",
        });
      }
      if (item.state === "closed" || below.state === "closed") {
        return refused("conflict", "closed", "A closed item is not ranked.", {
          current: item.state === "closed" ? item.state : below.state,
        });
      }
      return {
        ok: true,
        effect: async (receipt) =>
          settled(head, await storeOf(head).rank(wi, body, workActorFor(receipt, caller))),
      };
    },

    /**
     * `work.start`: a run for an open item, through the run adapter of the harness's shape.
     * Its seed copies only fields a person or an API caller wrote; the run's rows name the
     * item, and it resumes as `work:<wi>`.
     */
    async start(
      head: WorkHead,
      caller: WorkCaller,
      wi: string,
      home: RunHome,
      runId: string,
    ): Promise<WorkPlan> {
      if (!mayMove(caller.role, "link")) return forbidden(caller, "link");
      const store = storeOf(head);
      const read = store.get(wi);
      if ("ok" in read) return fromStore(read);
      if (read.item.state !== "open") {
        return stateRefusal(
          read.item,
          "not_accepted",
          read.item.state === "proposed"
            ? "This work item has not been accepted, so no run starts on it."
            : "This work item is closed. Reopen it to start a run on it.",
        );
      }
      const revision: WorkRevision | undefined = read.revision;
      if (revision === undefined) {
        return refused(
          "unavailable",
          "content_unreadable",
          "The item's content could not be read.",
        );
      }
      const seed = workSeed(wi, revision, { tools: head.tools === true });
      if (!seed.ok) return refused(seed.code, seed.reason, seed.message, { verb: null });
      const plan = await runAdapterFor(head.target).createRun({
        harnessDir: head.harnessDir,
        harness: head.harness,
        target: head.target,
        runId,
        input: seed.input,
        admission: "reject",
        work: wi,
        home,
      });
      if (!plan.ok) {
        return refused(plan.refusal.code, plan.refusal.reason, plan.refusal.message, {
          ...(plan.refusal.verb !== undefined ? { verb: plan.refusal.verb } : {}),
          ...(plan.refusal.current !== undefined ? { current: plan.refusal.current } : {}),
        });
      }
      return {
        ok: true,
        effect: async (receipt) => {
          const started = await plan.effect(receipt);
          const after = storeOf(head).get(wi);
          return {
            settle: started.settle,
            value: {
              ...("ok" in after ? {} : { item: after.item }),
              ...(started.value.run !== undefined ? { run: runId } : {}),
              ...(started.value.problem !== undefined ? { problem: started.value.problem } : {}),
              warnings: started.value.warnings,
            },
          };
        },
      };
    },

    /**
     * `work.adopt`: one item per source, open, its words read through the head's port at
     * the origin they came through. A repeat answers the item the source already opened
     * and writes nothing to the work log.
     */
    adopt(head: WorkHead, caller: WorkCaller, source: string): WorkPlan {
      if (!mayMove(caller.role, "open")) return forbidden(caller, "open");
      const match = ADOPT_SOURCE_RE.exec(source);
      if (match === null) {
        return refused(
          "invalid",
          "invalid_field",
          "Name the source as continuity-goal:<id>, thredz-task:<id> or github-issue:<owner>/<repo>#<n>.",
          { field: "source" },
        );
      }
      const kind = match[1] as "thredz-task" | "continuity-goal" | "github-issue";
      const id = match[2] as string;
      if (kind === "github-issue") {
        return refused("unsupported", "not_served", ISSUE_ADOPTION_NOT_SERVED, { verb: null });
      }
      let read: AdoptRead;
      if (kind === "thredz-task") {
        if (ports.thredzTask === undefined) {
          return refused("unsupported", "needs_home", THREDZ_ADOPTION_NEEDS_HOME, {
            verb: "crewhaus hangar serve",
          });
        }
        read = ports.thredzTask(head, id);
      } else {
        if (!/^goal-\d{4}$/.test(id)) {
          return refused("invalid", "invalid_field", "A continuity goal is named goal-NNNN.", {
            field: "source",
          });
        }
        read = continuityGoalSource(head.harnessDir, head.specName, id);
      }
      return {
        ok: true,
        effect: async (receipt) =>
          settled(
            head,
            await storeOf(head).adopt({ kind, ref: id }, read, workActorFor(receipt, caller)),
          ),
      };
    },
  };
}

export type WorkCommands = ReturnType<typeof workCommands>;
