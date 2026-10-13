import { afterAll, beforeAll, expect, test } from "bun:test";
import { bindEvmChains, evmBlockNumber } from "./index";

let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = (await req.json()) as { id: number; method: string };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x2a" });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

test("bound from the spec's chains block, a read tool reaches the declared chain", async () => {
  bindEvmChains({
    chains: [
      {
        chainId: "1",
        rpcUrls: [origin],
        rpcPolicy: "single",
        finality: { kind: "finalized" },
        reorgTolerant: true,
      },
    ],
  });
  expect(await evmBlockNumber.execute({ chainId: "1" })).toBe("0x2a");
  await expect(evmBlockNumber.execute({ chainId: "10" })).rejects.toThrow(
    'no chain adapter registered for chainId "10". Declare it in spec.chains[]',
  );
});
