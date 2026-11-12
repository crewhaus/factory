/**
 * What a command answers when it is refused before it is accepted, and the fixed words a
 * receipt's outcome carries. A receipt never quotes a handler's or a process's own text:
 * each outcome code has one sentence, so a receipt stays content-free.
 */
import type { CommandReceipt, ErrorCode } from "@crewhaus/control-contract";
import type { LeaseHolder } from "@crewhaus/control-records";

/** Refused before acceptance: nothing was written. */
export type ControlRefusal = {
  readonly code: ErrorCode;
  readonly message: string;
  /** The receipt as it stands, when the refusal is about one. */
  readonly current?: CommandReceipt;
  /** Who holds what the command needed. */
  readonly holder?: LeaseHolder;
};

export function refuse(code: ErrorCode, message: string): ControlRefusal {
  return { code, message };
}

/** The closed codes an outcome may carry: the error codes, plus two the core settles. */
export type OutcomeCode = ErrorCode | "interrupted" | "cancelled";

export type Outcome = { readonly code: OutcomeCode; readonly message: string };

/** One sentence per error code, for a receipt that was refused or failed after acceptance. */
export const OUTCOME_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  unauthenticated: "refused: not signed in",
  forbidden: "refused: not allowed",
  authorization_unavailable: "refused: who may do this could not be checked",
  not_found: "refused: what it names does not exist",
  invalid: "refused: the request was not valid",
  conflict: "refused: the harness is not in a state that allows it",
  already_decided: "refused: it was already decided",
  precondition_failed: "refused: a check before it ran did not pass",
  idempotency_key_reused: "refused: the idempotency key was used for another request",
  input_blocked: "refused: the input was blocked",
  unsupported: "refused: not supported here",
  unsupported_protocol: "refused: the protocol is not supported",
  paused: "refused: the harness is paused",
  disabled: "refused: the harness is disabled",
  unavailable: "not done: it could not be reached, try again later",
  rate_limited: "not done: too many requests, try again later",
  internal: "not done: it stopped with an error",
});

export function outcomeOf(code: ErrorCode): Outcome {
  return { code, message: OUTCOME_MESSAGES[code] };
}

/** Recovery could not tell whether the effect happened: a person decides. */
export const NEEDS_DECISION: Outcome = Object.freeze({
  code: "interrupted",
  message: "interrupted, needs a decision",
});

/** A daemon start accepted before the machine last booted: only the resident service restarts one. */
export const NOT_STARTED_REBOOT: Outcome = Object.freeze({
  code: "interrupted",
  message: "not started: the machine restarted",
});

/** A daemon command another daemon command on the same harness overtook: never run again. */
export const SUPERSEDED: Outcome = Object.freeze({
  code: "interrupted",
  message: "superseded by a later command",
});

/** A read-only job whose manager stopped while it ran. */
export const JOB_INTERRUPTED: Outcome = Object.freeze({
  code: "interrupted",
  message: "interrupted: Home stopped while it ran",
});

/** A job cancelled before or while it ran. */
export const CANCELLED: Outcome = Object.freeze({
  code: "cancelled",
  message: "cancelled",
});
