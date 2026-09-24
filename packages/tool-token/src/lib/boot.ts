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
 *     what can be dialled, and a model cannot widen it.
 *
 * Still no dialling code here: the fetch goes through `@crewhaus/tool-http`'s
 * gate (allow-list, SSRF, no redirects, byte cap), and the chain read through
 * the adapter.
 */
import type { ChainAdapterConfig } from "@crewhaus/chain-adapter-base";
import { createEvmAdapters } from "@crewhaus/chain-adapter-evm";
import { guardedGet } from "@crewhaus/tool-http";
import { TokenError, _setChainReader, chainReaderFromAdapters } from "./chain";
import { _setMetadataFetch } from "./uri";

/** A metadata document is small; a slow host should not hold a call open for long. */
const METADATA_TIMEOUT_MS = 10_000;

/** Bind the chain reader from the spec's `chains` block. */
export function bindTokenChains(config: {
  readonly chains: ReadonlyArray<ChainAdapterConfig>;
}): void {
  const adapters = createEvmAdapters(config.chains);
  _setChainReader(chainReaderFromAdapters((chainId) => adapters.get(chainId)));
}

/** The spec's `tool_config.token` block. */
export type TokenConfigInput = {
  readonly metadata_origins?: ReadonlyArray<string>;
  readonly metadataOrigins?: ReadonlyArray<string>;
};

/**
 * Bind the metadata fetcher from `tool_config.token.metadata_origins`. Only
 * https origins are accepted: a metadata document read over plain http is
 * whatever the network says it is. A block without the list binds nothing.
 */
export function registerTokenConfig(input: TokenConfigInput): void {
  const block = (input ?? {}) as Record<string, unknown>;
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
