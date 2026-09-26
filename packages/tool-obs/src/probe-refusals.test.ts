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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  __setPrivateHostsAllowedForTest,
  _resetObsConfig,
  _setDnsLookup,
  _setRawFetch,
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

describe("HealthProbe probes nothing once its signal has aborted", () => {
  // The skip gate asked the clock, which lags the deadline's timer and never
  // sees a cancel. A probe it let through started on an aborted signal and
  // failed at once, so an endpoint nobody reached was counted unhealthy. The
  // stub hangs until aborted and counts every probe the sweep starts.
  let issued = 0;
  beforeEach(() => {
    issued = 0;
    _setRawFetch(async (req) => {
      issued++;
      return await new Promise<Response>((_resolve, reject) => {
        const fail = (): void => reject(req.signal.reason);
        if (req.signal.aborted) fail();
        else req.signal.addEventListener("abort", fail, { once: true });
      });
    });
  });
  afterEach(() => {
    _setRawFetch(undefined);
  });

  const urls = (): string[] => [`${origin}/a`, `${origin}/b`, `${origin}/c`];

  test("the sweep deadline's timer skips the endpoints left, while the clock says time is left", async () => {
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const result = await probe({ urls: urls(), deadlineMs: 50, concurrency: 1 });
      expect({
        issued,
        counts: [result.healthy, result.unhealthy, result.skipped],
        errors: result.probes.map((p: { error?: string }) => p.error),
      }).toEqual({
        issued: 1,
        counts: [0, 1, 2],
        errors: [
          "deadline elapsed before the request completed",
          "the sweep deadline elapsed before this endpoint was probed",
          "the sweep deadline elapsed before this endpoint was probed",
        ],
      });
    } finally {
      now.mockRestore();
    }
  });

  test("a cancel skips the endpoints left, and says it was a cancel", async () => {
    const runtime = new AbortController();
    _setRawFetch(async (req) => {
      issued++;
      // The runtime cancels while the first probe is in flight.
      runtime.abort();
      throw req.signal.reason;
    });
    const result = JSON.parse(
      String(
        await healthProbe.execute(
          { urls: urls(), deadlineMs: 60_000, concurrency: 1 },
          { toolUseId: "t", signal: runtime.signal },
        ),
      ),
    );
    expect({
      issued,
      counts: [result.healthy, result.unhealthy, result.skipped],
      errors: result.probes.map((p: { error?: string }) => p.error),
    }).toEqual({
      issued: 1,
      counts: [0, 1, 2],
      errors: [
        "the request was aborted before it completed",
        "the sweep was cancelled before this endpoint was probed",
        "the sweep was cancelled before this endpoint was probed",
      ],
    });
  });
});
