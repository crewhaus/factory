import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { ChainAdapter } from "@crewhaus/chain-adapter-base";
import { _setRpc, bindChainCallChains } from "./index";
import { chainRpcFromAdapter, resolveRpc } from "./lib/rpc";

let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = (await req.json()) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x7" });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
afterEach(() => _setRpc(undefined));

test("bound from the spec's chains block, each declared chain gets its transport", async () => {
  bindChainCallChains({
    chains: [
      {
        chainId: "8453",
        rpcUrls: [origin],
        rpcPolicy: "single",
        finality: { kind: "finalized" },
        reorgTolerant: true,
      },
    ],
  });
  expect(await resolveRpc("8453", "GasMarketRead")("eth_blockNumber", [])).toBe("0x7");
  expect(() => resolveRpc("1", "GasMarketRead")).toThrow(
    'no chain is configured for chainId "1" — declare it in spec.chains[]',
  );
});

test("the adapter seam passes the call's signal down, so a cancel reaches the request (C041)", async () => {
  const seen: unknown[] = [];
  const adapter: ChainAdapter = {
    chainId: "1",
    config: {
      chainId: "1",
      rpcUrls: [origin],
      rpcPolicy: "single",
      finality: { kind: "finalized" },
      reorgTolerant: true,
    },
    rpcRead: async (_method, _params, opts) => {
      seen.push(opts);
      return "0x1";
    },
  };
  const { signal } = new AbortController();
  await chainRpcFromAdapter(adapter)("eth_blockNumber", [], { signal });
  expect(seen).toEqual([{ signal }]);
});
