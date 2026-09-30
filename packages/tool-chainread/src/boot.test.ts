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

  test("an entry that does not parse is named by position, never repeated (C157)", () => {
    // A keyed provider URL written without its scheme: the key is its path.
    let message = "";
    try {
      registerChainreadConfig({
        allowed_origins: [
          "https://mainnet.base.org",
          "eth-mainnet.g.alchemy.com/v2/SECRET-PROVIDER-KEY",
        ],
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(
      "tool_config.chainread.allowed_origins[1] is not an origin — it must start with https:// (or http://). Write it as https://host[:port]; the value is not repeated here, because a provider keeps its key in the path.",
    );
    expect(message).not.toContain("SECRET");
    expect(() =>
      registerChainreadConfig({ allowed_origins: ["https://exa mple.com/v2/SECRET"] }),
    ).toThrow(/allowed_origins\[0\] is not an origin — check the host and the port\./);
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

describe("a model-pool candidate's own tool_config block narrows the call (C029)", () => {
  // compile --strict accepted tool_config.<tool>.allowed_origins on a
  // model_pool candidate, and the runtime hands that block to the tool as
  // ctx.toolConfig — which these tools never read. A spec that set the list
  // only on a candidate got tools that dialled any public origin.
  const dialled: string[] = [];
  const stubNetwork = () => {
    dialled.length = 0;
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
    _setFetch(async (req) => {
      dialled.push(req.url);
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
    });
  };
  const block = (url: string, toolConfig: unknown) =>
    evmGetBlock.execute({ rpcUrl: url, block: "latest" } as never, { toolConfig } as never);

  test("with no boot list, the candidate's list is the list", async () => {
    stubNetwork();
    const ctx = { allowed_origins: ["https://mainnet.base.org"] };
    await expect(block("https://x.attacker.example/sk-live-5ecret", ctx)).rejects.toThrow(
      'refusing "https://x.attacker.example" — this model\'s rpc allow-list (its own tool_config block) is https://mainnet.base.org',
    );
    expect(dialled).toEqual([]);
    // The stub answers every method with "0x1", so the block read itself
    // fails after the request; what matters here is that it was dialled.
    await block("https://mainnet.base.org", ctx).catch(() => undefined);
    expect(dialled.every((u) => u.startsWith("https://mainnet.base.org"))).toBe(true);
    expect(dialled.length).toBeGreaterThan(0);
  });

  test("with a boot list, the candidate can only narrow it, never widen it", async () => {
    stubNetwork();
    registerChainreadConfig({ allowed_origins: ["https://mainnet.base.org"] });
    // An origin the boot list does not have stays refused, whatever the candidate says.
    await expect(
      block("https://other.example", { allowed_origins: ["https://other.example"] }),
    ).rejects.toThrow("the operator's rpc allow-list is https://mainnet.base.org");
    // And one the candidate leaves out is refused for that candidate.
    await expect(
      block("https://mainnet.base.org", { allowed_origins: ["https://other.example"] }),
    ).rejects.toThrow("this model's rpc allow-list");
    expect(dialled).toEqual([]);
  });

  test("a candidate block cannot open the private ranges, and a block without the list changes nothing", async () => {
    stubNetwork();
    await expect(block("https://mainnet.base.org", { allow_private_hosts: true })).rejects.toThrow(
      "a spec cannot open loopback or private addresses",
    );
    expect(dialled).toEqual([]);
    await block("https://mainnet.base.org", { timeoutMs: 5 }).catch(() => undefined);
    expect(dialled.length).toBeGreaterThan(0);
  });

  test("EvmRpcHealth reports the list the call ran under, and refuses the rest per endpoint", async () => {
    stubNetwork();
    const health = JSON.parse(
      (await evmRpcHealth.execute(
        {
          rpcUrl: "https://mainnet.base.org",
          compareWith: ["https://x.attacker.example/k"],
        } as never,
        { toolConfig: { allowed_origins: ["https://mainnet.base.org"] } } as never,
      )) as string,
    );
    expect(health.policy.modelAllowedOrigins).toEqual(["https://mainnet.base.org"]);
    expect(health.endpoints[1].errors[0]).toContain("this model's rpc allow-list");
    expect(dialled.some((u) => u.includes("attacker"))).toBe(false);
  });
});
