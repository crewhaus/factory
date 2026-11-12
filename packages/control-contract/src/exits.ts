/**
 * How a control-plane refusal ends a CLI process: the band 50-56 of
 * `@crewhaus/errors`' `EXIT_CODES`. This entry imports no package, so the numbers
 * are written here and a test in the control service holds them to that table.
 * `disabled` and `paused` end with 38 and 39, the operator-state codes.
 */
import type { ErrorCode } from "./errors.js";
import { deepFreeze } from "./util.js";

/** The exit for every error code. Total: a code with no exit fails to compile. */
export const EXIT_FOR_ERROR: Readonly<Record<ErrorCode, number>> = deepFreeze({
  unauthenticated: 50,
  forbidden: 51,
  authorization_unavailable: 51,
  unavailable: 52,
  rate_limited: 52,
  conflict: 53,
  already_decided: 53,
  precondition_failed: 53,
  idempotency_key_reused: 53,
  unsupported: 54,
  unsupported_protocol: 54,
  invalid: 55,
  input_blocked: 55,
  not_found: 56,
  disabled: 38,
  paused: 39,
  internal: 1,
});

/** The exit for a command whose receipt ended `rejected`: a precondition refused it. */
export const EXIT_FOR_REJECTED_RECEIPT = 55;
