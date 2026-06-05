import { describe, expect, test } from "bun:test";
import { type AbiItem, generateContractTools } from "./index";

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
