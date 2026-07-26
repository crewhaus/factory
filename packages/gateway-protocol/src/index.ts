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

/**
 * NEW-inloop-coverage — the gateway's RATING-CAPTURE method. A gateway-served
 * agent is the highest-traffic surface CrewHaus has, and until this method it
 * had no spec'd way to record a human verdict at all: `distill`, `optimize
 * --ratings`, `judge calibrate` and the auto-distill flywheel were all
 * structurally unreachable for the managed shape.
 *
 * The params are the USER-SUPPLIED subset of a `FeedbackRecord` (the daemon
 * stamps `schemaVersion`, `id`, `source: "ui"` and `ts` itself, so a client
 * cannot forge provenance or backdate a rating past the auto-distill
 * watermark). `sessionId` + `turnNumber` are the same join key `crewhaus
 * rate` uses, so a gateway rating and a CLI rating distill identically.
 *
 * The grammars are pinned HERE, at the boundary, so a bad submission is a
 * protocol error instead of a durable line nothing downstream can use:
 *   - `sessionId` must match `@crewhaus/session-store`'s id grammar, which is
 *     also what `isFeedbackRecord` requires — an id in any other shape would
 *     be accepted, written, counted against disk, and then silently dropped
 *     by every reader (and it is interpolated into a path by the managed
 *     daemon's tenant-ownership check);
 *   - the free-text fields are length-capped at the same bound
 *     `clipFeedbackText` enforces, so oversize input is REFUSED rather than
 *     silently truncated on a surface whose `correction` becomes a dataset's
 *     `expected_output`.
 */

/** `@crewhaus/session-store`'s `generateId` grammar (mirrored — this package
 *  is dependency-light by design and must not pull the store in). */
const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

/** Mirror of `@crewhaus/feedback-distill`'s `MAX_FEEDBACK_TEXT`. Kept in sync
 *  by hand for the same reason as SESSION_ID_REGEX above; the distill side
 *  still clips, so a drift can only ever be stricter here. */
export const MAX_FEEDBACK_TEXT = 8192;

export const FeedbackSubmitParams = z
  .object({
    sessionId: z.string().regex(SESSION_ID_REGEX, "sessionId must look like sess_<16 hex digits>"),
    /** 1-based ordinal of the rated user-text turn. */
    turnNumber: z.number().int().positive(),
    thumbs: z.enum(["up", "down"]).optional(),
    stars: z.number().int().min(1).max(5).optional(),
    scale: z.object({ value: z.number(), min: z.number(), max: z.number() }).strict().optional(),
    comment: z.string().max(MAX_FEEDBACK_TEXT).optional(),
    /** A better answer — becomes `expected_output` at distill time. */
    correction: z.string().max(MAX_FEEDBACK_TEXT).optional(),
    /** Opaque rater handle. Redacted at ingestion like every other free text. */
    rater: z.string().max(MAX_FEEDBACK_TEXT).optional(),
    /** B19 — this record settles a multi-rater disagreement. */
    adjudication: z.boolean().optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.thumbs !== undefined ||
      p.stars !== undefined ||
      p.scale !== undefined ||
      (p.comment ?? "") !== "" ||
      (p.correction ?? "") !== "",
    { message: "feedback.submit needs at least one of thumbs/stars/scale/comment/correction" },
  );
export const FeedbackSubmitResult = z
  .object({ recorded: z.boolean(), id: z.string().min(1) })
  .strict();
export type FeedbackSubmitParamsT = z.infer<typeof FeedbackSubmitParams>;
export type FeedbackSubmitResultT = z.infer<typeof FeedbackSubmitResult>;

export const Method = z.enum([
  "runs.create",
  "runs.continue",
  "runs.cancel",
  "runs.subscribe",
  "sessions.list",
  "sessions.fork",
  "audit.tail",
  "feedback.submit",
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
  "feedback.submit": FeedbackSubmitParams,
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
// `runs.subscribe` — Server-Sent Events framing.
//
// `runs.subscribe` is the ONE method that does not answer with a JSON
// `ResponseEnvelope`: it upgrades to a long-lived `text/event-stream` that
// replays the run's buffered trace events and then live-streams new ones.
// The frame format lives HERE (the wire-contract package) so the daemon and
// every reference client encode/parse it identically:
//
//   - each trace event is one SSE `data:` frame carrying the event's JSON.
//     `JSON.stringify` never emits a literal newline (newlines inside string
//     fields are escaped to `\n`), so one event is always exactly one `data:`
//     line — no multi-line-`data:` reassembly is required on the read side.
//   - heartbeats and the connection-open marker are SSE COMMENT frames
//     (`:`-prefixed); a spec-compliant client ignores them, so they keep
//     intermediaries from idling the connection out without polluting the
//     event stream. A comment body must not contain a newline.
//
// A stream carries no envelope `id`/`protocol` — those are per-request-reply
// fields; the subscription is a fire-hose keyed by the `runId` in the
// originating `runs.subscribe` request.
// ---------------------------------------------------------------------------

/** MIME type of a `runs.subscribe` response body. */
export const SSE_CONTENT_TYPE = "text/event-stream" as const;

/**
 * Encode one trace event as an SSE `data:` frame. `event` is serialized with
 * `JSON.stringify` (a TraceEvent is always JSON-serializable), so the frame is
 * a single `data:` line terminated by the mandatory blank line.
 */
export function encodeSseEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Encode an SSE comment frame (heartbeat / open marker). Any newline in `text`
 * is collapsed to a space so the comment stays a single well-formed frame.
 */
export function encodeSseComment(text: string): string {
  return `: ${text.replace(/[\r\n]+/g, " ")}\n\n`;
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
