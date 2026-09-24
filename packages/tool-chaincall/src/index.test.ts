/**
 * The four tools, driven through their own `execute` against recorded node
 * shapes. Every test installs a transport with `_setRpc`, so nothing here
 * resolves a name or opens a socket — a test that dialled a public RPC would
 * fail on a CI runner with no egress and flake on somebody else's rate limit.
 *
 * The refusal paths get as much room as the happy ones. A batch that cannot
 * be pinned to one block, a proxy whose mechanisms disagree, a contract whose
 * ERC-165 answers are worthless, a node that cannot simulate a bundle and a
 * chain that is not running a 1559 market are all things this package has to
 * say no to, or qualify, out loud and with the reason.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { MULTICALL3_ADDRESS, encodeAggregate3 } from "@crewhaus/tool-onchain";
import { z } from "zod";
import {
  ADDR,
  NON_ADDRESS_WORD,
  type RpcHandler,
  type RpcStub,
  ZERO_WORD,
  addressWord,
  aggregate3Return,
  blockResult,
  errorStringRevert,
  feeHistoryResult,
  inspectViewRows,
  jsonRpcError,
  methodNotFound,
  minimalProxyCode,
  rpcStub,
  sequentialCalls,
  simulateV1Raw,
  simulateV1Result,
  transferLog,
  word,
} from "./fixtures";
import {
  CHAINCALL_TOOLS,
  EIP1822_SLOT,
  EIP1967_ADMIN_SLOT,
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  _setRpc,
  contractInspect,
  evmMulticall,
  evmSimulateBundle,
  gasMarketRead,
} from "./index";

const CHAIN = "base-mainnet";

afterEach(() => _setRpc(undefined));

/** Install a stub and hand it back, so a test can read what was dispatched. */
function use(handlers: Readonly<Record<string, RpcHandler>>): RpcStub {
  const stub = rpcStub(handlers);
  _setRpc(stub.rpc);
  return stub;
}

/**
 * Validate the input against the tool's own schema first, then execute. A
 * test that skipped the schema would pass inputs the runtime never could.
 */
// biome-ignore lint/suspicious/noExplicitAny: test reader for a tool's JSON
async function run(tool: RegisteredTool, input: unknown): Promise<any> {
  const parsed = tool.inputSchema.parse(input);
  const out = await tool.execute(parsed);
  if (typeof out !== "string") throw new Error(`${tool.name} returned non-text content`);
  return JSON.parse(out);
}

describe("registration", () => {
  test("the four tools are all read-only, concurrency-safe and declared external", () => {
    expect(CHAINCALL_TOOLS.map((t) => t.name).sort()).toEqual([
      "ContractInspect",
      "EvmMulticall",
      "EvmSimulateBundle",
      "GasMarketRead",
    ]);
    for (const tool of CHAINCALL_TOOLS) {
      expect({
        name: tool.name,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
        scope: tool.scope,
        io: tool.ioCapability,
      }).toEqual({
        name: tool.name,
        readOnly: true,
        destructive: false,
        scope: "external",
        io: "network",
      });
    }
  });

  test("with nothing wired, each tool says what the spec must declare", async () => {
    _setRpc(undefined);
    await expect(
      run(evmMulticall, { chainId: CHAIN, calls: [{ target: ADDR.token, data: "0x" }] }),
    ).rejects.toThrow(/no chain is configured\. Declare one in the spec — chains: \[/);
  });
});

// ---------------------------------------------------------------------------

describe("EvmMulticall", () => {
  const balanceCall = (target: string) => ({
    target,
    signature: "balanceOf(address)",
    args: [ADDR.wallet],
    outputs: ["uint256"],
  });

  test("reads many contracts at one block, decoding each answer", async () => {
    const blob = await aggregate3Return([
      [true, word(1_000n)],
      [true, word(2_000n)],
      [true, word(19_123_456n)],
    ]);
    const stub = use({ eth_call: () => blob });

    const out = await run(evmMulticall, {
      chainId: CHAIN,
      calls: [
        { ...balanceCall(ADDR.token), label: "usdc" },
        { ...balanceCall(ADDR.other), label: "dai" },
      ],
    });

    expect(out.callCount).toBe(2);
    expect(out.succeeded).toBe(2);
    expect(out.requests).toBe(1);
    expect(out.results[0]).toMatchObject({ label: "usdc", success: true, decoded: ["1000"] });
    expect(out.results[1]).toMatchObject({ label: "dai", decoded: ["2000"] });
    // The block is pinned from Multicall3's own getBlockNumber(), riding in
    // the same request rather than costing a second round trip.
    expect(out.block).toMatchObject({ number: "19123456", pinned: true });
    expect(out.block.source).toContain("getBlockNumber()");
    expect(stub.count("eth_call")).toBe(1);
    expect(stub.count("eth_blockNumber")).toBe(0);
  });

  test("a sub-call that reverts is a row with its reason, not a failed request", async () => {
    const reverted = await errorStringRevert("ERC20: transfer amount exceeds balance");
    const blob = await aggregate3Return([
      [true, word(7n)],
      [false, reverted],
      [true, word(100n)],
    ]);
    use({ eth_call: () => blob });

    const out = await run(evmMulticall, {
      chainId: CHAIN,
      calls: [balanceCall(ADDR.token), balanceCall(ADDR.other)],
    });

    expect(out.failed).toBe(1);
    expect(out.succeeded).toBe(1);
    expect(out.results[0].decoded).toEqual(["7"]);
    expect(out.results[1]).toMatchObject({ success: false });
    expect(out.results[1].revert).toMatchObject({
      kind: "string",
      reason: "ERC20: transfer amount exceeds balance",
    });
  });

  test("an empty return is flagged, never decoded as a zero balance", async () => {
    const blob = await aggregate3Return([
      [true, "0x"],
      [true, word(19n)],
    ]);
    use({ eth_call: () => blob });
    const out = await run(evmMulticall, {
      chainId: CHAIN,
      calls: [balanceCall(ADDR.token)],
    });

    expect(out.results[0]).toMatchObject({ success: true, emptyReturn: true });
    expect(out.results[0].decoded).toBeUndefined();
    // No decode was ATTEMPTED, which is the behaviour the guard exists for.
    // Asserting only that `decoded` is absent passes just as well when the
    // decoder is handed `0x` and throws, so the guard itself goes untested.
    expect(out.results[0].decodeError).toBeUndefined();
    expect(out.emptyReturns).toBe(1);
    expect(out.caveats.join(" ")).toContain("no code");
  });

  test("splitting a batch pins the block from the first request", async () => {
    const first = await aggregate3Return([
      [true, word(1n)],
      [true, word(2n)],
      [true, word(500n)],
    ]);
    const second = await aggregate3Return([[true, word(3n)]]);
    const stub = use({ eth_call: sequentialCalls([first, second]) });

    const out = await run(evmMulticall, {
      chainId: CHAIN,
      calls: [balanceCall(ADDR.token), balanceCall(ADDR.other), balanceCall(ADDR.proxy)],
      batchSize: 2,
    });

    expect(out.requests).toBe(2);
    expect(out.block).toMatchObject({ number: "500", pinned: true });
    expect(out.results.map((r: { decoded: string[] }) => r.decoded[0])).toEqual(["1", "2", "3"]);
    // The second request must ask for the pinned height, not "latest" again.
    expect(stub.calls[0]?.params[1]).toBe("latest");
    expect(stub.calls[1]?.params[1]).toBe("0x1f4");
  });

  test("a split that cannot be pinned is refused rather than answered from two blocks", async () => {
    // Multicall3 at this address does not answer getBlockNumber(), so the
    // second request would resolve "latest" separately and the rows would
    // come from different heights while still arriving as one table.
    const first = await aggregate3Return([
      [true, word(1n)],
      [true, word(2n)],
      [false, "0x"],
    ]);
    const stub = use({ eth_call: sequentialCalls([first]) });

    await expect(
      run(evmMulticall, {
        chainId: CHAIN,
        calls: [balanceCall(ADDR.token), balanceCall(ADDR.other), balanceCall(ADDR.proxy)],
        batchSize: 2,
      }),
    ).rejects.toThrow(/could not be pinned/);
    expect(stub.count("eth_call")).toBe(1);
  });

  test("a single un-pinnable batch still answers, and says the block is not pinned", async () => {
    const blob = await aggregate3Return([
      [true, word(1n)],
      [false, "0x"],
    ]);
    use({ eth_call: () => blob });
    const out = await run(evmMulticall, { chainId: CHAIN, calls: [balanceCall(ADDR.token)] });
    expect(out.block).toMatchObject({ pinned: false, number: null, source: "none" });
    expect(out.caveats.join(" ")).toContain("not pinned");
  });

  test("a block number no chain could have is not pinned to", async () => {
    // Whatever is at that address answered getBlockNumber() with something
    // that is not a block number, so it is not Multicall3 and the height it
    // returned does not go into the answer.
    const blob = await aggregate3Return([
      [true, word(1n)],
      [true, word(1n << 200n)],
    ]);
    use({ eth_call: () => blob });
    const out = await run(evmMulticall, { chainId: CHAIN, calls: [balanceCall(ADDR.token)] });
    expect(out.block).toMatchObject({ pinned: false, number: null });
  });

  test("a caller-pinned block sends no probe and reuses the same height", async () => {
    const first = await aggregate3Return([[true, word(1n)]]);
    const second = await aggregate3Return([[true, word(2n)]]);
    const stub = use({ eth_call: sequentialCalls([first, second]) });

    const out = await run(evmMulticall, {
      chainId: CHAIN,
      calls: [balanceCall(ADDR.token), balanceCall(ADDR.other)],
      batchSize: 1,
      blockNumber: "18000000",
    });

    expect(out.block).toMatchObject({ pinned: true, source: "caller", requested: "0x112a880" });
    expect(stub.calls.every((c) => c.params[1] === "0x112a880")).toBe(true);
  });

  test("a blob with the wrong number of results is refused, not zipped", async () => {
    const short = await aggregate3Return([[true, word(1n)]]);
    use({ eth_call: () => short });
    await expect(
      run(evmMulticall, {
        chainId: CHAIN,
        calls: [balanceCall(ADDR.token), balanceCall(ADDR.other)],
        blockNumber: "1",
      }),
    ).rejects.toThrow(/matched by position/);
  });

  test("the batch itself failing is an exception, not a table of failures", async () => {
    use({
      eth_call: () => {
        throw jsonRpcError(-32000, "execution reverted");
      },
    });
    await expect(
      run(evmMulticall, { chainId: CHAIN, calls: [balanceCall(ADDR.token)] }),
    ).rejects.toThrow(/the Multicall3 batch itself failed/);
  });

  test("allowFailure and the target list reach the wire exactly as declared", async () => {
    const blob = await aggregate3Return([
      [true, word(1n)],
      [true, word(2n)],
    ]);
    const stub = use({ eth_call: () => blob });
    await run(evmMulticall, {
      chainId: CHAIN,
      calls: [
        { target: ADDR.token, data: "0xabcdef", allowFailure: false },
        { target: ADDR.other, data: "0x" },
      ],
      blockNumber: "1",
    });
    // Compared against the shared encoder rather than a pasted hex string:
    // this proves the flags survive, and that no second encoder is in play.
    const expected = encodeAggregate3(
      [
        { target: ADDR.token, callData: "0xabcdef", allowFailure: false },
        { target: ADDR.other, callData: "0x", allowFailure: true },
      ],
      MULTICALL3_ADDRESS,
    );
    expect((stub.calls[0]?.params[0] as { data: string }).data).toBe(expected.data);
  });

  test("a call with both data and signature is refused as ambiguous", async () => {
    use({ eth_call: () => "0x" });
    await expect(
      run(evmMulticall, {
        chainId: CHAIN,
        calls: [{ target: ADDR.token, data: "0x12345678", signature: "decimals()" }],
      }),
    ).rejects.toThrow(/both data and signature/);
  });

  test("a call with neither is refused with the two ways to fix it", async () => {
    use({ eth_call: () => "0x" });
    await expect(
      run(evmMulticall, { chainId: CHAIN, calls: [{ target: ADDR.token }] }),
    ).rejects.toThrow(/neither data nor signature/);
  });

  test("a mistyped target is refused before anything is dialled", async () => {
    const stub = use({ eth_call: () => "0x" });
    await expect(
      run(evmMulticall, { chainId: CHAIN, calls: [{ target: "0xnothex", data: "0x" }] }),
    ).rejects.toThrow();
    expect(stub.count("eth_call")).toBe(0);
  });

  test("one row that will not decode does not lose the other rows", async () => {
    const blob = await aggregate3Return([
      [true, word(5n)],
      [true, "0x1234"],
    ]);
    use({ eth_call: () => blob });
    const out = await run(evmMulticall, {
      chainId: CHAIN,
      calls: [balanceCall(ADDR.token), balanceCall(ADDR.other)],
      blockNumber: "1",
    });
    expect(out.results[0].decoded).toEqual(["5"]);
    expect(out.results[1].decodeError).toBeDefined();
    expect(out.results[1].returnData).toBe("0x1234");
  });

  test("a cancelled batch is reported as a cancellation, not as a missing Multicall3", async () => {
    const stub = use({ eth_call: () => word(1n) });
    const controller = new AbortController();
    controller.abort();
    const parsed = evmMulticall.inputSchema.parse({
      chainId: CHAIN,
      calls: [{ target: ADDR.token, data: "0x" }],
    });
    let caught: unknown;
    try {
      await evmMulticall.execute(parsed, { signal: controller.signal });
    } catch (err) {
      caught = err;
    }
    // "the batch failed" would send the caller looking for a Multicall3
    // deploy when what actually ran out was their deadline, so the assertion
    // is on what the error SAYS, not merely that one was thrown.
    expect((caught as Error)?.name).toBe("AbortError");
    expect((caught as Error)?.message).not.toContain("Multicall3 batch itself failed");
    expect(stub.calls.length).toBe(0);
  });

  test("a batch past the call ceiling is refused by the schema", () => {
    const calls = Array.from({ length: 513 }, () => ({ target: ADDR.token, data: "0x" }));
    expect(() => evmMulticall.inputSchema.parse({ chainId: CHAIN, calls })).toThrow(z.ZodError);
  });
});

// ---------------------------------------------------------------------------

type InspectStub = {
  readonly code: string;
  readonly slots?: Readonly<Record<string, string>>;
  readonly views: Array<readonly [boolean, string]>;
  /** Make the Multicall3 batch fail, forcing the sequential path. */
  readonly noMulticall?: boolean;
};

async function inspectHandlers(spec: InspectStub): Promise<Record<string, RpcHandler>> {
  const blob = await aggregate3Return(spec.views);
  let sequential = 0;
  return {
    eth_getCode: () => spec.code,
    eth_getStorageAt: (params) => spec.slots?.[String(params[1])] ?? ZERO_WORD,
    eth_call: (params) => {
      const to = String((params[0] as { to?: string }).to ?? "").toLowerCase();
      // The batch attempt goes to Multicall3; the sequential probes go to the
      // contract itself. Keying on the target rather than on a counter keeps
      // the failed batch from eating the first probe's row.
      if (to === MULTICALL3_ADDRESS.toLowerCase()) {
        if (spec.noMulticall) throw jsonRpcError(-32000, "execution reverted");
        return blob;
      }
      const row = spec.views[sequential++];
      if (row === undefined) throw new Error("the stub ran out of sequential view rows");
      if (!row[0]) throw jsonRpcError(3, "execution reverted");
      return row[1];
    },
  };
}

describe("ContractInspect", () => {
  test("an address with no code is an answer, and costs no further reads", async () => {
    const stub = use(await inspectHandlers({ code: "0x", views: [] }));
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.wallet });

    expect(out.verified).toEqual({ isContract: false, codeSize: 0 });
    expect(out.caveats.join(" ")).toContain("CREATE2");
    expect(stub.count("eth_getStorageAt")).toBe(0);
    expect(stub.count("eth_call")).toBe(0);
  });

  test("a plain contract: code verified, interfaces merely claimed", async () => {
    use(
      await inspectHandlers({
        code: "0x6080604052348015600f57600080fd5b50",
        views: inspectViewRows({ supports: ["0x80ac58cd", "0x5b5e139f"] }),
      }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.token });

    expect(out.verified.isContract).toBe(true);
    expect(out.verified.codeSize).toBe(17);
    expect(out.verified.proxy).toMatchObject({ isProxy: false, kind: "none" });
    expect(out.claimed.erc165.compliant).toBe(true);
    expect(out.claimed.erc165.supported).toEqual([
      { id: "0x80ac58cd", name: "ERC-721" },
      { id: "0x5b5e139f", name: "ERC-721Metadata" },
    ]);
    expect(out.claimed.erc165.caveat).toContain("claim, not a verification");
    // The split is structural, not decorative: nothing self-reported is in
    // `verified`, and nothing read from state is in `claimed`.
    expect(Object.keys(out.verified)).toEqual([
      "isContract",
      "codeSize",
      "storage",
      "proxy",
      "reads",
    ]);
    expect(JSON.stringify(out.verified)).not.toContain("erc165");
  });

  test("an EIP-1967 proxy resolves from storage, which is fact", async () => {
    use(
      await inspectHandlers({
        code: "0x363d3d",
        slots: {
          [EIP1967_IMPLEMENTATION_SLOT]: addressWord(ADDR.implementation),
          [EIP1967_ADMIN_SLOT]: addressWord(ADDR.admin),
        },
        views: inspectViewRows({ implementationView: ADDR.implementation, proxiable: true }),
      }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.proxy });

    expect(out.verified.proxy).toMatchObject({
      isProxy: true,
      resolved: true,
      kind: "eip1967",
      implementation: ADDR.implementation,
    });
    expect(out.verified.proxy.signals[0].evidence).toBe("storage");
    expect(out.verified.storage.adminAddress).toBe(ADDR.admin);
    expect(out.claimed.implementationView).toBe(ADDR.implementation);
    expect(out.claimed.uupsProxiable).toBe(true);
  });

  test("a beacon proxy takes the extra hop and marks the evidence as a call", async () => {
    use(
      await inspectHandlers({
        code: "0x363d3d",
        slots: { [EIP1967_BEACON_SLOT]: addressWord(ADDR.beacon) },
        views: inspectViewRows({ beaconImplementation: ADDR.implementation }),
      }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.proxy });

    expect(out.verified.proxy).toMatchObject({
      resolved: true,
      kind: "eip1967-beacon",
      implementation: ADDR.implementation,
    });
    expect(out.verified.proxy.signals[0].source).toContain(ADDR.beacon);
    expect(out.caveats.join(" ")).toContain("view CALL");
  });

  test("a beacon that will not answer leaves the proxy unresolved, not absent", async () => {
    use(
      await inspectHandlers({
        code: "0x363d3d",
        slots: { [EIP1967_BEACON_SLOT]: addressWord(ADDR.beacon) },
        views: inspectViewRows({ beaconImplementation: "revert" }),
      }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.proxy });
    expect(out.verified.proxy).toMatchObject({
      isProxy: true,
      resolved: false,
      implementation: null,
    });
    expect(out.caveats.join(" ")).toContain(ADDR.beacon);
  });

  test("an EIP-1167 clone is read straight out of its bytecode", async () => {
    use(
      await inspectHandlers({
        code: minimalProxyCode(ADDR.implementation),
        views: inspectViewRows({}),
      }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.proxy });
    expect(out.verified.proxy).toMatchObject({
      resolved: true,
      kind: "eip1167-minimal",
      implementation: ADDR.implementation,
    });
    expect(out.verified.proxy.signals[0].evidence).toBe("bytecode");
    expect(out.verified.codeSize).toBe(45);
  });

  test("two mechanisms naming different implementations come back unresolved", async () => {
    use(
      await inspectHandlers({
        code: minimalProxyCode(ADDR.implementation),
        slots: { [EIP1967_IMPLEMENTATION_SLOT]: addressWord(ADDR.other) },
        views: inspectViewRows({}),
      }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.proxy });
    expect(out.verified.proxy).toMatchObject({
      isProxy: true,
      resolved: false,
      kind: "conflicting",
      implementation: null,
    });
    expect(out.verified.proxy.unresolvedReason).toContain(ADDR.implementation);
    expect(out.verified.proxy.unresolvedReason).toContain(ADDR.other);
  });

  test("a contract that claims 0xffffffff has its claims DROPPED, with the reason", async () => {
    use(
      await inspectHandlers({
        code: "0x60806040",
        views: inspectViewRows({ sentinel: true, supports: ["0x80ac58cd"] }),
      }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.token });

    expect(out.claimed.erc165.compliant).toBe(false);
    expect(out.claimed.erc165.reason).toContain("0xffffffff");
    // Not an empty list — the key is absent, so nothing can read it as "this
    // supports no interfaces".
    expect(out.claimed.erc165.supported).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("0x80ac58cd");
  });

  test("a contract that is not ERC-165 at all says so, and claims nothing", async () => {
    use(
      await inspectHandlers({ code: "0x60806040", views: inspectViewRows({ sentinel: "revert" }) }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.token });
    expect(out.claimed.erc165).toMatchObject({ compliant: false });
    expect(out.claimed.erc165.reason).toContain("does not implement ERC-165");
  });

  test("a diamond has no single implementation, and none is invented", async () => {
    use(
      await inspectHandlers({
        code: "0x60806040",
        slots: { [EIP1967_IMPLEMENTATION_SLOT]: addressWord(ADDR.implementation) },
        views: inspectViewRows({ supports: ["0x48e2b093"] }),
      }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.proxy });
    expect(out.verified.proxy).toMatchObject({
      kind: "diamond",
      resolved: false,
      implementation: null,
    });
    expect(out.verified.proxy.unresolvedReason).toContain("facets()");
  });

  test("a non-address in the EIP-1822 slot is reported as raw storage, not masked down", async () => {
    use(
      await inspectHandlers({
        code: "0x60806040",
        slots: { [EIP1822_SLOT]: NON_ADDRESS_WORD },
        views: inspectViewRows({}),
      }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.token });
    expect(out.verified.proxy.isProxy).toBe(false);
    expect(out.verified.storage.eip1822).toBe(NON_ADDRESS_WORD);
    expect(out.caveats.join(" ")).toContain("not an address");
  });

  test("without Multicall3 the probes are made one at a time, and the report says so", async () => {
    const stub = use(
      await inspectHandlers({
        code: "0x60806040",
        views: inspectViewRows({ supports: ["0xd9b67a26"] }),
        noMulticall: true,
      }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.token });

    expect(out.verified.reads).toBe("sequential");
    expect(out.claimed.erc165.supported).toEqual([{ id: "0xd9b67a26", name: "ERC-1155" }]);
    expect(out.caveats.join(" ")).toContain("one at a time");
    // One failed batch, then one call each: the 0xffffffff sentinel, every
    // probed interface, implementation() and proxiableUUID().
    expect(stub.count("eth_call")).toBe(1 + 1 + out.claimed.erc165.probed + 2);
  });

  test("a node that answers nothing is a refusal, not a report saying 'no proxy, no ERC-165'", async () => {
    // Every probe failed for a reason that was not a revert. The tempting
    // report — everything absent — reads as a set of facts about the
    // contract, and none of them were established.
    use({
      eth_getCode: () => "0x60806040",
      eth_getStorageAt: () => ZERO_WORD,
      eth_call: () => {
        throw new Error("socket hang up");
      },
    });
    await expect(run(contractInspect, { chainId: CHAIN, address: ADDR.token })).rejects.toThrow(
      /Nothing was learned .*different claim from "could not ask"/s,
    );
  });

  test("a probe the node could not answer is counted apart from one that reverted", async () => {
    let call = 0;
    use({
      eth_getCode: () => "0x60806040",
      eth_getStorageAt: () => ZERO_WORD,
      eth_call: (params) => {
        const to = String((params[0] as { to: string }).to).toLowerCase();
        if (to === MULTICALL3_ADDRESS.toLowerCase())
          throw jsonRpcError(-32000, "execution reverted");
        // The last probe is rate-limited; the rest revert, which is an answer.
        call++;
        if (call === 14) throw jsonRpcError(-32005, "rate limit exceeded");
        throw jsonRpcError(3, "execution reverted");
      },
    });
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.token });
    expect(out.caveats.join(" ")).toContain("1 of 14 probes could not be answered");
    expect(out.caveats.join(" ")).toContain("not the same as the contract having said no");
  });

  test("a sentinel the node could not answer is not read as 'not ERC-165'", async () => {
    // The all-probes-failed refusal catches the case where nobody was asked
    // anything. This is the same mistake one probe at a time: the sentinel
    // alone goes unanswered, the claims are (correctly) dropped, and the
    // REASON given is a flat statement about a contract nobody managed to ask.
    const rows = inspectViewRows({ supports: ["0x80ac58cd"] });
    let sequential = 0;
    use({
      eth_getCode: () => "0x60806040",
      eth_getStorageAt: () => ZERO_WORD,
      eth_call: (params) => {
        const to = String((params[0] as { to?: string }).to ?? "").toLowerCase();
        if (to === MULTICALL3_ADDRESS.toLowerCase()) {
          throw jsonRpcError(-32000, "no contract code at given address");
        }
        const at = sequential++;
        if (at === 0) throw jsonRpcError(-32005, "rate limit exceeded");
        const row = rows[at];
        if (row === undefined) throw new Error("the stub ran out of sequential view rows");
        if (!row[0]) throw jsonRpcError(3, "execution reverted");
        return row[1];
      },
    });
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.token });

    expect(out.claimed.erc165.compliant).toBe(false);
    expect(out.claimed.erc165.established).toBe(false);
    expect(out.claimed.erc165.reason).toContain("never established");
    expect(out.claimed.erc165.reason).toContain("rate limit");
    expect(out.claimed.erc165.reason).not.toContain("does not implement ERC-165");
  });

  test("a sentinel that REVERTED is still an answer: that contract is not ERC-165", async () => {
    // The other side of the same line. A revert is the contract speaking, so
    // the flat reason is the right one and must not be softened away with it.
    use(
      await inspectHandlers({ code: "0x60806040", views: inspectViewRows({ sentinel: "revert" }) }),
    );
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.token });
    expect(out.claimed.erc165.established).toBe(true);
    expect(out.claimed.erc165.reason).toContain("does not implement ERC-165");
  });

  test("probeInterfaces:false skips ERC-165 and reports no claims at all", async () => {
    use(
      await inspectHandlers({
        code: "0x60806040",
        views: [
          [false, "0x"],
          [false, "0x"],
        ],
      }),
    );
    const out = await run(contractInspect, {
      chainId: CHAIN,
      address: ADDR.token,
      probeInterfaces: false,
    });
    expect(out.claimed.erc165).toBeUndefined();
  });

  test("a lowercase address is answered, with the checksum caveat attached", async () => {
    use(await inspectHandlers({ code: "0x60806040", views: inspectViewRows({}) }));
    const out = await run(contractInspect, { chainId: CHAIN, address: ADDR.token.toLowerCase() });
    expect(out.checksumVerified).toBe(false);
    expect(out.caveats.join(" ")).toContain("EIP-55");
  });

  test("a mistyped address is refused before any read", async () => {
    const stub = use(await inspectHandlers({ code: "0x", views: [] }));
    await expect(run(contractInspect, { chainId: CHAIN, address: "0xdeadbeef" })).rejects.toThrow(
      /40 hex/,
    );
    expect(stub.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("EvmSimulateBundle", () => {
  const bundle = [
    { from: ADDR.wallet, to: ADDR.token, data: "0x095ea7b3" },
    { from: ADDR.wallet, to: ADDR.other, data: "0x38ed1739" },
  ];

  test("a chained simulation reports per-call gas, return data and logs", async () => {
    use({
      eth_simulateV1: () =>
        simulateV1Result(100, [
          { returnData: word(1n), gasUsed: 46_000 },
          {
            returnData: word(999n),
            gasUsed: 180_000,
            logs: [transferLog(ADDR.token, ADDR.wallet, ADDR.other, 5n)],
          },
        ]),
    });
    const out = await run(evmSimulateBundle, { chainId: CHAIN, calls: bundle });

    expect(out).toMatchObject({ mode: "eth_simulateV1", chained: true, blockNumber: "100" });
    expect(out.reverted).toBe(0);
    expect(out.calls[0]).toMatchObject({ index: 0, status: "success", gasUsed: "46000" });
    expect(out.calls[1].logs[0].address).toBe(ADDR.token);
    expect(out.limitations.join(" ")).toContain("synthetic");
  });

  test("a call that reverts inside the bundle is data, with its reason decoded", async () => {
    const reason = await errorStringRevert("ERC20: insufficient allowance");
    use({
      eth_simulateV1: () =>
        simulateV1Result(100, [
          { returnData: word(1n) },
          { returnData: reason, status: 0, error: { code: 3, message: "execution reverted" } },
        ]),
    });
    const out = await run(evmSimulateBundle, { chainId: CHAIN, calls: bundle });
    expect(out.reverted).toBe(1);
    expect(out.calls[1]).toMatchObject({ status: "reverted" });
    expect(out.calls[1].revert.reason).toBe("ERC20: insufficient allowance");
    expect(out.calls[1].error).toBe("execution reverted");
  });

  test("an unimplemented eth_simulateV1 degrades, and omits logs and deltas ENTIRELY", async () => {
    const stub = use({
      eth_simulateV1: () => {
        throw methodNotFound("eth_simulateV1");
      },
      eth_call: () => word(1n),
    });
    const out = await run(evmSimulateBundle, { chainId: CHAIN, calls: bundle });

    expect(out).toMatchObject({ mode: "eth_call-fallback", chained: false, blockNumber: null });
    expect(out.calls).toHaveLength(2);
    // Absence, not emptiness. An empty log list reads as "no events", which
    // is the reading a policy gate would act on and be wrong about.
    expect(JSON.stringify(out)).not.toContain('"logs"');
    expect(JSON.stringify(out)).not.toContain("balanceChanges");
    expect(out.limitations.join(" ")).toContain("state is NOT chained");
    expect(stub.count("eth_call")).toBe(2);
  });

  test("a reverting call in fallback mode still carries its revert bytes", async () => {
    const reason = await errorStringRevert("STF");
    use({
      eth_simulateV1: () => {
        throw methodNotFound("eth_simulateV1");
      },
      eth_call: (_params, index) => {
        if (index === 1) throw jsonRpcError(3, "execution reverted", reason);
        return word(1n);
      },
    });
    const out = await run(evmSimulateBundle, { chainId: CHAIN, calls: bundle });
    expect(out.reverted).toBe(1);
    expect(out.calls[1].revert.reason).toBe("STF");
    expect(out.calls[1].logs).toBeUndefined();
  });

  test("a TIMEOUT never degrades — the refusal names the reason, not just the failure", async () => {
    const stub = use({
      eth_simulateV1: () => {
        throw Object.assign(new Error("the request was aborted"), { name: "AbortError" });
      },
      eth_call: () => word(1n),
    });
    // `ok === false` is what an abort returns too, so the assertion is on the
    // reason: a deadline says nothing about whether the node implements the
    // method, and no fallback may be attempted on it.
    await expect(run(evmSimulateBundle, { chainId: CHAIN, calls: bundle })).rejects.toThrow(
      /cancelled .*NOT treated as an unimplemented method/s,
    );
    expect(stub.count("eth_call")).toBe(0);
  });

  test("a rejected parameter never degrades either — that is an answer about the bundle", async () => {
    const stub = use({
      eth_simulateV1: () => {
        throw jsonRpcError(-32602, "invalid argument 0: hex string has odd length");
      },
      eth_call: () => word(1n),
    });
    await expect(run(evmSimulateBundle, { chainId: CHAIN, calls: bundle })).rejects.toThrow(
      /the node refused this bundle/,
    );
    expect(stub.count("eth_call")).toBe(0);
  });

  test("allowFallback:false refuses rather than answering a different question", async () => {
    const stub = use({
      eth_simulateV1: () => {
        throw methodNotFound("eth_simulateV1");
      },
      eth_call: () => word(1n),
    });
    await expect(
      run(evmSimulateBundle, { chainId: CHAIN, calls: bundle, allowFallback: false }),
    ).rejects.toThrow(/cannot chain state/);
    expect(stub.count("eth_call")).toBe(0);
  });

  test("balance tracking is refused in fallback mode instead of being faked", async () => {
    use({
      eth_simulateV1: () => {
        throw methodNotFound("eth_simulateV1");
      },
      eth_call: () => word(1n),
    });
    await expect(
      run(evmSimulateBundle, {
        chainId: CHAIN,
        calls: bundle,
        trackBalances: { accounts: [ADDR.wallet] },
      }),
    ).rejects.toThrow(/no honest delta/);
  });

  test("balance deltas come from the chain's own accounting, bracketed inside the bundle", async () => {
    const before = await aggregate3Return([
      [true, word(1_000_000_000_000_000_000n)],
      [true, word(500n)],
    ]);
    const after = await aggregate3Return([
      [true, word(900_000_000_000_000_000n)],
      [true, word(1_500n)],
    ]);
    const stub = use({
      eth_simulateV1: () =>
        simulateV1Result(100, [
          { returnData: before },
          { returnData: word(1n) },
          { returnData: word(1n) },
          { returnData: after },
        ]),
    });

    const out = await run(evmSimulateBundle, {
      chainId: CHAIN,
      calls: bundle,
      trackBalances: { accounts: [ADDR.wallet], tokens: [ADDR.token] },
    });

    // The brackets are stripped: the caller's two calls are indices 0 and 1.
    expect(out.callCount).toBe(2);
    expect(out.calls.map((c: { index: number }) => c.index)).toEqual([0, 1]);
    expect(out.balanceChanges.ok).toBe(true);
    expect(out.balanceChanges.entries).toEqual([
      {
        account: ADDR.wallet,
        asset: "native",
        beforeWei: "1000000000000000000",
        afterWei: "900000000000000000",
        deltaWei: "-100000000000000000",
      },
      {
        account: ADDR.wallet,
        asset: ADDR.token,
        beforeWei: "500",
        afterWei: "1500",
        deltaWei: "1000",
      },
    ]);
    // Four calls went out: the two brackets plus the caller's two.
    expect(
      (stub.calls[0]?.params[0] as { blockStateCalls: Array<{ calls: unknown[] }> })
        .blockStateCalls[0]?.calls,
    ).toHaveLength(4);
  });

  test("a token whose balance cannot be read is reported as unreadable, not as zero", async () => {
    const before = await aggregate3Return([
      [true, word(10n)],
      [false, "0x"],
    ]);
    const after = await aggregate3Return([
      [true, word(10n)],
      [false, "0x"],
    ]);
    use({
      eth_simulateV1: () =>
        simulateV1Result(100, [
          { returnData: before },
          { returnData: word(1n) },
          { returnData: after },
        ]),
    });
    const out = await run(evmSimulateBundle, {
      chainId: CHAIN,
      calls: [bundle[0] as (typeof bundle)[0]],
      trackBalances: { accounts: [ADDR.wallet], tokens: [ADDR.token] },
    });
    expect(out.balanceChanges.entries[1]).toMatchObject({ ok: false });
    expect(out.balanceChanges.entries[1].deltaWei).toBeUndefined();
  });

  test("a bracket that did not execute reports no deltas at all", async () => {
    use({
      eth_simulateV1: () =>
        simulateV1Result(100, [
          { returnData: "0x", status: 0 },
          { returnData: word(1n) },
          { returnData: "0x", status: 0 },
        ]),
    });
    const out = await run(evmSimulateBundle, {
      chainId: CHAIN,
      calls: [bundle[0] as (typeof bundle)[0]],
      trackBalances: { accounts: [ADDR.wallet] },
    });
    expect(out.balanceChanges).toMatchObject({ ok: false });
    expect(out.balanceChanges.reason).toContain("Multicall3");
    expect(out.balanceChanges.entries).toBeUndefined();
  });

  test("a cancelled run is refused by name, and no fallback is attempted", async () => {
    // No timer and no wall clock: the runtime's own signal is already
    // aborted, which is the same path a lapsed deadline takes.
    const stub = use({ eth_simulateV1: () => simulateV1Result(1, []), eth_call: () => word(1n) });
    const controller = new AbortController();
    controller.abort();
    const parsed = evmSimulateBundle.inputSchema.parse({ chainId: CHAIN, calls: bundle });
    await expect(evmSimulateBundle.execute(parsed, { signal: controller.signal })).rejects.toThrow(
      /cancelled .*NOT treated as an unimplemented method/s,
    );
    // Nothing was dispatched at all: a cancelled run is not a reason for a
    // node to see one more request.
    expect(stub.calls.length).toBe(0);
  });

  test("a bracket that answers in the wrong shape reports no deltas, not half of them", async () => {
    use({
      eth_simulateV1: () =>
        simulateV1Result(100, [
          { returnData: word(1n) },
          { returnData: word(1n) },
          { returnData: word(1n) },
        ]),
    });
    const out = await run(evmSimulateBundle, {
      chainId: CHAIN,
      calls: [bundle[0] as (typeof bundle)[0]],
      trackBalances: { accounts: [ADDR.wallet] },
    });
    expect(out.balanceChanges).toMatchObject({ ok: false });
    expect(out.balanceChanges.reason).toContain("Multicall3's shape");
    expect(out.balanceChanges.entries).toBeUndefined();
  });

  test("a node that reports no log list leaves the key OFF, and names the absence", async () => {
    // A node can implement eth_simulateV1 and still not trace logs. `logs: []`
    // there reads as "this call emitted no events", which is the reading a
    // policy gate acts on — and the one the fallback path already refuses to
    // produce. The primary path has to keep the same rule.
    use({
      eth_simulateV1: () =>
        simulateV1Raw(100, [
          { returnData: word(1n), gasUsed: "0x5208", status: "0x1" },
          { returnData: word(1n), gasUsed: "0x5208", status: "0x1" },
        ]),
    });
    const out = await run(evmSimulateBundle, { chainId: CHAIN, calls: bundle });
    expect(out.calls[0].logs).toBeUndefined();
    expect(JSON.stringify(out.calls)).not.toContain('"logs"');
    expect(out.limitations.join(" ")).toContain("NO log list");
  });

  test("an empty log list still means 'this call emitted nothing'", async () => {
    // The other half of the same rule: present-and-empty is a fact, and must
    // keep reading as one rather than being dropped along with the absent case.
    use({ eth_simulateV1: () => simulateV1Result(100, [{ returnData: "0x" }]) });
    const out = await run(evmSimulateBundle, {
      chainId: CHAIN,
      calls: [bundle[0] as (typeof bundle)[0]],
    });
    expect(out.calls[0].logs).toEqual([]);
    expect(out.limitations.join(" ")).not.toContain("NO log list");
  });

  test("a node that omits gasUsed leaves the key off rather than reporting zero", async () => {
    use({
      eth_simulateV1: () => simulateV1Raw(100, [{ returnData: "0x", status: "0x1", logs: [] }]),
    });
    const out = await run(evmSimulateBundle, {
      chainId: CHAIN,
      calls: [bundle[0] as (typeof bundle)[0]],
    });
    expect(out.calls[0].gasUsed).toBeUndefined();
    expect(out.limitations.join(" ")).toContain("no gasUsed figure");
  });

  test("a result with neither a status nor an error is refused, not read as success", async () => {
    // An outcome nobody reported is not an outcome that held. The assertion is
    // on the reason, because a thrown refusal is also what a timeout produces.
    use({ eth_simulateV1: () => simulateV1Raw(100, [{ returnData: "0x", gasUsed: "0x5208" }]) });
    await expect(
      run(evmSimulateBundle, { chainId: CHAIN, calls: [bundle[0] as (typeof bundle)[0]] }),
    ).rejects.toThrow(/neither a status nor an error/);
  });

  test("the fallback pins ONE height and sends it with every call", async () => {
    // Sending "latest" once per call resolves it once per call, and the head
    // moving mid-loop puts rows from two blocks into one table while the
    // limitation claims they share one.
    const stub = use({
      eth_simulateV1: () => {
        throw methodNotFound("eth_simulateV1");
      },
      eth_getBlockByNumber: () =>
        blockResult({ number: 4242, gasUsed: 1n, gasLimit: 2n, baseFeePerGas: 3n }),
      eth_call: () => word(1n),
    });
    const out = await run(evmSimulateBundle, { chainId: CHAIN, calls: bundle });

    const blocks = stub.calls.filter((c) => c.method === "eth_call").map((c) => c.params[1]);
    expect(blocks).toEqual(["0x1092", "0x1092"]);
    expect(out.blockNumber).toBe("4242");
    expect(out.limitations[0]).toContain("block 4242");
  });

  test("a fallback that cannot pin a height says the calls may not share a block", async () => {
    const stub = use({
      eth_simulateV1: () => {
        throw methodNotFound("eth_simulateV1");
      },
      eth_call: () => word(1n),
    });
    const out = await run(evmSimulateBundle, { chainId: CHAIN, calls: bundle });
    expect(out.blockNumber).toBeNull();
    expect(out.limitations[0]).toContain("do not even share a block");
    expect(stub.count("eth_call")).toBe(2);
  });

  test("a caller-pinned block costs the fallback no extra round trip", async () => {
    const stub = use({
      eth_simulateV1: () => {
        throw methodNotFound("eth_simulateV1");
      },
      eth_call: () => word(1n),
    });
    const out = await run(evmSimulateBundle, {
      chainId: CHAIN,
      calls: bundle,
      blockNumber: "4242",
    });
    expect(stub.count("eth_getBlockByNumber")).toBe(0);
    expect(stub.calls.filter((c) => c.method === "eth_call").map((c) => c.params[1])).toEqual([
      "0x1092",
      "0x1092",
    ]);
    expect(out.blockNumber).toBe("4242");
  });

  test("a node returning the wrong number of results is refused", async () => {
    use({ eth_simulateV1: () => simulateV1Result(100, [{ returnData: "0x" }]) });
    await expect(run(evmSimulateBundle, { chainId: CHAIN, calls: bundle })).rejects.toThrow(
      /matched by position/,
    );
  });

  test("a value that is not a decimal wei string is refused by the schema", () => {
    expect(() =>
      evmSimulateBundle.inputSchema.parse({
        chainId: CHAIN,
        calls: [{ to: ADDR.token, value: "0.5" }],
      }),
    ).toThrow(z.ZodError);
  });
});

// ---------------------------------------------------------------------------

describe("GasMarketRead", () => {
  const head = {
    number: 100,
    gasUsed: 15_000_000n,
    gasLimit: 30_000_000n,
    baseFeePerGas: 1_000_000_000n,
  };
  const history = {
    oldestBlock: 98,
    baseFeePerGas: [900_000_000n, 950_000_000n, 1_000_000_000n, 1_000_000_000n],
    reward: [
      [1n, 2n, 3n],
      [2n, 3n, 4n],
      [3n, 4n, 5n],
    ],
  };
  const feeMarket = (over: Record<string, RpcHandler> = {}): Record<string, RpcHandler> => ({
    eth_getBlockByNumber: () => blockResult(head),
    eth_feeHistory: () => feeHistoryResult(history),
    eth_gasPrice: () => "0x3b9aca0a",
    eth_getCode: () => "0x",
    ...over,
  });

  test("a 1559 chain: base fee, percentiles, and a projection that agrees with the node", async () => {
    use(feeMarket());
    const out = await run(gasMarketRead, { chainId: CHAIN, blockCount: 3 });

    expect(out.mechanism).toBe("eip1559");
    expect(out.block).toMatchObject({ number: "100", baseFeePerGasWei: "1000000000" });
    // A block exactly at target leaves the fee where it is.
    expect(out.nextBaseFee).toMatchObject({
      computedWei: "1000000000",
      nodeReportedWei: "1000000000",
      agrees: true,
      direction: "flat",
      gasTarget: "15000000",
    });
    expect(out.feeHistory.priorityFees).toEqual([
      { percentile: 10, medianWei: "2", minWei: "1", maxWei: "3", samples: 3 },
      { percentile: 50, medianWei: "3", minWei: "2", maxWei: "4", samples: 3 },
      { percentile: 90, medianWei: "4", minWei: "3", maxWei: "5", samples: 3 },
    ]);
    expect(out.feeHistory.baseFeeChangeBps).toBe("1111");
    expect(out.gasPriceWei).toBe("1000000010");
  });

  test("the projection uses the block's integers, not feeHistory's float ratio", async () => {
    // gasUsedRatio in the fixture is 0.5123456789 for every block. If the
    // projection used it, a block sitting exactly on target would be reported
    // as rising; it is not, because the rule reads gasUsed and gasLimit.
    use(feeMarket());
    const out = await run(gasMarketRead, { chainId: CHAIN, blockCount: 3 });
    expect(out.nextBaseFee.direction).toBe("flat");
    expect(out.nextBaseFee.computedWei).toBe("1000000000");
  });

  test("a chain whose rule differs is reported as a disagreement, not as a number", async () => {
    use(
      feeMarket({
        eth_feeHistory: () =>
          feeHistoryResult({
            ...history,
            baseFeePerGas: [...history.baseFeePerGas.slice(0, 3), 7n],
          }),
      }),
    );
    const out = await run(gasMarketRead, { chainId: CHAIN, blockCount: 3 });
    expect(out.nextBaseFee).toMatchObject({ agrees: false, nodeReportedWei: "7" });
    expect(out.caveats.join(" ")).toContain("does not follow the vanilla EIP-1559 rule");
  });

  test("a chain with no 1559 market is reported as legacy, not projected", async () => {
    use(
      feeMarket({
        eth_getBlockByNumber: () =>
          blockResult({ number: 100, gasUsed: 1_000n, gasLimit: 30_000_000n }),
        eth_feeHistory: () => {
          throw methodNotFound("eth_feeHistory");
        },
      }),
    );
    const out = await run(gasMarketRead, { chainId: CHAIN, gasLimit: "21000" });

    expect(out.mechanism).toBe("legacy");
    expect(out.nextBaseFee).toBeUndefined();
    expect(out.block.baseFeePerGasWei).toBeNull();
    expect(out.feeHistory).toEqual({ available: false });
    expect(out.planned).toMatchObject({ mechanism: "legacy", estimatedCostWei: "21000000210000" });
    expect(out.caveats.join(" ")).toContain("does not implement eth_feeHistory");
  });

  test("a base fee that never moves is flagged rather than trended", async () => {
    use(
      feeMarket({
        eth_feeHistory: () =>
          feeHistoryResult({
            ...history,
            baseFeePerGas: [1_000_000_000n, 1_000_000_000n, 1_000_000_000n, 1_000_000_000n],
          }),
      }),
    );
    const out = await run(gasMarketRead, { chainId: CHAIN, blockCount: 3 });
    expect(out.feeHistory.baseFeeConstant).toBe(true);
    expect(out.feeHistory.baseFeeChangeBps).toBe("0");
    expect(out.caveats.join(" ")).toContain("Arbitrum");
  });

  test("a head that moved between the two reads is named, not smoothed over", async () => {
    use(
      feeMarket({
        eth_feeHistory: () =>
          feeHistoryResult({
            ...history,
            baseFeePerGas: [900_000_000n, 950_000_000n, 970_000_000n, 1n],
          }),
      }),
    );
    const out = await run(gasMarketRead, { chainId: CHAIN, blockCount: 3 });
    expect(out.caveats.join(" ")).toContain("head moved between the two requests");
  });

  test("a blob market is reported from the node's own figures, never recomputed", async () => {
    use(
      feeMarket({
        eth_feeHistory: () =>
          feeHistoryResult({
            ...history,
            baseFeePerBlobGas: [1n, 2n, 3n, 4n],
          }),
      }),
    );
    const out = await run(gasMarketRead, { chainId: CHAIN, blockCount: 3 });
    expect(out.blobs).toMatchObject({
      baseFeePerBlobGasWei: "3",
      nextBaseFeePerBlobGasWei: "4",
    });
    expect(out.blobs.source).toContain("exponential");
  });

  test("an OP-stack chain is told it has an L1 data fee this tool does not price", async () => {
    use(feeMarket({ eth_getCode: () => "0x60806040" }));
    const out = await run(gasMarketRead, { chainId: CHAIN, blockCount: 3 });
    expect(out.rollup).toMatchObject({ opStackGasPriceOracle: true });
    expect(out.caveats.join(" ")).toContain("L1 data fee");
  });

  test("a planned transaction is priced at a percentile, with the headroom named", async () => {
    use(feeMarket());
    const out = await run(gasMarketRead, {
      chainId: CHAIN,
      blockCount: 3,
      gasLimit: "150000",
      atPercentile: 90,
    });
    expect(out.planned).toMatchObject({
      mechanism: "eip1559",
      atPercentile: 90,
      maxPriorityFeePerGasWei: "4",
      // next(1e9) * 2 + tip(4)
      suggestedMaxFeePerGasWei: "2000000004",
      expectedCostWei: "150000000600000",
      worstCaseCostWei: "300000000600000",
    });
  });

  test("a percentile the node did not answer is named, not quietly substituted", async () => {
    use({
      eth_getBlockByNumber: () => blockResult(head),
      // Three percentiles asked for, one column answered.
      eth_feeHistory: () =>
        feeHistoryResult({
          oldestBlock: 98,
          baseFeePerGas: [1_000_000_000n, 1_000_000_000n, 1_000_000_000n],
          reward: [[1n], [1n]],
        }),
      eth_gasPrice: () => "0x1",
      eth_getCode: () => "0x",
    });
    const out = await run(gasMarketRead, {
      chainId: CHAIN,
      blockCount: 2,
      percentiles: [10, 50, 90],
      gasLimit: "21000",
      atPercentile: 90,
    });
    // Pricing the 90th at the 10th without saying so is how a caller under-tips.
    expect(out.planned.requestedPercentile).toBe(90);
    expect(out.planned.atPercentile).toBe(10);
    expect(out.caveats.join(" ")).toContain("90th priority-fee percentile was not among");
  });

  test("the node's own next-block figure, not ours, prices the planned transaction", async () => {
    // A chain whose rule differs: the node says 2 gwei, the vanilla rule says
    // something else. The caveat already reports the disagreement; this pins
    // that the money figure follows the node rather than the cross-check.
    use({
      eth_getBlockByNumber: () => blockResult(head),
      eth_feeHistory: () =>
        feeHistoryResult({
          oldestBlock: 99,
          baseFeePerGas: [1_000_000_000n, 1_000_000_000n, 2_000_000_000n],
          reward: [[1n], [1n]],
        }),
      eth_gasPrice: () => "0x1",
      eth_getCode: () => "0x",
    });
    const out = await run(gasMarketRead, {
      chainId: CHAIN,
      blockCount: 2,
      percentiles: [50],
      gasLimit: "21000",
      atPercentile: 50,
    });
    expect(out.nextBaseFee).toMatchObject({
      computedWei: "1000000000",
      nodeReportedWei: "2000000000",
      agrees: false,
    });
    // 21000 * (2 gwei + 1 wei tip), from the node's figure — not 21000 * 1 gwei.
    expect(out.planned.expectedCostWei).toBe("42000000021000");
    expect(out.planned.suggestedMaxFeePerGasWei).toBe("4000000001");
  });

  test("percentiles that are not ascending are refused before anything is dialled", async () => {
    const stub = use(feeMarket());
    await expect(run(gasMarketRead, { chainId: CHAIN, percentiles: [50, 10] })).rejects.toThrow(
      /strictly ascending/,
    );
    expect(stub.calls.length).toBe(0);
  });

  test("a block the node does not have is a refusal, not an empty report", async () => {
    use(feeMarket({ eth_getBlockByNumber: () => null }));
    await expect(run(gasMarketRead, { chainId: CHAIN, blockNumber: "999999999" })).rejects.toThrow(
      /has no block at/,
    );
  });

  test("every report carries the rollup caveat, even where no oracle was found", async () => {
    use(feeMarket());
    const out = await run(gasMarketRead, { chainId: CHAIN, blockCount: 3 });
    expect(out.rollup).toMatchObject({ opStackGasPriceOracle: false });
    expect(out.caveats.join(" ")).toContain("L1 data fee is charged separately");
  });
});

// ---------------------------------------------------------------------------

describe("nothing here signs or sends", () => {
  /** Every key name any of these schemas will accept, however deeply nested. */
  function schemaKeys(schema: unknown, depth = 0): string[] {
    if (depth > 12 || schema === null || typeof schema !== "object") return [];
    const def = (schema as { _def?: Record<string, unknown> })._def;
    if (def === undefined) return [];
    const keys: string[] = [];
    const walk = (child: unknown): void => {
      keys.push(...schemaKeys(child, depth + 1));
    };

    const shape = def["shape"];
    if (typeof shape === "function") {
      for (const [name, child] of Object.entries((shape as () => object)())) {
        keys.push(name);
        walk(child);
      }
    }
    for (const field of ["type", "innerType", "valueType", "keyType", "schema"]) {
      if (def[field] !== undefined) walk(def[field]);
    }
    const options = def["options"];
    if (Array.isArray(options)) for (const option of options) walk(option);
    return keys;
  }

  test("the walker actually reaches nested keys, or every miss below is vacuous", () => {
    const keys = schemaKeys(evmSimulateBundle.inputSchema);
    // Proof of reach: `accounts` only exists inside trackBalances, and
    // `allowFailure` only inside a multicall call object.
    expect(keys).toContain("accounts");
    expect(schemaKeys(evmMulticall.inputSchema)).toContain("allowFailure");
  });

  test("no schema has a field to pass a key, a seed or a signed transaction to", () => {
    const forbidden = [
      "privatekey",
      "private_key",
      "mnemonic",
      "seedphrase",
      "keystore",
      "secretkey",
      "signer",
      "signedtransaction",
      "rawtransaction",
      "signtransaction",
      "credentials",
    ];
    for (const tool of CHAINCALL_TOOLS) {
      const keys = schemaKeys(tool.inputSchema).map((k) => k.toLowerCase());
      for (const bad of forbidden) {
        expect({ tool: tool.name, field: bad, present: keys.includes(bad) }).toEqual({
          tool: tool.name,
          field: bad,
          present: false,
        });
      }
    }
  });

  test("the one 'signature' field is a FUNCTION signature, and says so", () => {
    // It would be easy to read this as a cryptographic one. It is the thing
    // AbiEncodeCall takes, and it is the only field in the package whose name
    // is anywhere near a key.
    const root = evmMulticall.inputSchema as unknown as z.ZodObject<{
      calls: z.ZodArray<z.ZodObject<Record<string, z.ZodTypeAny>>>;
    }>;
    const described = root.shape.calls.element.shape["signature"] as z.ZodTypeAny;
    expect(described.description).toContain("balanceOf(address)");
  });

  test("every schema is strict, so an injected key field is rejected outright", () => {
    const result = evmSimulateBundle.inputSchema.safeParse({
      chainId: CHAIN,
      calls: [{ to: ADDR.token }],
      privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    });
    expect(result.success).toBe(false);
  });

  test("every method the four tools dispatch is on the read-only allowlist", async () => {
    const dispatched = new Set<string>();
    const record = (stub: RpcStub): void => {
      for (const call of stub.calls) dispatched.add(call.method);
    };

    let stub = use({
      eth_call: async () =>
        aggregate3Return([
          [true, word(1n)],
          [true, word(1n)],
        ]),
    });
    await run(evmMulticall, { chainId: CHAIN, calls: [{ target: ADDR.token, data: "0x" }] });
    record(stub);

    stub = use(await inspectHandlers({ code: "0x60806040", views: inspectViewRows({}) }));
    await run(contractInspect, { chainId: CHAIN, address: ADDR.token });
    record(stub);

    stub = use({ eth_simulateV1: () => simulateV1Result(1, [{ returnData: "0x" }]) });
    await run(evmSimulateBundle, { chainId: CHAIN, calls: [{ to: ADDR.token }] });
    record(stub);

    stub = use({
      eth_getBlockByNumber: () =>
        blockResult({ number: 1, gasUsed: 1n, gasLimit: 2n, baseFeePerGas: 3n }),
      eth_feeHistory: () => feeHistoryResult({ oldestBlock: 1, baseFeePerGas: [3n, 3n] }),
      eth_gasPrice: () => "0x1",
      eth_getCode: () => "0x",
    });
    await run(gasMarketRead, { chainId: CHAIN, blockCount: 1 });
    record(stub);

    // `assertReadOnlyMethod` is the gate; this asserts the gate was actually
    // exercised by naming what went through it.
    expect([...dispatched].sort()).toEqual([
      "eth_call",
      "eth_feeHistory",
      "eth_gasPrice",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_getStorageAt",
      "eth_simulateV1",
    ]);
    for (const forbidden of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign"]) {
      expect({ method: forbidden, dispatched: dispatched.has(forbidden) }).toEqual({
        method: forbidden,
        dispatched: false,
      });
    }
  });

  test("the module CODE holds no key-handling or transaction-sending path", async () => {
    // Comments are stripped first, because the doc comments say these words
    // on purpose — naming what a package will not do is the point of them.
    // What must not exist is a line of code that does it.
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join("\n");

    const anchors: Record<string, string> = {
      "index.ts": "buildTool",
      "lib/rpc.ts": "assertReadOnlyMethod",
      "lib/simulate.ts": "parseSimulateV1",
      "lib/codec.ts": "SELECTORS",
    };
    for (const [name, anchor] of Object.entries(anchors)) {
      const raw = await Bun.file(new URL(`./${name}`, import.meta.url)).text();
      const src = stripComments(raw);
      // A scan that read the wrong path, or a stripper that ate the file,
      // finds nothing and passes every miss below. Prove both landed first.
      expect({ name, anchored: src.includes(anchor), stripped: src.length < raw.length }).toEqual({
        name,
        anchored: true,
        stripped: true,
      });
      for (const forbidden of [
        "privateKey",
        "mnemonic",
        "keystore",
        "secretKey",
        "eth_sendRawTransaction",
        "eth_sendTransaction",
        "signTransaction",
        "personal_sign",
      ]) {
        expect({ name, forbidden, present: src.includes(forbidden) }).toEqual({
          name,
          forbidden,
          present: false,
        });
      }
    }
  });
});
