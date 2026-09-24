import { afterEach, describe, expect, test } from "bun:test";
import {
  _setDnsLookup,
  _setFetch,
  evmGetBlock,
  evmRpcHealth,
  getRpcEndpointPolicy,
  registerChainreadConfig,
  setRpcEndpointPolicy,
} from "./index";

afterEach(() => {
  setRpcEndpointPolicy({});
  _setFetch(undefined);
  _setDnsLookup(undefined);
});

describe("registerChainreadConfig — tool_config.chainread at boot", () => {
  test("allowed_origins becomes the only RPC origins, canonicalised", () => {
    registerChainreadConfig({ allowed_origins: ["https://Mainnet.Base.org:443/path"] });
    expect(getRpcEndpointPolicy()).toEqual({ allowedOrigins: ["https://mainnet.base.org"] });
  });

  test("a block without the list leaves the default in place", () => {
    registerChainreadConfig({});
    expect(getRpcEndpointPolicy()).toEqual({});
  });

  test("a spec cannot open loopback or the private ranges", () => {
    for (const key of ["allow_private_hosts", "allowPrivateHosts"]) {
      expect(() => registerChainreadConfig({ [key]: true } as never)).toThrow(
        `tool_config.chainread.${key} is not accepted: a spec cannot open loopback or private addresses`,
      );
    }
    expect(getRpcEndpointPolicy().allowPrivateHosts).toBeUndefined();
  });

  test("two spellings of the list, or a list of the wrong shape, are refused", () => {
    expect(() =>
      registerChainreadConfig({ allowed_origins: ["https://a.example"], allowedOrigins: [] }),
    ).toThrow("Write the list once, as allowed_origins");
    expect(() =>
      registerChainreadConfig({ allowed_origins: "https://a.example" } as never),
    ).toThrow("must be a list of origins");
    expect(() => registerChainreadConfig({ allowed_origins: ["ftp://a.example"] })).toThrow(
      "which is not http(s)",
    );
  });

  test("through the tools, an origin the block does not list is never dialled (C029)", async () => {
    // 0.7.0 had the seam and no caller: every public origin a model named was
    // dialled by these read-only tools, which plan and auto mode run unasked.
    const dialled: string[] = [];
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
    _setFetch(async (req) => {
      dialled.push(req.url);
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
    });
    registerChainreadConfig({ allowed_origins: ["https://mainnet.base.org"] });
    const refusal =
      'refusing "https://x.attacker.example" — the operator\'s rpc allow-list is https://mainnet.base.org';
    const health = JSON.parse(
      (await evmRpcHealth.execute(
        { rpcUrl: "https://x.attacker.example/p" } as never,
        {} as never,
      )) as string,
    );
    expect(health.endpoints[0].errors).toEqual([refusal]);
    await expect(
      evmGetBlock.execute(
        { rpcUrl: "https://x.attacker.example/p", block: "latest" } as never,
        {} as never,
      ),
    ).rejects.toThrow(refusal);
    expect(dialled).toEqual([]);
    await evmRpcHealth.execute({ rpcUrl: "https://mainnet.base.org" } as never, {} as never);
    expect(dialled.length).toBeGreaterThan(0);
    expect(dialled.every((u) => u.startsWith("https://mainnet.base.org"))).toBe(true);
  });
});
