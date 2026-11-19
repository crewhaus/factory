/**
 * What a work item reads as now: one pure function, so Home, the CLI and the tools say the
 * same word. Precedence runs top to bottom and the first row that applies wins:
 *
 * | Condition | Status |
 * |---|---|
 * | closed with a pull-request outcome | merged · closed-unmerged · reverted |
 * | closed otherwise | done · declined · cancelled · superseded · failed |
 * | a linked run waits for approval / for input | waiting-approval · needs-input |
 * | a linked run is preparing or running | working |
 * | a delivered pull request is open | in-review · changes-requested |
 * | the last publish attempt failed or did not finish | publish-unfinished |
 * | the last linked run was interrupted, and no newer run exists | interrupted |
 * | the harness is disabled / paused / out of budget | disabled · paused · waiting-budget |
 * | proposed | proposed |
 * | open with a queued run | queued |
 * | open | up-next |
 *
 * The pull-request and publish facts are optional: nothing fills them until work is
 * delivered as pull requests.
 */
import type { WorkCloseOutcome, WorkState, WorkStatus } from "@crewhaus/control-contract";

export type WorkStateFacts = {
  readonly state: WorkState;
  readonly outcome?: WorkCloseOutcome;
  /** The linked runs' newest states, oldest run first. */
  readonly runs?: readonly string[];
  readonly pr?: {
    readonly state: "open" | "merged" | "closed";
    readonly review?: "approved" | "changes_requested";
    readonly reverted?: boolean;
  };
  readonly publish?: "started" | "pushed" | "done" | "failed" | "unknown" | "not-done";
  readonly harness?: {
    readonly paused?: boolean;
    readonly disabled?: boolean;
    readonly budgetExhausted?: boolean;
  };
};

/** Each status in words, as a person reads it. Never colour alone. */
export const WORK_STATUS_WORDS: Readonly<Record<WorkStatus, string>> = Object.freeze({
  merged: "Merged",
  "closed-unmerged": "Closed without merging",
  reverted: "Reverted",
  done: "Done",
  declined: "Declined",
  cancelled: "Cancelled",
  superseded: "Superseded",
  failed: "Failed",
  "waiting-approval": "Waiting for approval",
  "needs-input": "Needs your input",
  working: "Working",
  "in-review": "In review",
  "changes-requested": "Changes requested",
  "publish-unfinished": "Publish didn't finish",
  interrupted: "Interrupted",
  paused: "Paused",
  disabled: "Disabled",
  "waiting-budget": "Waiting for budget",
  proposed: "Proposed",
  queued: "Queued",
  "up-next": "Up next",
});

/** The status an item reads as, by the precedence above. Pure. */
export function effectiveWorkState(facts: WorkStateFacts): WorkStatus {
  const runs = facts.runs ?? [];
  if (facts.state === "closed") {
    if (facts.pr !== undefined && facts.pr.state !== "open") {
      if (facts.pr.reverted === true) return "reverted";
      return facts.pr.state === "merged" ? "merged" : "closed-unmerged";
    }
    return facts.outcome ?? "done";
  }
  if (runs.includes("waiting-for-approval")) return "waiting-approval";
  if (runs.includes("waiting-for-input")) return "needs-input";
  if (runs.includes("preparing") || runs.includes("running")) return "working";
  if (facts.pr?.state === "open") {
    return facts.pr.review === "changes_requested" ? "changes-requested" : "in-review";
  }
  if (facts.publish === "failed" || facts.publish === "not-done") return "publish-unfinished";
  if (runs.at(-1) === "interrupted") return "interrupted";
  if (facts.harness?.disabled === true) return "disabled";
  if (facts.harness?.paused === true) return "paused";
  if (facts.harness?.budgetExhausted === true) return "waiting-budget";
  if (facts.state === "proposed") return "proposed";
  if (runs.includes("queued")) return "queued";
  return "up-next";
}

/** The status and its words, as a view carries them. */
export function statusOf(facts: WorkStateFacts): {
  readonly status: WorkStatus;
  readonly statusWord: string;
} {
  const status = effectiveWorkState(facts);
  return { status, statusWord: WORK_STATUS_WORDS[status] };
}
