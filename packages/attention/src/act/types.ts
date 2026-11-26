/**
 * The shapes the act layer works in: what a head lends it (the decision service, and its
 * own writers for what another package owns), what an act asks, and how it answers. An act
 * is planned first, reading only, and carried out second: a plan that refuses has written
 * nothing, so a caller writes its receipt only for an act that runs.
 */
import type { AccessHarness } from "@crewhaus/access-control";
import type {
  AttentionActionEvent,
  AttentionItem,
  AttentionState,
  DeployQuorumSubject,
  ErrorCode,
  ReceiptVia,
} from "@crewhaus/control-contract";
import type { DecisionActor, Decisions } from "@crewhaus/control-service";

/** Why an act was refused, in the API's words. */
export type ActRefusal = {
  readonly ok: false;
  readonly code: ErrorCode;
  /** A closed reason. */
  readonly reason: string;
  readonly message: string;
  /** The item as it stands, when the refusal is about it. */
  readonly current?: Readonly<Record<string, unknown>>;
  /** The command that does what was refused, when one does. */
  readonly verb?: string;
  /** The permission that is missing. */
  readonly needs?: string;
};

export type ActDone = {
  readonly ok: true;
  readonly event: AttentionActionEvent;
  /** The item's state as the act leaves it. */
  readonly state: AttentionState;
  /** What else happened, as a closed sentence. */
  readonly detail?: string;
  /** The job it queued. */
  readonly job?: string;
};

export type ActAnswer = ActDone | ActRefusal;

/** A planned act: refused, or ready. `cmd` is the receipt it runs under. */
export type ActPlan = ActRefusal | { readonly ok: true; run(cmd?: string): Promise<ActAnswer> };

/** What settling a review entry through a head's own writer answers. */
export type ReviewAnswer =
  | { readonly outcome: "resolved" }
  | { readonly outcome: "already-resolved" }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "rejected"; readonly reason: string };

/** A thing a head starts on an item's behalf (a job, a build), or why it did not. */
export type StartAnswer =
  | { readonly ok: true; readonly job?: string; readonly detail?: string }
  | ActRefusal;

export type ActDeps = {
  readonly decisions: Decisions;
  readonly now: () => number;
  /** Settle a review entry, claimed, with the adjudicating rating when the verdict is one. */
  readonly reviewWriter: (request: {
    readonly dir: string;
    readonly id: string;
    readonly verdict: "pass" | "fail" | "up" | "down";
    readonly note?: string;
    readonly by: string;
    readonly via: ReceiptVia;
    readonly nowIso: string;
  }) => Promise<ReviewAnswer>;
  /** Start an Advisor finding's own closed job. Absent: this head starts none. */
  readonly advisorAct?: (request: {
    readonly dir: string;
    readonly itemId: string;
    readonly cmd?: string;
  }) => Promise<StartAnswer>;
  /** Resume a paused graph run with one of the two words. Absent: this head starts none. */
  readonly resumeGraph?: (request: {
    readonly dir: string;
    readonly grun: string;
    readonly ckpt: string;
    readonly decision: "approve" | "reject";
    readonly cmd?: string;
  }) => Promise<StartAnswer>;
  /** Move an approved version where it was approved for. Absent: this head starts none. */
  readonly promote?: (request: {
    readonly dir: string;
    readonly subject: DeployQuorumSubject;
    readonly cmd?: string;
  }) => Promise<StartAnswer>;
  /**
   * Where Home keeps who its members are, and the harness as those records name it. Absent:
   * nobody can be assigned anything here.
   */
  readonly members?: { readonly hangarRoot: string; readonly harness: AccessHarness };
  /** The actor's name as the approvals file shows it. */
  readonly displayOf?: (actor: DecisionActor) => string;
};

/** What every act names. */
export type ActRequest = {
  /** The harness it is acted on in. */
  readonly dir: string;
  /** The item as it was just read. */
  readonly item: AttentionItem;
  readonly actor: DecisionActor;
  readonly via: ReceiptVia;
  /** The item's state or evidence revision when the person read it. */
  readonly expect?: string;
};
