/**
 * Deciding an item: its source's own writer settles it, whichever surface asks. A tool
 * request and a `dec_` go to the decision service, a review entry to its claimed writer, a
 * graph pause to a resume, a protected environment's quorum to its vote, an Advisor finding
 * to its own closed job. The inbox settles nothing itself, and records the act once.
 */
import {
  type AttentionResolution,
  type AttentionState,
  attentionChoiceDoes,
  isId,
} from "@crewhaus/control-contract";
import { readDeployQuorums } from "@crewhaus/control-records";
import { readBudgetState } from "@crewhaus/control-records/budget";
import type { ResolveAnswer } from "@crewhaus/control-service";
import { quorumVoterProblem, recordQuorumVote } from "@crewhaus/deployment-controller/quorum";
import { pauseOf } from "../adapters/checkpoints";
import {
  approvalIdsOf,
  classProblem,
  expectProblem,
  noteProblem,
  refuse,
  settledProblem,
} from "./checks";
import { type ActionLine, appendAction, appendAdvisorDecision } from "./ledger";
import { planAcknowledge, planDefer } from "./overlay-acts";
import type { ActAnswer, ActDeps, ActPlan, ActRefusal, ActRequest, StartAnswer } from "./types";

export type ResolveItemRequest = ActRequest & {
  readonly choice: string;
  readonly note?: string;
};

/** The store's own time to live decides what has expired, never this call. */
const NO_TTL_DAYS = Number.MAX_SAFE_INTEGER;

const iso = (ms: number): string => new Date(ms).toISOString();

/** A decision the core refused, in the act layer's words. */
function refusalOf(answer: ResolveAnswer): ActRefusal {
  switch (answer.outcome) {
    case "forbidden":
      return refuse("forbidden", "decider", answer.reason ?? "You may not decide this.");
    case "not-found":
      return refuse("not_found", "decision_unknown", answer.reason ?? "No such decision.");
    case "invalid":
      return refuse("invalid", "invalid", answer.reason ?? "Not valid.");
    case "expired":
      return refuse("precondition_failed", "expired", "This request has expired.", {
        current: { state: "expired" },
      });
    case "stale":
      return refuse("conflict", "stale", answer.reason ?? "It changed meanwhile.");
    default:
      return refuse("already_decided", "already_decided", "This was already settled.");
  }
}

/** Record the act once the source settled it. */
async function recorded(
  request: ActRequest & { readonly choice: string },
  deps: ActDeps,
  how: AttentionResolution,
  state: AttentionState,
  cmd: string | undefined,
  extra: { readonly detail?: string; readonly job?: string } = {},
): Promise<ActAnswer> {
  const line: ActionLine = {
    state,
    event: "resolved",
    at: iso(deps.now()),
    by: await deps.decisions.storedActorOf(request.dir, request.actor),
    via: request.via,
    evidenceRev: request.item.evidenceRev,
    how,
    choice: request.choice,
    ...(cmd !== undefined ? { cmd } : {}),
  };
  const failed = await appendAction(request.dir, request.item, line);
  // The decision stands: what could not be kept is the line that says it was made here.
  return {
    ok: true,
    event: "resolved",
    state,
    ...(failed !== undefined
      ? { detail: `It is done. ${failed.message}` }
      : extra.detail !== undefined
        ? { detail: extra.detail }
        : {}),
    ...(extra.job !== undefined ? { job: extra.job } : {}),
  };
}

/** A tool request: each request the item folds is decided on its own, the same way. */
function planApproval(request: ResolveItemRequest, deps: ActDeps): ActPlan {
  const { item, choice, dir, actor, via } = request;
  const ids = approvalIdsOf(item);
  if (ids.length === 0) {
    return refuse("conflict", "not_decidable", "This item names no request to decide.");
  }
  const always = choice === "grant-always" || choice === "grant-propose";
  const manages = deps.decisions.mayManageRules(dir, actor);
  if (choice === "grant-always" && !manages) {
    return refuse("forbidden", "class", "Only the owner allows calls like it from now on.", {
      current: { requiredClass: "owner" },
    });
  }
  if (choice === "grant-propose" && manages) {
    return refuse("conflict", "owner", "You are the owner: allow it once, or from now on.");
  }
  if (always && ids.length !== 1) {
    return refuse("conflict", "several", "Several runs wait for this: allow it or refuse it.");
  }
  return {
    ok: true,
    async run(cmd) {
      const answers: ResolveAnswer[] = [];
      for (const ref of ids) {
        answers.push(
          await deps.decisions.resolve({
            harnessDir: dir,
            ref,
            choice: choice === "deny" ? "deny" : "grant",
            actor,
            via,
            ...(always ? { always: true } : {}),
            ttlDays: NO_TTL_DAYS,
          }),
        );
      }
      const decided = answers.filter((a) => a.outcome === "decided");
      if (decided.length === 0) return refusalOf(answers[0] as ResolveAnswer);
      const detail =
        decided.length < answers.length
          ? `${decided.length} of ${answers.length} requests were decided; the others were already settled.`
          : decided[0]?.ruleError !== undefined
            ? "It is allowed this once. The rule for next time could not be made."
            : undefined;
      return recorded(request, deps, "decided", "resolved", cmd, {
        ...(detail !== undefined ? { detail } : {}),
      });
    },
  };
}

/** A `dec_` decision the core settles. */
function planDecision(request: ResolveItemRequest, deps: ActDeps): ActPlan {
  const { item, choice, dir, actor, via } = request;
  if (!isId("dec", item.source.id)) {
    return refuse("conflict", "not_decidable", "This item names no decision.");
  }
  if (choice !== "grant" && choice !== "deny") {
    return refuse("conflict", "choice", "This is allowed or refused.");
  }
  return {
    ok: true,
    async run(cmd) {
      const answer = await deps.decisions.resolve({
        harnessDir: dir,
        ref: item.source.id,
        choice,
        actor,
        via,
      });
      if (answer.outcome !== "decided") return refusalOf(answer);
      return recorded(request, deps, "decided", "resolved", cmd, {
        ...(answer.ruleError !== undefined
          ? { detail: "It is granted. Its rule could not be made." }
          : {}),
      });
    },
  };
}

/** A protected environment's quorum: one person's vote, or the move it allowed. */
function planQuorum(request: ResolveItemRequest, deps: ActDeps): ActPlan {
  const { item, choice, dir, actor } = request;
  const dec = item.source.id;
  const read = readDeployQuorums(dir);
  const row = read.state === "present" ? read.rows.find((r) => r.id === dec) : undefined;
  if (row === undefined) {
    return refuse("not_found", "decision_unknown", "This approval is not recorded here any more.");
  }
  if (choice === "promote") {
    if (row.state !== "granted") {
      return refuse("conflict", "not_approved", "It does not have its approvals yet.");
    }
    if (deps.promote === undefined) {
      const twin = item.choices.find((c) => c.id === "promote")?.cliTwin;
      return refuse("unavailable", "executor_offline", "Nothing here can move it.", {
        ...(twin !== null && twin !== undefined ? { verb: twin } : {}),
      });
    }
    const promote = deps.promote;
    return {
      ok: true,
      run: (cmd) =>
        started(
          request,
          deps,
          promote({ dir, subject: row.subject, ...(cmd !== undefined ? { cmd } : {}) }),
          cmd,
        ),
    };
  }
  const who = deps.decisions.principalOf(actor, dir);
  if (who.service === true) {
    const problem = quorumVoterProblem(dir, { principal: "", service: true }, deps.now());
    return refuse("forbidden", "service", problem ?? "A person approves a deployment.");
  }
  return {
    ok: true,
    async run(cmd) {
      const principal = await deps.decisions.storedActorOf(dir, actor);
      const answer = await recordQuorumVote(dir, dec, {
        principal,
        display: deps.displayOf?.(actor) ?? principal,
        choice: choice === "deny" ? "deny" : "approve",
        now: deps.now(),
      });
      switch (answer.outcome) {
        case "recorded": {
          const ended = answer.row.state !== "pending";
          return recorded(request, deps, "decided", ended ? "resolved" : "open", cmd, {
            detail: ended
              ? answer.row.state === "granted"
                ? "It has its approvals."
                : "It is refused."
              : `${answer.counted.length} of ${answer.required} approvals are recorded.`,
          });
        }
        case "forbidden":
          return refuse("forbidden", "class", answer.reason);
        case "unavailable":
          return refuse("unavailable", "not_recorded", answer.reason);
        case "not-found":
          return refuse("not_found", "decision_unknown", "No such approval.");
        case "expired":
          return refuse("precondition_failed", "expired", "This approval has expired.", {
            current: { state: "expired" },
          });
        case "already-voted":
          return refuse("already_decided", "already_voted", "You already answered this.");
        default:
          return refuse("already_decided", "already_decided", "This was already settled.", {
            current: { state: answer.row.state },
          });
      }
    },
  };
}

/** A thing another process does now: recorded as started, the item settled by its own record. */
async function started(
  request: ResolveItemRequest,
  deps: ActDeps,
  answer: Promise<StartAnswer>,
  cmd: string | undefined,
  state: AttentionState = "open",
): Promise<ActAnswer> {
  const done = await answer;
  if (!done.ok) return done;
  return recorded(request, deps, "acted", state, cmd, {
    ...(done.detail !== undefined ? { detail: done.detail } : {}),
    ...(done.job !== undefined ? { job: done.job } : {}),
  });
}

function planReview(request: ResolveItemRequest, deps: ActDeps): ActPlan {
  const { item, choice, dir, actor, via, note } = request;
  if (choice !== "pass" && choice !== "fail" && choice !== "up" && choice !== "down") {
    return refuse("conflict", "choice", "A review is passed or failed.");
  }
  return {
    ok: true,
    async run(cmd) {
      const answer = await deps.reviewWriter({
        dir,
        id: item.source.id,
        verdict: choice,
        ...(note !== undefined ? { note } : {}),
        by: await deps.decisions.storedActorOf(dir, actor),
        via,
        nowIso: iso(deps.now()),
      });
      switch (answer.outcome) {
        case "resolved":
          return recorded(request, deps, "decided", "resolved", cmd);
        case "already-resolved":
          return refuse("already_decided", "already_decided", "This was already reviewed.");
        case "not-found":
          return refuse("not_found", "review_unknown", "No such review item.");
        default:
          return refuse("conflict", "rejected", answer.reason);
      }
    },
  };
}

function planCheckpoint(request: ResolveItemRequest, deps: ActDeps): ActPlan {
  const { item, choice, dir } = request;
  const pause = pauseOf(item.source.id);
  if (pause === undefined) {
    return refuse("conflict", "not_decidable", "This item names no paused run.");
  }
  if (choice !== "approve" && choice !== "reject") {
    return refuse("conflict", "choice", "A paused run is approved or rejected.");
  }
  const resume = deps.resumeGraph;
  if (resume === undefined) {
    const twin = item.choices.find((c) => c.id === choice)?.cliTwin;
    return refuse("unavailable", "executor_offline", "Nothing here can resume it.", {
      ...(twin !== null && twin !== undefined ? { verb: twin } : {}),
    });
  }
  return {
    ok: true,
    run: (cmd) =>
      started(
        request,
        deps,
        resume({ dir, ...pause, decision: choice, ...(cmd !== undefined ? { cmd } : {}) }),
        cmd,
      ),
  };
}

function planAdvisor(request: ResolveItemRequest, deps: ActDeps): ActPlan {
  const { item, dir, via, actor } = request;
  const act = deps.advisorAct;
  if (act === undefined) {
    const twin = item.choices.find((c) => c.id === "act")?.cliTwin;
    return refuse("unavailable", "executor_offline", "Nothing here can start it.", {
      ...(twin !== null && twin !== undefined ? { verb: twin } : {}),
    });
  }
  return {
    ok: true,
    async run(cmd) {
      const done = await act({
        dir,
        itemId: item.source.id,
        ...(cmd !== undefined ? { cmd } : {}),
      });
      if (!done.ok) return done;
      const failed = appendAdvisorDecision(dir, {
        itemId: item.source.id,
        action: "acted",
        at: iso(deps.now()),
        by: await deps.decisions.storedActorOf(dir, actor),
        via,
        evidenceRev: item.evidenceRev,
        ...(done.job !== undefined ? { jobId: done.job } : {}),
        ...(cmd !== undefined ? { cmd } : {}),
      });
      return recorded(request, deps, "acted", "open", cmd, {
        ...(failed !== undefined
          ? { detail: failed.message }
          : done.detail !== undefined
            ? { detail: done.detail }
            : {}),
        ...(done.job !== undefined ? { job: done.job } : {}),
      });
    },
  };
}

/** Put a budget off until its period renews: the time is the record's, never a person's. */
function planWaitForRenewal(request: ResolveItemRequest, deps: ActDeps): ActPlan {
  const read = readBudgetState(request.dir);
  if (read.state !== "present") {
    return refuse(
      "conflict",
      "no_renewal",
      read.state === "absent"
        ? "This budget does not renew on its own. Raise it, or acknowledge this."
        : "The budget's record can't be read, so nothing says when it renews.",
    );
  }
  return planDefer({ ...request, until: read.record.renewsAt, reason: "scheduled" }, deps, {
    event: "resolved",
    choice: request.choice,
    how: "acted",
  });
}

/**
 * Plan a verdict on an item. Reads only: a refusal has written nothing.
 *
 * First consumers: `attention.resolve` and `crewhaus inbox decide`.
 */
export function planResolve(request: ResolveItemRequest, deps: ActDeps): ActPlan {
  const { item, choice } = request;
  if (item.kind === "question") {
    return refuse("conflict", "question", "A question is answered, not allowed or refused.");
  }
  const settled = settledProblem(item);
  if (settled !== undefined) return settled;
  const stale = expectProblem(request) ?? noteProblem(request.note);
  if (stale !== undefined) return stale;
  if (request.note !== undefined && item.source.kind !== "review") {
    return refuse("invalid", "note", "A note is kept with a review. Add it to the discussion.");
  }
  const does = attentionChoiceDoes(item.kind, choice);
  if (does === undefined || does === "open" || !item.choices.some((c) => c.id === choice)) {
    return refuse("conflict", "choice", "This item does not offer that choice.", {
      current: { choices: item.choices.map((c) => c.id) },
    });
  }
  const offered = item.choices.find((c) => c.id === choice);
  const unreached = classProblem(request, offered?.needs ?? item.requiredClass, deps);
  if (unreached !== undefined) return unreached;
  switch (item.source.kind) {
    case "approval":
      return planApproval(request, deps);
    case "decision":
      return item.kind === "deploy-approval"
        ? planQuorum(request, deps)
        : planDecision(request, deps);
    case "review":
      return planReview(request, deps);
    case "checkpoint":
      return planCheckpoint(request, deps);
    case "advisor":
      return choice === "act"
        ? planAdvisor(request, deps)
        : refuse("conflict", "choice", "This item does not offer that choice.");
    default:
      if (choice === "wait-for-renewal") return planWaitForRenewal(request, deps);
      return planAcknowledge(request, deps, { event: "resolved", choice });
  }
}

/** Plan and carry out a verdict. */
export async function resolveItem(
  request: ResolveItemRequest,
  deps: ActDeps,
  cmd?: string,
): Promise<ActAnswer> {
  const plan = planResolve(request, deps);
  return plan.ok ? plan.run(cmd) : plan;
}
