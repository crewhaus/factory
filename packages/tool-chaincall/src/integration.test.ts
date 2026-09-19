/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and turns a thrown refusal into an error RESULT rather than
 * a crash. A tool that works when called directly but not here is a tool the
 * runtime cannot use, which is why this file exists separately.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { MULTICALL3_ADDRESS } from "@crewhaus/tool-onchain";
import {
  ADDR,
  ZERO_WORD,
  addressWord,
  aggregate3Return,
  blockResult,
  feeHistoryResult,
  inspectViewRows,
  methodNotFound,
  rpcStub,
  simulateV1Result,
  word,
} from "./fixtures";
import { CHAINCALL_TOOLS, EIP1967_IMPLEMENTATION_SLOT, _setRpc } from "./index";

const CHAIN = "base-mainnet";
/** `supportsInterface(bytes4)` — how the introspection batch is recognised. */
const SUPPORTS_INTERFACE_SELECTOR = "01ffc9a7";
let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

/** `content` is a union; every tool here returns the string arm. */
function text(result: { content: unknown }): string {
  if (typeof result.content !== "string") throw new Error("expected string content");
  return result.content;
}

/**
 * One transport that answers every method all four tools reach for, so a
 * dispatch test is about the runtime path and not about fixture plumbing.
 */
async function wholeChain(): Promise<void> {
  const views = await aggregate3Return(inspectViewRows({ supports: ["0x80ac58cd"] }));
  const batch = await aggregate3Return([
    [true, word(1_234n)],
    [true, word(19_000_000n)],
  ]);
  const stub = rpcStub({
    eth_call: (params) => {
      const { to, data } = params[0] as { to: string; data: string };
      if (to.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase()) {
        throw new Error(`the stub serves Multicall3 batches only, not a direct call to ${to}`);
      }
      // The introspection batch is the one carrying supportsInterface probes.
      return data.includes(SUPPORTS_INTERFACE_SELECTOR) ? views : batch;
    },
    eth_getCode: () => "0x60806040",
    eth_getStorageAt: (params) =>
      String(params[1]) === EIP1967_IMPLEMENTATION_SLOT
        ? addressWord(ADDR.implementation)
        : ZERO_WORD,
    eth_simulateV1: () => simulateV1Result(19_000_000, [{ returnData: word(1n) }]),
    eth_getBlockByNumber: () =>
      blockResult({
        number: 19_000_000,
        gasUsed: 15_000_000n,
        gasLimit: 30_000_000n,
        baseFeePerGas: 1_000_000_000n,
      }),
    eth_feeHistory: () =>
      feeHistoryResult({
        oldestBlock: 19_000_000,
        baseFeePerGas: [1_000_000_000n, 1_000_000_000n],
      }),
    eth_gasPrice: () => "0x3b9aca00",
  });
  _setRpc(stub.rpc);
}

beforeEach(async () => {
  catalog = new ToolCatalog();
  for (const tool of CHAINCALL_TOOLS) catalog.register(tool);
  await wholeChain();
});

afterEach(() => _setRpc(undefined));

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(CHAINCALL_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of CHAINCALL_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });

  test("registering the same package twice is refused, which is what protects the names", () => {
    expect(() => catalog.register(CHAINCALL_TOOLS[0] as RegisteredTool)).toThrow();
  });
});

describe("dispatch through executeTool", () => {
  const minimal: Record<string, unknown> = {
    EvmMulticall: {
      chainId: CHAIN,
      calls: [{ target: ADDR.token, signature: "decimals()", outputs: ["uint256"] }],
    },
    ContractInspect: { chainId: CHAIN, address: ADDR.proxy },
    EvmSimulateBundle: { chainId: CHAIN, calls: [{ to: ADDR.token, data: "0x" }] },
    GasMarketRead: { chainId: CHAIN, blockCount: 1 },
  };

  test("every tool dispatches with a minimal valid input", async () => {
    for (const tool of CHAINCALL_TOOLS) {
      const result = await executeTool(lookup(tool.name), minimal[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("input is validated before execute, so a bad type never reaches the chain", async () => {
    const result = await executeTool(
      lookup("ContractInspect"),
      { chainId: CHAIN, address: 42 },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(true);
  });

  test("an unknown field is rejected rather than ignored", async () => {
    const result = await executeTool(
      lookup("GasMarketRead"),
      { chainId: CHAIN, privateKey: "0xdeadbeef" },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
  });

  test("a refusal comes back as an error result with the reason, not a thrown crash", async () => {
    const result = await executeTool(
      lookup("GasMarketRead"),
      { chainId: CHAIN, percentiles: [90, 10] },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("strictly ascending");
  });

  test("an unwired chain is an error result naming the spec block", async () => {
    _setRpc(undefined);
    const result = await executeTool(
      lookup("EvmMulticall"),
      { chainId: "nope", calls: [{ target: ADDR.token, data: "0x" }] },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("setChainRpcResolver");
  });

  test("a degraded simulation is a successful RESULT, because it is an answer", async () => {
    // The distinction the runtime depends on: "this node cannot chain state"
    // is something the model must read and reason about, not an error that
    // sends it into a retry loop.
    const stub = rpcStub({
      eth_simulateV1: () => {
        throw methodNotFound("eth_simulateV1");
      },
      eth_call: () => word(1n),
    });
    _setRpc(stub.rpc);
    const result = await executeTool(
      lookup("EvmSimulateBundle"),
      { chainId: CHAIN, calls: [{ to: ADDR.token, data: "0x" }] },
      { toolUseId: "t5" },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(text(result)).mode).toBe("eth_call-fallback");
  });
});

describe("the question these four answer together", () => {
  test("inspect the proxy, read its implementation, then price the call", async () => {
    // The workflow the package is for: find out what an address really is,
    // read its state consistently, check the plan, then decide what to pay.
    const inspected = await executeTool(
      lookup("ContractInspect"),
      { chainId: CHAIN, address: ADDR.proxy },
      { toolUseId: "w1" },
    );
    const implementation = JSON.parse(text(inspected)).verified.proxy.implementation as string;
    expect(implementation).toBe(ADDR.implementation);

    const read = await executeTool(
      lookup("EvmMulticall"),
      {
        chainId: CHAIN,
        calls: [{ target: implementation, signature: "totalSupply()", outputs: ["uint256"] }],
      },
      { toolUseId: "w2" },
    );
    const batch = JSON.parse(text(read));
    expect(batch.results[0].decoded).toEqual(["1234"]);
    expect(batch.block.number).toBe("19000000");

    const gas = await executeTool(
      lookup("GasMarketRead"),
      { chainId: CHAIN, blockCount: 1, gasLimit: "21000" },
      { toolUseId: "w3" },
    );
    const market = JSON.parse(text(gas));
    expect(market.mechanism).toBe("eip1559");
    expect(market.planned.gasLimit).toBe("21000");
  });
});
