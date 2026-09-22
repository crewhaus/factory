/**
 * The only part of this package that opens a socket.
 *
 * Everything the tool does with an OSV response is in `lib/osv.ts` and is
 * pure; what is left here is the request itself, the budget it runs under,
 * and the gate on where it may go. `_setFetch` is the seam every test drives
 * — a test that reached api.osv.dev would fail on a CI runner with no egress
 * and flake on somebody else's rate limit, so no test here has a code path
 * that can reach one.
 *
 * On where a request may go: the default destination is a constant, because
 * that is the whole point of a tool named after one database. An `endpoint`
 * override exists for a self-hosted OSV mirror, and it is gated twice — the
 * origin must be one the OPERATOR allow-listed in `tool_config.fetch`, and it
 * must still survive the SSRF check. A model-supplied URL that only had to
 * pass an IP check would be an exfiltration channel with a response that
 * lands straight back in the context window.
 */
import { CrewhausError } from "@crewhaus/errors";
import {
  FetchPermissionError,
  assertNotSsrf,
  canonicalizeOrigin,
  getFetchConfig,
} from "@crewhaus/tool-fetch";
import {
  type BatchHit,
  type Coordinate,
  type OsvAdvisory,
  buildQueryBatch,
  chunk,
  parseQueryBatchResponse,
  parseVulnRecord,
} from "./lib/osv";

/** The public, unauthenticated OSV API. Reads need no token. */
export const OSV_DEFAULT_ENDPOINT = "https://api.osv.dev";

/**
 * OSV documents a thousand queries per `querybatch` call; this is lower on
 * purpose. A smaller batch keeps one slow response from consuming the whole
 * budget, and keeps a retryable failure from throwing away a thousand
 * coordinates' worth of work.
 */
export const QUERY_BATCH_SIZE = 250;
/** Concurrent `/v1/vulns/{id}` hydrations. Politeness, not throughput. */
const HYDRATE_CONCURRENCY = 6;
/**
 * Distinct advisories whose full record is fetched.
 *
 * Hydration is one request per id, so an old lockfile with hundreds of
 * matches turns into hundreds of requests and a call that runs for minutes.
 * Beyond this cap the MATCH is still reported — it is real — but without
 * severity or a fix, and the caller is told how many were left that way.
 */
export const MAX_HYDRATIONS = 300;
/** Response body cap. A `querybatch` answer for 250 packages is far under it. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Raised when the database could not be consulted.
 *
 * This is deliberately an ERROR and not a result field: a supply-chain report
 * that came back empty because the network was down, and said so only in a
 * note, is a report a harness reads as "clean". The executor turns a throw
 * into `isError: true`, which no caller mistakes for an answer.
 */
export class OsvUnavailableError extends CrewhausError {
  override readonly name = "OsvUnavailableError";
  constructor(message: string) {
    super("tool", message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
let fetchFn: FetchLike = defaultFetch;

/** Test seam: replace the fetch used for every OSV call, or restore it. */
export function _setFetch(fn: FetchLike | undefined): void {
  fetchFn = fn ?? defaultFetch;
}

export type EndpointDecision =
  | { readonly ok: true; readonly base: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide where this call is allowed to go.
 *
 * The allow-list consulted is `tool_config.fetch.allowed_origins` — the one
 * the operator already writes for the `Fetch` tool — so a mirror is declared
 * in one place rather than per tool, and a model cannot widen it by passing a
 * different URL.
 */
export async function resolveEndpoint(endpoint: string | undefined): Promise<EndpointDecision> {
  if (endpoint === undefined || endpoint.trim() === "") {
    return { ok: true, base: OSV_DEFAULT_ENDPOINT };
  }
  let origin: string;
  try {
    origin = canonicalizeOrigin(endpoint);
  } catch (err) {
    return {
      ok: false,
      reason: `endpoint "${endpoint}" is not a usable http(s) origin: ${(err as Error).message}`,
    };
  }
  // Naming the default explicitly is the default, down to skipping the
  // resolver — otherwise the same destination would behave differently
  // depending on whether the caller spelled it out.
  if (origin === canonicalizeOrigin(OSV_DEFAULT_ENDPOINT)) {
    return { ok: true, base: OSV_DEFAULT_ENDPOINT };
  }
  {
    const allowed = getFetchConfig().allowedOrigins;
    if (!allowed.has(origin)) {
      return {
        ok: false,
        reason: `endpoint "${origin}" is not the public OSV API and is not in the operator's fetch allow-list. Add it to tool_config.fetch.allowed_origins to use a self-hosted OSV mirror; this tool will not take a destination from its own input alone.`,
      };
    }
  }
  try {
    await assertNotSsrf(new URL(origin).hostname);
  } catch (err) {
    if (err instanceof FetchPermissionError) return { ok: false, reason: err.message };
    return {
      ok: false,
      reason: `endpoint "${origin}" could not be resolved: ${(err as Error).message}`,
    };
  }
  return { ok: true, base: origin.replace(/\/+$/, "") };
}

export type RequestBudget = {
  readonly base: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

/**
 * Read a response body with a hard ceiling.
 *
 * `res.text()` buffers whatever arrives, and "whatever arrives" from a
 * self-hosted mirror is not a number this process chose. Streaming with a
 * counter is the only version of this that has a limit.
 */
async function readCapped(res: Response, url: string): Promise<string> {
  const body = res.body;
  if (body === null || body === undefined) return await res.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OsvUnavailableError(
          `${url} returned more than ${MAX_RESPONSE_BYTES} bytes; the response was abandoned rather than buffered`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of chunks) {
    joined.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** One request, with the timeout and the caller's cancellation both wired in. */
async function request(
  budget: RequestBudget,
  path: string,
  body: unknown | undefined,
): Promise<{ status: number; text: string }> {
  const url = `${budget.base}${path}`;
  const controller = new AbortController();
  // The reason is carried on the abort so the catch below can tell a timeout
  // from a caller's cancellation. Without it both arrive as the same
  // AbortError and the report would have to guess which happened.
  const timeoutReason = new OsvUnavailableError(
    `OSV did not answer ${path} within ${budget.timeoutMs}ms`,
  );
  const timer = setTimeout(() => controller.abort(timeoutReason), budget.timeoutMs);
  const onOuterAbort = (): void =>
    controller.abort(budget.signal?.reason ?? new Error("cancelled"));
  if (budget.signal !== undefined) {
    if (budget.signal.aborted) onOuterAbort();
    else budget.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    const res = await fetchFn(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    return { status: res.status, text: await readCapped(res, url) };
  } catch (err) {
    if (err instanceof OsvUnavailableError) throw err;
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof OsvUnavailableError) throw reason;
      throw new OsvUnavailableError(`the OSV query was cancelled before ${path} answered`);
    }
    throw new OsvUnavailableError(`could not reach ${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    budget.signal?.removeEventListener("abort", onOuterAbort);
  }
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new OsvUnavailableError(
      `OSV returned a body at ${path} that is not JSON (${(err as Error).message}); nothing was audited`,
    );
  }
}

/** Query every coordinate, in batches, and return the ids that matched. */
export async function queryBatches(
  budget: RequestBudget,
  coordinates: ReadonlyArray<Coordinate>,
): Promise<{ hits: BatchHit[]; batches: number }> {
  const groups = chunk(coordinates, QUERY_BATCH_SIZE);
  const hits: BatchHit[] = [];
  for (const group of groups) {
    const { status, text } = await request(budget, "/v1/querybatch", buildQueryBatch(group));
    if (status < 200 || status >= 300) {
      throw new OsvUnavailableError(
        `OSV answered /v1/querybatch with HTTP ${status}; no part of this lockfile was audited${status === 429 ? " — this is a rate limit, so retrying later is the fix" : ""}`,
      );
    }
    const parsed = parseQueryBatchResponse(parseJson(text, "/v1/querybatch"), group);
    if (!parsed.ok) throw new OsvUnavailableError(parsed.reason);
    hits.push(...parsed.hits);
  }
  return { hits, batches: groups.length };
}

export type HydrateResult = {
  readonly advisories: ReadonlyMap<string, OsvAdvisory>;
  /** Ids the database did not return a usable record for. */
  readonly unresolved: ReadonlyArray<string>;
  /** Ids whose record came back naming a DIFFERENT advisory. */
  readonly mismatched: ReadonlyArray<string>;
  /** Ids past `MAX_HYDRATIONS` — never requested, so never answered. */
  readonly notFetched: ReadonlyArray<string>;
};

/**
 * Fetch the full record for each id.
 *
 * `querybatch` answers with ids and a modification timestamp and nothing
 * else, so severity, the affected range and the fixed version all live behind
 * a second call. A 404 on one id does not sink the run — it is reported as
 * unresolved, because "OSV knows of this id but would not serve it" is a fact
 * about one advisory, not about the lockfile.
 *
 * The record is filed under the id that was REQUESTED. A body is not allowed
 * to say which advisory it is; see the comment at the check below.
 */
export async function hydrateAdvisories(
  budget: RequestBudget,
  ids: ReadonlyArray<string>,
): Promise<HydrateResult> {
  const advisories = new Map<string, OsvAdvisory>();
  const unresolved: string[] = [];
  const mismatched: string[] = [];
  // `ids` arrives sorted, so which ones fall past the cap is deterministic
  // rather than dependent on the order a lockfile happened to be read in.
  const queue = ids.slice(0, MAX_HYDRATIONS);
  const notFetched = ids.slice(MAX_HYDRATIONS);
  const workers = Array.from({ length: Math.min(HYDRATE_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      const path = `/v1/vulns/${encodeURIComponent(id)}`;
      const { status, text } = await request(budget, path, undefined);
      if (status < 200 || status >= 300) {
        unresolved.push(id);
        continue;
      }
      const record = parseVulnRecord(parseJson(text, path));
      if (record === undefined) {
        unresolved.push(id);
        continue;
      }
      // Filed under the id that was ASKED for, never the one the body claims.
      // Keying by `record.id` let a response decide which advisory it was
      // about: a record served for GHSA-a that names itself GHSA-b landed on
      // GHSA-b's entry — attributing one advisory's severity and fix to
      // another, and racing the real GHSA-b response for the slot, while
      // GHSA-a was reported as "OSV did not serve its record" although it
      // had. Same alignment rule as querybatch: refuse rather than attribute.
      if (record.id !== id) {
        mismatched.push(id);
        continue;
      }
      advisories.set(id, record);
    }
  });
  await Promise.all(workers);
  return { advisories, unresolved: unresolved.sort(), mismatched: mismatched.sort(), notFetched };
}
