/** The v1 error envelope and its closed codes. Legacy routes keep their own `{error}`. */
import { deepFreeze } from "./util.js";

export const ERROR_CODES = deepFreeze({
  unauthenticated: { statuses: [401], retryable: false },
  forbidden: { statuses: [403], retryable: false },
  authorization_unavailable: { statuses: [403], retryable: false },
  not_found: { statuses: [404], retryable: false },
  invalid: { statuses: [400, 422], retryable: false },
  conflict: { statuses: [409], retryable: false },
  already_decided: { statuses: [409], retryable: false },
  precondition_failed: { statuses: [412], retryable: false },
  idempotency_key_reused: { statuses: [422], retryable: false },
  input_blocked: { statuses: [422], retryable: false },
  unsupported: { statuses: [501], retryable: false },
  unsupported_protocol: { statuses: [400], retryable: false },
  paused: { statuses: [503], retryable: true },
  disabled: { statuses: [503], retryable: false },
  unavailable: { statuses: [503], retryable: true },
  rate_limited: { statuses: [429], retryable: true },
  internal: { statuses: [500], retryable: false },
} as const);

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

export type ErrorBody = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** The object's present state, on a conflict. */
  readonly current?: unknown;
  /** The missing permission. */
  readonly needs?: string;
  readonly role?: string;
  /** A real CLI command that does the same thing. Absent when there is none. */
  readonly verb?: string;
  readonly reason?: string;
  readonly remedy?: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type ErrorEnvelope = { readonly error: ErrorBody };
