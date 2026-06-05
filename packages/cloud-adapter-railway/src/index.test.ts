import { afterEach, describe, expect, test } from "bun:test";
import {
  RAILWAY_DEFAULT_API_BASE,
  RAILWAY_TARGET_SHAPES,
  RailwayAdapterError,
  deployToRailway,
  isRailwayTargetShape,
  railwayConfigFor,
  railwayDockerfileFor,
  scrubApiToken,
} from "./index";

const API_TOKEN_ENV = "RAILWAY_API_TOKEN";

describe("isRailwayTargetShape", () => {
  test("accepts daemon shapes", () => {
    for (const shape of RAILWAY_TARGET_SHAPES) {
      expect(isRailwayTargetShape(shape)).toBe(true);
    }
  });
  test("rejects one-shot shapes", () => {
    for (const shape of ["cli", "workflow", "eval", "graph", "pipeline", "crew", "research"]) {
      expect(isRailwayTargetShape(shape)).toBe(false);
    }
  });
});

describe("railwayConfigFor", () => {
  test("web shape gets healthcheck path", () => {
    const json = railwayConfigFor({ target: "channel" });
    const parsed = JSON.parse(json);
    expect(parsed.build.builder).toBe("DOCKERFILE");
    expect(parsed.build.dockerfilePath).toBe("Dockerfile.railway");
    expect(parsed.deploy.healthcheckPath).toBe("/healthz");
    expect(parsed.deploy.healthcheckTimeout).toBe(300);
    expect(parsed.deploy.restartPolicyType).toBe("ON_FAILURE");
  });

  test("worker shape omits healthcheck", () => {
    const json = railwayConfigFor({ target: "batch" });
    const parsed = JSON.parse(json);
    expect(parsed.deploy.healthcheckPath).toBeUndefined();
    expect(parsed.deploy.healthcheckTimeout).toBeUndefined();
  });

  test("is deterministic for the same input", () => {
    const a = railwayConfigFor({ target: "channel" });
    const b = railwayConfigFor({ target: "channel" });
    expect(a).toBe(b);
  });

  test("respects restart policy + dockerfile path overrides", () => {
    const parsed = JSON.parse(
      railwayConfigFor({
        target: "managed",
        restartPolicy: "ALWAYS",
        restartPolicyMaxRetries: 25,
        dockerfilePath: "Dockerfile.prod",
      }),
    );
    expect(parsed.deploy.restartPolicyType).toBe("ALWAYS");
    expect(parsed.deploy.restartPolicyMaxRetries).toBe(25);
    expect(parsed.build.dockerfilePath).toBe("Dockerfile.prod");
  });

  test("rejects unsupported shapes", () => {
    expect(() => railwayConfigFor({ target: "cli" })).toThrow(RailwayAdapterError);
    expect(() => railwayConfigFor({ target: "eval" })).toThrow(RailwayAdapterError);
  });

  test("rejects unknown shapes", () => {
    expect(() => railwayConfigFor({ target: "mystery" as never })).toThrow(RailwayAdapterError);
  });

  test("honors healthcheck overrides on web shapes", () => {
    const parsed = JSON.parse(
      railwayConfigFor({
        target: "voice",
        healthcheckPath: "/ready",
        healthcheckTimeoutSec: 42,
      }),
    );
    expect(parsed.deploy.healthcheckPath).toBe("/ready");
    expect(parsed.deploy.healthcheckTimeout).toBe(42);
  });

  test("worker shape still carries restart defaults", () => {
    const parsed = JSON.parse(railwayConfigFor({ target: "batch" }));
    expect(parsed.deploy.restartPolicyType).toBe("ON_FAILURE");
    expect(parsed.deploy.restartPolicyMaxRetries).toBe(10);
    expect(parsed.build.dockerfilePath).toBe("Dockerfile.railway");
  });

  test("emits a stable schema url and trailing newline", () => {
    const json = railwayConfigFor({ target: "channel" });
    expect(json.endsWith("\n")).toBe(true);
    expect(JSON.parse(json).$schema).toBe("https://railway.app/railway.schema.json");
  });
});

describe("railwayDockerfileFor", () => {
  test("web shape EXPOSEs 8080", () => {
    const df = railwayDockerfileFor({ target: "channel", baseImage: "crewhaus/channel:0.1.0" });
    expect(df).toContain("FROM crewhaus/channel:0.1.0");
    expect(df).toContain("EXPOSE 8080");
  });

  test("worker shape does not EXPOSE", () => {
    const df = railwayDockerfileFor({ target: "batch", baseImage: "crewhaus/batch:0.1.0" });
    expect(df).not.toContain("EXPOSE");
  });

  test("rejects unsupported shapes", () => {
    expect(() => railwayDockerfileFor({ target: "cli", baseImage: "x" })).toThrow(
      RailwayAdapterError,
    );
  });

  test("rejects unknown shapes", () => {
    expect(() => railwayDockerfileFor({ target: "mystery" as never, baseImage: "x" })).toThrow(
      RailwayAdapterError,
    );
  });

  test("pins PORT and a trailing newline for every shape", () => {
    const df = railwayDockerfileFor({ target: "batch", baseImage: "crewhaus/batch:0.1.0" });
    expect(df).toContain("ENV PORT=8080");
    expect(df.endsWith("\n")).toBe(true);
    expect(df).toContain("# Railway-tuned wrapper around crewhaus/batch:0.1.0");
  });
});

describe("RailwayAdapterError", () => {
  test("carries the config error code", () => {
    const err = new RailwayAdapterError("boom");
    expect(err.name).toBe("RailwayAdapterError");
    expect(err.code).toBe("config");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("scrubApiToken", () => {
  test("redacts", () => {
    expect(scrubApiToken("token rw_abcdef1234567890 leaked", "rw_abcdef1234567890")).toBe(
      "token [REDACTED:RAILWAY_API_TOKEN] leaked",
    );
  });
  test("ignores short tokens", () => {
    expect(scrubApiToken("untouched", "abc")).toBe("untouched");
  });
});

describe("deployToRailway", () => {
  const ORIGINAL_TOKEN = process.env[API_TOKEN_ENV];
  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env[API_TOKEN_ENV];
    else process.env[API_TOKEN_ENV] = ORIGINAL_TOKEN;
  });

  test("posts a serviceCreate mutation", async () => {
    let observed: { url: string; body: string } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      observed = { url: String(url), body: String(init?.body ?? "") };
      return new Response(
        JSON.stringify({ data: { serviceCreate: { id: "svc-123", name: "my-bot" } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const record = await deployToRailway({
      projectId: "p-456",
      serviceName: "my-bot",
      apiToken: "rw_testtoken_abc",
      fetchImpl,
    });
    expect(observed?.url).toBe(RAILWAY_DEFAULT_API_BASE);
    expect(observed?.body).toContain("serviceCreate");
    expect(observed?.body).toContain("p-456");
    expect(record.serviceId).toBe("svc-123");
    expect(record.serviceName).toBe("my-bot");
    expect(record.projectId).toBe("p-456");
  });

  test("surfaces GraphQL errors", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "project not found" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRailway({
        projectId: "missing",
        serviceName: "my-bot",
        apiToken: "rw_testtoken_abc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RailwayAdapterError);
    expect(caught?.message).toContain("project not found");
  });

  test("scrubs token from HTTP error bodies", async () => {
    const fetchImpl = (async () =>
      new Response("unauthorized — token rw_leakingtoken_full denied", {
        status: 401,
        statusText: "Unauthorized",
      })) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRailway({
        projectId: "p",
        serviceName: "my-bot",
        apiToken: "rw_leakingtoken_full",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).not.toContain("rw_leakingtoken_full");
    expect(caught?.message).toContain("[REDACTED:RAILWAY_API_TOKEN]");
  });

  test("throws clearly when no token configured", async () => {
    delete process.env[API_TOKEN_ENV];
    let caught: Error | undefined;
    try {
      await deployToRailway({ projectId: "p", serviceName: "my-bot" });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RailwayAdapterError);
    expect(caught?.message).toContain("RAILWAY_API_TOKEN is required");
  });

  test("validates service name before network", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRailway({
        projectId: "p",
        serviceName: "BadCaps",
        apiToken: "rw_testtoken_abc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RailwayAdapterError);
    expect(called).toBe(false);
  });

  test("wraps and scrubs network/transport failures", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED via proxy auth rw_leakingtoken_full");
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRailway({
        projectId: "p",
        serviceName: "my-bot",
        apiToken: "rw_leakingtoken_full",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RailwayAdapterError);
    expect(caught?.message).toContain("Railway GraphQL request failed");
    expect(caught?.message).toContain("ECONNREFUSED");
    expect(caught?.message).not.toContain("rw_leakingtoken_full");
    expect(caught?.message).toContain("[REDACTED:RAILWAY_API_TOKEN]");
    expect((caught as RailwayAdapterError).cause).toBeInstanceOf(Error);
  });

  test("stringifies non-Error transport rejections", async () => {
    const fetchImpl = (async () => {
      throw "boom-string-reject";
    }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRailway({
        projectId: "p",
        serviceName: "my-bot",
        apiToken: "rw_testtoken_abc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RailwayAdapterError);
    expect(caught?.message).toContain("boom-string-reject");
  });

  test("rejects and scrubs a non-JSON 200 body", async () => {
    const fetchImpl = (async () =>
      new Response("<html>gateway error rw_leakingtoken_full</html>", {
        status: 200,
      })) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRailway({
        projectId: "p",
        serviceName: "my-bot",
        apiToken: "rw_leakingtoken_full",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RailwayAdapterError);
    expect(caught?.message).toContain("non-JSON body");
    expect(caught?.message).not.toContain("rw_leakingtoken_full");
    expect(caught?.message).toContain("[REDACTED:RAILWAY_API_TOKEN]");
  });

  test("rejects and scrubs when serviceCreate.id is missing", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: { serviceCreate: { name: "my-bot" } },
          meta: "trace rw_leakingtoken_full",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRailway({
        projectId: "p",
        serviceName: "my-bot",
        apiToken: "rw_leakingtoken_full",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RailwayAdapterError);
    expect(caught?.message).toContain("missing serviceCreate.id");
    expect(caught?.message).not.toContain("rw_leakingtoken_full");
    expect(caught?.message).toContain("[REDACTED:RAILWAY_API_TOKEN]");
  });

  test("surfaces HTTP status errors with status line", async () => {
    const fetchImpl = (async () =>
      new Response("internal error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRailway({
        projectId: "p",
        serviceName: "my-bot",
        apiToken: "rw_testtoken_abc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RailwayAdapterError);
    expect(caught?.message).toContain("500");
    expect(caught?.message).toContain("Internal Server Error");
  });

  test("falls back to the requested service name when the API omits it", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { serviceCreate: { id: "svc-xyz" } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const record = await deployToRailway({
      projectId: "p-789",
      serviceName: "named-bot",
      apiToken: "rw_testtoken_abc",
      fetchImpl,
    });
    expect(record.serviceId).toBe("svc-xyz");
    expect(record.serviceName).toBe("named-bot");
    expect(record.projectId).toBe("p-789");
  });

  test("reads RAILWAY_API_TOKEN from the environment when apiToken is omitted", async () => {
    process.env[API_TOKEN_ENV] = "rw_env_token_value";
    let observedAuth: string | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observedAuth = headers.get("Authorization") ?? undefined;
      return new Response(
        JSON.stringify({ data: { serviceCreate: { id: "svc-env", name: "n" } } }),
        {
          status: 200,
        },
      );
    }) as unknown as typeof fetch;
    const record = await deployToRailway({
      projectId: "p",
      serviceName: "my-bot",
      fetchImpl,
    });
    expect(record.serviceId).toBe("svc-env");
    expect(observedAuth).toBe("Bearer rw_env_token_value");
  });

  test("honors an explicit apiBaseUrl override", async () => {
    let observedUrl: string | undefined;
    const fetchImpl = (async (url: string | URL) => {
      observedUrl = String(url);
      return new Response(JSON.stringify({ data: { serviceCreate: { id: "svc-1", name: "n" } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await deployToRailway({
      projectId: "p",
      serviceName: "my-bot",
      apiToken: "rw_testtoken_abc",
      apiBaseUrl: "https://example.test/graphql",
      fetchImpl,
    });
    expect(observedUrl).toBe("https://example.test/graphql");
  });

  test("surfaces a generic message when a GraphQL error lacks a message field", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{}] }), {
        status: 200,
      })) as unknown as typeof fetch;
    let caught: Error | undefined;
    try {
      await deployToRailway({
        projectId: "p",
        serviceName: "my-bot",
        apiToken: "rw_testtoken_abc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(RailwayAdapterError);
    expect(caught?.message).toContain("(no message)");
  });
});
