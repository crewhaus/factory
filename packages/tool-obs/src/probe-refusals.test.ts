/**
 * HealthProbe reports an endpoint the gate refused as refused, not as
 * unhealthy (C119, config-delivery#5, security-8#17).
 *
 * 0.7.0 counted every error as `unhealthy`, so an endpoint the allow-list
 * or the SSRF check refused — never probed — was reported down, and with
 * the allow-list unset every endpoint was. Now a refusal is `refused` (a
 * redirect the gate would not follow keeps the status the endpoint DID
 * answer with), and it and a skipped probe carry `ok: null`: neither
 * healthy nor unhealthy. A name that does not resolve is still unhealthy.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  __setPrivateHostsAllowedForTest,
  _resetObsConfig,
  _setDnsLookup,
  healthProbe,
  registerObsConfig,
} from "./index";

let server: ReturnType<typeof Bun.serve>;
let origin = "";
let hits: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path === "/away") return Response.redirect("http://elsewhere.example.test/h", 302);
      if (path === "/slow") {
        await Bun.sleep(5_000);
        return new Response("late");
      }
      return new Response("ok");
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  hits = [];
  __setPrivateHostsAllowedForTest(true);
  registerObsConfig({ allowed_origins: [origin] });
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
  _setDnsLookup(undefined);
  _resetObsConfig();
});

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
const probe = async (input: unknown): Promise<any> =>
  JSON.parse(String(await healthProbe.execute(input, {} as never)));

describe("HealthProbe separates refused from unhealthy (C119)", () => {
  test("with no allow-list, nothing is probed and nothing is called unhealthy", async () => {
    _resetObsConfig();
    const result = await probe({ urls: ["https://example.com/h"], deadlineMs: 2_000 });
    expect(result).toMatchObject({ probed: 1, healthy: 0, unhealthy: 0, refused: 1, skipped: 0 });
    expect(result.probes[0]).toMatchObject({ ok: null, refused: true });
    expect(result.probes[0].error).toContain("not in allowed_origins");
    expect(hits).toEqual([]);
  });

  test("an allowed endpoint and a refused one are counted apart", async () => {
    const result = await probe({
      urls: [`${origin}/fine`, "https://example.com/h", `${origin}/away`],
      deadlineMs: 5_000,
    });
    expect(result).toMatchObject({ healthy: 1, unhealthy: 0, refused: 2, skipped: 0 });
    const away = result.probes.find((p: { url: string }) => p.url.endsWith("/away"));
    // It answered, with a redirect the gate would not follow.
    expect(away).toMatchObject({ ok: null, refused: true, status: 302 });
    expect(hits.sort()).toEqual(["/away", "/fine"]);
  });

  test("a name that does not resolve is still unhealthy", async () => {
    registerObsConfig({ allowed_origins: ["https://nx.example.test"] });
    _setDnsLookup(async () => {
      throw new Error("getaddrinfo ENOTFOUND nx.example.test");
    });
    const result = await probe({ urls: ["https://nx.example.test/h"], deadlineMs: 2_000 });
    expect(result).toMatchObject({ unhealthy: 1, refused: 0 });
    expect(result.probes[0].ok).toBe(false);
  });

  test("a probe the deadline never reached is skipped with ok null", async () => {
    const result = await probe({
      urls: [`${origin}/slow`, `${origin}/fine`],
      deadlineMs: 300,
      concurrency: 1,
    });
    const fine = result.probes.find((p: { url: string }) => p.url.endsWith("/fine"));
    expect(fine).toMatchObject({ ok: null, skipped: true });
    expect(result.healthy).toBe(0);
    expect(hits.includes("/fine")).toBe(false);
  }, 20_000);
});
