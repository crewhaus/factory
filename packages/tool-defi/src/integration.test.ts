/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, including the `tool_config` path — the
 * endpoint table and the pinned feeds arrive per call in a pool run, and a
 * tool that only read its boot registration would work in a unit test and
 * quietly read the wrong chain in production.
 *
 * The last block is the walkthrough these four exist for.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  ADDR,
  type ChainState,
  chainlinkFeed,
  coinbaseSpot,
  coinbaseUrl,
  erc20,
  frankfurter,
  frankfurterUrl,
  newChain,
  serve,
} from "./fixtures";
import { DEFI_TOOLS, _resetDefiConfig, _setClock, _setFetch, registerDefiConfig } from "./index";

const ENDPOINT = "https://node.example/v2/SECRET-KEY";
const NOW = 1_757_000_000;

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

/** A chain with the ETH/USD feed, Multicall3, a wallet balance and USDC. */
async function scenario(): Promise<ChainState> {
  const chain = newChain(21_000_000n);
  chain.multicall3 = ADDR.multicall3;
  chain.balances.set(ADDR.wallet, 2_500_000_000_000_000_000n);
  await chainlinkFeed(chain, ADDR.chainlinkEthUsd, {
    roundId: 42n,
    answer: 342_155_000_000n,
    startedAt: BigInt(NOW - 60),
    updatedAt: BigInt(NOW - 60),
    answeredInRound: 42n,
    decimals: 8,
  });
  await erc20(chain, ADDR.usdc, ADDR.wallet, 2_500_000_000n, 6);
  // An airdropped token with a balance, no market, and no readable decimals.
  await erc20(chain, ADDR.spam, ADDR.wallet, 999_000_000_000_000_000_000n, null);
  return chain;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of DEFI_TOOLS) catalog.register(tool);
  _setClock(() => NOW);
});

afterEach(() => {
  _setFetch(undefined);
  _setClock(undefined);
  _resetDefiConfig();
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(DEFI_TOOLS.length);
  });
});

describe("dispatch through executeTool", () => {
  test("input is validated before execute, so a bad shape never reaches the network", async () => {
    let dialled = false;
    _setFetch(async () => {
      dialled = true;
      return new Response("{}");
    });
    const result = await executeTool(lookup("PriceQuote"), { base: 42 }, { toolUseId: "t1" });
    expect(result.isError).toBe(true);
    expect(dialled).toBe(false);
  });

  test("an unknown field is rejected, because every schema here is strict", async () => {
    const result = await executeTool(
      lookup("PriceQuote"),
      { base: "EUR", quote: "USD", privateKey: "0xdeadbeef" },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
  });

  test("a refusal is an error result with its reason, not a crash", async () => {
    _setFetch(serve({ http: {} }).fetch);
    const result = await executeTool(
      lookup("PriceQuote"),
      { base: "BTC", quote: "USD", at: "2026-01-16" },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("cannot be told apart from today's");
  });

  test("a valid call returns a non-error result", async () => {
    _setFetch(
      serve({
        http: { [frankfurterUrl("EUR", "USD")]: frankfurter("EUR", "USD", 1.0891, "2026-09-17") },
      }).fetch,
    );
    const result = await executeTool(
      lookup("PriceQuote"),
      { base: "EUR", quote: "USD" },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain('"price":"1.0891"');
  });

  test("a cancelled run comes back with the deadline as the reason, not a bare failure", async () => {
    const controller = new AbortController();
    controller.abort(new Error("the run was cancelled"));
    _setFetch(async (req) => {
      if (req.signal.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return new Response("{}");
    });
    registerDefiConfig({ rpc: { "1": ENDPOINT } });
    const result = await executeTool(
      lookup("OraclePriceRead"),
      { chainId: "1", kind: "chainlink", address: ADDR.chainlinkEthUsd },
      { toolUseId: "t5", signal: controller.signal },
    );
    // `isError` alone is what a timeout, a 503 and a bad address all return.
    // The reason is the assertion.
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("could not pin a block");
    expect(String(result.content)).toContain("deadline elapsed");
  });
});

describe("tool_config through the executor", () => {
  test("a per-call config block supplies the endpoint and the pinned feed", async () => {
    _setFetch(serve({ chain: await scenario() }).fetch);
    // Nothing is registered at boot: the whole table arrives with the call.
    const result = await executeTool(
      lookup("OraclePriceRead"),
      { feed: "eth-usd" },
      {
        toolUseId: "c1",
        toolConfig: {
          rpc: { "1": ENDPOINT },
          multicall3: { "1": ADDR.multicall3 },
          feeds: {
            "eth-usd": {
              chain_id: "1",
              kind: "chainlink",
              address: ADDR.chainlinkEthUsd,
              heartbeat_seconds: 3600,
            },
          },
        },
      },
    );
    expect(result.isError).toBe(false);
    const out = JSON.parse(String(result.content)) as Record<string, unknown>;
    expect(out["price"]).toBe("3421.55");
    expect((out["signals"] as Record<string, unknown>)["heartbeatSeconds"]).toBe(3600);
  });

  test("a per-call block REPLACES the boot registration rather than merging into it", async () => {
    _setFetch(serve({ chain: await scenario() }).fetch);
    registerDefiConfig({
      rpc: { "1": ENDPOINT },
      feeds: { "eth-usd": { chain_id: "1", kind: "chainlink", address: ADDR.chainlinkEthUsd } },
    });
    const result = await executeTool(
      lookup("OraclePriceRead"),
      { feed: "eth-usd" },
      { toolUseId: "c2", toolConfig: { rpc: { "1": ENDPOINT } } },
    );
    // The override has no feeds, so the boot table's feed is NOT visible.
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("none are pinned");
  });

  test("a non-object config block is ignored, not widened", async () => {
    _setFetch(serve({ chain: await scenario() }).fetch);
    const result = await executeTool(
      lookup("OraclePriceRead"),
      { chainId: "1", kind: "chainlink", address: ADDR.chainlinkEthUsd },
      { toolUseId: "c3", toolConfig: "use whatever node you like" },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("the table is empty");
  });
});

describe("the valuation these exist for", () => {
  test("read the feed, cross a quote, and value a wallet with an unpriced residue", async () => {
    const chain = await scenario();
    _setFetch(
      serve({
        chain,
        http: {
          [coinbaseUrl("BTC", "EUR")]: { status: 404 },
          [coinbaseUrl("EUR", "BTC")]: { status: 404 },
          [coinbaseUrl("BTC", "USD")]: coinbaseSpot("BTC", "USD", "64000"),
          [frankfurterUrl("USD", "EUR")]: frankfurter("USD", "EUR", 0.92, "2026-09-17"),
        },
      }).fetch,
    );
    const config = { rpc: { "1": ENDPOINT }, multicall3: { "1": ADDR.multicall3 } };

    // 1. The feed answers, and it says which round the answer belongs to.
    const oracle = await executeTool(
      lookup("OraclePriceRead"),
      { chainId: "1", kind: "chainlink", address: ADDR.chainlinkEthUsd, heartbeatSeconds: 3600 },
      { toolUseId: "v1", toolConfig: config },
    );
    expect(oracle.isError).toBe(false);
    const feed = JSON.parse(String(oracle.content)) as Record<string, unknown>;
    expect(feed["price"]).toBe("3421.55");
    expect((feed["signals"] as Record<string, unknown>)["answeredInRoundBehindRoundId"]).toBe(
      false,
    );

    // 2. A pair nobody publishes is crossed, and says through what.
    const quote = await executeTool(
      lookup("PriceQuote"),
      { base: "BTC", quote: "EUR" },
      { toolUseId: "v2" },
    );
    expect(quote.isError).toBe(false);
    const crossed = JSON.parse(String(quote.content)) as Record<string, unknown>;
    expect(crossed["derivation"]).toBe("cross");
    expect(crossed["via"]).toBe("USD");

    // 3. The portfolio: two priced holdings, and one that cannot be priced.
    const valuation = await executeTool(
      lookup("PortfolioValuation"),
      {
        quoteCurrency: "USD",
        chainId: "1",
        wallet: ADDR.wallet,
        holdings: [
          {
            asset: "ETH",
            native: true,
            oracle: { kind: "chainlink", address: ADDR.chainlinkEthUsd },
          },
          { asset: "USDC", token: ADDR.usdc, price: "1" },
          { asset: "SPAM", token: ADDR.spam },
        ],
      },
      { toolUseId: "v3", toolConfig: config },
    );
    expect(valuation.isError).toBe(false);
    const portfolio = JSON.parse(String(valuation.content)) as Record<string, unknown>;

    // 2.5 ETH at 3421.55 is 8553.88 (half-even), plus 2500 USDC.
    expect((portfolio["total"] as Record<string, unknown>)["value"]).toBe("11053.88");
    expect((portfolio["priced"] as unknown[]).length).toBe(2);

    // And the residue is a NAMED row, not an absence. This is the whole point:
    // the total above is honest precisely because this is visible next to it.
    const unpriced = portfolio["unpriced"] as Array<Record<string, unknown>>;
    expect(unpriced.length).toBe(1);
    expect(unpriced[0]?.["asset"]).toBe("SPAM");
    expect(String(unpriced[0]?.["reason"])).toContain("no price source");
    expect(String((portfolio["notes"] as string[]).join(" "))).toContain("NOT in the total");
    expect((portfolio["coverage"] as Record<string, unknown>)["unpricedCount"]).toBe(1);

    // Everything came from one block, which is what makes the total a figure
    // that existed at a height rather than an average of several.
    expect(portfolio["blockNumber"]).toBe("21000000");
    expect(JSON.stringify(portfolio)).not.toContain("SECRET-KEY");
  });
});
