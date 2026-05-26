import { afterEach, describe, expect, test } from "bun:test";
import {
  FLY_DEFAULT_API_BASE,
  FLY_TARGET_SHAPES,
  FlyAdapterError,
  deployToFly,
  flyDockerfileFor,
  flyTomlFor,
  isFlyTargetShape,
  scrubApiToken,
} from "./index";

const API_TOKEN_ENV = "FLY_API_TOKEN";

describe("isFlyTargetShape", () => {
  test("accepts daemon shapes", () => {
    for (const shape of FLY_TARGET_SHAPES) {
      expect(isFlyTargetShape(shape)).toBe(true);
    }
  });
  test("rejects one-shot shapes", () => {
    for (const shape of ["cli", "workflow", "eval", "graph", "pipeline", "crew", "research"]) {
      expect(isFlyTargetShape(shape)).toBe(false);
    }
  });
});

describe("flyTomlFor", () => {
  test("web shape emits http_service block + healthcheck", () => {
    const toml = flyTomlFor({ target: "channel", appName: "my-bot" });
    expect(toml).toContain('app = "my-bot"');
    expect(toml).toContain('primary_region = "iad"');
    expect(toml).toContain("[build]");
    expect(toml).toContain('dockerfile = "Dockerfile.fly"');
    expect(toml).toContain("[http_service]");
    expect(toml).toContain("internal_port = 8080");
    expect(toml).toContain("force_https = true");
    expect(toml).toContain('path = "/healthz"');
    expect(toml).toContain("[[vm]]");
    expect(toml).toContain('cpu_kind = "shared"');
  });

  test("batch shape emits process group (no http_service)", () => {
    const toml = flyTomlFor({ target: "batch", appName: "my-worker" });
    expect(toml).not.toContain("[http_service]");
    expect(toml).toContain("[processes]");
    expect(toml).toContain("worker =");
  });

  test("env vars are TOML-encoded + sorted", () => {
    const a = flyTomlFor({
      target: "channel",
      appName: "svc",
      envVars: { ZETA: "1", ALPHA: "2" },
    });
    const b = flyTomlFor({
      target: "channel",
      appName: "svc",
      envVars: { ALPHA: "2", ZETA: "1" },
    });
    expect(a).toBe(b);
    const alpha = a.indexOf("ALPHA");
    const zeta = a.indexOf("ZETA");
    expect(alpha).toBeLessThan(zeta);
  });

  test("env var values with quotes are escaped", () => {
    const toml = flyTomlFor({
      target: "channel",
      appName: "svc",
      envVars: { TRICKY: 'has "quote" inside' },
    });
    expect(toml).toContain('TRICKY = "has \\"quote\\" inside"');
  });

  test("respects vm preset", () => {
    const toml = flyTomlFor({ target: "channel", appName: "svc", vm: "performance-2x" });
    expect(toml).toContain('cpu_kind = "performance"');
    expect(toml).toContain("cpus = 2");
    expect(toml).toContain("memory_mb = 4096");
  });

  test("respects internal port + region overrides", () => {
    const toml = flyTomlFor({
      target: "channel",
      appName: "svc",
      internalPort: 3000,
      primaryRegion: "fra",
    });
    expect(toml).toContain("internal_port = 3000");
    expect(toml).toContain('primary_region = "fra"');
  });

  test("rejects invalid app names", () => {
    expect(() => flyTomlFor({ target: "channel", appName: "MyApp" })).toThrow(FlyAdapterError);
    expect(() => flyTomlFor({ target: "channel", appName: "-leading" })).toThrow(FlyAdapterError);
    expect(() =>
      flyTomlFor({ target: "channel", appName: "this-app-name-is-far-too-long-for-fly" }),
    ).toThrow(FlyAdapterError);
  });

  test("rejects unsupported target shapes", () => {
    expect(() => flyTomlFor({ target: "cli", appName: "svc" })).toThrow(FlyAdapterError);
    expect(() => flyTomlFor({ target: "eval", appName: "svc" })).toThrow(FlyAdapterError);
  });
});

describe("flyDockerfileFor", () => {
  test("web shape gets EXPOSE on the internal port", () => {
    const df = flyDockerfileFor({ target: "channel", baseImage: "crewhaus/channel:0.1.0" });
    expect(df).toContain("FROM crewhaus/channel:0.1.0");
    expect(df).toContain("ENV PORT=8080");
    expect(df).toContain("EXPOSE 8080");
  });

  test("worker shape skips EXPOSE", () => {
    const df = flyDockerfileFor({ target: "batch", baseImage: "crewhaus/batch:0.1.0" });
    expect(df).not.toContain("EXPOSE");
  });

  test("respects internal port override", () => {
    const df = flyDockerfileFor({
      target: "channel",
      baseImage: "crewhaus/channel:0.1.0",
      internalPort: 3000,
    });
    expect(df).toContain("EXPOSE 3000");
    expect(df).toContain("ENV PORT=3000");
  });

  test("rejects one-shot shapes", () => {
    expect(() => flyDockerfileFor({ target: "cli", baseImage: "x" })).toThrow(FlyAdapterError);
  });

  test("rejects unknown shapes", () => {
    expect(() => flyDockerfileFor({ target: "mystery" as never, baseImage: "x" })).toThrow(
      FlyAdapterError,
    );
  });
});

describe("scrubApiToken", () => {
  test("redacts the token", () => {
    expect(scrubApiToken("token fo_abcdefghij123 leaked", "fo_abcdefghij123")).toBe(
      "token [REDACTED:FLY_API_TOKEN] leaked",
    );
  });
  test("ignores short tokens", () => {
    expect(scrubApiToken("untouched", "abc")).toBe("untouched");
  });
  test("ignores undefined tokens", () => {
    expect(scrubApiToken("untouched", undefined)).toBe("untouched");
  });
});

describe("deployToFly", () => {
  const ORIGINAL_TOKEN = process.env[API_TOKEN_ENV];
  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env[API_TOKEN_ENV];
    else process.env[API_TOKEN_ENV] = ORIGINAL_TOKEN;
  });

  function okFetchImpl(machineId = "m-default", state = "started"): typeof fetch {
    return (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/apps")) {
        return new Response("{}", { status: 201 });
      }
      if (u.includes("/machines")) {
        return new Response(JSON.stringify({ id: machineId, state }), { status: 200 });
      }
      return new Response("not matched", { status: 500 });
    }) as unknown as typeof fetch;
  }

  test("creates app + launches first machine", async () => {
    const record = await deployToFly({
      target: "channel",
      appName: "my-bot",
      imageRef: "registry.fly.io/my-bot:latest",
      apiToken: "fo_testtoken_abc",
      fetchImpl: okFetchImpl("m-12345", "started"),
    });
    expect(record.appName).toBe("my-bot");
    expect(record.machineId).toBe("m-12345");
    expect(record.status).toBe("started");
    expect(record.region).toBe("iad");
  });

  test("treats 409 app-create conflict as success (already exists)", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/apps")) {
        return new Response('{"error":"app exists"}', { status: 409 });
      }
      return new Response(JSON.stringify({ id: "m-x", state: "started" }), { status: 200 });
    }) as unknown as typeof fetch;
    const record = await deployToFly({
      target: "channel",
      appName: "my-bot",
      imageRef: "img",
      apiToken: "fo_testtoken_abc",
      fetchImpl,
    });
    expect(record.machineId).toBe("m-x");
  });

  test("scrubs the token from machine-launch error bodies", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/apps")) return new Response("{}", { status: 201 });
      return new Response("unauthorized — token fo_leakingtoken_full denied", {
        status: 401,
        statusText: "Unauthorized",
      });
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToFly({
        target: "channel",
        appName: "my-bot",
        imageRef: "img",
        apiToken: "fo_leakingtoken_full",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(FlyAdapterError);
    expect(caught?.message).not.toContain("fo_leakingtoken_full");
    expect(caught?.message).toContain("[REDACTED:FLY_API_TOKEN]");
  });

  test("scrubs the token from app-create error bodies", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden — token fo_leakingtoken_full denied", {
        status: 403,
        statusText: "Forbidden",
      })) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToFly({
        target: "channel",
        appName: "my-bot",
        imageRef: "img",
        apiToken: "fo_leakingtoken_full",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(FlyAdapterError);
    expect(caught?.message).not.toContain("fo_leakingtoken_full");
  });

  test("throws clearly when no token is configured", async () => {
    delete process.env[API_TOKEN_ENV];
    let caught: Error | undefined;
    try {
      await deployToFly({
        target: "channel",
        appName: "my-bot",
        imageRef: "img",
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(FlyAdapterError);
    expect(caught?.message).toContain("FLY_API_TOKEN is required");
  });

  test("resolves token from env when apiToken omitted", async () => {
    process.env[API_TOKEN_ENV] = "fo_env_provided_token";
    let seenAuth: string | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string>)["Authorization"];
      const u = String(url);
      if (u.endsWith("/apps")) return new Response("{}", { status: 201 });
      return new Response(JSON.stringify({ id: "m-1", state: "started" }), { status: 200 });
    }) as unknown as typeof fetch;
    await deployToFly({
      target: "channel",
      appName: "my-bot",
      imageRef: "img",
      fetchImpl,
    });
    expect(seenAuth).toBe("Bearer fo_env_provided_token");
  });

  test("rejects invalid app name before any network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToFly({
        target: "channel",
        appName: "BadCaps",
        imageRef: "img",
        apiToken: "fo_testtoken_abc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(FlyAdapterError);
    expect(called).toBe(false);
  });

  test("uses the configured base url", async () => {
    let seenUrl: string | undefined;
    const fetchImpl = (async (url: string | URL) => {
      seenUrl = seenUrl ?? String(url);
      const u = String(url);
      if (u.endsWith("/apps")) return new Response("{}", { status: 201 });
      return new Response(JSON.stringify({ id: "m-1", state: "started" }), { status: 200 });
    }) as unknown as typeof fetch;
    await deployToFly({
      target: "channel",
      appName: "my-bot",
      imageRef: "img",
      apiToken: "fo_testtoken_abc",
      fetchImpl,
    });
    expect(seenUrl).toBe(`${FLY_DEFAULT_API_BASE}/apps`);
  });
});
