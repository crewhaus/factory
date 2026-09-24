/**
 * Section 47 — `chain-adapter-evm`.
 *
 * Concrete EVM JSON-RPC adapter. Implements the `ChainAdapter` contract
 * from `@crewhaus/chain-adapter-base` for any EVM-compatible chain
 * (Ethereum, Base, Arbitrum, Optimism, Polygon, …). Dispatches
 * read-only methods against the configured `rpcUrls`, applies the
 * `rpcPolicy` (single / fallback / quorum), classifies every response
 * via the §41 boundary classifier with `origin: "chain"`, and decodes
 * standard JSON-RPC envelopes.
 *
 * Catalog layer: R5 (protocol hosts). Slice 0 surface = reads only;
 * sends and signs land in slice 1 with `wallet-engine`.
 */
import {
  type ChainAdapter,
  type ChainAdapterConfig,
  ChainAdapterError,
  type RpcReadOptions,
  assertReadOnlyMethod,
  classifyChainPayload,
  orderRpcUrls,
} from "@crewhaus/chain-adapter-base";
import { readResponseBounded, withRawBody } from "@crewhaus/tool-safety/streams";

/**
 * A read's deadline when the caller names none: across every URL it tries,
 * so a fallback list cannot multiply it.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * The most bytes of a JSON-RPC response this reads, decoded. A large
 * eth_getLogs or Multicall3 answer runs to megabytes; nothing a node should
 * send runs to more, and a body is held in memory whole.
 */
export const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: ReadonlyArray<unknown>;
};

type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: number; readonly result: unknown }
  | {
      readonly jsonrpc: "2.0";
      readonly id: number;
      readonly error: { readonly code: number; readonly message: string };
    };

/**
 * Construct an EVM adapter. The optional `fetchImpl` argument exists
 * for tests — production callers omit it and the adapter uses the
 * global `fetch`. The adapter is stateless; create it once at boot
 * and reuse across requests.
 */
export function createEvmAdapter(
  config: ChainAdapterConfig,
  fetchImpl: typeof fetch = fetch,
): ChainAdapter {
  let nextId = 1;

  return {
    chainId: config.chainId,
    config,

    async rpcRead(
      method: string,
      params: ReadonlyArray<unknown>,
      opts?: RpcReadOptions,
    ): Promise<unknown> {
      assertReadOnlyMethod(config.chainId, method);
      const urls = orderRpcUrls(config.rpcUrls, config.rpcPolicy);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new ChainAdapterError(
          config.chainId,
          method,
          `timeoutMs ${timeoutMs} is not a duration`,
        );
      }
      const deadline = AbortSignal.timeout(timeoutMs);
      const call: Dispatch = {
        chainId: config.chainId,
        method,
        params,
        fetchImpl,
        id: nextId++,
        signal: opts?.signal === undefined ? deadline : AbortSignal.any([opts.signal, deadline]),
        cancelled: () =>
          opts?.signal?.aborted === true
            ? "the read was cancelled"
            : deadline.aborted
              ? `no answer within ${timeoutMs} ms`
              : undefined,
        ...(opts?.bypassCache !== undefined ? { bypassCache: opts.bypassCache } : {}),
      };
      if (config.rpcPolicy === "quorum") return quorumDispatch(urls, call);
      // "single" was reduced to one URL by orderRpcUrls; "fallback"
      // iterates the full list and stops on the first success.
      return fallbackDispatch(urls, call);
    },
  };
}

/**
 * One adapter per declared chain, keyed by chain id — what a bundle builds
 * from the spec's `chains` block at boot, and what every chain-reading tool
 * package binds its seam to. Each RPC URL must be an absolute http(s) URL; a
 * refusal names the position, never the URL, whose path is where a provider
 * keeps its key.
 */
export function createEvmAdapters(
  chains: ReadonlyArray<ChainAdapterConfig>,
): ReadonlyMap<string, ChainAdapter> {
  const out = new Map<string, ChainAdapter>();
  chains.forEach((chain, i) => {
    if (chain.rpcUrls.length === 0) {
      throw new ChainAdapterError(chain.chainId, "boot", `chains[${i}] has no rpcUrls`);
    }
    chain.rpcUrls.forEach((raw, j) => {
      let url: URL | undefined;
      try {
        url = new URL(raw);
      } catch {
        url = undefined;
      }
      if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
        throw new ChainAdapterError(
          chain.chainId,
          "boot",
          `chains[${i}].rpcUrls[${j}] is not an absolute http(s) URL`,
        );
      }
    });
    if (out.has(chain.chainId)) {
      throw new ChainAdapterError(
        chain.chainId,
        "boot",
        `chains[${i}] repeats chain id "${chain.chainId}"`,
      );
    }
    out.set(chain.chainId, createEvmAdapter(chain));
  });
  return out;
}

/**
 * An RPC endpoint as a message may name it: scheme, host and port. Providers
 * put the API key in the path (`/v2/<key>`), and an error travels into tool
 * results and transcripts.
 */
function endpointLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "the RPC endpoint";
  }
}

/** One read, as every URL it is sent to sees it. */
type Dispatch = {
  readonly chainId: string;
  readonly method: string;
  readonly params: ReadonlyArray<unknown>;
  readonly fetchImpl: typeof fetch;
  readonly id: number;
  /** The caller's signal and the read's deadline, together. */
  readonly signal: AbortSignal;
  /** Why the read was stopped, once it was; undefined while it may go on. */
  readonly cancelled: () => string | undefined;
  readonly bypassCache?: boolean;
};

async function fallbackDispatch(urls: readonly string[], call: Dispatch): Promise<unknown> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await dispatchOne(url, call);
    } catch (err) {
      lastError = err;
      // A cancelled or timed-out read is over: the next URL would only be
      // asked after the caller stopped waiting.
      const stopped = call.cancelled();
      if (stopped !== undefined) {
        throw new ChainAdapterError(call.chainId, call.method, stopped);
      }
    }
  }
  throw new ChainAdapterError(
    call.chainId,
    call.method,
    `all ${urls.length} RPC URL(s) failed`,
    lastError,
  );
}

async function quorumDispatch(urls: readonly string[], call: Dispatch): Promise<unknown> {
  const { chainId, method } = call;
  const results = await Promise.allSettled(urls.map((u) => dispatchOne(u, call)));
  const stopped = call.cancelled();
  if (stopped !== undefined) throw new ChainAdapterError(chainId, method, stopped);
  const fulfilled = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (fulfilled.length === 0) {
    throw new ChainAdapterError(chainId, method, "quorum failed: every RPC URL rejected");
  }
  // Quorum: require a strict majority agree on the result. Compare
  // by JSON serialization so structural equality is bit-exact.
  const counts = new Map<string, { value: unknown; n: number }>();
  for (const v of fulfilled) {
    const k = JSON.stringify(v);
    const cur = counts.get(k);
    if (cur === undefined) counts.set(k, { value: v, n: 1 });
    else cur.n += 1;
  }
  const threshold = Math.floor(urls.length / 2) + 1;
  for (const { value, n } of counts.values()) {
    if (n >= threshold) return value;
  }
  throw new ChainAdapterError(
    chainId,
    method,
    `quorum failed: no value reached threshold ${threshold}/${urls.length}`,
  );
}

async function dispatchOne(url: string, call: Dispatch): Promise<unknown> {
  const { chainId, method, params, id } = call;
  const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  let res: Response;
  try {
    // The body stays encoded until the bounded reader decodes it, so a
    // compressed answer cannot inflate past the cap before it is counted.
    res = await call.fetchImpl(
      url,
      withRawBody({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: call.signal,
      }) as RequestInit,
    );
  } catch (err) {
    // No `cause`: a dialler's error can quote the URL it failed on, and a
    // provider keeps its key in the URL's path.
    const message = (err as Error).message.split(url).join(endpointLabel(url));
    throw new ChainAdapterError(chainId, method, `network error: ${message}`);
  }
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // already closed
    }
    throw new ChainAdapterError(chainId, method, `HTTP ${res.status} from ${endpointLabel(url)}`);
  }
  const read = await readResponseBounded(res, {
    maxBytes: MAX_RPC_RESPONSE_BYTES,
    signal: call.signal,
  });
  if (!read.ok) {
    throw new ChainAdapterError(
      chainId,
      method,
      `the response from ${endpointLabel(url)} could not be read: ${read.code === "aborted" ? (call.cancelled() ?? "the read was stopped") : read.reason}`,
    );
  }
  if (read.truncated) {
    // Parsing a prefix is not an option — half a JSON-RPC answer is either
    // an error or, worse, a shorter plausible one.
    throw new ChainAdapterError(
      chainId,
      method,
      `the response from ${endpointLabel(url)} is larger than ${MAX_RPC_RESPONSE_BYTES} bytes — refusing to read it`,
    );
  }
  const text = read.text;

  // Pillar 3: classify the raw response BEFORE parsing. The classifier
  // operates on text — JSON-RPC error messages, decoded log strings,
  // and any other vector through which an attacker could plant a
  // malicious payload all hit the classifier first.
  const boundary = await classifyChainPayload(text, {
    ...(call.bypassCache !== undefined ? { bypassCache: call.bypassCache } : {}),
  });
  if (boundary.action === "redact") {
    // The verbatim node response is suspected of carrying an injection
    // payload — refuse to bubble it up. The caller sees an error
    // rather than a redaction-string masquerading as data.
    throw new ChainAdapterError(
      chainId,
      method,
      "response from RPC node was classified malicious and refused",
    );
  }

  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(text) as JsonRpcResponse;
  } catch (err) {
    throw new ChainAdapterError(chainId, method, "response was not valid JSON", err);
  }
  if ("error" in parsed) {
    throw new ChainAdapterError(
      chainId,
      method,
      `RPC error ${parsed.error.code}: ${parsed.error.message}`,
    );
  }
  return parsed.result;
}
