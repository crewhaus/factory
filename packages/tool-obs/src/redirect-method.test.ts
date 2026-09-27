/**
 * A redirect turns only a POST into a GET on a 301 or 302 (net review of
 * 0.7.1).
 *
 * openRequest rewrote any method but GET and HEAD to a GET without its body
 * on a 301, 302 or 303. The Fetch Standard, browsers and curl rewrite only
 * a POST on a 301 or 302. A PUT, PATCH or DELETE sent to a moved resource
 * therefore arrived as a GET, and the call reported the 200 of a read for
 * an update or a delete that never happened.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { __setPrivateHostsAllowedForTest, buildObsConfig, openRequest } from "./net";

let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/301")
        return new Response(null, { status: 301, headers: { location: "/echo" } });
      if (path === "/302")
        return new Response(null, { status: 302, headers: { location: "/echo" } });
      if (path === "/303")
        return new Response(null, { status: 303, headers: { location: "/echo" } });
      return Response.json({ method: req.method, body: await req.text() });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  __setPrivateHostsAllowedForTest(true);
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
});

async function hop(status: number, method: string): Promise<{ method: string; body: string }> {
  const opened = await openRequest({
    url: new URL(`${origin}/${status}`),
    method,
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
    signal: AbortSignal.timeout(10_000),
    cfg: buildObsConfig({ allowed_origins: [origin] }),
  });
  return (await opened.res.json()) as { method: string; body: string };
}

describe("the method a redirect keeps", () => {
  test("a 301 or 302 after a PUT, PATCH or DELETE keeps the method and body", async () => {
    let checked = 0;
    for (const status of [301, 302]) {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        expect({ status, seen: await hop(status, method) }).toEqual({
          status,
          seen: { method, body: '{"a":1}' },
        });
        checked += 1;
      }
    }
    expect(checked).toBe(6);
  });

  test("a POST becomes a GET without its body on a 301, 302 or 303, and a 303 does so to any method", async () => {
    let checked = 0;
    for (const [status, method] of [
      [301, "POST"],
      [302, "POST"],
      [303, "POST"],
      [303, "PUT"],
      [303, "DELETE"],
    ] as const) {
      expect({ status, method, seen: await hop(status, method) }).toEqual({
        status,
        method,
        seen: { method: "GET", body: "" },
      });
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});
