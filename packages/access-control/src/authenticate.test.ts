/**
 * `authenticate`: Home's own key only from this computer, the proxy identity only from a
 * proven proxy, a bearer and an identity that must agree, and every live identity answered
 * for the choke point to authorize. Every refusal is asserted by its reason, not its status.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAccessSetUp, openAccess } from "./access";
import { isLoopbackAddress } from "./addresses";
import {
  type AuthenticateConfig,
  type Authenticated,
  BOOTSTRAP_PRINCIPAL,
  type Peer,
  type TrustedProxy,
  authenticate,
} from "./authenticate";
import { sha256Hex } from "./secrets";
import { type SignInHandle, openSignIn } from "./sign-in";
import { BOOTSTRAP_TOKEN, LOCAL, fakeClock, removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const LOOPBACK: Peer = { address: "127.0.0.1", listener: "tcp" };
const LAN: Peer = { address: "192.168.1.20", listener: "tcp" };
const SOCKET: Peer = { address: null, listener: "home.sock" };
const PROXY_SOCKET: Peer = { address: null, listener: "proxy.sock" };
/** Built at runtime from parts, never a real secret. */
const PROXY_SECRET = ["proxy", "secret", "for", "tests"].join("-");

type Home = { root: string; signIn: SignInHandle; owner?: string };

async function home(setUp = true): Promise<Home> {
  const root = join(tempDir(), "hangar");
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, "token"), `${BOOTSTRAP_TOKEN}\n`, { mode: 0o600 });
  const clock = fakeClock();
  let owner: string | undefined;
  if (setUp) {
    const done = await ensureAccessSetUp(root, { localActor: LOCAL, now: clock.now });
    if (!done.ok) throw new Error(done.reason);
    owner = done.result.owner;
  }
  return {
    root,
    signIn: openSignIn(root, { now: clock.now, localActor: LOCAL }),
    ...(owner ? { owner } : {}),
  };
}

/** A session for the owner, through the real exchange, signed by the browser module. */
async function ownerSession(h: Home): Promise<string> {
  const signIn = (await import(
    new URL("../../hangar-ui/assets/js/sign-in.js", import.meta.url).href
  )) as {
    makeDeviceKey(): Promise<{ deviceJwk: { kty: "EC"; crv: "P-256"; x: string; y: string } }>;
  };
  const sealed = (await import(
    new URL("../../hangar-ui/assets/js/sealed.js", import.meta.url).href
  )) as {
    makeSeal(): Promise<{
      seal: { kty: "EC"; crv: "P-256"; x: string; y: string };
      open(issued: unknown, op: string): Promise<string>;
    }>;
  };
  const code = h.signIn.mintExchangeCode(h.signIn.mintBootTicket().slice("/boot/".length));
  if (code === undefined) throw new Error("no code");
  const seal = await sealed.makeSeal();
  const answer = await h.signIn.exchange({
    code,
    deviceJwk: (await signIn.makeDeviceKey()).deviceJwk,
    seal: seal.seal,
  });
  if (!answer.ok) throw new Error(answer.reason);
  return seal.open(answer.issued, "auth.exchange");
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:4200/api/harnesses", { headers });
}

const bearer = (secret: string): Record<string, string> => ({ authorization: `Bearer ${secret}` });

function auth(
  h: Home,
  req: Request,
  peer: Peer,
  config: AuthenticateConfig = {},
): Promise<Authenticated> {
  return authenticate(req, peer, config, { signIn: h.signIn, bootToken: BOOTSTRAP_TOKEN });
}

function reasonOf(answer: Authenticated): string {
  return answer.kind === "refused"
    ? `${answer.status} ${answer.code} ${answer.reason}`
    : answer.kind;
}

async function proxyConfig(extra: Partial<TrustedProxy> = {}): Promise<AuthenticateConfig> {
  return {
    trustedProxy: {
      header: "x-auth-user",
      peers: ["10.0.0.0/8"],
      hosts: ["home.example.test"],
      secretDigest: await sha256Hex(PROXY_SECRET),
      ...extra,
    },
  };
}

describe("isLoopbackAddress", () => {
  test.each([
    ["127.0.0.1", true],
    ["127.255.255.254", true],
    ["::1", true],
    ["0:0:0:0:0:0:0:1", true],
    ["0000:0000:0000:0000:0000:0000:0000:0001", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["10.0.0.1", false],
    ["::ffff:10.0.0.1", false],
    ["128.0.0.1", false],
    ["::", false],
    ["::2", false],
    ["127.0.0", false],
    ["localhost", false],
    [null, false],
  ] as const)("%p → %p", (address, loopback) => {
    expect(isLoopbackAddress(address)).toBe(loopback);
  });
});

describe("Home's own key", () => {
  test("works from a direct loopback peer and on home.sock, as the owner", async () => {
    const h = await home();
    for (const peer of [LOOPBACK, { address: "::1", listener: "tcp" } as Peer, SOCKET]) {
      const answer = await auth(h, request(bearer(BOOTSTRAP_TOKEN)), peer);
      expect(answer).toEqual({ kind: "principal", principal: h.owner as string, via: "bootstrap" });
    }
  });

  test("before access is set up it is the token Home read at boot", async () => {
    const h = await home(false);
    expect(await auth(h, request(bearer(BOOTSTRAP_TOKEN)), LOOPBACK)).toEqual({
      kind: "principal",
      principal: BOOTSTRAP_PRINCIPAL,
      via: "bootstrap",
    });
    expect(reasonOf(await auth(h, request(bearer("tok-abc123")), LOOPBACK))).toBe(
      "401 unauthenticated credential_unknown",
    );
  });

  test("each forwarding header turns it away, however loopback the peer", async () => {
    const h = await home();
    for (const header of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-anything",
      "x-real-ip",
    ]) {
      const answer = await auth(
        h,
        request({ ...bearer(BOOTSTRAP_TOKEN), [header]: "1.2.3.4" }),
        LOOPBACK,
      );
      expect(`${header}: ${reasonOf(answer)}`).toBe(
        `${header}: 401 unauthenticated bootstrap_not_accepted_here`,
      );
    }
  });

  test("a peer off this computer is turned away", async () => {
    const h = await home();
    expect(reasonOf(await auth(h, request(bearer(BOOTSTRAP_TOKEN)), LAN))).toBe(
      "401 unauthenticated bootstrap_not_accepted_here",
    );
  });

  test("socket-only and proxy mode take it off TCP and leave home.sock", async () => {
    const h = await home();
    const config = await proxyConfig();
    expect(reasonOf(await auth(h, request(bearer(BOOTSTRAP_TOKEN)), LOOPBACK, config))).toBe(
      "401 unauthenticated bootstrap_not_accepted_here",
    );
    expect((await auth(h, request(bearer(BOOTSTRAP_TOKEN)), SOCKET, config)).kind).toBe(
      "principal",
    );

    const { rotateBootstrap } = await import("./bootstrap");
    const rotated = await rotateBootstrap(h.root, { localActor: LOCAL, socketOnly: true });
    if (!rotated.ok) throw new Error(rotated.reason);
    const token = (await Bun.file(join(h.root, "token")).text()).trim();
    expect(reasonOf(await auth(h, request(bearer(token)), LOOPBACK))).toBe(
      "401 unauthenticated bootstrap_not_accepted_here",
    );
    expect((await auth(h, request(bearer(token)), SOCKET)).kind).toBe("principal");
  });
});

describe("trusted-proxy identity", () => {
  async function linked(h: Home, subject: string, member?: string): Promise<void> {
    const access = openAccess(h.root);
    const done = await access.link(
      { principal: h.owner as string },
      member === undefined
        ? { subject, member: h.owner as string }
        : { subject, member, create: true },
    );
    if (!done.ok) throw new Error(done.reason);
  }

  const fromProxy = (extra: Record<string, string> = {}): Request =>
    request({ "x-auth-user": "max@example.test", "crewhaus-proxy-secret": PROXY_SECRET, ...extra });

  test("a listed peer with the secret names the linked owner", async () => {
    const h = await home();
    await linked(h, "proxy:x-auth-user:max@example.test");
    const answer = await auth(
      h,
      fromProxy(),
      { address: "10.1.2.3", listener: "tcp" },
      await proxyConfig(),
    );
    expect(answer).toEqual({ kind: "principal", principal: h.owner as string, via: "proxy" });
  });

  test("a link made with the header's capitals names the same person: header names ignore case", async () => {
    const h = await home();
    await linked(h, "proxy:X-Auth-User:max@example.test");
    const answer = await auth(
      h,
      fromProxy(),
      { address: "10.1.2.3", listener: "tcp" },
      await proxyConfig(),
    );
    expect(answer).toEqual({ kind: "principal", principal: h.owner as string, via: "proxy" });
  });

  test("on proxy.sock the socket is the proof", async () => {
    const h = await home();
    await linked(h, "proxy:x-auth-user:max@example.test");
    const config = await proxyConfig({ socket: true });
    const answer = await auth(
      h,
      request({ "x-auth-user": "max@example.test" }),
      PROXY_SOCKET,
      config,
    );
    expect(answer.kind).toBe("principal");
  });

  test("an unlisted peer, a wrong secret or home.sock: the identity is ignored", async () => {
    const h = await home();
    await linked(h, "proxy:x-auth-user:max@example.test");
    const config = await proxyConfig();
    const cases: Array<[string, Request, Peer]> = [
      ["unlisted peer", fromProxy(), { address: "192.168.1.9", listener: "tcp" }],
      [
        "wrong secret",
        fromProxy({ "crewhaus-proxy-secret": "wrong" }),
        { address: "10.1.2.3", listener: "tcp" },
      ],
      ["home.sock", fromProxy(), SOCKET],
    ];
    for (const [name, req, peer] of cases) {
      const answer = await auth(h, req, peer, config);
      expect(`${name}: ${answer.kind} ${answer.ignoredProxyHeaders === true}`).toBe(
        `${name}: anonymous true`,
      );
    }
  });

  test("an unlinked identity is told to ask for an invite, never made a member", async () => {
    const h = await home();
    const answer = await auth(
      h,
      fromProxy(),
      { address: "10.1.2.3", listener: "tcp" },
      await proxyConfig(),
    );
    expect(reasonOf(answer)).toBe("403 forbidden not_invited");
    expect(answer.kind === "refused" && answer.message).toBe(
      "Ask the owner of this Home to invite you.",
    );
  });

  test("a listed peer with the secret and no identity is anonymous, even with Home's own key", async () => {
    const h = await home();
    const config = await proxyConfig();
    const peer: Peer = { address: "10.1.2.3", listener: "tcp" };
    const req = request({ "crewhaus-proxy-secret": PROXY_SECRET });
    expect((await auth(h, req, peer, config)).kind).toBe("anonymous");
    const withKey = request({ "crewhaus-proxy-secret": PROXY_SECRET, ...bearer(BOOTSTRAP_TOKEN) });
    expect(reasonOf(await auth(h, withKey, peer, config))).toBe(
      "401 unauthenticated bootstrap_not_accepted_here",
    );
  });

  test("a bearer and a proxy identity that name different people are refused", async () => {
    const h = await home();
    await linked(h, "proxy:x-auth-user:max@example.test");
    const access = openAccess(h.root);
    const ana = await access.link(
      { principal: h.owner as string },
      { subject: "proxy:x-auth-user:ana@example.test", member: "Ana", create: true },
    );
    if (!ana.ok) throw new Error(ana.reason);
    const session = await ownerSession(h);
    const config = await proxyConfig();
    const peer: Peer = { address: "10.1.2.3", listener: "tcp" };
    const as = (user: string): Request =>
      request({ "x-auth-user": user, "crewhaus-proxy-secret": PROXY_SECRET, ...bearer(session) });
    expect(reasonOf(await auth(h, as("ana@example.test"), peer, config))).toBe(
      "401 unauthenticated identity_mismatch",
    );
    expect(reasonOf(await auth(h, as("nobody@example.test"), peer, config))).toBe(
      "401 unauthenticated identity_mismatch",
    );
    const agreed = await auth(h, as("max@example.test"), peer, config);
    expect(agreed.kind === "principal" && agreed.via).toBe("session");
  });
});

describe("every live identity is answered; what it may do is the choke point's", () => {
  test("a proxy identity linked to a second member authenticates as that member", async () => {
    const h = await home();
    const access = openAccess(h.root);
    const done = await access.link(
      { principal: h.owner as string },
      { subject: "proxy:x-auth-user:ana@example.test", member: "Ana", create: true },
    );
    if (!done.ok) throw new Error(done.reason);
    const answer = await auth(
      h,
      request({ "x-auth-user": "ana@example.test", "crewhaus-proxy-secret": PROXY_SECRET }),
      { address: "10.9.9.9", listener: "tcp" },
      await proxyConfig(),
    );
    expect(answer).toEqual({ kind: "principal", principal: done.result.principal, via: "proxy" });
  });

  test("a live service token authenticates as its service, naming the credential it used", async () => {
    const h = await home();
    const access = openAccess(h.root);
    const minted = await access.mintServiceToken(
      { principal: h.owner as string },
      { service: "ci", permissions: [], harnesses: [] },
    );
    if (!minted.ok) throw new Error(minted.reason);
    expect(await auth(h, request(bearer(minted.result.secret)), LAN)).toEqual({
      kind: "principal",
      principal: minted.result.principal,
      via: "service",
      credential: minted.result.token.id,
    });
    expect(reasonOf(await auth(h, request(bearer(`chs_${"A".repeat(43)}`)), LAN))).toBe(
      "401 unauthenticated credential_unknown",
    );
  });

  test("an unminted personal token is unknown, and is never compared as Home's own key", async () => {
    const h = await home(false);
    const personal = `chp_${"A".repeat(43)}`;
    // Even as the key Home read at boot, from a direct loopback peer, it is not one.
    const answer = await authenticate(
      request(bearer(personal)),
      LOOPBACK,
      {},
      {
        signIn: h.signIn,
        bootToken: personal,
      },
    );
    expect(reasonOf(answer)).toBe("401 unauthenticated credential_unknown");
    const invite = `chi_${"B".repeat(43)}`;
    expect(
      reasonOf(
        await authenticate(
          request(bearer(invite)),
          SOCKET,
          {},
          {
            signIn: h.signIn,
            bootToken: invite,
          },
        ),
      ),
    ).toBe("401 unauthenticated credential_unknown");
  });

  test("an unknown session is unauthenticated", async () => {
    const h = await home();
    expect(reasonOf(await auth(h, request(bearer(`cha_${"A".repeat(43)}`)), LAN))).toBe(
      "401 unauthenticated session_unknown",
    );
  });
});

describe("personal tokens", () => {
  async function withToken(readOnly = false) {
    const { homeFixture, ok } = await import("./test-helpers");
    const { openDeviceRequests } = await import("./device-requests");
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
    const start = await devices.start({ readOnly });
    if (!start.ok) throw new Error(start.reason);
    await devices.decide({ caller: member, code: start.userCode, choice: "allow" });
    const polled = await devices.poll(start.pollRef);
    if (!polled.ok || polled.state !== "allowed") throw new Error("no token");
    const signIn = openSignIn(fixture.root, { now: fixture.clock.now, localActor: LOCAL });
    const check = (secret = polled.secret) =>
      authenticate(
        request(bearer(secret)),
        LAN,
        {},
        {
          signIn,
          bootToken: undefined,
          now: fixture.clock.now,
        },
      );
    return { fixture, member, secret: polled.secret, credential: polled.token.id, check };
  }

  test("a live one authenticates as its member, from any address", async () => {
    const t = await withToken();
    expect(await t.check()).toEqual({
      kind: "principal",
      principal: t.member,
      via: "personal",
      credential: t.credential,
    });
  });

  test("revoked, expired, or its member removed: unauthenticated", async () => {
    const revoked = await withToken();
    const { ok } = await import("./test-helpers");
    ok(await revoked.fixture.access.revoke(revoked.fixture.actor, revoked.credential));
    expect(reasonOf(await revoked.check())).toBe("401 unauthenticated credential_unknown");

    const expired = await withToken();
    expired.fixture.clock.advance(91 * 24 * 60 * 60 * 1000);
    expect(reasonOf(await expired.check())).toBe("401 unauthenticated credential_unknown");

    const removed = await withToken();
    ok(await removed.fixture.access.removeMember(removed.fixture.actor, removed.member));
    expect(reasonOf(await removed.check())).toBe("401 unauthenticated credential_unknown");
  });

  test("a read-only one is refused anything above reading, naming what it needs", async () => {
    const { authorize } = await import("./authorize");
    const t = await withToken(true);
    const snapshot = t.fixture.snapshot();
    const actor = { principal: t.member, credential: t.credential };
    const harness = { scope: "harness" as const, harness: "hrn_00000000000000aa", groups: [] };
    const now = { now: t.fixture.clock.now() };
    expect(authorize(snapshot, actor, "h.read", harness, now).allow).toBe(true);
    expect(authorize(snapshot, actor, "h.control", harness, now)).toEqual({
      allow: false,
      needs: "h.control",
      role: "operator",
    });
    // The same member through a session holds it.
    expect(authorize(snapshot, { principal: t.member }, "h.control", harness, now).allow).toBe(
      true,
    );
  });

  test("whatever its member's role, it never manages access", async () => {
    const { authorize } = await import("./authorize");
    const t = await withToken();
    const { ok } = await import("./test-helpers");
    ok(
      await t.fixture.access.grant(t.fixture.actor, {
        member: t.member,
        role: "owner",
        scope: "home",
      }),
    );
    const snapshot = t.fixture.snapshot();
    const now = { now: t.fixture.clock.now() };
    const home = { scope: "home" as const };
    expect(
      authorize(snapshot, { principal: t.member }, "home.access.manage", home, now).allow,
    ).toBe(true);
    expect(
      authorize(
        snapshot,
        { principal: t.member, credential: t.credential },
        "home.access.manage",
        home,
        now,
      ).allow,
    ).toBe(false);
  });
});

describe("scoped tokens", () => {
  test("a scoped token whose service's epoch moved on is refused as withdrawn", async () => {
    const { homeFixture, ok } = await import("./test-helpers");
    const { mintScopedToken } = await import("./scoped");
    const fixture = await homeFixture();
    const harness = fixture.addHarness("a");
    const minted = ok(
      await fixture.access.mintServiceToken(fixture.actor, {
        service: "portal",
        permissions: [],
        harnesses: [harness.id],
      }),
    );
    const scoped = await mintScopedToken(
      fixture.root,
      {
        credential: minted.token.id,
        refs: [`${harness.id}/run/run_0badcafe`],
        acts: ["run.result.read"],
      },
      { now: fixture.clock.now },
    );
    if (!scoped.ok) throw new Error(scoped.message);
    const signIn = openSignIn(fixture.root, { now: fixture.clock.now, localActor: LOCAL });
    const check = () =>
      authenticate(
        request(bearer(scoped.token)),
        LAN,
        {},
        { signIn, bootToken: undefined, now: fixture.clock.now },
      );
    // The grant carries the epoch it was minted under, so an open stream is checked by it too.
    expect(await check()).toMatchObject({
      kind: "principal",
      principal: minted.principal,
      via: "scoped",
      scoped: { ep: 0 },
    });
    ok(await fixture.access.bumpScopedEpoch(fixture.actor, minted.principal));
    const answer = await check();
    expect(reasonOf(answer)).toBe("401 unauthenticated token_revoked");
    expect(answer.kind === "refused" && answer.message).toBe(
      "This link's access was withdrawn. Ask for a new one.",
    );
  });
});
