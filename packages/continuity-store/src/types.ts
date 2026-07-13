/**
 * Shared record types for the continuity store (design §2.2/§2.4).
 * Split from index.ts so the pure handoff renderer can import them without a
 * module cycle.
 */
import type { FrozenProof } from "./evidence";

/** The proof ladder (design §2.4). `claimed` is always free to record;
 *  `proven` is earned only through `verifyEvidence`. */
export type LadderStatus = "open" | "in_progress" | "claimed" | "proven";

/** Ladder statuses a caller may set WITHOUT evidence — everything below
 *  `proven`. */
export type ClaimableStatus = "open" | "in_progress" | "claimed";

export type RequirementStatus = "open" | "confirmed" | "dropped";

/** One `REQ-nnn` requirements-ledger entry (design §2.2/§2.3): the user's
 *  words VERBATIM — there is deliberately no paraphrase field — plus the
 *  session/turn attribution rendered as `(user, sess_…, turn N)`. */
export type Requirement = {
  readonly id: string;
  readonly text: string;
  readonly status: RequirementStatus;
  readonly source: { readonly sessionId: string; readonly turn: number };
};

export type PlanStep = {
  /** 1-based position in the plan. */
  readonly index: number;
  readonly text: string;
  readonly status: LadderStatus;
  /** Frozen proof excerpts accumulated by `proven` transitions. Retained
   *  even if the step is later reopened — history, not status. */
  readonly proofs: readonly FrozenProof[];
};

export type PlanRecord = {
  /** `plan-NNNN`. */
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly steps: readonly PlanStep[];
};

/** One `goals.yaml` entry — the local mirror of Thredz goals (design §2.2):
 *  `{id, title, status, target?, current?, unit?}` plus bookkeeping. */
export type Goal = {
  /** `goal-NNNN`. */
  readonly id: string;
  readonly title: string;
  readonly status: LadderStatus;
  readonly target?: number;
  readonly current?: number;
  readonly unit?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly proofs?: readonly FrozenProof[];
};

/** Parsed managed `focus.md` state. */
export type FocusState = {
  /** The mutable focus body (may be empty). */
  readonly body: string;
  /** The active plan pointer, or null. */
  readonly activePlanId: string | null;
  readonly requirements: readonly Requirement[];
  /** True when the requirements ledger evicted oldest entries to stay under
   *  its byte cap (a `[ledger truncated]` marker is rendered in the file). */
  readonly ledgerTruncated: boolean;
};
