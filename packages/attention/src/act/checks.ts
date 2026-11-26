/**
 * What every act checks before it writes anything: that the item still is what the person
 * read, that it can be acted on, and that they reach the class it needs. A check that
 * passes here is not authority: the decision service decides again as it writes.
 */
import { decideClassOf, loadAccessSnapshot } from "@crewhaus/access-control";
import {
  APPROVAL_ID_RE,
  ATTENTION_NOTE_MAX_BYTES,
  type AttentionItem,
  type DecisionClass,
  classAllows,
  memberMayDecide,
} from "@crewhaus/control-contract";
import { createApproverReader } from "@crewhaus/control-records";
import type { ActDeps, ActRefusal, ActRequest } from "./types";

const OPEN_STATES: ReadonlySet<string> = new Set(["open", "assigned", "deferred"]);

/** Whether an item still waits for someone. */
export const isOpen = (item: Pick<AttentionItem, "state">): boolean => OPEN_STATES.has(item.state);

/** The requests an item folds, by the decision each piece of its evidence names. */
export function approvalIdsOf(item: Pick<AttentionItem, "evidence">): string[] {
  return item.evidence
    .map((e) => e.ref.slice(e.ref.lastIndexOf("/") + 1))
    .filter((id) => APPROVAL_ID_RE.test(id));
}

export const refuse = (
  code: ActRefusal["code"],
  reason: string,
  message: string,
  extra: Partial<ActRefusal> = {},
): ActRefusal => ({ ok: false, code, reason, message, ...extra });

/** The item no longer is what the person read: 412, with what it is now. */
export function expectProblem(request: ActRequest): ActRefusal | undefined {
  const { expect, item } = request;
  if (expect === undefined || expect === item.state || expect === item.evidenceRev)
    return undefined;
  return refuse(
    "precondition_failed",
    "expect",
    "This has changed since you read it. Read it again, then decide.",
    { current: { state: item.state, evidenceRev: item.evidenceRev } },
  );
}

export function settledProblem(item: AttentionItem): ActRefusal | undefined {
  if (isOpen(item)) return undefined;
  return refuse("already_decided", "already_decided", "This was already settled.", {
    current: {
      state: item.state,
      ...(item.resolution !== undefined ? { resolution: { ...item.resolution } } : {}),
    },
  });
}

/** Why a note is not one, or `undefined`: a few words, counted in bytes. */
export function noteProblem(note: string | undefined): ActRefusal | undefined {
  return note === undefined || Buffer.byteLength(note, "utf8") <= ATTENTION_NOTE_MAX_BYTES
    ? undefined
    : refuse("invalid", "note", "A note holds at most 2 KiB.");
}

const CLASS_WORD: Readonly<Record<DecisionClass, string>> = {
  operator: "an operator",
  maintainer: "a maintainer",
  owner: "the owner",
};

/** Why the actor does not reach a class here, or `undefined`. */
export function classProblem(
  request: Pick<ActRequest, "dir" | "actor">,
  needs: DecisionClass,
  deps: Pick<ActDeps, "decisions" | "now">,
): ActRefusal | undefined {
  const who = deps.decisions.principalOf(request.actor, request.dir);
  const read = createApproverReader()(request.dir);
  if (read.state === "absent") {
    // A single owner's harness: every person decides everything, and no service does.
    return who.service === true && needs !== "operator"
      ? refuse("forbidden", "class", `This needs ${CLASS_WORD[needs]}, a person.`)
      : undefined;
  }
  if (read.state === "unreadable") {
    return refuse(
      "authorization_unavailable",
      "approvers_unreadable",
      `This harness's list of who may approve cannot be read (${read.reason}).`,
      { verb: "crewhaus access sync" },
    );
  }
  if (
    who.principal !== undefined &&
    !(who.service === true && needs !== "operator") &&
    memberMayDecide(read.projection, who.principal, needs, deps.now())
  ) {
    return undefined;
  }
  return refuse("forbidden", "class", `This needs ${CLASS_WORD[needs]}.`, {
    current: { requiredClass: needs },
  });
}

/**
 * The highest class the actor reaches here, or `null` for none: what {@link classProblem}
 * would allow, for a reader who shows it. Reads only.
 *
 * First consumer: Home's inbox list, which says what its reader may do.
 */
export function classReached(
  request: Pick<ActRequest, "dir" | "actor">,
  deps: Pick<ActDeps, "decisions" | "now">,
): DecisionClass | null {
  for (const needs of ["owner", "maintainer", "operator"] as const) {
    if (classProblem(request, needs, deps) === undefined) return needs;
  }
  return null;
}

/**
 * Why this member may not be given a class of work here, or `undefined`: Home's access
 * records say which members decide on the harness, and at which class. A service is given
 * none.
 */
export function assigneeProblem(
  principal: string,
  needs: DecisionClass,
  deps: Pick<ActDeps, "members" | "now">,
): ActRefusal | undefined {
  const none = refuse(
    "conflict",
    "assignee_class",
    "This harness has no members to assign to yet.",
    { current: { requiredClass: needs } },
  );
  if (deps.members === undefined) return none;
  const read = loadAccessSnapshot(deps.members.hangarRoot);
  if (read.state === "absent") return none;
  if (read.state === "unreadable") {
    return refuse(
      "authorization_unavailable",
      "access_unreadable",
      `Home's access records cannot be read (${read.reason}).`,
    );
  }
  const { snapshot } = read;
  const row = snapshot.principals.find((p) => p.id === principal);
  const held =
    row?.kind === "member"
      ? decideClassOf(snapshot, principal, deps.members.harness, deps.now())
      : null;
  if (held !== null && classAllows(held, needs)) return undefined;
  return refuse(
    "conflict",
    "assignee_class",
    `That member does not decide here at this class. It needs ${CLASS_WORD[needs]}.`,
    { current: { requiredClass: needs } },
  );
}
