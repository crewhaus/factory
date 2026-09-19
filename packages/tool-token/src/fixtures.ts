/**
 * Recorded chain answers, and a reader stub that serves them.
 *
 * Every test in this package drives `_setChainReader` with one of these. None
 * of them opens a socket, because there is nothing under the seam to open one
 * with — a suite that reached a public RPC endpoint would fail on a CI runner
 * with no egress and flake on somebody else's rate limit.
 *
 * The tokens here are the ones that break naive readers, and they are
 * modelled on real contracts rather than invented:
 *
 *   - a six-decimal stablecoin, the ordinary case;
 *   - a `bytes32` symbol, which is what MKR and other 2017-era tokens return
 *     because the ABI was not settled when they deployed;
 *   - a token whose `decimals()` reverts, which must come back as unknown and
 *     never as 18;
 *   - two impostors claiming a listed ticker, one of them with a Cyrillic \u0421;
 *   - an address with no code at all.
 *
 * The Multicall3 stub does a real ABI round trip through `tool-onchain`'s
 * codec rather than a hand-written fake of one: it decodes the batch this
 * package encoded and encodes the `(bool,bytes)[]` the package decodes. A
 * fixture that faked the encoding would pass against a broken encoder.
 */
import { MULTICALL3_ADDRESS, abiDecode, abiEncodeCall } from "@crewhaus/tool-onchain";
import type { ChainRead, ChainReader } from "./lib/chain";
import { SELECTOR } from "./lib/erc";

// ─── encoding helpers ───────────────────────────────────────────────────────

const hexBody = (value: string): string => value.replace(/^0x/, "");

/** A 32-byte word from an unsigned integer. */
export const word = (value: bigint): string => value.toString(16).padStart(64, "0");

export const encodeUint = (value: bigint): string => `0x${word(value)}`;

export const encodeAddress = (address: string): string =>
  `0x${hexBody(address).toLowerCase().padStart(64, "0")}`;

export const encodeBool = (value: boolean): string => encodeUint(value ? 1n : 0n);

/** A dynamic `string` return: offset, length, then the bytes, padded. */
export function encodeString(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let data = "";
  for (const b of bytes) data += b.toString(16).padStart(2, "0");
  const padded = data.padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `0x${word(32n)}${word(BigInt(bytes.length))}${padded}`;
}

/** The pre-standard `bytes32` symbol: the text, left-aligned, NUL-padded. */
export function encodeBytes32String(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 32) throw new Error(`"${text}" does not fit in a bytes32`);
  let data = "";
  for (const b of bytes) data += b.toString(16).padStart(2, "0");
  return `0x${data.padEnd(64, "0")}`;
}

const strip = (call: string): string => `0x${call.slice(10)}`;

async function encodeCall(signature: string, args: ReadonlyArray<unknown>): Promise<string> {
  const out = await abiEncodeCall.execute({ signature, args });
  if (typeof out !== "string") throw new Error("AbiEncodeCall did not return a string");
  return (JSON.parse(out) as { data: string }).data;
}

/** `Error(string)` revert data — the selector is the one Solidity emits. */
export async function revertWith(message: string): Promise<string> {
  return encodeCall("Error(string)", [message]);
}

// ─── the contracts ──────────────────────────────────────────────────────────

/** What one contract answers for one call. A revert is an answer, not a throw. */
export type CallAnswer = { readonly ok: boolean; readonly data: string };

export const answers = (data: string): CallAnswer => ({ ok: true, data });
export const reverts = (revertData: string): CallAnswer => ({ ok: false, data: revertData });
/** What a contract without that function returns: nothing at all. */
export const NOTHING: CallAnswer = { ok: true, data: "0x" };

export type ContractHandler = (selector: string, args: string) => CallAnswer;

export const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const IMPOSTOR_USDC = "0x1111111111111111111111111111111111111111";
export const CYRILLIC_USDC = "0x2222222222222222222222222222222222222222";
export const MKR = "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2";
export const BROKEN = "0x3333333333333333333333333333333333333333";
export const NOT_A_CONTRACT = "0x4444444444444444444444444444444444444444";
export const APE_NFT = "0x5555555555555555555555555555555555555555";
export const GAME_1155 = "0x6666666666666666666666666666666666666666";
export const ONCHAIN_NFT = "0x7777777777777777777777777777777777777777";
export const LIAR_165 = "0x8888888888888888888888888888888888888888";

export const ALICE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
export const BOB = "0x388C818CA8B9251b393131C08a736A67ccB19297";
export const SPENDER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

const addressArg = (args: string, index = 0): string =>
  `0x${args.slice(index * 64 + 24, index * 64 + 64)}`.toLowerCase();

const uintArg = (args: string, index = 0): bigint =>
  BigInt(`0x${args.slice(index * 64, index * 64 + 64) || "0"}`);

/** A plain ERC-20 whose metadata is all well-formed strings. */
export function erc20(opts: {
  decimals: bigint;
  symbol: string;
  name: string;
  totalSupply: bigint;
  balances?: Record<string, bigint>;
  allowances?: Record<string, bigint>;
  bytes32Metadata?: boolean;
}): ContractHandler {
  const text = opts.bytes32Metadata ? encodeBytes32String : encodeString;
  return (selector, args) => {
    switch (selector) {
      case SELECTOR.decimals:
        return answers(encodeUint(opts.decimals));
      case SELECTOR.symbol:
        return answers(text(opts.symbol));
      case SELECTOR.name:
        return answers(text(opts.name));
      case SELECTOR.totalSupply:
        return answers(encodeUint(opts.totalSupply));
      case SELECTOR.balanceOf:
        return answers(encodeUint(opts.balances?.[addressArg(args)] ?? 0n));
      case SELECTOR.allowance:
        return answers(
          encodeUint(opts.allowances?.[`${addressArg(args, 0)}:${addressArg(args, 1)}`] ?? 0n),
        );
      default:
        return NOTHING;
    }
  };
}

/** An ERC-721 that declares itself properly through ERC-165. */
export function erc721(opts: {
  name: string;
  symbol: string;
  owners: Record<string, string>;
  tokenUris: Record<string, string>;
  missingTokenRevert: string;
  interfaceIds?: ReadonlyArray<string>;
  answersEverything?: boolean;
}): ContractHandler {
  const supported = new Set(opts.interfaceIds ?? ["01ffc9a7", "80ac58cd", "5b5e139f"]);
  return (selector, args) => {
    if (selector === SELECTOR.supportsInterface) {
      const id = args.slice(0, 8).toLowerCase();
      return answers(encodeBool(opts.answersEverything === true || supported.has(id)));
    }
    if (selector === SELECTOR.name) return answers(encodeString(opts.name));
    if (selector === SELECTOR.symbol) return answers(encodeString(opts.symbol));
    if (selector === SELECTOR.ownerOf) {
      const owner = opts.owners[uintArg(args).toString()];
      return owner === undefined ? reverts(opts.missingTokenRevert) : answers(encodeAddress(owner));
    }
    if (selector === SELECTOR.tokenURI) {
      const uri = opts.tokenUris[uintArg(args).toString()];
      return uri === undefined ? reverts(opts.missingTokenRevert) : answers(encodeString(uri));
    }
    return NOTHING;
  };
}

/** An ERC-1155, which has no ownerOf and whose uri carries the {id} template. */
export function erc1155(opts: {
  uriTemplate: string;
  balances: Record<string, bigint>;
  interfaceIds?: ReadonlyArray<string>;
}): ContractHandler {
  const supported = new Set(opts.interfaceIds ?? ["01ffc9a7", "d9b67a26", "0e89341c"]);
  return (selector, args) => {
    if (selector === SELECTOR.supportsInterface) {
      return answers(encodeBool(supported.has(args.slice(0, 8).toLowerCase())));
    }
    if (selector === SELECTOR.uri) return answers(encodeString(opts.uriTemplate));
    if (selector === SELECTOR.balanceOf1155) {
      return answers(encodeUint(opts.balances[`${addressArg(args, 0)}:${uintArg(args, 1)}`] ?? 0n));
    }
    return NOTHING;
  };
}

// ─── the reader stub ────────────────────────────────────────────────────────

export type ChainStub = {
  readonly reader: ChainReader;
  /** Every read that left the package, in order, for assertions about what was asked. */
  readonly reads: ChainRead[];
};

export function chainStub(opts: {
  readonly contracts: Record<string, ContractHandler>;
  readonly nativeBalances?: Record<string, bigint>;
  readonly code?: Record<string, string>;
  readonly blockNumber?: bigint;
  readonly multicall3Address?: string;
  /** Answer the batch call itself with this instead, to test an unusable answer. */
  readonly brokenBatchAnswer?: string;
  /**
   * A Multicall3-shaped contract that implements `aggregate3` and nothing
   * else, so `getEthBalance` and `getBlockNumber` reach its fallback and
   * answer with no data. Real: `multicall3Address` is a caller-supplied
   * address, and an aggregator that is not the canonical deployment has no
   * obligation to carry the helpers.
   */
  readonly withoutMulticallHelpers?: boolean;
}): ChainStub {
  const reads: ChainRead[] = [];
  const multicall = (opts.multicall3Address ?? MULTICALL3_ADDRESS).toLowerCase();
  const handlerFor = (address: string): ContractHandler | undefined =>
    opts.contracts[address.toLowerCase()];

  const dispatch = (target: string, data: string): CallAnswer => {
    const selector = data.slice(0, 10).toLowerCase();
    const args = data.slice(10);
    if (target.toLowerCase() === multicall) {
      if (opts.withoutMulticallHelpers === true) return NOTHING;
      if (selector === SELECTOR.getBlockNumber) return answers(encodeUint(opts.blockNumber ?? 0n));
      if (selector === SELECTOR.getEthBalance) {
        return answers(encodeUint(opts.nativeBalances?.[addressArg(args)] ?? 0n));
      }
      return NOTHING;
    }
    const handler = handlerFor(target);
    // An address with no code answers every call with nothing. That is the
    // whole point of the NOT_A_CONTRACT fixture.
    return handler === undefined ? NOTHING : handler(selector, args);
  };

  const reader: ChainReader = async (read) => {
    reads.push(read);
    if (read.method === "eth_getCode") {
      const address = String(read.params[0]).toLowerCase();
      if (opts.code?.[address] !== undefined) return opts.code[address];
      return handlerFor(address) === undefined ? "0x" : "0x60806040";
    }
    if (read.method === "eth_getBalance") {
      return encodeUint(opts.nativeBalances?.[String(read.params[0]).toLowerCase()] ?? 0n);
    }
    const call = read.params[0] as { to: string; data: string };
    if (call.to.toLowerCase() !== multicall || !call.data.startsWith("0x82ad56cb")) {
      const answer = dispatch(call.to, call.data);
      // An unbatched eth_call cannot return a revert as data: the node errors.
      if (!answer.ok) throw new Error(`execution reverted (${answer.data})`);
      return answer.data;
    }
    if (opts.brokenBatchAnswer !== undefined) return opts.brokenBatchAnswer;

    const decoded = await abiDecode.execute({
      data: strip(call.data),
      types: ["(address,bool,bytes)[]"],
    });
    if (typeof decoded !== "string") throw new Error("AbiDecode did not return a string");
    const [batch] = (JSON.parse(decoded) as { values: [Array<[string, boolean, string]>] }).values;
    const results = batch.map(([to, , callData]) => {
      const answer = dispatch(to, callData);
      return [answer.ok, answer.data];
    });
    return strip(await encodeCall("f((bool,bytes)[])", [results]));
  };

  return { reader, reads };
}

// ─── token lists ────────────────────────────────────────────────────────────

export const UNISWAP_LIST = {
  id: "uniswap-default",
  name: "Uniswap Labs Default",
  tokens: [
    { chainId: 1, address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6 },
    { chainId: 1, address: MKR, symbol: "MKR", name: "Maker", decimals: 18 },
  ],
};

/** A second reputable list that happens to carry a different address for USDC. */
export const RIVAL_LIST = {
  id: "rival-list",
  name: "Somebody Else's List",
  tokens: [{ chainId: 1, address: IMPOSTOR_USDC, symbol: "USDC", name: "USD Coin", decimals: 6 }],
};

/** The Cyrillic \u0421 impostor. It is not the same string, and it looks identical. */
export const CYRILLIC_LIST = {
  id: "shady-list",
  tokens: [
    { chainId: 1, address: CYRILLIC_USDC, symbol: "USD\u0421", name: "USD Coin", decimals: 6 },
  ],
};
