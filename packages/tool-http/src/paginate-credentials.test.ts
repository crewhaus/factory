/**
 * HttpPaginate sends the call's credential only to the origin the call named
 * (C058, security-8#5).
 *
 * openRequest drops credentials when a REDIRECT changes origin, but that
 * rule reset on every call, and HttpPaginate's link style made one call per
 * page with the same headers: a `Link: <https://other/...>; rel="next"`
 * from the first origin sent the bearer token (or an X-Api-Key) to the
 * second, provided both were allow-listed. Worse, a first page that
 * redirected to the second origin had its token correctly dropped for that
 * hop, and then the second origin's own Link header got it re-attached on
 * the next page. HttpPaginate is readOnly, so plan and auto mode run it
 * unasked.
 *
 * Now every page's request carries the credential only when it is on the
 * origin the call named, the walk continues without it elsewhere (as a
 * redirect does), and the result says `credentialsDropped`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  __setPrivateHostsAllowedForTest,
  _resetHttpConfig,
  httpPaginate,
  registerHttpConfig,
} from "./index";

const TOKEN_VAR = "CREWHAUS_TEST_PAGINATE_TOKEN";
const TOKEN = "paginate-token-value-7c1d";

type Seen = {
  server: "A" | "B";
  path: string;
  authorization: string | null;
  apiKey: string | null;
};
let seen: Seen[] = [];

let a: ReturnType<typeof Bun.serve>;
let b: ReturnType<typeof Bun.serve>;
let originA = "";
let originB = "";

const page = (items: unknown[], next?: string): Response =>
  new Response(JSON.stringify({ items }), {
    headers: {
      "content-type": "application/json",
      ...(next !== undefined ? { link: `<${next}>; rel="next"` } : {}),
    },
  });

beforeAll(() => {
  a = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      seen.push({
        server: "A",
        path,
        authorization: req.headers.get("authorization"),
        apiKey: req.headers.get("x-api-key"),
      });
      if (path === "/list") return page([1], `${originB}/collect`);
      if (path === "/redir") return Response.redirect(`${originB}/start`, 302);
      if (path === "/p1") return page([1], "/p2");
      if (path === "/p2") return page([2]);
      if (path === "/moved") return Response.redirect(`${originA}/deep/page1`, 302);
      if (path === "/deep/page1") return page([1], "page2");
      if (path === "/deep/page2") return page([2]);
      return page([]);
    },
  });
  b = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      seen.push({
        server: "B",
        path,
        authorization: req.headers.get("authorization"),
        apiKey: req.headers.get("x-api-key"),
      });
      if (path === "/start") return page([1], `${originB}/collect`);
      return page([]);
    },
  });
  originA = `http://127.0.0.1:${a.port}`;
  originB = `http://127.0.0.1:${b.port}`;
});

afterAll(() => {
  a.stop(true);
  b.stop(true);
});

beforeEach(() => {
  seen = [];
  process.env[TOKEN_VAR] = TOKEN;
  __setPrivateHostsAllowedForTest(true);
  registerHttpConfig({ allowed_origins: [originA, originB], allowed_auth_envs: [TOKEN_VAR] });
});

afterEach(() => {
  delete process.env[TOKEN_VAR];
  __setPrivateHostsAllowedForTest(false);
  _resetHttpConfig();
});

const bearer = { type: "bearer", envVar: TOKEN_VAR } as const;
const apiKey = { type: "header", headerName: "X-Api-Key", envVar: TOKEN_VAR } as const;

async function walk(url: string, auth: unknown) {
  const out = String(
    await httpPaginate.execute(
      { url, style: "link", itemsPath: "items", maxPages: 5, timeoutMs: 5_000, auth },
      {} as never,
    ),
  );
  return JSON.parse(out) as {
    pages: number;
    stoppedBy: string;
    credentialsDropped: boolean;
    items: unknown[];
  };
}

describe("HttpPaginate's credential stays with the origin the call named (C058)", () => {
  for (const [kind, auth] of [
    ["a bearer token", bearer],
    ["an X-Api-Key header", apiKey],
  ] as const) {
    test(`${kind}: a Link to another origin is followed without it`, async () => {
      const result = await walk(`${originA}/list`, auth);
      expect(result).toMatchObject({ pages: 2, stoppedBy: "emptyPage", credentialsDropped: true });
      const onA = seen.filter((s) => s.server === "A");
      const onB = seen.filter((s) => s.server === "B");
      expect(onA).toHaveLength(1);
      expect(onA[0]?.authorization ?? onA[0]?.apiKey).toContain(TOKEN);
      expect(onB).toEqual([{ server: "B", path: "/collect", authorization: null, apiKey: null }]);
    });
  }

  test("a first page redirected to another origin does not get the token back from that origin's Link", async () => {
    const result = await walk(`${originA}/redir`, bearer);
    expect(result).toMatchObject({ pages: 2, credentialsDropped: true });
    const onB = seen.filter((s) => s.server === "B");
    expect(onB.map((s) => s.path)).toEqual(["/start", "/collect"]);
    expect(onB.every((s) => s.authorization === null)).toBe(true);
  });

  test("a same-origin walk keeps the credential on every page", async () => {
    const result = await walk(`${originA}/p1`, bearer);
    expect(result).toMatchObject({ pages: 2, credentialsDropped: false, items: [1, 2] });
    expect(seen.map((s) => s.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  test("a relative Link resolves against the page it came from, after a redirect", async () => {
    // /moved redirects to /deep/page1, whose `Link: <page2>` means
    // /deep/page2 — not /page2, which is what resolving against the URL the
    // walk asked for would give.
    const result = await walk(`${originA}/moved`, bearer);
    expect(result).toMatchObject({ pages: 2, items: [1, 2], credentialsDropped: false });
    expect(seen.map((s) => s.path)).toEqual(["/moved", "/deep/page1", "/deep/page2"]);
  });
});
