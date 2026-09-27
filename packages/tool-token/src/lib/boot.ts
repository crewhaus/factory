/**
 * The two boot bindings this package's seams get in a compiled bundle,
 * `crewhaus run` and `crewhaus eval` — each from a spec block, each failing
 * closed without one.
 *
 *   - {@link bindTokenChains}: the chain reader, from the spec's `chains`
 *     block, through the same adapters `tool-evm` reads with.
 *   - {@link registerTokenConfig}: the metadata fetcher, from
 *     `tool_config.token.metadata_origins`, the operator's list of origins a
 *     contract's `tokenURI` may be read from. The caller's own `allowedHosts`
 *     and `ipfsGateway` still decide what is attempted; this list decides
 *     what can be dialled, and a model cannot widen it. And the Multicall3
 *     deployments in `tool_config.token.multicall3`, below.
 *
 * Still no dialling code here: the fetch goes through `@crewhaus/tool-http`'s
 * gate (allow-list, SSRF, no redirects, byte cap), and the chain read through
 * the adapter.
 */
import type { ChainAdapterConfig } from "@crewhaus/chain-adapter-base";
import { createEvmAdapters } from "@crewhaus/chain-adapter-evm";
import { guardedGet } from "@crewhaus/tool-http";
import { MULTICALL3_ADDRESS, parseMulticallMap } from "@crewhaus/tool-onchain";
import { TokenError, _setChainReader, chainReaderFromAdapters } from "./chain";
import { _setMetadataFetch } from "./uri";

/**
 * The operator's Multicall3 deployments by chain id, from
 * `tool_config.token.multicall3`. Only {@link registerTokenConfig} writes it.
 */
let configured: ReadonlyMap<string, string> = new Map();

/** A metadata document is small; a slow host should not hold a call open for long. */
const METADATA_TIMEOUT_MS = 10_000;

/** Bind the chain reader from the spec's `chains` block. */
export function bindTokenChains(config: {
  readonly chains: ReadonlyArray<ChainAdapterConfig>;
}): void {
  const adapters = createEvmAdapters(config.chains);
  _setChainReader(
    chainReaderFromAdapters((chainId) => adapters.get(chainId), [...adapters.keys()]),
  );
}

/** The spec's `tool_config.token` block. */
export type TokenConfigInput = {
  readonly metadata_origins?: ReadonlyArray<string>;
  readonly metadataOrigins?: ReadonlyArray<string>;
  /** chain id → the Multicall3 deployment batches on that chain go to. */
  readonly multicall3?: Readonly<Record<string, string>>;
};

/**
 * Apply `tool_config.token`: the Multicall3 deployments in `multicall3`, and
 * the metadata fetcher from `metadata_origins`. Only https origins are
 * accepted: a metadata document read over plain http is whatever the network
 * says it is. A block without the list binds no fetcher.
 */
export function registerTokenConfig(input: TokenConfigInput): void {
  const block = (input ?? {}) as Record<string, unknown>;
  configured = parseTokenMulticall(block["multicall3"]);
  if (Object.hasOwn(block, "metadata_origins") && Object.hasOwn(block, "metadataOrigins")) {
    throw new TokenError(
      "tool_config.token sets both metadata_origins and metadataOrigins. Write the list once, as metadata_origins.",
    );
  }
  const raw = block["metadata_origins"] ?? block["metadataOrigins"];
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.some((o) => typeof o !== "string")) {
    throw new TokenError(
      'tool_config.token.metadata_origins must be a list of https origins, for example ["https://ipfs.io"].',
    );
  }
  const origins: string[] = [];
  for (const origin of raw as string[]) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new TokenError(
        `tool_config.token.metadata_origins has "${origin}", which is not an origin. Write it as https://host.`,
      );
    }
    if (url.protocol !== "https:") {
      throw new TokenError(
        `tool_config.token.metadata_origins has "${url.protocol}//${url.host}", which is not https. Metadata is read over https only.`,
      );
    }
    origins.push(url.origin);
  }
  _setMetadataFetch(async ({ url, maxBytes, signal }) => {
    // One byte over the cap, so a document that fills it exactly is told
    // apart from one that was cut — `fetchDocument` refuses the latter.
    const got = await guardedGet(url, {
      allowedOrigins: origins,
      maxBytes: maxBytes + 1,
      timeoutMs: METADATA_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    });
    return { status: got.status, contentType: got.contentType, bytes: got.bytes };
  });
}

// ---------------------------------------------------------------------------
// the aggregator
// ---------------------------------------------------------------------------

/**
 * Which contract answers a batched read — decided by the operator, never by
 * a call.
 *
 * A batch is ONE `eth_call` to Multicall3, and every sub-result — decimals,
 * symbol, balances, allowances, `ownerOf`, the block number — is whatever
 * that contract returns. Any contract can implement `aggregate3` and return
 * rows it made up. So a model-supplied aggregator address was a way to make
 * TokenResolve report a decimals mismatch as `verified: true`, and
 * Erc20Balance report balances nobody holds.
 *
 * The aggregator is the canonical deployment unless the operator names
 * another for that chain in `tool_config.token.multicall3` (a chain whose
 * Multicall3 is elsewhere, such as zkSync Era). A call may still pass
 * `multicall3Address`, which older callers do, but only the address that
 * would be used anyway is accepted; anything else is refused before a read.
 */

/** Who served a batch, as every batched answer reports it. */
export type Aggregator = {
  /** EIP-55. */
  readonly address: string;
  /** `canonical`: the deterministic deploy. `config`: the operator's tool_config. */
  readonly source: "canonical" | "config";
};

/** Parse `tool_config.token.multicall3`, refusing a malformed entry by its key. */
function parseTokenMulticall(input: unknown): ReadonlyMap<string, string> {
  try {
    return parseMulticallMap(input, "tool_config.token.multicall3");
  } catch (err) {
    throw new TokenError((err as Error).message);
  }
}

/**
 * The map one call runs under: the serving candidate's own `tool_config`
 * block when it has one (it replaces the boot registration, as every
 * tool_config block does), else the boot registration.
 */
function mapFor(toolConfig: unknown): ReadonlyMap<string, string> {
  if (typeof toolConfig === "object" && toolConfig !== null && !Array.isArray(toolConfig)) {
    return parseTokenMulticall((toolConfig as Record<string, unknown>)["multicall3"]);
  }
  return configured;
}

/**
 * The aggregator a batch on `chainId` goes to, and where that came from. A
 * `requested` address other than that one is refused: which contract answers
 * every read is not a per-call choice.
 */
export function resolveAggregator(
  chainId: number,
  requested: string | undefined,
  toolConfig: unknown,
): Aggregator {
  const override = mapFor(toolConfig).get(String(chainId));
  const aggregator: Aggregator =
    override === undefined
      ? { address: MULTICALL3_ADDRESS, source: "canonical" }
      : { address: override, source: "config" };
  if (
    requested !== undefined &&
    requested.trim().toLowerCase() !== aggregator.address.toLowerCase()
  ) {
    throw new TokenError(
      `multicall3Address ${JSON.stringify(requested.slice(0, 64))} is not the Multicall3 chain ${chainId} reads through (${aggregator.address}). The aggregator answers every read in a batch — decimals, balances, the block number — so which contract that is belongs to the operator: name it in tool_config.token.multicall3 for chain ${chainId}. Or pass batch:false to read each call directly.`,
    );
  }
  return aggregator;
}
