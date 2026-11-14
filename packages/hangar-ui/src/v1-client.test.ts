/**
 * The console's v1 client: every path comes from the operation table Home publishes, and
 * one user action carries one Idempotency-Key, the same on its retry.
 */
import { beforeEach, describe, expect, test } from "bun:test";
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
});
