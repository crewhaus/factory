import { describe, expect, spyOn, test } from "bun:test";

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

describe("default fetcher (no injected wellKnownFetcher)", () => {
  test("uses globalThis.fetch with GET + Accept: application/json and parses the response", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(goodPayload), { status: 200 }),
    );
    try {
      const rec = await discoverDeployment("deployment-b.example");
      expect(rec.endpoint).toBe(goodPayload.endpoint);
      expect(rec.publicKeyFingerprint).toBe(HEX64);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://deployment-b.example/.well-known/crewhaus.json");
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>)["Accept"]).toBe("application/json");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("propagates a non-200 status from the real-fetch path as a FederationDiscoveryError", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 404 }),
    );
    try {
      await expect(discoverDeployment("deployment-b.example")).rejects.toThrow(/returned 404/);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("parsing branches", () => {
  test("accepts snake_case field aliases (supported_shapes / public_key_fingerprint)", async () => {
    const d = createDiscovery({
      wellKnownFetcher: fetcherReturning({
        endpoint: "https://snake.example",
        version: "crewhaus.federation.v1",
        supported_shapes: ["cli"],
        public_key_fingerprint: HEX64,
      }),
    });
    const rec = await d.discover("snake.example");
    expect(rec.supportedShapes).toEqual(["cli"]);
    expect(rec.publicKeyFingerprint).toBe(HEX64);
  });

  test("drops non-string entries from supportedShapes and defaults a missing list to []", async () => {
    const withMixed = createDiscovery({
      wellKnownFetcher: fetcherReturning({ ...goodPayload, supportedShapes: ["cli", 7, null] }),
    });
    expect((await withMixed.discover("mixed.example")).supportedShapes).toEqual(["cli"]);

    const withNone = createDiscovery({
      wellKnownFetcher: fetcherReturning({
        endpoint: "https://noshapes.example",
        version: "crewhaus.federation.v1",
        publicKeyFingerprint: HEX64,
      }),
    });
    expect((await withNone.discover("noshapes.example")).supportedShapes).toEqual([]);
  });

  test("rejects a non-object peer record (JSON primitive)", async () => {
    // A bare JSON number/string is `typeof !== "object"`, so it hits the
    // top-level guard. (Arrays are `typeof === "object"` and fall through to
    // the endpoint+version check instead.)
    const num = createDiscovery({ wellKnownFetcher: fetcherReturning(42) });
    await expect(num.discover("num.example")).rejects.toThrow(/is not an object/);

    const nul = createDiscovery({ wellKnownFetcher: fetcherReturning(null) });
    await expect(nul.discover("null.example")).rejects.toThrow(/is not an object/);
  });

  test("normalizes an upper-case fingerprint to lower-case", async () => {
    const d = createDiscovery({
      wellKnownFetcher: fetcherReturning({ ...goodPayload, publicKeyFingerprint: "A".repeat(64) }),
    });
    expect((await d.discover("upper.example")).publicKeyFingerprint).toBe(HEX64);
  });

  test("allows http://localhost when allowInsecureLocalhost is set", async () => {
    const d = createDiscovery({
      allowInsecureLocalhost: true,
      wellKnownFetcher: fetcherReturning({
        ...goodPayload,
        endpoint: "http://localhost:8443",
      }),
    });
    expect((await d.discover("local.example")).endpoint).toBe("http://localhost:8443");
  });

  test("still rejects http://localhost when allowInsecureLocalhost is NOT set", async () => {
    const d = createDiscovery({
      wellKnownFetcher: fetcherReturning({ ...goodPayload, endpoint: "http://localhost:8443" }),
    });
    await expect(d.discover("local.example")).rejects.toThrow(/must be https/);
  });
});

describe("SRV edge cases", () => {
  test("SRV returns zero records → falls through to direct .well-known", async () => {
    const srv: SrvResolver = async () => ({ records: [], ttl: 60 });
    const seen: string[] = [];
    const d = createDiscovery({
      srvDomain: "internal.crewhaus",
      srvResolver: srv,
      wellKnownFetcher: async (url) => {
        seen.push(url);
        return { status: 200, body: JSON.stringify(goodPayload) };
      },
    });
    const rec = await d.discover("deployment-b.example");
    expect(rec.endpoint).toBe(goodPayload.endpoint);
    // Direct fetch used the deployment URL, not an SRV-derived one.
    expect(seen).toEqual(["https://deployment-b.example/.well-known/crewhaus.json"]);
  });

  test("SRV hit whose well-known is bad falls through to the direct .well-known", async () => {
    const srv: SrvResolver = async () => ({
      records: [{ priority: 10, weight: 5, port: 8443, name: "fed.deployment-b.example" }],
      ttl: 60,
    });
    const seen: string[] = [];
    const d = createDiscovery({
      srvDomain: "internal.crewhaus",
      srvResolver: srv,
      wellKnownFetcher: async (url) => {
        seen.push(url);
        // First call (SRV endpoint) 404s; second call (direct) succeeds.
        if (url.startsWith("https://fed.deployment-b.example:8443")) {
          return { status: 404, body: "" };
        }
        return { status: 200, body: JSON.stringify(goodPayload) };
      },
    });
    const rec = await d.discover("deployment-b.example");
    expect(seen[0]).toBe("https://fed.deployment-b.example:8443/.well-known/crewhaus.json");
    expect(seen[1]).toBe("https://deployment-b.example/.well-known/crewhaus.json");
    expect(rec.endpoint).toBe(goodPayload.endpoint);
  });

  test("SRV sorts by priority then by descending weight", async () => {
    const srv: SrvResolver = async () => ({
      records: [
        { priority: 20, weight: 99, port: 1, name: "low-priority.example" },
        { priority: 10, weight: 1, port: 2, name: "lo-weight.example" },
        { priority: 10, weight: 50, port: 8443, name: "winner.example" },
      ],
      ttl: 60,
    });
    const seen: string[] = [];
    const d = createDiscovery({
      srvDomain: "internal.crewhaus",
      srvResolver: srv,
      wellKnownFetcher: async (url) => {
        seen.push(url);
        return { status: 200, body: JSON.stringify(goodPayload) };
      },
    });
    const rec = await d.discover("deployment-b");
    expect(seen[0]).toBe("https://winner.example:8443/.well-known/crewhaus.json");
    expect(rec.endpoint).toBe("https://winner.example:8443");
  });

  test("srvDomain set but no srvResolver → skips SRV entirely", async () => {
    const seen: string[] = [];
    const d = createDiscovery({
      srvDomain: "internal.crewhaus",
      wellKnownFetcher: async (url) => {
        seen.push(url);
        return { status: 200, body: JSON.stringify(goodPayload) };
      },
    });
    const rec = await d.discover("deployment-b.example");
    expect(seen).toEqual(["https://deployment-b.example/.well-known/crewhaus.json"]);
    expect(rec.endpoint).toBe(goodPayload.endpoint);
  });
});

describe("error semantics", () => {
  test("non-FederationDiscoveryError from the fetcher is wrapped with its cause preserved", async () => {
    const boom = new TypeError("socket hang up");
    const d = createDiscovery({
      wellKnownFetcher: async () => {
        throw boom;
      },
    });
    let caught: unknown;
    try {
      await d.discover("deployment-b.example");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FederationDiscoveryError);
    expect((caught as FederationDiscoveryError).message).toMatch(/peer discovery failed/);
    expect((caught as FederationDiscoveryError).message).toMatch(/socket hang up/);
    expect((caught as FederationDiscoveryError).cause).toBe(boom);
    expect((caught as FederationDiscoveryError).code).toBe("config");
  });

  test("cacheStats exposes per-deployment expiry timestamps", async () => {
    const clock = 1_000;
    const d = createDiscovery({
      now: () => clock,
      wellKnownFetcher: fetcherReturning(goodPayload),
    });
    await d.discover("deployment-b.example");
    const stats = d.cacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.expirations).toEqual([
      { deployment: "deployment-b.example", expiresAt: 1_000 + 60_000 },
    ]);
  });

  test("an expired entry is evicted and re-resolved (covers stale-branch delete)", async () => {
    let clock = 0;
    let calls = 0;
    const d = createDiscovery({
      now: () => clock,
      wellKnownFetcher: async () => {
        calls++;
        return { status: 200, body: JSON.stringify(goodPayload) };
      },
    });
    await d.discover("deployment-b.example");
    expect(calls).toBe(1);
    clock += 60_001; // past the 60s record TTL
    await d.discover("deployment-b.example");
    expect(calls).toBe(2);
  });
});
