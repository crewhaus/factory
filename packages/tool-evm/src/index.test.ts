import { beforeEach, describe, expect, test } from "bun:test";
import type { ChainAdapter } from "@crewhaus/chain-adapter-base";
import { auditToolScopes } from "@crewhaus/tool-builder";
import { EVM_TOOL_MAP, bindEvmChains, setEvmAdapterResolver } from "./index";

type Call = { method: string; params: ReadonlyArray<unknown> };

function fakeAdapter(handler: (call: Call) => unknown): ChainAdapter {
  return {
    chainId: "test-chain",
    config: {
      chainId: "test-chain",
      rpcUrls: ["https://stub.test"],
      rpcPolicy: "single",
      finality: { kind: "finalized" },
      reorgTolerant: true,
    },
    async rpcRead(method, params) {
      return handler({ method, params });
    },
  };
}

beforeEach(() => {
  // Reset the resolver between tests so missing-binding errors are testable.
  setEvmAdapterResolver(() => undefined);
});

describe("tool-evm: all tools surfaced with readOnly: true", () => {
  test("every tool is readOnly and classifies output", () => {
    for (const tool of Object.values(EVM_TOOL_MAP)) {
      expect(tool.readOnly).toBe(true);
      expect(tool.destructive).toBe(false);
      expect(tool.classifyOutput).toBe(true);
    }
  });

  test("every tool declares the RPC boundary it crosses (C041)", () => {
    // Read-only is not offline: each call's arguments, EvmCall's calldata
    // among them, go to the chain's RPC endpoint. Undeclared, the egress
    // classifier and the strict scope audit never saw them.
    const tools = Object.values(EVM_TOOL_MAP);
    expect(tools).toHaveLength(6);
    for (const tool of tools) {
      expect({ name: tool.name, scope: tool.scope, io: tool.ioCapability }).toEqual({
        name: tool.name,
        scope: "external",
        io: "network",
      });
    }
    expect(auditToolScopes(tools)).toEqual([]);
  });
});

describe("tool-evm: a call's cancellation reaches the adapter (C041)", () => {
  const inputs: Record<string, Record<string, unknown>> = {
    evmCall: { chainId: "1", to: "0xc", data: "0x" },
    evmGetLogs: { chainId: "1", fromBlock: "0x0", toBlock: "latest" },
    evmGetTransaction: { chainId: "1", txHash: "0xh" },
    evmGetTransactionReceipt: { chainId: "1", txHash: "0xh" },
    evmGetBalance: { chainId: "1", address: "0xa" },
    evmBlockNumber: { chainId: "1" },
  };

  test("every tool hands its ctx.signal to rpcRead", async () => {
    const seen: unknown[] = [];
    setEvmAdapterResolver(() => ({
      ...fakeAdapter(() => "0x1"),
      async rpcRead(_method, _params, opts) {
        seen.push(opts);
        return "0x1";
      },
    }));
    const { signal } = new AbortController();
    for (const [key, tool] of Object.entries(EVM_TOOL_MAP)) {
      await tool.execute(inputs[key] as never, { signal });
    }
    expect(seen).toHaveLength(6);
    for (const opts of seen) expect(opts).toEqual({ signal });
  });

  test("a cancelled EvmGetLogs against a node that never answers ends", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      bindEvmChains({
        chains: [
          {
            chainId: "1",
            rpcUrls: [`http://127.0.0.1:${server.port}/`],
            rpcPolicy: "single",
            finality: { kind: "finalized" },
            reorgTolerant: true,
          },
        ],
      });
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 50);
      // A two-second sentinel, far past the 50 ms cancel: it wins only when
      // nothing ends the read (0.7.0 had no signal to end it with).
      const outcome = await Promise.race([
        EVM_TOOL_MAP.evmGetLogs
          .execute(inputs["evmGetLogs"] as never, { signal: cancel.signal })
          .then(
            () => "resolved",
            (err: unknown) => err,
          ),
        Bun.sleep(2_000).then(() => "still pending"),
      ]);
      expect(String(outcome)).toContain("the read was cancelled");
    } finally {
      server.stop(true);
    }
  });
});

describe("EvmCall", () => {
  test("dispatches eth_call with to+data, latest by default", async () => {
    const calls: Call[] = [];
    setEvmAdapterResolver(() =>
      fakeAdapter((c) => {
        calls.push(c);
        return "0x000000000000000000000000000000000000000000000000000000000000007b";
      }),
    );
    const result = await EVM_TOOL_MAP.evmCall.execute({
      chainId: "base-mainnet",
      to: "0xcontract",
      data: "0xabcd",
    });
    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first?.method).toBe("eth_call");
    expect(first?.params[1]).toBe("latest");
    expect(result).toContain("007b");
  });

  test("honors explicit blockTag", async () => {
    let receivedTag: unknown;
    setEvmAdapterResolver(() =>
      fakeAdapter((c) => {
        receivedTag = c.params[1];
        return "0x";
      }),
    );
    await EVM_TOOL_MAP.evmCall.execute({
      chainId: "base-mainnet",
      to: "0x",
      data: "0x",
      blockTag: "finalized",
    });
    expect(receivedTag).toBe("finalized");
  });

  test("throws a descriptive error when no adapter is registered", async () => {
    setEvmAdapterResolver(() => undefined);
    await expect(
      EVM_TOOL_MAP.evmCall.execute({ chainId: "unknown", to: "0x", data: "0x" }),
    ).rejects.toThrow(/no chain adapter registered for chainId "unknown"/);
  });
});

describe("EvmGetLogs", () => {
  test("forwards optional address and topics", async () => {
    const calls: Call[] = [];
    setEvmAdapterResolver(() =>
      fakeAdapter((c) => {
        calls.push(c);
        return [];
      }),
    );
    await EVM_TOOL_MAP.evmGetLogs.execute({
      chainId: "base-mainnet",
      address: "0xabc",
      fromBlock: "0x1",
      toBlock: "latest",
      topics: ["0xtopic0", null],
    });
    const first = calls[0];
    expect(first?.method).toBe("eth_getLogs");
    const filter = first?.params[0] as Record<string, unknown>;
    expect(filter["address"]).toBe("0xabc");
    expect(filter["topics"]).toEqual(["0xtopic0", null]);
    expect(filter["fromBlock"]).toBe("0x1");
    expect(filter["toBlock"]).toBe("latest");
  });
});

describe("EvmGetTransactionReceipt", () => {
  test("returns the serialized receipt", async () => {
    setEvmAdapterResolver(() =>
      fakeAdapter(() => ({
        status: "0x1",
        blockNumber: "0x100",
        gasUsed: "0x5208",
      })),
    );
    const out = await EVM_TOOL_MAP.evmGetTransactionReceipt.execute({
      chainId: "base-mainnet",
      txHash: "0xdead",
    });
    expect(typeof out).toBe("string");
    expect(JSON.parse(out as string).status).toBe("0x1");
  });
});

describe("EvmGetTransaction", () => {
  test("dispatches eth_getTransactionByHash with the hash", async () => {
    const calls: Call[] = [];
    setEvmAdapterResolver(() =>
      fakeAdapter((c) => {
        calls.push(c);
        return { from: "0xfrom", to: "0xto", value: "0x0" };
      }),
    );
    const out = await EVM_TOOL_MAP.evmGetTransaction.execute({
      chainId: "base-mainnet",
      txHash: "0xdeadbeef",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("eth_getTransactionByHash");
    expect(calls[0]?.params).toEqual(["0xdeadbeef"]);
    expect(JSON.parse(out as string).from).toBe("0xfrom");
  });
});

describe("EvmGetBalance", () => {
  test("dispatches eth_getBalance with address + latest by default and returns the hex string", async () => {
    const calls: Call[] = [];
    setEvmAdapterResolver(() =>
      fakeAdapter((c) => {
        calls.push(c);
        return "0xde0b6b3a7640000";
      }),
    );
    const out = await EVM_TOOL_MAP.evmGetBalance.execute({
      chainId: "base-mainnet",
      address: "0xwallet",
    });
    expect(calls[0]?.method).toBe("eth_getBalance");
    expect(calls[0]?.params).toEqual(["0xwallet", "latest"]);
    // String result is returned verbatim, not JSON-stringified.
    expect(out).toBe("0xde0b6b3a7640000");
  });

  test("honors explicit blockTag and JSON-stringifies a non-string result", async () => {
    let receivedTag: unknown;
    setEvmAdapterResolver(() =>
      fakeAdapter((c) => {
        receivedTag = c.params[1];
        return { weird: "object" };
      }),
    );
    const out = await EVM_TOOL_MAP.evmGetBalance.execute({
      chainId: "base-mainnet",
      address: "0xwallet",
      blockTag: "finalized",
    });
    expect(receivedTag).toBe("finalized");
    expect(JSON.parse(out as string).weird).toBe("object");
  });
});

describe("EvmBlockNumber", () => {
  test("dispatches eth_blockNumber with no params and returns the hex string", async () => {
    const calls: Call[] = [];
    setEvmAdapterResolver(() =>
      fakeAdapter((c) => {
        calls.push(c);
        return "0x1234";
      }),
    );
    const out = await EVM_TOOL_MAP.evmBlockNumber.execute({ chainId: "base-mainnet" });
    expect(calls[0]?.method).toBe("eth_blockNumber");
    expect(calls[0]?.params).toEqual([]);
    expect(out).toBe("0x1234");
  });

  test("JSON-stringifies a non-string block-number result (defensive)", async () => {
    setEvmAdapterResolver(() => fakeAdapter(() => ({ block: 4660 })));
    const out = await EVM_TOOL_MAP.evmBlockNumber.execute({ chainId: "base-mainnet" });
    expect(JSON.parse(out as string).block).toBe(4660);
  });
});

describe("requireAdapter — unbound resolver branch", () => {
  test("throws a boot-time error when no resolver has been bound", async () => {
    // Force the module-level resolver back to undefined to exercise the
    // `resolver === undefined` branch (distinct from a bound resolver that
    // returns undefined for an unknown chainId).
    setEvmAdapterResolver(undefined as unknown as (chainId: string) => undefined);
    await expect(EVM_TOOL_MAP.evmBlockNumber.execute({ chainId: "base-mainnet" })).rejects.toThrow(
      /EvmBlockNumber: no chain is configured\. Declare one in the spec — chains: \[/,
    );
  });
});
