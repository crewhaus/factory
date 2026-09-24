/**
 * @crewhaus/tool-defi — what is it worth right now, with provenance, and an
 * explicit unpriced bucket.
 *
 * Four tools: a price from an offchain provider, a price from an onchain
 * oracle, a lending or vault position normalised into one row, and a portfolio
 * total assembled from the first three.
 *
 * Three rules run through all of it.
 *
 * **1. Every price says where it came from and how it was derived.** Which
 * source, which round or which fixing date, and whether the number is a direct
 * quote, an inversion of the pair the provider actually publishes, or a cross
 * through an intermediate — and a cross names the intermediate and carries
 * both legs. A price with no provenance is a number somebody will paste into a
 * report, and nobody will be able to reproduce it a week later.
 *
 * **2. There is no boolean called `stale`.** A Chainlink aggregator updates on
 * heartbeat OR on a deviation threshold, so elapsed time alone does not mean
 * stale, and the real incomplete-round signal is `answeredInRound < roundId`.
 * Pyth's freshness is a confidence interval over the price, which is a
 * different quantity in different units. Each feed reports its own signal under
 * its own name; collapsing them into one flag is how a wrong oracle verdict
 * ships.
 *
 * **3. A portfolio total that silently drops what it could not price is wrong
 * in the direction that looks good.** `PortfolioValuation` returns the total,
 * the priced set and the unpriced set as three separate fields, and the
 * unpriced set names every asset and why.
 *
 * **Nothing here signs or sends.** The RPC method set is `eth_call`,
 * `eth_getBalance`, `eth_blockNumber` and `eth_getBlockByNumber`, gated first
 * through `@crewhaus/chain-adapter-base`'s shared read-only chokepoint. No
 * schema in this package has a field to pass a private key, a mnemonic or a
 * keystore to, and `index.test.ts` asserts that over every schema rather than
 * trusting this paragraph.
 *
 * Money is decimal strings and bigints end to end. A uint256 does not fit in a
 * double, and eighteen decimals of precision silently becomes fifteen.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { CURRENCY_MINOR_UNITS } from "@crewhaus/tool-math";
import { z } from "zod";
import { SELECTORS, callNoArgs, callWithAddress, decodeWords, normalizeAddress } from "./lib/abi";
import { type BatchCall, batchCalls } from "./lib/batch";
import {
  type Fixed,
  type RoundingMode,
  ZERO,
  add,
  compare,
  fixed,
  fromInteger,
  isPositive,
  multiply,
  parseFixed,
  ratioBps,
  roundToPlaces,
  toDecimalString,
  trim,
} from "./lib/decimal";
import { type OracleReading, readChainlink, readPyth } from "./lib/oracle";
import {
  DEFAULT_AAVE_BASE_DECIMALS,
  type Protocol,
  REFUSED_PROTOCOLS,
  SUPPORTED_PROTOCOLS,
  readPosition,
} from "./lib/positions";
import { PROVIDER_NAMES, type ProviderName, type Quote, quotePrice } from "./lib/quotes";
import {
  DEFAULT_TIMEOUT_MS,
  type DefiConfig,
  DefiError,
  MAX_TIMEOUT_MS,
  blockTagOf,
  ethBlockNumber,
  ethGetBalance,
  json,
  requireEndpoint,
  resolveDefiConfig,
} from "./lib/rpc";

/** The seams, and the config. Every test in this package drives the first two. */
export {
  _setFetch,
  _setClock,
  _resetDefiConfig,
  registerDefiConfig,
  getDefiConfig,
  type Clock,
  type DefiConfig,
  type DefiConfigInput,
  type DefiFetch,
  DefiError,
} from "./lib/rpc";
export { PROVIDER_ORIGINS, type ProviderName } from "./lib/quotes";
export { SUPPORTED_PROTOCOLS, REFUSED_PROTOCOLS, type Protocol } from "./lib/positions";

const NETWORK_TOOL = {
  readOnly: true,
  concurrencySafe: true,
  // Pillar 3 sink-side: these cross a network boundary and say so. The
  // destinations are an operator's own endpoint and two constants, but "we
  // only talk to the configured node" is not a reason to hide the fact that
  // bytes leave the process.
  scope: "external",
  ioCapability: "network",
} as const;

const timeoutField = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`deadline for the whole call in ms; default ${DEFAULT_TIMEOUT_MS}`);

const blockNumberField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "pin every read in this answer to one block; decimal or 0x hex, default the head block",
  );

const ROUNDING_MODES = ["halfEven", "halfUp", "down"] as const;

const roundingField = z
  .enum(ROUNDING_MODES)
  .optional()
  .describe("halfEven (default, errors cancel over many rows), halfUp or down");

/** An explicit block, or the head. Decimal and hex are both common in the wild. */
function parseBlockNumber(raw: string | undefined): bigint | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) {
    throw new DefiError(`blockNumber: "${raw}" is not a block number (decimal or 0x hex)`);
  }
  return BigInt(text);
}

function configOf(ctx: ToolExecuteContext | undefined): DefiConfig {
  return resolveDefiConfig(ctx?.toolConfig);
}

function rpcOptions(
  ctx: ToolExecuteContext | undefined,
  timeoutMs: number | undefined,
  chainId?: string,
): { signal?: AbortSignal; timeoutMs?: number; chainId?: string } {
  return {
    ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(chainId === undefined ? {} : { chainId }),
  };
}

/**
 * Resolve the tag every read in one answer shares.
 *
 * When no block is named this asks the node for its head and pins THAT, rather
 * than sending "latest" with each call: two reads tagged "latest" seconds apart
 * can land on different blocks, and the resulting valuation is a number that
 * never existed at any height.
 */
async function pinBlock(
  endpoint: string,
  requested: bigint | undefined,
  options: { signal?: AbortSignal; timeoutMs?: number; chainId?: string },
): Promise<{ blockNumber: bigint; blockTag: string; pinnedByThisCall: boolean }> {
  if (requested !== undefined) {
    return { blockNumber: requested, blockTag: blockTagOf(requested), pinnedByThisCall: false };
  }
  const head = await ethBlockNumber(endpoint, options);
  if (!head.ok) throw new DefiError(`could not pin a block: ${head.message}`);
  return { blockNumber: head.value, blockTag: blockTagOf(head.value), pinnedByThisCall: true };
}

// ---------------------------------------------------------------------------
// PriceQuote
// ---------------------------------------------------------------------------

export const priceQuote: RegisteredTool = buildTool({
  name: "PriceQuote",
  operativeArgs: [],
  description:
    "Price one asset in another from a public, unauthenticated provider — the ECB's daily euro reference rates for currencies, Coinbase spot for everything else — and return the price with its provenance. Use it whenever a number will be reported to somebody: the result says which source answered, which fixing date it carries, and whether the price is a direct quote, an inversion of the pair the provider actually publishes, or a cross through an intermediate asset (and through which one, with both legs attached). It refuses a historical CRYPTO quote rather than serving one from a spot endpoint that echoes no date, because a price that cannot be told apart from today's must not be labelled as last Tuesday's; a historical currency rate comes from the ECB fixing for that date and says which fixing it resolved to. Nothing here signs or sends anything.",
  inputSchema: z
    .object({
      base: z.string().min(2).max(12).describe("the asset being priced, e.g. BTC or EUR"),
      quote: z.string().min(2).max(12).describe("the asset to price it in, e.g. USD"),
      at: z
        .string()
        .optional()
        .describe("an ISO date (YYYY-MM-DD) for a historical rate; currencies only"),
      providers: z
        .array(z.enum(PROVIDER_NAMES as unknown as [ProviderName, ...ProviderName[]]))
        .min(1)
        .max(PROVIDER_NAMES.length)
        .optional()
        .describe(
          "provider order; default is the ECB first for currency pairs, Coinbase otherwise",
        ),
      via: z
        .string()
        .min(2)
        .max(12)
        .optional()
        .describe(
          "cross through this asset when no provider publishes the pair; default USD then EUR",
        ),
      allowCross: z
        .boolean()
        .optional()
        .describe("false refuses rather than composing two prices into one; default true"),
      timeoutMs: timeoutField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx) => {
    const result = await quotePrice(
      {
        base: input.base,
        quote: input.quote,
        ...(input.at === undefined ? {} : { at: input.at }),
        ...(input.providers === undefined ? {} : { providers: input.providers }),
        ...(input.via === undefined ? {} : { via: input.via }),
        ...(input.allowCross === undefined ? {} : { allowCross: input.allowCross }),
      },
      rpcOptions(ctx, input.timeoutMs),
    );
    return json(result.quote);
  },
});

// ---------------------------------------------------------------------------
// OraclePriceRead
// ---------------------------------------------------------------------------

export const oraclePriceRead: RegisteredTool = buildTool({
  name: "OraclePriceRead",
  operativeArgs: [
    { field: "feed", kind: "id" },
    { field: "address", kind: "id", within: "chainId" },
  ],
  description:
    "Read a Chainlink or Pyth price feed onchain at a pinned block and report the price with EACH FEED'S OWN freshness signal, under its own name. Use it instead of asking whether a feed is 'stale', because that word means two different things: a Chainlink aggregator updates on its heartbeat OR on a deviation threshold, so an unchanged price legitimately looks old and the real incomplete-round signal is answeredInRound being behind roundId — while Pyth's signal is the width of its confidence interval relative to the price, a different quantity entirely. Both are reported, plus the round data, the feed's own description and the publish time the feed itself states; there is deliberately no single boolean called stale. The heartbeat comparison only happens when you supply the heartbeat, because it is a property of the deployment that the aggregator will not tell you. This reads; it never signs or sends.",
  inputSchema: z
    .object({
      feed: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe("a feed pinned in the defi tool_config block, instead of chainId/kind/address"),
      chainId: z.string().min(1).max(64).optional().describe("the chain whose RPC endpoint to use"),
      kind: z.enum(["chainlink", "pyth"]).optional(),
      address: z.string().min(1).optional().describe("the aggregator, or the Pyth contract"),
      priceId: z.string().min(1).optional().describe("Pyth's 32-byte feed id; required for pyth"),
      heartbeatSeconds: z
        .number()
        .int()
        .positive()
        .max(60 * 60 * 24 * 30)
        .optional()
        .describe("the feed's published heartbeat; without it beyondHeartbeat is null, not false"),
      maxConfidenceBps: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .describe("Pyth only: the confidence-to-price bound to compare against"),
      blockNumber: blockNumberField,
      timeoutMs: timeoutField,
    })
    .strict()
    .refine(
      (v) =>
        v.feed !== undefined ||
        (v.chainId !== undefined && v.kind !== undefined && v.address !== undefined),
      {
        message: "give either feed, or all of chainId, kind and address",
      },
    ),
  ...NETWORK_TOOL,
  execute: async (input, ctx) => {
    const config = configOf(ctx);
    const pin = input.feed === undefined ? undefined : config.feeds.get(input.feed);
    if (input.feed !== undefined && pin === undefined) {
      const known = [...config.feeds.keys()].sort();
      throw new DefiError(
        `no feed named "${input.feed}" is pinned — add it to the defi tool_config block under feeds${
          known.length === 0 ? " (none are pinned)" : `; pinned feeds: ${known.join(", ")}`
        }`,
      );
    }

    const chainId = pin?.chainId ?? (input.chainId as string);
    const kind = pin?.kind ?? (input.kind as "chainlink" | "pyth");
    const address = pin?.address ?? (input.address as string);
    const priceId = input.priceId ?? pin?.priceId;
    const heartbeatSeconds = input.heartbeatSeconds ?? pin?.heartbeatSeconds;

    const endpoint = requireEndpoint(config, chainId);
    const multicall3 = config.multicall.get(chainId);
    const options = rpcOptions(ctx, input.timeoutMs, chainId);

    // Everything that can be refused without asking anybody is refused here,
    // before the block is pinned. A malformed address or a Pyth read with no
    // price id should cost zero requests, and a test can only tell the two
    // apart by counting what was dialled.
    normalizeAddress(address, "the feed address");
    if (kind === "pyth") requirePriceId(priceId);
    const block = await pinBlock(endpoint, parseBlockNumber(input.blockNumber), options);

    const reading =
      kind === "chainlink"
        ? await readChainlink(
            {
              chainId,
              endpoint,
              address,
              blockTag: block.blockTag,
              ...(heartbeatSeconds === undefined ? {} : { heartbeatSeconds }),
              ...(multicall3 === undefined ? {} : { multicall3 }),
            },
            options,
          )
        : await readPyth(
            {
              chainId,
              endpoint,
              address,
              priceId: requirePriceId(priceId),
              blockTag: block.blockTag,
              ...(input.maxConfidenceBps === undefined
                ? {}
                : { maxConfidenceBps: input.maxConfidenceBps }),
              ...(multicall3 === undefined ? {} : { multicall3 }),
            },
            options,
          );

    return json({
      ...reading.reading,
      blockNumber: block.blockNumber.toString(),
      blockPinnedByThisCall: block.pinnedByThisCall,
      signalNote: STALENESS_NOTE,
    });
  },
});

const STALENESS_NOTE =
  "there is no single 'stale' flag here on purpose: a Chainlink feed updates on heartbeat OR deviation, so beyondHeartbeat is a question and answeredInRoundBehindRoundId is the incomplete-round fact, while a Pyth feed's freshness is confidenceToPriceBps — a different quantity in different units";

function requirePriceId(priceId: string | undefined): string {
  if (priceId === undefined) {
    throw new DefiError(
      "a Pyth read needs priceId: one Pyth contract serves every feed, so without the id there is nothing to ask it for",
    );
  }
  return priceId;
}

// ---------------------------------------------------------------------------
// DefiPositionRead
// ---------------------------------------------------------------------------

export const defiPositionRead: RegisteredTool = buildTool({
  name: "DefiPositionRead",
  operativeArgs: [{ field: "contract", kind: "id", within: "chainId" }],
  description:
    "Read one Aave v3, Compound v3 or ERC-4626 position at a pinned block and normalise it into one row, with every figure labelled with the basis it is in. Use it because each protocol answers in its own units and the conversion is where the wrong number gets made: Aave reports in its oracle's base currency and returns type(uint256).max as the health factor of a debt-free account, Compound v3 has one borrowable asset and publishes its own liquidation verdict, and an ERC-4626 share is worth convertToAssets(shares) — not totalAssets/totalSupply, which differs for any vault with a fee. It reports how far the collateral basket may fall before the health factor reaches 1 rather than a liquidation price, because a liquidation price for an aggregate position depends on which collateral you assume moves. A protocol it cannot read is refused with what reading it would take, never probed. It reads; it never signs or sends.",
  inputSchema: z
    .object({
      protocol: z
        .string()
        .min(1)
        .max(64)
        .describe(`one of ${SUPPORTED_PROTOCOLS.join(", ")}`),
      chainId: z.string().min(1).max(64),
      contract: z.string().min(1).describe("the Aave Pool, the Comet, or the ERC-4626 vault"),
      account: z.string().min(1).describe("the position holder"),
      baseCurrencyDecimals: z
        .number()
        .int()
        .min(0)
        .max(36)
        .optional()
        .describe(
          `Aave only: the market's BASE_CURRENCY_UNIT decimals; default ${DEFAULT_AAVE_BASE_DECIMALS}`,
        ),
      collateralAssets: z
        .array(z.string().min(1))
        .max(32)
        .optional()
        .describe("Compound v3 only: collateral tokens to read balances for"),
      blockNumber: blockNumberField,
      timeoutMs: timeoutField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx) => {
    const protocol = input.protocol.trim().toLowerCase();
    if (!(SUPPORTED_PROTOCOLS as ReadonlyArray<string>).includes(protocol)) {
      const refusal = REFUSED_PROTOCOLS[protocol];
      throw new DefiError(
        refusal === undefined
          ? `"${input.protocol}" is not a protocol this reads; it reads ${SUPPORTED_PROTOCOLS.join(", ")}`
          : `"${protocol}" is not read here. ${refusal}`,
      );
    }

    const config = configOf(ctx);
    const endpoint = requireEndpoint(config, input.chainId);
    const multicall3 = config.multicall.get(input.chainId);
    const options = rpcOptions(ctx, input.timeoutMs, input.chainId);
    const block = await pinBlock(endpoint, parseBlockNumber(input.blockNumber), options);

    const row = await readPosition(
      {
        protocol: protocol as Protocol,
        chainId: input.chainId,
        endpoint,
        contract: input.contract,
        account: input.account,
        blockTag: block.blockTag,
        ...(input.baseCurrencyDecimals === undefined
          ? {}
          : { baseCurrencyDecimals: input.baseCurrencyDecimals }),
        ...(input.collateralAssets === undefined
          ? {}
          : { collateralAssets: input.collateralAssets }),
        ...(multicall3 === undefined ? {} : { multicall3 }),
      },
      options,
    );

    return json({
      ...row,
      blockNumber: block.blockNumber.toString(),
      blockPinnedByThisCall: block.pinnedByThisCall,
    });
  },
});

// ---------------------------------------------------------------------------
// PortfolioValuation
// ---------------------------------------------------------------------------

const priceSource = {
  price: z.string().min(1).optional().describe("a price you already have, in the quote currency"),
  feed: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("a feed pinned in the defi tool_config block"),
  oracle: z
    .object({
      kind: z.enum(["chainlink", "pyth"]),
      address: z.string().min(1),
      priceId: z.string().min(1).optional(),
      heartbeatSeconds: z.number().int().positive().optional(),
      maxConfidenceBps: z.number().int().min(0).max(10_000).optional(),
    })
    .strict()
    .optional(),
  quotePair: z
    .object({
      base: z.string().min(2).max(12),
      via: z.string().min(2).max(12).optional(),
    })
    .strict()
    .optional()
    .describe(
      "price this asset against the portfolio's quote currency through PriceQuote's providers",
    ),
};

const holdingSchema = z
  .object({
    asset: z.string().min(1).max(64).describe("a label for this holding, e.g. WETH"),
    amount: z.string().min(1).optional().describe("a decimal amount you already have"),
    baseUnits: z.string().min(1).optional().describe("an integer amount in the token's base units"),
    decimals: z.number().int().min(0).max(36).optional().describe("the token's decimals"),
    token: z.string().min(1).optional().describe("an ERC-20 to read the wallet's balance of"),
    native: z.boolean().optional().describe("read the wallet's native-coin balance instead"),
    ...priceSource,
  })
  .strict();

export const portfolioValuation: RegisteredTool = buildTool({
  name: "PortfolioValuation",
  operativeArgs: [{ field: "wallet", kind: "id", within: "chainId" }],
  description:
    "Value a set of holdings in one currency at one pinned block and return the total, the priced holdings and the UNPRICED ones as three separate fields. Use it for any figure that will be reported: the unpriced bucket names every asset that could not be priced and why, so a total is never quietly the sum of whatever happened to have a price — which is the failure mode that makes a treasury number wrong in the direction that looks good. Amounts can be given, or read as ERC-20 and native balances for a wallet; prices can be given, read from a pinned oracle feed, or quoted from a public provider, and each priced row carries the provenance of its own price. Weights are stated as a share of the PRICED total. A historical valuation must pin both the block and the date, because a current balance multiplied by a historical price is a plausible number that means nothing. It reads; it never signs or sends.",
  inputSchema: z
    .object({
      quoteCurrency: z.string().min(2).max(12).describe("what to value everything in, e.g. USD"),
      holdings: z.array(holdingSchema).min(1).max(256),
      chainId: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("required for any balance or oracle read"),
      wallet: z.string().min(1).optional().describe("the address whose balances to read"),
      blockNumber: blockNumberField,
      at: z
        .string()
        .optional()
        .describe(
          "an ISO date for a historical valuation; requires blockNumber, and prices are asked for that date",
        ),
      places: z
        .number()
        .int()
        .min(0)
        .max(18)
        .optional()
        .describe(
          "decimal places for the total; default is the quote currency's minor units, else 2",
        ),
      rounding: roundingField,
      minValue: z
        .string()
        .min(1)
        .optional()
        .describe("rows worth less than this are summarised as dust — they stay in the total"),
      timeoutMs: timeoutField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx) => valuePortfolio(input, ctx),
});

type Holding = z.infer<typeof holdingSchema>;

type PricedRow = {
  asset: string;
  amount: string;
  price: string;
  value: string;
  weightBps: number;
  belowMinValue: boolean;
  provenance: unknown;
};

type UnpricedRow = { asset: string; amount: string | null; reason: string };

async function valuePortfolio(
  input: {
    quoteCurrency: string;
    holdings: Holding[];
    chainId?: string;
    wallet?: string;
    blockNumber?: string;
    at?: string;
    places?: number;
    rounding?: RoundingMode;
    minValue?: string;
    timeoutMs?: number;
  },
  ctx: ToolExecuteContext | undefined,
): Promise<string> {
  const quoteCurrency = input.quoteCurrency.trim().toUpperCase();
  const config = configOf(ctx);
  const rounding: RoundingMode = input.rounding ?? "halfEven";
  const places = input.places ?? CURRENCY_MINOR_UNITS[quoteCurrency] ?? 2;
  const requestedBlock = parseBlockNumber(input.blockNumber);
  const usesQuoteProvider = input.holdings.some((h) => h.quotePair !== undefined);

  // The corner the whole `at` path exists for: a current balance multiplied by
  // a historical price is a number that looks plausible and means nothing, and
  // so is a historical balance at today's price. The two are pinned together
  // or the request is refused.
  if (input.at !== undefined && requestedBlock === undefined) {
    throw new DefiError(
      "at was given without blockNumber: a historical valuation needs the balances and the prices resolved from the SAME instant, and resolving a date to a block is a different read (EvmBlockAtTimestamp)",
    );
  }
  if (input.at === undefined && requestedBlock !== undefined && usesQuoteProvider) {
    throw new DefiError(
      "blockNumber was given for the balances but a holding is priced from a live provider quote: that mixes a historical balance with today's price. Give `at` as well, or price every holding from an oracle read at the same block, or from a price you supply.",
    );
  }

  // The price-source shape is checked BEFORE anything is dialled, and a holding
  // with a broken source is excluded from `needsChain`: otherwise a typo in one
  // row's price source turns the whole call into a refusal for a missing
  // chainId, which is a true statement about the wrong problem.
  const sourceErrors = input.holdings.map((holding) => priceSourceError(holding));
  const needsChain = input.holdings.some(
    (h, index) =>
      sourceErrors[index] === undefined &&
      (h.token !== undefined ||
        h.native === true ||
        h.feed !== undefined ||
        h.oracle !== undefined),
  );
  let endpoint: string | undefined;
  let block: { blockNumber: bigint; blockTag: string; pinnedByThisCall: boolean } | undefined;
  const options = rpcOptions(ctx, input.timeoutMs, input.chainId);
  if (needsChain) {
    if (input.chainId === undefined) {
      throw new DefiError(
        "chainId is required: a holding asks for a balance or an oracle read, and neither can happen without a chain's endpoint",
      );
    }
    endpoint = requireEndpoint(config, input.chainId);
    block = await pinBlock(endpoint, requestedBlock, options);
  }

  const amounts = await resolveAmounts(input.holdings, {
    sourceErrors,
    endpoint,
    blockTag: block?.blockTag,
    wallet: input.wallet,
    chainId: input.chainId,
    multicall3: input.chainId === undefined ? undefined : config.multicall.get(input.chainId),
    options,
  });

  const priced: PricedRow[] = [];
  const unpriced: UnpricedRow[] = [];
  const notes: string[] = [];
  // Two running totals, on purpose. `total` is the sum of the ROUNDED rows, so
  // the table a human reads adds up to the figure at the bottom of it;
  // `exactSum` is the sum of the unrounded products, so the rounding the table
  // cost is visible rather than argued about.
  let total: Fixed = ZERO;
  let exactSum: Fixed = ZERO;

  for (let index = 0; index < input.holdings.length; index++) {
    const holding = input.holdings[index] as Holding;
    const amount = amounts[index] as AmountOutcome;
    const sourceError = sourceErrors[index];
    if (sourceError !== undefined) {
      unpriced.push({
        asset: holding.asset,
        amount: amount.ok ? toDecimalString(trim(amount.value)) : null,
        reason: sourceError,
      });
      continue;
    }
    if (!amount.ok) {
      unpriced.push({ asset: holding.asset, amount: null, reason: amount.reason });
      continue;
    }
    let price: { value: Fixed; provenance: unknown };
    try {
      price = await priceFor(holding, {
        quoteCurrency,
        config,
        endpoint,
        chainId: input.chainId,
        blockTag: block?.blockTag,
        at: input.at,
        options,
      });
    } catch (err) {
      // A holding that could not be priced is a ROW, not a thrown error: the
      // other forty-nine assets still have values, and the whole point of the
      // unpriced bucket is that it is visible rather than absent.
      unpriced.push({
        asset: holding.asset,
        amount: toDecimalString(trim(amount.value)),
        reason: (err as Error).message,
      });
      continue;
    }
    let exact: Fixed;
    let value: Fixed;
    try {
      exact = multiply(amount.value, price.value);
      value = roundToPlaces(exact, places, rounding);
    } catch (err) {
      // The multiplication refuses past MAX_SCALE, and it used to do it out
      // here, outside the try above: one holding whose amount and price
      // between them ask for more decimal places than this carries threw out
      // of the whole call, so forty-nine priceable rows were lost to the
      // fiftieth. An arithmetic refusal is a row, exactly like a price
      // refusal is.
      unpriced.push({
        asset: holding.asset,
        amount: toDecimalString(trim(amount.value)),
        reason: `${holding.asset}: the amount and the price could not be multiplied — ${(err as Error).message}`,
      });
      continue;
    }
    total = add(total, value);
    exactSum = add(exactSum, exact);
    priced.push({
      asset: holding.asset,
      amount: toDecimalString(trim(amount.value)),
      price: toDecimalString(trim(price.value)),
      value: toDecimalString(value),
      weightBps: 0,
      belowMinValue: false,
      provenance: price.provenance,
    });
  }

  const minValue =
    input.minValue === undefined ? undefined : parseFixed(input.minValue, "minValue");
  let dustCount = 0;
  let dustValue: Fixed = ZERO;
  for (const row of priced) {
    const value = parseFixed(row.value, "a row value");
    row.weightBps = isPositive(total) ? ratioBps(value, total) : 0;
    if (minValue !== undefined && compare(value, minValue) < 0) {
      row.belowMinValue = true;
      dustCount++;
      dustValue = add(dustValue, value);
    }
  }

  if (unpriced.length > 0) {
    notes.push(
      `${unpriced.length} of ${input.holdings.length} holding(s) could not be priced and are NOT in the total — see unpriced[], which names each one and why`,
    );
  }
  if (!isPositive(total) && priced.length > 0) {
    // Zero or negative: a portfolio carrying more debt than collateral has a
    // negative total, and a share OF a negative total is not a weight.
    notes.push(
      `the priced total is ${toDecimalString(total)}, so weightBps is 0 on every row — a share of a total that is not positive is not a weight`,
    );
  }
  if (block?.pinnedByThisCall === true) {
    notes.push(
      `no block was given, so the head block ${block.blockNumber} was pinned and every read used it`,
    );
  }

  return json({
    quoteCurrency,
    at: input.at ?? null,
    blockNumber: block === undefined ? null : block.blockNumber.toString(),
    blockTag: block?.blockTag ?? null,
    total: {
      // Rounded again for the empty case only: with no priced rows `total` is
      // still scale 0, and a USD total that reads "0" where every other answer
      // reads "0.00" is the kind of inconsistency a downstream parser trips on.
      value: toDecimalString(roundToPlaces(total, places, rounding)),
      places,
      rounding,
      // Said in the payload, not just in the docs: whoever reads this JSON
      // three screens down is the person who would otherwise assume the total
      // covers everything they passed in.
      covers:
        "the priced holdings only; the unpriced ones are listed separately and are NOT in this figure",
    },
    exactTotal: toDecimalString(trim(exactSum)),
    coverage: {
      holdings: input.holdings.length,
      pricedCount: priced.length,
      unpricedCount: unpriced.length,
      weightsNote:
        "weightBps is a share of the PRICED total, so the weights of an incomplete portfolio still sum to 10000",
    },
    priced,
    unpriced,
    dust:
      minValue === undefined
        ? null
        : {
            threshold: toDecimalString(minValue),
            count: dustCount,
            value: toDecimalString(roundToPlaces(dustValue, places, rounding)),
            note: "dust rows are flagged, not dropped — they are still in the total, because a floor that removes value from a total is the same silent loss as an unpriced asset",
          },
    notes,
  });
}

/**
 * Whether a holding names exactly one price source.
 *
 * Zero sources and two sources are both answers, not crashes: the holding
 * lands in the unpriced bucket with the reason, and the other forty-nine rows
 * still get values. Two sources in particular must never be resolved by
 * preferring one — that is a silent choice about which number a report shows.
 */
function priceSourceError(holding: Holding): string | undefined {
  const named = [
    holding.price === undefined ? undefined : "price",
    holding.feed === undefined ? undefined : "feed",
    holding.oracle === undefined ? undefined : "oracle",
    holding.quotePair === undefined ? undefined : "quotePair",
  ].filter((name): name is string => name !== undefined);
  if (named.length === 1) return undefined;
  if (named.length === 0) {
    return `${holding.asset}: no price source — give price, feed, oracle or quotePair, or accept that it lands in the unpriced bucket`;
  }
  return `${holding.asset}: give exactly one of price, feed, oracle or quotePair; this names ${named.join(" and ")}`;
}

type AmountOutcome = { ok: true; value: Fixed } | { ok: false; reason: string };

/**
 * Whether a holding names more than one way to arrive at its amount.
 *
 * The same rule `priceSourceError` applies to prices, for the same reason: a
 * holding carrying both `amount` and `token` was silently valued from
 * `amount`, and one carrying both `token` and `native` was silently valued
 * from the wallet's ETH — with nothing in the row saying which of the two the
 * figure came from. "WETH: 7" reads as the token balance whichever one it is.
 * Resolving that by hidden preference is the same silent choice about which
 * number a report shows, one field along.
 *
 * Zero sources is NOT handled here: the messages further down name what is
 * missing in the context of what the holding did ask for.
 */
function amountSourceError(holding: Holding): string | undefined {
  const named = [
    holding.amount === undefined ? undefined : "amount",
    holding.baseUnits === undefined ? undefined : "baseUnits",
    holding.token === undefined ? undefined : "token",
    holding.native === true ? "native" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (named.length <= 1) return undefined;
  return `${holding.asset}: give exactly one of amount, baseUnits, token or native; this names ${named.join(" and ")}, and preferring one of them silently would hide which figure the row is`;
}

async function resolveAmounts(
  holdings: ReadonlyArray<Holding>,
  context: {
    sourceErrors: ReadonlyArray<string | undefined>;
    endpoint: string | undefined;
    blockTag: string | undefined;
    wallet: string | undefined;
    chainId: string | undefined;
    multicall3: string | undefined;
    options: { signal?: AbortSignal; timeoutMs?: number; chainId?: string };
  },
): Promise<ReadonlyArray<AmountOutcome>> {
  const out: AmountOutcome[] = holdings.map(() => ({ ok: false, reason: "not resolved" }));

  // Every token read goes out as ONE batch at the pinned block, so fifty
  // balances are fifty answers from one height rather than fifty races.
  const tokenIndices: number[] = [];
  const calls: BatchCall[] = [];
  for (let index = 0; index < holdings.length; index++) {
    const holding = holdings[index] as Holding;
    const ambiguous = amountSourceError(holding);
    if (ambiguous !== undefined) {
      // Before anything is dialled: an ambiguous holding must not cost a
      // request to produce a row that is a refusal either way.
      out[index] = { ok: false, reason: ambiguous };
      continue;
    }
    const sourceError = context.sourceErrors[index];
    if (sourceError !== undefined) {
      // No usable price source, so reading its balance would cost a request to
      // produce a row that is unpriced either way — but an amount the caller
      // already gave is kept, because "1,000,000 SPAM, unpriced" is a row
      // somebody can act on and "unpriced" alone is not.
      out[index] = givenAmount(holding) ?? { ok: false, reason: sourceError };
      continue;
    }
    const given = givenAmount(holding);
    if (given !== undefined) {
      out[index] = given;
      continue;
    }
    if (holding.native === true) continue;
    if (holding.token === undefined) {
      out[index] = {
        ok: false,
        reason: `${holding.asset}: no amount — give amount, or baseUnits with decimals, or token (with a wallet), or native`,
      };
      continue;
    }
    if (
      context.wallet === undefined ||
      context.endpoint === undefined ||
      context.blockTag === undefined
    ) {
      out[index] = {
        ok: false,
        reason: `${holding.asset}: a token balance needs wallet and chainId`,
      };
      continue;
    }
    const token = normalizeAddress(holding.token, `${holding.asset}.token`);
    const wallet = normalizeAddress(context.wallet, "wallet");
    tokenIndices.push(index);
    calls.push({
      to: token,
      data: callWithAddress(SELECTORS.balanceOf, wallet, "wallet"),
      label: `${holding.asset} balanceOf`,
    });
    calls.push({
      to: token,
      data: callNoArgs(SELECTORS.decimals),
      label: `${holding.asset} decimals`,
    });
  }

  if (calls.length > 0 && context.endpoint !== undefined && context.blockTag !== undefined) {
    const results = await batchCalls(context.endpoint, calls, context.blockTag, {
      ...context.options,
      ...(context.multicall3 === undefined ? {} : { multicall3: context.multicall3 }),
    });
    tokenIndices.forEach((holdingIndex, slot) => {
      const holding = holdings[holdingIndex] as Holding;
      const balanceRow = results[slot * 2];
      const decimalsRow = results[slot * 2 + 1];
      if (balanceRow === undefined || !balanceRow.ok) {
        out[holdingIndex] = {
          ok: false,
          reason: `${holding.asset}: ${balanceRow?.reason ?? "no balance row returned"}`,
        };
        return;
      }
      let decimals = holding.decimals;
      if (decimalsRow?.ok) {
        try {
          decimals = Number(
            decodeWords(decimalsRow.data, 1, `${holding.asset} decimals`)[0] as bigint,
          );
        } catch (err) {
          out[holdingIndex] = { ok: false, reason: `${holding.asset}: ${(err as Error).message}` };
          return;
        }
      }
      if (
        decimals === undefined ||
        !Number.isSafeInteger(decimals) ||
        decimals < 0 ||
        decimals > 36
      ) {
        // Defaulting to 18 here would be a factor of 10^12 on USDC. An
        // unreadable decimals() is an unpriced row, not a guess.
        out[holdingIndex] = {
          ok: false,
          reason: `${holding.asset}: the token's decimals() could not be read and none was supplied; a default would be a factor-of-a-trillion guess`,
        };
        return;
      }
      try {
        const balance = decodeWords(balanceRow.data, 1, `${holding.asset} balanceOf`)[0] as bigint;
        out[holdingIndex] = { ok: true, value: fixed(balance, decimals) };
      } catch (err) {
        out[holdingIndex] = { ok: false, reason: `${holding.asset}: ${(err as Error).message}` };
      }
    });
  }

  for (let index = 0; index < holdings.length; index++) {
    const holding = holdings[index] as Holding;
    if (holding.native !== true || context.sourceErrors[index] !== undefined) continue;
    if (amountSourceError(holding) !== undefined) continue;
    if (
      context.wallet === undefined ||
      context.endpoint === undefined ||
      context.blockTag === undefined
    ) {
      out[index] = {
        ok: false,
        reason: `${holding.asset}: a native balance needs wallet and chainId`,
      };
      continue;
    }
    const balance = await ethGetBalance(
      context.endpoint,
      normalizeAddress(context.wallet, "wallet"),
      context.blockTag,
      context.options,
    );
    out[index] = balance.ok
      ? { ok: true, value: fixed(balance.value, holding.decimals ?? 18) }
      : { ok: false, reason: `${holding.asset}: ${balance.message}` };
  }

  return out;
}

function givenAmount(holding: Holding): AmountOutcome | undefined {
  if (holding.amount !== undefined) {
    try {
      return { ok: true, value: parseFixed(holding.amount, `${holding.asset}.amount`) };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }
  if (holding.baseUnits !== undefined) {
    if (holding.decimals === undefined) {
      return {
        ok: false,
        reason: `${holding.asset}: baseUnits needs decimals — an integer with no decimalisation is not an amount`,
      };
    }
    if (!/^-?\d+$/.test(holding.baseUnits.trim())) {
      return {
        ok: false,
        reason: `${holding.asset}: baseUnits "${holding.baseUnits}" is not an integer`,
      };
    }
    return { ok: true, value: fixed(BigInt(holding.baseUnits.trim()), holding.decimals) };
  }
  return undefined;
}

async function priceFor(
  holding: Holding,
  context: {
    quoteCurrency: string;
    config: DefiConfig;
    endpoint: string | undefined;
    chainId: string | undefined;
    blockTag: string | undefined;
    at: string | undefined;
    options: { signal?: AbortSignal; timeoutMs?: number; chainId?: string };
  },
): Promise<{ value: Fixed; provenance: unknown }> {
  // `priceSourceError` has already established that exactly one is set.
  if (holding.price !== undefined) {
    const value = parseFixed(holding.price, `${holding.asset}.price`);
    if (value.unscaled < 0n) {
      // A negative AMOUNT is a borrow and is allowed; a negative price is not a
      // thing, and multiplied by a balance it subtracts from a total.
      throw new DefiError(
        `${holding.asset}: a supplied price of ${toDecimalString(value)} is negative — a debt is a negative amount, not a negative price`,
      );
    }
    return {
      value,
      provenance: {
        source: "given",
        derivation: "supplied-by-caller",
        quoteCurrency: context.quoteCurrency,
        note: "this price was passed in, so its provenance is whoever passed it",
      },
    };
  }

  if (holding.feed !== undefined || holding.oracle !== undefined) {
    if (
      context.endpoint === undefined ||
      context.blockTag === undefined ||
      context.chainId === undefined
    ) {
      throw new DefiError(`${holding.asset}: an oracle price needs chainId`);
    }
    const pin = holding.feed === undefined ? undefined : context.config.feeds.get(holding.feed);
    if (holding.feed !== undefined && pin === undefined) {
      throw new DefiError(
        `${holding.asset}: no feed named "${holding.feed}" is pinned in the defi tool_config block`,
      );
    }
    const kind = pin?.kind ?? holding.oracle?.kind;
    const address = pin?.address ?? holding.oracle?.address;
    if (kind === undefined || address === undefined) {
      throw new DefiError(`${holding.asset}: the oracle source needs a kind and an address`);
    }
    const multicall3 = context.config.multicall.get(context.chainId);
    const heartbeatSeconds = pin?.heartbeatSeconds ?? holding.oracle?.heartbeatSeconds;
    const reading =
      kind === "chainlink"
        ? await readChainlink(
            {
              chainId: context.chainId,
              endpoint: context.endpoint,
              address,
              blockTag: context.blockTag,
              ...(heartbeatSeconds === undefined ? {} : { heartbeatSeconds }),
              ...(multicall3 === undefined ? {} : { multicall3 }),
            },
            context.options,
          )
        : await readPyth(
            {
              chainId: context.chainId,
              endpoint: context.endpoint,
              address,
              priceId: requirePriceId(holding.oracle?.priceId ?? pin?.priceId),
              blockTag: context.blockTag,
              ...(holding.oracle?.maxConfidenceBps === undefined
                ? {}
                : { maxConfidenceBps: holding.oracle.maxConfidenceBps }),
              ...(multicall3 === undefined ? {} : { multicall3 }),
            },
            context.options,
          );
    assertUsablePrice(holding.asset, reading.reading);
    return {
      value: reading.value,
      provenance: { ...reading.reading.provenance, signals: reading.reading.signals },
    };
  }

  const pair = holding.quotePair as { base: string; via?: string };
  const result = await quotePrice(
    {
      base: pair.base,
      quote: context.quoteCurrency,
      ...(context.at === undefined ? {} : { at: context.at }),
      ...(pair.via === undefined ? {} : { via: pair.via }),
    },
    context.options,
  );
  return { value: result.value, provenance: quoteProvenance(result.quote) };
}

function quoteProvenance(quote: Quote): unknown {
  return {
    source: quote.legs.map((leg) => leg.source).join("+"),
    derivation: quote.derivation,
    via: quote.via,
    asOf: quote.asOf,
    legs: quote.legs,
    notes: quote.notes,
  };
}

/**
 * Refuse an oracle answer that is not a usable price.
 *
 * A non-positive answer or a round that was never completed is not a low
 * price, it is a broken feed — and multiplying a balance by it produces a
 * confident zero in a total. An incomplete round is a REFUSAL here rather than
 * a caveat for the same reason: the row belongs in the unpriced bucket, which
 * is visible, instead of in the total, which is not.
 */
function assertUsablePrice(asset: string, reading: OracleReading): void {
  if (reading.kind === "chainlink") {
    if (reading.signals.updatedAtZero) {
      throw new DefiError(`${asset}: the feed's round has never been completed (updatedAt is 0)`);
    }
    if (reading.signals.answerNotPositive) {
      throw new DefiError(
        `${asset}: the feed answered ${reading.price}, which is a broken feed rather than a price`,
      );
    }
    if (reading.signals.answeredInRoundBehindRoundId) {
      throw new DefiError(
        `${asset}: answeredInRound (${reading.signals.answeredInRound}) is behind roundId (${reading.signals.roundId}) — the round is incomplete, so this price belongs to an earlier one`,
      );
    }
    return;
  }
  if (reading.signals.priceNotPositive) {
    throw new DefiError(`${asset}: the Pyth feed answered ${reading.price}, which is not a price`);
  }
  if (reading.signals.beyondConfidenceBound === true) {
    throw new DefiError(
      `${asset}: the Pyth confidence band is ${reading.signals.confidenceToPriceBps} bps of the price, past the ${reading.signals.maxConfidenceBps} bps bound`,
    );
  }
}

/** Every tool this package registers, in the order a catalog should list them. */
export const DEFI_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  defiPositionRead,
  oraclePriceRead,
  portfolioValuation,
  priceQuote,
]);

/** Re-exported for callers assembling their own valuations from the same maths. */
export {
  type Fixed,
  type RoundingMode,
  add,
  compare,
  fixed,
  fromInteger,
  parseFixed,
  ratioBps,
  roundToPlaces,
  toDecimalString,
} from "./lib/decimal";
