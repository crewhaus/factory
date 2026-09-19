import {
  SELECTORS,
  UINT256_MAX,
  addressFromWord,
  callNoArgs,
  callWithAddress,
  callWithAddresses,
  callWithUint256,
  decodeWords,
  normalizeAddress,
} from "./abi";
/**
 * One normalised row per lending or vault position, and a refusal for every
 * protocol whose basis this package cannot state.
 *
 * Each protocol reports collateral and debt in its OWN basis, and the
 * normalising is where the wrong number gets made:
 *
 *   - **Aave v3** answers in the price oracle's base currency, scaled by
 *     `BASE_CURRENCY_UNIT`, and returns the health factor in wad. The base
 *     unit is a market parameter, not a constant, so it is an input here with
 *     a stated default and a flag saying whether the default was used —
 *     hard-coding 8 is right for the USD markets and a hundred-million-fold
 *     error anywhere else. Its "no debt" health factor is `type(uint256).max`,
 *     which read as a wad is 1.1e59 and prints as a spectacularly safe
 *     position; it is reported as null with a reason instead.
 *   - **Compound v3** is single-borrow-asset, so a supply balance and a borrow
 *     balance are mutually exclusive and both are in base-token units. Its
 *     liquidation verdict is read from the protocol's own `isLiquidatable`
 *     rather than derived, because Comet's collateral factors are per asset
 *     and a derived answer would disagree with the protocol UI.
 *   - **ERC-4626** share value is `convertToAssets(shares)`, NOT
 *     `totalAssets() / totalSupply()`. The two differ for any vault with entry
 *     or exit fees, and the second is the one that looks right.
 *
 * **A liquidation PRICE is not reported.** For an aggregate position it is not
 * a fact: it depends on which collateral is assumed to move, and picking one
 * produces a number that looks authoritative and disagrees with the protocol
 * UI. What is reported instead is `collateralDropToLiquidationBps` — how far
 * the whole collateral basket may fall before the health factor reaches 1 —
 * which is derived from the same inputs, needs no assumption, and is what the
 * liquidation price was being used to approximate.
 */
import { type BatchCall, type CallOutcome, batchCalls } from "./batch";
import { type Fixed, compare, fixed, fromInteger, ratioBps, toDecimalString } from "./decimal";
import { DefiError, type RpcOptions, endpointLabel } from "./rpc";

/** The protocols this package reads. Everything else is refused by name. */
export const SUPPORTED_PROTOCOLS = Object.freeze(["aave-v3", "compound-v3", "erc4626"] as const);
export type Protocol = (typeof SUPPORTED_PROTOCOLS)[number];

/**
 * Protocols a caller will reasonably ask for, each with what reading it would
 * actually take. A named refusal is worth more than a missing case: it tells
 * the caller what to go and do instead.
 */
export const REFUSED_PROTOCOLS: Readonly<Record<string, string>> = Object.freeze({
  "morpho-blue":
    "Morpho Blue is per-market, and a market's collateral is valued by an oracle contract named in the market parameters — reading a position means reading that oracle too, at the same block, and this package will not guess which oracle a market id points at. Read the market's oracle with OraclePriceRead and value the position from it.",
  "uniswap-v3":
    "A Uniswap v3 LP position is an amount of liquidity between two ticks, not a token balance: turning it into amounts needs the pool's current tick and the tick-math conversion, and the uncollected fees need the per-position fee growth checkpoints. That is a different job from reading a balance and it is not implemented here.",
  "uniswap-v2":
    "A Uniswap v2 LP position is a share of the pool's reserves, which is readable — but a reserve-derived value is manipulable within a block, and pricing it needs the spot reserves and an independent price for at least one side. Price the underlying assets with PriceQuote or OraclePriceRead instead.",
  lido: "stETH is a rebasing ERC-20: the balance IS the position, so read it as a token balance in PortfolioValuation and price it as an asset. wstETH needs the wrapper's exchange rate, which is an ERC-4626-shaped read this package does not pin an address for.",
  maker:
    "A Maker vault is an urn in the CDP engine, addressed by ilk and urn rather than by owner, with the debt scaled by a per-ilk rate accumulator. Reading it needs the ilk registry, which is not pinned here.",
});

export type PositionRequest = {
  readonly protocol: Protocol;
  readonly chainId: string;
  readonly endpoint: string;
  /** The protocol contract: an Aave Pool, a Comet, or an ERC-4626 vault. */
  readonly contract: string;
  readonly account: string;
  readonly blockTag: string;
  readonly multicall3?: string;
  /** Aave only: the oracle base currency's decimals. Defaults to 8 with a flag. */
  readonly baseCurrencyDecimals?: number;
  /** Compound v3 only: collateral assets to read balances for. */
  readonly collateralAssets?: ReadonlyArray<string>;
};

export type PositionProvenance = {
  readonly protocol: Protocol;
  readonly chainId: string;
  readonly endpoint: string;
  readonly contract: string;
  readonly account: string;
  readonly blockTag: string;
  /** The view calls this row was assembled from, so the read is reproducible. */
  readonly calls: ReadonlyArray<string>;
};

export type PositionRow = {
  readonly protocol: Protocol;
  readonly provenance: PositionProvenance;
  /** Protocol-specific figures, each labelled with its own basis. */
  readonly figures: Readonly<Record<string, string | number | boolean | null>>;
  /** Health, when the protocol has one. Null with a reason when it does not. */
  readonly health: {
    readonly healthFactor: string | null;
    readonly liquidatable: boolean | null;
    readonly collateralDropToLiquidationBps: number | null;
    readonly reason: string;
  };
  readonly notes: ReadonlyArray<string>;
};

/** Aave's health factor and Compound's balances are wad-scaled. */
const WAD_DECIMALS = 18;

/** Aave markets priced in USD use a 1e8 base unit; the rest say so explicitly. */
export const DEFAULT_AAVE_BASE_DECIMALS = 8;

export async function readPosition(
  request: PositionRequest,
  options: RpcOptions = {},
): Promise<PositionRow> {
  switch (request.protocol) {
    case "aave-v3":
      return readAaveV3(request, options);
    case "compound-v3":
      return readCompoundV3(request, options);
    default:
      return readErc4626(request, options);
  }
}

async function readAaveV3(request: PositionRequest, options: RpcOptions): Promise<PositionRow> {
  const contract = normalizeAddress(request.contract, "the Aave v3 Pool address");
  const account = normalizeAddress(request.account, "account");
  const results = await issue(
    request,
    [
      {
        to: contract,
        data: callWithAddress(SELECTORS.getUserAccountData, account, "account"),
        label: "getUserAccountData(address)",
      },
    ],
    options,
  );

  const [
    collateralBase,
    debtBase,
    availableBorrowsBase,
    liquidationThresholdBps,
    ltvBps,
    healthFactorWad,
  ] = decodeWords(
    required(results[0], "getUserAccountData(address)"),
    6,
    "getUserAccountData(address)",
  ) as [bigint, bigint, bigint, bigint, bigint, bigint];

  const baseDecimals = request.baseCurrencyDecimals ?? DEFAULT_AAVE_BASE_DECIMALS;
  if (!Number.isSafeInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 36) {
    throw new DefiError(
      `baseCurrencyDecimals must be an integer from 0 to 36, got ${baseDecimals}`,
    );
  }
  const notes: string[] = [];
  if (request.baseCurrencyDecimals === undefined) {
    notes.push(
      `collateral and debt are reported in the market's base currency at the default ${DEFAULT_AAVE_BASE_DECIMALS} decimals, which is what Aave's USD markets use; pass baseCurrencyDecimals for a market with a different BASE_CURRENCY_UNIT`,
    );
  }

  const collateral = fixed(collateralBase, baseDecimals);
  const debt = fixed(debtBase, baseDecimals);

  // type(uint256).max is Aave's "no debt" sentinel. As a wad it is about
  // 1.15e59, which sorts, compares and prints as an extremely healthy
  // position — which is exactly why it must not reach a caller as a number.
  const noDebt = debtBase === 0n || healthFactorWad === UINT256_MAX;
  const health = noDebt
    ? {
        healthFactor: null,
        liquidatable: false,
        collateralDropToLiquidationBps: null,
        reason:
          "no debt, so there is no health factor; Aave returns type(uint256).max here and reporting it as a number would read as an extraordinarily safe position",
      }
    : healthFrom(fixed(healthFactorWad, WAD_DECIMALS));

  return {
    protocol: "aave-v3",
    provenance: provenanceOf(request, contract, account, ["getUserAccountData(address)"]),
    figures: {
      totalCollateralBase: toDecimalString(collateral),
      totalDebtBase: toDecimalString(debt),
      availableBorrowsBase: toDecimalString(fixed(availableBorrowsBase, baseDecimals)),
      baseCurrencyDecimals: baseDecimals,
      baseCurrencyDecimalsAssumed: request.baseCurrencyDecimals === undefined,
      currentLiquidationThresholdBps: Number(liquidationThresholdBps),
      ltvBps: Number(ltvBps),
      healthFactorWad: healthFactorWad === UINT256_MAX ? null : healthFactorWad.toString(),
    },
    health,
    notes,
  };
}

async function readCompoundV3(request: PositionRequest, options: RpcOptions): Promise<PositionRow> {
  const contract = normalizeAddress(request.contract, "the Compound v3 Comet address");
  const account = normalizeAddress(request.account, "account");
  const collateralAssets = (request.collateralAssets ?? []).map((asset, i) =>
    normalizeAddress(asset, `collateralAssets[${i}]`),
  );

  const calls: BatchCall[] = [
    { to: contract, data: callNoArgs(SELECTORS.baseToken), label: "baseToken()" },
    {
      to: contract,
      data: callWithAddress(SELECTORS.balanceOf, account, "account"),
      label: "balanceOf(address)",
    },
    {
      to: contract,
      data: callWithAddress(SELECTORS.borrowBalanceOf, account, "account"),
      label: "borrowBalanceOf(address)",
    },
    {
      to: contract,
      data: callWithAddress(SELECTORS.isLiquidatable, account, "account"),
      label: "isLiquidatable(address)",
    },
    ...collateralAssets.map((asset) => ({
      to: contract,
      data: callWithAddresses(SELECTORS.collateralBalanceOf, account, asset, "collateralBalanceOf"),
      label: `collateralBalanceOf(address,${asset})`,
    })),
  ];
  const results = await issue(request, calls, options);

  const baseTokenWord = decodeWords(
    required(results[0], "baseToken()"),
    1,
    "baseToken()",
  )[0] as bigint;
  const baseTokenAddress = addressFromWord(baseTokenWord);
  const supplied = decodeWords(
    required(results[1], "balanceOf(address)"),
    1,
    "balanceOf(address)",
  )[0] as bigint;
  const borrowed = decodeWords(
    required(results[2], "borrowBalanceOf(address)"),
    1,
    "borrowBalanceOf(address)",
  )[0] as bigint;
  const liquidatableWord = decodeWords(
    required(results[3], "isLiquidatable(address)"),
    1,
    "isLiquidatable(address)",
  )[0] as bigint;

  const collateral: Record<string, string> = {};
  const notes: string[] = [];
  if (baseTokenAddress.paddingDirty) {
    notes.push(
      "baseToken() returned a word whose top 12 bytes are not zero; the low 20 are read as the address, as an ABI decoder does, but a conforming contract does not do that — check that this Comet address is the market you meant",
    );
  }
  collateralAssets.forEach((asset, index) => {
    const outcome = results[4 + index];
    if (outcome === undefined || !outcome.ok) {
      // One unreadable collateral balance does not invalidate the rest of the
      // position; it is named so nobody reads its absence as a zero balance.
      notes.push(
        `collateralBalanceOf for ${asset} could not be read: ${outcome?.reason ?? "no row returned"}`,
      );
      return;
    }
    const amount = decodeWords(outcome.data, 1, `collateralBalanceOf(${asset})`)[0] as bigint;
    collateral[asset] = amount.toString();
  });

  notes.push(
    "supplied and borrowed are in the base token's own units, not a common currency — read the base token's decimals before valuing them",
  );
  if (supplied > 0n && borrowed > 0n) {
    notes.push(
      "both a supply and a borrow balance are non-zero, which Comet's single-base-asset design does not produce; check that this Comet address is the market you meant",
    );
  }

  return {
    protocol: "compound-v3",
    provenance: provenanceOf(
      request,
      contract,
      account,
      calls.map((call) => call.label),
    ),
    figures: {
      baseToken: baseTokenAddress.address,
      suppliedBase: supplied.toString(),
      borrowedBase: borrowed.toString(),
      collateral: JSON.stringify(collateral),
    },
    health: {
      healthFactor: null,
      liquidatable: liquidatableWord !== 0n,
      collateralDropToLiquidationBps: null,
      reason:
        "Compound v3 publishes no health factor; `liquidatable` is the protocol's own isLiquidatable(address) verdict rather than one derived here, because Comet's collateral factors are per asset and a derived answer would disagree with the protocol UI",
    },
    notes,
  };
}

async function readErc4626(request: PositionRequest, options: RpcOptions): Promise<PositionRow> {
  const contract = normalizeAddress(request.contract, "the ERC-4626 vault address");
  const account = normalizeAddress(request.account, "account");

  const shareCall: BatchCall[] = [
    {
      to: contract,
      data: callWithAddress(SELECTORS.balanceOf, account, "account"),
      label: "balanceOf(address)",
    },
    { to: contract, data: callNoArgs(SELECTORS.asset), label: "asset()" },
    { to: contract, data: callNoArgs(SELECTORS.decimals), label: "decimals()" },
  ];
  const first = await issue(request, shareCall, options);
  const shares = decodeWords(
    required(first[0], "balanceOf(address)"),
    1,
    "balanceOf(address)",
  )[0] as bigint;
  const assetAddress = addressFromWord(
    decodeWords(required(first[1], "asset()"), 1, "asset()")[0] as bigint,
  );
  const shareDecimals = Number(
    decodeWords(required(first[2], "decimals()"), 1, "decimals()")[0] as bigint,
  );
  if (!Number.isSafeInteger(shareDecimals) || shareDecimals < 0 || shareDecimals > 36) {
    throw new DefiError(
      `the vault answered decimals() with ${shareDecimals}, which is not a token decimalisation`,
    );
  }

  // The second round trip is unavoidable: convertToAssets takes the share
  // balance that the first read returned. Both are at the same pinned block
  // tag, which is what makes them one answer rather than two.
  const second = await issue(
    request,
    [
      {
        to: contract,
        data: callWithUint256(SELECTORS.convertToAssets, shares, "shares"),
        label: "convertToAssets(uint256)",
      },
    ],
    options,
  );
  const assets = decodeWords(
    required(second[0], "convertToAssets(uint256)"),
    1,
    "convertToAssets(uint256)",
  )[0] as bigint;

  return {
    protocol: "erc4626",
    provenance: provenanceOf(request, contract, account, [
      "balanceOf(address)",
      "asset()",
      "decimals()",
      "convertToAssets(uint256)",
    ]),
    figures: {
      shares: shares.toString(),
      shareDecimals,
      asset: assetAddress.address,
      assetsRedeemable: assets.toString(),
    },
    health: {
      healthFactor: null,
      liquidatable: null,
      collateralDropToLiquidationBps: null,
      reason: "an ERC-4626 share is not a borrow position, so it has no health factor",
    },
    notes: [
      "assetsRedeemable is convertToAssets(shares), which is what the vault says these shares are worth — not totalAssets()/totalSupply(), which is the same figure only for a vault with no entry or exit fee",
      "assetsRedeemable is in the UNDERLYING asset's units; read that token's decimals before valuing it",
      ...(assetAddress.paddingDirty
        ? [
            "asset() returned a word whose top 12 bytes are not zero; the low 20 are read as the address, as an ABI decoder does, but a conforming vault does not do that",
          ]
        : []),
    ],
  };
}

/**
 * Health from a wad health factor.
 *
 * `collateralDropToLiquidationBps` is `10000 - 10000/HF`: the fraction the
 * collateral basket may lose before HF reaches 1. It needs no assumption about
 * which asset moves, which is precisely why it is reported instead of a
 * liquidation price. A position already below 1 has no room left, so it floors
 * at zero rather than going negative.
 */
function healthFrom(healthFactor: Fixed): PositionRow["health"] {
  const one = fromInteger(1n);
  const liquidatable = compare(healthFactor, one) < 0;
  return {
    healthFactor: toDecimalString(healthFactor),
    liquidatable,
    // 10000/HF is what the basket would have to be worth, relative to now, for
    // HF to reach 1; the room above that is the drop it can take. It is
    // computed only for a position that HAS room: Aave answers a health factor
    // of exactly ZERO for an account that still owes against collateral whose
    // liquidation threshold has been set to nothing, and dividing by it threw
    // DecimalError out of the tool — so the one position with no room left was
    // the one position this could not report at all.
    collateralDropToLiquidationBps: liquidatable
      ? 0
      : Math.max(0, 10_000 - ratioBps(one, healthFactor)),
    reason: liquidatable
      ? "the health factor is below 1, so this position is liquidatable now"
      : "the collateral basket may fall by collateralDropToLiquidationBps before the health factor reaches 1; no liquidation price is given because that would require assuming which collateral moves",
  };
}

async function issue(
  request: PositionRequest,
  calls: ReadonlyArray<BatchCall>,
  options: RpcOptions,
): Promise<ReadonlyArray<CallOutcome>> {
  return batchCalls(request.endpoint, calls, request.blockTag, {
    ...options,
    chainId: request.chainId,
    ...(request.multicall3 === undefined ? {} : { multicall3: request.multicall3 }),
  });
}

function provenanceOf(
  request: PositionRequest,
  contract: string,
  account: string,
  calls: ReadonlyArray<string>,
): PositionProvenance {
  return {
    protocol: request.protocol,
    chainId: request.chainId,
    endpoint: endpointLabel(request.endpoint),
    contract,
    account,
    blockTag: request.blockTag,
    calls,
  };
}

function required(outcome: CallOutcome | undefined, label: string): string {
  if (outcome === undefined) throw new DefiError(`the batch returned no row for ${label}`);
  if (!outcome.ok) throw new DefiError(outcome.reason);
  return outcome.data;
}
