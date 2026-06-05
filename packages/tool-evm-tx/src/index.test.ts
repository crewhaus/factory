import { beforeEach, describe, expect, test } from "bun:test";
import type { ChainAdapter } from "@crewhaus/chain-adapter-base";
import {
  type TransactionPolicy,
  type WalletConfig,
  createLocalSignerStub,
  createWalletEngine,
} from "@crewhaus/wallet-engine";
import {
  EVM_TX_TOOL_MAP,
  setTransactionPolicyResolver,
  setWalletEngineResolver,
  setWalletResolver,
} from "./index";

function fakeAdapter(handler: (method: string) => unknown): ChainAdapter {
  return {
    chainId: "test-chain",
    config: {
      chainId: "test-chain",
      rpcUrls: ["https://stub.test"],
      rpcPolicy: "single",
      finality: { kind: "finalized" },
      reorgTolerant: true,
    },
    async rpcRead(method) {
      return handler(method);
    },
  };
}

const WALLET: WalletConfig = {
  id: "treasury",
  chainId: "test-chain",
  custody: "local",
  signingPolicy: "explicit-user-approval",
};

const POLICY: TransactionPolicy = {
  defaultWriteApproval: "required",
  allowedContracts: ["usdc"],
  simulationRequired: true,
};

beforeEach(() => {
  setWalletResolver(() => undefined);
  setTransactionPolicyResolver(() => undefined);
  setWalletEngineResolver(() => undefined);
});

describe("EvmSendTransaction & EvmSimulate — tool flags", () => {
  test("EvmSendTransaction is destructive and classifies output", () => {
    expect(EVM_TX_TOOL_MAP.evmSendTransaction.destructive).toBe(true);
    expect(EVM_TX_TOOL_MAP.evmSendTransaction.readOnly).toBe(false);
    expect(EVM_TX_TOOL_MAP.evmSendTransaction.classifyOutput).toBe(true);
  });
  test("EvmSimulate is readOnly", () => {
    expect(EVM_TX_TOOL_MAP.evmSimulate.readOnly).toBe(true);
    expect(EVM_TX_TOOL_MAP.evmSimulate.destructive).toBe(false);
  });
});

describe("EvmSendTransaction — happy path through wallet-engine", () => {
  test("broadcasts and returns the receipt", async () => {
    const engine = createWalletEngine({
      resolveAdapter: () =>
        fakeAdapter((method) => {
          if (method === "eth_call") return "0x";
          if (method === "eth_estimateGas") return "0x5208";
          if (method === "eth_getTransactionReceipt") {
            return { blockNumber: "0x100", status: "0x1" };
          }
          return null;
        }),
      approve: async () => "allow",
    });
    engine.registerCustody(createLocalSignerStub());
    setWalletResolver((id) => (id === "treasury" ? WALLET : undefined));
    setTransactionPolicyResolver(() => POLICY);
    setWalletEngineResolver(() => engine);

    const result = await EVM_TX_TOOL_MAP.evmSendTransaction.execute({
      walletId: "treasury",
      contractId: "usdc",
      to: "0xusdc",
      data: "0xa9059cbb000000",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe("0x1");
    expect(parsed.blockNumber).toBe("0x100");
    expect(typeof parsed.txHash).toBe("string");
  });

  test("rejects when contractId is not in allowedContracts", async () => {
    const engine = createWalletEngine({
      resolveAdapter: () => fakeAdapter(() => "0x"),
      approve: async () => "allow",
    });
    engine.registerCustody(createLocalSignerStub());
    setWalletResolver(() => WALLET);
    setTransactionPolicyResolver(() => POLICY);
    setWalletEngineResolver(() => engine);

    await expect(
      EVM_TX_TOOL_MAP.evmSendTransaction.execute({
        walletId: "treasury",
        contractId: "wrong-id",
        to: "0xother",
        data: "0xabcd",
      }),
    ).rejects.toThrow(/not in transaction_policy.allowedContracts/);
  });

  test("denied approval prevents broadcast", async () => {
    const engine = createWalletEngine({
      resolveAdapter: () => fakeAdapter(() => "0x"),
      approve: async () => "deny",
    });
    engine.registerCustody(createLocalSignerStub());
    setWalletResolver(() => WALLET);
    setTransactionPolicyResolver(() => ({ ...POLICY, simulationRequired: false }));
    setWalletEngineResolver(() => engine);

    await expect(
      EVM_TX_TOOL_MAP.evmSendTransaction.execute({
        walletId: "treasury",
        contractId: "usdc",
        to: "0xusdc",
        data: "0xabcd",
      }),
    ).rejects.toThrow(/approval denied/);
  });

  test("throws when wiring is missing", async () => {
    // beforeEach binds resolvers that return undefined — so we hit the
    // wallet-not-registered branch first.
    await expect(
      EVM_TX_TOOL_MAP.evmSendTransaction.execute({
        walletId: "treasury",
        to: "0xusdc",
        data: "0xabcd",
      }),
    ).rejects.toThrow(/no wallet registered for walletId/);
  });
});

describe("resolver-binding guards", () => {
  // These exercise the boot-time "resolver was never bound" branches, which
  // are distinct from a bound resolver returning undefined. The setters assign
  // the module-level resolver directly, so passing undefined clears them.
  test("throws when no WalletResolver is bound", async () => {
    setWalletResolver(undefined as unknown as (id: string) => undefined);
    await expect(
      EVM_TX_TOOL_MAP.evmSendTransaction.execute({
        walletId: "treasury",
        to: "0xusdc",
        data: "0xabcd",
      }),
    ).rejects.toThrow(/no WalletResolver bound/);
  });

  test("throws when no TransactionPolicyResolver is bound", async () => {
    // Wallet resolves OK so we get past requireWallet into requirePolicy.
    setWalletResolver(() => WALLET);
    setTransactionPolicyResolver(undefined as unknown as () => undefined);
    await expect(
      EVM_TX_TOOL_MAP.evmSendTransaction.execute({
        walletId: "treasury",
        to: "0xusdc",
        data: "0xabcd",
      }),
    ).rejects.toThrow(/no TransactionPolicyResolver bound/);
  });

  test("throws when the policy resolver returns undefined", async () => {
    setWalletResolver(() => WALLET);
    setTransactionPolicyResolver(() => undefined);
    await expect(
      EVM_TX_TOOL_MAP.evmSendTransaction.execute({
        walletId: "treasury",
        to: "0xusdc",
        data: "0xabcd",
      }),
    ).rejects.toThrow(/no transaction_policy declared/);
  });

  test("throws when no WalletEngineResolver is bound", async () => {
    // Wallet + policy resolve OK so we reach requireEngine's unbound branch.
    setWalletResolver(() => WALLET);
    setTransactionPolicyResolver(() => POLICY);
    setWalletEngineResolver(undefined as unknown as () => undefined);
    await expect(
      EVM_TX_TOOL_MAP.evmSendTransaction.execute({
        walletId: "treasury",
        contractId: "usdc",
        to: "0xusdc",
        data: "0xabcd",
      }),
    ).rejects.toThrow(/no WalletEngine bound/);
  });

  test("throws when the engine resolver returns undefined (EvmSimulate path)", async () => {
    // EvmSimulate calls requireWallet then requireEngine; a bound resolver
    // returning undefined exercises the `e === undefined` branch.
    setWalletResolver(() => WALLET);
    setWalletEngineResolver(() => undefined);
    await expect(
      EVM_TX_TOOL_MAP.evmSimulate.execute({
        walletId: "treasury",
        to: "0xusdc",
        data: "0xabcd",
      }),
    ).rejects.toThrow(/WalletEngine resolver returned undefined/);
  });
});

describe("EvmSimulate", () => {
  test("returns success+gasUsed without broadcasting", async () => {
    const engine = createWalletEngine({
      resolveAdapter: () =>
        fakeAdapter((method) => {
          if (method === "eth_call") return "0x42";
          if (method === "eth_estimateGas") return "0x5208";
          throw new Error(`unexpected method: ${method}`);
        }),
      approve: async () => {
        throw new Error("simulate must not request approval");
      },
    });
    setWalletResolver(() => WALLET);
    setWalletEngineResolver(() => engine);

    const out = await EVM_TX_TOOL_MAP.evmSimulate.execute({
      walletId: "treasury",
      to: "0xusdc",
      data: "0xabcd",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(true);
    expect(parsed.gasUsed).toBe("0x5208");
    expect(parsed.returnData).toBe("0x42");
  });

  test("returns success=false with revertReason on revert", async () => {
    const engine = createWalletEngine({
      resolveAdapter: () =>
        fakeAdapter((method) => {
          if (method === "eth_call") throw new Error("execution reverted: insufficient balance");
          return "0x";
        }),
      approve: async () => "allow",
    });
    setWalletResolver(() => WALLET);
    setWalletEngineResolver(() => engine);

    const out = await EVM_TX_TOOL_MAP.evmSimulate.execute({
      walletId: "treasury",
      to: "0xusdc",
      data: "0xabcd",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.revertReason).toContain("insufficient balance");
  });
});
