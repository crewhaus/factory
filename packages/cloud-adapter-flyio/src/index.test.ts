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

  test('falls back to status "created" when launch body omits state', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/apps")) return new Response("{}", { status: 201 });
      // No `state` field — exercises the `?? "created"` fallback.
      return new Response(JSON.stringify({ id: "m-nostate" }), { status: 200 });
    }) as unknown as typeof fetch;
    const record = await deployToFly({
      target: "channel",
      appName: "my-bot",
      imageRef: "img",
      apiToken: "fo_testtoken_abc",
      fetchImpl,
    });
    expect(record.machineId).toBe("m-nostate");
    expect(record.status).toBe("created");
  });

  test("throws when launch returns 2xx with a non-JSON body", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/apps")) return new Response("{}", { status: 201 });
      return new Response("not json at all", { status: 200 });
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToFly({
        target: "channel",
        appName: "my-bot",
        imageRef: "img",
        apiToken: "fo_testtoken_abc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(FlyAdapterError);
    expect(caught?.message).toContain("non-JSON body");
  });

  test("throws when launch body is valid JSON but missing machine id", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/apps")) return new Response("{}", { status: 201 });
      // Valid JSON, but `id` is absent (or non-string).
      return new Response(JSON.stringify({ state: "started" }), { status: 200 });
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToFly({
        target: "channel",
        appName: "my-bot",
        imageRef: "img",
        apiToken: "fo_testtoken_abc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(FlyAdapterError);
    expect(caught?.message).toContain("missing machine id");
  });

  test("wraps a thrown fetch on app-create and scrubs the token", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down for fo_leakingtoken_full retry");
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
    expect(caught?.message).toContain("Fly Machines API request failed");
    expect(caught?.message).not.toContain("fo_leakingtoken_full");
    expect(caught?.message).toContain("[REDACTED:FLY_API_TOKEN]");
    expect((caught as FlyAdapterError).cause).toBeInstanceOf(Error);
  });

  test("wraps a non-Error thrown fetch on machine launch", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/apps")) return new Response("{}", { status: 201 });
      // Throw a non-Error so the `String(err)` branch is taken.
      throw "boom-string";
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToFly({
        target: "channel",
        appName: "my-bot",
        imageRef: "img",
        apiToken: "fo_testtoken_abc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(FlyAdapterError);
    expect(caught?.message).toContain("Fly Machines API request failed: boom-string");
  });

  test("rejects unsupported (one-shot) target shapes before any network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToFly({
        target: "eval",
        appName: "my-bot",
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

  test("rejects unknown target shapes before any network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToFly({
        target: "mystery" as never,
        appName: "my-bot",
        imageRef: "img",
        apiToken: "fo_testtoken_abc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(FlyAdapterError);
    expect(caught?.message).toContain("unknown target shape");
    expect(called).toBe(false);
  });

  test("treats an empty-string apiToken as unconfigured", async () => {
    delete process.env[API_TOKEN_ENV];
    let caught: Error | undefined;
    try {
      await deployToFly({
        target: "channel",
        appName: "my-bot",
        imageRef: "img",
        apiToken: "",
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(FlyAdapterError);
    expect(caught?.message).toContain("FLY_API_TOKEN is required");
  });

  test("honors an explicit org slug + region in the request payload", async () => {
    let createBody: string | undefined;
    let launchBody: string | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/apps")) {
        createBody = init?.body as string;
        return new Response("{}", { status: 201 });
      }
      launchBody = init?.body as string;
      return new Response(JSON.stringify({ id: "m-1", state: "started" }), { status: 200 });
    }) as unknown as typeof fetch;
    const record = await deployToFly({
      target: "channel",
      appName: "my-bot",
      imageRef: "img",
      apiToken: "fo_testtoken_abc",
      orgSlug: "acme-co",
      region: "fra",
      fetchImpl,
    });
    expect(record.region).toBe("fra");
    expect(JSON.parse(createBody as string).org_slug).toBe("acme-co");
    expect(JSON.parse(launchBody as string).region).toBe("fra");
  });

  test("surfaces a scrubbed app-create failure for non-409 statuses", async () => {
    const fetchImpl = (async () =>
      new Response("boom fo_leakingtoken_full boom", {
        status: 500,
        statusText: "Internal Server Error",
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
    expect(caught?.message).toContain("Fly app create returned 500");
    expect(caught?.message).not.toContain("fo_leakingtoken_full");
  });
});

describe("security: app name guards the Machines API URL path", () => {
  // Regression: appName is interpolated into `${baseUrl}/apps/${appName}/machines`.
  // assertAppName must reject path-traversal / SSRF payloads BEFORE any fetch runs.
  const PAYLOADS = [
    "../../etc/passwd",
    "app/../../admin",
    "app%2F..%2Fadmin",
    "app name",
    "app\nmachines",
    "evil.example.com",
    "UPPER",
  ];
  for (const payload of PAYLOADS) {
    test(`rejects "${payload}" without calling fetch`, async () => {
      let called = false;
      const fetchImpl = (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      let caught: Error | undefined;
      try {
        await deployToFly({
          target: "channel",
          appName: payload,
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
  }
});

describe("flyTomlFor: unknown vs unsupported shape branches", () => {
  test("rejects an entirely unknown shape (isTargetShape=false)", () => {
    expect(() => flyTomlFor({ target: "mystery" as never, appName: "svc" })).toThrow(
      /unknown target shape/,
    );
  });

  test("skips env entries whose value is undefined", () => {
    const toml = flyTomlFor({
      target: "channel",
      appName: "svc",
      // `MISSING` is explicitly undefined; it must not emit a line.
      envVars: { KEEP: "1", MISSING: undefined } as unknown as Record<string, string>,
    });
    expect(toml).toContain('KEEP = "1"');
    expect(toml).not.toContain("MISSING");
  });

  test("omits the [env] block entirely when envVars is empty", () => {
    const toml = flyTomlFor({ target: "channel", appName: "svc", envVars: {} });
    expect(toml).not.toContain("[env]");
  });

  test("escapes backslashes in env values", () => {
    const toml = flyTomlFor({
      target: "channel",
      appName: "svc",
      envVars: { WIN: "C:\\path" },
    });
    expect(toml).toContain('WIN = "C:\\\\path"');
  });

  test("uses a custom dockerfile path", () => {
    const toml = flyTomlFor({
      target: "channel",
      appName: "svc",
      dockerfilePath: "ops/Dockerfile.custom",
    });
    expect(toml).toContain('dockerfile = "ops/Dockerfile.custom"');
  });

  test("supports every web shape and the lone worker shape", () => {
    for (const shape of ["channel", "managed", "voice", "browser"] as const) {
      expect(flyTomlFor({ target: shape, appName: "svc" })).toContain("[http_service]");
    }
    expect(flyTomlFor({ target: "batch", appName: "svc" })).toContain("[processes]");
  });
});
