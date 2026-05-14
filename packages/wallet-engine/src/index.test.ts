import { afterEach, describe, expect, test } from "bun:test";
import { clearBoundaryCache } from "@crewhaus/boundary-classifier";
import type { ChainAdapter } from "@crewhaus/chain-adapter-base";
import {
  type TransactionPolicy,
  type UnsignedTx,
  type WalletConfig,
  WalletEngineError,
  createLocalSignerStub,
  createWalletEngine,
} from "./index";

afterEach(() => clearBoundaryCache());

function fakeAdapter(
  handler: (method: string, params: ReadonlyArray<unknown>) => unknown,
): ChainAdapter {
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
      return handler(method, params);
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

const TX_OK: UnsignedTx = {
  chainId: "test-chain",
  walletId: "treasury",
  contractId: "usdc",
  to: "0xusdc",
  data: "0xa9059cbb000000",
};

describe("createWalletEngine — happy path", () => {
  test("simulates, prompts approval, signs, fetches receipt", async () => {
    let approvalCalls = 0;
    const we = createWalletEngine({
      resolveAdapter: () =>
        fakeAdapter((method) => {
          if (method === "eth_call") return "0x";
          if (method === "eth_estimateGas") return "0x5208";
          if (method === "eth_getTransactionReceipt") {
            return { blockNumber: "0x100", status: "0x1" };
          }
          return null;
        }),
      approve: async () => {
        approvalCalls += 1;
        return "allow";
      },
    });
    we.registerCustody(createLocalSignerStub());

    const receipt = await we.requestSignAndBroadcast({
      tx: TX_OK,
      policy: POLICY,
      wallet: WALLET,
    });

    expect(approvalCalls).toBe(1);
    expect(receipt.status).toBe("0x1");
    expect(receipt.blockNumber).toBe("0x100");
    expect(receipt.txHash.startsWith("0x")).toBe(true);
    expect(receipt.boundary.origin).toBe("chain");
  });
});

describe("createWalletEngine — policy enforcement", () => {
  test("rejects when contractId is missing and allowedContracts is non-empty", async () => {
    const we = createWalletEngine({
      resolveAdapter: () => fakeAdapter(() => "0x"),
      approve: async () => "allow",
    });
    we.registerCustody(createLocalSignerStub());
    const tx: UnsignedTx = { chainId: "test-chain", walletId: "treasury", to: "0xraw", data: "0x" };
    await expect(
      we.requestSignAndBroadcast({ tx, policy: POLICY, wallet: WALLET }),
    ).rejects.toThrow(WalletEngineError);
  });

  test("rejects when contractId is not in allowedContracts", async () => {
    const we = createWalletEngine({
      resolveAdapter: () => fakeAdapter(() => "0x"),
      approve: async () => "allow",
    });
    we.registerCustody(createLocalSignerStub());
    const tx: UnsignedTx = { ...TX_OK, contractId: "uniswap-router" };
    await expect(
      we.requestSignAndBroadcast({ tx, policy: POLICY, wallet: WALLET }),
    ).rejects.toThrow(/uniswap-router/);
  });

  test("rejects approval='none' with non-automated wallet", async () => {
    const we = createWalletEngine({
      resolveAdapter: () => fakeAdapter(() => "0x"),
      approve: async () => "allow",
    });
    we.registerCustody(createLocalSignerStub());
    await expect(
      we.requestSignAndBroadcast({
        tx: TX_OK,
        policy: { ...POLICY, defaultWriteApproval: "none", simulationRequired: false },
        wallet: WALLET,
      }),
    ).rejects.toThrow(/automated/);
  });
});

describe("createWalletEngine — simulation gate", () => {
  test("aborts on failed simulation when simulationRequired", async () => {
    const we = createWalletEngine({
      resolveAdapter: () =>
        fakeAdapter((method) => {
          if (method === "eth_call") throw new Error("execution reverted: insufficient balance");
          return "0x";
        }),
      approve: async () => "allow",
    });
    we.registerCustody(createLocalSignerStub());
    await expect(
      we.requestSignAndBroadcast({ tx: TX_OK, policy: POLICY, wallet: WALLET }),
    ).rejects.toThrow(/simulation failed/);
  });

  test("skips simulation when simulationRequired is false", async () => {
    const simCalls: string[] = [];
    const we = createWalletEngine({
      resolveAdapter: () =>
        fakeAdapter((method) => {
          simCalls.push(method);
          if (method === "eth_getTransactionReceipt")
            return { blockNumber: "0x100", status: "0x1" };
          return "0x";
        }),
      approve: async () => "allow",
    });
    we.registerCustody(createLocalSignerStub());
    await we.requestSignAndBroadcast({
      tx: TX_OK,
      policy: { ...POLICY, simulationRequired: false },
      wallet: WALLET,
    });
    expect(simCalls.includes("eth_call")).toBe(false);
    expect(simCalls.includes("eth_estimateGas")).toBe(false);
    expect(simCalls.includes("eth_getTransactionReceipt")).toBe(true);
  });
});

describe("createWalletEngine — approval gate", () => {
  test("denied approval blocks broadcast", async () => {
    let signedCalls = 0;
    const we = createWalletEngine({
      resolveAdapter: () => fakeAdapter(() => "0x"),
      approve: async () => "deny",
    });
    we.registerCustody({
      custody: "local",
      async signAndBroadcast() {
        signedCalls += 1;
        return "0xfake";
      },
    });
    await expect(
      we.requestSignAndBroadcast({
        tx: TX_OK,
        policy: { ...POLICY, simulationRequired: false },
        wallet: WALLET,
      }),
    ).rejects.toThrow(/approval denied/);
    expect(signedCalls).toBe(0);
  });

  test("automated signing skips the approval resolver", async () => {
    let approvalCalls = 0;
    const we = createWalletEngine({
      resolveAdapter: () =>
        fakeAdapter((method) =>
          method === "eth_getTransactionReceipt" ? { blockNumber: "0x100", status: "0x1" } : "0x",
        ),
      approve: async () => {
        approvalCalls += 1;
        return "allow";
      },
    });
    we.registerCustody(createLocalSignerStub());
    await we.requestSignAndBroadcast({
      tx: TX_OK,
      policy: { ...POLICY, defaultWriteApproval: "policy", simulationRequired: false },
      wallet: { ...WALLET, signingPolicy: "automated" },
    });
    expect(approvalCalls).toBe(0);
  });
});

describe("createWalletEngine — missing wiring", () => {
  test("throws when no adapter for chainId", async () => {
    const we = createWalletEngine({
      resolveAdapter: () => undefined,
      approve: async () => "allow",
    });
    we.registerCustody(createLocalSignerStub());
    await expect(
      we.requestSignAndBroadcast({ tx: TX_OK, policy: POLICY, wallet: WALLET }),
    ).rejects.toThrow(/no chain adapter registered/);
  });

  test("throws when no custody provider for wallet.custody", async () => {
    const we = createWalletEngine({
      resolveAdapter: () => fakeAdapter(() => "0x"),
      approve: async () => "allow",
    });
    // Note: no registerCustody() call.
    await expect(
      we.requestSignAndBroadcast({
        tx: TX_OK,
        policy: { ...POLICY, simulationRequired: false },
        wallet: WALLET,
      }),
    ).rejects.toThrow(/no CustodyProvider registered/);
  });
});
