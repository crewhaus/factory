/**
 * The console's v1 client: every path comes from the operation table Home publishes, and
 * one user action carries one Idempotency-Key, the same on its retry. It never throws:
 * Home offline or a table it could not read comes back as an answer, and a session that
 * ended is signed in again and the call sent once more with its key.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { onUnauthorized } from "../assets/js/api.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { call, createAction, pathFor, resetDiscovery } from "../assets/js/v1.js";

type Seen = { url: string; init: RequestInit };

/** A discovery document whose paths no real table has, so a built path proves its source. */
const PLANTED = {
  protocol: "crewhaus.hangar.v1",
  signIn: { methods: ["browser", "device"] },
  operations: [
    { id: "things.list", method: "GET", path: "/api/v1/planted/{h}/things" },
    { id: "auth.device.decide", method: "POST", path: "/api/v1/somewhere/decide" },
    { id: "decisions.get", method: "GET", path: "/api/v1/d/{ref}" },
  ],
};

function home(answers: (url: string) => Response) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return url === "/api/v1" ? Response.json(PLANTED) : answers(url);
  };
  return { seen, fetchImpl };
}

beforeEach(() => resetDiscovery());
afterEach(() => onUnauthorized(null));

describe("the v1 client", () => {
  test("builds paths from the planted table only, and reads it once", async () => {
    const { seen, fetchImpl } = home(() => Response.json({ items: [] }));
    const first = await call(
      "things.list",
      { params: { h: "alpha" }, query: { limit: "2" } },
      fetchImpl,
    );
    expect(first.ok).toBe(true);
    await call("things.list", { params: { h: "bravo" } }, fetchImpl);
    expect(seen.map((s) => s.url)).toEqual([
      "/api/v1",
      "/api/v1/planted/alpha/things?limit=2",
      "/api/v1/planted/bravo/things",
    ]);
    expect(new Headers(seen[1]?.init.headers).get("CrewHaus-Protocol")).toBe("crewhaus.hangar.v1");
    expect(pathFor({ path: "/a/{ref}" }, { ref: "x/y/z" })).toBe("/a/x/y/z");
    expect(pathFor({ path: "/a/{h}" }, {})).toBeNull();
  });

  test("an operation the table does not hold is not called", async () => {
    const { seen, fetchImpl } = home(() => Response.json({}));
    const answer = await call("harnesses.list", {}, fetchImpl);
    expect(answer.ok).toBe(false);
    expect(seen.map((s) => s.url)).toEqual(["/api/v1"]);
  });

  test("one action sends one key, the same on its retry", async () => {
    let attempts = 0;
    const { seen, fetchImpl } = home(() => {
      attempts++;
      return attempts === 1
        ? Response.json(
            { error: { code: "unavailable", message: "busy", retryable: true } },
            { status: 503 },
          )
        : Response.json({ receipt: { id: "cmd_x" } });
    });
    const action = createAction(
      "auth.device.decide",
      { body: { code: "BCDF-GHJK", choice: "allow" } },
      fetchImpl,
    );
    const failed = await action.run();
    expect(failed.ok).toBe(false);
    expect(failed.error.code).toBe("unavailable");
    const retried = await action.run();
    expect(retried.ok).toBe(true);
    const keys = seen
      .filter((s) => s.url !== "/api/v1")
      .map((s) => new Headers(s.init.headers).get("Idempotency-Key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1] as string);
    expect(keys[0]).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    const other = createAction("auth.device.decide", {}, fetchImpl);
    expect(other.key).not.toBe(action.key);
  });

  test("an error comes back in the envelope's own words", async () => {
    const { fetchImpl } = home(() =>
      Response.json(
        {
          error: {
            code: "forbidden",
            message: "no",
            retryable: false,
            needs: "h.read",
            verb: "crewhaus harness list",
            reason: "permission",
          },
        },
        { status: 403 },
      ),
    );
    const answer = await call("decisions.get", { params: { ref: "a/b/c" } }, fetchImpl);
    expect(answer).toMatchObject({
      ok: false,
      status: 403,
      error: {
        code: "forbidden",
        message: "no",
        needs: "h.read",
        verb: "crewhaus harness list",
        reason: "permission",
      },
    });
  });

  test("Home offline answers, never throws, and the next call reads the table again", async () => {
    let up = false;
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      if (!up) throw new Error("offline");
      return url === "/api/v1" ? Response.json(PLANTED) : Response.json({ ok: 1 });
    };
    const answer = await call("auth.device.decide", { body: {} }, fetchImpl);
    expect(answer).toMatchObject({ ok: false, status: 0, error: { code: "unavailable" } });
    up = true;
    expect((await call("auth.device.decide", { body: {} }, fetchImpl)).ok).toBe(true);
    expect(seen).toEqual(["/api/v1", "/api/v1", "/api/v1/somewhere/decide"]);
  });

  test("a table refused with 401 and no way to sign in again is an answer", async () => {
    const fetchImpl = async () =>
      Response.json(
        { error: { code: "unauthenticated", message: "missing", reason: "no_credential" } },
        { status: 401 },
      );
    const answer = await call("auth.device.decide", { body: {} }, fetchImpl);
    expect(answer).toMatchObject({
      ok: false,
      status: 401,
      error: { code: "unauthenticated", reason: "no_credential" },
    });
  });

  test("a session that ended is signed in again, then the call goes once more with its key", async () => {
    let signedIn = false;
    let asked = 0;
    onUnauthorized(() => {
      asked += 1;
      signedIn = true;
      return true;
    });
    const seen: Seen[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (!signedIn && url !== "/api/v1") {
        return Response.json({ error: { code: "unauthenticated", message: "x" } }, { status: 401 });
      }
      return url === "/api/v1" ? Response.json(PLANTED) : Response.json({ receipt: {} });
    };
    const action = createAction("auth.device.decide", { body: { code: "c" } }, fetchImpl);
    const answer = await action.run();
    expect(answer.ok).toBe(true);
    expect(asked).toBe(1);
    // The table was read again after signing in, and both sends carried one key.
    expect(seen.map((s) => s.url)).toEqual([
      "/api/v1",
      "/api/v1/somewhere/decide",
      "/api/v1",
      "/api/v1/somewhere/decide",
    ]);
    const keys = seen
      .filter((s) => s.url !== "/api/v1")
      .map((s) => new Headers(s.init.headers).get("Idempotency-Key"));
    expect(keys).toEqual([action.key, action.key]);
  });

  test("a 401 reading the table signs in again too, and is retried once at most", async () => {
    let asked = 0;
    onUnauthorized(() => {
      asked += 1;
      return true;
    });
    const fetchImpl = async () =>
      Response.json({ error: { code: "unauthenticated", message: "x" } }, { status: 401 });
    const answer = await call("auth.device.decide", { body: {} }, fetchImpl);
    expect(answer.status).toBe(401);
    expect(asked).toBe(1);
  });
});
