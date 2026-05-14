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
  assertReadOnlyMethod,
  classifyChainPayload,
  orderRpcUrls,
} from "@crewhaus/chain-adapter-base";

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
      opts?: { readonly bypassCache?: boolean },
    ): Promise<unknown> {
      assertReadOnlyMethod(config.chainId, method);
      const urls = orderRpcUrls(config.rpcUrls, config.rpcPolicy);

      if (config.rpcPolicy === "quorum") {
        return quorumDispatch(config.chainId, urls, method, params, fetchImpl, nextId++, opts);
      }
      // "single" was reduced to one URL by orderRpcUrls; "fallback"
      // iterates the full list and stops on the first success.
      return fallbackDispatch(config.chainId, urls, method, params, fetchImpl, nextId++, opts);
    },
  };
}

async function fallbackDispatch(
  chainId: string,
  urls: readonly string[],
  method: string,
  params: ReadonlyArray<unknown>,
  fetchImpl: typeof fetch,
  id: number,
  opts?: { readonly bypassCache?: boolean },
): Promise<unknown> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await dispatchOne(chainId, url, method, params, fetchImpl, id, opts);
    } catch (err) {
      lastError = err;
    }
  }
  throw new ChainAdapterError(chainId, method, `all ${urls.length} RPC URL(s) failed`, lastError);
}

async function quorumDispatch(
  chainId: string,
  urls: readonly string[],
  method: string,
  params: ReadonlyArray<unknown>,
  fetchImpl: typeof fetch,
  id: number,
  opts?: { readonly bypassCache?: boolean },
): Promise<unknown> {
  const results = await Promise.allSettled(
    urls.map((u) => dispatchOne(chainId, u, method, params, fetchImpl, id, opts)),
  );
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

async function dispatchOne(
  chainId: string,
  url: string,
  method: string,
  params: ReadonlyArray<unknown>,
  fetchImpl: typeof fetch,
  id: number,
  opts?: { readonly bypassCache?: boolean },
): Promise<unknown> {
  const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ChainAdapterError(chainId, method, `network error: ${(err as Error).message}`, err);
  }
  if (!res.ok) {
    throw new ChainAdapterError(chainId, method, `HTTP ${res.status} from ${url}`);
  }
  const text = await res.text();

  // Pillar 3: classify the raw response BEFORE parsing. The classifier
  // operates on text — JSON-RPC error messages, decoded log strings,
  // and any other vector through which an attacker could plant a
  // malicious payload all hit the classifier first.
  const boundary = await classifyChainPayload(text, {
    ...(opts?.bypassCache !== undefined ? { bypassCache: opts.bypassCache } : {}),
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
