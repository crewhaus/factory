import { describe, expect, test } from "bun:test";
import type { ChainAdapter } from "@crewhaus/chain-adapter-base";
import { TokenGatedError, resolveTokenGated, resolveTokenGatedRules } from "./index";

function fakeAdapter(handler: (params: ReadonlyArray<unknown>) => unknown): ChainAdapter {
  return {
    chainId: "base-mainnet",
    config: {
      chainId: "base-mainnet",
      rpcUrls: ["https://stub.test"],
      rpcPolicy: "single",
      finality: { kind: "finalized" },
      reorgTolerant: true,
    },
    async rpcRead(method, params) {
      if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
      return handler(params);
    },
  };
}

/** Encode a uint256 as a right-padded 32-byte hex (returns 0x...). */
function pad32hex(n: bigint): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** Encode an address as a 32-byte hex (left-pad zeros). */
function addressTo32(addr: string): string {
  const stripped = addr.startsWith("0x") ? addr.slice(2) : addr;
  return `0x${stripped.toLowerCase().padStart(64, "0")}`;
}

describe("resolveTokenGated — balanceOf", () => {
  test("emits alwaysAllow when balance >= minBalanceWei", async () => {
    const adapter = fakeAdapter(() => pad32hex(2_000_000n));
    const rules = await resolveTokenGated(
      {
        allowTools: ["EvmCall", "EvmGetLogs"],
        chainId: "base-mainnet",
        contractAddress: "0xusdc",
        walletAddress: "0xowner",
        requirement: { kind: "balanceOf", minBalanceWei: "1000000" },
      },
      adapter,
    );
    expect(rules).toHaveLength(2);
    expect(rules.every((r) => r.type === "alwaysAllow")).toBe(true);
    expect(rules.map((r) => r.pattern)).toEqual(["EvmCall", "EvmGetLogs"]);
  });

  test("emits alwaysDeny when balance < minBalanceWei", async () => {
    const adapter = fakeAdapter(() => pad32hex(500_000n));
    const rules = await resolveTokenGated(
      {
        allowTools: ["EvmCall"],
        chainId: "base-mainnet",
        contractAddress: "0xusdc",
        walletAddress: "0xowner",
        requirement: { kind: "balanceOf", minBalanceWei: "1000000" },
      },
      adapter,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]?.type).toBe("alwaysDeny");
  });
});

describe("resolveTokenGated — ownerOf", () => {
  test("alwaysAllow when ownerOf returns the wallet address", async () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    const adapter = fakeAdapter(() => addressTo32(wallet));
    const rules = await resolveTokenGated(
      {
        allowTools: ["EvmCall"],
        chainId: "base-mainnet",
        contractAddress: "0xnft",
        walletAddress: wallet,
        requirement: { kind: "ownerOf", tokenId: "42" },
      },
      adapter,
    );
    expect(rules[0]?.type).toBe("alwaysAllow");
  });

  test("alwaysDeny when ownerOf returns a different address", async () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    const adapter = fakeAdapter(() => addressTo32("0xdead000000000000000000000000000000000000"));
    const rules = await resolveTokenGated(
      {
        allowTools: ["EvmCall"],
        chainId: "base-mainnet",
        contractAddress: "0xnft",
        walletAddress: wallet,
        requirement: { kind: "ownerOf", tokenId: "42" },
      },
      adapter,
    );
    expect(rules[0]?.type).toBe("alwaysDeny");
  });

  test("alwaysDeny when ownerOf reverts (non-existent token)", async () => {
    const adapter: ChainAdapter = {
      chainId: "base-mainnet",
      config: {
        chainId: "base-mainnet",
        rpcUrls: ["https://stub.test"],
        rpcPolicy: "single",
        finality: { kind: "finalized" },
        reorgTolerant: true,
      },
      async rpcRead() {
        throw new Error("execution reverted: ERC721NonexistentToken");
      },
    };
    const rules = await resolveTokenGated(
      {
        allowTools: ["EvmCall"],
        chainId: "base-mainnet",
        contractAddress: "0xnft",
        walletAddress: "0xowner",
        requirement: { kind: "ownerOf", tokenId: "9999" },
      },
      adapter,
    );
    expect(rules[0]?.type).toBe("alwaysDeny");
  });
});

describe("resolveTokenGated — hasAny", () => {
  test("alwaysAllow when balance > 0", async () => {
    const adapter = fakeAdapter(() => pad32hex(1n));
    const rules = await resolveTokenGated(
      {
        allowTools: ["EvmCall"],
        chainId: "base-mainnet",
        contractAddress: "0xnft",
        walletAddress: "0xowner",
        requirement: { kind: "hasAny" },
      },
      adapter,
    );
    expect(rules[0]?.type).toBe("alwaysAllow");
  });

  test("alwaysDeny when balance == 0", async () => {
    const adapter = fakeAdapter(() => pad32hex(0n));
    const rules = await resolveTokenGated(
      {
        allowTools: ["EvmCall"],
        chainId: "base-mainnet",
        contractAddress: "0xnft",
        walletAddress: "0xowner",
        requirement: { kind: "hasAny" },
      },
      adapter,
    );
    expect(rules[0]?.type).toBe("alwaysDeny");
  });
});

describe("resolveTokenGated — validation", () => {
  test("rejects empty allowTools", async () => {
    const adapter = fakeAdapter(() => pad32hex(0n));
    await expect(
      resolveTokenGated(
        {
          allowTools: [],
          chainId: "base-mainnet",
          contractAddress: "0xusdc",
          walletAddress: "0xowner",
          requirement: { kind: "hasAny" },
        },
        adapter,
      ),
    ).rejects.toThrow(TokenGatedError);
  });

  test("rejects adapter/spec chainId mismatch", async () => {
    const adapter = fakeAdapter(() => pad32hex(1n));
    await expect(
      resolveTokenGated(
        {
          allowTools: ["EvmCall"],
          chainId: "polygon-mainnet",
          contractAddress: "0xusdc",
          walletAddress: "0xowner",
          requirement: { kind: "hasAny" },
        },
        adapter,
      ),
    ).rejects.toThrow(/chainId/);
  });
});

describe("resolveTokenGatedRules — batched", () => {
  test("resolves multiple directives against per-chain adapters", async () => {
    const adapterBase = fakeAdapter(() => pad32hex(2n));
    const adapterPolygon: ChainAdapter = {
      chainId: "polygon-mainnet",
      config: {
        chainId: "polygon-mainnet",
        rpcUrls: ["https://stub.test"],
        rpcPolicy: "single",
        finality: { kind: "finalized" },
        reorgTolerant: true,
      },
      async rpcRead() {
        return pad32hex(0n);
      },
    };
    const rules = await resolveTokenGatedRules(
      [
        {
          allowTools: ["EvmCall"],
          chainId: "base-mainnet",
          contractAddress: "0xusdc",
          walletAddress: "0xa",
          requirement: { kind: "hasAny" },
        },
        {
          allowTools: ["EvmGetLogs"],
          chainId: "polygon-mainnet",
          contractAddress: "0xmatic",
          walletAddress: "0xa",
          requirement: { kind: "hasAny" },
        },
      ],
      (chainId) =>
        chainId === "base-mainnet"
          ? adapterBase
          : chainId === "polygon-mainnet"
            ? adapterPolygon
            : undefined,
    );
    expect(rules).toHaveLength(2);
    expect(rules.find((r) => r.pattern === "EvmCall")?.type).toBe("alwaysAllow");
    expect(rules.find((r) => r.pattern === "EvmGetLogs")?.type).toBe("alwaysDeny");
  });

  test("throws fail-closed when no adapter is registered for a directive", async () => {
    await expect(
      resolveTokenGatedRules(
        [
          {
            allowTools: ["EvmCall"],
            chainId: "unknown-chain",
            contractAddress: "0xusdc",
            walletAddress: "0xa",
            requirement: { kind: "hasAny" },
          },
        ],
        () => undefined,
      ),
    ).rejects.toThrow(/no chain adapter registered/);
  });
});
