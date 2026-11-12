/**
 * The sign-in handle: exchange codes, challenges, device keys and sessions, on a fake
 * clock. Devices sign with the browser module Home serves, so the signed bytes cannot
 * drift between the two halves.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { rotateBootstrap } from "./bootstrap";
import { readRevision } from "./files";
import { type SessionIssue, type SignInHandle, type SignInRefusal, openSignIn } from "./sign-in";
import type { DeviceJwk } from "./sign-in-records";
import {
  BOOTSTRAP_TOKEN,
  DAY,
  HOUR,
  LOCAL,
  fakeClock,
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
