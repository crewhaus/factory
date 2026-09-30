/**
 * A probe the gate refused is reported as refused, not as down (C119,
 * config-delivery#5, security-8#17).
 *
 * UrlReachable, LinkCheck and (in tool-obs) HealthProbe folded every error
 * into the negative bucket, so a URL the allow-list or the SSRF check
 * refused — nothing sent, nothing learned — came back `reachable: false`,
 * counted in `brokenCount`. With the allow-list unset, every URL was
 * "down". LinkCheck also counted a URL the sweep deadline never reached as
 * broken.
 *
 * Now a refusal is `refused` (a redirect the gate would not follow keeps
 * the status the endpoint DID answer with), a URL never reached is
 * `skipped`, both with `ok: null`, and neither is counted as broken. A name
 * that does not resolve is still broken: that is a fact about the network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  __setPrivateHostsAllowedForTest,
  _resetHttpConfig,
  _setDnsLookup,
  linkCheck,
  registerHttpConfig,
  urlReachable,
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
      if (path === "/away") return Response.redirect("http://elsewhere.example.test/x", 302);
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
  registerHttpConfig({ allowed_origins: [origin] });
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
  _setDnsLookup(undefined);
  _resetHttpConfig();
});

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
const run = async (tool: typeof linkCheck, input: unknown): Promise<any> =>
  JSON.parse(String(await tool.execute(input, {} as never)));

describe("UrlReachable (C119)", () => {
  test("a URL the allow-list refuses was never probed: reachable is null, not false", async () => {
    _resetHttpConfig();
    const result = await run(urlReachable, { url: "https://example.com/" });
    expect(result).toEqual({
      reachable: null,
      refused: true,
      error:
        'denied: origin "https://example.com" is not in allowed_origins (empty allow-list = deny all)',
    });
    expect(hits).toEqual([]);
  });

  test("an endpoint that answered with a redirect the gate would not follow did answer", async () => {
    const result = await run(urlReachable, { url: `${origin}/away` });
    expect(result).toMatchObject({ reachable: true, status: 302, ok: null });
    expect(result.redirectRefused).toContain("not in allowed_origins");
    expect(hits).toEqual(["/away"]);
  });

  test("an allow-listed private address is refused by the SSRF check, not called down", async () => {
    __setPrivateHostsAllowedForTest(false);
    registerHttpConfig({ allowed_origins: ["http://10.0.0.1"] });
    const result = await run(urlReachable, { url: "http://10.0.0.1/health" });
    expect(result.reachable).toBe(null);
    expect(result.error).toContain("SSRF");
  });

  test("a name that does not resolve is still unreachable", async () => {
    registerHttpConfig({ allowed_origins: ["https://nx.example.test"] });
    _setDnsLookup(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND nx.example.test"), {
        code: "ENOTFOUND",
      });
    });
    const result = await run(urlReachable, { url: "https://nx.example.test/" });
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("cannot resolve");
  });
});

describe("LinkCheck (C119)", () => {
  test("a refused URL is counted as refused, not broken", async () => {
    const result = await run(linkCheck, {
      urls: [`${origin}/fine`, "http://example.com/off", `${origin}/away`],
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      checked: 3,
      okCount: 1,
      brokenCount: 0,
      refusedCount: 2,
      skippedCount: 0,
    });
    expect(result.results[1]).toMatchObject({ ok: null, refused: true });
    expect(result.results[2]).toMatchObject({ ok: null, refused: true, status: 302 });
    // The refused URL was never requested; the redirecting one was, once.
    expect(hits.sort()).toEqual(["/away", "/fine"]);
  });

  test("a name that does not resolve is still a broken link", async () => {
    registerHttpConfig({ allowed_origins: ["https://nx.example.test"] });
    _setDnsLookup(async () => {
      throw new Error("getaddrinfo ENOTFOUND nx.example.test");
    });
    const result = await run(linkCheck, { urls: ["https://nx.example.test/"], timeoutMs: 5_000 });
    expect(result).toMatchObject({ brokenCount: 1, refusedCount: 0 });
    expect(result.results[0].ok).toBe(false);
  });

  test("URLs the sweep deadline never reached are skipped, not broken", async () => {
    // One at a time: the first holds the whole sweep (the endpoint answers
    // after 5 s, the sweep allows 300 ms), so the other two are never begun.
    const result = await run(linkCheck, {
      urls: [`${origin}/slow`, `${origin}/fine`, `${origin}/fine`],
      concurrency: 1,
      timeoutMs: 300,
    });
    expect(result).toMatchObject({ brokenCount: 1, skippedCount: 2, refusedCount: 0, okCount: 0 });
    expect(result.results[1]).toMatchObject({ ok: null, skipped: true });
    // Whether /slow's request got out before the deadline is the runner's
    // business; that the other two were never begun is the tool's.
    expect(hits.includes("/fine")).toBe(false);
  }, 20_000);
});
