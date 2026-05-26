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
});
