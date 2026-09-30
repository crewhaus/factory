import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bindEvmTxChains, evmSendTransaction, evmSimulate } from "./index";

let server: ReturnType<typeof Bun.serve>;
let origin = "";
const TO = "0x00000000000000000000000000000000000000c0";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = (await req.json()) as { id: number; method: string };
      const result =
        body.method === "eth_call" ? "0x2a" : body.method === "eth_estimateGas" ? "0x5208" : null;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

function bind(): void {
  bindEvmTxChains({
    chains: [
      {
        chainId: "1",
        rpcUrls: [origin],
        rpcPolicy: "single",
        finality: { kind: "finalized" },
        reorgTolerant: true,
      },
    ],
    wallets: [
      {
        id: "ops",
        chainId: "1",
        custody: "user-controlled",
        signingPolicy: "explicit-user-approval",
      },
    ],
    contracts: [{ id: "vault", address: TO }],
    transactionPolicy: {
      defaultWriteApproval: "required",
      allowedContracts: ["vault"],
      simulationRequired: false,
    },
  });
}

describe("bindEvmTxChains — the three resolvers from the chain blocks", () => {
  test("EvmSimulate runs against the declared chain as the declared wallet", async () => {
    bind();
    const out = JSON.parse(await evmSimulate.execute({ walletId: "ops", to: TO, data: "0x" }));
    expect(out).toMatchObject({ success: true, gasUsed: "0x5208", returnData: "0x2a" });
  });

  test("a wallet the spec does not declare is refused by name, with the block to write", async () => {
    bind();
    await expect(evmSimulate.execute({ walletId: "nope", to: TO, data: "0x" })).rejects.toThrow(
      'no wallet "nope" is declared. Add it to the spec\'s wallets block — wallets: [',
    );
  });

  test("nothing can be broadcast: the engine's own approval step denies", async () => {
    bind();
    await expect(
      evmSendTransaction.execute({ walletId: "ops", contractId: "vault", to: TO, data: "0x" }),
    ).rejects.toThrow("approval denied; transaction not broadcast");
  });
});
