/**
 * Who may make which move on a work item, as data the store enforces and a test reads as a
 * table. The machine says which moves exist; this says who may make them.
 *
 * The harness (its tools) proposes, adds notes, links its run, delivers and closes an
 * accepted item as done, failed or superseded with a reason. It never accepts, declines or
 * cancels, never edits an item it did not propose or one already accepted, and never
 * claims an operator's or an API caller's source. Only a person accepts, declines and
 * corrects the ranking. The system accepts only under the owner's accept policy, and
 * reopens only under the pull request tracker's rule ({@link OUTCOME_RULE}): an item the
 * tracker itself closed because its pull request was closed, when that pull request is
 * reopened. Every other reopen is a person's.
 */
import type { WorkCloseOutcome, WorkSourceKind } from "@crewhaus/control-contract";
import type { WorkActorRole } from "./records";

export type WorkMove =
  | "open"
  | "propose"
  | "accept"
  | "decline"
  | "cancel"
  | "reopen"
  | "edit"
  | "note"
  | "link"
  | "deliver"
  | "close"
  | "rank";

/** The roles that may make each move. A move no row lists for a role is refused. */
export const WORK_ACTOR_RULES: Readonly<Record<WorkMove, readonly WorkActorRole[]>> = Object.freeze(
  {
    open: Object.freeze(["person", "service"] as const),
    propose: Object.freeze(["person", "service", "harness", "system"] as const),
    accept: Object.freeze(["person", "system"] as const),
    decline: Object.freeze(["person"] as const),
    cancel: Object.freeze(["person", "service"] as const),
    reopen: Object.freeze(["person", "system"] as const),
    edit: Object.freeze(["person", "service", "harness"] as const),
    note: Object.freeze(["person", "service", "harness"] as const),
    link: Object.freeze(["person", "service", "harness", "system"] as const),
    deliver: Object.freeze(["person", "service", "harness", "system"] as const),
    close: Object.freeze(["person", "service", "harness", "system"] as const),
    rank: Object.freeze(["person"] as const),
  },
);

/** The sources the harness may name for its own proposals. */
export const HARNESS_SOURCE_KINDS: readonly WorkSourceKind[] = Object.freeze([
  "agent",
  "schedule",
  "github-issue",
  "channel",
  "continuity-goal",
]);

/** How the harness may close an accepted item: each needs a reason. */
export const HARNESS_CLOSE_OUTCOMES: readonly WorkCloseOutcome[] = Object.freeze([
  "done",
  "failed",
  "superseded",
]);

/** The rule a system acceptance is recorded under. */
export const ACCEPT_RULE = "tool_config.work.accept";

/** The rule the pull request tracker closes and reopens an item under. */
export const OUTCOME_RULE = "work.outcomes";

/** The actor the pull request tracker writes as. */
export const OUTCOME_ACTOR = "sys:outcomes";

/** The reason the tracker closes an open item whose pull request was closed unmerged. */
export const PR_CLOSED_REASON = "pr-closed";

/** Whether a role may make a move at all. */
export function mayMove(role: WorkActorRole, move: WorkMove): boolean {
  return WORK_ACTOR_RULES[move].includes(role);
}
