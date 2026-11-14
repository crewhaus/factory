/**
 * The receipts middleware: every mutating `/api` route writes a command receipt before its
 * handler runs, and its answer carries that receipt. It runs after authentication and the
 * read-only refusal, around the one dispatch call in `server.ts`, and reads only the route
 * table (`route-table.ts`): a route added there is covered by construction.
 *
 * A request refused before its handler writes nothing: an unmatched route, a read, an
 * unknown or malformed harness id, a path value that is not the ref its row's
 * `receiptRef` names, a body that is not a JSON object, a malformed `Idempotency-Key`, a
 * key reused for another request. A receipt's target is the most specific ref the row
 * names: the harness, or, with `receiptRef`, the object inside it the command settles. Once accepted, the handler's answer
 * settles the receipt by its status:
 *
 * | Answer | Receipt |
 * |---|---|
 * | 2xx (207 is a partial failure: `failed`) | `succeeded`; one that queued a job stays `accepted` until the job settles |
 * | 4xx, 501, 503, or an `HttpError` with one | `rejected`, with the status's error code |
 * | any other throw, or another 5xx | `unknown` (`failed` for a write that is safe to repeat) |
 *
 * The outcome's words are fixed per code, never the handler's text. The answer keeps its
 * status and every field, and gains `receipt`, masked like the rest; a body that is not a
 * JSON object gains the `x-crewhaus-command` header instead.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import {
  COMMAND_KINDS,
  type CommandReceipt,
  type ErrorCode,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_VALUE_RE,
  IDEMPOTENT_REPLAYED_HEADER,
  type ReceiptEffect,
  parseRef,
} from "@crewhaus/control-contract";
import {
  type ControlService,
  type LedgerChoice,
  type Settlement,
  outcomeOf,
} from "@crewhaus/control-service";
import { HARNESS_ID_RE, type HangarHarnessEntry } from "@crewhaus/harness-registry";
import { HttpError, errResponse, json } from "./http";
import { type TextScrubber, maskDeep } from "./mask";
import { matchRequest } from "./route-match";
import type { RouteRow } from "./route-table";

/** The header a non-object answer carries the receipt's id in. */
export const COMMAND_HEADER = "x-crewhaus-command";

type CommandContext = {
  readonly commandId: string;
  readonly by: string;
  /** Jobs this request queued. */
  jobs: number;
};

const commandContext = new AsyncLocalStorage<CommandContext>();

/**
 * The command the current request runs for, for a job it queues: `{commandId, by}`, or
 * nothing outside a receipted request. Spread into the queue's submit.
 */
export function commandFields(): { readonly commandId?: string; readonly by?: string } {
  const context = commandContext.getStore();
  if (context === undefined) return {};
  context.jobs += 1;
  return { commandId: context.commandId, by: context.by };
}

/** The command the current request runs for, read only (it queues nothing). */
export function currentCommand(): { readonly commandId: string; readonly by: string } | undefined {
  const context = commandContext.getStore();
  return context === undefined ? undefined : { commandId: context.commandId, by: context.by };
}

/** The error code an answer's status means. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 412:
      return "precondition_failed";
    case 429:
      return "rate_limited";
    case 501:
      return "unsupported";
    case 503:
      return "unavailable";
    default:
      return status >= 500 ? "internal" : "invalid";
  }
}

function isRefusalStatus(status: number): boolean {
  return (status >= 400 && status < 500) || status === 501 || status === 503;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A group walk's members, one effect each. */
function memberEffects(body: unknown): ReceiptEffect[] | undefined {
  const result = isRecord(body) ? body["result"] : undefined;
  const members = isRecord(result) ? result["members"] : undefined;
  if (!Array.isArray(members)) return undefined;
  return members.filter(isRecord).map((member) => ({
    kind: "member",
    ...(typeof member["id"] === "string" && HARNESS_ID_RE.test(member["id"])
      ? { ref: `home/harness/${member["id"]}` }
      : {}),
    status: member["skipped"] === true ? "skipped" : member["ok"] === true ? "done" : "failed",
  }));
}

function rowIsIdempotent(row: RouteRow): boolean {
  const kind = row.kind ?? "";
  const declared = (COMMAND_KINDS as Readonly<Record<string, { readonly idempotent: boolean }>>)[
    kind
  ];
  return declared?.idempotent ?? row.idempotent === true;
}

/**
 * How a handler's answer settles its receipt; `undefined` leaves it for the job. A 2xx
 * that queued a job is the job's to settle whatever the row declares, so a route that
 * starts queuing work is never reported done before that work runs.
 */
export function settleForStatus(
  row: RouteRow,
  status: number,
  options: { readonly jobsQueued: number; readonly body?: unknown } = { jobsQueued: 0 },
): Settlement | undefined {
  if (status >= 200 && status < 300) {
    if (options.jobsQueued > 0) return undefined;
    const effects = (row.key === "groupProc" ? memberEffects(options.body) : undefined) ?? [
      { kind: "route", status: "done" as const, observed: `http ${status}` },
    ];
    return status === 207
      ? { state: "failed", effects, outcome: outcomeOf("conflict") }
      : { state: "succeeded", effects };
  }
  if (isRefusalStatus(status)) {
    return { state: "rejected", outcome: outcomeOf(codeForStatus(status)) };
  }
  return { state: rowIsIdempotent(row) ? "failed" : "unknown", outcome: outcomeOf("internal") };
}

export type ReceiptsDeps = {
  readonly control: ControlService;
  /** The signed-in principal the request is from, `prn_…`; absent, the head's own user. */
  readonly actorOf?: (req: Request) => string | undefined;
  readonly harness: (id: string) => HangarHarnessEntry | undefined;
  /** The scrubber the route's own payload is masked with: a harness's, or the fleet's. */
  readonly scrubFor: (harnessDir: string | undefined) => TextScrubber;
  readonly onWarn: (message: string) => void;
};

type Handled = {
  readonly response: Response;
  readonly body: unknown;
  readonly text: string | undefined;
};

/** The request's body as the handlers would read it, or the refusal they would give. */
async function readJsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  let text: string;
  try {
    text = await req.clone().text();
  } catch {
    return errResponse(400, "invalid JSON body");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return errResponse(400, "invalid JSON body");
  }
  if (!isRecord(parsed)) return errResponse(400, "body must be a JSON object");
  return parsed;
}

/** Answer with the receipt added: to a JSON object's fields, else as a header. */
function withReceiptOn(handled: Handled, receipt: CommandReceipt, scrub: TextScrubber): Response {
  const { response, body } = handled;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (!isRecord(body)) {
    headers.set(COMMAND_HEADER, receipt.id);
    // A body that was never read streams through as it is.
    return new Response(handled.text ?? response.body, { status: response.status, headers });
  }
  const merged = { ...body, receipt: maskDeep(receipt, scrub) };
  return new Response(`${JSON.stringify(merged)}\n`, { status: response.status, headers });
}

export type WithReceipt = (
  req: Request,
  segments: readonly string[],
  next: () => Promise<Response>,
) => Promise<Response>;

export function createReceipts(deps: ReceiptsDeps): WithReceipt {
  return async (req, segments, next) => {
    const method = req.method;
    if (method === "GET" || method === "HEAD") return next();
    // The one matcher the choke point uses too.
    const matched = matchRequest(method, segments);
    const row = matched?.row;
    if (
      matched === undefined ||
      row === undefined ||
      row.receipt === "none" ||
      row.kind === undefined
    ) {
      return next();
    }

    let target: string | undefined;
    let ledger: LedgerChoice = "workspace";
    let harnessDir: string | undefined;
    const id = matched.params["id"];
    if (id !== undefined) {
      // An unknown or malformed id is refused by the handler's lookup, before it acts.
      if (!HARNESS_ID_RE.test(id)) return next();
      const entry = deps.harness(id);
      if (entry === undefined) return next();
      target = `home/harness/${id}`;
      const named = row.receiptRef;
      if (named !== undefined) {
        // The row names what the command settles: `<hrn>/<kind>/<value>`. A value that is
        // not that ref is the handler's to refuse, before it acts, with no receipt.
        const value = matched.params[named.param];
        const ref = value === undefined ? undefined : `${id}/${named.kind}/${value}`;
        if (ref === undefined || "error" in parseRef(ref)) return next();
        target = ref;
      }
      if (entry.missingSince === null && existsSync(entry.dir)) harnessDir = entry.dir;
      if (row.receipt === "harness" && harnessDir !== undefined) ledger = { harness: harnessDir };
    }

    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    const idempotency = req.headers.get(IDEMPOTENCY_HEADER) ?? undefined;
    if (idempotency !== undefined && !IDEMPOTENCY_VALUE_RE.test(idempotency)) {
      return json(
        { error: `${IDEMPOTENCY_HEADER} must be 1-128 of A-Z a-z 0-9 . _ : -`, code: "invalid" },
        400,
      );
    }

    // Everything that addresses the request is fingerprinted, so one key reused on another
    // path (`/env/A`, then `/env/B`) or another query is refused, not replayed.
    const params: Record<string, string> = {};
    const inTarget = new Set(
      target === undefined ? [] : ["id", ...(row.receiptRef ? [row.receiptRef.param] : [])],
    );
    for (const [name, value] of Object.entries(matched.params)) {
      if (!inTarget.has(name)) params[name] = value;
    }
    const query = [...new URL(req.url).searchParams.entries()];

    const scrub = deps.scrubFor(harnessDir);
    const actor = deps.actorOf?.(req);
    const answer = await deps.control.commands.submit<Handled>(
      {
        kind: row.kind,
        ...(actor !== undefined ? { actor } : {}),
        ...(target !== undefined ? { target } : {}),
        ledger,
        via: "home",
        body,
        params,
        query,
        ...(row.secretFields !== undefined ? { secretFields: row.secretFields } : {}),
        ...(idempotency !== undefined ? { idempotency } : {}),
        ...(row.idempotent !== undefined ? { idempotent: row.idempotent } : {}),
        ...(row.dispatch === "job" ? { queued: true } : {}),
      },
      async (receipt) => {
        const context: CommandContext = { commandId: receipt.id, by: receipt.actor, jobs: 0 };
        let response: Response;
        try {
          response = await commandContext.run(context, next);
        } catch (err) {
          if (err instanceof HttpError) {
            // A refusal that carries fields beside its message (`needs`, `paths`) keeps them.
            response =
              err.body === undefined
                ? errResponse(err.status, err.message)
                : json(maskDeep({ error: err.message, ...err.body }, scrub), err.status);
          } else {
            deps.onWarn(
              `hangar-server: unhandled route error: ${err instanceof Error ? err.message : String(err)}`,
            );
            response = errResponse(500, "internal error");
          }
        }
        const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
        const text = isJson ? await response.text() : undefined;
        let parsed: unknown;
        if (text !== undefined) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
        }
        const handled: Handled = {
          response,
          body: parsed,
          text,
        };
        const settle = settleForStatus(row, response.status, {
          jobsQueued: context.jobs,
          body: parsed,
        });
        return { ...(settle !== undefined ? { settle } : {}), value: handled };
      },
    );

    if (!answer.ok) {
      const { code, message } = answer.refusal;
      const status = code === "idempotency_key_reused" ? 422 : code === "invalid" ? 400 : 503;
      return json({ error: message, code }, status);
    }
    if (answer.replayed) {
      const terminal = ["succeeded", "failed", "rejected", "cancelled"].includes(
        answer.receipt.state,
      );
      return json({ receipt: maskDeep(answer.receipt, scrub) }, terminal ? 200 : 202, {
        [IDEMPOTENT_REPLAYED_HEADER]: "true",
      });
    }
    const handled = answer.value;
    // An effect was passed, so it always answers; this is only for the type.
    if (handled === undefined) return errResponse(500, "internal error");
    return withReceiptOn(handled, answer.receipt, scrub);
  };
}
