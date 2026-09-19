/**
 * One JSON-RPC request, done carefully, and the only way out of this package.
 *
 * Three properties the code below exists to hold:
 *
 *   1. **Nothing here can send a transaction.** Every method name goes through
 *      `assertReadOnlyMethod` from `@crewhaus/chain-adapter-base` — the same
 *      allow-list the adapters use — before a socket is opened. That makes the
 *      "this package only reads" claim structural rather than a promise about
 *      the seven call sites: `eth_sendRawTransaction` throws here even if some
 *      future edit asks for it. `index.test.ts` asserts it.
 *   2. **Failures are returned, not thrown.** A tool that polls, pages or
 *      probes several endpoints needs to branch on WHY a call failed — a
 *      halve-and-retry on a range cap is right, a halve-and-retry on a 401 is
 *      a denial-of-service against somebody's endpoint. `RpcOutcome` keeps
 *      those apart. The refusals a caller can fix (a bad URL, a write method)
 *      still throw, because they are not something to branch on.
 *   3. **The URL never appears in an error.** Provider keys live in the path —
 *      `…/v2/<key>` on Alchemy, `…/v3/<key>` on Infura — so messages carry the
 *      origin only. An error that quotes the endpoint is how a key reaches a
 *      transcript.
 */
import { assertReadOnlyMethod } from "@crewhaus/chain-adapter-base";
import { type VettedEndpoint, vetEndpoint } from "./endpoint";
import { ChainReadError } from "./quantity";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 120_000;

/**
 * 16 MB. A single `eth_getLogs` page of ten thousand logs is a few megabytes;
 * this is generous enough that no honest answer hits it and small enough that a
 * broken endpoint streaming forever cannot pin the process.
 */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

const USER_AGENT = "crewhaus-tool-chainread (+https://github.com/crewhaus/factory)";

/**
 * Why a call did not produce a result. These are not collapsible into one
 * boolean: `rpcError` is the node answering a question, `transport` is the node
 * not answering, and the log scanner treats them completely differently.
 */
export type RpcFailureKind =
  | "transport"
  | "timeout"
  | "status"
  | "malformed"
  | "tooLarge"
  | "rpcError";

export type RpcOutcome =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly kind: RpcFailureKind;
      readonly message: string;
      /** The JSON-RPC error code, when the node sent one. -32000 is "server error, good luck". */
      readonly code?: number;
      readonly status?: number;
      readonly data?: unknown;
    };

export type RpcFetch = (req: Request, pinnedIp: string) => Promise<Response>;

/**
 * Dial the vetted IP while keeping the real hostname for the Host header and
 * TLS SNI, so virtual hosting and certificate validation still work. Mirrors
 * `tool-containers`' dialer rather than re-deriving it: resolving in the guard
 * and letting `fetch` re-resolve at connect time is the rebinding TOCTOU the
 * guard exists to close.
 *
 * This function is the one place in the package a test never executes, because
 * executing it means opening a socket.
 */
const pinnedFetch: RpcFetch = async (req, pinnedIp) => {
  const original = new URL(req.url);
  const host = original.hostname;
  const unbracketed = host.replace(/^\[/, "").replace(/\]$/, "");
  if (pinnedIp === "" || unbracketed === pinnedIp) return globalThis.fetch(req);

  const pinnedUrl = new URL(original.toString());
  pinnedUrl.hostname = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;
  const headers = new Headers(req.headers);
  headers.set("host", original.port === "" ? host : `${host}:${original.port}`);
  // Re-read the body as a string rather than forwarding the Request's stream:
  // a streaming body needs duplex support that runtimes disagree about, and a
  // JSON-RPC envelope is a few hundred bytes.
  const body = await req.text();
  const init: RequestInit & { tls?: { serverName: string } } = {
    method: req.method,
    headers,
    body,
    signal: req.signal,
    redirect: "manual",
    tls: { serverName: host },
  };
  return globalThis.fetch(pinnedUrl.toString(), init);
};

let rpcFetch: RpcFetch = pinnedFetch;

/**
 * Test seam — `_setFetch(undefined)` restores the production dialer. A suite
 * that sets it must restore it, or the next file in the same bun process
 * inherits the stub.
 */
export function _setFetch(fn: RpcFetch | undefined): void {
  rpcFetch = fn ?? pinnedFetch;
}

export type RpcClientOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
};

export type RpcClient = {
  /** Scheme + host + port. Safe to print; the path, which may hold a key, is not. */
  readonly origin: string;
  /** How many requests this client has issued, so a tool can report what it cost. */
  calls: number;
  call(method: string, params: ReadonlyArray<unknown>): Promise<RpcOutcome>;
};

/**
 * Vet the URL once, then reuse the verdict for every call on it.
 *
 * `EvmEventScan` issues dozens of requests against one endpoint and
 * `EvmWaitForReceipt` issues one per poll; re-resolving the host each time
 * would be a DNS query per call, and — worse — would let the answer change
 * mid-scan, which is precisely the rebinding the pin defends against.
 */
export async function openRpc(rawUrl: string, options: RpcClientOptions = {}): Promise<RpcClient> {
  const endpoint = await vetEndpoint(rawUrl);
  return clientFor(endpoint, options);
}

function clientFor(endpoint: VettedEndpoint, options: RpcClientOptions): RpcClient {
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const origin = endpoint.url.origin;
  let nextId = 1;

  const client: RpcClient = {
    origin,
    calls: 0,
    async call(method, params) {
      assertReadOnlyMethod(origin, method);
      client.calls += 1;
      return request(endpoint, {
        id: nextId++,
        method,
        params,
        timeoutMs,
        maxBytes,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    },
  };
  return client;
}

type RequestSpec = {
  readonly id: number;
  readonly method: string;
  readonly params: ReadonlyArray<unknown>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
};

async function request(endpoint: VettedEndpoint, spec: RequestSpec): Promise<RpcOutcome> {
  const origin = endpoint.url.origin;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: spec.id,
    method: spec.method,
    params: spec.params,
  });

  const timer = new AbortController();
  const handle = setTimeout(() => timer.abort(new Error("deadline")), spec.timeoutMs);
  const onOuterAbort = () => timer.abort();
  spec.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await rpcFetch(
        new Request(endpoint.url.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": USER_AGENT,
          },
          body,
          redirect: "manual",
          signal: timer.signal,
        }),
        endpoint.pinnedIp,
      );
    } catch (err) {
      const error = err as Error;
      const aborted = error?.name === "AbortError" || timer.signal.aborted;
      // The caller's own signal and our deadline both surface as an abort, and
      // they are different situations: one means the run is shutting down, the
      // other means this endpoint is slow. Only the second is worth retrying.
      if (aborted && spec.signal?.aborted === true) {
        return {
          ok: false,
          kind: "timeout",
          message: `the run was cancelled while ${origin} was answering ${spec.method}`,
        };
      }
      if (aborted) {
        return {
          ok: false,
          kind: "timeout",
          message: `${origin} did not answer ${spec.method} within ${spec.timeoutMs}ms`,
        };
      }
      return {
        ok: false,
        kind: "transport",
        message: `could not reach ${origin}: ${error?.message ?? String(err)}`,
      };
    }

    // A redirect is not followed. An RPC endpoint that 302s is either
    // misconfigured or pointing somewhere the guard never vetted, and the
    // second is the whole reason `redirect: "manual"` is set.
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        kind: "status",
        status: res.status,
        message: `${origin} answered ${res.status} with a redirect — refusing to follow it to a host that was never vetted`,
      };
    }

    let text: string;
    try {
      text = await readCapped(res, spec.maxBytes);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        return {
          ok: false,
          kind: "tooLarge",
          message: `${origin} sent more than ${spec.maxBytes} bytes for ${spec.method} — refusing to parse a prefix of it`,
        };
      }
      return {
        ok: false,
        kind: "transport",
        message: `${origin} closed the connection while sending ${spec.method}`,
      };
    }

    if (res.status < 200 || res.status >= 300) {
      // Providers rate-limit with 429 and a JSON-RPC body, so the status is
      // reported alongside whatever the body said rather than instead of it.
      return {
        ok: false,
        kind: "status",
        status: res.status,
        message: `${origin} answered HTTP ${res.status} for ${spec.method}: ${snippet(text)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        kind: "malformed",
        message: `${origin} answered ${spec.method} with something that is not JSON: ${snippet(text)}`,
      };
    }

    if (Array.isArray(parsed)) {
      return {
        ok: false,
        kind: "malformed",
        message: `${origin} answered a single ${spec.method} request with a batch array`,
      };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        ok: false,
        kind: "malformed",
        message: `${origin} answered ${spec.method} with ${snippet(text)}, not a JSON-RPC envelope`,
      };
    }

    const envelope = parsed as Record<string, unknown>;
    const rpcErr = envelope["error"];
    if (rpcErr !== undefined && rpcErr !== null) {
      const asObject = typeof rpcErr === "object" ? (rpcErr as Record<string, unknown>) : {};
      const code = typeof asObject["code"] === "number" ? (asObject["code"] as number) : undefined;
      // Capped here rather than where it is read. This string is the one field
      // in the exchange the endpoint fills in freely, it arrives inside a body
      // allowed up to `maxBytes`, and from here it goes into a refusal, a tool
      // result and a model's context. A provider's longest real message is a
      // sentence and a suggested range.
      const message =
        typeof asObject["message"] === "string"
          ? capMessage(asObject["message"] as string)
          : snippet(text);
      return {
        ok: false,
        kind: "rpcError",
        message,
        ...(code !== undefined ? { code } : {}),
        ...(asObject["data"] !== undefined ? { data: asObject["data"] } : {}),
      };
    }

    if (!("result" in envelope)) {
      return {
        ok: false,
        kind: "malformed",
        message: `${origin} answered ${spec.method} with neither a result nor an error`,
      };
    }
    return { ok: true, result: envelope["result"] };
  } finally {
    clearTimeout(handle);
    spec.signal?.removeEventListener("abort", onOuterAbort);
  }
}

class BodyTooLarge extends Error {}

/**
 * Read a body with a ceiling, WHILE reading.
 *
 * `await res.text()` would buffer whatever arrives first and check afterwards,
 * which is no ceiling at all against an endpoint that streams. Stopping at the
 * cap and refusing is also why the result is never parsed as a prefix: half a
 * log array parses to a plausible SHORTER answer, which is the failure mode
 * this whole package is organised against.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLarge();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** The longest JSON-RPC error message this package will carry. */
export const MAX_ERROR_MESSAGE_CHARS = 2_000;

function capMessage(text: string): string {
  return text.length <= MAX_ERROR_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}… (truncated from ${text.length} characters)`;
}

/** Enough of a body to recognise it, never enough to paste a secret into a transcript. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** Turn a failed outcome into the refusal a tool throws, with the reason kept. */
export function failed(outcome: Extract<RpcOutcome, { ok: false }>, what: string): ChainReadError {
  const code = outcome.code === undefined ? "" : ` (code ${outcome.code})`;
  return new ChainReadError(`${what}: ${outcome.message}${code} [${outcome.kind}]`);
}

/** Call, or throw the refusal. For the steps where there is nothing to fall back to. */
export async function callOrThrow(
  client: RpcClient,
  method: string,
  params: ReadonlyArray<unknown>,
  what: string,
): Promise<unknown> {
  const outcome = await client.call(method, params);
  if (!outcome.ok) throw failed(outcome, what);
  return outcome.result;
}
