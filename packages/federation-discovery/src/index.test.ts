import { describe, expect, test } from "bun:test";

import {
  FederationDiscoveryError,
  type PeerRecord,
  type SrvResolver,
  type WellKnownFetcher,
  createDiscovery,
  discoverDeployment,
} from "./index";

const HEX64 = "a".repeat(64);

const goodPayload = {
  endpoint: "https://federation.deployment-b.example",
  version: "crewhaus.federation.v1",
  supportedShapes: ["cli", "crew"],
  publicKeyFingerprint: HEX64,
};

function fetcherReturning(payload: unknown, status = 200): WellKnownFetcher {
  return async () => ({ status, body: JSON.stringify(payload) });
}

describe("createDiscovery — happy path (T2)", () => {
  test("falls back to .well-known when no SRV configured", async () => {
    const d = createDiscovery({ wellKnownFetcher: fetcherReturning(goodPayload) });
    const rec = await d.discover("deployment-b.example");
    expect(rec.endpoint).toBe("https://federation.deployment-b.example");
    expect(rec.version).toBe("crewhaus.federation.v1");
    expect(rec.supportedShapes).toEqual(["cli", "crew"]);
    expect(rec.publicKeyFingerprint).toBe(HEX64);
  });

  test("SRV-then-.well-known: SRV returns target, then well-known is fetched against that endpoint", async () => {
    const srv: SrvResolver = async () => ({
      records: [{ priority: 10, weight: 5, port: 8443, name: "fed.deployment-b.example" }],
      ttl: 60,
    });
    const seenUrls: string[] = [];
    const fetcher: WellKnownFetcher = async (url) => {
      seenUrls.push(url);
      return { status: 200, body: JSON.stringify(goodPayload) };
    };
    const d = createDiscovery({
      srvDomain: "internal.crewhaus",
      srvResolver: srv,
      wellKnownFetcher: fetcher,
    });
    const rec = await d.discover("deployment-b");
    expect(seenUrls[0]).toBe("https://fed.deployment-b.example:8443/.well-known/crewhaus.json");
    // SRV is the source of truth for the endpoint, so the discovered
    // record's endpoint is the SRV-derived URL, not the well-known body's.
    expect(rec.endpoint).toBe("https://fed.deployment-b.example:8443");
    expect(rec.publicKeyFingerprint).toBe(HEX64);
  });

  test("SRV miss → falls through to direct .well-known fetch", async () => {
    const srv: SrvResolver = async () => {
      throw new Error("ENOTFOUND");
    };
    const d = createDiscovery({
      srvDomain: "internal.crewhaus",
      srvResolver: srv,
      wellKnownFetcher: fetcherReturning(goodPayload),
    });
    const rec = await d.discover("deployment-b.example");
    expect(rec.endpoint).toBe(goodPayload.endpoint);
  });
});

describe("createDiscovery — failure modes (T8)", () => {
  test("rejects malformed deployment id", async () => {
    const d = createDiscovery({ wellKnownFetcher: fetcherReturning(goodPayload) });
    await expect(d.discover("../bad")).rejects.toThrow(/invalid deployment id/);
    await expect(d.discover("")).rejects.toThrow(/non-empty/);
  });

  test("rejects non-200 .well-known", async () => {
    const d = createDiscovery({
      wellKnownFetcher: async () => ({ status: 503, body: "" }),
    });
    await expect(d.discover("deployment-b.example")).rejects.toThrow(/returned 503/);
  });

  test("rejects malformed JSON", async () => {
    const d = createDiscovery({
      wellKnownFetcher: async () => ({ status: 200, body: "not json{" }),
    });
    await expect(d.discover("deployment-b.example")).rejects.toThrow(/invalid JSON/);
  });

  test("rejects http:// endpoint (https only)", async () => {
    const d = createDiscovery({
      wellKnownFetcher: fetcherReturning({
        ...goodPayload,
        endpoint: "http://insecure.example",
      }),
    });
    await expect(d.discover("deployment-b.example")).rejects.toThrow(/must be https/);
  });

  test("rejects malformed publicKeyFingerprint", async () => {
    const d = createDiscovery({
      wellKnownFetcher: fetcherReturning({
        ...goodPayload,
        publicKeyFingerprint: "abc",
      }),
    });
    await expect(d.discover("deployment-b.example")).rejects.toThrow(
      /publicKeyFingerprint must be 64-char hex/,
    );
  });

  test("rejects record missing endpoint+version", async () => {
    const d = createDiscovery({
      wellKnownFetcher: fetcherReturning({ publicKeyFingerprint: HEX64 }),
    });
    await expect(d.discover("deployment-b.example")).rejects.toThrow(
      /endpoint\+version are required/,
    );
  });
});

describe("createDiscovery — caching (T9 property-style)", () => {
  test("hits the cache before TTL expiry", async () => {
    let calls = 0;
    const fetcher: WellKnownFetcher = async () => {
      calls++;
      return { status: 200, body: JSON.stringify(goodPayload) };
    };
    const d = createDiscovery({ wellKnownFetcher: fetcher });
    await d.discover("deployment-b.example");
    await d.discover("deployment-b.example");
    await d.discover("deployment-b.example");
    expect(calls).toBe(1);
  });

  test("re-fetches after TTL expires", async () => {
    let now = 1000;
    let calls = 0;
    const fetcher: WellKnownFetcher = async () => {
      calls++;
      return { status: 200, body: JSON.stringify(goodPayload) };
    };
    const d = createDiscovery({ wellKnownFetcher: fetcher, now: () => now });
    await d.discover("deployment-b.example");
    expect(calls).toBe(1);
    now += 5_000;
    await d.discover("deployment-b.example");
    expect(calls).toBe(1); // still in TTL
    now += 60_000;
    await d.discover("deployment-b.example");
    expect(calls).toBe(2); // TTL expired
  });

  test("negative cache: failed lookup short-circuits within negativeTtlMs", async () => {
    let now = 0;
    let calls = 0;
    const fetcher: WellKnownFetcher = async () => {
      calls++;
      return { status: 503, body: "" };
    };
    const d = createDiscovery({
      wellKnownFetcher: fetcher,
      now: () => now,
      negativeTtlMs: 5_000,
    });
    await expect(d.discover("deployment-b.example")).rejects.toThrow();
    now += 1_000;
    await expect(d.discover("deployment-b.example")).rejects.toThrow(/cached negative/);
    expect(calls).toBe(1);
    now += 5_000;
    await expect(d.discover("deployment-b.example")).rejects.toThrow(/returned 503/);
    expect(calls).toBe(2);
  });

  test("reset() clears the cache", async () => {
    let calls = 0;
    const fetcher: WellKnownFetcher = async () => {
      calls++;
      return { status: 200, body: JSON.stringify(goodPayload) };
    };
    const d = createDiscovery({ wellKnownFetcher: fetcher });
    await d.discover("deployment-b.example");
    expect(calls).toBe(1);
    d.reset();
    await d.discover("deployment-b.example");
    expect(calls).toBe(2);
  });

  test("cacheStats reports current entries", async () => {
    const d = createDiscovery({ wellKnownFetcher: fetcherReturning(goodPayload) });
    await d.discover("deployment-b.example");
    await d.discover("deployment-c.example");
    expect(d.cacheStats().entries).toBe(2);
  });
});

describe("discoverDeployment top-level helper", () => {
  test("returns the resolved record", async () => {
    const rec: PeerRecord = await discoverDeployment("deployment-b.example", {
      wellKnownFetcher: fetcherReturning(goodPayload),
    });
    expect(rec).toEqual({
      endpoint: goodPayload.endpoint,
      version: "crewhaus.federation.v1",
      supportedShapes: goodPayload.supportedShapes,
      publicKeyFingerprint: HEX64,
    });
  });
});
