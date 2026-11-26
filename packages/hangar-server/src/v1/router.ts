/**
 * The versioned API, `crewhaus.hangar.v1`, at `/api/v1`, behind Home's one choke point.
 * A request reaches this router only after authentication and `authorizeRequest` decided
 * its operation row; here it is checked again for shape and answered:
 *
 * 1. `CrewHaus-Protocol`, when sent, names this protocol (any other is 400
 *    `unsupported_protocol`), and every answer echoes it.
 * 2. An operation declared and not served yet answers 501 `unsupported` with its twin.
 * 3. The query holds only the names the operation takes, and the body parses strictly
 *    with the operation's request schema: an unknown field is 400 `invalid` naming it.
 * 4. The handler answers; every answer passes the dispatch masker at this one exit, with
 *    the harness's scrubber or the fleet's.
 */
import {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_VALUE_RE,
  type OperationRow,
  PROTOCOL_HEADER,
  PROTOCOL_ID,
  isId,
  parseRef,
  renderTwin,
} from "@crewhaus/control-contract";
import { EXECUTION_RUN_ID_RE } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import { readRequestBodyCapped } from "@crewhaus/gateway-protocol/body-limit";
import { HARNESS_ID_RE } from "@crewhaus/harness-registry";
import { type Caller, type RequestAccess, currentRequestAccess } from "../access";
import { HttpError, json } from "../http";
import { maskDeep } from "../mask";
import type { RequestMatch } from "../route-match";
import {
  HOME_AREAS,
  type HomeAreaRuntime,
  V1_NOT_SERVED,
  capabilityProvidersOf,
  handlersOf,
  homeCompositionProblems,
  projectionsOf,
  refResolversOf,
  streamSourcesOf,
} from "./areas";
import type { DaemonState, V1Context, V1Deps } from "./context";
import { V1Error, v1ErrorBody, v1ErrorHeaders } from "./errors";
import { OPERATION_BY_ID, matchOperation } from "./match";
import { commandLedgerOf, entryOf } from "./resolve";
import { findExecution, findRun, startedRunIn } from "./runs";
import { type StreamPlan, v1EventStream } from "./stream";

const BINARY = "crewhaus";

/** A body the API takes is a few kilobytes; anything past this is not one. */
const MAX_BODY_BYTES = 256 * 1024;

/** The query names each request schema takes; an operation with a `{ref}`, `{cmd}` or `{run}` also takes `harness`. */
const QUERY_NAMES: Readonly<Record<string, readonly string[]>> = {
  listQuery: ["limit", "cursor"],
  streamQuery: ["after"],
  noBody: [],
  attentionListQuery: ["harness", "kind", "band", "state", "limit", "cursor"],
  attentionMetricsQuery: ["harness", "since"],
  exportFormatQuery: ["format"],
  inspectTimelineQuery: ["view", "limit", "before", "after"],
  inspectRawQuery: ["before"],
};

export type V1Router = {
  handle(req: Request, url: URL, segs: readonly string[]): Promise<Response>;
  /**
   * What the choke point decides a v1 row on, worked out first: the harness its `{h}`,
   * `{ref}` or `{cmd}` names (`null` for none this Home has), and whether it asks about
   * the caller's own token, device or link.
   */
  targetOf(
    matched: RequestMatch,
    url: URL,
    caller: Caller,
  ): {
    readonly targetHarness?: string | null;
    readonly selfScope?: true;
    /**
     * On a row qualified `creating-service`: who started the run it names (or, for a list,
     * the caller). The credential in `runByCredential` decides.
     */
    readonly runBy?: string;
    /** On a row qualified `creating-service`: the credential that started the run it names (or, for a list, the caller's). */
    readonly runByCredential?: string;
  };
  /** `GET /api/v1` for a caller who sent no credential: the protocol and how to sign in. */
  discoverAnonymous(): Response;
};

/** The supervisor's state in the API's words. */
export function daemonStateOf(state: string): DaemonState {
  switch (state) {
    case "running":
      return "running";
    case "preflight":
    case "starting":
      return "starting";
    case "draining":
      return "draining";
    case "crashed":
    case "crash-looping":
      return "crashed";
    case "stopped":
    case "parked":
    case "terminal":
      return "stopped";
    default:
      return "unknown";
  }
}

function protocolHeaders(): Record<string, string> {
  return { [PROTOCOL_HEADER]: PROTOCOL_ID };
}

function unknownFieldsOf(error: unknown): string[] {
  const issues = (error as { issues?: readonly { code?: string; keys?: readonly string[] }[] })
    .issues;
  return (issues ?? []).flatMap((issue) =>
    issue.code === "unrecognized_keys" ? [...(issue.keys ?? [])] : [],
  );
}

function viaOf(caller: Caller): V1Context["via"] {
  return caller.via === "service" || caller.via === "personal" || caller.via === "scoped"
    ? "sdk"
    : "home";
}

/** The operation's twin with the request's own params, when every placeholder is known. */
export function twinVerb(
  op: OperationRow,
  params: Readonly<Record<string, string>>,
): string | undefined {
  if (op.cliTwin === null) return undefined;
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    if (name === "h" && HARNESS_ID_RE.test(value)) values["hrn"] = value;
    else values[name] = value;
  }
  const rendered = renderTwin(op.cliTwin, values);
  // The binary's name and the rendered words: a twin is never a template of its own.
  return "argv" in rendered ? [BINARY, ...rendered.argv].join(" ") : undefined;
}

/**
 * Build the router once, beside the receipts middleware. A composition with a problem is
 * refused at boot, with the reason.
 */
export function createV1Router(
  deps: V1Deps,
  areas: readonly HomeAreaRuntime[] = HOME_AREAS,
): V1Router {
  const problems = homeCompositionProblems(areas);
  if (problems.length > 0) {
    throw new Error(
      `hangar-server: the API's area composition is refused:\n  ${problems.join("\n  ")}`,
    );
  }
  const handlers = handlersOf(areas);
  const refResolvers = refResolversOf(areas);
  const capabilityProviders = capabilityProvidersOf(areas);
  const projections = projectionsOf(areas);
  const streamSources = streamSourcesOf(areas);

  const exit = (status: number, body: unknown, scrubDir?: string, headers = {}): Response =>
    json(
      maskDeep(body, scrubDir === undefined ? deps.fleetScrub() : deps.harnessScrub(scrubDir)),
      status,
      { ...protocolHeaders(), "cache-control": "no-store", ...headers },
    );

  /**
   * A stream's answer: the one writer, with the scrubber `exit` would choose, the protocol
   * headers, and the caller's authority as it stands at each batch.
   */
  const streamExit = (
    plan: StreamPlan,
    scrubDir: string | undefined,
    access: RequestAccess,
  ): Response =>
    v1EventStream({
      ...plan,
      ...(deps.streamTimings ?? {}),
      scrub: scrubDir === undefined ? deps.fleetScrub() : deps.harnessScrub(scrubDir),
      // A Home that lends no fresh view (a test's) keeps the request's own.
      accessNow: () => deps.accessNow?.(access.caller) ?? access,
      headers: protocolHeaders(),
      onWarn: deps.onWarn,
    });

  const refuse = (error: V1Error): Response =>
    exit(error.input.status, v1ErrorBody(error.input), undefined, v1ErrorHeaders(error.input));

  const queryOf = (op: OperationRow, url: URL): Record<string, string> => {
    const allowed = new Set(QUERY_NAMES[op.request] ?? []);
    if (op.path.includes("{ref}") || op.path.includes("{cmd}") || op.path.includes("{run}")) {
      allowed.add("harness");
    }
    const out: Record<string, string> = {};
    const unknown: string[] = [];
    for (const [name, value] of url.searchParams.entries()) {
      if (!allowed.has(name) || Object.hasOwn(out, name)) unknown.push(name);
      else out[name] = value;
    }
    if (unknown.length > 0) {
      throw new V1Error({
        status: 400,
        code: "invalid",
        reason: "unknown_fields",
        message: `This operation does not take: ${[...new Set(unknown)].join(", ")}.`,
        details: { unknownFields: [...new Set(unknown)] },
      });
    }
    return out;
  };

  const bodyOf = async (op: OperationRow, req: Request): Promise<Record<string, unknown>> => {
    if (op.method === "GET") return {};
    const read = await readRequestBodyCapped(req, MAX_BODY_BYTES);
    if (!read.ok) {
      throw new V1Error({
        status: 400,
        code: "invalid",
        reason: "body_too_large",
        message: "The request body is too large.",
      });
    }
    let parsed: unknown;
    try {
      parsed = read.text.trim() === "" ? {} : JSON.parse(read.text);
    } catch {
      throw new V1Error({
        status: 400,
        code: "invalid",
        reason: "body_invalid",
        message: "The request body is not JSON.",
      });
    }
    const schema = (SCHEMAS as Readonly<Record<string, { safeParse(v: unknown): unknown }>>)[
      op.request
    ];
    const checked = schema?.safeParse(parsed) as
      | { success: true; data: unknown }
      | { success: false; error: unknown }
      | undefined;
    if (checked === undefined || !checked.success) {
      const unknownFields = checked === undefined ? [] : unknownFieldsOf(checked.error);
      throw new V1Error({
        status: 400,
        code: "invalid",
        reason: unknownFields.length > 0 ? "unknown_fields" : "body_invalid",
        message:
          unknownFields.length > 0
            ? `This operation does not take: ${unknownFields.join(", ")}.`
            : "The request body is not what this operation takes.",
        ...(unknownFields.length > 0 ? { details: { unknownFields } } : {}),
      });
    }
    const data = checked.data;
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  };

  const handle = async (req: Request, url: URL, segs: readonly string[]): Promise<Response> => {
    try {
      const asked = req.headers.get(PROTOCOL_HEADER);
      if (asked !== null && asked.trim() !== PROTOCOL_ID) {
        throw new V1Error({
          status: 400,
          code: "unsupported_protocol",
          reason: "protocol",
          message: `This Home speaks ${PROTOCOL_ID}.`,
          details: { supported: [PROTOCOL_ID] },
        });
      }
      const matched = matchOperation(req.method, ["api", ...segs]);
      const op = matched === undefined ? undefined : OPERATION_BY_ID.get(matched.row.key);
      if (matched === undefined || op === undefined) {
        throw new V1Error({
          status: 404,
          code: "not_found",
          reason: "no_route",
          message: "not found",
        });
      }
      const notServed = V1_NOT_SERVED[op.id];
      if (notServed !== undefined) {
        const verb = twinVerb(op, matched.params);
        throw new V1Error({
          status: 501,
          code: "unsupported",
          reason: "not_served",
          message: notServed,
          ...(verb !== undefined ? { verb } : {}),
        });
      }
      const handler = handlers.get(op.id);
      if (handler === undefined) {
        throw new V1Error({
          status: 501,
          code: "unsupported",
          reason: "not_served",
          message: "This operation is not served by this Home.",
        });
      }
      const access = currentRequestAccess();
      if (access === undefined) {
        throw new V1Error({
          status: 401,
          code: "unauthenticated",
          reason: "no_credential",
          message: "missing or invalid bearer token",
        });
      }
      const idempotency = req.headers.get(IDEMPOTENCY_HEADER) ?? undefined;
      if (idempotency !== undefined && !IDEMPOTENCY_VALUE_RE.test(idempotency)) {
        throw new V1Error({
          status: 400,
          code: "invalid",
          reason: "idempotency_key",
          message: `${IDEMPOTENCY_HEADER} must be 1-128 of A-Z a-z 0-9 . _ : -`,
        });
      }
      const caller = access.caller;
      // A service repeats a command only under the key it was first sent with.
      if (
        op.idempotency === "required-for-services" &&
        caller.via === "service" &&
        idempotency === undefined
      ) {
        throw new V1Error({
          status: 400,
          code: "invalid",
          reason: "idempotency_required",
          message: `A service sends ${IDEMPOTENCY_HEADER} with this operation.`,
        });
      }
      const query = queryOf(op, url);
      const body = await bodyOf(op, req);
      const ctx: V1Context = {
        req,
        url,
        op,
        params: matched.params,
        query,
        body,
        access,
        deps,
        ...(idempotency !== undefined ? { idempotency } : {}),
        via: viaOf(caller),
        refResolvers,
        capabilityProviders,
        projections,
        streamSources,
        ...(caller.actor !== null && isId("prn", caller.principal)
          ? {
              actor: caller.principal,
              ...("credential" in caller.actor ? { credentialRef: caller.actor.credential } : {}),
            }
          : {}),
      };
      const answer = await handler(ctx);
      if ("stream" in answer) return streamExit(answer.stream, answer.scrubDir, access);
      return exit(answer.status, answer.body, answer.scrubDir, answer.headers ?? {});
    } catch (err) {
      if (err instanceof V1Error) return refuse(err);
      if (err instanceof HttpError) {
        return refuse(
          new V1Error({
            status: err.status,
            code: codeForStatus(err.status),
            message: err.message,
            ...(err.body !== undefined ? { details: err.body } : {}),
          }),
        );
      }
      deps.onWarn(
        `hangar-server: unhandled API error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return refuse(
        new V1Error({
          status: 500,
          code: "internal",
          reason: "internal",
          message: "internal error",
        }),
      );
    }
  };

  const targetOf: V1Router["targetOf"] = (matched, url, caller) => {
    const op = OPERATION_BY_ID.get(matched.row.key);
    if (op === undefined) return {};
    const out: {
      targetHarness?: string | null;
      selfScope?: true;
      runBy?: string;
      runByCredential?: string;
    } = {};
    const { h, ref, cmd, run } = matched.params;
    const creating = op.qualifiers.includes("creating-service");
    const credential =
      caller.actor !== null && "credential" in caller.actor ? caller.actor.credential : undefined;
    if (h !== undefined) {
      const entry = entryOf(deps, h);
      out.targetHarness = entry?.id ?? null;
      // A service credential that started a run there lists the runs it started, and no
      // others; one that started none is refused as for a harness this Home does not have.
      if (creating && caller.via === "service" && credential !== undefined && entry !== undefined) {
        if (startedRunIn(entry, caller.principal, credential)) {
          out.runBy = caller.principal;
          out.runByCredential = credential;
        }
      }
    } else if (run !== undefined && EXECUTION_RUN_ID_RE.test(run)) {
      // A supervisor's execution is a stream's only: found in one harness's supervisor
      // ledger, or none. Every other run operation reads canonical runs, so it has none.
      if (op.id === "runs.events") {
        const found = findExecution(deps, run, url.searchParams.get("harness") ?? undefined);
        out.targetHarness = found?.entry.id ?? null;
      } else {
        out.targetHarness = null;
      }
    } else if (run !== undefined) {
      const found = findRun(deps, run, url.searchParams.get("harness") ?? undefined);
      out.targetHarness = found?.entry.id ?? null;
      if (creating && found?.by !== undefined && found.byCredential !== undefined) {
        out.runBy = found.by;
        out.runByCredential = found.byCredential;
      }
    } else if (ref !== undefined) {
      const parsed = parseRef(ref);
      if (!("error" in parsed)) {
        out.targetHarness = parsed.scope === "home" ? null : parsed.scope;
      } else {
        // A bare id: the `?harness=` hint names where, or the handler lists candidates.
        const hint = url.searchParams.get("harness");
        if (hint !== null) out.targetHarness = entryOf(deps, hint)?.id ?? null;
      }
    } else if (cmd !== undefined) {
      const found = commandLedgerOf(deps, cmd, url.searchParams.get("harness") ?? undefined);
      if (found !== undefined && found.harness !== undefined) out.targetHarness = found.harness;
      else if (found === undefined) out.targetHarness = null;
    }
    // One's own token, device or link, or one's own part of their lists.
    if (op.qualifiers.includes("self") && op.id.startsWith("access.") && caller.actor !== null) {
      out.selfScope = true;
    }
    return out;
  };

  const discoverAnonymous = (): Response =>
    exit(200, { protocol: PROTOCOL_ID, signIn: { methods: ["browser", "device"] } });

  return { handle, targetOf, discoverAnonymous };
}

function codeForStatus(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return "invalid";
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
      return "internal";
  }
}
