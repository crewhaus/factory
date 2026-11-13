/**
 * The sign-in handle: exchange codes, challenges, device keys and sessions, on a fake
 * clock. Devices sign with the browser module Home serves, so the signed bytes cannot
 * drift between the two halves.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { authenticate } from "./authenticate";
import { rotateBootstrap } from "./bootstrap";
import { readRevision } from "./files";
import { sha256Hex } from "./secrets";
import { type SessionIssue, type SignInHandle, type SignInRefusal, openSignIn } from "./sign-in";
import type { DeviceJwk } from "./sign-in-records";
import {
  BOOTSTRAP_TOKEN,
  DAY,
  HOUR,
  LOCAL,
  fakeClock,
  filesUnder,
  homeFixture,
  ok,
  removeTempDirs,
  rowCount,
  tempDir,
} from "./test-helpers";

afterAll(removeTempDirs);

const MINUTE = 60_000;

type Seal = { seal: DeviceJwk; open(issued: unknown, op: string): Promise<string> };
type SignInJs = {
  makeDeviceKey(): Promise<{ privateKey: CryptoKey; deviceJwk: DeviceJwk }>;
  signChallenge(
    key: CryptoKey,
    input: { device: string; nonce: string; seal: DeviceJwk },
  ): Promise<string>;
};
type SealedJs = { makeSeal(): Promise<Seal> };

const ui = async (): Promise<{ signIn: SignInJs; sealed: SealedJs }> => ({
  signIn: (await import(
    new URL("../../hangar-ui/assets/js/sign-in.js", import.meta.url).href
  )) as SignInJs,
  sealed: (await import(
    new URL("../../hangar-ui/assets/js/sealed.js", import.meta.url).href
  )) as SealedJs,
});

type Home = {
  root: string;
  clock: ReturnType<typeof fakeClock>;
  handle: SignInHandle;
  reopen(): SignInHandle;
};

function home(): Home {
  const base = tempDir();
  const root = join(base, "hangar");
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, "token"), `${BOOTSTRAP_TOKEN}\n`, { mode: 0o600 });
  const clock = fakeClock();
  const open = (): SignInHandle => openSignIn(root, { now: clock.now, localActor: LOCAL });
  return { root, clock, handle: open(), reopen: open };
}

function code(handle: SignInHandle): string {
  const nonce = handle.mintBootTicket().slice("/boot/".length);
  const minted = handle.mintExchangeCode(nonce);
  if (minted === undefined) throw new Error("no exchange code");
  return minted;
}

type Browser = { device: string; privateKey: CryptoKey; secret: string };

function issuedOf(answer: SessionIssue | SignInRefusal): SessionIssue {
  if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
  return answer;
}

async function enrol(handle: SignInHandle): Promise<Browser> {
  const { signIn, sealed } = await ui();
  const key = await signIn.makeDeviceKey();
  const seal = await sealed.makeSeal();
  const answer = issuedOf(
    await handle.exchange({ code: code(handle), deviceJwk: key.deviceJwk, seal: seal.seal }),
  );
  return {
    device: answer.device,
    privateKey: key.privateKey,
    secret: await seal.open(answer.issued, "auth.exchange"),
  };
}

async function returning(
  handle: SignInHandle,
  browser: { device: string; privateKey: CryptoKey },
  opts: { signWith?: CryptoKey; signSeal?: DeviceJwk } = {},
): Promise<SessionIssue | SignInRefusal> {
  const { signIn, sealed } = await ui();
  const { nonce } = handle.challenge();
  const seal = await sealed.makeSeal();
  const signature = await signIn.signChallenge(opts.signWith ?? browser.privateKey, {
    device: browser.device,
    nonce,
    seal: opts.signSeal ?? seal.seal,
  });
  return handle.signInWithDevice({ device: browser.device, nonce, signature, seal: seal.seal });
}

const reasonOf = (answer: SessionIssue | SignInRefusal): string =>
  answer.ok ? "ok" : answer.reason;

describe("exchange codes", () => {
  test("a boot link's code signs a browser in once, as the owner, and sets access up", async () => {
    const h = home();
    const b = await enrol(h.handle);
    expect(b.secret).toMatch(/^cha_[A-Za-z0-9_-]{43}$/);
    const check = await h.handle.verifyBearer(b.secret);
    expect(check.ok).toBe(true);
    const snapshot = h.handle.snapshot();
    expect(snapshot.state).toBe("present");
    if (check.ok && snapshot.state === "present") {
      expect(check.principal).toBe(snapshot.snapshot.owner as string);
    }
  });

  test("a code works once, and not after 60 seconds", async () => {
    const h = home();
    const { signIn, sealed } = await ui();
    const key = await signIn.makeDeviceKey();
    const seal = await sealed.makeSeal();
    const once = code(h.handle);
    expect(
      (await h.handle.exchange({ code: once, deviceJwk: key.deviceJwk, seal: seal.seal })).ok,
    ).toBe(true);
    const again = await h.handle.exchange({
      code: once,
      deviceJwk: key.deviceJwk,
      seal: seal.seal,
    });
    expect(reasonOf(again)).toBe("code_unknown");

    const late = code(h.handle);
    h.clock.advance(60_000);
    expect(
      reasonOf(await h.handle.exchange({ code: late, deviceJwk: key.deviceJwk, seal: seal.seal })),
    ).toBe("code_unknown");
    const fresh = code(h.handle);
    h.clock.advance(59_000);
    expect(
      (await h.handle.exchange({ code: fresh, deviceJwk: key.deviceJwk, seal: seal.seal })).ok,
    ).toBe(true);
  });

  test("a code exists only by spending a boot ticket", async () => {
    const h = home();
    const { signIn, sealed } = await ui();
    const key = await signIn.makeDeviceKey();
    const seal = await sealed.makeSeal();
    const invented = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    expect(
      reasonOf(
        await h.handle.exchange({ code: invented, deviceJwk: key.deviceJwk, seal: seal.seal }),
      ),
    ).toBe("code_unknown");
    expect(h.handle.mintExchangeCode("0".repeat(64))).toBeUndefined();
    const path = h.handle.mintBootTicket();
    expect(h.handle.mintExchangeCode(path.slice(6))).toBeDefined();
    // The ticket is spent with its first code.
    expect(h.handle.mintExchangeCode(path.slice(6))).toBeUndefined();
  });

  test("at most 256 codes and 256 challenges live at once", () => {
    const h = home();
    for (let i = 0; i < 300; i++) {
      code(h.handle);
      h.handle.challenge();
    }
    expect(h.handle.pending()).toEqual({ codes: 256, challenges: 256 });
  });
});

describe("returning browsers", () => {
  test("a device key signs a challenge for a new session", async () => {
    const h = home();
    const b = await enrol(h.handle);
    const answer = issuedOf(await returning(h.handle, b));
    expect(answer.device).toBe(b.device);
  });

  test("a challenge works once, and not after 60 seconds", async () => {
    const h = home();
    const b = await enrol(h.handle);
    const { signIn, sealed } = await ui();
    const { nonce } = h.handle.challenge();
    const seal = await sealed.makeSeal();
    const signature = await signIn.signChallenge(b.privateKey, {
      device: b.device,
      nonce,
      seal: seal.seal,
    });
    const input = { device: b.device, nonce, signature, seal: seal.seal };
    expect((await h.handle.signInWithDevice(input)).ok).toBe(true);
    expect(reasonOf(await h.handle.signInWithDevice(input))).toBe("challenge_unknown");

    const late = h.handle.challenge();
    h.clock.advance(60_000);
    const lateSig = await signIn.signChallenge(b.privateKey, {
      device: b.device,
      nonce: late.nonce,
      seal: seal.seal,
    });
    expect(
      reasonOf(
        await h.handle.signInWithDevice({ ...input, nonce: late.nonce, signature: lateSig }),
      ),
    ).toBe("challenge_unknown");
  });

  test("a signature by another key, or over another seal, is refused", async () => {
    const h = home();
    const b = await enrol(h.handle);
    const { signIn, sealed } = await ui();
    const stranger = await signIn.makeDeviceKey();
    expect(reasonOf(await returning(h.handle, b, { signWith: stranger.privateKey }))).toBe(
      "signature_invalid",
    );
    // A relay that swaps in its own seal cannot reuse the browser's signature.
    const relay = await sealed.makeSeal();
    expect(reasonOf(await returning(h.handle, b, { signSeal: relay.seal }))).toBe(
      "signature_invalid",
    );
  });

  test("an unknown, a withdrawn and a 30-day-idle device are refused with their reason", async () => {
    const h = home();
    const b = await enrol(h.handle);
    const unknown = { device: mintId("dev"), privateKey: b.privateKey };
    expect(reasonOf(await returning(h.handle, unknown))).toBe("device_unknown");

    h.clock.advance(29 * DAY);
    expect((await returning(h.handle, b)).ok).toBe(true);
    // That sign-in restarts the 30 days, from now.
    h.clock.advance(30 * DAY);
    expect(reasonOf(await returning(h.handle, b))).toBe("device_expired");

    const fresh = await enrol(h.handle);
    const rotated = await rotateBootstrap(h.root, { localActor: LOCAL, now: h.clock.now });
    expect(rotated.ok).toBe(true);
    expect(reasonOf(await returning(h.handle, fresh))).toBe("device_revoked");
  });
});

describe("sessions", () => {
  test("a session slides for an hour from its last use", async () => {
    const h = home();
    const b = await enrol(h.handle);
    h.clock.advance(59 * MINUTE);
    expect((await h.handle.verifyBearer(b.secret)).ok).toBe(true);
    h.clock.advance(59 * MINUTE);
    expect((await h.handle.verifyBearer(b.secret)).ok).toBe(true);
    h.clock.advance(61 * MINUTE);
    expect(await h.handle.verifyBearer(b.secret)).toEqual({ ok: false, reason: "session_expired" });
  });

  test("a session ends at 12 hours however busy", async () => {
    const h = home();
    const b = await enrol(h.handle);
    let uses = 0;
    for (let t = MINUTE; t < 12 * HOUR; t += MINUTE) {
      h.clock.advance(MINUTE);
      if (!(await h.handle.verifyBearer(b.secret)).ok) throw new Error(`refused at ${t}`);
      uses += 1;
    }
    expect(uses).toBe(12 * 60 - 1);
    h.clock.advance(MINUTE);
    expect(await h.handle.verifyBearer(b.secret)).toEqual({ ok: false, reason: "session_expired" });
  }, 20_000); // 719 lookups, each a sha256

  test("a new handle over the same files keeps a live session", async () => {
    const h = home();
    const b = await enrol(h.handle);
    h.clock.advance(30 * MINUTE);
    expect((await h.reopen().verifyBearer(b.secret)).ok).toBe(true);
    // After a restart the hour runs from the session's row, not from a use the old process saw.
    h.clock.advance(31 * MINUTE);
    expect((await h.reopen().verifyBearer(b.secret)).ok).toBe(false);
  });

  test("a refresh ends the old secret and keeps the deadline", async () => {
    const h = home();
    const b = await enrol(h.handle);
    const check = await h.handle.verifyBearer(b.secret);
    if (!check.ok) throw new Error("no session");
    const { sealed } = await ui();
    const seal = await sealed.makeSeal();
    h.clock.advance(HOUR / 2);
    const answer = issuedOf(await h.handle.refresh(check.sessionRef, seal.seal));
    const fresh = await seal.open(answer.issued, "auth.refresh");
    expect(fresh).not.toBe(b.secret);
    expect((await h.handle.verifyBearer(b.secret)).ok).toBe(false);
    expect((await h.handle.verifyBearer(fresh)).ok).toBe(true);
    expect(Date.parse(answer.expiresAt)).toBe(Date.parse("2026-11-01T12:00:00.000Z"));
  });

  test("signing out ends the session and tells its streams", async () => {
    const h = home();
    const b = await enrol(h.handle);
    const check = await h.handle.verifyBearer(b.secret);
    if (!check.ok) throw new Error("no session");
    const heard: string[] = [];
    h.handle.onEnd(check.sessionRef, (end) => heard.push(end));
    expect(await h.handle.signOut(check.sessionRef)).toEqual({ signedOut: true });
    expect(heard).toEqual(["revoked"]);
    expect((await h.handle.verifyBearer(b.secret)).ok).toBe(false);
  });

  test("a watched session is reported expired by the check, once", async () => {
    const h = home();
    const b = await enrol(h.handle);
    const check = await h.handle.verifyBearer(b.secret);
    if (!check.ok) throw new Error("no session");
    const heard: string[] = [];
    h.handle.onEnd(check.sessionRef, (end) => heard.push(end));
    h.clock.advance(59 * MINUTE);
    h.handle.checkSessions();
    expect(heard).toEqual([]);
    h.clock.advance(2 * MINUTE);
    h.handle.checkSessions();
    h.handle.checkSessions();
    expect(heard).toEqual(["expired"]);
  });

  test("a rotation in another process ends a watched session at the next check", async () => {
    const h = home();
    const b = await enrol(h.handle);
    const check = await h.handle.verifyBearer(b.secret);
    if (!check.ok) throw new Error("no session");
    const heard: string[] = [];
    h.handle.onEnd(check.sessionRef, (end) => heard.push(end));
    expect((await rotateBootstrap(h.root, { localActor: LOCAL, now: h.clock.now })).ok).toBe(true);
    h.handle.checkSessions();
    expect(heard).toEqual(["revoked"]);
    expect((await h.handle.verifyBearer(b.secret)).ok).toBe(false);
  });

  test("issuing a session leaves the access revision alone; ending one moves it", async () => {
    const h = home();
    const b = await enrol(h.handle);
    const epoch = (): number => {
      const read = readRevision(h.root);
      return read.state === "present" ? read.value.epoch : 0;
    };
    const before = epoch();
    const rows = rowCount(h.root, "access/sessions.jsonl");
    issuedOf(await returning(h.handle, b));
    expect(rowCount(h.root, "access/sessions.jsonl")).toBe(rows + 1);
    expect(epoch()).toBe(before);
    const check = await h.handle.verifyBearer(b.secret);
    if (!check.ok) throw new Error("no session");
    const { sealed } = await ui();
    issuedOf(await h.handle.refresh(check.sessionRef, (await sealed.makeSeal()).seal));
    expect(epoch()).toBe(before);
    const live = await returning(h.handle, b);
    const secret = await (async () => {
      const seal = await sealed.makeSeal();
      const { signIn } = await ui();
      const { nonce } = h.handle.challenge();
      const signature = await signIn.signChallenge(b.privateKey, {
        device: b.device,
        nonce,
        seal: seal.seal,
      });
      return seal.open(
        issuedOf(
          await h.handle.signInWithDevice({ device: b.device, nonce, signature, seal: seal.seal }),
        ).issued,
        "auth.session",
      );
    })();
    expect(live.ok).toBe(true);
    const mine = await h.handle.verifyBearer(secret);
    if (!mine.ok) throw new Error("no session");
    await h.handle.signOut(mine.sessionRef);
    expect(epoch()).toBe(before + 1);
  });
});

describe("joining from an invite", () => {
  async function invited(role = "operator", scope?: string) {
    const fixture = await homeFixture();
    const harness = fixture.addHarness("a");
    const minted = ok(
      await fixture.access.createInvite(fixture.actor, {
        role,
        scope: scope ?? `harness:${harness.id}`,
      }),
    );
    const handle = openSignIn(fixture.root, {
      now: fixture.clock.now,
      localActor: LOCAL,
      harnesses: () => fixture.harnesses,
    });
    return { fixture, harness, handle, code: minted.code };
  }

  const sessionSecret = (): string =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

  test("one member, one grant of the invite's role and scope, one device and one session", async () => {
    const { fixture, harness, handle, code: inviteCode } = await invited();
    const { signIn, sealed } = await ui();
    const key = await signIn.makeDeviceKey();
    const seal = await sealed.makeSeal();
    const before = fixture.snapshot();
    const answer = await handle.acceptInvite({
      code: inviteCode,
      displayName: "Ana",
      deviceJwk: key.deviceJwk,
      seal: seal.seal,
    });
    if (!answer.ok || "tabOnly" in answer) throw new Error("expected a sealed session");
    const secret = await seal.open(answer.issued, "auth.acceptInvite");
    const after = fixture.snapshot();
    const added = after.principals.filter((p) => !before.principals.some((q) => q.id === p.id));
    expect(added.map((p) => [p.id, p.kind])).toEqual([[answer.principal, "member"]]);
    const grants = after.grants.filter((g) => g.principal === answer.principal);
    expect(grants.map((g) => [g.role, g.scope, g.grantedBy])).toEqual([
      ["operator", `harness:${harness.id}`, fixture.owner],
    ]);
    expect(after.subjects.principals[answer.principal]?.displayName).toBe("Ana");
    expect(rowCount(fixture.root, join("access", "devices.jsonl"))).toBe(1);
    expect(rowCount(fixture.root, join("access", "sessions.jsonl"))).toBe(1);
    const check = await handle.verifyBearer(secret);
    expect(check.ok && check.principal).toBe(answer.principal);
    expect(check.ok && check.device).toBe(answer.device);
    // The invite is spent, and names who spent it.
    expect(after.invites.map((i) => [i.state, i.principal])).toEqual([
      ["consumed", answer.principal],
    ]);
  });

  test("a second use of the same code is refused as consumed, and writes nothing", async () => {
    const { fixture, handle, code: inviteCode } = await invited();
    const first = await handle.acceptInvite({
      code: inviteCode,
      displayName: "Ana",
      sessionSecret: sessionSecret(),
      bindHost: "192.168.1.20",
    });
    expect(first.ok).toBe(true);
    const principals = fixture.snapshot().principals.length;
    const second = await handle.acceptInvite({
      code: inviteCode,
      displayName: "Bo",
      sessionSecret: sessionSecret(),
      bindHost: "192.168.1.20",
    });
    expect(second.ok === false && `${second.status} ${second.reason}`).toBe("401 consumed");
    expect(fixture.snapshot().principals.length).toBe(principals);
  });

  test("an expired, a withdrawn or an unknown invite is refused by reason", async () => {
    const { fixture, handle, code: inviteCode } = await invited();
    const accept = (codeText: string) =>
      handle.acceptInvite({
        code: codeText,
        displayName: "Ana",
        sessionSecret: sessionSecret(),
        bindHost: "192.168.1.20",
      });
    const reasonOf = (answer: Awaited<ReturnType<typeof accept>>) =>
      answer.ok ? "ok" : `${answer.status} ${answer.reason}`;
    const withdrawn = ok(
      await fixture.access.createInvite(fixture.actor, { role: "viewer", scope: "home" }),
    );
    ok(await fixture.access.revoke(fixture.actor, withdrawn.invite.id));
    expect(reasonOf(await accept(withdrawn.code))).toBe("401 revoked");
    expect(reasonOf(await accept(`chi_${"Z".repeat(43)}`))).toBe("401 unknown");
    fixture.clock.advance(DAY + 1);
    expect(reasonOf(await accept(inviteCode))).toBe("401 expired");
    expect(fixture.snapshot().principals.length).toBe(1);
  });

  test("the display name is kept only in subjects.json, never in a ledger line", async () => {
    const { fixture, handle, code: inviteCode } = await invited();
    const name = ["Zephyrine", "Quillfeather"].join(" ");
    const answer = await handle.acceptInvite({
      code: inviteCode,
      displayName: name,
      sessionSecret: sessionSecret(),
      bindHost: "192.168.1.20",
    });
    expect(answer.ok).toBe(true);
    const access = join(fixture.root, "access");
    const ledgers = filesUnder(access).filter((rel) => rel.endsWith(".jsonl"));
    expect(ledgers.length).toBeGreaterThan(3);
    for (const rel of ledgers) {
      expect(`${rel}:${readFileSync(join(access, rel), "utf8").includes("Zephyrine")}`).toBe(
        `${rel}:false`,
      );
    }
    expect(readFileSync(join(access, "subjects.json"), "utf8")).toContain(name);
  });

  test("a tab-only session keeps only a digest, answers no secret, and cannot be renewed", async () => {
    const { fixture, handle, code: inviteCode } = await invited("viewer", "home");
    const secret = sessionSecret();
    const answer = await handle.acceptInvite({
      code: inviteCode,
      displayName: "Ana",
      sessionSecret: secret,
      bindHost: "192.168.1.20",
    });
    if (!answer.ok || !("tabOnly" in answer)) throw new Error("expected a tab-only answer");
    expect(Object.keys(answer).sort()).toEqual(["expiresAt", "ok", "principal", "tabOnly"]);
    const sessions = readFileSync(join(fixture.root, "access", "sessions.jsonl"), "utf8");
    expect(sessions).not.toContain(secret);
    const row = JSON.parse(sessions.trim()) as Record<string, unknown>;
    expect(row["sha256"]).toBe(await sha256Hex(`cha_${secret}`));
    expect([row["tabOnly"], row["bindHost"], row["device"]]).toEqual([
      true,
      "192.168.1.20",
      undefined,
    ]);
    const check = await handle.verifyBearer(`cha_${secret}`);
    expect(check.ok && [check.tabOnly, check.bindHost, check.device]).toEqual([
      true,
      "192.168.1.20",
      undefined,
    ]);
    const { sealed } = await ui();
    const seal = await sealed.makeSeal();
    const renewed = await handle.refresh(check.ok ? check.sessionRef : "", seal.seal);
    expect(renewed.ok === false && `${renewed.status} ${renewed.reason}`).toBe("403 tab_only");
  });

  test("a tab-only session counts only over TCP, on its own address, unrelayed", async () => {
    const { handle, code: inviteCode } = await invited("viewer", "home");
    const secret = sessionSecret();
    expect(
      (
        await handle.acceptInvite({
          code: inviteCode,
          displayName: "Ana",
          sessionSecret: secret,
          bindHost: "192.168.1.20",
        })
      ).ok,
    ).toBe(true);
    const lan = { lanHost: "192.168.1.20" };
    const at = (host: string, extra: Record<string, string> = {}) =>
      new Request(`http://${host}/api/harnesses`, {
        headers: { host, authorization: `Bearer cha_${secret}`, ...extra },
      });
    const reason = async (
      req: Request,
      peer: { address: string | null; listener: "tcp" | "home.sock" | "proxy.sock" },
      config = lan,
    ) => {
      const answer = await authenticate(req, peer, config, {
        signIn: handle,
        bootToken: undefined,
      });
      return answer.kind === "refused" ? `${answer.status} ${answer.reason}` : answer.kind;
    };
    const phone = { address: "192.168.1.31", listener: "tcp" as const };
    expect(await reason(at("192.168.1.20:4200"), phone)).toBe("principal");
    expect(await reason(at("home.example.test:4200"), phone)).toBe("403 tab_only");
    expect(await reason(at("192.168.1.20:4200", { "x-forwarded-for": "10.0.0.9" }), phone)).toBe(
      "403 tab_only",
    );
    expect(
      await reason(at("192.168.1.20:4200", { "crewhaus-proxy-secret": "anything" }), phone),
    ).toBe("403 tab_only");
    expect(await reason(at("192.168.1.20:4200"), { address: null, listener: "home.sock" })).toBe(
      "403 tab_only",
    );
    // Home started again without the LAN door, or on another address: the session is done.
    expect(await reason(at("192.168.1.20:4200"), phone, {} as typeof lan)).toBe("403 tab_only");
    expect(await reason(at("192.168.1.20:4200"), phone, { lanHost: "192.168.1.21" })).toBe(
      "403 tab_only",
    );
  });

  test("a write that fails after the claim answers 503, and the invite stays spent", async () => {
    const { fixture, handle, code: inviteCode } = await invited("viewer", "home");
    // The session ledger cannot take a line: the failure comes after the claim is won.
    mkdirSync(join(fixture.root, "access", "sessions.jsonl"));
    const secret = sessionSecret();
    const answer = await handle.acceptInvite({
      code: inviteCode,
      displayName: "Ana",
      sessionSecret: secret,
      bindHost: "192.168.1.20",
    });
    expect(answer.ok === false && `${answer.status} ${answer.reason}`).toBe("503 unavailable");
    expect(answer.ok === false && answer.message).toContain("new invite");
    const snapshot = fixture.snapshot();
    expect(snapshot.invites.map((i) => i.state)).toEqual(["consumed"]);
    // Whatever was written before the failure has no way to authenticate.
    expect((await handle.verifyBearer(`cha_${secret}`)).ok).toBe(false);
    rmSync(join(fixture.root, "access", "sessions.jsonl"), { recursive: true });
    const again = await handle.acceptInvite({
      code: inviteCode,
      displayName: "Ana",
      sessionSecret: secret,
      bindHost: "192.168.1.20",
    });
    expect(again.ok === false && again.reason).toBe("consumed");
    expect((await handle.verifyBearer(`cha_${secret}`)).ok).toBe(false);
  });

  test("a body without two usable keys or a valid secret is refused before the invite is spent", async () => {
    const { fixture, handle, code: inviteCode } = await invited();
    const bad = await handle.acceptInvite({
      code: inviteCode,
      displayName: "Ana",
      sessionSecret: "short",
      bindHost: "192.168.1.20",
    });
    expect(bad.ok === false && `${bad.status} ${bad.reason}`).toBe("400 invalid");
    const named = await handle.acceptInvite({
      code: inviteCode,
      displayName: "   ",
      sessionSecret: sessionSecret(),
      bindHost: "192.168.1.20",
    });
    expect(named.ok === false && `${named.status} ${named.reason}`).toBe("400 invalid");
    expect(fixture.snapshot().invites.map((i) => i.state)).toEqual(["open"]);
  });
});
