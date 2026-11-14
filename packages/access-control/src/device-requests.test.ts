/**
 * Device sign-in with a short code: start, look up, allow, then the first poll collects a
 * sealed personal token that signs in as the member who allowed it. Every refusal is
 * asserted by its reason, and the clock is faked.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSeal } from "@crewhaus/control-contract/http";
import { authenticate } from "./authenticate";
import { DEVICE_LIMITS, openDeviceRequests } from "./device-requests";
import { accessPaths } from "./paths";
import { sealSecret } from "./sealed";
import { openSignIn } from "./sign-in";
import { LOCAL, homeFixture, ok, removeTempDirs } from "./test-helpers";

afterAll(removeTempDirs);

async function home() {
  const fixture = await homeFixture();
  const member = ok(
    await fixture.access.grant(fixture.actor, {
      member: "Sam",
      create: true,
      role: "operator",
      scope: "home",
    }),
  ).principal;
  const devices = openDeviceRequests(fixture.root, { now: fixture.clock.now });
  return { ...fixture, member, devices };
}

function started(answer: Awaited<ReturnType<ReturnType<typeof openDeviceRequests>["start"]>>) {
  if (!answer.ok) throw new Error(`expected a start, got ${answer.reason}`);
  return answer;
}

describe("a device sign-in", () => {
  test("start, look up, allow, then the first poll yields a token that signs in", async () => {
    const h = await home();
    const start = started(await h.devices.start({ clientName: "laptop" }));
    expect(start.userCode).toMatch(/^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/);
    expect(start.pollRef).toMatch(/^[0-9a-f]{64}$/);
    expect(start.intervalMs).toBe(DEVICE_LIMITS.intervalMs);

    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "pending" });
    // A lower-case code with no hyphen is the same code.
    const looked = await h.devices.lookup(h.member, start.userCode.replace("-", "").toLowerCase());
    expect(looked).toEqual({
      ok: true,
      request: {
        state: "pending",
        readOnly: false,
        expiresAt: start.expiresAt,
        clientName: "laptop",
        tokenDays: 90,
      },
    });
    expect(
      await h.devices.decide({ caller: h.member, code: start.userCode, choice: "allow" }),
    ).toEqual({ ok: true, state: "allowed" });
    // Nothing exists until the client collects it.
    expect(h.snapshot().tokens.filter((t) => t.kind === "personal")).toHaveLength(0);

    h.clock.advance(DEVICE_LIMITS.intervalMs);
    const collected = await h.devices.poll(start.pollRef);
    if (!collected.ok || collected.state !== "allowed") throw new Error("expected the token");
    expect(collected.secret.startsWith("chp_")).toBe(true);
    const row = h.snapshot().tokens.find((t) => t.id === collected.token.id);
    expect(row).toMatchObject({ kind: "personal", principal: h.member, state: "active" });
    expect(Date.parse(row?.expiresAt ?? "") - h.clock.now()).toBe(90 * 24 * 60 * 60 * 1000);

    // The secret travels sealed to the poll's own key, for this operation only.
    const pair = await makeSeal();
    const sealed = await sealSecret(pair.seal, collected.secret, "auth.device.poll");
    expect(await pair.open(sealed, "auth.device.poll")).toBe(collected.secret);
    await expect(pair.open(sealed, "auth.device.start")).rejects.toThrow();

    const signIn = openSignIn(h.root, { now: h.clock.now, localActor: LOCAL });
    const who = await authenticate(
      new Request("http://127.0.0.1/api/v1/me", {
        headers: { authorization: `Bearer ${collected.secret}` },
      }),
      { address: "203.0.113.9", listener: "tcp" },
      {},
      { signIn, bootToken: undefined, now: h.clock.now },
    );
    expect(who).toMatchObject({ kind: "principal", principal: h.member, via: "personal" });

    h.clock.advance(DEVICE_LIMITS.intervalMs);
    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "consumed" });
    expect(h.snapshot().tokens.filter((t) => t.kind === "personal")).toHaveLength(1);
  });

  test("deny answers denied, and the code is spent", async () => {
    const h = await home();
    const start = started(await h.devices.start({}));
    expect(
      await h.devices.decide({ caller: h.member, code: start.userCode, choice: "deny" }),
    ).toEqual({
      ok: true,
      state: "denied",
    });
    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "denied" });
    const again = await h.devices.lookup(h.member, start.userCode);
    expect(again.ok === false && again.reason).toBe("code_used");
  });

  test("a code expires after ten minutes, and an allowed one not collected by then too", async () => {
    const h = await home();
    const start = started(await h.devices.start({}));
    h.clock.advance(DEVICE_LIMITS.codeTtlMs);
    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "expired" });
    const late = await h.devices.lookup(h.member, start.userCode);
    expect(late.ok === false && late.reason).toBe("code_expired");

    const second = started(await h.devices.start({}));
    ok(
      (await h.devices.decide({ caller: h.member, code: second.userCode, choice: "allow" })).ok
        ? { ok: true, result: null }
        : { ok: false, reason: "decide" },
    );
    h.clock.advance(DEVICE_LIMITS.codeTtlMs);
    expect(await h.devices.poll(second.pollRef)).toEqual({ ok: true, state: "expired" });
    expect(h.snapshot().tokens.filter((t) => t.kind === "personal")).toHaveLength(0);
  });

  test("the thirty-third waiting request is refused", async () => {
    const h = await home();
    for (let i = 0; i < DEVICE_LIMITS.maxPending; i++) started(await h.devices.start({}));
    const refused = await h.devices.start({});
    expect(refused).toMatchObject({ ok: false, code: "rate_limited", reason: "too_many_pending" });
    // Once those expire, the next writer drops them and a start is taken again.
    h.clock.advance(DEVICE_LIMITS.codeTtlMs);
    started(await h.devices.start({}));
    expect(h.devices.read()).toHaveLength(1);
  });

  test("a poll that comes too soon is slowed down by five seconds", async () => {
    const h = await home();
    const start = started(await h.devices.start({}));
    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "pending" });
    h.clock.advance(1_000);
    const soon = await h.devices.poll(start.pollRef);
    expect(soon).toMatchObject({ ok: false, code: "rate_limited", reason: "slow_down" });
    expect(soon.ok === false && soon.retryAfterMs).toBe(
      DEVICE_LIMITS.intervalMs + DEVICE_LIMITS.slowDownMs,
    );
    h.clock.advance(DEVICE_LIMITS.intervalMs);
    // Still inside the slower interval.
    const still = await h.devices.poll(start.pollRef);
    expect(still.ok === false && still.reason).toBe("slow_down");
  });

  test("the eleventh failed lookup is refused, even with the right code", async () => {
    const h = await home();
    const start = started(await h.devices.start({}));
    for (let i = 0; i < DEVICE_LIMITS.lookupFailures; i++) {
      const wrong = await h.devices.lookup(h.member, "BBBB-BBBB");
      expect(wrong.ok === false && wrong.reason).toBe("code_unknown");
    }
    const blocked = await h.devices.lookup(h.member, start.userCode);
    expect(blocked).toMatchObject({ ok: false, code: "rate_limited", reason: "too_many_tries" });
    // Another member's tries are their own.
    const other = ok(
      await h.access.grant(h.actor, { member: "Ana", create: true, role: "viewer", scope: "home" }),
    ).principal;
    expect((await h.devices.lookup(other, start.userCode)).ok).toBe(true);
    // Once the window passes the caller is heard again (the code has ended by then too).
    h.clock.advance(DEVICE_LIMITS.lookupWindowMs);
    const later = await h.devices.lookup(h.member, start.userCode);
    expect(later.ok === false && later.reason).toBe("code_expired");
  });

  test("only an active member decides", async () => {
    const h = await home();
    const start = started(await h.devices.start({}));
    const svc = ok(
      await h.access.mintServiceToken(h.actor, { service: "bot", permissions: [], harnesses: [] }),
    ).principal;
    const refused = await h.devices.decide({ caller: svc, code: start.userCode, choice: "allow" });
    expect(refused).toMatchObject({ ok: false, code: "forbidden", reason: "member_required" });
  });

  test("a read-only request mints a read-only token", async () => {
    const h = await home();
    const start = started(await h.devices.start({ readOnly: true }));
    await h.devices.decide({ caller: h.member, code: start.userCode, choice: "allow" });
    const collected = await h.devices.poll(start.pollRef);
    if (!collected.ok || collected.state !== "allowed") throw new Error("expected the token");
    expect(h.snapshot().tokens.find((t) => t.id === collected.token.id)?.readOnly).toBe(true);
  });

  test("the file holds no raw code and no raw poll reference, and moves no revision", async () => {
    const h = await home();
    const before = readFileSync(join(h.root, accessPaths().revision), "utf8");
    const start = started(await h.devices.start({}));
    await h.devices.poll(start.pollRef);
    await h.devices.decide({ caller: h.member, code: start.userCode, choice: "deny" });
    const text = readFileSync(join(h.root, accessPaths().deviceRequests), "utf8");
    expect(text).not.toContain(start.userCode);
    expect(text).not.toContain(start.userCode.replace("-", ""));
    expect(text).not.toContain(start.pollRef);
    expect(readFileSync(join(h.root, accessPaths().revision), "utf8")).toBe(before);
  });

  test("a Home with no access records refuses to start one, and creates nothing", async () => {
    const { tempDir } = await import("./test-helpers");
    const root = tempDir();
    const devices = openDeviceRequests(root);
    expect(await devices.start({})).toMatchObject({ ok: false, reason: "access_not_set_up" });
    expect((await import("node:fs")).existsSync(join(root, "access"))).toBe(false);
  });
});
