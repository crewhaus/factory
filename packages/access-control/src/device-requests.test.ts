/**
 * Device sign-in with a short code: start, look up, allow, then the first poll collects a
 * sealed personal token that signs in as the member who allowed it. Every refusal is
 * asserted by its reason, and the clock is faked.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSeal } from "@crewhaus/control-contract/http";
import * as records from "@crewhaus/control-records";
import { type TrustedProxy, authenticate, requesterOf } from "./authenticate";
import { DEVICE_LIMITS, type RequestedFrom, openDeviceRequests } from "./device-requests";
import { accessPaths } from "./paths";
import { sealSecret } from "./sealed";
import { sha256Hex } from "./secrets";
import { openSignIn } from "./sign-in";
import { LOCAL, homeFixture, ok, removeTempDirs } from "./test-helpers";

afterAll(removeTempDirs);

/** The address most requests here come from. */
const HERE: RequestedFrom = { via: "direct", address: "203.0.113.5" };

/** A different address for each `i`, each its own count. */
const from = (i: number): RequestedFrom => ({ via: "direct", address: `198.51.100.${i}` });

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
    const start = started(await h.devices.start({ clientName: "laptop", requestedFrom: HERE }));
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
        createdAt: new Date(h.clock.now()).toISOString(),
        requestedFrom: HERE,
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
    const start = started(await h.devices.start({ requestedFrom: HERE }));
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
    const start = started(await h.devices.start({ requestedFrom: HERE }));
    h.clock.advance(DEVICE_LIMITS.codeTtlMs);
    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "expired" });
    const late = await h.devices.lookup(h.member, start.userCode);
    expect(late.ok === false && late.reason).toBe("code_expired");

    const second = started(await h.devices.start({ requestedFrom: HERE }));
    ok(
      (await h.devices.decide({ caller: h.member, code: second.userCode, choice: "allow" })).ok
        ? { ok: true, result: null }
        : { ok: false, reason: "decide" },
    );
    h.clock.advance(DEVICE_LIMITS.codeTtlMs);
    expect(await h.devices.poll(second.pollRef)).toEqual({ ok: true, state: "expired" });
    expect(h.snapshot().tokens.filter((t) => t.kind === "personal")).toHaveLength(0);
  });

  // 128 starts, each a locked whole-file write: slow on a loaded CI runner.
  test("a start past Home's limit of waiting requests is refused", async () => {
    const h = await home();
    expect(DEVICE_LIMITS.maxPending).toBe(128);
    // The longest name, in a three-byte script: a full Home still reads back whole.
    const clientName = String.fromCodePoint(0x4e2d).repeat(64);
    for (let i = 0; i < DEVICE_LIMITS.maxPending; i++) {
      started(await h.devices.start({ clientName, requestedFrom: from(i) }));
    }
    expect(h.devices.read()).toHaveLength(DEVICE_LIMITS.maxPending);
    const refused = await h.devices.start({ requestedFrom: HERE });
    expect(refused).toMatchObject({ ok: false, code: "rate_limited", reason: "too_many_pending" });
    // Once those expire, the next writer drops them and a start is taken again.
    h.clock.advance(DEVICE_LIMITS.codeTtlMs);
    started(await h.devices.start({ requestedFrom: HERE }));
    expect(h.devices.read()).toHaveLength(1);
  }, 20_000);

  test("a poll that comes too soon is told to wait five seconds longer", async () => {
    const h = await home();
    const start = started(await h.devices.start({ requestedFrom: HERE }));
    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "pending" });
    h.clock.advance(1_000);
    const soon = await h.devices.poll(start.pollRef);
    expect(soon).toMatchObject({ ok: false, code: "rate_limited", reason: "slow_down" });
    expect(soon.ok === false && soon.retryAfterMs).toBe(
      DEVICE_LIMITS.intervalMs + DEVICE_LIMITS.slowDownMs,
    );
    h.clock.advance(1_000);
    const again = await h.devices.poll(start.pollRef);
    expect(again.ok === false && again.reason).toBe("slow_down");
    // A poll that waited the interval since the last one answered is answered.
    h.clock.advance(DEVICE_LIMITS.intervalMs);
    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "pending" });
  });

  test("the eleventh failed lookup is refused, even with the right code", async () => {
    const h = await home();
    const start = started(await h.devices.start({ requestedFrom: HERE }));
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
    const start = started(await h.devices.start({ requestedFrom: HERE }));
    const svc = ok(
      await h.access.mintServiceToken(h.actor, { service: "bot", permissions: [], harnesses: [] }),
    ).principal;
    const refused = await h.devices.decide({ caller: svc, code: start.userCode, choice: "allow" });
    expect(refused).toMatchObject({ ok: false, code: "forbidden", reason: "member_required" });
  });

  test("a read-only request mints a read-only token", async () => {
    const h = await home();
    const start = started(await h.devices.start({ readOnly: true, requestedFrom: HERE }));
    await h.devices.decide({ caller: h.member, code: start.userCode, choice: "allow" });
    const collected = await h.devices.poll(start.pollRef);
    if (!collected.ok || collected.state !== "allowed") throw new Error("expected the token");
    expect(h.snapshot().tokens.find((t) => t.id === collected.token.id)?.readOnly).toBe(true);
  });

  test("the file holds no raw code and no raw poll reference, and moves no revision", async () => {
    const h = await home();
    const before = readFileSync(join(h.root, accessPaths().revision), "utf8");
    const start = started(await h.devices.start({ requestedFrom: HERE }));
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
    expect(await devices.start({ requestedFrom: HERE })).toMatchObject({
      ok: false,
      reason: "access_not_set_up",
    });
    expect((await import("node:fs")).existsSync(join(root, "access"))).toBe(false);
  });
});

/** The proxy secret, built at runtime from parts. */
const PROXY_SECRET = ["proxy", "secret", "for", "tests"].join("-");

async function trustedProxy(): Promise<TrustedProxy> {
  return {
    header: "x-auth-user",
    peers: ["10.0.0.0/8"],
    hosts: ["home.example.test"],
    secretDigest: await sha256Hex(PROXY_SECRET),
  };
}

/** A request that carries forwarding headers, with the proxy secret given. */
function forwarded(secret: string): Request {
  return new Request("http://home.example.test/api/v1/auth/device", {
    method: "POST",
    headers: {
      "crewhaus-proxy-secret": secret,
      "x-forwarded-for": "192.0.2.1, 198.51.100.7",
      forwarded: "for=192.0.2.44",
      "x-real-ip": "192.0.2.55",
    },
  });
}

describe("where a waiting sign-in came from", () => {
  test("a direct start names its TCP peer and when it arrived", async () => {
    const h = await home();
    const requestedFrom = await requesterOf(
      new Request("http://127.0.0.1/api/v1/auth/device"),
      { address: "203.0.113.5", listener: "tcp" },
      {},
    );
    expect(requestedFrom).toEqual({ via: "direct", address: "203.0.113.5" });
    const start = started(await h.devices.start({ clientName: "laptop", requestedFrom }));
    const at = new Date(h.clock.now()).toISOString();
    h.clock.advance(60_000);
    const looked = await h.devices.lookup(h.member, start.userCode);
    if (!looked.ok) throw new Error(looked.reason);
    expect(looked.request.requestedFrom).toEqual({ via: "direct", address: "203.0.113.5" });
    expect(looked.request.createdAt).toBe(at);
  });

  test("a proven proxy's start names the address it reports, last in X-Forwarded-For", async () => {
    const proxy = await trustedProxy();
    expect(
      await requesterOf(
        forwarded(PROXY_SECRET),
        { address: "10.1.2.3", listener: "tcp" },
        { trustedProxy: proxy },
      ),
    ).toEqual({ via: "proxy", address: "198.51.100.7" });
    // The proxy's socket proves itself by its file mode.
    expect(
      await requesterOf(
        forwarded(""),
        { address: null, listener: "proxy.sock" },
        { trustedProxy: { ...proxy, socket: true } },
      ),
    ).toEqual({ via: "proxy", address: "198.51.100.7" });
    // A proven proxy that reports nothing readable is still the proxy.
    expect(
      await requesterOf(
        new Request("http://home.example.test/", {
          headers: { "crewhaus-proxy-secret": PROXY_SECRET, "x-forwarded-for": "not<an>ip" },
        }),
        { address: "10.1.2.3", listener: "tcp" },
        { trustedProxy: proxy },
      ),
    ).toEqual({ via: "proxy" });
  });

  test("forwarding headers count only from the proven proxy", async () => {
    const h = await home();
    const proxy = await trustedProxy();
    const peer = { address: "203.0.113.5", listener: "tcp" } as const;
    const wrongSecret = await requesterOf(forwarded("not-the-secret"), peer, {
      trustedProxy: proxy,
    });
    const noProxy = await requesterOf(forwarded(PROXY_SECRET), peer, {});
    // The right secret from a peer outside the proxy's blocks proves nothing either.
    const outside = await requesterOf(forwarded(PROXY_SECRET), peer, { trustedProxy: proxy });
    for (const requestedFrom of [wrongSecret, noProxy, outside]) {
      expect(requestedFrom).toEqual({ via: "direct", address: "203.0.113.5" });
      started(await h.devices.start({ requestedFrom }));
    }
    const text = readFileSync(join(h.root, accessPaths().deviceRequests), "utf8");
    expect(text).toContain("203.0.113.5");
    for (const reported of ["198.51.100.7", "192.0.2.1", "192.0.2.44", "192.0.2.55"]) {
      expect(text).not.toContain(reported);
    }
  });

  test("Home's own socket is named as Home", async () => {
    expect(
      await requesterOf(
        forwarded(PROXY_SECRET),
        { address: null, listener: "home.sock" },
        { trustedProxy: await trustedProxy() },
      ),
    ).toEqual({ via: "home" });
  });

  test("a stored address holds only the characters of an address", async () => {
    const tcp = (address: string | null) => ({ address, listener: "tcp" as const });
    const plain = new Request("http://127.0.0.1/");
    expect(await requesterOf(plain, tcp("fe80::1%en0"), {})).toEqual({
      via: "direct",
      address: "fe80::1",
    });
    expect(await requesterOf(plain, tcp("fe80::1%\u202eevil"), {})).toEqual({
      via: "direct",
      address: "fe80::1",
    });
    expect(await requesterOf(plain, tcp("203.0.113.5\u202e"), {})).toEqual({ via: "direct" });
    expect(await requesterOf(plain, tcp("999.1.1.1"), {})).toEqual({ via: "direct" });
    expect(await requesterOf(plain, tcp(null), {})).toEqual({ via: "direct" });
  });

  test("a stored request that does not name where it came from is not read as one", async () => {
    const h = await home();
    started(await h.devices.start({ requestedFrom: HERE }));
    const path = join(h.root, accessPaths().deviceRequests);
    const file = JSON.parse(readFileSync(path, "utf8")) as { requests: Record<string, unknown>[] };
    const [row] = file.requests;
    if (row === undefined) throw new Error("no row");
    const { requestedFrom: _gone, ...bare } = row;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        requests: [bare, { ...row, requestedFrom: { via: "header" } }],
      }),
    );
    expect(h.devices.read()).toHaveLength(0);
  });
});

describe("waiting requests per address", () => {
  test("one address has at most four waiting; another still starts", async () => {
    const h = await home();
    const four = [];
    for (let i = 0; i < DEVICE_LIMITS.maxPendingPerPeer; i++) {
      four.push(started(await h.devices.start({ requestedFrom: HERE })));
    }
    expect(DEVICE_LIMITS.maxPendingPerPeer).toBe(4);
    const fifth = await h.devices.start({ requestedFrom: HERE });
    expect(fifth).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
      reason: "too_many_pending_here",
      message:
        "Too many sign-ins from this address are waiting. Finish or cancel one, or wait ten minutes.",
      retryAfterMs: DEVICE_LIMITS.codeTtlMs,
    });
    started(await h.devices.start({ requestedFrom: { via: "direct", address: "198.51.100.7" } }));
    // Once one of the four is decided, the address starts again.
    const first = four[0];
    if (first === undefined) throw new Error("no start");
    await h.devices.decide({ caller: h.member, code: first.userCode, choice: "deny" });
    started(await h.devices.start({ requestedFrom: HERE }));
  });

  test("an IPv6 address counts by its /64, and a mapped IPv4 address as IPv4", async () => {
    const h = await home();
    const v6 = (address: string): RequestedFrom => ({ via: "direct", address });
    for (const address of ["2001:db8:1:2::a", "2001:db8:1:2::b", "2001:db8:1:2::a"]) {
      started(await h.devices.start({ requestedFrom: v6(address) }));
    }
    started(await h.devices.start({ requestedFrom: v6("2001:db8:1:2:ffff::1") }));
    const fifth = await h.devices.start({ requestedFrom: v6("2001:db8:1:2::b") });
    expect(fifth.ok === false && fifth.reason).toBe("too_many_pending_here");
    started(await h.devices.start({ requestedFrom: v6("2001:db8:1:3::a") }));

    for (let i = 0; i < DEVICE_LIMITS.maxPendingPerPeer; i++) {
      started(await h.devices.start({ requestedFrom: HERE }));
    }
    const mapped = await h.devices.start({ requestedFrom: v6("::ffff:203.0.113.5") });
    expect(mapped.ok === false && mapped.reason).toBe("too_many_pending_here");
  });

  test("a proxy's requests count by the address it reports, and Home's socket as one", async () => {
    const h = await home();
    const viaProxy = (address: string): RequestedFrom => ({ via: "proxy", address });
    for (let i = 0; i < DEVICE_LIMITS.maxPendingPerPeer; i++) {
      started(await h.devices.start({ requestedFrom: viaProxy("192.0.2.1") }));
      started(await h.devices.start({ requestedFrom: { via: "home" } }));
    }
    const proxied = await h.devices.start({ requestedFrom: viaProxy("192.0.2.1") });
    expect(proxied.ok === false && proxied.reason).toBe("too_many_pending_here");
    const own = await h.devices.start({ requestedFrom: { via: "home" } });
    expect(own.ok === false && own.reason).toBe("too_many_pending_here");
    started(await h.devices.start({ requestedFrom: viaProxy("192.0.2.2") }));
    // The same address reached directly is its own count.
    started(await h.devices.start({ requestedFrom: { via: "direct", address: "192.0.2.1" } }));
  });

  test("one IPv6 /48 has at most eight waiting, however its /64s are spread", async () => {
    const h = await home();
    const v6 = (address: string): RequestedFrom => ({ via: "direct", address });
    expect(DEVICE_LIMITS.maxPendingPerNetwork).toBe(8);
    for (let i = 0; i < DEVICE_LIMITS.maxPendingPerNetwork; i++) {
      started(await h.devices.start({ requestedFrom: v6(`2001:db8:1:${i}::a`) }));
    }
    const ninth = await h.devices.start({ requestedFrom: v6("2001:db8:1:ff::a") });
    expect(ninth.ok === false && ninth.reason).toBe("too_many_pending_here");
    // Another /48, and an IPv4 address, still start.
    started(await h.devices.start({ requestedFrom: v6("2001:db8:2::a") }));
    started(await h.devices.start({ requestedFrom: HERE }));
  });

  test("one /48 cannot fill Home: an address elsewhere still starts", async () => {
    const h = await home();
    const v6 = (address: string): RequestedFrom => ({ via: "direct", address });
    for (let net = 0; net < 8; net++) {
      for (let i = 0; i < DEVICE_LIMITS.maxPendingPerPeer; i++) {
        await h.devices.start({ requestedFrom: v6(`2001:db8:1:${net}::${i + 1}`) });
      }
    }
    const pending = h.devices.read().filter((row) => row.state === "pending");
    expect(pending).toHaveLength(DEVICE_LIMITS.maxPendingPerNetwork);
    started(await h.devices.start({ requestedFrom: { via: "direct", address: "198.51.100.9" } }));
  });

  // 65 proxy starts and a direct one, each a locked whole-file write.
  test("whatever the proxy reports, its requests leave room for the rest", async () => {
    const h = await home();
    const proxy = await trustedProxy();
    const peer = { address: "10.1.2.3", listener: "tcp" } as const;
    const through = (i: number) =>
      new Request("http://home.example.test/api/v1/auth/device", {
        method: "POST",
        headers: {
          "crewhaus-proxy-secret": PROXY_SECRET,
          "x-forwarded-for": `192.0.2.${i % 250}, 198.18.${Math.floor(i / 250)}.${i % 250}`,
        },
      });
    for (let i = 0; i < DEVICE_LIMITS.maxPendingThroughProxy; i++) {
      const requestedFrom = await requesterOf(through(i), peer, { trustedProxy: proxy });
      expect(requestedFrom.via).toBe("proxy");
      started(await h.devices.start({ requestedFrom }));
    }
    expect(DEVICE_LIMITS.maxPendingThroughProxy).toBeLessThan(DEVICE_LIMITS.maxPending);
    const next = await requesterOf(through(9_999), peer, { trustedProxy: proxy });
    const refused = await h.devices.start({ requestedFrom: next });
    expect(refused.ok === false && refused.reason).toBe("too_many_pending");
    started(await h.devices.start({ requestedFrom: HERE }));
    started(await h.devices.start({ requestedFrom: { via: "home" } }));
  }, 20_000);

  test("the cap holds under the lock: of two starts racing for the last slot, one wins", async () => {
    const h = await home();
    for (let i = 0; i < DEVICE_LIMITS.maxPendingPerPeer - 1; i++) {
      started(await h.devices.start({ requestedFrom: HERE }));
    }
    const both = await Promise.all([
      h.devices.start({ requestedFrom: HERE }),
      h.devices.start({ requestedFrom: HERE }),
    ]);
    expect(both.filter((answer) => answer.ok)).toHaveLength(1);
    const lost = both.find((answer) => !answer.ok);
    expect(lost?.ok === false && lost.reason).toBe("too_many_pending_here");
  });
});

describe("the access lock", () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });
  const countLocks = () => {
    const spy = spyOn(records, "withLedgerLock");
    spies.push(spy);
    return spy;
  };

  test("an accepted start takes it once", async () => {
    const h = await home();
    const locks = countLocks();
    started(await h.devices.start({ requestedFrom: HERE }));
    expect(locks).toHaveBeenCalledTimes(1);
  });

  test("a poll for a request that never existed never waits for it", async () => {
    const h = await home();
    started(await h.devices.start({ requestedFrom: HERE }));
    const locks = countLocks();
    expect(await h.devices.poll("ab".repeat(32))).toEqual({ ok: true, state: "expired" });
    expect(locks).toHaveBeenCalledTimes(0);
  });

  test("a poll for a request that has ended never waits for it", async () => {
    const h = await home();
    const gone = started(await h.devices.start({ requestedFrom: HERE }));
    h.clock.advance(DEVICE_LIMITS.codeTtlMs);
    const locks = countLocks();
    expect(await h.devices.poll(gone.pollRef)).toEqual({ ok: true, state: "expired" });
    expect(locks).toHaveBeenCalledTimes(0);
  });

  test("a poll for a collected request never waits for it", async () => {
    const h = await home();
    const start = started(await h.devices.start({ requestedFrom: HERE }));
    await h.devices.decide({ caller: h.member, code: start.userCode, choice: "allow" });
    const collected = await h.devices.poll(start.pollRef);
    expect(collected.ok && collected.state).toBe("allowed");
    h.clock.advance(DEVICE_LIMITS.intervalMs);
    const locks = countLocks();
    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "consumed" });
    expect(locks).toHaveBeenCalledTimes(0);
  });

  test("a poll of a live request that waited its interval takes it once", async () => {
    const h = await home();
    const start = started(await h.devices.start({ requestedFrom: HERE }));
    const locks = countLocks();
    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "pending" });
    expect(locks).toHaveBeenCalledTimes(1);
  });

  test("a poll that comes too soon never waits for it, and writes nothing", async () => {
    const h = await home();
    const start = started(await h.devices.start({ requestedFrom: HERE }));
    expect(await h.devices.poll(start.pollRef)).toEqual({ ok: true, state: "pending" });
    h.clock.advance(1_000);
    const path = join(h.root, accessPaths().deviceRequests);
    const before = readFileSync(path);
    const locks = countLocks();
    const soon = await h.devices.poll(start.pollRef);
    expect(soon.ok === false && soon.reason).toBe("slow_down");
    expect(locks).toHaveBeenCalledTimes(0);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("of forty polls of one request at once, at most one waits for it", async () => {
    const h = await home();
    const start = started(await h.devices.start({ requestedFrom: HERE }));
    await h.devices.decide({ caller: h.member, code: start.userCode, choice: "allow" });
    const locks = countLocks();
    const answers = await Promise.all(
      Array.from({ length: 40 }, () => h.devices.poll(start.pollRef)),
    );
    // The one that took the lock collected, and minted under it.
    expect(locks).toHaveBeenCalledTimes(1);
    expect(answers.filter((a) => a.ok && a.state === "allowed")).toHaveLength(1);
    expect(h.snapshot().tokens.filter((t) => t.kind === "personal")).toHaveLength(1);
    for (const answer of answers.filter((a) => !a.ok)) {
      expect(answer.ok === false && answer.reason).toBe("slow_down");
    }
  });

  test("polls refused while one is answered leave the request to collect", async () => {
    const h = await home();
    const start = started(await h.devices.start({ requestedFrom: HERE }));
    const answers = await Promise.all(
      Array.from({ length: 40 }, () => h.devices.poll(start.pollRef)),
    );
    expect(answers.filter((a) => a.ok && a.state === "pending")).toHaveLength(1);
    await h.devices.decide({ caller: h.member, code: start.userCode, choice: "allow" });
    h.clock.advance(DEVICE_LIMITS.intervalMs);
    const collected = await h.devices.poll(start.pollRef);
    expect(collected.ok && collected.state).toBe("allowed");
  });

  test("a start refused because Home is full never waits for it, and writes nothing", async () => {
    const h = await home();
    for (let i = 0; i < DEVICE_LIMITS.maxPending; i++) {
      started(await h.devices.start({ requestedFrom: from(i) }));
    }
    const path = join(h.root, accessPaths().deviceRequests);
    const before = readFileSync(path);
    const locks = countLocks();
    const refused = await h.devices.start({ requestedFrom: HERE });
    expect(refused.ok === false && refused.reason).toBe("too_many_pending");
    expect(locks).toHaveBeenCalledTimes(0);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("a start refused because its address is full never waits for it", async () => {
    const h = await home();
    for (let i = 0; i < DEVICE_LIMITS.maxPendingPerPeer; i++) {
      started(await h.devices.start({ requestedFrom: HERE }));
    }
    const locks = countLocks();
    const refused = await h.devices.start({ requestedFrom: HERE });
    expect(refused.ok === false && refused.reason).toBe("too_many_pending_here");
    expect(locks).toHaveBeenCalledTimes(0);
  });
});
