import {
  type BoundaryResult,
  type TrustOrigin,
  classifyBoundary,
} from "@crewhaus/boundary-classifier";
/**
 * Section 47 — `chain-adapter-base`.
 *
 * Defines the `ChainAdapter` interface (mirror of `ChannelAdapter` from
 * §33) plus the wrap-on-read helpers that route every byte returned from
 * a chain node through the §41 boundary classifier with `origin: "chain"`.
 *
 * Catalog layer: R5 (protocol hosts). The slice-0 cut ships read-only
 * primitives — `call`, `getLogs`, `getTransaction`, `getBlockNumber` —
 * that any adapter (EVM today; Solana / Cosmos later) implements.
 * Destructive (signing) primitives live in `wallet-engine` (slice 1),
 * not here, so the read path stays simple and the classifier wrap
 * applies uniformly.
 *
 * Pillar 3 contract: every adapter SHALL route node responses through
 * `classifyChainPayload` before returning them to the runtime. The base
 * provides the helper; concrete adapters call it. The `crewhaus doctor
 * --philosophy-alignment` audit grep's for `classifyBoundary` /
 * `classifyChainPayload` inside each `chain-adapter-*` package — bypass
 * is a security regression, not a perf optimization.
 */
import { CrewhausError } from "@crewhaus/errors";

export class ChainAdapterError extends CrewhausError {
  override readonly name = "ChainAdapterError";
  readonly chainId: string;
  readonly method: string;

  constructor(chainId: string, method: string, message: string, cause?: unknown) {
    super("adapter", `[${chainId}] ${method}: ${message}`, cause);
    this.chainId = chainId;
    this.method = method;
  }
}

/**
 * A finality policy mirrors `IrChainFinality` from `@crewhaus/ir`. The
 * adapter base does not depend on `@crewhaus/ir` (to keep the runtime
 * dependency arrow pointing one way: IR → compiler → runtime, never the
 * reverse). Adapters receive this shape at construction.
 */
export type ChainFinality =
  | { readonly kind: "confirmations"; readonly count: number }
  | { readonly kind: "finalized" }
  | { readonly kind: "safe" };

export type RpcPolicy = "single" | "quorum" | "fallback";

export type ChainAdapterConfig = {
  readonly chainId: string;
  readonly rpcUrls: readonly string[];
  readonly rpcPolicy: RpcPolicy;
  readonly finality: ChainFinality;
  readonly reorgTolerant: boolean;
};

/**
 * Read-only adapter surface for slice 0. `call`, `getLogs`,
 * `getTransaction`, `getBlockNumber` cover the four primitives the
 * `tool-evm` read tools dispatch through. Each returns a structured
 * payload AFTER the wrap-on-read classifier has approved it; callers
 * never see raw node bytes that bypass the boundary.
 */
export interface ChainAdapter {
  readonly chainId: string;
  readonly config: ChainAdapterConfig;

  /**
   * EVM-style read: dispatches the JSON-RPC method against the
   * configured RPC URLs, classifies the response, and returns the
   * decoded value. Slice 0 surface is restricted to read methods —
   * `eth_call`, `eth_getLogs`, `eth_getTransactionByHash`,
   * `eth_blockNumber`, `eth_chainId`. Any attempt to dispatch a
   * write-class method (`eth_sendRawTransaction`, etc.) throws.
   */
  rpcRead(
    method: string,
    params: ReadonlyArray<unknown>,
    opts?: { readonly bypassCache?: boolean },
  ): Promise<unknown>;
}

/**
 * Whitelist of read-only JSON-RPC methods. Adding writes here is a
 * security regression — wallet-engine (slice 1) is the only path that
 * may broadcast transactions, and it goes through the permission
 * engine's approval gate first.
 */
const READ_ONLY_RPC_METHODS: ReadonlySet<string> = new Set([
  "eth_call",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_blockNumber",
  "eth_chainId",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "net_version",
]);

export function assertReadOnlyMethod(chainId: string, method: string): void {
  if (!READ_ONLY_RPC_METHODS.has(method)) {
    throw new ChainAdapterError(
      chainId,
      method,
      "method is not on the slice-0 read-only allowlist; signing flows land in slice 1 (wallet-engine)",
    );
  }
}

/**
 * Pillar 3 chokepoint for chain content. Wraps any string payload
 * before it reaches a model context or a tool result. Adapters that
 * return structured data (decoded log fields, JSON-RPC results)
 * should `JSON.stringify` the payload first; the classifier operates
 * on text. Callers receive the classifier's verdict + recommended
 * action so they can branch on `"redact"` vs `"pass"`/`"warn"`.
 */
export async function classifyChainPayload(
  payload: string,
  opts: {
    readonly origin?: TrustOrigin;
    readonly bypassCache?: boolean;
  } = {},
): Promise<BoundaryResult> {
  return classifyBoundary(payload, {
    origin: opts.origin ?? "chain",
    ...(opts.bypassCache !== undefined ? { bypassCache: opts.bypassCache } : {}),
  });
}

/**
 * Helper for adapters: given an `rpcPolicy`, return the urls in the
 * order they should be tried. `single` returns the head; `fallback`
 * returns the full list (callers try in order); `quorum` returns the
 * full list (callers issue concurrent requests). The base does not
 * implement the multi-URL dispatch — each adapter does — because
 * different chains have different retry / cache semantics.
 */
export function orderRpcUrls(urls: readonly string[], policy: RpcPolicy): readonly string[] {
  const first = urls[0];
  if (first === undefined) {
    throw new ChainAdapterError("?", "config", "rpcUrls must be non-empty");
  }
  if (policy === "single") return [first];
  return urls;
}
