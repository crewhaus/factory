/**
 * Catalog R16 `gateway-protocol` — wire contract for the managed-daemon
 * gateway.
 *
 * Every request and response is wrapped in a versioned envelope so
 * future protocol revisions can fan out on `protocol`. v1 carries:
 *
 *   { protocol: "crewhaus.v1", id: <opaque>, method: <string>, params: <obj> }
 *
 * All schemas are exported as Zod runtime validators; the inferred
 * types are the canonical TS API. Reference clients (TS, Python) ship
 * alongside this package — see `clients/` for snippets external app
 * servers can paste into their own build.
 *
 * Methods (v1):
 *   runs.create        — start a new run, return runId
 *   runs.continue      — append a user turn to an existing session
 *   runs.cancel        — abort an in-flight run
 *   runs.subscribe     — SSE stream of trace events for a runId
 *   sessions.list      — list per-tenant sessions
 *   sessions.fork      — branch a session at a specific event
 *   audit.tail         — stream the per-tenant audit log
 *
 * Layer R16. Pairs with `gateway-server` (R16 — Bun.serve daemon) and
 * `target-managed` (F2 — codegen).
 */

import { CrewhausError } from "@crewhaus/errors";
import { z } from "zod";

export const PROTOCOL_VERSION = "crewhaus.v1" as const;

export class GatewayProtocolError extends CrewhausError {
  override readonly name = "GatewayProtocolError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

const protocolField = z.literal(PROTOCOL_VERSION);

const requestEnvelope = z
  .object({
    protocol: protocolField,
    id: z.string().min(1),
    method: z.string().min(1),
    params: z.unknown(),
  })
  .strict();

const successEnvelope = z
  .object({
    protocol: protocolField,
    id: z.string().min(1),
    result: z.unknown(),
  })
  .strict();

const errorEnvelope = z
  .object({
    protocol: protocolField,
    id: z.string().min(1),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

export const ResponseEnvelope = z.union([successEnvelope, errorEnvelope]);
export const RequestEnvelope = requestEnvelope;
export type RequestEnvelopeT = z.infer<typeof RequestEnvelope>;
export type ResponseEnvelopeT = z.infer<typeof ResponseEnvelope>;

// ---------------------------------------------------------------------------
// Method-specific schemas.
// ---------------------------------------------------------------------------

export const RunsCreateParams = z
  .object({
    spec: z.string().min(1),
    input: z.string(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();
export const RunsCreateResult = z
  .object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    tenantId: z.string().min(1),
  })
  .strict();
export type RunsCreateParamsT = z.infer<typeof RunsCreateParams>;
export type RunsCreateResultT = z.infer<typeof RunsCreateResult>;

export const RunsContinueParams = z
  .object({
    sessionId: z.string().min(1),
    input: z.string(),
  })
  .strict();
export const RunsContinueResult = z
  .object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    tenantId: z.string().min(1),
  })
  .strict();
export type RunsContinueParamsT = z.infer<typeof RunsContinueParams>;
export type RunsContinueResultT = z.infer<typeof RunsContinueResult>;

export const RunsCancelParams = z.object({ runId: z.string().min(1) }).strict();
export const RunsCancelResult = z.object({ ok: z.boolean() }).strict();
export type RunsCancelParamsT = z.infer<typeof RunsCancelParams>;
export type RunsCancelResultT = z.infer<typeof RunsCancelResult>;

export const RunsSubscribeParams = z.object({ runId: z.string().min(1) }).strict();
export type RunsSubscribeParamsT = z.infer<typeof RunsSubscribeParams>;

export const SessionsListParams = z.object({}).strict();
export const SessionsListResult = z
  .object({
    sessions: z.array(
      z
        .object({
          id: z.string().min(1),
          tenantId: z.string().min(1),
          updatedAt: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type SessionsListParamsT = z.infer<typeof SessionsListParams>;
export type SessionsListResultT = z.infer<typeof SessionsListResult>;

export const SessionsForkParams = z
  .object({ sessionId: z.string().min(1), atEventTs: z.number().int().nonnegative() })
  .strict();
export const SessionsForkResult = z.object({ newSessionId: z.string().min(1) }).strict();
export type SessionsForkParamsT = z.infer<typeof SessionsForkParams>;
export type SessionsForkResultT = z.infer<typeof SessionsForkResult>;

export const AuditTailParams = z
  .object({ tenantId: z.string().min(1), sinceTs: z.number().int().nonnegative().optional() })
  .strict();
export type AuditTailParamsT = z.infer<typeof AuditTailParams>;

export const Method = z.enum([
  "runs.create",
  "runs.continue",
  "runs.cancel",
  "runs.subscribe",
  "sessions.list",
  "sessions.fork",
  "audit.tail",
]);
export type MethodT = z.infer<typeof Method>;

const PARAM_SCHEMAS: Record<MethodT, z.ZodType<unknown>> = {
  "runs.create": RunsCreateParams,
  "runs.continue": RunsContinueParams,
  "runs.cancel": RunsCancelParams,
  "runs.subscribe": RunsSubscribeParams,
  "sessions.list": SessionsListParams,
  "sessions.fork": SessionsForkParams,
  "audit.tail": AuditTailParams,
};

export function decodeRequest(raw: unknown): RequestEnvelopeT & { method: MethodT } {
  const parsed = RequestEnvelope.safeParse(raw);
  if (!parsed.success) {
    throw new GatewayProtocolError(
      `invalid envelope: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const m = Method.safeParse(parsed.data.method);
  if (!m.success) {
    throw new GatewayProtocolError(`unknown method "${parsed.data.method}"`);
  }
  const paramSchema = PARAM_SCHEMAS[m.data];
  const params = paramSchema.safeParse(parsed.data.params);
  if (!params.success) {
    throw new GatewayProtocolError(
      `invalid params for ${m.data}: ${params.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return { ...parsed.data, method: m.data, params: params.data };
}

export function encodeSuccess(id: string, result: unknown): ResponseEnvelopeT {
  return { protocol: PROTOCOL_VERSION, id, result };
}

export function encodeError(
  id: string,
  code: string,
  message: string,
  data?: unknown,
): ResponseEnvelopeT {
  return {
    protocol: PROTOCOL_VERSION,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Standard error codes — wire-stable so reference clients can switch on them.
// ---------------------------------------------------------------------------

export const ErrorCode = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  BadRequest: "bad_request",
  BudgetExceeded: "budget_exceeded",
  InternalError: "internal_error",
} as const;

export type ErrorCodeT = (typeof ErrorCode)[keyof typeof ErrorCode];
