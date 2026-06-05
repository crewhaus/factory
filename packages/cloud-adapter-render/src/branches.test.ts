// Supplementary branch/edge coverage for @crewhaus/cloud-adapter-render.
// The primary behavioural contract lives in ./index.test.ts; this file
// drives the error, fallback, and combinatorial branches that the happy-path
// suite does not exercise explicitly (network failure, non-JSON bodies,
// response-shape fallbacks, and the env-var/group merge matrix), with a
// strong focus on the T8 credential-leak guarantee on every error surface.

import { afterEach, describe, expect, test } from "bun:test";
import {
  RENDER_DEFAULT_API_BASE,
  RenderAdapterError,
  deployToRender,
  isRenderTargetShape,
  renderBlueprintFor,
  renderDockerfileFor,
  scrubApiKey,
} from "./index";

const API_KEY_ENV = "RENDER_API_KEY";

/** Build a fetch test seam returning a fixed body/status. */
function fakeFetch(body: string, init?: ResponseInit): typeof fetch {
  return (async () => new Response(body, init)) as unknown as typeof fetch;
}

describe("renderBlueprintFor — env var branches", () => {
  test("merges envVars and envVarsFromGroup under a single envVars block", () => {
    const yaml = renderBlueprintFor({
      target: "channel",
      serviceName: "svc",
      envVars: { FOO: "bar" },
      envVarsFromGroup: ["secrets-prod", "secrets-shared"],
    });
    // The `envVars:` header must appear exactly once (not re-emitted for the group).
    const headerCount = yaml.split("\n").filter((l) => l === "    envVars:").length;
    expect(headerCount).toBe(1);
    expect(yaml).toContain("      - key: FOO");
    expect(yaml).toContain('        value: "bar"');
    expect(yaml).toContain("      - fromGroup: secrets-prod");
    expect(yaml).toContain("      - fromGroup: secrets-shared");
  });

  test("empty envVars object emits no envVars block", () => {
    const yaml = renderBlueprintFor({ target: "channel", serviceName: "svc", envVars: {} });
    expect(yaml).not.toContain("envVars:");
  });

  test("empty envVarsFromGroup array emits no envVars block", () => {
    const yaml = renderBlueprintFor({
      target: "channel",
      serviceName: "svc",
      envVarsFromGroup: [],
    });
    expect(yaml).not.toContain("envVars:");
  });

  test("skips env entries whose value is undefined", () => {
    // Defends the `if (value === undefined) continue` guard against callers
    // who pass a partial record at runtime despite the string-typed signature.
    const yaml = renderBlueprintFor({
      target: "channel",
      serviceName: "svc",
      envVars: { KEEP: "yes", DROP: undefined } as unknown as Record<string, string>,
    });
    expect(yaml).toContain("      - key: KEEP");
    expect(yaml).not.toContain("DROP");
  });

  test("env values are JSON-escaped (YAML-injection defense)", () => {
    const yaml = renderBlueprintFor({
      target: "channel",
      serviceName: "svc",
      envVars: { TOKEN: 'a"b\nc: pwned' },
    });
    // JSON.stringify keeps the value on one quoted line with escapes — the
    // newline and quote cannot break out into a new YAML node.
    expect(yaml).toContain('        value: "a\\"b\\nc: pwned"');
    expect(yaml).not.toContain("\nc: pwned");
  });

  test("explicit undefined imageTag falls through to build-from-Dockerfile", () => {
    const yaml = renderBlueprintFor({
      target: "channel",
      serviceName: "svc",
      imageTag: undefined,
    });
    expect(yaml).not.toContain("\n    image:");
  });

  test("honors a custom dockerfilePath", () => {
    const yaml = renderBlueprintFor({
      target: "batch",
      serviceName: "svc",
      dockerfilePath: "./docker/Dockerfile.batch",
    });
    expect(yaml).toContain("dockerfilePath: ./docker/Dockerfile.batch");
  });

  test("accepts a 63-char service name but rejects a 64-char one", () => {
    const name63 = "a".repeat(63);
    const name64 = "a".repeat(64);
    expect(() => renderBlueprintFor({ target: "channel", serviceName: name63 })).not.toThrow();
    expect(() => renderBlueprintFor({ target: "channel", serviceName: name64 })).toThrow(
      RenderAdapterError,
    );
  });
});

describe("renderDockerfileFor — every web shape", () => {
  test("all web-typed shapes emit a HEALTHCHECK", () => {
    for (const shape of ["channel", "managed", "voice", "browser"] as const) {
      const df = renderDockerfileFor({ target: shape, baseImage: `crewhaus/${shape}:0.1.0` });
      expect(df).toContain("HEALTHCHECK");
      expect(df).toContain("http://localhost:$PORT/healthz");
    }
  });

  test("output ends with exactly one trailing newline", () => {
    const df = renderDockerfileFor({ target: "batch", baseImage: "crewhaus/batch:0.1.0" });
    expect(df.endsWith("\n")).toBe(true);
    expect(df.endsWith("\n\n")).toBe(false);
  });
});

describe("scrubApiKey — boundary lengths", () => {
  test("scrubs at exactly 8 chars (inclusive lower bound)", () => {
    expect(scrubApiKey("x 12345678 y", "12345678")).toBe("x [REDACTED:RENDER_API_KEY] y");
  });

  test("does not scrub at 7 chars (just below bound)", () => {
    expect(scrubApiKey("x 1234567 y", "1234567")).toBe("x 1234567 y");
  });

  test("empty-string key is treated as too short and left untouched", () => {
    expect(scrubApiKey("nothing to scrub", "")).toBe("nothing to scrub");
  });
});

describe("isRenderTargetShape — extra negatives", () => {
  test("rejects objects and arrays", () => {
    expect(isRenderTargetShape({})).toBe(false);
    expect(isRenderTargetShape([])).toBe(false);
    expect(isRenderTargetShape("")).toBe(false);
  });
});

describe("deployToRender — error & fallback branches", () => {
  const ORIGINAL_KEY = process.env[API_KEY_ENV];
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = ORIGINAL_KEY;
  });

  test("wraps a thrown network error and scrubs the key from it", async () => {
    const key = "rnd_network_failure_key_long";
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED while using ${key}`);
    }) as unknown as typeof fetch;
    let caught: RenderAdapterError | undefined;
    try {
      await deployToRender({
        apiKey: key,
        blueprintYaml: "services: []\n",
        serviceName: "svc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as RenderAdapterError;
    }
    expect(caught).toBeInstanceOf(RenderAdapterError);
    expect(caught?.message).toContain("Render API request failed");
    expect(caught?.message).not.toContain(key);
    expect(caught?.message).toContain("[REDACTED:RENDER_API_KEY]");
  });

  test("handles a non-Error thrown value from fetch (String(err) branch)", async () => {
    const fetchImpl = (async () => {
      // eslint-disable-next-line no-throw-literal
      throw "raw string failure";
    }) as unknown as typeof fetch;
    let caught: RenderAdapterError | undefined;
    try {
      await deployToRender({
        apiKey: "rnd_key_nonerror_throw",
        blueprintYaml: "x",
        serviceName: "svc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as RenderAdapterError;
    }
    expect(caught).toBeInstanceOf(RenderAdapterError);
    expect(caught?.message).toContain("raw string failure");
  });

  test("throws scrubbed error on non-2xx response", async () => {
    const key = "rnd_status500_key_longenough";
    const fetchImpl = fakeFetch(`upstream blew up with ${key}`, {
      status: 500,
      statusText: "Internal Server Error",
    });
    let caught: RenderAdapterError | undefined;
    try {
      await deployToRender({
        apiKey: key,
        blueprintYaml: "x",
        serviceName: "svc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as RenderAdapterError;
    }
    expect(caught?.message).toContain("Render API returned 500 Internal Server Error");
    expect(caught?.message).not.toContain(key);
    expect(caught?.message).toContain("[REDACTED:RENDER_API_KEY]");
  });

  test("throws scrubbed error when a 2xx body is not JSON", async () => {
    const key = "rnd_nonjson_body_key_longxx";
    const fetchImpl = fakeFetch(`<html>not json ${key}</html>`, { status: 200 });
    let caught: RenderAdapterError | undefined;
    try {
      await deployToRender({
        apiKey: key,
        blueprintYaml: "x",
        serviceName: "svc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as RenderAdapterError;
    }
    expect(caught?.message).toContain("Render API returned non-JSON body");
    expect(caught?.message).not.toContain(key);
    expect(caught?.message).toContain("[REDACTED:RENDER_API_KEY]");
  });

  test("throws scrubbed error when the JSON body has no service id", async () => {
    const key = "rnd_missing_id_key_longenough";
    const fetchImpl = fakeFetch(JSON.stringify({ deploy: { id: "d-1" }, hint: key }), {
      status: 201,
    });
    let caught: RenderAdapterError | undefined;
    try {
      await deployToRender({
        apiKey: key,
        blueprintYaml: "x",
        serviceName: "svc",
        fetchImpl,
      });
    } catch (err) {
      caught = err as RenderAdapterError;
    }
    expect(caught?.message).toContain("missing service id");
    expect(caught?.message).not.toContain(key);
    expect(caught?.message).toContain("[REDACTED:RENDER_API_KEY]");
  });

  test("falls back to top-level `id` when `service.id` is absent", async () => {
    const fetchImpl = fakeFetch(
      JSON.stringify({ id: "srv-top-level", deploy: { id: "d-9", status: "live" } }),
      { status: 201 },
    );
    const result = await deployToRender({
      apiKey: "rnd_toplevel_id_key_long",
      blueprintYaml: "x",
      serviceName: "svc",
      fetchImpl,
    });
    expect(result.serviceId).toBe("srv-top-level");
  });

  test("applies default deployId/status/url when those fields are absent", async () => {
    const fetchImpl = fakeFetch(JSON.stringify({ service: { id: "srv-min" } }), { status: 201 });
    const result = await deployToRender({
      apiKey: "rnd_defaults_key_longenough",
      blueprintYaml: "x",
      serviceName: "svc",
      fetchImpl,
    });
    expect(result.serviceId).toBe("srv-min");
    expect(result.deployId).toBe("");
    expect(result.status).toBe("pending");
    expect(result.url).toBeUndefined();
  });

  test("surfaces serviceDetails.url when present", async () => {
    const fetchImpl = fakeFetch(
      JSON.stringify({
        service: { id: "srv-u" },
        deploy: { id: "d-u", status: "live" },
        serviceDetails: { url: "https://svc-u.onrender.com" },
      }),
      { status: 201 },
    );
    const result = await deployToRender({
      apiKey: "rnd_url_present_key_long",
      blueprintYaml: "x",
      serviceName: "svc",
      fetchImpl,
    });
    expect(result.url).toBe("https://svc-u.onrender.com");
  });

  test("honors a custom apiBaseUrl (VCR-style override)", async () => {
    let observedUrl: string | undefined;
    const fetchImpl = (async (url: string | URL) => {
      observedUrl = String(url);
      return new Response(
        JSON.stringify({ service: { id: "srv-vcr" }, deploy: { id: "d", status: "ok" } }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    await deployToRender({
      apiKey: "rnd_custom_base_key_long",
      blueprintYaml: "x",
      serviceName: "svc",
      apiBaseUrl: "http://localhost:9999/mock",
      fetchImpl,
    });
    expect(observedUrl).toBe("http://localhost:9999/mock/services");
    expect(observedUrl).not.toBe(`${RENDER_DEFAULT_API_BASE}/services`);
  });
});
