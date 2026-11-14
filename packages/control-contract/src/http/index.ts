/**
 * `@crewhaus/control-contract/http`: a small client for `crewhaus.hangar.v1`. Every path
 * is built from the operation table Home publishes (`GET /api/v1`), or from a table the
 * caller hands in, so a client never keeps a route map of its own. It sends the protocol
 * header, carries one `Idempotency-Key` per action when asked, and answers each call as
 * `{ok: true, status, body, headers}` or `{ok: false, status, error}` in the v1 envelope.
 *
 * Runtime-neutral: `fetch` is injected (the CLI hands in one that reaches Home's own
 * socket), and nothing here names a runtime, a builtin module or a package. The sealing
 * helpers open a secret Home issued to the one key that asked, with WebCrypto.
 */
import type { CliTwin, OperationRow } from "../areas/types.js";
import type { ErrorBody, ErrorCode } from "../errors.js";
import { ERROR_CODES } from "../errors.js";
import { API_PREFIX, IDEMPOTENCY_HEADER, PROTOCOL_HEADER, PROTOCOL_ID } from "../protocol.js";

export { makeSeal, openIssued, type SealedAnswer, type SealPair } from "./sealed.js";
export { readSse, type SseFrame } from "./sse.js";

import { type SseFrame, readSse } from "./sse.js";

/** The operation columns a client needs: what discovery publishes for each row. */
export type ClientOperation = Pick<
  OperationRow,
  "id" | "method" | "path" | "permission" | "receipt" | "idempotency"
> & {
  readonly cliTwin?: CliTwin | null;
  readonly stream?: "sse";
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ClientOptions = {
  /** Home's address, `http://127.0.0.1:8740` or `https://home.example`. No path. */
  readonly baseUrl: string;
  /** The bearer: a personal token, a session or Home's own key. */
  readonly token?: string;
  readonly fetch: FetchLike;
  /** The protocol to ask for; `crewhaus.hangar.v1` by default. */
  readonly protocol?: string;
  /** An operation table to build paths from instead of asking Home for its own. */
  readonly operations?: readonly ClientOperation[];
};

export type CallOptions = {
  /** Path parameters by name; a `{ref}` is `<scope>/<kind>/<id>` and spans three segments. */
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** One per user action, reused on that action's retry. */
  readonly idempotencyKey?: string;
};

export type CallAnswer =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: unknown;
      readonly headers: Headers;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: ErrorBody;
      readonly headers?: Headers;
    };

export type DiscoveryAnswer =
  | {
      readonly ok: true;
      readonly protocol: string;
      readonly signIn: { readonly methods: readonly string[] };
      readonly operations: readonly ClientOperation[];
      readonly body: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly status: number; readonly error: ErrorBody };

export type HangarClient = {
  /** `GET /api/v1`, read once and kept. */
  discover(): Promise<DiscoveryAnswer>;
  /** Call one operation by its id. An id the table does not hold answers `invalid`. */
  call(operationId: string, options?: CallOptions): Promise<CallAnswer>;
  /** Read an event stream: `id`/`event`/`data` frames, heartbeats skipped. */
  events(
    path: string,
    options: { readonly after?: string; readonly signal?: AbortSignal },
  ): AsyncIterable<SseFrame>;
};

const CODE_FOR_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: "invalid",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  412: "precondition_failed",
  422: "invalid",
  429: "rate_limited",
  501: "unsupported",
  503: "unavailable",
};

function codeFor(status: number): ErrorCode {
  return CODE_FOR_STATUS[status] ?? "internal";
}

function isErrorCodeName(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

function localError(code: ErrorCode, message: string): ErrorBody {
  return { code, message, retryable: ERROR_CODES[code].retryable };
}

/**
 * A response's error as a v1 error body: the envelope as it came, a legacy `{error}`
 * string with the code its status names, or the status alone.
 */
export function errorOf(status: number, body: unknown): ErrorBody {
  if (typeof body === "object" && body !== null) {
    const error = (body as Record<string, unknown>)["error"];
    if (typeof error === "object" && error !== null) {
      const e = error as Record<string, unknown>;
      const code = isErrorCodeName(e["code"]) ? e["code"] : codeFor(status);
      return {
        ...(e as object),
        code,
        message: typeof e["message"] === "string" ? e["message"] : `HTTP ${status}`,
        retryable: typeof e["retryable"] === "boolean" ? e["retryable"] : false,
      } as ErrorBody;
    }
    if (typeof error === "string") {
      const named = (body as Record<string, unknown>)["code"];
      const code = isErrorCodeName(named) ? named : codeFor(status);
      return { code, message: error, retryable: ERROR_CODES[code].retryable };
    }
  }
  return localError(
    codeFor(status),
    typeof body === "string" && body !== "" ? body : `HTTP ${status}`,
  );
}

/**
 * The path for an operation, with its params filled in. A `{ref}` with slashes spans its
 * segments, each encoded; any other param is one segment. A missing param answers
 * `undefined`, never a path with a hole in it.
 */
export function buildPath(
  template: string,
  params: Readonly<Record<string, string>> = {},
): string | undefined {
  const out: string[] = [];
  for (const piece of template.split("/")) {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    if (name === undefined) {
      out.push(piece);
      continue;
    }
    const value = params[name];
    if (typeof value !== "string" || value === "") return undefined;
    const parts = name === "ref" ? value.split("/") : [value];
    if (parts.some((part) => part === "")) return undefined;
    out.push(parts.map(encodeURIComponent).join("/"));
  }
  return out.join("/");
}

function queryString(query: CallOptions["query"]): string {
  if (query === undefined) return "";
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function operationsOf(body: Readonly<Record<string, unknown>>): ClientOperation[] {
  const rows = body["operations"];
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is ClientOperation =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as Record<string, unknown>)["id"] === "string" &&
      typeof (row as Record<string, unknown>)["path"] === "string" &&
      typeof (row as Record<string, unknown>)["method"] === "string",
  );
}

/** A client for one Home. Nothing is sent until a method is called. */
export function createClient(options: ClientOptions): HangarClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const protocol = options.protocol ?? PROTOCOL_ID;
  const headersFor = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
    [PROTOCOL_HEADER]: protocol,
    ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
    ...extra,
  });
  let discovered: Promise<DiscoveryAnswer> | undefined;

  const discover = (): Promise<DiscoveryAnswer> => {
    discovered ??= (async (): Promise<DiscoveryAnswer> => {
      let response: Response;
      try {
        response = await options.fetch(`${base}${API_PREFIX}`, {
          method: "GET",
          headers: headersFor({ accept: "application/json" }),
        });
      } catch (err) {
        return {
          ok: false,
          status: 0,
          error: localError("unavailable", `Home could not be reached: ${messageOf(err)}`),
        };
      }
      const body = await bodyOf(response);
      if (!response.ok)
        return { ok: false, status: response.status, error: errorOf(response.status, body) };
      if (typeof body !== "object" || body === null) {
        return {
          ok: false,
          status: response.status,
          error: localError("unsupported_protocol", "Home did not answer with its operations."),
        };
      }
      const record = body as Record<string, unknown>;
      const signIn = record["signIn"] as { methods?: unknown } | undefined;
      return {
        ok: true,
        protocol: String(record["protocol"]),
        signIn: {
          methods: Array.isArray(signIn?.methods)
            ? signIn.methods.filter((m): m is string => typeof m === "string")
            : [],
        },
        operations: operationsOf(record),
        body: record,
      };
    })();
    // A failed read is not kept: the next call asks again.
    discovered.then(
      (answer) => {
        if (!answer.ok) discovered = undefined;
      },
      () => {
        discovered = undefined;
      },
    );
    return discovered;
  };

  const tableOf = async (): Promise<readonly ClientOperation[] | ErrorBody> => {
    if (options.operations !== undefined) return options.operations;
    const answer = await discover();
    return answer.ok ? answer.operations : answer.error;
  };

  const call = async (operationId: string, opts: CallOptions = {}): Promise<CallAnswer> => {
    const table = await tableOf();
    if (!Array.isArray(table)) return { ok: false, status: 0, error: table as ErrorBody };
    const row = table.find((op) => op.id === operationId);
    if (row === undefined) {
      return {
        ok: false,
        status: 0,
        error: localError("invalid", `Home has no operation "${operationId}".`),
      };
    }
    const path = buildPath(row.path, opts.params);
    if (path === undefined) {
      return {
        ok: false,
        status: 0,
        error: localError(
          "invalid",
          `"${operationId}" needs the params its path names: ${row.path}`,
        ),
      };
    }
    const extra: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) extra["content-type"] = "application/json";
    if (opts.idempotencyKey !== undefined) extra[IDEMPOTENCY_HEADER] = opts.idempotencyKey;
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}${queryString(opts.query)}`, {
        method: row.method,
        headers: headersFor(extra),
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: localError("unavailable", `Home could not be reached: ${messageOf(err)}`),
      };
    }
    const body = await bodyOf(response);
    if (response.ok) return { ok: true, status: response.status, body, headers: response.headers };
    return {
      ok: false,
      status: response.status,
      error: errorOf(response.status, body),
      headers: response.headers,
    };
  };

  const events = (
    path: string,
    opts: { readonly after?: string; readonly signal?: AbortSignal },
  ): AsyncIterable<SseFrame> => ({
    async *[Symbol.asyncIterator]() {
      const response = await options.fetch(`${base}${path}`, {
        method: "GET",
        headers: headersFor({
          accept: "text/event-stream",
          ...(opts.after !== undefined ? { "last-event-id": opts.after } : {}),
        }),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      if (!response.ok || response.body === null) {
        const body = await bodyOf(response);
        throw new HangarCallError(response.status, errorOf(response.status, body));
      }
      yield* readSse(response.body);
    },
  });

  return { discover, call, events };
}

/** A stream that could not be opened: the status and the error body Home sent. */
export class HangarCallError extends Error {
  readonly status: number;
  readonly error: ErrorBody;
  constructor(status: number, error: ErrorBody) {
    super(error.message);
    this.status = status;
    this.error = error;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
