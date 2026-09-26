import { describe, expect, test } from "bun:test";
import { auditToolScopes } from "@crewhaus/tool-builder";
import { ToolCatalog } from "@crewhaus/tool-catalog";
import { evmCall } from "@crewhaus/tool-evm";
import { evmSendTransaction } from "@crewhaus/tool-evm-tx";
import { canonicalFunction } from "@crewhaus/tool-onchain";
import {
  type AbiItem,
  ContractToolError,
  type WriteExecutor,
  generateContractTools,
} from "./index";

const ERC20_ABI: ReadonlyArray<AbiItem> = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256" },
    ],
  },
];

const CONTRACT = { id: "usdc", chainId: "base-mainnet", address: "0xusdc" };

describe("generateContractTools", () => {
  test("emits one tool per ABI function (events skipped)", () => {
    const tools = generateContractTools({
      contract: CONTRACT,
      abi: ERC20_ABI,
      readExecutor: async () => "0x0",
      writeExecutor: async () => "{}",
    });
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "usdc__allowance",
      "usdc__approve",
      "usdc__balanceOf",
      "usdc__transfer",
    ]);
  });

  test("view/pure functions become readOnly tools", () => {
    const tools = generateContractTools({
      contract: CONTRACT,
      abi: ERC20_ABI,
      readExecutor: async () => "0x0",
      writeExecutor: async () => "{}",
    });
    const balanceOf = tools.find((t) => t.name === "usdc__balanceOf");
    expect(balanceOf?.readOnly).toBe(true);
    expect(balanceOf?.destructive).toBe(false);
  });

  test("nonpayable/payable functions become destructive tools", () => {
    const tools = generateContractTools({
      contract: CONTRACT,
      abi: ERC20_ABI,
      readExecutor: async () => "0x0",
      writeExecutor: async () => "{}",
    });
    const transfer = tools.find((t) => t.name === "usdc__transfer");
    expect(transfer?.destructive).toBe(true);
    expect(transfer?.readOnly).toBe(false);
    expect(transfer?.classifyOutput).toBe(true);
  });

  test("read tool dispatches with the input parameters in ABI order", async () => {
    const captured: Array<{ methodName: string; inputs: ReadonlyArray<unknown> }> = [];
    const tools = generateContractTools({
      contract: CONTRACT,
      abi: ERC20_ABI,
      readExecutor: async (args) => {
        captured.push({ methodName: args.methodName, inputs: args.inputs });
        return "0x42";
      },
      writeExecutor: async () => "{}",
    });
    const allowance = tools.find((t) => t.name === "usdc__allowance");
    if (allowance === undefined) throw new Error("allowance tool not generated");
    const out = await allowance.execute({
      owner: "0xowner",
      spender: "0xspender",
    });
    expect(out).toBe("0x42");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.methodName).toBe("allowance");
    expect(captured[0]?.inputs).toEqual(["0xowner", "0xspender"]);
  });

  test("write tool requires walletId and forwards to executor", async () => {
    let received: { walletId: string; methodName: string; inputs: ReadonlyArray<unknown> } | null =
      null;
    const tools = generateContractTools({
      contract: CONTRACT,
      abi: ERC20_ABI,
      readExecutor: async () => "0x",
      writeExecutor: async (args) => {
        received = {
          walletId: args.walletId,
          methodName: args.methodName,
          inputs: args.inputs,
        };
        return JSON.stringify({ txHash: "0xfake" });
      },
    });
    const transfer = tools.find((t) => t.name === "usdc__transfer");
    if (transfer === undefined) throw new Error("transfer tool not generated");
    const out = await transfer.execute({
      walletId: "treasury",
      to: "0xrecipient",
      amount: "0x64",
    });
    expect(out).toContain("0xfake");
    expect(received).not.toBeNull();
    const r = received as unknown as {
      walletId: string;
      methodName: string;
      inputs: ReadonlyArray<unknown>;
    };
    expect(r.walletId).toBe("treasury");
    expect(r.methodName).toBe("transfer");
    expect(r.inputs).toEqual(["0xrecipient", "0x64"]);
  });

  test("payable function adds an optional value field and forwards it to the executor", async () => {
    const PAYABLE_ABI: ReadonlyArray<AbiItem> = [
      {
        type: "function",
        name: "deposit",
        inputs: [{ name: "to", type: "address" }],
        outputs: [],
        stateMutability: "payable",
      },
    ];
    let received: { value?: string; inputs: ReadonlyArray<unknown>; methodName: string } | null =
      null;
    const tools = generateContractTools({
      contract: CONTRACT,
      abi: PAYABLE_ABI,
      readExecutor: async () => "0x",
      writeExecutor: async (args) => {
        received = { value: args.value, inputs: args.inputs, methodName: args.methodName };
        return JSON.stringify({ txHash: "0xpay" });
      },
    });
    const deposit = tools.find((t) => t.name === "usdc__deposit");
    if (deposit === undefined) throw new Error("deposit tool not generated");

    // The payable branch extends the schema with an optional `value` field.
    const schema = deposit.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(
      schema.safeParse({ walletId: "treasury", to: "0xrcv", value: "0x16345785d8a0000" }).success,
    ).toBe(true);
    // value is optional — a call without it still validates.
    expect(schema.safeParse({ walletId: "treasury", to: "0xrcv" }).success).toBe(true);

    const out = await deposit.execute({
      walletId: "treasury",
      to: "0xrcv",
      value: "0x16345785d8a0000",
    });
    expect(out).toContain("0xpay");
    const r = received as unknown as { value?: string; methodName: string };
    expect(r.value).toBe("0x16345785d8a0000");
    expect(r.methodName).toBe("deposit");
  });

  test("payable function omits value from executor args when not provided", async () => {
    const PAYABLE_ABI: ReadonlyArray<AbiItem> = [
      {
        type: "function",
        name: "deposit",
        inputs: [],
        outputs: [],
        stateMutability: "payable",
      },
    ];
    let sawValueKey = true;
    const tools = generateContractTools({
      contract: CONTRACT,
      abi: PAYABLE_ABI,
      readExecutor: async () => "0x",
      writeExecutor: async (args) => {
        sawValueKey = "value" in args;
        return "{}";
      },
    });
    const deposit = tools.find((t) => t.name === "usdc__deposit");
    if (deposit === undefined) throw new Error("deposit tool not generated");
    await deposit.execute({ walletId: "treasury" });
    // value is undefined → the spread omits the key entirely.
    expect(sawValueKey).toBe(false);
  });

  test("write tool throws when walletId is missing", async () => {
    const tools = generateContractTools({
      contract: CONTRACT,
      abi: ERC20_ABI,
      readExecutor: async () => "0x",
      writeExecutor: async () => "{}",
    });
    const transfer = tools.find((t) => t.name === "usdc__transfer");
    if (transfer === undefined) throw new Error("transfer tool not generated");
    await expect(transfer.execute({ to: "0xrecipient", amount: "0x64" })).rejects.toThrow(
      /walletId is required/,
    );
  });
});

describe("generated tools say they cross the network, and writes are intent-gated (C151)", () => {
  const tools = generateContractTools({
    contract: CONTRACT,
    abi: [
      ...ERC20_ABI,
      {
        type: "function",
        name: "deposit",
        inputs: [],
        outputs: [],
        stateMutability: "payable",
      },
    ],
    readExecutor: async () => "0x0",
    writeExecutor: async () => "{}",
  });
  const flags = (name: string) => {
    const t = tools.find((tool) => tool.name === name);
    if (t === undefined) throw new Error(`${name} not generated`);
    return {
      scope: t.scope,
      ioCapability: t.ioCapability,
      requireJustification: t.requireJustification,
      destructive: t.destructive,
      readOnly: t.readOnly,
    };
  };

  test("a view read is an eth_call over the network, as EvmCall is", () => {
    expect(flags("usdc__balanceOf")).toEqual({
      scope: "external",
      ioCapability: "network",
      requireJustification: false,
      destructive: false,
      readOnly: true,
    });
  });

  test("nonpayable and payable writes carry EvmSendTransaction's flags", () => {
    // EvmSendTransaction (tool-evm-tx) is destructive, external, network and
    // justification-gated; a generated write signs through the same engine.
    const send = {
      scope: "external",
      ioCapability: "network",
      requireJustification: true,
      destructive: true,
      readOnly: false,
    };
    expect(flags("usdc__transfer")).toEqual(send);
    expect(flags("usdc__deposit")).toEqual(send);
  });

  test("the flags stay those of EvmCall and EvmSendTransaction, the tools they stand in for", () => {
    // Read from the tools themselves, not restated: if either builtin's flags
    // move, the generated tools must move with them.
    const of = (t: {
      scope?: string;
      ioCapability?: string;
      requireJustification?: boolean;
      destructive?: boolean;
      readOnly?: boolean;
    }) => ({
      scope: t.scope,
      ioCapability: t.ioCapability,
      requireJustification: t.requireJustification,
      destructive: t.destructive,
      readOnly: t.readOnly,
    });
    expect(flags("usdc__balanceOf")).toEqual(of(evmCall));
    expect(flags("usdc__transfer")).toEqual(of(evmSendTransaction));
    expect(flags("usdc__deposit")).toEqual(of(evmSendTransaction));
  });

  test("the strict scope audit has nothing to report", () => {
    expect(auditToolScopes(tools)).toEqual([]);
    // The audit reads the flags: a network tool left internal is reported.
    const internal = tools.map((t) => ({ ...t, scope: "internal" as const }));
    expect(auditToolScopes(internal).length).toBe(tools.length);
  });
});

describe("an ABI either becomes tools that each mean one thing, or is refused (C197)", () => {
  const SAFE_TRANSFER_3 = {
    type: "function",
    name: "safeTransferFrom",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  } as const;
  const SAFE_TRANSFER_4 = {
    ...SAFE_TRANSFER_3,
    inputs: [...SAFE_TRANSFER_3.inputs, { name: "data", type: "bytes" }],
  } as const;
  const NFT = { id: "nft", chainId: "1", address: "0xnft" };

  function recordingWrites(): {
    calls: Array<Parameters<WriteExecutor>[0]>;
    writeExecutor: WriteExecutor;
  } {
    const calls: Array<Parameters<WriteExecutor>[0]> = [];
    return {
      calls,
      writeExecutor: async (args) => {
        calls.push(args);
        return "{}";
      },
    };
  }

  test("ERC-721's two safeTransferFrom overloads are two tools, each naming its overload", async () => {
    const { calls, writeExecutor } = recordingWrites();
    const tools = generateContractTools({
      contract: NFT,
      abi: [SAFE_TRANSFER_3, SAFE_TRANSFER_4],
      readExecutor: async () => "0x",
      writeExecutor,
    });
    const three = canonicalFunction("safeTransferFrom(address,address,uint256)");
    const four = canonicalFunction("safeTransferFrom(address,address,uint256,bytes)");
    // The selectors every explorer shows for these two.
    expect([three.selector, four.selector]).toEqual(["0x42842e0e", "0xb88d4fde"]);
    expect(tools.map((t) => t.name)).toEqual([
      "nft__safeTransferFrom_42842e0e",
      "nft__safeTransferFrom_b88d4fde",
    ]);
    // 0.7.0 named both nft__safeTransferFrom, and the second registration threw.
    const catalog = new ToolCatalog();
    for (const t of tools) catalog.register(t);

    await tools[1]?.execute({ walletId: "w", from: "0xa", to: "0xb", tokenId: "1", data: "0x" });
    expect(calls.at(-1)).toMatchObject({
      methodName: "safeTransferFrom",
      signature: "safeTransferFrom(address,address,uint256,bytes)",
      selector: "0xb88d4fde",
      inputs: ["0xa", "0xb", "1", "0x"],
    });
    expect(tools[1]?.description).toContain(
      "the overload safeTransferFrom(address,address,uint256,bytes)",
    );
  });

  test("a name the ABI declares once keeps its plain tool name, and reads get the signature too", async () => {
    const seen: Array<{ signature: string; selector: string }> = [];
    const tools = generateContractTools({
      contract: CONTRACT,
      abi: ERC20_ABI,
      readExecutor: async (args) => {
        seen.push({ signature: args.signature, selector: args.selector });
        return "0x";
      },
      writeExecutor: async () => "{}",
    });
    expect(tools.map((t) => t.name)).toEqual([
      "usdc__balanceOf",
      "usdc__allowance",
      "usdc__transfer",
      "usdc__approve",
    ]);
    await tools[0]?.execute({ owner: "0xo" });
    expect(seen).toEqual([{ signature: "balanceOf(address)", selector: "0x70a08231" }]);
  });

  test("a nonpayable input named value is an ABI argument, never native value", async () => {
    // OpenZeppelin v5's ERC-20: transfer(address to, uint256 value).
    const { calls, writeExecutor } = recordingWrites();
    const [transfer] = generateContractTools({
      contract: CONTRACT,
      abi: [
        {
          type: "function",
          name: "transfer",
          inputs: [
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
          stateMutability: "nonpayable",
        },
      ],
      readExecutor: async () => "0x",
      writeExecutor,
    });
    await transfer?.execute({ walletId: "w", to: "0xr", value: "1000" });
    expect(calls.at(-1)?.inputs).toEqual(["0xr", "1000"]);
    // 0.7.0 also sent "1000" as the transaction's native value.
    expect(calls.at(-1) !== undefined && "value" in (calls.at(-1) as object)).toBe(false);
  });

  test("an input a write tool already uses for its own field is refused at generation", () => {
    const refuse = (item: AbiItem) => () =>
      generateContractTools({
        contract: CONTRACT,
        abi: [item],
        readExecutor: async () => "0x",
        writeExecutor: async () => "{}",
      });
    expect(
      refuse({
        type: "function",
        name: "buy",
        inputs: [{ name: "value", type: "uint256" }],
        outputs: [],
        stateMutability: "payable",
      }),
    ).toThrow(
      'usdc: buy(uint256): input 0 is named "value", which the generated write tool already takes as the native-token amount to send',
    );
    expect(
      refuse({
        type: "function",
        name: "bind",
        inputs: [{ name: "walletId", type: "bytes32" }],
        outputs: [],
        stateMutability: "nonpayable",
      }),
    ).toThrow(
      /input 0 is named "walletId", which the generated write tool already takes as the signing wallet's id/,
    );
    // A view function has no injected fields, so the same names are fine there.
    expect(
      refuse({
        type: "function",
        name: "quote",
        inputs: [{ name: "value", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
      })(),
    ).toHaveLength(1);
  });

  test("an unnamed input and an input named for its position do not share a key", () => {
    expect(() =>
      generateContractTools({
        contract: CONTRACT,
        abi: [
          {
            type: "function",
            name: "f",
            inputs: [
              { name: "arg1", type: "uint256" },
              { name: "", type: "uint256" },
            ],
            outputs: [],
            stateMutability: "view",
          },
        ],
        readExecutor: async () => "0x",
        writeExecutor: async () => "{}",
      }),
    ).toThrow(
      new ContractToolError(
        'usdc: f(uint256,uint256): inputs 0 and 1 would both be read from the key "arg1"',
      ),
    );
  });

  test("the same function listed twice, or a type no encoder knows, is refused by name", () => {
    const generate = (abi: ReadonlyArray<AbiItem>) => () =>
      generateContractTools({
        contract: NFT,
        abi,
        readExecutor: async () => "0x",
        writeExecutor: async () => "{}",
      });
    expect(generate([SAFE_TRANSFER_3, SAFE_TRANSFER_3])).toThrow(
      /the ABI lists the same function twice/,
    );
    expect(
      generate([
        {
          type: "function",
          name: "g",
          inputs: [{ name: "x", type: "widget" }],
          outputs: [],
          stateMutability: "view",
        },
      ]),
    ).toThrow(/nft: the ABI's function g\(widget\) cannot be encoded/);
  });

  test("a tuple input is written out as its components in the signature", async () => {
    const { calls, writeExecutor } = recordingWrites();
    const [tool] = generateContractTools({
      contract: CONTRACT,
      abi: [
        {
          type: "function",
          name: "settle",
          inputs: [
            {
              name: "orders",
              type: "tuple[]",
              components: [
                { name: "maker", type: "address" },
                { name: "amount", type: "uint" },
              ],
            },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
      ],
      readExecutor: async () => "0x",
      writeExecutor,
    });
    await tool?.execute({ walletId: "w", orders: [] });
    expect(calls.at(-1)?.signature).toBe("settle((address,uint256)[])");
  });
});
