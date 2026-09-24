import { afterEach, describe, expect, test } from "bun:test";
import { getRpcEndpointPolicy, registerChainreadConfig, setRpcEndpointPolicy } from "./index";

afterEach(() => setRpcEndpointPolicy({}));

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
});
