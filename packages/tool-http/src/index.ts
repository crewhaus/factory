/**
 * `@crewhaus/tool-http` — HTTP and network work that should not cost a model
 * turn.
 *
 * `@crewhaus/tool-fetch` gives an agent ONE request. That is the right
 * primitive, and it is also why a seven-page API costs seven model turns, a
 * webhook signature costs a code-execution round trip, and "wait until the
 * deploy is healthy" becomes a sleep-and-hope loop. Each tool here collapses
 * one of those patterns into a single call with a stated bound.
 *
 * Three commitments hold across the package.
 *
 *   1. **The gate is tool-fetch's gate.** Allow-list, SSRF refusal, IP
 *      pinning, per-hop re-checks and credential stripping all live in
 *      `./net` and every outbound byte passes through them. A second HTTP
 *      surface with a weaker gate would be the same hole twice. See that
 *      file's header for the full list.
 *   2. **Nothing runs unbounded.** Every outbound tool has a deadline and a
 *      response byte cap; the polling and streaming tools REQUIRE the
 *      deadline rather than defaulting it.
 *   3. **Determinism.** Same inputs against the same world, same bytes out:
 *      listings are sorted, comparisons are locale-free, nothing is random,
 *      and the wall clock appears in a result only where the caller asked
 *      for timing (`HttpRequest`, `UrlReachable`, `HttpWaitFor`,
 *      `TlsInspect`'s days-remaining) — each of those fields is flagged in
 *      its description.
 *
 * Secrets: no tool accepts an inline credential. An `auth` profile names an
 * environment VARIABLE, and inline `Authorization`/`Cookie` headers are
 * refused, because a token a model can put in a tool argument is a token in
 * the transcript, the trace and the eval report.
 *
 * Results are compact JSON, and a caller's mistake comes back as a readable
 * string rather than an exception.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  resolve4,
  resolve6,
  resolveCname,
  resolveMx,
  resolveNs,
  resolveTxt,
} from "node:dns/promises";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { connect as tlsConnect } from "node:tls";
import type { DetailedPeerCertificate } from "node:tls";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { formatDn, summarizeCert } from "./lib/cert";
import { parseFeed } from "./lib/feed";
import { matchesPredicate, readPath } from "./lib/jsonpath";
import type { FieldPredicate } from "./lib/jsonpath";
import { relTarget } from "./lib/link-header";
import { nextDelayMs } from "./lib/retry";
import { evaluateRobots, parseRobots } from "./lib/robots";
import { parseSitemap } from "./lib/sitemap";
import { SseDecoder } from "./lib/sse";
import type { SseEvent } from "./lib/sse";
import { formatHeader, hmacHex, signedPayload, verifySignature } from "./lib/webhook";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  HttpPermissionError,
  MAX_MAX_BYTES,
  MAX_REDIRECTS,
  MAX_TIMEOUT_MS,
  applyAuth,
  assertHostAllowed,
  assertNotSsrf,
  authHeaderName,
  byString,
  describeFailure,
  json,
  openRequest,
  parseUrl,
  readBytesCapped,
  readCapped,
  redactHeaders,
  rejectInlineCredentials,
  resolveHttpConfig,
  responseHeaders,
  safeUrlLabel,
  sleep,
  startDeadline,
} from "./net";
import type { AuthProfile, Deadline, HttpConfig } from "./net";
import { ToolPermissionError, resolveSafe } from "./paths";

export {
  HttpPermissionError,
  _resetHttpConfig,
  _setDnsLookup,
  _setRawFetch,
  __setPrivateHostsAllowedForTest,
  canonicalizeOrigin,
  getHttpConfig,
  registerHttpConfig,
} from "./net";
export { ToolPermissionError } from "./paths";

// ---------------------------------------------------------------------------
// shared schema pieces
// ---------------------------------------------------------------------------

const urlSchema = z
  .string()
  .min(1)
  .describe("absolute http(s) URL; its origin must appear in the configured allow-list");

const headersSchema = z
  .record(z.string())
  .optional()
  .describe(
    "request headers; Authorization, Proxy-Authorization and Cookie are refused here — use auth",
  );

const authSchema = z
  .object({
    type: z
      .enum(["bearer", "basic", "header"])
      .describe(
        "bearer ⇒ Authorization: Bearer, basic ⇒ Authorization: Basic, header ⇒ headerName",
      ),
    envVar: z
      .string()
      .min(1)
      .describe("NAME of the environment variable holding the secret — never the secret itself"),
    headerName: z.string().min(1).optional().describe('header to set when type is "header"'),
    username: z
      .string()
      .optional()
      .describe('username when type is "basic"; envVar is the password'),
    prefix: z.string().optional().describe('literal prefix before the secret for type "header"'),
  })
  .optional()
  .describe("credential resolved from the process environment at call time");

const timeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`milliseconds before the request is abandoned (default ${DEFAULT_TIMEOUT_MS})`);

const deadlineSchema = (what: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .describe(`REQUIRED deadline in milliseconds — ${what} never runs longer than this`);

const maxBytesSchema = z
  .number()
  .int()
  .min(1024)
  .max(MAX_MAX_BYTES)
  .optional()
  .describe(
    `response body cap in bytes (default ${DEFAULT_MAX_BYTES}); the body is cut, not grown`,
  );

const redirectSchema = z
  .enum(["follow", "manual", "error"])
  .optional()
  .describe(
    "follow (default, re-checking the allow-list each hop), manual (return the 3xx), or error (refuse to leave the URL)",
  );

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

type PreparedHeaders =
  | {
      readonly ok: true;
      readonly headers: Record<string, string>;
      /**
       * Lowercased names of the headers the auth profile set. Everything that
       * echoes or forwards headers consults this, so a profile that puts the
       * secret in `X-Api-Key` is guarded exactly as hard as one that puts it
       * in `Authorization`.
       */
      readonly secretHeaders: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly message: string };

/** Reject inline credentials, then attach the auth profile's secret. */
function prepareHeaders(
  raw: Record<string, string> | undefined,
  auth: AuthProfile | undefined,
): PreparedHeaders {
  const headers: Record<string, string> = { ...(raw ?? {}) };
  const inline = rejectInlineCredentials(headers);
  if (inline !== null) return { ok: false, message: inline };
  const authError = applyAuth(headers, auth);
  if (authError !== null) return { ok: false, message: authError };
  const named = authHeaderName(auth);
  return {
    ok: true,
    headers,
    secretHeaders: named === undefined ? new Set<string>() : new Set([named]),
  };
}

/** Set `name` only when no spelling of it is present. Header names are case-insensitive. */
function setDefaultHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return;
  }
  headers[name] = value;
}

/** Parse a body as JSON, or say why it is not JSON without dumping it all back. */
function parseJsonBody(
  text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const preview = text.slice(0, 200);
    return {
      ok: false,
      message: `response body is not JSON (${(err as Error).message}); first 200 characters: ${preview}`,
    };
  }
}

/** Run `fn` over `items` with at most `limit` in flight, results in input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Reject with `message` once `signal` aborts, for APIs with no abort signal of
 * their own. Everything raced against one signal shares one deadline.
 */
async function raceSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  message: string,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error(message));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** The config this call runs under. */
function configFor(ctx: ToolExecuteContext | undefined): HttpConfig {
  return resolveHttpConfig(ctx?.toolConfig);
}

/** Fetch a text document through the full gate. Used by the parsing tools. */
async function fetchText(
  url: URL,
  cfg: HttpConfig,
  deadline: Deadline,
  maxBytes: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; truncated: boolean; finalUrl: string }> {
  const opened = await openRequest({
    url,
    method: "GET",
    headers,
    signal: deadline.signal,
    cfg,
    redirect: "follow",
  });
  const body = await readCapped(opened.res, maxBytes);
  return {
    status: opened.res.status,
    text: body.text,
    truncated: body.truncated,
    finalUrl: opened.finalUrl,
  };
}

// ---------------------------------------------------------------------------
// one request
// ---------------------------------------------------------------------------

export const httpRequest: RegisteredTool = buildTool({
  name: "HttpRequest",
  description:
    "Issue one HTTP request to an allow-listed origin, with an env-resolved auth profile, a redirect policy, a retry-on-status rule and a deadline, returning status, headers, body and timing. Use it when Fetch is not enough because the call needs authentication, a non-default redirect policy, or an automatic retry on 429/503 that would otherwise cost a model turn per attempt. It does not stream, does not keep cookies between calls, and its elapsedMs field is wall-clock, so it differs run to run. A 301, 302 or 303 answer to a non-GET is followed as a GET with the body dropped, as HTTP requires, so a POST is never replayed at a hop the caller did not ask for.",
  inputSchema: z.object({
    url: urlSchema,
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      .optional()
      .describe("default GET"),
    headers: headersSchema,
    body: z.string().optional().describe("request body, as the exact bytes to send"),
    auth: authSchema,
    redirect: redirectSchema,
    maxRedirects: z.number().int().min(0).max(MAX_REDIRECTS).optional(),
    retryOnStatus: z
      .array(z.number().int().min(100).max(599))
      .max(10)
      .optional()
      .describe("status codes worth another attempt, e.g. [429, 503]"),
    maxRetries: z.number().int().min(0).max(5).optional().describe("extra attempts (default 0)"),
    retryBaseMs: z
      .number()
      .int()
      .min(1)
      .max(60_000)
      .optional()
      .describe("first backoff step; doubles each attempt, and Retry-After wins over it"),
    parseJson: z
      .boolean()
      .optional()
      .describe("parse the body and return it as json instead of text"),
    timeoutMs: timeoutSchema.describe(
      `milliseconds for the whole call including retries (default ${DEFAULT_TIMEOUT_MS})`,
    ),
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const url = parseUrl(input.url);
    if (typeof url === "string") return url;
    const prepared = prepareHeaders(input.headers, input.auth);
    if (!prepared.ok) return prepared.message;

    const cfg = configFor(ctx);
    const method = input.method ?? "GET";
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const retryOn = new Set(input.retryOnStatus ?? []);
    const maxRetries = input.maxRetries ?? 0;
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    const startedAt = Date.now();
    try {
      let attempt = 0;
      while (true) {
        const opened = await openRequest({
          url,
          method,
          headers: prepared.headers,
          body: input.body,
          signal: deadline.signal,
          cfg,
          redirect: input.redirect ?? "follow",
          maxRedirects: input.maxRedirects ?? MAX_REDIRECTS,
          credentialHeaders: prepared.secretHeaders,
        });
        const status = opened.res.status;
        const shouldRetry = attempt < maxRetries && retryOn.has(status);
        if (shouldRetry) {
          const delay = nextDelayMs({
            attempt,
            baseMs: input.retryBaseMs ?? 500,
            maxMs: 30_000,
            retryAfter: opened.res.headers.get("retry-after"),
            nowMs: Date.now(),
            remainingMs: deadline.remaining(),
          });
          if (delay !== null) {
            try {
              await opened.res.body?.cancel();
            } catch {
              // already closed
            }
            await sleep(delay, deadline.signal);
            attempt++;
            continue;
          }
        }
        const body = await readCapped(opened.res, maxBytes);
        const parsed = input.parseJson === true ? parseJsonBody(body.text) : undefined;
        if (parsed !== undefined && !parsed.ok) return parsed.message;
        return json({
          status,
          statusText: opened.res.statusText,
          ok: status >= 200 && status < 300,
          finalUrl: opened.finalUrl,
          redirects: opened.redirects,
          credentialsDropped: opened.credentialsDropped,
          attempts: attempt + 1,
          headers: responseHeaders(opened.res),
          bytes: body.bytes,
          truncated: body.truncated,
          requestHeaders: redactHeaders(prepared.headers, prepared.secretHeaders),
          elapsedMs: Date.now() - startedAt,
          ...(parsed !== undefined ? { json: parsed.value } : { body: body.text }),
        });
      }
    } catch (err) {
      return describeFailure(err, deadline);
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

export const httpPaginate: RegisteredTool = buildTool({
  name: "HttpPaginate",
  description:
    "Walk a paginated API to the end or to a page cap and return the concatenated items, following RFC 5988 Link headers, a cursor field you name, or a page-number parameter. Use it instead of calling Fetch once per page: a seven-page listing becomes one tool call rather than seven model turns. It issues GET only, holds every item in memory, and stops at whichever comes first of the page cap, the item cap, the total-byte budget, an empty page or the deadline — the result says which.",
  inputSchema: z.object({
    url: urlSchema.describe("the first page's URL; later pages are derived from it"),
    headers: headersSchema,
    auth: authSchema,
    style: z
      .enum(["link", "cursor", "page"])
      .describe(
        'link = Link header rel="next"; cursor = read cursorPath from the body and send it as cursorParam; page = increment pageParam',
      ),
    cursorPath: z
      .string()
      .optional()
      .describe('style "cursor": dotted path to the next cursor, e.g. "meta.next_cursor"'),
    cursorParam: z
      .string()
      .optional()
      .describe('style "cursor": query parameter the cursor is sent as'),
    pageParam: z.string().optional().describe('style "page": the page-number query parameter'),
    startPage: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('style "page": first page number (default 1)'),
    pageSizeParam: z.string().optional().describe('style "page": the page-size query parameter'),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('style "page": page size to request'),
    itemsPath: z
      .string()
      .optional()
      .describe(
        'dotted path to the array in each page, e.g. "data.items"; omit if the body IS the array',
      ),
    maxPages: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe("REQUIRED page cap — this tool never follows a cursor forever"),
    maxItems: z.number().int().min(1).max(100_000).optional(),
    timeoutMs: deadlineSchema("the whole walk, across every page,"),
    maxBytes: maxBytesSchema.describe("per-page response cap in bytes"),
    maxTotalBytes: z
      .number()
      .int()
      .min(1024)
      .max(MAX_MAX_BYTES)
      .optional()
      .describe(
        `cap across ALL pages (default ${MAX_MAX_BYTES}); the walk stops when the pages read so far reach it, because maxBytes alone bounds one page and this tool holds every page's items at once`,
      ),
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const first = parseUrl(input.url);
    if (typeof first === "string") return first;
    if (
      input.style === "cursor" &&
      (input.cursorPath === undefined || input.cursorParam === undefined)
    ) {
      return 'style "cursor" needs both cursorPath (where the cursor is in the body) and cursorParam (the query parameter to send it as)';
    }
    if (input.style === "page" && input.pageParam === undefined) {
      return 'style "page" needs pageParam — the query parameter holding the page number';
    }
    const prepared = prepareHeaders(input.headers, input.auth);
    if (!prepared.ok) return prepared.message;

    const cfg = configFor(ctx);
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const deadline = startDeadline(input.timeoutMs, ctx?.signal);
    const maxTotalBytes = input.maxTotalBytes ?? MAX_MAX_BYTES;
    const items: unknown[] = [];
    let totalBytes = 0;
    let pages = 0;
    let stoppedBy = "end";
    let lastUrl = first.toString();
    let current: URL | null = new URL(first.toString());
    let pageNumber = input.startPage ?? 1;

    if (input.style === "page" && input.pageParam !== undefined) {
      current.searchParams.set(input.pageParam, String(pageNumber));
      if (input.pageSizeParam !== undefined && input.pageSize !== undefined) {
        current.searchParams.set(input.pageSizeParam, String(input.pageSize));
      }
    }

    try {
      while (current !== null) {
        if (deadline.expired()) {
          stoppedBy = "deadline";
          break;
        }
        if (pages >= input.maxPages) {
          stoppedBy = "pageCap";
          break;
        }
        lastUrl = current.toString();
        const opened = await openRequest({
          url: current,
          method: "GET",
          headers: prepared.headers,
          signal: deadline.signal,
          cfg,
          redirect: "follow",
          credentialHeaders: prepared.secretHeaders,
        });
        const body = await readCapped(opened.res, maxBytes);
        pages++;
        totalBytes += body.bytes;
        if (opened.res.status < 200 || opened.res.status >= 300) {
          return json({
            pages,
            itemCount: items.length,
            stoppedBy: "status",
            lastUrl,
            status: opened.res.status,
            items,
            note: `page ${pages} returned HTTP ${opened.res.status}; the walk stopped there`,
          });
        }
        if (body.truncated) {
          return json({
            pages,
            itemCount: items.length,
            stoppedBy: "pageTooLarge",
            lastUrl,
            items,
            note: `page ${pages} exceeded the ${maxBytes}-byte cap, so it could not be parsed; raise maxBytes or request a smaller page size`,
          });
        }
        const parsed = parseJsonBody(body.text);
        if (!parsed.ok) return `page ${pages}: ${parsed.message}`;

        const rawItems =
          input.itemsPath === undefined ? parsed.value : readPath(parsed.value, input.itemsPath);
        if (!Array.isArray(rawItems)) {
          return json({
            pages,
            itemCount: items.length,
            stoppedBy: "shape",
            lastUrl,
            items,
            note:
              input.itemsPath === undefined
                ? "the response body is not an array — pass itemsPath to say where the items live"
                : `itemsPath "${input.itemsPath}" did not resolve to an array on page ${pages}`,
          });
        }
        for (const item of rawItems) {
          items.push(item);
          if (input.maxItems !== undefined && items.length >= input.maxItems) break;
        }
        if (input.maxItems !== undefined && items.length >= input.maxItems) {
          stoppedBy = "itemCap";
          break;
        }
        if (rawItems.length === 0) {
          stoppedBy = "emptyPage";
          break;
        }
        // The per-page cap bounds one response; this bounds the walk. Without
        // it, 100 pages at the default page cap is half a gigabyte of parsed
        // items held in memory at once, which is not a bound at all.
        if (totalBytes >= maxTotalBytes) {
          stoppedBy = "byteBudget";
          break;
        }

        // Where the next page lives, per style.
        if (input.style === "link") {
          const next = relTarget(opened.res.headers.get("link"), "next");
          current = next === undefined ? null : (new URL(next, current) as URL);
        } else if (input.style === "cursor" && input.cursorPath !== undefined) {
          const cursor = readPath(parsed.value, input.cursorPath);
          if (cursor === undefined || cursor === null || cursor === "") {
            current = null;
          } else if (typeof cursor !== "string" && typeof cursor !== "number") {
            return `cursorPath "${input.cursorPath}" resolved to a ${typeof cursor}; a cursor must be a string or a number`;
          } else {
            const next: URL = new URL(first.toString());
            for (const [key, value] of current.searchParams.entries())
              next.searchParams.set(key, value);
            next.searchParams.set(input.cursorParam as string, String(cursor));
            current = next;
          }
        } else if (input.pageParam !== undefined) {
          pageNumber++;
          const next: URL = new URL(current.toString());
          next.searchParams.set(input.pageParam, String(pageNumber));
          current = next;
        } else {
          current = null;
        }
      }
      return json({ pages, itemCount: items.length, bytes: totalBytes, stoppedBy, lastUrl, items });
    } catch (err) {
      return describeFailure(err, deadline);
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

export const graphqlQuery: RegisteredTool = buildTool({
  name: "GraphqlQuery",
  description:
    "POST a GraphQL query or mutation with variables to an allow-listed endpoint and return data and errors as separate fields. Use it so a partial GraphQL response — which arrives as HTTP 200 with a populated errors array — is visible as an error instead of being mistaken for success. It does not validate the query against a schema, does not batch operations, and does not follow @defer or subscription streams.",
  inputSchema: z.object({
    url: urlSchema.describe("the GraphQL endpoint"),
    query: z.string().min(1).describe("the query or mutation document"),
    variables: z.record(z.unknown()).optional(),
    operationName: z
      .string()
      .optional()
      .describe("required when the document holds several operations"),
    headers: headersSchema,
    auth: authSchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const url = parseUrl(input.url);
    if (typeof url === "string") return url;
    const prepared = prepareHeaders(input.headers, input.auth);
    if (!prepared.ok) return prepared.message;
    // Case-insensitively, so a caller that wrote "Content-Type" does not end
    // up with two of them on the wire.
    setDefaultHeader(prepared.headers, "content-type", "application/json");
    setDefaultHeader(prepared.headers, "accept", "application/json");

    const cfg = configFor(ctx);
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      const opened = await openRequest({
        url,
        method: "POST",
        headers: prepared.headers,
        body: JSON.stringify({
          query: input.query,
          ...(input.variables !== undefined ? { variables: input.variables } : {}),
          ...(input.operationName !== undefined ? { operationName: input.operationName } : {}),
        }),
        signal: deadline.signal,
        cfg,
        redirect: "follow",
        credentialHeaders: prepared.secretHeaders,
      });
      const body = await readCapped(opened.res, input.maxBytes ?? DEFAULT_MAX_BYTES);
      if (body.truncated) {
        return `the GraphQL response exceeded the ${input.maxBytes ?? DEFAULT_MAX_BYTES}-byte cap and could not be parsed — narrow the selection set or raise maxBytes`;
      }
      const parsed = parseJsonBody(body.text);
      if (!parsed.ok) {
        return `HTTP ${opened.res.status}: ${parsed.message}`;
      }
      const envelope = (parsed.value ?? {}) as Record<string, unknown>;
      const errors = Array.isArray(envelope["errors"]) ? envelope["errors"] : [];
      return json({
        status: opened.res.status,
        hasErrors: errors.length > 0,
        errorCount: errors.length,
        errors,
        data: envelope["data"] ?? null,
      });
    } catch (err) {
      return describeFailure(err, deadline);
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// batching
// ---------------------------------------------------------------------------

export const httpBatch: RegisteredTool = buildTool({
  name: "HttpBatch",
  description:
    "Issue several independent requests with a concurrency cap and return every result in request order, whether it succeeded or failed. Use it when a step needs a handful of unrelated endpoints — one per resource id, say — and calling them one at a time would spend a model turn each. Requests cannot depend on one another, a failure never cancels the rest, and each response is capped independently. The batch has its own deadline as well as a per-request one, so requests still queued when it elapses come back as skipped rather than running the batch out to the sum of its parts.",
  inputSchema: z.object({
    requests: z
      .array(
        z.object({
          url: urlSchema,
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional(),
          headers: headersSchema,
          body: z.string().optional(),
        }),
      )
      .min(1)
      .max(25),
    auth: authSchema.describe("applied to every request in the batch"),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe("requests in flight (default 4)"),
    includeBody: z.boolean().optional().describe("include response bodies (default true)"),
    includeHeaders: z.boolean().optional().describe("include response headers (default false)"),
    timeoutMs: timeoutSchema.describe("per-request deadline in milliseconds"),
    totalTimeoutMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `deadline for the whole batch (default ${MAX_TIMEOUT_MS}); requests still waiting when it elapses are reported as skipped rather than issued`,
      ),
    maxBytes: maxBytesSchema.describe("per-response cap in bytes"),
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const cfg = configFor(ctx);
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const perRequestMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const includeBody = input.includeBody ?? true;
    // A per-request deadline is not a bound on the batch: 25 requests at the
    // maximum per-request timeout, one at a time, is over four hours. The
    // batch gets its own clock and every request is clamped to what is left.
    const overall = startDeadline(input.totalTimeoutMs ?? MAX_TIMEOUT_MS, ctx?.signal);

    try {
      const results = await mapWithConcurrency(
        input.requests,
        input.concurrency ?? 4,
        async (req, index) => {
          const url = parseUrl(req.url);
          if (typeof url === "string") return { index, url: req.url, ok: false, error: url };
          const prepared = prepareHeaders(req.headers, input.auth);
          if (!prepared.ok) return { index, url: req.url, ok: false, error: prepared.message };
          if (overall.expired()) {
            return {
              index,
              url: req.url,
              ok: false,
              error: "skipped: the batch deadline elapsed before this request was issued",
            };
          }
          const deadline = startDeadline(
            Math.min(perRequestMs, Math.max(1, overall.remaining())),
            overall.signal,
          );
          try {
            const opened = await openRequest({
              url,
              method: req.method ?? "GET",
              headers: prepared.headers,
              body: req.body,
              signal: deadline.signal,
              cfg,
              redirect: "follow",
              credentialHeaders: prepared.secretHeaders,
            });
            const body = await readCapped(opened.res, maxBytes);
            return {
              index,
              url: req.url,
              ok: opened.res.status >= 200 && opened.res.status < 300,
              status: opened.res.status,
              finalUrl: opened.finalUrl,
              bytes: body.bytes,
              truncated: body.truncated,
              ...(input.includeHeaders === true ? { headers: responseHeaders(opened.res) } : {}),
              ...(includeBody ? { body: body.text } : {}),
            };
          } catch (err) {
            return { index, url: req.url, ok: false, error: describeFailure(err, deadline) };
          } finally {
            deadline.cancel();
          }
        },
      );

      return json({
        count: results.length,
        okCount: results.filter((r) => r.ok).length,
        results,
      });
    } finally {
      overall.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

let partCounter = 0;

export const downloadFile: RegisteredTool = buildTool({
  name: "DownloadFile",
  description:
    "Download a URL to a path inside the workspace under a byte cap, optionally verifying an expected sha256 before the file is kept. Use it to bring an artifact, dataset or fixture onto disk without piping a response body through a model's context. The download is written to a temporary file and renamed only after the cap and the checksum both pass, so a failed transfer never leaves a half-written file at the destination.",
  inputSchema: z.object({
    url: urlSchema,
    path: z
      .string()
      .min(1)
      .describe("destination, relative to the workspace root; must stay inside it"),
    expectedSha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional()
      .describe("hex digest the content must match, checked before the file is kept"),
    overwrite: z.boolean().optional().describe("replace an existing file (default false)"),
    headers: headersSchema,
    auth: authSchema,
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_MAX_BYTES)
      .optional()
      .describe(
        `refuse anything larger (default ${DEFAULT_MAX_BYTES}); exceeding it is an error, not a truncation`,
      ),
    timeoutMs: timeoutSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  execute: async (input, ctx) => {
    const url = parseUrl(input.url);
    if (typeof url === "string") return url;
    const prepared = prepareHeaders(input.headers, input.auth);
    if (!prepared.ok) return prepared.message;

    let target: ReturnType<typeof resolveSafe>;
    try {
      target = resolveSafe("DownloadFile", input.path);
    } catch (err) {
      if (err instanceof ToolPermissionError) return err.message;
      throw err;
    }
    // `lstat`, not `exists`: `existsSync` follows the link, so a DANGLING
    // symlink at the destination reads as "nothing there" and the guard would
    // wave the write through and silently replace it. Something is there.
    if (
      lstatSync(target.real, { throwIfNoEntry: false }) !== undefined &&
      input.overwrite !== true
    ) {
      return `"${target.rel}" already exists — pass overwrite: true to replace it`;
    }

    const cfg = configFor(ctx);
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    // A distinct partial name per call so two concurrent downloads into the
    // same directory cannot clobber each other's in-flight bytes.
    const partial = `${target.real}.crewhaus-part-${process.pid}-${partCounter++}`;
    try {
      const opened = await openRequest({
        url,
        method: "GET",
        headers: prepared.headers,
        signal: deadline.signal,
        cfg,
        redirect: "follow",
        credentialHeaders: prepared.secretHeaders,
      });
      if (opened.res.status < 200 || opened.res.status >= 300) {
        try {
          await opened.res.body?.cancel();
        } catch {
          // already closed
        }
        return `HTTP ${opened.res.status} ${opened.res.statusText} from ${safeUrlLabel(opened.finalUrl)} — nothing was written`;
      }
      // One extra byte past the cap is enough to know it was exceeded.
      const raw = await readBytesCapped(opened.res, maxBytes + 1);
      if (raw.truncated || raw.bytes.byteLength > maxBytes) {
        return `the response is larger than the ${maxBytes}-byte cap — nothing was written; raise maxBytes if the file really is that big`;
      }
      const digest = createHash("sha256").update(raw.bytes).digest("hex");
      if (input.expectedSha256 !== undefined && digest !== input.expectedSha256.toLowerCase()) {
        return `checksum mismatch: expected ${input.expectedSha256.toLowerCase()}, got ${digest} — nothing was written`;
      }
      mkdirSync(path.dirname(target.real), { recursive: true });
      writeFileSync(partial, raw.bytes);
      renameSync(partial, target.real);
      const contentType = opened.res.headers.get("content-type");
      return json({
        path: target.rel,
        bytes: raw.bytes.byteLength,
        sha256: digest,
        status: opened.res.status,
        finalUrl: opened.finalUrl,
        ...(contentType !== null ? { contentType } : {}),
        ...(input.expectedSha256 !== undefined ? { checksumVerified: true } : {}),
      });
    } catch (err) {
      return describeFailure(err, deadline);
    } finally {
      deadline.cancel();
      rmSync(partial, { force: true });
    }
  },
});

// ---------------------------------------------------------------------------
// metadata-only probes
// ---------------------------------------------------------------------------

export const headRequest: RegisteredTool = buildTool({
  name: "HeadRequest",
  description:
    "Ask for a URL's metadata without its body: status, size, content type, ETag, last-modified and caching headers. Use it to check whether a resource exists, how big it is, or whether a cached copy is still current, without spending the bytes on a download. Some servers refuse HEAD with 405 or 501, so this falls back to a single-byte ranged GET and says so in usedRangedGet.",
  inputSchema: z.object({
    url: urlSchema,
    headers: headersSchema,
    auth: authSchema,
    redirect: redirectSchema,
    fallbackToGet: z
      .boolean()
      .optional()
      .describe("retry with a ranged GET when HEAD is refused (default true)"),
    timeoutMs: timeoutSchema,
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const url = parseUrl(input.url);
    if (typeof url === "string") return url;
    const prepared = prepareHeaders(input.headers, input.auth);
    if (!prepared.ok) return prepared.message;

    const cfg = configFor(ctx);
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      let opened = await openRequest({
        url,
        method: "HEAD",
        headers: prepared.headers,
        signal: deadline.signal,
        cfg,
        redirect: input.redirect ?? "follow",
        credentialHeaders: prepared.secretHeaders,
      });
      let usedRangedGet = false;
      if (
        (opened.res.status === 405 || opened.res.status === 501) &&
        input.fallbackToGet !== false
      ) {
        try {
          await opened.res.body?.cancel();
        } catch {
          // already closed
        }
        opened = await openRequest({
          url,
          method: "GET",
          headers: { ...prepared.headers, range: "bytes=0-0" },
          signal: deadline.signal,
          cfg,
          redirect: input.redirect ?? "follow",
          credentialHeaders: prepared.secretHeaders,
        });
        usedRangedGet = true;
      }
      try {
        await opened.res.body?.cancel();
      } catch {
        // already closed
      }
      const headers = responseHeaders(opened.res);
      const lengthRaw = headers["content-length"];
      const length = lengthRaw === undefined ? Number.NaN : Number.parseInt(lengthRaw, 10);
      return json({
        status: opened.res.status,
        exists: opened.res.status >= 200 && opened.res.status < 400,
        finalUrl: opened.finalUrl,
        redirects: opened.redirects,
        usedRangedGet,
        ...(Number.isFinite(length) && !usedRangedGet ? { contentLength: length } : {}),
        ...(headers["content-type"] !== undefined ? { contentType: headers["content-type"] } : {}),
        ...(headers["etag"] !== undefined ? { etag: headers["etag"] } : {}),
        ...(headers["last-modified"] !== undefined
          ? { lastModified: headers["last-modified"] }
          : {}),
        ...(headers["cache-control"] !== undefined
          ? { cacheControl: headers["cache-control"] }
          : {}),
        ...(headers["accept-ranges"] !== undefined
          ? { acceptRanges: headers["accept-ranges"] }
          : {}),
      });
    } catch (err) {
      return describeFailure(err, deadline);
    } finally {
      deadline.cancel();
    }
  },
});

export const urlReachable: RegisteredTool = buildTool({
  name: "UrlReachable",
  description:
    "Probe one URL within a deadline and report whether it answered, with what status, and how long it took. Use it as a bounded connectivity check — is this endpoint up, is the tunnel open — rather than as a health check of what the service returns. Both status and latencyMs are wall-clock facts about one moment, so a passing probe is not a promise about the next one.",
  inputSchema: z.object({
    url: urlSchema,
    method: z.enum(["HEAD", "GET"]).optional().describe("default HEAD"),
    timeoutMs: timeoutSchema.describe(
      `milliseconds before it is called unreachable (default ${DEFAULT_TIMEOUT_MS})`,
    ),
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const url = parseUrl(input.url);
    if (typeof url === "string") return url;
    const cfg = configFor(ctx);
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    const startedAt = Date.now();
    try {
      const opened = await openRequest({
        url,
        method: input.method ?? "HEAD",
        headers: {},
        signal: deadline.signal,
        cfg,
        redirect: "follow",
      });
      const latencyMs = Date.now() - startedAt;
      try {
        await opened.res.body?.cancel();
      } catch {
        // already closed
      }
      return json({
        reachable: true,
        status: opened.res.status,
        ok: opened.res.status >= 200 && opened.res.status < 400,
        finalUrl: opened.finalUrl,
        latencyMs,
      });
    } catch (err) {
      return json({
        reachable: false,
        latencyMs: Date.now() - startedAt,
        error: describeFailure(err, deadline),
      });
    } finally {
      deadline.cancel();
    }
  },
});

export const linkCheck: RegisteredTool = buildTool({
  name: "LinkCheck",
  description:
    "Check a list of URLs for reachability with a concurrency cap and a shared deadline, returning a status per URL in input order. Use it to validate the links in a document or a sitemap in one call instead of one per link. It reports what each server answered and does not judge content, so a soft 404 that returns HTTP 200 is reported as reachable.",
  inputSchema: z.object({
    urls: z.array(urlSchema).min(1).max(100),
    method: z.enum(["HEAD", "GET"]).optional().describe("default HEAD"),
    concurrency: z.number().int().min(1).max(8).optional().describe("checks in flight (default 4)"),
    perRequestTimeoutMs: z
      .number()
      .int()
      .min(1)
      .max(60_000)
      .optional()
      .describe("per-URL deadline (default 10000)"),
    timeoutMs: deadlineSchema("the whole sweep"),
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const cfg = configFor(ctx);
    const overall = startDeadline(input.timeoutMs, ctx?.signal);
    const perRequest = input.perRequestTimeoutMs ?? 10_000;
    try {
      const results = await mapWithConcurrency(input.urls, input.concurrency ?? 4, async (raw) => {
        if (overall.expired())
          return { url: raw, ok: false, error: "skipped: the sweep deadline elapsed" };
        const url = parseUrl(raw);
        if (typeof url === "string") return { url: raw, ok: false, error: url };
        const deadline = startDeadline(
          Math.min(perRequest, Math.max(1, overall.remaining())),
          overall.signal,
        );
        try {
          const opened = await openRequest({
            url,
            method: input.method ?? "HEAD",
            headers: {},
            signal: deadline.signal,
            cfg,
            redirect: "follow",
          });
          try {
            await opened.res.body?.cancel();
          } catch {
            // already closed
          }
          return {
            url: raw,
            ok: opened.res.status >= 200 && opened.res.status < 400,
            status: opened.res.status,
            ...(opened.finalUrl !== raw ? { finalUrl: opened.finalUrl } : {}),
          };
        } catch (err) {
          return { url: raw, ok: false, error: describeFailure(err, deadline) };
        } finally {
          deadline.cancel();
        }
      });
      return json({
        checked: results.length,
        okCount: results.filter((r) => r.ok).length,
        brokenCount: results.filter((r) => !r.ok).length,
        results,
      });
    } finally {
      overall.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

export const httpWaitFor: RegisteredTool = buildTool({
  name: "HttpWaitFor",
  description:
    "Poll a URL until it answers with an expected status or a named JSON field satisfies a predicate, within a required deadline. Use it to wait for a deploy, a migration or an async job to reach a stated condition instead of guessing with a sleep and burning a model turn per check. The deadline is mandatory and the poll never runs past it; the result says whether the condition was met, how many attempts it took and what the last answer was.",
  inputSchema: z.object({
    url: urlSchema,
    method: z.enum(["GET", "HEAD"]).optional().describe("default GET"),
    headers: headersSchema,
    auth: authSchema,
    expectStatus: z
      .array(z.number().int().min(100).max(599))
      .max(10)
      .optional()
      .describe("stop when the status is one of these, e.g. [200]"),
    expectJson: z
      .object({
        path: z
          .string()
          .min(1)
          .describe('dotted path into the body, e.g. "status" or "data.state"'),
        op: z
          .enum(["exists", "equals", "notEquals", "contains", "gte", "lte"])
          .optional()
          .describe("default equals"),
        value: z.unknown().optional().describe("compared against; ignored by exists"),
      })
      .optional(),
    intervalMs: z
      .number()
      .int()
      .min(50)
      .max(60_000)
      .optional()
      .describe("milliseconds between attempts (default 1000)"),
    timeoutMs: deadlineSchema("the poll"),
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const url = parseUrl(input.url);
    if (typeof url === "string") return url;
    if (input.expectStatus === undefined && input.expectJson === undefined) {
      return "nothing to wait for — give expectStatus, expectJson, or both";
    }
    const prepared = prepareHeaders(input.headers, input.auth);
    if (!prepared.ok) return prepared.message;

    const cfg = configFor(ctx);
    const method = input.method ?? "GET";
    if (method === "HEAD" && input.expectJson !== undefined) {
      return "expectJson needs a body, so it cannot be used with method HEAD";
    }
    const wantStatus = new Set(input.expectStatus ?? []);
    const predicate: FieldPredicate | undefined =
      input.expectJson === undefined
        ? undefined
        : {
            path: input.expectJson.path,
            op: input.expectJson.op ?? "equals",
            value: input.expectJson.value,
          };
    const interval = input.intervalMs ?? 1000;
    const deadline = startDeadline(input.timeoutMs, ctx?.signal);
    const startedAt = Date.now();
    let attempts = 0;
    let lastStatus: number | undefined;
    let lastError: string | undefined;

    try {
      while (!deadline.expired()) {
        attempts++;
        try {
          const opened = await openRequest({
            url,
            method,
            headers: prepared.headers,
            signal: deadline.signal,
            cfg,
            redirect: "follow",
            credentialHeaders: prepared.secretHeaders,
          });
          lastStatus = opened.res.status;
          const statusOk = wantStatus.size === 0 || wantStatus.has(opened.res.status);
          let jsonOk = predicate === undefined;
          if (predicate !== undefined) {
            const body = await readCapped(opened.res, input.maxBytes ?? DEFAULT_MAX_BYTES);
            const parsed = parseJsonBody(body.text);
            if (parsed.ok) {
              jsonOk = matchesPredicateSafely(parsed.value, predicate);
              lastError = undefined;
            } else {
              jsonOk = false;
              lastError = parsed.message;
            }
          } else {
            try {
              await opened.res.body?.cancel();
            } catch {
              // already closed
            }
          }
          if (statusOk && jsonOk) {
            return json({
              met: true,
              attempts,
              lastStatus,
              elapsedMs: Date.now() - startedAt,
              stoppedBy: "condition",
            });
          }
        } catch (err) {
          // A refusal is a configuration fact, not a transient one — stop.
          if (err instanceof HttpPermissionError) return err.message;
          lastError = describeFailure(err, deadline);
        }
        const left = deadline.remaining();
        if (left <= 0) break;
        await sleep(Math.min(interval, left), deadline.signal);
      }
      return json({
        met: false,
        attempts,
        ...(lastStatus !== undefined ? { lastStatus } : {}),
        ...(lastError !== undefined ? { lastError } : {}),
        elapsedMs: Date.now() - startedAt,
        stoppedBy: ctx?.signal?.aborted === true ? "aborted" : "deadline",
      });
    } finally {
      deadline.cancel();
    }
  },
});

/**
 * `matchesPredicate`, with a malformed path reported as "no match" rather
 * than thrown: a poll loop that dies on a typo'd path is worse than one that
 * runs out its deadline and says the condition never held.
 */
function matchesPredicateSafely(body: unknown, predicate: FieldPredicate): boolean {
  try {
    return matchesPredicate(body, predicate);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// server-sent events
// ---------------------------------------------------------------------------

export const sseRead: RegisteredTool = buildTool({
  name: "SseRead",
  description:
    "Open a server-sent-events endpoint and collect events until a count, a terminator event name, or a required deadline — whichever comes first. Use it to capture a bounded slice of a streaming endpoint, such as a job's progress feed, in one call. It does not reconnect on Last-Event-ID, does not interpret the data payloads, and always closes the connection before returning. The terminator ends the read where it arrives, so events the server had already queued behind it are not returned.",
  inputSchema: z.object({
    url: urlSchema,
    headers: headersSchema,
    auth: authSchema,
    maxEvents: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("stop after this many events (default 50)"),
    terminatorEvent: z
      .string()
      .optional()
      .describe('stop when an event with this name arrives, e.g. "done"; the event is included'),
    timeoutMs: deadlineSchema("the read"),
    maxBytes: maxBytesSchema.describe("stop once this many stream bytes have been read"),
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const url = parseUrl(input.url);
    if (typeof url === "string") return url;
    const prepared = prepareHeaders(input.headers, input.auth);
    if (!prepared.ok) return prepared.message;
    setDefaultHeader(prepared.headers, "accept", "text/event-stream");

    const cfg = configFor(ctx);
    const maxEvents = input.maxEvents ?? 50;
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const deadline = startDeadline(input.timeoutMs, ctx?.signal);
    const collected: SseEvent[] = [];
    let bytes = 0;
    let stoppedBy = "streamEnded";
    let status = 0;

    try {
      const opened = await openRequest({
        url,
        method: "GET",
        headers: prepared.headers,
        signal: deadline.signal,
        cfg,
        redirect: "follow",
        credentialHeaders: prepared.secretHeaders,
      });
      status = opened.res.status;
      if (status < 200 || status >= 300 || opened.res.body === null) {
        try {
          await opened.res.body?.cancel();
        } catch {
          // already closed
        }
        return json({ status, count: 0, events: [], stoppedBy: "status", bytes: 0 });
      }

      const reader = opened.res.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const sse = new SseDecoder();
      try {
        while (true) {
          if (deadline.expired()) {
            stoppedBy = "deadline";
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            bytes += value.byteLength;
            for (const event of sse.push(decoder.decode(value, { stream: true }))) {
              collected.push(event);
              if (input.terminatorEvent !== undefined && event.event === input.terminatorEvent) {
                // The terminator ends the read. Events the server had already
                // pushed into the same chunk are dropped rather than returned
                // after the event that said the stream was finished.
                stoppedBy = "terminator";
                break;
              }
            }
          }
          if (stoppedBy === "terminator") break;
          if (collected.length >= maxEvents) {
            stoppedBy = "eventCap";
            break;
          }
          if (bytes >= maxBytes) {
            stoppedBy = "byteCap";
            break;
          }
        }
        if (stoppedBy === "streamEnded") {
          for (const event of sse.flush()) collected.push(event);
        }
      } catch (err) {
        stoppedBy = deadline.expired() ? "deadline" : "error";
        if (stoppedBy === "error" && !(err instanceof Error && err.name === "AbortError")) {
          return describeFailure(err, deadline);
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // already closed
        }
      }

      return json({
        status,
        count: Math.min(collected.length, maxEvents),
        events: collected.slice(0, maxEvents),
        bytes,
        stoppedBy,
      });
    } catch (err) {
      return describeFailure(err, deadline);
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// webhook signatures
// ---------------------------------------------------------------------------

const schemeSchema = z
  .enum(["timestamped", "body"])
  .describe(
    'timestamped = "t=<unix>,v1=<hex>" over "<unix>.<body>" (Stripe\'s shape); body = "sha256=<hex>" over the body alone (GitHub\'s shape)',
  );

export const webhookSign: RegisteredTool = buildTool({
  name: "WebhookSign",
  description:
    "Produce an HMAC webhook signature header over a payload, in either the timestamped scheme or the plain-body scheme. Use it to sign an outgoing webhook, or to build a realistic fixture for testing a receiver, without a code-execution round trip. The secret comes from a named environment variable and is never echoed; the payload is signed as the exact string given, so re-serialised JSON will not match what a receiver verifies.",
  inputSchema: z.object({
    scheme: schemeSchema,
    payload: z.string().describe("the exact body bytes to sign — not a re-serialised object"),
    secretEnvVar: z
      .string()
      .min(1)
      .describe("NAME of the environment variable holding the signing secret"),
    timestamp: z
      .number()
      .int()
      .optional()
      .describe(
        "unix SECONDS; required for the timestamped scheme, and required rather than defaulted so the result is reproducible",
      ),
    algorithm: z
      .enum(["sha256", "sha1"])
      .optional()
      .describe("default sha256; sha1 only for legacy receivers"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const secret = process.env[input.secretEnvVar];
    if (secret === undefined || secret === "") {
      return `environment variable "${input.secretEnvVar}" is unset or empty in this process`;
    }
    if (input.scheme === "timestamped" && input.timestamp === undefined) {
      return 'the timestamped scheme needs an explicit timestamp (unix seconds) — it is not defaulted to "now", so that the same call always produces the same signature';
    }
    const algorithm = input.algorithm ?? "sha256";
    const signature = hmacHex(
      secret,
      signedPayload(input.scheme, input.payload, input.timestamp),
      algorithm,
    );
    return json({
      header: formatHeader(input.scheme, signature, algorithm, input.timestamp),
      signature,
      algorithm,
      scheme: input.scheme,
      payloadBytes: Buffer.byteLength(input.payload, "utf8"),
    });
  },
});

export const webhookVerify: RegisteredTool = buildTool({
  name: "WebhookVerify",
  description:
    "Verify an inbound webhook signature header against a payload in constant time, rejecting a stale timestamp as a replay. Use it before acting on any webhook body, because an unverified payload is attacker-controlled input. The comparison does not short-circuit on the first differing byte, a timestamped signature outside the tolerance is refused even when its HMAC is correct, and the plain-body scheme carries no timestamp at all — so it offers no replay protection and the result says so.",
  inputSchema: z.object({
    scheme: schemeSchema,
    payload: z
      .string()
      .describe(
        "the exact body bytes as received — parsing and re-serialising breaks verification",
      ),
    signatureHeader: z.string().min(1).describe("the raw header value the sender transmitted"),
    secretEnvVar: z
      .string()
      .min(1)
      .describe("NAME of the environment variable holding the signing secret"),
    algorithm: z.enum(["sha256", "sha1"]).optional().describe("default sha256"),
    toleranceSeconds: z
      .number()
      .int()
      .min(1)
      .max(86_400)
      .optional()
      .describe("how old a timestamped signature may be (default 300)"),
    nowSeconds: z
      .number()
      .int()
      .optional()
      .describe("unix seconds to measure staleness against; omit to use this process's clock"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const secret = process.env[input.secretEnvVar];
    if (secret === undefined || secret === "") {
      return `environment variable "${input.secretEnvVar}" is unset or empty in this process`;
    }
    const result = verifySignature({
      scheme: input.scheme,
      body: input.payload,
      secret,
      header: input.signatureHeader,
      algorithm: input.algorithm ?? "sha256",
      ...(input.toleranceSeconds !== undefined ? { toleranceSeconds: input.toleranceSeconds } : {}),
      nowSeconds: input.nowSeconds ?? Math.floor(Date.now() / 1000),
    });
    return json({
      valid: result.valid,
      reason: result.reason,
      scheme: input.scheme,
      ...(result.ageSeconds !== undefined ? { ageSeconds: result.ageSeconds } : {}),
      ...(input.scheme === "body"
        ? {
            replayProtection: false,
            note: "the plain-body scheme carries no timestamp, so this check cannot detect a replay",
          }
        : { replayProtection: true }),
    });
  },
});

// ---------------------------------------------------------------------------
// DNS and TLS
// ---------------------------------------------------------------------------

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"] as const;

export const dnsLookup: RegisteredTool = buildTool({
  name: "DnsLookup",
  description:
    "Resolve A, AAAA, CNAME, MX, TXT and NS records for a hostname, reporting each type's answer or the error the resolver gave. Use it to confirm a domain's records line up with what a deployment expects — that a CNAME points where it should, that MX or TXT verification records landed — without a shell. Records are sorted for a stable result, TTLs are not reported, and the host must be named by an allow-listed origin. The timeout is one budget for the whole lookup, not one per record type, so a type that is never reached says so.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .describe("the hostname to resolve; must be named by an allow-listed origin"),
    types: z
      .array(z.enum(RECORD_TYPES))
      .min(1)
      .max(RECORD_TYPES.length)
      .optional()
      .describe('record types to ask for (default ["A"])'),
    timeoutMs: timeoutSchema.describe("milliseconds for the whole lookup (default 30000)"),
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const cfg = configFor(ctx);
    const host = input.name.trim().toLowerCase();
    try {
      assertHostAllowed(host, cfg);
    } catch (err) {
      return describeFailure(err);
    }
    const wanted = input.types ?? ["A"];
    // ONE budget for the whole lookup, as the description promises. Handing
    // the same timeout to each record type in turn means six types can take
    // six times the stated deadline, which is not a deadline.
    //
    // And ONE clock: the deadline's timer, and nothing else, spends it. This
    // used to measure what was left with `Date.now()` while a separate timer
    // enforced each type's share, and the two clocks disagree — a 1ms timer
    // can fire before the wall clock has moved a whole millisecond — so a type
    // could time out and the next still see budget left and be issued.
    const budget = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = startDeadline(budget);
    const records: Record<string, unknown> = {};
    const errors: Record<string, string> = {};

    try {
      for (const type of [...wanted].sort(byString)) {
        if (deadline.signal.aborted) {
          errors[type] =
            `the ${budget}ms lookup budget elapsed before this record type was asked for`;
          continue;
        }
        try {
          records[type] = await raceSignal(
            resolveOne(type, host),
            deadline.signal,
            `${type} lookup exceeded the ${budget}ms lookup budget`,
          );
        } catch (err) {
          const code = (err as { code?: string }).code;
          errors[type] = code ?? (err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      deadline.cancel();
    }
    return json({
      name: host,
      records,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    });
  },
});

/**
 * A seam for the record resolvers, so a test does not need a real one.
 *
 * `_setDnsLookup` in `./net` does this for the SSRF guard's lookup, and this
 * is the same idea for the query resolvers. Without it, the only way to
 * exercise the shared-budget path was to hope the real resolver took longer
 * than a millisecond — which it did on a developer's machine and did not on
 * CI, where `.invalid` is refused instantly.
 *
 * Production never sets this; it is `undefined` and the real resolvers run.
 */
export type DnsRecordResolver = (type: string, host: string) => Promise<unknown>;
let recordResolver: DnsRecordResolver | undefined;

/** Test seam. Pass `undefined` to restore the real resolvers. */
export function _setDnsRecordResolver(fn: DnsRecordResolver | undefined): void {
  recordResolver = fn;
}

async function resolveOne(type: string, host: string): Promise<unknown> {
  if (recordResolver !== undefined) return recordResolver(type, host);
  switch (type) {
    case "A":
      return (await resolve4(host)).sort(byString);
    case "AAAA":
      return (await resolve6(host)).sort(byString);
    case "CNAME":
      return (await resolveCname(host)).sort(byString);
    case "NS":
      return (await resolveNs(host)).sort(byString);
    case "TXT":
      // Each record arrives as chunks that must be concatenated, not joined
      // with a separator — a long TXT value is split at 255 bytes on the wire.
      return (await resolveTxt(host)).map((chunks) => chunks.join("")).sort(byString);
    case "MX":
      return (await resolveMx(host))
        .map((record) => ({ priority: record.priority, exchange: record.exchange }))
        .sort((a, b) => a.priority - b.priority || byString(a.exchange, b.exchange));
    default:
      throw new Error(`unsupported record type "${type}"`);
  }
}

export const tlsInspect: RegisteredTool = buildTool({
  name: "TlsInspect",
  description:
    "Open a TLS connection to a host and port and report the certificate chain: subject, issuer, validity window, days remaining, SANs and fingerprint. Use it to check an expiry date or confirm which certificate a host is actually serving, instead of shelling out to openssl. It completes the handshake without requiring a valid chain — reporting authorized and authorizationError rather than refusing — so an expired or self-signed certificate can still be examined, and daysRemaining is measured against this machine's clock.",
  inputSchema: z.object({
    host: z.string().min(1).describe("hostname; must be named by an allow-listed origin"),
    port: z.number().int().min(1).max(65_535).optional().describe("default 443"),
    servername: z.string().min(1).optional().describe("SNI name, when it differs from host"),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(60_000)
      .optional()
      .describe("handshake deadline (default 10000)"),
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const cfg = configFor(ctx);
    const host = input.host.trim().toLowerCase();
    const port = input.port ?? 443;
    let pinnedIp: string;
    try {
      assertHostAllowed(host, cfg);
      pinnedIp = await assertNotSsrf(host);
    } catch (err) {
      return describeFailure(err);
    }
    try {
      return await inspectCertificate(
        host,
        pinnedIp,
        port,
        input.servername ?? host,
        input.timeoutMs ?? 10_000,
      );
    } catch (err) {
      return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  },
});

function inspectCertificate(
  host: string,
  pinnedIp: string,
  port: number,
  servername: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Dial the address the SSRF gate vetted, with SNI and cert validation
    // still keyed to the real name — the same pinning the HTTP path uses.
    //
    // The deadline is enforced ON THE SOCKET, not by racing the promise: a
    // race settles the promise and leaves the connection open, so a host that
    // accepts the TCP connection and then says nothing would hold a file
    // descriptor and a TLS handshake buffer for as long as the process lives.
    const socket = tlsConnect(
      { host: pinnedIp, port, servername, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        try {
          const leaf = socket.getPeerCertificate(true);
          // One clock reading for the whole chain, so two certificates that
          // expire on the same day never report different days remaining.
          const now = Date.now();
          const chain: Array<Record<string, unknown>> = [];
          const seen = new Set<string>();
          let node: DetailedPeerCertificate | undefined = leaf;
          while (node !== undefined && chain.length < 10) {
            const key = node.fingerprint256 ?? formatDn(node.subject);
            if (seen.has(key)) break;
            seen.add(key);
            chain.push(summarizeCert(node, now));
            const issuer: DetailedPeerCertificate | undefined = node.issuerCertificate;
            node = issuer === node ? undefined : issuer;
          }
          const cipher = socket.getCipher();
          resolve(
            json({
              host,
              port,
              servername,
              authorized: socket.authorized,
              ...(socket.authorizationError !== undefined && socket.authorizationError !== null
                ? { authorizationError: String(socket.authorizationError) }
                : {}),
              ...(socket.getProtocol() !== null ? { protocol: socket.getProtocol() } : {}),
              ...(cipher !== null ? { cipher: cipher.name } : {}),
              certificate: chain[0] ?? {},
              chainLength: chain.length,
              chain: chain.slice(1),
            }),
          );
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          socket.destroy();
        }
      },
    );
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`TLS handshake with ${host}:${port} exceeded ${timeoutMs}ms`));
    });
    socket.once("error", (err: Error) => {
      socket.destroy();
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// robots, sitemaps, feeds
// ---------------------------------------------------------------------------

export const robotsCheck: RegisteredTool = buildTool({
  name: "RobotsCheck",
  description:
    "Fetch an origin's robots.txt and decide whether a given user-agent may fetch a given path, reporting the rule that decided it. Use it before crawling anything, so a harness does not learn about a site's rules by being blocked. It applies the RFC 9309 matching rules — longest match wins, Allow breaks a tie, and a 5xx on robots.txt means treat the whole site as disallowed — and it reports Crawl-delay without enforcing it, because pacing is the caller's decision.",
  inputSchema: z.object({
    url: urlSchema.describe("the URL you want to fetch; robots.txt is read from its origin"),
    userAgent: z
      .string()
      .min(1)
      .optional()
      .describe('the crawler name to evaluate as (default "*")'),
    timeoutMs: timeoutSchema,
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const url = parseUrl(input.url);
    if (typeof url === "string") return url;
    const cfg = configFor(ctx);
    const robotsUrl = new URL("/robots.txt", url);
    const userAgent = input.userAgent ?? "*";
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      const fetched = await fetchText(robotsUrl, cfg, deadline, 512 * 1024);
      if (fetched.status === 404 || fetched.status === 410) {
        return json({
          allowed: true,
          robotsUrl: robotsUrl.toString(),
          status: fetched.status,
          userAgent,
          sitemaps: [],
          reason: "no robots.txt is published, so nothing is disallowed",
        });
      }
      if (fetched.status >= 500) {
        return json({
          allowed: false,
          robotsUrl: robotsUrl.toString(),
          status: fetched.status,
          userAgent,
          sitemaps: [],
          reason:
            "robots.txt returned a server error; RFC 9309 says treat the site as fully disallowed until it recovers",
        });
      }
      if (fetched.status < 200 || fetched.status >= 300) {
        return json({
          allowed: false,
          robotsUrl: robotsUrl.toString(),
          status: fetched.status,
          userAgent,
          sitemaps: [],
          reason: `robots.txt answered HTTP ${fetched.status}, which is neither a fetch nor a clean absence — treated as disallowed`,
        });
      }
      const file = parseRobots(fetched.text);
      const target = `${url.pathname}${url.search}`;
      const verdict = evaluateRobots(file, userAgent, target);
      return json({
        allowed: verdict.allowed,
        robotsUrl: robotsUrl.toString(),
        status: fetched.status,
        userAgent,
        path: target,
        ...(verdict.rule !== undefined ? { rule: verdict.rule, ruleType: verdict.ruleType } : {}),
        ...(verdict.matchedAgent !== undefined ? { matchedAgent: verdict.matchedAgent } : {}),
        ...(verdict.crawlDelay !== undefined ? { crawlDelaySeconds: verdict.crawlDelay } : {}),
        sitemaps: [...file.sitemaps].sort(byString),
        ...(fetched.truncated ? { truncated: true } : {}),
      });
    } catch (err) {
      return describeFailure(err, deadline);
    } finally {
      deadline.cancel();
    }
  },
});

const documentSourceSchema = {
  text: z.string().optional().describe("the document itself, when you already have it"),
  url: urlSchema.optional().describe("fetch it from here instead; the origin must be allow-listed"),
  timeoutMs: timeoutSchema,
  maxBytes: maxBytesSchema,
};

/** Resolve a `text`-or-`url` document input to a string, or a readable refusal. */
async function documentBody(
  input: {
    text?: string | undefined;
    url?: string | undefined;
    timeoutMs?: number | undefined;
    maxBytes?: number | undefined;
  },
  ctx: ToolExecuteContext | undefined,
  toolName: string,
): Promise<{ ok: true; text: string; source: string } | { ok: false; message: string }> {
  if (input.text !== undefined && input.url !== undefined) {
    return { ok: false, message: `give ${toolName} either text or url, not both` };
  }
  if (input.text !== undefined) return { ok: true, text: input.text, source: "text" };
  if (input.url === undefined)
    return { ok: false, message: `${toolName} needs either text or url` };
  const url = parseUrl(input.url);
  if (typeof url === "string") return { ok: false, message: url };
  const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
  try {
    const fetched = await fetchText(
      url,
      configFor(ctx),
      deadline,
      input.maxBytes ?? DEFAULT_MAX_BYTES,
    );
    if (fetched.status < 200 || fetched.status >= 300) {
      return {
        ok: false,
        message: `HTTP ${fetched.status} from ${safeUrlLabel(fetched.finalUrl)}`,
      };
    }
    if (fetched.truncated) {
      return {
        ok: false,
        message: `the document exceeded the ${input.maxBytes ?? DEFAULT_MAX_BYTES}-byte cap, and a partial XML document cannot be parsed — raise maxBytes`,
      };
    }
    return { ok: true, text: fetched.text, source: fetched.finalUrl };
  } catch (err) {
    return { ok: false, message: describeFailure(err, deadline) };
  } finally {
    deadline.cancel();
  }
}

export const sitemapParse: RegisteredTool = buildTool({
  name: "SitemapParse",
  description:
    "Parse a sitemap into structured entries, either from text you already have or from an allow-listed URL, saying whether it was a urlset or a sitemapindex. Use it to turn a site's own index of itself into a work list without a model reading XML. It reads exactly one document — an index's children are not followed — and refuses a document with entity declarations or an internal DTD subset rather than expanding them.",
  inputSchema: z.object(documentSourceSchema),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const doc = await documentBody(input, ctx, "SitemapParse");
    if (!doc.ok) return doc.message;
    try {
      const result = parseSitemap(doc.text);
      return json({
        kind: result.kind,
        count: result.entries.length,
        source: doc.source,
        entries: result.entries,
        ...(result.kind === "sitemapindex"
          ? { note: "these are sitemaps, not pages — parse each one separately to get its URLs" }
          : {}),
      });
    } catch (err) {
      return `could not parse the sitemap: ${(err as Error).message}`;
    }
  },
});

export const feedParse: RegisteredTool = buildTool({
  name: "FeedParse",
  description:
    "Parse an RSS, RDF or Atom feed into a common entry shape, either from text you already have or from an allow-listed URL. Use it to read a changelog, release feed or blog without a model parsing XML by hand. Entries keep the feed's own order because that order is the signal, dates are returned exactly as the feed wrote them rather than normalised, and HTML inside a summary is left as-is.",
  inputSchema: z.object(documentSourceSchema),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  execute: async (input, ctx) => {
    const doc = await documentBody(input, ctx, "FeedParse");
    if (!doc.ok) return doc.message;
    try {
      const result = parseFeed(doc.text);
      return json({
        kind: result.kind,
        count: result.entries.length,
        source: doc.source,
        ...(result.title !== undefined ? { title: result.title } : {}),
        ...(result.link !== undefined ? { link: result.link } : {}),
        ...(result.description !== undefined ? { description: result.description } : {}),
        entries: result.entries,
      });
    } catch (err) {
      return `could not parse the feed: ${(err as Error).message}`;
    }
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const HTTP_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  dnsLookup,
  downloadFile,
  feedParse,
  graphqlQuery,
  headRequest,
  httpBatch,
  httpPaginate,
  httpRequest,
  httpWaitFor,
  linkCheck,
  robotsCheck,
  sitemapParse,
  sseRead,
  tlsInspect,
  urlReachable,
  webhookSign,
  webhookVerify,
]);
