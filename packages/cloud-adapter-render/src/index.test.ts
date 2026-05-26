import { afterEach, describe, expect, test } from "bun:test";
import {
  RENDER_DEFAULT_API_BASE,
  RENDER_TARGET_SHAPES,
  RenderAdapterError,
  deployToRender,
  isRenderTargetShape,
  renderBlueprintFor,
  renderDockerfileFor,
  scrubApiKey,
} from "./index";

describe("isRenderTargetShape", () => {
  test("accepts the daemon shapes", () => {
    for (const shape of RENDER_TARGET_SHAPES) {
      expect(isRenderTargetShape(shape)).toBe(true);
    }
  });
  test("rejects one-shot shapes", () => {
    for (const shape of ["cli", "workflow", "eval", "graph", "pipeline", "crew", "research"]) {
      expect(isRenderTargetShape(shape)).toBe(false);
    }
  });
  test("rejects non-strings", () => {
    expect(isRenderTargetShape(42)).toBe(false);
    expect(isRenderTargetShape(undefined)).toBe(false);
    expect(isRenderTargetShape(null)).toBe(false);
  });
});

describe("renderBlueprintFor", () => {
  test("emits a web-service blueprint for channel", () => {
    const yaml = renderBlueprintFor({ target: "channel", serviceName: "my-bot" });
    expect(yaml).toContain("services:");
    expect(yaml).toContain("- type: web");
    expect(yaml).toContain("name: my-bot");
    expect(yaml).toContain("runtime: docker");
    expect(yaml).toContain("dockerfilePath: ./Dockerfile.render");
    expect(yaml).toContain("region: oregon");
    expect(yaml).toContain("plan: starter");
    expect(yaml).toContain("healthCheckPath: /healthz");
  });

  test("emits a worker blueprint for batch (no healthCheckPath)", () => {
    const yaml = renderBlueprintFor({ target: "batch", serviceName: "my-worker" });
    expect(yaml).toContain("- type: worker");
    expect(yaml).not.toContain("healthCheckPath");
  });

  test("env vars are sorted deterministically", () => {
    const a = renderBlueprintFor({
      target: "channel",
      serviceName: "svc",
      envVars: { ZETA: "1", ALPHA: "2", MIDDLE: "3" },
    });
    const b = renderBlueprintFor({
      target: "channel",
      serviceName: "svc",
      envVars: { MIDDLE: "3", ZETA: "1", ALPHA: "2" },
    });
    expect(a).toBe(b);
    const alpha = a.indexOf("key: ALPHA");
    const middle = a.indexOf("key: MIDDLE");
    const zeta = a.indexOf("key: ZETA");
    expect(alpha).toBeLessThan(middle);
    expect(middle).toBeLessThan(zeta);
  });

  test("renders envVarsFromGroup references", () => {
    const yaml = renderBlueprintFor({
      target: "managed",
      serviceName: "svc",
      envVarsFromGroup: ["secrets-prod"],
    });
    expect(yaml).toContain("- fromGroup: secrets-prod");
  });

  test("respects region + plan overrides", () => {
    const yaml = renderBlueprintFor({
      target: "channel",
      serviceName: "svc",
      region: "frankfurt",
      plan: "standard",
    });
    expect(yaml).toContain("region: frankfurt");
    expect(yaml).toContain("plan: standard");
  });

  test("includes image tag when provided", () => {
    const yaml = renderBlueprintFor({
      target: "channel",
      serviceName: "svc",
      imageTag: "ghcr.io/me/img:0.1.0",
    });
    expect(yaml).toContain("image: ghcr.io/me/img:0.1.0");
  });

  test("omits image when imageTag is 'auto' (build from Dockerfile)", () => {
    const yaml = renderBlueprintFor({ target: "channel", serviceName: "svc", imageTag: "auto" });
    expect(yaml).not.toContain("\n    image:");
  });

  test("rejects invalid service names", () => {
    expect(() => renderBlueprintFor({ target: "channel", serviceName: "MyBot" })).toThrow(
      RenderAdapterError,
    );
    expect(() => renderBlueprintFor({ target: "channel", serviceName: "-leading" })).toThrow(
      RenderAdapterError,
    );
    expect(() => renderBlueprintFor({ target: "channel", serviceName: "trailing-" })).toThrow(
      RenderAdapterError,
    );
    expect(() => renderBlueprintFor({ target: "channel", serviceName: "" })).toThrow(
      RenderAdapterError,
    );
  });

  test("rejects unsupported target shapes", () => {
    expect(() => renderBlueprintFor({ target: "cli", serviceName: "svc" })).toThrow(
      RenderAdapterError,
    );
    expect(() => renderBlueprintFor({ target: "workflow", serviceName: "svc" })).toThrow(
      RenderAdapterError,
    );
    expect(() => renderBlueprintFor({ target: "eval", serviceName: "svc" })).toThrow(
      RenderAdapterError,
    );
  });
});

describe("renderDockerfileFor", () => {
  test("web shape gets healthcheck against \\$PORT", () => {
    const df = renderDockerfileFor({ target: "channel", baseImage: "crewhaus/channel:0.1.0" });
    expect(df).toContain("FROM crewhaus/channel:0.1.0");
    expect(df).toContain("ENV PORT=10000");
    expect(df).toContain("HEALTHCHECK");
    expect(df).toContain("http://localhost:$PORT/healthz");
  });

  test("worker shape skips HEALTHCHECK", () => {
    const df = renderDockerfileFor({ target: "batch", baseImage: "crewhaus/batch:0.1.0" });
    expect(df).toContain("FROM crewhaus/batch:0.1.0");
    expect(df).not.toContain("HEALTHCHECK");
  });

  test("rejects one-shot target shapes", () => {
    expect(() => renderDockerfileFor({ target: "cli", baseImage: "crewhaus/cli:0.1.0" })).toThrow(
      RenderAdapterError,
    );
  });

  test("rejects unknown target shapes", () => {
    expect(() => renderDockerfileFor({ target: "mystery" as never, baseImage: "x" })).toThrow(
      RenderAdapterError,
    );
  });
});

describe("scrubApiKey", () => {
  test("redacts the key", () => {
    const out = scrubApiKey("Auth failed for key rnd_abcdef1234567890", "rnd_abcdef1234567890");
    expect(out).toBe("Auth failed for key [REDACTED:RENDER_API_KEY]");
  });

  test("redacts multiple occurrences", () => {
    const out = scrubApiKey("key rnd_xyzlong used twice rnd_xyzlong", "rnd_xyzlong");
    expect(out).toBe("key [REDACTED:RENDER_API_KEY] used twice [REDACTED:RENDER_API_KEY]");
  });

  test("returns input unchanged when key is short", () => {
    expect(scrubApiKey("foo bar baz", "abc")).toBe("foo bar baz");
  });

  test("returns input unchanged when key is undefined", () => {
    expect(scrubApiKey("foo bar baz", undefined)).toBe("foo bar baz");
  });
});

const API_KEY_ENV = "RENDER_API_KEY";

describe("deployToRender", () => {
  const ORIGINAL_KEY = process.env[API_KEY_ENV];
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = ORIGINAL_KEY;
  });

  test("posts to the default Render base URL with Bearer auth", async () => {
    let observed: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      observed = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          service: { id: "srv-123" },
          deploy: { id: "dep-456", status: "created" },
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const result = await deployToRender({
      apiKey: "rnd_testkey_abcdef",
      blueprintYaml: "services: []\n",
      serviceName: "svc",
      fetchImpl,
    });
    expect(observed?.url).toBe(`${RENDER_DEFAULT_API_BASE}/services`);
    expect(observed?.init.method).toBe("POST");
    const headers = observed?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer rnd_testkey_abcdef");
    expect(headers["Content-Type"]).toBe("application/yaml");
    expect(result.serviceId).toBe("srv-123");
    expect(result.deployId).toBe("dep-456");
    expect(result.status).toBe("created");
  });

  test("scrubs the API key out of error messages", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden — key rnd_leakingkey_full was rejected", {
        status: 403,
        statusText: "Forbidden",
      })) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRender({
        apiKey: "rnd_leakingkey_full",
        blueprintYaml: "services: []\n",
        serviceName: "svc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RenderAdapterError);
    expect(caught?.message).not.toContain("rnd_leakingkey_full");
    expect(caught?.message).toContain("[REDACTED:RENDER_API_KEY]");
  });

  test("throws clearly when no API key is configured", async () => {
    delete process.env[API_KEY_ENV];
    let caught: Error | undefined;
    try {
      await deployToRender({ blueprintYaml: "x", serviceName: "svc" });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RenderAdapterError);
    expect(caught?.message).toContain("RENDER_API_KEY is required");
  });

  test("resolves the API key from the env var when apiKey omitted", async () => {
    process.env[API_KEY_ENV] = "rnd_env_provided_key_long";
    let seen: string | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seen = (init?.headers as Record<string, string>)["Authorization"];
      return new Response(
        JSON.stringify({ service: { id: "srv-x" }, deploy: { id: "d-x", status: "live" } }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    await deployToRender({ blueprintYaml: "services: []\n", serviceName: "svc", fetchImpl });
    expect(seen).toBe("Bearer rnd_env_provided_key_long");
  });

  test("validates service name before the network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRender({
        apiKey: "rnd_key_for_test_only",
        blueprintYaml: "x",
        serviceName: "BadCaps",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RenderAdapterError);
    expect(called).toBe(false);
  });
});
