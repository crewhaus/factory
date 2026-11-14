/**
 * The versioned API's one error envelope (`errorEnvelope` in control-contract):
 * `{error: {code, message, retryable, …}}`, with what was missing (`needs`), the role the
 * caller has there (`role`), a reason code (`reason`), a real CLI command that does the
 * same (`verb`, never a manufactured one), what to do (`remedy`) and the object's present
 * state on a conflict (`current`). The legacy routes keep their own `{error}`.
 */
import { ERROR_CODES, type ErrorCode } from "@crewhaus/control-contract";
import { json } from "../http";

export type V1ErrorInput = {
  readonly status: number;
  readonly code: ErrorCode | string;
  readonly message: string;
  readonly reason?: string;
  readonly needs?: string;
  readonly role?: string | null;
  readonly verb?: string;
  readonly remedy?: string;
  readonly current?: unknown;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
};

function retryableOf(code: string, status: number): boolean {
  return Object.hasOwn(ERROR_CODES, code)
    ? ERROR_CODES[code as ErrorCode].retryable
    : status === 503;
}

/** The envelope as a value, for a caller that masks it first. */
export function v1ErrorBody(input: V1ErrorInput): { readonly error: Record<string, unknown> } {
  return {
    error: {
      code: input.code,
      message: input.message,
      retryable: retryableOf(String(input.code), input.status),
      ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.needs !== undefined ? { needs: input.needs } : {}),
      ...(input.role !== undefined && input.role !== null ? { role: input.role } : {}),
      ...(input.verb !== undefined ? { verb: input.verb } : {}),
      ...(input.remedy !== undefined ? { remedy: input.remedy } : {}),
      ...(input.current !== undefined ? { current: input.current } : {}),
      // The reason, needs and role are also kept under `details` for one release.
      details: {
        ...(input.details ?? {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.needs !== undefined ? { needs: input.needs } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
      },
    },
  };
}

/** An error answer in the v1 envelope. */
export function v1Error(input: V1ErrorInput, headers: Record<string, string> = {}): Response {
  return json(v1ErrorBody(input), input.status, {
    ...(input.status === 401 ? { "www-authenticate": "Bearer" } : {}),
    ...(input.retryAfterMs !== undefined
      ? { "retry-after": String(Math.max(1, Math.ceil(input.retryAfterMs / 1000))) }
      : {}),
    ...headers,
  });
}

/** A handler's way to stop with a v1 error: the router answers it in the envelope. */
export class V1Error extends Error {
  readonly input: V1ErrorInput;
  constructor(input: V1ErrorInput) {
    super(input.message);
    this.input = input;
  }
}
