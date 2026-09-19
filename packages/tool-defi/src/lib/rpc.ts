/**
 * The network posture for `@crewhaus/tool-defi`, and the two seams a test drives.
 *
 * Two kinds of byte leave this package: a JSON-RPC POST to a chain node, and a
 * GET to one of two pinned public price providers (see `./quotes`). Both go
 * through `defiFetch`, which `_setFetch` replaces, so no test in this package
 * resolves a name or opens a socket.
 *
 * **No caller ever supplies a URL.** An RPC endpoint comes from the operator's
 * `defi` tool_config block, keyed by chain id; a price provider's origin is a
 * constant in `./quotes`. That is the same stance `@crewhaus/tool-registry`
 * takes and it is what lets this file be short: there is no model-chosen host
 * to defend against, so there is no allow-list to widen and no SSRF gate to
 * get subtly wrong. It also means an operator's own node on `127.0.0.1:8545`
 * is a first-class endpoint rather than something a private-address rule has
 * to be argued out of.
 *
 * **Nothing here writes.** The method allow-list is `eth_call`,
 * `eth_getBalance`, `eth_blockNumber` and `eth_getBlockByNumber`, checked
 * against `@crewhaus/chain-adapter-base`'s shared read-only chokepoint first so
 * this package cannot drift from the runtime's own definition of a read. There
 * is no signing path, no `eth_sendRawTransaction` and no `eth_sendTransaction`,
 * and no schema in this package has a field to pass a key to.
 */
import { assertReadOnlyMethod } from "@crewhaus/chain-adapter-base";
import { CrewhausError } from "@crewhaus/errors";

/** A refusal this package chose: a missing endpoint, a bad shape, a write attempt. */
export class DefiError extends CrewhausError {
  override readonly name = "DefiError";
  constructor(message: string) {
    super("tool", message);
  }
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

/** A pinned oracle feed, so a caller can name "eth-usd" instead of an address. */
export type FeedPin = {
  readonly chainId: string;
  readonly kind: "chainlink" | "pyth";
  readonly address: string;
  /** Pyth's per-feed id. Required for a Pyth pin, meaningless for Chainlink. */
  readonly priceId?: string;
  /**
   * The feed's published heartbeat, in seconds. Optional because a heartbeat
   * is a property of the feed's deployment and is not readable from the
   * aggregator — a tool that guessed one would be inventing the threshold it
   * then judges against.
   */
  readonly heartbeatSeconds?: number;
};

export type DefiConfig = {
  /** chain id -> JSON-RPC endpoint. */
  readonly endpoints: ReadonlyMap<string, string>;
  /** chain id -> Multicall3 deployment, when it is not at the canonical address. */
  readonly multicall: ReadonlyMap<string, string>;
  /** feed name -> pin. */
  readonly feeds: ReadonlyMap<string, FeedPin>;
};

export type DefiConfigInput = {
  readonly rpc?: Record<string, string>;
  readonly multicall3?: Record<string, string>;
  readonly feeds?: Record<string, Record<string, unknown>>;
};

const EMPTY_CONFIG: DefiConfig = Object.freeze({
  endpoints: new Map(),
  multicall: new Map(),
  feeds: new Map(),
});

let bootConfig: DefiConfig = EMPTY_CONFIG;

function stringField(row: Record<string, unknown>, key: string, what: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DefiError(`${what}: "${key}" must be a non-empty string`);
  }
  return value.trim();
}

export function buildDefiConfig(input: DefiConfigInput): DefiConfig {
  const endpoints = new Map<string, string>();
  for (const [chainId, url] of Object.entries(input.rpc ?? {})) {
    if (typeof url !== "string") throw new DefiError(`rpc["${chainId}"] must be a URL string`);
    endpoints.set(String(chainId), assertEndpoint(url, chainId));
  }
  const multicall = new Map<string, string>();
  for (const [chainId, address] of Object.entries(input.multicall3 ?? {})) {
    if (typeof address !== "string") {
      throw new DefiError(`multicall3["${chainId}"] must be an address string`);
    }
    multicall.set(String(chainId), address.trim().toLowerCase());
  }
  const feeds = new Map<string, FeedPin>();
  for (const [name, row] of Object.entries(input.feeds ?? {})) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new DefiError(`feeds["${name}"] must be an object`);
    }
    const kind = stringField(row, "kind", `feeds["${name}"]`);
    if (kind !== "chainlink" && kind !== "pyth") {
      throw new DefiError(`feeds["${name}"].kind must be "chainlink" or "pyth", got "${kind}"`);
    }
    const priceId = row["price_id"];
    const heartbeat = row["heartbeat_seconds"];
    if (kind === "pyth" && typeof priceId !== "string") {
      // A Pyth contract serves every feed; without the id there is nothing to
      // ask it for, and defaulting to one would read some other asset's price.
      throw new DefiError(`feeds["${name}"]: a pyth feed needs "price_id"`);
    }
    feeds.set(name, {
      chainId: stringField(row, "chain_id", `feeds["${name}"]`),
      kind,
      address: stringField(row, "address", `feeds["${name}"]`),
      ...(typeof priceId === "string" ? { priceId } : {}),
      ...(typeof heartbeat === "number" && Number.isFinite(heartbeat) && heartbeat > 0
        ? { heartbeatSeconds: heartbeat }
        : {}),
    });
  }
  return { endpoints, multicall, feeds };
}

/** Replace the process-global config. Generated daemons call this at boot. */
export function registerDefiConfig(input: DefiConfigInput): void {
  bootConfig = buildDefiConfig(input);
}

export function getDefiConfig(): DefiConfig {
  return bootConfig;
}

/**
 * The config ONE call runs under: the serving candidate's `tool_config.defi`
 * block when it declares one, else the boot registration. A non-object
 * override is ignored rather than merged — an endpoint table only ever comes
 * from a spec block or from boot.
 */
export function resolveDefiConfig(override: unknown): DefiConfig {
  if (typeof override === "object" && override !== null && !Array.isArray(override)) {
    return buildDefiConfig(override as DefiConfigInput);
  }
  return bootConfig;
}

/** Test-only — back to an empty, fail-closed table. */
export function _resetDefiConfig(): void {
  bootConfig = EMPTY_CONFIG;
}

/**
 * Validate an endpoint at CONFIG time, not at first request.
 *
 * A typo in a spec block should fail when the spec is loaded, where somebody
 * is looking at the spec, rather than three tool calls into a run.
 */
function assertEndpoint(raw: string, chainId: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DefiError(`rpc["${chainId}"] is not an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DefiError(
      `rpc["${chainId}"] uses the "${url.protocol.replace(":", "")}" scheme; JSON-RPC over http(s) only`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new DefiError(
      `rpc["${chainId}"] carries userinfo (user:password@host) — a credential in a URL ends up in logs`,
    );
  }
  return url.toString();
}

/**
 * The only form an endpoint takes in a message or a result: scheme, host and
 * port, never the path.
 *
 * Provider RPC URLs carry the API key in the PATH — `/v2/<key>` at one vendor,
 * `/<key>` at another. Printing the endpoint in a refusal, a provenance field
 * or a caveat would put that key in a model's context and then in a transcript.
 */
export function endpointLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "the configured endpoint";
  }
}

/**
 * Take the endpoint back out of a message this package did not write.
 *
 * Every failure here is assembled from `endpointLabel` — and then has somebody
 * else's string concatenated onto it: the dialler's error, the node's own
 * JSON-RPC message, an HTTP status line. Those are the one place the key can
 * still get out, because a fetch implementation that reports "unable to
 * connect to <url>" is quoting a URL whose PATH is the credential. One
 * borrowed string undoes the labelling everywhere else, and it lands in a
 * model's context and from there in a transcript.
 *
 * The path and the query are redacted as well as the whole URL, so a message
 * that quotes only the tail is covered too.
 */
export function withoutEndpoint(message: string, endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return message;
  }
  const label = `${url.protocol}//${url.host}`;
  let out = message.split(endpoint).join(label);
  if (url.toString() !== endpoint) out = out.split(url.toString()).join(label);
  const tail = `${url.pathname}${url.search}`;
  if (tail.length > 1) out = out.split(tail).join("/<redacted>");
  if (url.pathname.length > 1) out = out.split(url.pathname).join("/<redacted>");
  if (url.search.length > 1) out = out.split(url.search).join("?<redacted>");
  return out;
}

export function requireEndpoint(config: DefiConfig, chainId: string): string {
  const endpoint = config.endpoints.get(chainId);
  if (endpoint === undefined) {
    const known = [...config.endpoints.keys()].sort();
    throw new DefiError(
      `no RPC endpoint is configured for chain "${chainId}" — add it to the defi tool_config block under rpc${
        known.length === 0 ? " (the table is empty)" : `; configured chains: ${known.join(", ")}`
      }`,
    );
  }
  return endpoint;
}

// ---------------------------------------------------------------------------
// the seams
// ---------------------------------------------------------------------------

export type DefiFetch = (req: Request) => Promise<Response>;

const realFetch: DefiFetch = (req) => globalThis.fetch(req);
let defiFetch: DefiFetch = realFetch;

/**
 * Test-only injection point, the convention every networked package here
 * follows. `undefined` restores the real dialler; a suite that sets it must
 * restore it, or the next file in the same bun process inherits the stub.
 */
export function _setFetch(fn: DefiFetch | undefined): void {
  defiFetch = fn ?? realFetch;
}

/** Epoch SECONDS, to match every onchain timestamp this package compares against. */
export type Clock = () => number;

const realClock: Clock = () => Math.floor(Date.now() / 1000);
let clock: Clock = realClock;

/**
 * Test-only clock. An oracle's age is the difference between two instants, and
 * a test that took the second one from the wall clock would be asserting how
 * fast the runner is. Every age in this package comes from here.
 */
export function _setClock(fn: Clock | undefined): void {
  clock = fn ?? realClock;
}

export function nowSeconds(): number {
  return clock();
}

// ---------------------------------------------------------------------------
// the request path
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 120_000;

/** 16 MB. An `eth_getLogs` answer is not read here; an `eth_call` result is small. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const USER_AGENT = "crewhaus-tool-defi (+https://github.com/crewhaus/factory)";

/**
 * The JSON-RPC methods this package may issue, narrower than the runtime's
 * read-only set because this package reads state and prices and nothing else.
 */
export const DEFI_RPC_METHODS: ReadonlySet<string> = new Set([
  "eth_call",
  "eth_getBalance",
  "eth_blockNumber",
  "eth_getBlockByNumber",
]);

export type TransportFailure = {
  readonly kind: "transport" | "status" | "rateLimited" | "malformed" | "rpcError" | "refused";
  readonly message: string;
  readonly status?: number;
  /** The JSON-RPC error code, when the node answered with one. */
  readonly code?: number;
};

export type RpcOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | ({ readonly ok: false } & TransportFailure);

export type RpcOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Only for the refusal message when a method is off the allow-list. */
  readonly chainId?: string;
};

/**
 * Issue one JSON-RPC call.
 *
 * Failures are RETURNED rather than thrown, because the caller with the most
 * at stake — `PortfolioValuation`, reading fifty assets — wants the asset that
 * failed named in its unpriced bucket rather than losing the other forty-nine.
 * A method outside the allow-list is the exception: that is a defect in this
 * package and it throws.
 */
export async function rpcCall<T = unknown>(
  endpoint: string,
  method: string,
  params: ReadonlyArray<unknown>,
  options: RpcOptions = {},
): Promise<RpcOutcome<T>> {
  // Two gates, the outer one shared with the runtime so this package cannot
  // quietly diverge from what the rest of CrewHaus calls a read.
  assertReadOnlyMethod(options.chainId ?? "defi", method);
  if (!DEFI_RPC_METHODS.has(method)) {
    throw new DefiError(
      `refusing to issue "${method}" — @crewhaus/tool-defi reads prices and balances, and its method set is ${[...DEFI_RPC_METHODS].sort().join(", ")}`,
    );
  }

  const label = endpointLabel(endpoint);
  const deadline = startDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    let res: Response;
    try {
      res = await defiFetch(
        new Request(endpoint, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": USER_AGENT,
          },
          body,
          signal: deadline.signal,
        }),
      );
    } catch (err) {
      const error = err as Error;
      if (error?.name === "AbortError" || deadline.signal.aborted) {
        return {
          ok: false,
          kind: "transport",
          message: `the deadline elapsed before ${label} answered ${method}`,
        };
      }
      return {
        ok: false,
        kind: "transport",
        message: `could not reach ${label}: ${withoutEndpoint(error?.message ?? String(err), endpoint)}`,
      };
    }

    if (res.status >= 300 && res.status < 400) {
      await discard(res);
      // Not followed. A JSON-RPC endpoint that redirects is a proxy nobody
      // configured, and a POST body forwarded to it goes somewhere the
      // operator did not name.
      return {
        ok: false,
        kind: "refused",
        status: res.status,
        message: `${label} answered ${res.status} with a redirect; a JSON-RPC POST is not followed to another host`,
      };
    }
    if (res.status === 429) {
      await discard(res);
      const retryAfter = res.headers.get("retry-after");
      return {
        ok: false,
        kind: "rateLimited",
        status: 429,
        message: `${label} rate-limited this read${retryAfter === null ? "" : `; it asked for ${retryAfter}s`} — this package does not retry, so the caller decides when to ask again`,
      };
    }
    if (!res.ok) {
      await discard(res);
      return {
        ok: false,
        kind: "status",
        status: res.status,
        message: withoutEndpoint(
          `${label} answered ${res.status} ${res.statusText}`.trimEnd(),
          endpoint,
        ),
      };
    }

    const text = await readCapped(res, MAX_RESPONSE_BYTES);
    if (text === null) {
      return {
        ok: false,
        kind: "malformed",
        message: `${label} sent more than ${MAX_RESPONSE_BYTES} bytes for ${method} — refusing to answer from a prefix of it`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        kind: "malformed",
        message: `${label} answered ${method} with bytes that are not JSON: ${withoutEndpoint((err as Error).message, endpoint)}`,
      };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        kind: "malformed",
        message: `${label} answered ${method} with a non-object`,
      };
    }
    const envelope = parsed as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (envelope.error !== undefined && envelope.error !== null) {
      const code = typeof envelope.error.code === "number" ? envelope.error.code : undefined;
      const message =
        typeof envelope.error.message === "string" ? envelope.error.message : "no message";
      return {
        ok: false,
        kind: "rpcError",
        message: `${label} refused ${method}: ${withoutEndpoint(message, endpoint)}`,
        ...(code === undefined ? {} : { code }),
      };
    }
    if (!("result" in envelope)) {
      // A node that answered 200 with neither result nor error. Reading that
      // as `undefined` downstream would decode to an empty answer, which the
      // word decoders turn into zeros.
      return {
        ok: false,
        kind: "malformed",
        message: `${label} answered ${method} with neither a result nor an error`,
      };
    }
    return { ok: true, value: envelope.result as T };
  } finally {
    deadline.cancel();
  }
}

/**
 * GET a JSON document, through the same seam and the same cap.
 *
 * The URL is never a caller's: `./quotes` builds it from one of two origin
 * constants and re-checks the origin before dialling. Redirects are NOT
 * followed — a price provider that 302s somewhere else is not a price
 * provider, and following it is how an answer arrives from a host nobody
 * configured.
 */
export async function getJson(
  url: string,
  options: RpcOptions & { readonly accept?: string } = {},
): Promise<RpcOutcome<unknown>> {
  const label = endpointLabel(url);
  const deadline = startDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
  try {
    let res: Response;
    try {
      res = await defiFetch(
        new Request(url, {
          method: "GET",
          redirect: "manual",
          headers: { accept: options.accept ?? "application/json", "user-agent": USER_AGENT },
          signal: deadline.signal,
        }),
      );
    } catch (err) {
      const error = err as Error;
      if (error?.name === "AbortError" || deadline.signal.aborted) {
        return {
          ok: false,
          kind: "transport",
          message: `the deadline elapsed before ${label} answered`,
        };
      }
      return {
        ok: false,
        kind: "transport",
        message: `could not reach ${label}: ${withoutEndpoint(error?.message ?? String(err), url)}`,
      };
    }
    if (res.status >= 300 && res.status < 400) {
      await discard(res);
      return {
        ok: false,
        kind: "refused",
        status: res.status,
        message: `${label} answered ${res.status} with a redirect; a price read is not followed to another host`,
      };
    }
    if (res.status === 429) {
      await discard(res);
      const retryAfter = res.headers.get("retry-after");
      return {
        ok: false,
        kind: "rateLimited",
        status: 429,
        message: `${label} rate-limited this read${retryAfter === null ? "" : `; it asked for ${retryAfter}s`} — this package does not retry`,
      };
    }
    if (!res.ok) {
      await discard(res);
      return {
        ok: false,
        kind: "status",
        status: res.status,
        message: withoutEndpoint(
          `${label} answered ${res.status} ${res.statusText}`.trimEnd(),
          url,
        ),
      };
    }
    const text = await readCapped(res, MAX_RESPONSE_BYTES);
    if (text === null) {
      return {
        ok: false,
        kind: "malformed",
        message: `${label} sent more than ${MAX_RESPONSE_BYTES} bytes`,
      };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (err) {
      return {
        ok: false,
        kind: "malformed",
        message: `${label} answered bytes that are not JSON: ${withoutEndpoint((err as Error).message, url)}`,
      };
    }
  } finally {
    deadline.cancel();
  }
}

/** `eth_call` at a named block, returning the raw 0x hex. */
export async function ethCall(
  endpoint: string,
  to: string,
  data: string,
  blockTag: string,
  options: RpcOptions = {},
): Promise<RpcOutcome<string>> {
  const outcome = await rpcCall<unknown>(endpoint, "eth_call", [{ to, data }, blockTag], options);
  if (!outcome.ok) return outcome;
  if (typeof outcome.value !== "string") {
    return { ok: false, kind: "malformed", message: "eth_call returned something other than hex" };
  }
  return { ok: true, value: outcome.value };
}

/** The native-coin balance of an address, in wei, at a named block. */
export async function ethGetBalance(
  endpoint: string,
  address: string,
  blockTag: string,
  options: RpcOptions = {},
): Promise<RpcOutcome<bigint>> {
  const outcome = await rpcCall<unknown>(endpoint, "eth_getBalance", [address, blockTag], options);
  if (!outcome.ok) return outcome;
  return toBigintOutcome(outcome.value, "eth_getBalance");
}

/** The head block number. */
export async function ethBlockNumber(
  endpoint: string,
  options: RpcOptions = {},
): Promise<RpcOutcome<bigint>> {
  const outcome = await rpcCall<unknown>(endpoint, "eth_blockNumber", [], options);
  if (!outcome.ok) return outcome;
  return toBigintOutcome(outcome.value, "eth_blockNumber");
}

function toBigintOutcome(value: unknown, method: string): RpcOutcome<bigint> {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    return {
      ok: false,
      kind: "malformed",
      message: `${method} returned "${String(value)}", which is not a quantity`,
    };
  }
  return { ok: true, value: BigInt(value) };
}

/**
 * Turn a block number into the tag every read in one answer shares.
 *
 * A valuation assembled from reads at different heights is a number that never
 * existed: balances from one block, a price from the next. Every tool here
 * resolves ONE tag up front and passes it down.
 */
export function blockTagOf(blockNumber: bigint | undefined): string {
  return blockNumber === undefined ? "latest" : `0x${blockNumber.toString(16)}`;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed — nothing to release
  }
}

/** Read a body with a hard byte cap, cancelling the stream once it is passed. */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (res.body === null) {
    const text = await res.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      if (total + value.byteLength > maxBytes) {
        over = true;
        try {
          await reader.cancel();
        } catch {
          // already aborting
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  if (over) return null;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

export type Deadline = { readonly signal: AbortSignal; cancel(): void };

/**
 * A deadline that also honours the runtime's own cancellation. Every call
 * opens one and cancels it in a `finally` — a timer left running holds the
 * process open past the answer.
 */
export function startDeadline(ms: number, outer?: AbortSignal): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`deadline of ${ms}ms elapsed`)), ms);
  const onOuter = (): void => controller.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

/**
 * Run `work` over `items` with at most `limit` in flight, preserving input
 * order in the result. Order is preserved because the output is a TABLE, and a
 * row order that depends on which read answered first is a diff that changes
 * between two identical runs.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await work(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return out;
}

/** Compact JSON — every byte returned is a byte in somebody's context window. */
export const json = (value: unknown): string => JSON.stringify(value);
