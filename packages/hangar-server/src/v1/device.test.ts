/**
 * Device sign-in over HTTP: a client starts a sign-in on the sign-in routes, a member signed
 * in to Home in a browser looks up its code and allows it, and the client's next poll
 * collects a personal token, sealed to that poll's key, that signs in as that member.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeSeal } from "@crewhaus/control-contract/http";
import { type V1Home, v1Home } from "../__test__/v1-home";

let home: V1Home;
/** Home's clock, moved by hand past the poll interval. */
let offset = 0;

beforeAll(async () => {
  home = await v1Home({ now: () => Date.now() + offset });
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

async function start(body: Record<string, unknown> = {}) {
  const pair = await makeSeal();
  const res = await home.call("POST", "/api/v1/auth/device", {
    body: { seal: pair.seal, clientName: "laptop", ...body },
    secret: null,
  });
  expect(res.status).toBe(200);
  const pollRef = await pair.open(res.body["issued"], "auth.device.start");
  return { res, pollRef, userCode: String(res.body["userCode"]) };
}

async function poll(pollRef: string) {
  const pair = await makeSeal();
  const res = await home.call("POST", "/api/v1/auth/device/poll", {
    body: { pollRef, seal: pair.seal },
    secret: null,
  });
  return { res, pair };
}

describe("a device signs in with a short code", () => {
  test("start, look up, allow, collect: the token signs in as the member who allowed it", async () => {
    const s = await start();
    expect(s.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(String(s.res.body["verificationUrl"]).endsWith("/#/device")).toBe(true);
    // The code never appears in a path, and the poll reference only sealed.
    expect(JSON.stringify(s.res.body)).not.toContain(s.pollRef);
    const looked = await home.call("POST", "/api/v1/access/device-requests/lookup", {
      body: { code: s.userCode.toLowerCase().replace("-", "") },
    });
    expect(looked.status).toBe(200);
    expect(looked.body).toMatchObject({
      state: "pending",
      readOnly: false,
      clientName: "laptop",
      tokenDays: 90,
    });
    const pending = await poll(s.pollRef);
    expect(pending.res.body).toEqual({ state: "pending" });
    const allowed = await home.call("POST", "/api/v1/access/device-requests/decide", {
      body: { code: s.userCode, choice: "allow" },
    });
    expect(allowed.status).toBe(200);
    expect((allowed.body["receipt"] as Record<string, unknown>)["kind"]).toBe("auth.device.decide");
    offset += 6_000;
    const collected = await poll(s.pollRef);
    expect(collected.res.status).toBe(200);
    const token = await collected.pair.open(collected.res.body["issued"], "auth.device.poll");
    expect(token.startsWith("chp_")).toBe(true);
    const me = await home.call("GET", "/api/v1/me", { secret: token });
    expect(me.status).toBe(200);
    expect((me.body["principal"] as Record<string, unknown>)["id"]).toBe(home.owner);
    // Owner-held access management is never the token's.
    expect((me.body["can"] as Record<string, boolean>)["home.access.manage"]).toBe(false);
  });

  test("a wrong code is refused in words, and a token cannot allow a sign-in", async () => {
    const wrong = await home.call("POST", "/api/v1/access/device-requests/lookup", {
      body: { code: "BBBB-BBBB" },
    });
    expect(wrong.status).toBe(404);
    expect((wrong.body["error"] as Record<string, unknown>)["reason"]).toBe("code_unknown");
    const s = await start();
    const svc = await home.service("bot", [], { permissions: ["home.read"] });
    const refused = await home.call("POST", "/api/v1/access/device-requests/decide", {
      body: { code: s.userCode, choice: "allow" },
      secret: svc.secret,
    });
    expect(refused.status).toBe(403);
    expect((refused.body["error"] as Record<string, unknown>)["reason"]).toBe("session_required");
  });
});
