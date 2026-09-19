/**
 * The pure parts, tested without a transport: hex on the wire, the EIP-1559
 * rule, proxy reconciliation, and the predicate the simulation degrades on.
 */
import { describe, expect, test } from "bun:test";
import { functionSelector } from "@crewhaus/tool-onchain";
import { ADDR, aggregate3Return, jsonRpcError, minimalProxyCode, word } from "./fixtures";
import { chunk } from "./lib/batch";
import {
  SELECTORS,
  SELECTOR_SIGNATURES,
  addressArg,
  balanceOfData,
  bytes4Arg,
  checkAddress,
  getEthBalanceData,
  supportsInterfaceData,
} from "./lib/codec";
import {
  BASE_FEE_MAX_CHANGE_DENOMINATOR,
  changeBps,
  medianOf,
  nextBaseFee,
  summarisePercentile,
} from "./lib/fees";
import {
  data as asData,
  blockParam,
  byteLength,
  isZeroWord,
  optionalQuantity,
  quantity,
  toQuantity,
  wordAt,
  wordToAddress,
  wordToBigint,
  wordToBool,
} from "./lib/hex";
import {
  ERC165_INVALID_ID,
  KNOWN_INTERFACES,
  type ProxySignal,
  minimalProxyTarget,
  reconcileProxy,
} from "./lib/proxy";
import {
  ChainCallError,
  type ChainRpc,
  _setRpc,
  isAbort,
  isMethodUnsupported,
  resolveRpc,
  rpcError,
  rpcErrorText,
  rpcRead,
  setChainRpcResolver,
} from "./lib/rpc";
import { parseSimulateV1, revertFromCallError, toWireCall } from "./lib/simulate";

describe("hex — quantities and data are different dialects", () => {
  test("a quantity parses, with or without a node's leading zeros", () => {
    expect(quantity("0x1a", "x")).toBe(26n);
    expect(
      quantity("0x0000000000000000000000000000000000000000000000000000000000000001", "x"),
    ).toBe(1n);
  });

  test("a uint256 survives intact — the value a double would round", () => {
    const max = (1n << 256n) - 1n;
    expect(quantity(`0x${max.toString(16)}`, "x")).toBe(max);
    // The point of never using a number: this is the nearest double, and it
    // is 12 wei away from a balance that was exact on the wire.
    const balance = 123_456_789_012_345_678_901n;
    expect(quantity(`0x${balance.toString(16)}`, "x").toString()).toBe("123456789012345678901");
    expect(Number(balance).toString()).not.toBe("123456789012345678901");
  });

  test("a decimal string is not a quantity", () => {
    expect(() => quantity("26", "the block")).toThrow(ChainCallError);
  });

  test("0x with no digits is not a quantity, but it IS valid data", () => {
    expect(() => quantity("0x", "the block")).toThrow(ChainCallError);
    expect(asData("0x", "return data")).toBe("0x");
  });

  test("data with an odd number of digits is refused as the truncated paste it is", () => {
    expect(() => asData("0x123", "calldata")).toThrow(ChainCallError);
  });

  test("toQuantity refuses a negative, which the wire cannot express", () => {
    expect(() => toQuantity(-1n)).toThrow(ChainCallError);
    expect(toQuantity(0n)).toBe("0x0");
  });

  test("optionalQuantity treats an absent field as absent, not as zero", () => {
    expect(optionalQuantity(undefined, "x")).toBeUndefined();
    expect(optionalQuantity(null, "x")).toBeUndefined();
    expect(optionalQuantity("0x0", "x")).toBe(0n);
  });

  test("wordAt returns undefined for a short answer rather than padding it", () => {
    expect(wordAt(word(7), 0)).toBe(word(7));
    expect(wordAt(word(7), 1)).toBeUndefined();
    // The one that matters: an empty return does not become a zero word.
    expect(wordAt("0x", 0)).toBeUndefined();
  });

  test("a word with dirty top bytes is not an address", () => {
    expect(wordToAddress(`0x${"0".repeat(24)}${"11".repeat(20)}`, "slot")).toBe(
      `0x${"11".repeat(20)}`,
    );
    expect(() =>
      wordToAddress("0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bec8", "slot"),
    ).toThrow(ChainCallError);
  });

  test("bool and zero-word helpers", () => {
    expect(wordToBool(word(0))).toBe(false);
    expect(wordToBool(word(1))).toBe(true);
    expect(isZeroWord(word(0))).toBe(true);
    expect(wordToBigint(word(255))).toBe(255n);
    expect(byteLength("0x0102")).toBe(2);
  });

  test("blockParam: a decimal block number becomes a hex quantity, a tag passes through", () => {
    expect(blockParam("19123456", undefined)).toBe("0x123cd00");
    expect(blockParam(undefined, "finalized")).toBe("finalized");
    expect(blockParam(undefined, undefined)).toBe("latest");
    expect(() => blockParam("0x123", undefined)).toThrow(ChainCallError);
  });
});

describe("codec — the selectors are recomputed, never trusted on sight", () => {
  test("every hardcoded selector equals Keccak of its signature", async () => {
    for (const [name, signature] of Object.entries(SELECTOR_SIGNATURES)) {
      const raw = await functionSelector.execute({ signature });
      const { selector } = JSON.parse(raw as string) as { selector: string };
      expect({ name, selector }).toEqual({
        name,
        selector: SELECTORS[name as keyof typeof SELECTORS],
      });
    }
  });

  test("the single-function interface ids equal that function's selector", async () => {
    const single = KNOWN_INTERFACES.filter((i) => i.singleFunction !== undefined);
    expect(single.length).toBeGreaterThan(2);
    for (const entry of single) {
      const raw = await functionSelector.execute({ signature: entry.singleFunction as string });
      const { selector } = JSON.parse(raw as string) as { selector: string };
      expect({ name: entry.name, selector }).toEqual({ name: entry.name, selector: entry.id });
    }
  });

  test("argument words are padded on the correct side", () => {
    expect(addressArg(ADDR.proxy)).toBe(`${"0".repeat(24)}${"11".repeat(20)}`);
    // bytes4 is right-padded; padding it left would probe interface 0x00000000.
    expect(bytes4Arg("0x01ffc9a7")).toBe(`01ffc9a7${"0".repeat(56)}`);
    expect(supportsInterfaceData(ERC165_INVALID_ID)).toBe(`0x01ffc9a7ffffffff${"0".repeat(56)}`);
    expect(getEthBalanceData(ADDR.wallet).startsWith(SELECTORS.getEthBalance)).toBe(true);
    expect(balanceOfData(ADDR.wallet).startsWith(SELECTORS.balanceOf)).toBe(true);
  });

  test("an interface id that is not four bytes is refused", () => {
    expect(() => bytes4Arg("0x01ff")).toThrow(ChainCallError);
  });

  test("checkAddress reports whether a checksum was VERIFIED, not just parsed", async () => {
    const lower = await checkAddress("0xcafebabecafebabecafebabecafebabecafebabe", "x");
    expect(lower.checksumVerified).toBe(false);
    const checksummed = await checkAddress(lower.address, "x");
    expect(checksummed.checksumVerified).toBe(true);
    expect(checksummed.address).toBe(lower.address);
  });

  test("a mistyped address is refused rather than checksummed into something", async () => {
    await expect(checkAddress("0x1234", "the target")).rejects.toThrow(ChainCallError);
  });
});

describe("fees — the EIP-1559 rule, in integers", () => {
  const limit = 30_000_000n;
  const target = limit / 2n;

  test("a block exactly at target leaves the base fee unchanged", () => {
    const r = nextBaseFee(1_000_000_000n, target, limit);
    expect(r.next).toBe(1_000_000_000n);
    expect(r.direction).toBe("flat");
    expect(r.target).toBe(target);
  });

  test("a full block raises it by the full eighth", () => {
    const r = nextBaseFee(1_000_000_000n, limit, limit);
    expect(r.next).toBe(1_125_000_000n);
    expect(r.direction).toBe("up");
  });

  test("an empty block lowers it by the full eighth", () => {
    const r = nextBaseFee(1_000_000_000n, 0n, limit);
    expect(r.next).toBe(875_000_000n);
    expect(r.direction).toBe("down");
  });

  test("the max(1) floor: a one-wei base fee still rises on a fuller block", () => {
    // parent * excess / target / 8 truncates to zero here; the spec's max(1)
    // is what stops a chain at a one-wei base fee from being pinned there.
    const r = nextBaseFee(1n, target + 1n, limit);
    expect(r.next).toBe(2n);
  });

  test("a large base fee keeps every digit", () => {
    const parent = 123_456_789_012_345_678n;
    const r = nextBaseFee(parent, limit, limit);
    expect(r.next).toBe(parent + parent / BASE_FEE_MAX_CHANGE_DENOMINATOR);
    expect(r.next.toString()).toBe("138888887638888887");
  });

  test("a zero gasLimit returns the parent instead of dividing by zero", () => {
    expect(nextBaseFee(7n, 0n, 0n).next).toBe(7n);
  });

  test("the base fee never goes below zero", () => {
    expect(nextBaseFee(1n, 0n, limit).next).toBe(1n);
    expect(nextBaseFee(0n, 0n, limit).next).toBe(0n);
  });

  test("a non-positive elasticity or denominator is refused", () => {
    expect(() => nextBaseFee(1n, 1n, 2n, 0n)).toThrow(ChainCallError);
    expect(() => nextBaseFee(1n, 1n, 2n, 2n, 0n)).toThrow(ChainCallError);
  });

  test("the median is an observation, never an invented average", () => {
    expect(medianOf([3n, 1n, 2n])).toBe(2n);
    // Even count: the low middle. (1+2)/2 would be a tip nobody paid.
    expect(medianOf([1n, 2n])).toBe(1n);
    expect(medianOf([])).toBeUndefined();
  });

  test("a percentile summary counts its samples", () => {
    const s = summarisePercentile(50, [5n, 1n, 9n]);
    expect(s).toEqual({
      percentile: 50,
      medianWei: "5",
      minWei: "1",
      maxWei: "9",
      samples: 3,
    });
    expect(summarisePercentile(50, [])).toBeUndefined();
  });

  test("changeBps is undefined when there is nothing to divide by", () => {
    expect(changeBps(100n, 125n)).toBe("2500");
    expect(changeBps(100n, 75n)).toBe("-2500");
    expect(changeBps(0n, 5n)).toBeUndefined();
  });

  test("a move past 2^53 bps is still an exact integer, not 1e+34", () => {
    // A chain sitting at a one-wei floor that then spikes. Number() renders
    // this as "1e+34": neither an integer nor the value that was computed.
    const bps = changeBps(1n, 10n ** 30n) as string;
    expect(bps).toBe("9999999999999999999999999999990000");
    expect(bps).not.toContain("e");
  });
});

describe("proxy — signals, and declining to reconcile them", () => {
  test("the canonical EIP-1167 pattern yields its target", () => {
    expect(minimalProxyTarget(minimalProxyCode(ADDR.implementation))).toBe(ADDR.implementation);
  });

  test("a near-match is no match, because an almost-right address is wrong", () => {
    const code = minimalProxyCode(ADDR.implementation);
    expect(minimalProxyTarget(`${code}00`)).toBeNull();
    expect(minimalProxyTarget(code.replace(/fd5bf3$/, "fd5bf4"))).toBeNull();
    expect(minimalProxyTarget("0x6080604052")).toBeNull();
  });

  const storageSignal: ProxySignal = {
    kind: "eip1967",
    implementation: ADDR.implementation,
    source: "slot",
    evidence: "storage",
  };

  test("no signals is not a proxy", () => {
    const v = reconcileProxy([]);
    expect(v).toMatchObject({ isProxy: false, resolved: true, kind: "none", implementation: null });
  });

  test("one signal resolves", () => {
    const v = reconcileProxy([storageSignal]);
    expect(v).toMatchObject({ isProxy: true, resolved: true, implementation: ADDR.implementation });
  });

  test("two signals naming the same implementation still resolve", () => {
    const v = reconcileProxy([
      storageSignal,
      { ...storageSignal, kind: "eip1167-minimal", evidence: "bytecode" },
    ]);
    expect(v.resolved).toBe(true);
    expect(v.implementation).toBe(ADDR.implementation);
  });

  test("two signals naming DIFFERENT implementations refuse to pick one", () => {
    const v = reconcileProxy([
      storageSignal,
      { ...storageSignal, kind: "eip1167-minimal", implementation: ADDR.other },
    ]);
    expect(v.resolved).toBe(false);
    expect(v.kind).toBe("conflicting");
    expect(v.implementation).toBeNull();
    expect(v.unresolvedReason).toContain(ADDR.other);
    expect(v.unresolvedReason).toContain("wrong ABI");
  });

  test("a diamond is a proxy with no implementation to report", () => {
    const v = reconcileProxy([
      { kind: "diamond", implementation: null, source: "erc165", evidence: "call" },
    ]);
    expect(v).toMatchObject({ isProxy: true, resolved: false, kind: "diamond" });
    expect(v.unresolvedReason).toContain("facets()");
  });

  test("a diamond claim withdraws an address even when a slot named one", () => {
    const v = reconcileProxy([
      storageSignal,
      { kind: "diamond", implementation: null, source: "erc165", evidence: "call" },
    ]);
    expect(v.implementation).toBeNull();
    expect(v.resolved).toBe(false);
  });

  test("a proxy whose implementation could not be read is unresolved, not absent", () => {
    const v = reconcileProxy([
      { kind: "eip1967-beacon", implementation: null, source: "beacon", evidence: "call" },
    ]);
    expect(v).toMatchObject({ isProxy: true, resolved: false });
    expect(v.unresolvedReason).toContain("no implementation address");
  });
});

describe("rpc — reading a node's refusal", () => {
  test("a JSON-RPC code is found on the error, under .error, and under .cause", () => {
    expect(rpcError(jsonRpcError(-32601, "nope")).code).toBe(-32601);
    expect(rpcError({ error: { code: -32000, message: "deep" } })).toMatchObject({ code: -32000 });
    expect(rpcError({ cause: { code: -32602, message: "deeper" } }).code).toBe(-32602);
    expect(rpcError(new Error("plain")).message).toBe("plain");
  });

  test("a cyclic error object does not hang the reader", () => {
    const cyclic: Record<string, unknown> = { message: "loop" };
    cyclic["cause"] = cyclic;
    expect(rpcError(cyclic).message).toBe("loop");
  });

  test("rpcErrorText carries the code when there is one", () => {
    expect(rpcErrorText(jsonRpcError(-32601, "nope"))).toBe("nope (code -32601)");
    expect(rpcErrorText(new Error("bare"))).toBe("bare");
  });

  test("-32601 and its string forms mean unimplemented", () => {
    for (const err of [
      jsonRpcError(-32601, "the method eth_simulateV1 does not exist/is not available"),
      jsonRpcError(-32004, "method not supported"),
      new Error("Method not found"),
      new Error("unsupported method: eth_simulateV1"),
    ]) {
      expect({ message: (err as Error).message, unsupported: isMethodUnsupported(err) }).toEqual({
        message: (err as Error).message,
        unsupported: true,
      });
    }
  });

  test("a revert, a bad parameter and a rate limit do NOT mean unimplemented", () => {
    // Degrading on any of these would turn a transient or a real answer into
    // a permanently weaker one that still reads like an answer.
    for (const err of [
      jsonRpcError(3, "execution reverted"),
      jsonRpcError(-32602, "invalid argument 0: hex string too short"),
      jsonRpcError(-32005, "rate limit exceeded"),
      jsonRpcError(-32000, "insufficient funds for gas * price + value"),
      new Error("socket hang up"),
    ]) {
      expect({ message: (err as Error).message, unsupported: isMethodUnsupported(err) }).toEqual({
        message: (err as Error).message,
        unsupported: false,
      });
    }
  });

  test("an abort is never read as unimplemented — a timeout says nothing about support", () => {
    const controller = new AbortController();
    controller.abort();
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isAbort(abortErr)).toBe(true);
    expect(isAbort(new Error("x"), controller.signal)).toBe(true);
    expect(isMethodUnsupported(abortErr)).toBe(false);
    // Even the -32601 shape is not degraded on once the signal has aborted.
    expect(isMethodUnsupported(jsonRpcError(-32601, "nope"), controller.signal)).toBe(false);
  });

  test("a read that outlives its signal rejects as an abort, so a timeout bounds something", async () => {
    // `ChainAdapter.rpcRead` takes no signal, so the transport below cannot
    // be cancelled. Racing is what makes `timeoutMs` mean anything at all;
    // without it the field would be a promise the package does not keep.
    const controller = new AbortController();
    const never: ChainRpc = () => new Promise(() => undefined);
    const pending = rpcRead(never, "base-mainnet", "eth_call", [], controller.signal);
    controller.abort(new Error("deadline of 30000ms elapsed"));
    await expect(pending).rejects.toThrow(/deadline of 30000ms elapsed/);
  });

  test("a read whose signal is already aborted is never dispatched", async () => {
    const controller = new AbortController();
    controller.abort();
    let dispatched = 0;
    const counting: ChainRpc = async () => {
      dispatched++;
      return "0x";
    };
    await expect(
      rpcRead(counting, "base-mainnet", "eth_call", [], controller.signal),
    ).rejects.toThrow();
    expect(dispatched).toBe(0);
  });

  test("with nothing bound, a tool says what the operator has to wire", () => {
    _setRpc(undefined);
    expect(() => resolveRpc("base-mainnet", "EvmMulticall")).toThrow(/setChainRpcResolver/);
  });

  test("with a chain missing, it names the chain rather than the wiring", () => {
    // `_setRpc` answers for every chain id, so the miss is made through the
    // production resolver shape instead.
    setChainRpcResolver(() => undefined);
    try {
      expect(() => resolveRpc("nope", "GasMarketRead")).toThrow(/spec.chains/);
    } finally {
      setChainRpcResolver(undefined);
    }
  });
});

describe("simulate — positional results, and reverts that carry bytes", () => {
  test("a wire call omits absent fields instead of nulling them", () => {
    expect(toWireCall({ to: ADDR.token }, 0)).toEqual({ to: ADDR.token });
    expect(toWireCall({ to: ADDR.token, value: "1000", gas: "21000" }, 0)).toEqual({
      to: ADDR.token,
      value: "0x3e8",
      gas: "0x5208",
    });
  });

  test("a value that is not a decimal integer is refused before it reaches the node", () => {
    expect(() => toWireCall({ to: ADDR.token, value: "0x1" }, 0)).toThrow(ChainCallError);
    expect(() => toWireCall({ to: ADDR.token, value: "1.5" }, 3)).toThrow(/calls\[3\].value/);
  });

  test("a result count that does not match the bundle is refused, not zipped", () => {
    const short = [{ number: "0x1", calls: [{ returnData: "0x", status: "0x1" }] }];
    expect(() => parseSimulateV1(short, 2)).toThrow(/matched by position/);
  });

  test("more than one block for a one-block bundle is refused", () => {
    const two = [
      { number: "0x1", calls: [] },
      { number: "0x2", calls: [] },
    ];
    expect(() => parseSimulateV1(two, 0)).toThrow(/two|2 blocks/i);
  });

  test("a status of 0x0 is a revert whose bytes are decoded", async () => {
    const reason = await (async () => {
      const { errorStringRevert } = await import("./fixtures");
      return errorStringRevert("ERC20: insufficient allowance");
    })();
    const block = parseSimulateV1(
      [
        {
          number: "0x64",
          calls: [{ returnData: reason, status: "0x0", gasUsed: "0x5208", logs: [] }],
        },
      ],
      1,
    );
    expect(block.blockNumber).toBe("100");
    expect(block.calls[0]?.status).toBe("reverted");
    expect(block.calls[0]?.revert?.reason).toBe("ERC20: insufficient allowance");
  });

  test("an eth_call revert is read from error.data; anything else is not a revert", async () => {
    const bytes = await aggregate3Return([]);
    expect(revertFromCallError(jsonRpcError(3, "execution reverted", bytes))).toBeDefined();
    expect(revertFromCallError(jsonRpcError(-32602, "invalid argument"))).toBeUndefined();
    expect(revertFromCallError(jsonRpcError(3, "reverted", "not hex"))).toBeUndefined();
  });
});

describe("batch", () => {
  test("chunk preserves order and the tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
