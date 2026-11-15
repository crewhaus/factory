/**
 * Device sign-in over HTTP: a client starts a sign-in on the sign-in routes, a member signed
 * in to Home in a browser looks up its code and allows it, and the client's next poll
 * collects a personal token, sealed to that poll's key, that signs in as that member.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEVICE_LIMITS, isLoopbackAddress, openDeviceRequests } from "@crewhaus/access-control";
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
    // Where it came from is what Home saw on its own listener, and when it arrived.
    const from = looked.body["requestedFrom"] as { via?: string; address?: string };
    expect(from.via).toBe("direct");
    expect(isLoopbackAddress(from.address)).toBe(true);
    expect(Number.isNaN(Date.parse(String(looked.body["createdAt"])))).toBe(false);
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

describe("a device's name", () => {
  test("is refused with a bidi or invisible character, and nothing is recorded", async () => {
    const before = openDeviceRequests(home.t.hangarRoot).read().length;
    for (const clientName of ["lap\u202etop", "lap\u2066top", "lap\u200btop"]) {
      const pair = await makeSeal();
      const res = await home.call("POST", "/api/v1/auth/device", {
        body: { seal: pair.seal, clientName },
        secret: null,
      });
      expect(res.status).toBe(400);
      expect((res.body["error"] as Record<string, unknown>)["reason"]).toBe("body_invalid");
    }
    expect(openDeviceRequests(home.t.hangarRoot).read()).toHaveLength(before);
    // The name `crewhaus login` gives from a host name passes.
    await start({ clientName: "crewhaus CLI on my-mac.local" });
  });
});

describe("waiting sign-ins from one address", () => {
  test("a fifth is refused with when to ask again", async () => {
    const own = await v1Home();
    try {
      for (let i = 0; i < DEVICE_LIMITS.maxPendingPerPeer; i++) {
        const pair = await makeSeal();
        const res = await own.call("POST", "/api/v1/auth/device", {
          body: { seal: pair.seal },
          secret: null,
        });
        expect(res.status).toBe(200);
      }
      const pair = await makeSeal();
      const fifth = await own.call("POST", "/api/v1/auth/device", {
        body: { seal: pair.seal },
        secret: null,
      });
      expect(fifth.status).toBe(429);
      expect((fifth.body["error"] as Record<string, unknown>)["reason"]).toBe(
        "too_many_pending_here",
      );
      expect(Number(fifth.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      await own.t.stop();
    }
    // It boots a Home of its own, so its waiting requests reach no other test.
  }, 60_000);
});
