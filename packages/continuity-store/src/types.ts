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

/**
 * 0.8.0 (design/0.8.0-provability-release.md §6.3) — a cited evidence ref
 * recorded WITHOUT being resolved: what a `proven` transition writes under
 * `continuity.proof: off`, the mode for harnesses that keep no session event
 * log to resolve against. It is the model's citation and nothing more — no
 * tool name, no input hash, no result digest, because nothing was read — so
 * it lives beside {@link FrozenProof}s, never among them: every reader that
 * shape-checks `proofs` keeps treating those as machine-checked, and no
 * session an unverified ref names is ever pinned for retention.
 */
export type UnverifiedRef = {
  readonly toolUseId: string;
  /** The session the caller said the call ran in, when one was known. */
  readonly sessionId?: string;
  readonly recordedAt: string;
};

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
  /** The refs cited for the step's current proof when that proof skipped
   *  verification (`continuity.proof: off`): the ones the step was proven
   *  by assertion with, plus any cited while it stayed so. Present and
   *  non-empty on a `proven` step means proven BY ASSERTION, and renderers
   *  say so ({@link renderLadderStatus}). A verified transition clears it.
   *  A step reopened afterwards keeps the list until its next proof, which
   *  replaces it. Absent on every record written by the ladder, so those
   *  bytes are unchanged. */
  readonly unverified?: readonly UnverifiedRef[];
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
  /** See {@link PlanStep.unverified} — same meaning for a goal. */
  readonly unverified?: readonly UnverifiedRef[];
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
