import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetPeerPolicy,
  _setDnsLookup,
  _setFetch,
  federationDiscover,
  getPeerPolicy,
  registerDiscoveryConfig,
} from "./index";

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

describe("a model-pool candidate's own tool_config block narrows the sweep (C029)", () => {
  // compile --strict accepted tool_config.federationDiscover on a model_pool
  // candidate, and the runtime handed it to the tool as ctx.toolConfig, which
  // FederationDiscover never read: a spec that set the list only on a
  // candidate dialled any public peer.
  const dialled: string[] = [];
  afterEach(() => {
    _setFetch(undefined);
    _setDnsLookup(undefined);
  });
  const sweep = async (peers: string[], toolConfig: unknown) => {
    dialled.length = 0;
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
    _setFetch(async (req) => {
      dialled.push(req.url);
      return new Response("{}", { status: 404 });
    });
    return JSON.parse(
      (await federationDiscover.execute(
        { peers, refresh: true } as never,
        {
          toolConfig,
        } as never,
      )) as string,
    );
  };

  test("a peer outside the candidate's list is refused and never dialled", async () => {
    const r = await sweep(["736b2d6c6976652d356563726574.attacker.example"], {
      allowed_origins: ["https://peer.example"],
    });
    expect(r.summary.refused).toBe(1);
    expect(r.posture.modelAllowList).toEqual(["https://peer.example"]);
    expect(dialled).toEqual([]);
    await sweep(["peer.example"], { allowed_origins: ["https://peer.example"] });
    expect(dialled.every((u) => u.startsWith("https://peer.example/"))).toBe(true);
    expect(dialled.length).toBeGreaterThan(0);
  });

  test("with a boot list, the candidate can only narrow it", async () => {
    registerDiscoveryConfig({ allowed_origins: ["https://peer.example"] });
    const widened = await sweep(["other.example"], { allowed_origins: ["https://other.example"] });
    expect(widened.summary.refused).toBe(1);
    expect(dialled).toEqual([]);
  });

  test("a candidate block that tries to open the private ranges refuses the sweep", async () => {
    const r = await sweep(["peer.example"], { allow_private_hosts: true });
    expect(r.status).toBe("refused");
    expect(r.reason).toContain("a spec cannot open loopback or private addresses");
    expect(dialled).toEqual([]);
  });
});
