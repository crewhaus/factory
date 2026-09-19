/**
 * A recorded chain and two recorded price providers, and the stub that serves
 * them.
 *
 * Nothing in this package's suite opens a socket: `_setFetch` is replaced with
 * `serve(...)` and every byte a test sees comes from here. That is not just
 * hygiene — a test that dialled a public RPC would fail on a runner with no
 * egress and flake on somebody else's rate limit, and a test that dialled a
 * price provider would assert today's Bitcoin price.
 *
 * Two things this file does deliberately:
 *
 *   1. **Return data is encoded by `@crewhaus/tool-onchain`'s own ABI coder**,
 *      through its public `AbiEncodeCall` tool, rather than by hand. The
 *      decoders in `./lib/abi` are therefore checked against the real encoder
 *      instead of against a second hand-rolled version of themselves, which
 *      would agree with them about any mistake they shared.
 *   2. **The node really implements Multicall3.** `aggregate3` calldata is
 *      decoded, each sub-call is dispatched against the same routing table,
 *      and the results are re-encoded — so the same scenario can be run with
 *      and without a pinned Multicall3 address and the two answers compared.
 *      A stub that special-cased the batch would prove nothing about the path
 *      production takes.
 */
import { abiDecode, abiEncodeCall } from "@crewhaus/tool-onchain";
import type { DefiFetch } from "./lib/rpc";

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and these two tools never read it.
const ctx = {} as any;

/** ABI-encode a tuple of values, as a contract's return data (no selector). */
export async function encodeReturn(
  types: ReadonlyArray<string>,
  args: ReadonlyArray<unknown>,
): Promise<string> {
  const out = JSON.parse(
    (await abiEncodeCall.execute({ signature: `f(${types.join(",")})`, args }, ctx)) as string,
  ) as { data: string };
  return `0x${out.data.slice(10)}`;
}

async function decodeOne(type: string, data: string): Promise<unknown> {
  const out = JSON.parse((await abiDecode.execute({ data, types: [type] }, ctx)) as string) as {
    values: unknown[];
  };
  return out.values[0];
}

// ─── addresses ──────────────────────────────────────────────────────────────

/** Mainnet-shaped addresses. Lowercase: this package shape-checks, it does not checksum. */
export const ADDR = Object.freeze({
  wallet: "0x1111111111111111111111111111111111111111",
  chainlinkEthUsd: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
  pyth: "0x4305fb66699c3b2702d4d05cf36551390a4c69c6",
  aavePool: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
  comet: "0xc3d688b66703497daa19211eedff47f25384cdc3",
  vault4626: "0x83f20f44975d03b1b09e64809b757c47f942beea",
  usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  multicall3: "0xca11bde05977b3631167028862be2a173976ca11",
  spam: "0xdead000000000000000000000000000000000001",
});

export const SELECTOR_TEXT = Object.freeze({
  decimals: "0x313ce567",
  description: "0x7284e416",
  latestRoundData: "0xfeaf968c",
  balanceOf: "0x70a08231",
  getPriceUnsafe: "0x96834ad3",
  getUserAccountData: "0xbf92857c",
  convertToAssets: "0x07a2d13a",
  asset: "0x38d52e0f",
  borrowBalanceOf: "0x374c49b4",
  baseToken: "0xc55dae63",
  collateralBalanceOf: "0x5c2549ee",
  isLiquidatable: "0x042e02cf",
  aggregate3: "0x82ad56cb",
});

/** A Pyth price id. Any 32 bytes will do; this is the shape, not the value. */
export const ETH_USD_PRICE_ID = `0x${"ff".repeat(32)}`;

// ─── the recorded chain ─────────────────────────────────────────────────────

/** A sub-call's answer: return data, or a revert. */
export type CallAnswer = { readonly data: string } | { readonly revert: string };

export type ChainState = {
  blockNumber: bigint;
  /** `${to}|${calldata}` -> answer. Exact calldata, so a wrong argument misses. */
  readonly calls: Map<string, CallAnswer>;
  /** address -> wei. */
  readonly balances: Map<string, bigint>;
  /** Where Multicall3 is, when this chain has it. */
  multicall3?: string;
};

export function newChain(blockNumber = 21_000_000n): ChainState {
  return { blockNumber, calls: new Map(), balances: new Map() };
}

export function route(chain: ChainState, to: string, calldata: string, answer: CallAnswer): void {
  chain.calls.set(`${to.toLowerCase()}|${calldata.toLowerCase()}`, answer);
}

/** `latestRoundData()`, `decimals()` and `description()` for one Chainlink feed. */
export async function chainlinkFeed(
  chain: ChainState,
  address: string,
  feed: {
    roundId: bigint;
    answer: bigint;
    startedAt: bigint;
    updatedAt: bigint;
    answeredInRound: bigint;
    decimals: number;
    description?: string | null;
  },
): Promise<void> {
  route(chain, address, SELECTOR_TEXT.latestRoundData, {
    data: await encodeReturn(
      ["uint80", "int256", "uint256", "uint256", "uint80"],
      [
        feed.roundId.toString(),
        feed.answer.toString(),
        feed.startedAt.toString(),
        feed.updatedAt.toString(),
        feed.answeredInRound.toString(),
      ],
    ),
  });
  route(chain, address, SELECTOR_TEXT.decimals, {
    data: await encodeReturn(["uint8"], [String(feed.decimals)]),
  });
  if (feed.description === null) {
    route(chain, address, SELECTOR_TEXT.description, { revert: "0x" });
  } else {
    route(chain, address, SELECTOR_TEXT.description, {
      data: await encodeReturn(["string"], [feed.description ?? "ETH / USD"]),
    });
  }
}

/** One Pyth price, under `getPriceUnsafe(priceId)`. */
export async function pythFeed(
  chain: ChainState,
  address: string,
  priceId: string,
  price: { price: bigint; confidence: bigint; exponent: number; publishTime: bigint },
): Promise<void> {
  const calldata = SELECTOR_TEXT.getPriceUnsafe + priceId.replace(/^0x/, "");
  route(chain, address, calldata, {
    data: await encodeReturn(
      ["int64", "uint64", "int32", "uint256"],
      [
        price.price.toString(),
        price.confidence.toString(),
        String(price.exponent),
        price.publishTime.toString(),
      ],
    ),
  });
}

/** An ERC-20's `balanceOf(wallet)` and `decimals()`. */
export async function erc20(
  chain: ChainState,
  token: string,
  wallet: string,
  balance: bigint,
  decimals: number | null,
): Promise<void> {
  route(chain, token, SELECTOR_TEXT.balanceOf + wallet.replace(/^0x/, "").padStart(64, "0"), {
    data: await encodeReturn(["uint256"], [balance.toString()]),
  });
  if (decimals === null) {
    route(chain, token, SELECTOR_TEXT.decimals, { revert: "0x" });
  } else {
    route(chain, token, SELECTOR_TEXT.decimals, {
      data: await encodeReturn(["uint8"], [String(decimals)]),
    });
  }
}

/** Aave v3 `getUserAccountData(account)`. */
export async function aaveAccount(
  chain: ChainState,
  pool: string,
  account: string,
  data: {
    collateralBase: bigint;
    debtBase: bigint;
    availableBorrowsBase: bigint;
    liquidationThresholdBps: bigint;
    ltvBps: bigint;
    healthFactorWad: bigint;
  },
): Promise<void> {
  route(
    chain,
    pool,
    SELECTOR_TEXT.getUserAccountData + account.replace(/^0x/, "").padStart(64, "0"),
    {
      data: await encodeReturn(
        ["uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
        [
          data.collateralBase.toString(),
          data.debtBase.toString(),
          data.availableBorrowsBase.toString(),
          data.liquidationThresholdBps.toString(),
          data.ltvBps.toString(),
          data.healthFactorWad.toString(),
        ],
      ),
    },
  );
}

// ─── the stub ───────────────────────────────────────────────────────────────

export type Recorded = { method: string; url: string; rpcMethod?: string; body?: unknown };

export type ServeOptions = {
  readonly chain?: ChainState;
  /** Absolute URL -> body, or a status to answer with. */
  readonly http?: Record<string, unknown | { status: number; headers?: Record<string, string> }>;
  /** Called before anything is served, so a test can fail one request. */
  readonly intercept?: (req: Request) => Response | undefined;
};

/**
 * Build the fetch stub. It records every request so a test can assert what was
 * NOT asked for, which is how the "a cross only happens when a direct quote
 * failed" claims are checked.
 */
export function serve(options: ServeOptions): { fetch: DefiFetch; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const fetch: DefiFetch = async (req) => {
    const intercepted = options.intercept?.(req);
    if (intercepted !== undefined) {
      recorded.push({ method: req.method, url: req.url });
      return intercepted;
    }
    if (req.method === "POST") {
      const body = (await req.json()) as { method: string; params: unknown[] };
      recorded.push({ method: "POST", url: req.url, rpcMethod: body.method, body: body.params });
      if (options.chain === undefined) {
        return json({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "no chain in this fixture" },
        });
      }
      return handleRpc(options.chain, body);
    }
    recorded.push({ method: "GET", url: req.url });
    const route = options.http?.[req.url];
    if (route === undefined) {
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }
    const asStatus = route as { status?: number; headers?: Record<string, string> };
    if (typeof asStatus?.status === "number") {
      return new Response("", { status: asStatus.status, headers: asStatus.headers ?? {} });
    }
    return new Response(JSON.stringify(route), { status: 200 });
  };
  return { fetch, recorded };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleRpc(
  chain: ChainState,
  body: { method: string; params: unknown[] },
): Promise<Response> {
  if (body.method === "eth_blockNumber") {
    return json({ jsonrpc: "2.0", id: 1, result: `0x${chain.blockNumber.toString(16)}` });
  }
  if (body.method === "eth_getBalance") {
    const address = String(body.params[0] ?? "").toLowerCase();
    const balance = chain.balances.get(address);
    if (balance === undefined) {
      return json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: `no balance recorded for ${address}` },
      });
    }
    return json({ jsonrpc: "2.0", id: 1, result: `0x${balance.toString(16)}` });
  }
  if (body.method !== "eth_call") {
    return json({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: `unexpected method ${body.method}` },
    });
  }
  const call = body.params[0] as { to: string; data: string };
  const to = call.to.toLowerCase();
  const data = call.data.toLowerCase();

  if (chain.multicall3 !== undefined && to === chain.multicall3.toLowerCase()) {
    if (!data.startsWith(SELECTOR_TEXT.aggregate3)) {
      return json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "not an aggregate3 call" },
      });
    }
    const decoded = (await decodeOne("(address,bool,bytes)[]", `0x${data.slice(10)}`)) as Array<
      [string, boolean, string]
    >;
    const rows: Array<[boolean, string]> = [];
    for (const [target, allowFailure, callData] of decoded) {
      const answer = chain.calls.get(`${target.toLowerCase()}|${callData.toLowerCase()}`);
      if (answer === undefined || "revert" in answer) {
        if (!allowFailure) {
          return json({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "a sub-call reverted" },
          });
        }
        rows.push([false, answer === undefined ? "0x" : answer.revert]);
        continue;
      }
      rows.push([true, answer.data]);
    }
    return json({ jsonrpc: "2.0", id: 1, result: await encodeReturn(["(bool,bytes)[]"], [rows]) });
  }

  const answer = chain.calls.get(`${to}|${data}`);
  if (answer === undefined) {
    return json({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32000,
        message: `execution reverted: no route for ${to} ${data.slice(0, 10)}`,
      },
    });
  }
  if ("revert" in answer) {
    return json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
  }
  return json({ jsonrpc: "2.0", id: 1, result: answer.data });
}

// ─── recorded provider documents ────────────────────────────────────────────

/** Frankfurter's shape. The rate is a bare JSON NUMBER, which is the point. */
export function frankfurter(base: string, quote: string, rate: number, date: string): unknown {
  return { amount: 1.0, base, date, rates: { [quote]: rate } };
}

/** Coinbase's shape. The amount is a STRING, and there is no timestamp anywhere. */
export function coinbaseSpot(base: string, currency: string, amount: string): unknown {
  return { data: { base, currency, amount } };
}

export const FRANKFURTER = "https://api.frankfurter.app";
export const COINBASE = "https://api.coinbase.com";

export const frankfurterUrl = (base: string, quote: string, at?: string): string =>
  `${FRANKFURTER}/${at ?? "latest"}?from=${base}&to=${quote}`;

export const coinbaseUrl = (base: string, quote: string): string =>
  `${COINBASE}/v2/prices/${base}-${quote}/spot`;
