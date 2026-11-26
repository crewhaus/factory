/**
 * What a person does about an item without settling its record: assign it, put it off, hide
 * it from themselves, set a problem aside, take it up again. Each is one line on the
 * harness's actions ledger. Assignment grants nothing: what an item needs, it needs of
 * whoever decides it.
 */
import {
  type AttentionActionEvent,
  type AttentionItem,
  type AttentionResolution,
  type AttentionState,
  DEFER_REASONS,
  DISMISS_REASONS,
  type DeferReason,
  type DismissReason,
  isId,
} from "@crewhaus/control-contract";
import { parseDeferUntil } from "@crewhaus/session-store";
import { DEFER_MAX_MS, decidesItself } from "../overlays";
import {
  approvalIdsOf,
  assigneeProblem,
  classProblem,
  expectProblem,
  isOpen,
  noteProblem,
  refuse,
  settledProblem,
} from "./checks";
import { type ActionLine, appendAction, appendAdvisorDecision } from "./ledger";
import type { ActAnswer, ActDeps, ActPlan, ActRefusal, ActRequest } from "./types";

const iso = (ms: number): string => new Date(ms).toISOString();

type LineExtra = Partial<
  Pick<ActionLine, "how" | "choice" | "to" | "member" | "until" | "reasonCode">
>;

/** The same act as another verb's event: a verdict that puts an item off, say. */
export type ActAs = {
  readonly event: AttentionActionEvent;
  readonly choice?: string;
  readonly how?: AttentionResolution;
};

async function act(
  request: ActRequest,
  deps: ActDeps,
  event: AttentionActionEvent,
  state: AttentionState,
  cmd: string | undefined,
  extra: LineExtra = {},
  detail?: string,
): Promise<ActAnswer> {
  const failed = await appendAction(request.dir, request.item, {
    state,
    event,
    at: iso(deps.now()),
    by: await deps.decisions.storedActorOf(request.dir, request.actor),
    via: request.via,
    evidenceRev: request.item.evidenceRev,
    ...extra,
    ...(cmd !== undefined ? { cmd } : {}),
  });
  if (failed !== undefined) return failed;
  return { ok: true, event, state, ...(detail !== undefined ? { detail } : {}) };
}

/** An item that waits for someone, as the person read it. */
function openProblem(request: ActRequest): ActRefusal | undefined {
  return settledProblem(request.item) ?? expectProblem(request);
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export function planAssign(request: ActRequest & { readonly to: string }, deps: ActDeps): ActPlan {
  const problem = openProblem(request);
  if (problem !== undefined) return problem;
  if (!isId("prn", request.to)) {
    return refuse("invalid", "to", "Name a member: prn_ and 26 characters.");
  }
  const unfit = assigneeProblem(request.to, request.item.requiredClass, deps);
  if (unfit !== undefined) return unfit;
  return {
    ok: true,
    run: (cmd) => act(request, deps, "assigned", "assigned", cmd, { to: request.to }),
  };
}

export function planUnassign(request: ActRequest, deps: ActDeps): ActPlan {
  const problem = openProblem(request);
  if (problem !== undefined) return problem;
  if (request.item.assignee === undefined) {
    return refuse("conflict", "not_assigned", "This is not assigned to anyone.");
  }
  const putOff =
    request.item.state === "deferred" && request.item.deferral?.deadlineMoved === false;
  return {
    ok: true,
    run: (cmd) => act(request, deps, "unassigned", putOff ? "deferred" : "open", cmd),
  };
}

// ---------------------------------------------------------------------------
// Putting off
// ---------------------------------------------------------------------------

/** A time to put something off until, or why it is not one. */
function untilProblem(until: string, now: number): { readonly at: string } | ActRefusal {
  const ms = parseDeferUntil(until, now);
  if (typeof ms === "string") return refuse("invalid", "until", ms);
  if (ms - now > DEFER_MAX_MS) {
    return refuse("invalid", "until", "An item is put off for at most 90 days.");
  }
  return { at: iso(ms) };
}

/** Why a request could not be put off, as the decision service says. */
function deferRefusal(answer: Awaited<ReturnType<ActDeps["decisions"]["defer"]>>): ActRefusal {
  switch (answer.outcome) {
    case "forbidden":
      return refuse("forbidden", "decider", answer.reason ?? "You may not put this off.");
    case "not-found":
      return refuse("not_found", "decision_unknown", answer.reason ?? "No such request.");
    case "expired":
      return refuse("precondition_failed", "expired", "This request has expired.");
    default:
      return refuse("already_decided", "already_decided", "This was already settled.");
  }
}

export function planDefer(
  request: ActRequest & { readonly until: string; readonly reason: DeferReason },
  deps: ActDeps,
  as: ActAs = { event: "deferred" },
): ActPlan {
  const problem = openProblem(request);
  if (problem !== undefined) return problem;
  if (!(DEFER_REASONS as readonly string[]).includes(request.reason)) {
    return refuse("invalid", "reason", `A reason is one of: ${DEFER_REASONS.join(", ")}.`);
  }
  const when = untilProblem(request.until, deps.now());
  if (!("at" in when)) return when;
  const unreached = classProblem(request, request.item.requiredClass, deps);
  if (unreached !== undefined) return unreached;
  const { item, dir, actor, via } = request;
  const extra: LineExtra = {
    until: when.at,
    reasonCode: request.reason,
    ...(as.how !== undefined ? { how: as.how } : {}),
    ...(as.choice !== undefined ? { choice: as.choice } : {}),
  };
  if (item.source.kind === "approval") {
    // A request's own deadline moves with it: the decision service writes that, under its
    // own lock, and refuses once someone decided.
    const ids = approvalIdsOf(item);
    if (ids.length === 0) {
      return refuse("conflict", "not_decidable", "This item names no request to put off.");
    }
    return {
      ok: true,
      async run(cmd) {
        const refusals: ActRefusal[] = [];
        for (const ref of ids) {
          const answer = await deps.decisions.defer({
            harnessDir: dir,
            ref,
            until: when.at,
            reason: request.reason,
            actor,
            via,
          });
          if (answer.outcome !== "deferred") refusals.push(deferRefusal(answer));
        }
        // Several requests are one item: it is put off when any of them still could be.
        const first = refusals[0];
        if (first !== undefined && refusals.length === ids.length) return first;
        const detail =
          refusals.length === 0
            ? "Its deadline moved with it."
            : `${ids.length - refusals.length} of ${ids.length} requests were put off; the others were already settled.`;
        return act(request, deps, as.event, "deferred", cmd, extra, detail);
      },
    };
  }
  return {
    ok: true,
    run: (cmd) =>
      act(
        request,
        deps,
        as.event,
        "deferred",
        cmd,
        extra,
        item.source.kind === "decision" ? "Its own deadline is unchanged." : undefined,
      ),
  };
}

export function planUndefer(request: ActRequest, deps: ActDeps): ActPlan {
  const problem = openProblem(request);
  if (problem !== undefined) return problem;
  const { item } = request;
  if (item.state !== "deferred") {
    return refuse("conflict", "not_deferred", "This is not put off.");
  }
  if (item.deferral?.deadlineMoved === true) {
    return refuse(
      "conflict",
      "deadline_moved",
      "Its deadline was moved and stays where it is. It can be decided any time.",
    );
  }
  const unreached = classProblem(request, item.requiredClass, deps);
  if (unreached !== undefined) return unreached;
  return {
    ok: true,
    run: (cmd) =>
      act(request, deps, "undeferred", item.assignee !== undefined ? "assigned" : "open", cmd),
  };
}

/** Hide an item from its own viewer until a time: no one else's list changes. */
export function planSnooze(
  request: ActRequest & { readonly until: string },
  deps: ActDeps,
): ActPlan {
  const problem = openProblem(request);
  if (problem !== undefined) return problem;
  const when = untilProblem(request.until, deps.now());
  if (!("at" in when)) return when;
  return {
    ok: true,
    async run(cmd) {
      const member = await deps.decisions.storedActorOf(request.dir, request.actor);
      return act(request, deps, "snoozed", overlayStateOf(request.item), cmd, {
        member,
        until: when.at,
      });
    },
  };
}

/** The state an act that changes none carries on its line. */
export function overlayStateOf(item: AttentionItem): AttentionState {
  if (item.state === "deferred" && item.deferral?.deadlineMoved === true) return "open";
  return isOpen(item) ? item.state : "open";
}

// ---------------------------------------------------------------------------
// Setting aside
// ---------------------------------------------------------------------------

/** Problems and suggestions are set aside; a decision is decided. */
function asideProblem(request: ActRequest): ActRefusal | undefined {
  if (decidesItself(request.item)) {
    return refuse("conflict", "decides", "This waits for a decision: decide it, or put it off.");
  }
  return openProblem(request);
}

/** A note is kept with an Advisor finding, where its reasons are; anywhere else, discuss it. */
function asideNoteProblem(request: ActRequest, note: string | undefined): ActRefusal | undefined {
  return note === undefined || request.item.source.kind === "advisor"
    ? noteProblem(note)
    : refuse(
        "invalid",
        "note",
        "A note is kept for Advisor findings only. Add it to the discussion.",
      );
}

async function setAside(
  request: ActRequest & { readonly note?: string },
  deps: ActDeps,
  verb: {
    readonly event: AttentionActionEvent;
    readonly action: "dismissed" | "acknowledged";
    readonly how: AttentionResolution;
    readonly reasonCode?: DismissReason;
    readonly choice?: string;
  },
  cmd: string | undefined,
): Promise<ActAnswer> {
  const { item, dir, actor, via, note } = request;
  if (item.source.kind === "advisor") {
    const failed = appendAdvisorDecision(dir, {
      itemId: item.source.id,
      action: verb.action,
      at: iso(deps.now()),
      by: await deps.decisions.storedActorOf(dir, actor),
      via,
      evidenceRev: item.evidenceRev,
      ...(verb.reasonCode !== undefined ? { reasonCode: verb.reasonCode } : {}),
      ...(note !== undefined ? { reason: note } : {}),
      ...(cmd !== undefined ? { cmd } : {}),
    });
    if (failed !== undefined) return failed;
  }
  return act(request, deps, verb.event, "resolved", cmd, {
    how: verb.how,
    ...(verb.reasonCode !== undefined ? { reasonCode: verb.reasonCode } : {}),
    ...(verb.choice !== undefined ? { choice: verb.choice } : {}),
  });
}

export function planDismiss(
  request: ActRequest & { readonly reasonCode: DismissReason; readonly note?: string },
  deps: ActDeps,
): ActPlan {
  const problem = asideProblem(request) ?? asideNoteProblem(request, request.note);
  if (problem !== undefined) return problem;
  if (!(DISMISS_REASONS as readonly string[]).includes(request.reasonCode)) {
    return refuse("invalid", "reasonCode", `A reason is one of: ${DISMISS_REASONS.join(", ")}.`);
  }
  return {
    ok: true,
    run: (cmd) =>
      setAside(
        request,
        deps,
        {
          event: "dismissed",
          action: "dismissed",
          how: "dismissed",
          reasonCode: request.reasonCode,
        },
        cmd,
      ),
  };
}

export function planAcknowledge(
  request: ActRequest & { readonly note?: string },
  deps: ActDeps,
  as: ActAs = { event: "acknowledged" },
): ActPlan {
  const problem = asideProblem(request) ?? asideNoteProblem(request, request.note);
  if (problem !== undefined) return problem;
  return {
    ok: true,
    run: (cmd) =>
      setAside(
        request,
        deps,
        {
          event: as.event,
          action: "acknowledged",
          how: "acted",
          ...(as.choice !== undefined ? { choice: as.choice } : {}),
        },
        cmd,
      ),
  };
}

/** Take up a problem that was set aside. One that cleared by itself opens on new evidence. */
export function planReopen(
  request: ActRequest & { readonly note?: string },
  deps: ActDeps,
): ActPlan {
  const { item } = request;
  if (decidesItself(item)) {
    return refuse("conflict", "decides", "A decision is not taken up again; it is asked again.");
  }
  const how = item.resolution?.how;
  if (item.state !== "resolved" || (how !== "dismissed" && how !== "acted")) {
    return refuse("conflict", "not_set_aside", "This was not set aside.", {
      current: { state: item.state },
    });
  }
  const problem = expectProblem(request) ?? asideNoteProblem(request, request.note);
  if (problem !== undefined) return problem;
  return {
    ok: true,
    async run(cmd) {
      if (item.source.kind === "advisor") {
        const failed = appendAdvisorDecision(request.dir, {
          itemId: item.source.id,
          action: "reopened",
          at: iso(deps.now()),
          by: await deps.decisions.storedActorOf(request.dir, request.actor),
          via: request.via,
          evidenceRev: item.evidenceRev,
          ...(request.note !== undefined ? { comment: request.note } : {}),
          ...(cmd !== undefined ? { cmd } : {}),
        });
        if (failed !== undefined) return failed;
      }
      return act(request, deps, "reopened", "open", cmd);
    },
  };
}

// ---------------------------------------------------------------------------
// Carried out in one call
// ---------------------------------------------------------------------------

const carried =
  <R extends ActRequest>(plan: (request: R, deps: ActDeps) => ActPlan) =>
  async (request: R, deps: ActDeps, cmd?: string): Promise<ActAnswer> => {
    const planned = plan(request, deps);
    return planned.ok ? planned.run(cmd) : planned;
  };

export const assignItem = carried(planAssign);
export const unassignItem = carried(planUnassign);
export const deferItem = carried((request: Parameters<typeof planDefer>[0], deps: ActDeps) =>
  planDefer(request, deps),
);
export const undeferItem = carried(planUndefer);
export const snoozeItem = carried(planSnooze);
export const dismissItem = carried(planDismiss);
export const acknowledgeItem = carried(
  (request: Parameters<typeof planAcknowledge>[0], deps: ActDeps) => planAcknowledge(request, deps),
);
export const reopenItem = carried(planReopen);
