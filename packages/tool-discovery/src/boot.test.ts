import { afterEach, describe, expect, test } from "bun:test";
import { _resetPeerPolicy, getPeerPolicy, registerDiscoveryConfig } from "./index";

afterEach(() => _resetPeerPolicy());

describe("registerDiscoveryConfig — tool_config.federationDiscover at boot", () => {
  test("allowed_origins becomes the only peer origins; an empty list dials nothing", () => {
    registerDiscoveryConfig({ allowed_origins: ["https://Peer.Example/.well-known/x"] });
    expect(getPeerPolicy()).toEqual({ allowedOrigins: ["https://peer.example"] });
    registerDiscoveryConfig({ allowed_origins: [] });
    expect(getPeerPolicy()).toEqual({ allowedOrigins: [] });
  });

  test("a spec cannot open loopback or the private ranges", () => {
    expect(() => registerDiscoveryConfig({ allow_private_hosts: true } as never)).toThrow(
      "tool_config.federationDiscover.allow_private_hosts is not accepted",
    );
  });

  test("an entry that is not an origin is refused with the form to write", () => {
    expect(() => registerDiscoveryConfig({ allowed_origins: ["peer.example"] })).toThrow(
      'has "peer.example", which is not an origin. Write it as https://host[:port]',
    );
    expect(() => registerDiscoveryConfig({ allowed_origins: ["ftp://peer.example"] })).toThrow(
      'has "ftp://peer.example", which is not http(s)',
    );
  });
});
