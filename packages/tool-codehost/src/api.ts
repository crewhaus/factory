import { type NextPage, nextPageFrom } from "./lib/page";
import { buildQuery } from "./lib/refs";
/**
 * One request, and one paginated listing, against a code host's REST API.
 *
 * Everything the tools do goes through here so the rules hold in exactly one
 * place: the token is attached as a header and never as a path, query or
 * body; the response is read under a byte cap; the listing loop is bounded by
 * a page cap as well as the deadline; and the token is scrubbed out of every
 * string on the way back even though it was never put into one.
 */
import {
  CREDENTIAL_HEADERS,
  type CodehostConfig,
  CodehostPermissionError,
  type Deadline,
  type HostKind,
  authHeaders,
  byString,
  openRequest,
  readCapped,
  safeUrlLabel,
} from "./net";

/** What one tool call carries for the length of its work. */
export type CallCtx = {
  readonly cfg: CodehostConfig;
  readonly host: HostKind;
  /** Absolute API root, e.g. `https://api.github.com`, without a trailing slash. */
  readonly baseUrl: string;
  readonly token: string;
  readonly deadline: Deadline;
  readonly maxBytes: number;
  /** Scrubs the token out of anything on its way to the caller. */
  readonly redact: (text: string) => string;
};

export type ApiRequestInit = {
  readonly method: string;
  /** Path under the base URL, already validated and encoded, starting with "/". */
  readonly path?: string;
  /** A fully-formed URL instead of `path` — used only to follow a `rel=next`. */
  readonly absoluteUrl?: string;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  readonly accept?: string;
  /** Override the ctx cap for one call, e.g. a log body. */
  readonly maxBytes?: number;
};

export type ApiResult = {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed body when the response was JSON; `undefined` otherwise. */
  readonly json: unknown;
  readonly text: string;
  /** Bytes actually read off the wire, which is not `text.length`. */
  readonly bytes: number;
  readonly truncated: boolean;
  /** Lowercase-keyed response headers, credentials removed. */
  readonly headers: Record<string, string>;
  /** The URL actually answered, with the query string dropped. */
  readonly url: string;
  readonly nextPage: NextPage;
  /** True when a cross-origin redirect dropped the token before the hop. */
  readonly credentialsDropped: boolean;
};

/**
 * Response headers no result may carry back: the same set a request drops at
 * a cross-origin hop, read from one place so the two cannot drift, plus the
 * response-only spelling of a cookie.
 */
const STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  ...CREDENTIAL_HEADERS,
  "set-cookie",
]);

function headerMap(res: Response): Record<string, string> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of res.headers.entries()) {
    const lower = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    pairs.push([lower, value]);
  }
  pairs.sort((a, b) => byString(a[0], b[0]));
  return Object.fromEntries(pairs);
}

/** The base URL with any trailing slash removed, so joins never double up. */
export function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * Why a base URL cannot be used as an API root, or `null` when it can.
 *
 * Every path in this package is appended to the base URL as TEXT, which is
 * the only way to keep `/repos/a/b` a path rather than something a URL
 * resolver might reinterpret. That makes a base URL carrying a query string
 * or a fragment actively misleading rather than merely odd: with
 * `https://host/#` every request silently goes to `/` and comes back looking
 * like an answer about the resource that was asked for, and with
 * `https://host/?x=1` the whole path lands inside the query string. Both are
 * refused here, where the caller can see why.
 */
export function baseUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `baseUrl "${safeUrlLabel(raw)}" is not an absolute URL — it must include the scheme, e.g. https://api.github.com`;
  }
  // The raw text, not just the parsed parts: `https://host/#` parses with an
  // EMPTY hash, and it is the spelling that silently sends every request to
  // the root.
  if (raw.includes("?") || raw.includes("#") || url.search !== "" || url.hash !== "") {
    return `baseUrl "${safeUrlLabel(raw)}" carries a query string or a fragment — it must be an API ROOT, e.g. https://api.github.com or https://gitlab.example.com/api/v4, because every request path is appended to it`;
  }
  return null;
}

/**
 * Issue one API request.
 *
 * Throws only `CodehostPermissionError` (a gate refusal) or a transport
 * error; an HTTP error status comes back as a result with `ok: false`, since
 * a 404 on a PR is an answer, not a crash.
 */
export async function apiRequest(c: CallCtx, init: ApiRequestInit): Promise<ApiResult> {
  const raw = init.absoluteUrl ?? `${c.baseUrl}${init.path ?? ""}${buildQuery(init.query ?? {})}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CodehostPermissionError(
      `"${safeUrlLabel(raw)}" is not an absolute URL — baseUrl must include the scheme, e.g. https://api.github.com`,
    );
  }

  const headers: Record<string, string> = {
    Accept:
      init.accept ?? (c.host === "github" ? "application/vnd.github+json" : "application/json"),
    "User-Agent": "crewhaus-tool-codehost",
    ...authHeaders(c.host, c.token),
  };
  if (c.host === "github") headers["X-GitHub-Api-Version"] = "2022-11-28";

  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["Content-Type"] = "application/json";
  }

  const opened = await openRequest({
    url,
    method: init.method,
    headers,
    body,
    signal: c.deadline.signal,
    cfg: c.cfg,
  });
  const drained = await readCapped(opened.res, init.maxBytes ?? c.maxBytes);
  const map = headerMap(opened.res);
  const contentType = map["content-type"] ?? "";
  let parsed: unknown;
  if (contentType.includes("json") && drained.text.trim() !== "" && !drained.truncated) {
    try {
      parsed = JSON.parse(drained.text);
    } catch {
      parsed = undefined;
    }
  }
  return {
    status: opened.res.status,
    ok: opened.res.status >= 200 && opened.res.status < 300,
    json: parsed,
    text: drained.text,
    bytes: drained.bytes,
    truncated: drained.truncated,
    headers: map,
    url: safeUrlLabel(opened.finalUrl),
    nextPage: nextPageFrom(map),
    credentialsDropped: opened.credentialsDropped,
  };
}

export type ListOptions = {
  readonly perPage: number;
  readonly maxPages: number;
};

export type ListResult = {
  readonly items: unknown[];
  readonly pages: number;
  /** True when the page cap stopped the walk with more pages available. */
  readonly morePages: boolean;
  readonly last: ApiResult;
};

/**
 * Walk a paginated listing under a page cap.
 *
 * The cap is not politeness: without it a tool pointed at a busy repository
 * will keep asking for pages until the deadline, and return more JSON than
 * any caller wanted. The walk stops at the cap, at the end of the list, at
 * the first error status, or when the deadline has nothing left.
 *
 * Every hop re-enters `apiRequest`, so a `rel=next` URL that points at
 * another origin is refused by the allow-list rather than followed.
 */
export async function apiList(
  c: CallCtx,
  init: ApiRequestInit,
  opts: ListOptions,
): Promise<ListResult> {
  const items: unknown[] = [];
  let pages = 0;
  let morePages = false;
  let request: ApiRequestInit = {
    ...init,
    query: { ...(init.query ?? {}), per_page: opts.perPage, page: 1 },
  };
  let last: ApiResult | undefined;

  while (true) {
    const result = await apiRequest(c, request);
    last = result;
    pages++;
    if (!result.ok) break;
    const payload = result.json;
    if (Array.isArray(payload)) items.push(...payload);
    else if (payload !== undefined) items.push(payload);

    const next = result.nextPage;
    if (next === null) break;
    if (pages >= opts.maxPages || c.deadline.remaining() <= 0) {
      morePages = true;
      break;
    }
    request =
      next.kind === "url"
        ? {
            method: init.method,
            absoluteUrl: next.url,
            accept: init.accept,
            // The cap is part of the call, not part of the first page.
            ...(init.maxBytes !== undefined ? { maxBytes: init.maxBytes } : {}),
          }
        : {
            ...init,
            query: { ...(init.query ?? {}), per_page: opts.perPage, page: next.page },
          };
  }

  return { items, pages, morePages, last: last as ApiResult };
}
