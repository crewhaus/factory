/**
 * Home's own key and the boot tickets (moved here from hangar-server with their
 * behaviour), and rotation: a new key at 0600, the old digest refused at once, every
 * browser signed out, the revision moved once, and another user of this computer refused.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAccessSetUp } from "./access";
import { type Peer, authenticate } from "./authenticate";
import {
  BOOT_TICKET_TTL_MS,
  TOKEN_FILENAME,
  createBootTickets,
  ensureToken,
  rotateBootstrap,
  tokenEquals,
} from "./bootstrap";
import { readRevision } from "./files";
import { openSignIn } from "./sign-in";
import { foldSignIn } from "./sign-in-records";
import { loadAccessSnapshot } from "./snapshot";
import {
  BOOTSTRAP_TOKEN,
  LOCAL,
  fakeClock,
  removeTempDirs,
  rowCount,
  tempDir,
} from "./test-helpers";

afterAll(removeTempDirs);

const LOOPBACK: Peer = { address: "127.0.0.1", listener: "tcp" };
const SOCKET: Peer = { address: null, listener: "home.sock" };

function root(withToken = true): string {
  const dir = join(tempDir(), "hangar");
  mkdirSync(dir, { mode: 0o700 });
  if (withToken) writeFileSync(join(dir, TOKEN_FILENAME), `${BOOTSTRAP_TOKEN}\n`, { mode: 0o600 });
  return dir;
}

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("ensureToken", () => {
  test("mints a 64-hex token at 0600 once, and reads it back after", () => {
    const dir = join(tempDir(), "fresh", "hangar");
    const first = ensureToken(dir);
    expect(first.minted).toBe(true);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.tokenPath).toBe(join(dir, TOKEN_FILENAME));
    if (process.platform !== "win32") expect(modeOf(first.tokenPath as string)).toBe(0o600);
    const again = ensureToken(dir);
    expect(again).toEqual({ token: first.token, tokenPath: first.tokenPath, minted: false });
  });

  test("an explicit value wins and writes nothing; an empty file is re-minted", () => {
    const dir = root(false);
    expect(ensureToken(dir, "tok-abc123")).toEqual({ token: "tok-abc123", minted: false });
    writeFileSync(join(dir, TOKEN_FILENAME), "  \n");
    expect(ensureToken(dir).minted).toBe(true);
  });
});

describe("tokenEquals", () => {
  test("equal and unequal values, whatever their lengths", () => {
    expect(tokenEquals("abc", "abc")).toBe(true);
    expect(tokenEquals("abc", "abd")).toBe(false);
    expect(tokenEquals("abc", "abcd")).toBe(false);
    expect(tokenEquals("", "")).toBe(true);
  });
});

describe("boot tickets", () => {
  test("a ticket works once, is spent even when late, and expires at its TTL", () => {
    const tickets = createBootTickets();
    const path = tickets.mint(0);
    expect(path).toMatch(/^\/boot\/[0-9a-f]{64}$/);
    const nonce = path.slice("/boot/".length);
    expect(tickets.consume(nonce, BOOT_TICKET_TTL_MS - 1)).toBe("ok");
    expect(tickets.consume(nonce, 0)).toBeUndefined();

    const late = tickets.mint(0).slice("/boot/".length);
    expect(tickets.consume(late, BOOT_TICKET_TTL_MS)).toBeUndefined();
    // Deleted before its expiry was checked: no second try after the clock is wound back.
    expect(tickets.consume(late, 0)).toBeUndefined();
    expect(tickets.consume("0".repeat(64), 0)).toBeUndefined();
  });
});

describe("rotateBootstrap", () => {
  test("a new token at 0600: the old one refused at once, the new one accepted", async () => {
    const dir = root();
    const clock = fakeClock();
    const signIn = openSignIn(dir, { now: clock.now, localActor: LOCAL });
    const state = { signIn, bootToken: BOOTSTRAP_TOKEN, now: clock.now };
    const request = (token: string): Request =>
      new Request("http://127.0.0.1/api/version", {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await authenticate(request(BOOTSTRAP_TOKEN), LOOPBACK, {}, state)).kind).toBe(
      "principal",
    );

    const done = await rotateBootstrap(dir, { localActor: LOCAL, now: clock.now });
    if (!done.ok) throw new Error(done.reason);
    const path = join(dir, TOKEN_FILENAME);
    const fresh = readFileSync(path, "utf8").trim();
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh).not.toBe(BOOTSTRAP_TOKEN);
    if (process.platform !== "win32") expect(modeOf(path)).toBe(0o600);
    expect(done.result.tokenPath).toBe(path);
    expect(JSON.stringify(done.result)).not.toContain(fresh);

    const old = await authenticate(request(BOOTSTRAP_TOKEN), LOOPBACK, {}, state);
    expect(old.kind === "refused" && old.reason).toBe("credential_unknown");
    expect((await authenticate(request(fresh), LOOPBACK, {}, state)).kind).toBe("principal");
  });

  test("it ends every session, revokes every device and moves the revision once", async () => {
    const dir = root();
    const clock = fakeClock();
    const signIn = openSignIn(dir, { now: clock.now, localActor: LOCAL });
    const ui = {
      signIn: (await import(
        new URL("../../hangar-ui/assets/js/sign-in.js", import.meta.url).href
      )) as {
        makeDeviceKey(): Promise<{ deviceJwk: { kty: "EC"; crv: "P-256"; x: string; y: string } }>;
      },
      sealed: (await import(
        new URL("../../hangar-ui/assets/js/sealed.js", import.meta.url).href
      )) as {
        makeSeal(): Promise<{ seal: { kty: "EC"; crv: "P-256"; x: string; y: string } }>;
      },
    };
    for (let i = 0; i < 3; i++) {
      const code = signIn.mintExchangeCode(signIn.mintBootTicket().slice(6)) as string;
      const answer = await signIn.exchange({
        code,
        deviceJwk: (await ui.signIn.makeDeviceKey()).deviceJwk,
        seal: (await ui.sealed.makeSeal()).seal,
      });
      expect(answer.ok).toBe(true);
    }
    const epochOf = (): number => {
      const read = readRevision(dir);
      return read.state === "present" ? read.value.epoch : 0;
    };
    const before = epochOf();
    const credentials = rowCount(dir, "access/credentials.jsonl");
    const done = await rotateBootstrap(dir, { localActor: LOCAL, now: clock.now });
    if (!done.ok) throw new Error(done.reason);
    expect(done.result.endedSessions).toBe(3);
    expect(done.result.revokedDevices).toBe(3);
    expect(epochOf()).toBe(before + 1);
    // The old bootstrap revoked, a new one recorded.
    expect(rowCount(dir, "access/credentials.jsonl")).toBe(credentials + 2);
    const fold = foldSignIn(dir);
    if (!fold.ok) throw new Error(fold.reason);
    expect(
      [...fold.sessions.values()].every((row) => row.state === "ended" && row.reason === "rotated"),
    ).toBe(true);
    expect([...fold.devices.values()].every((row) => row.state === "revoked")).toBe(true);
    const snapshot = loadAccessSnapshot(dir);
    if (snapshot.state !== "present") throw new Error("no snapshot");
    const bootstraps = snapshot.snapshot.tokens.filter((row) => row.kind === "bootstrap");
    expect(bootstraps.map((row) => row.state).sort()).toEqual(["active", "revoked"]);
  });

  test("a Home with no access records gets them, then rotates", async () => {
    const dir = root();
    expect(loadAccessSnapshot(dir).state).toBe("absent");
    const done = await rotateBootstrap(dir, { localActor: LOCAL });
    if (!done.ok) throw new Error(done.reason);
    expect(done.result.setUp).toContain("owner");
    expect(done.result.endedSessions).toBe(0);
  });

  test("socket-only persists across a plain rotation, and --tcp clears it", async () => {
    const dir = root();
    const activeSocketOnly = (): boolean | undefined => {
      const read = loadAccessSnapshot(dir);
      if (read.state !== "present") return undefined;
      return read.snapshot.tokens.find((row) => row.kind === "bootstrap" && row.state === "active")
        ?.socketOnly;
    };
    const one = await rotateBootstrap(dir, { localActor: LOCAL, socketOnly: true });
    expect(one.ok && one.result.socketOnly).toBe(true);
    expect(activeSocketOnly()).toBe(true);
    const two = await rotateBootstrap(dir, { localActor: LOCAL });
    expect(two.ok && two.result.socketOnly).toBe(true);
    expect(activeSocketOnly()).toBe(true);
    const signIn = openSignIn(dir, { localActor: LOCAL });
    const token = readFileSync(join(dir, TOKEN_FILENAME), "utf8").trim();
    const request = new Request("http://127.0.0.1/", {
      headers: { authorization: `Bearer ${token}` },
    });
    const tcp = await authenticate(request, LOOPBACK, {}, { signIn, bootToken: token });
    expect(tcp.kind === "refused" && tcp.reason).toBe("bootstrap_not_accepted_here");
    expect((await authenticate(request, SOCKET, {}, { signIn, bootToken: token })).kind).toBe(
      "principal",
    );
    const three = await rotateBootstrap(dir, { localActor: LOCAL, tcp: true });
    expect(three.ok && three.result.socketOnly).toBe(false);
    expect(activeSocketOnly()).toBeUndefined();
  });

  test("another user of this computer is refused, and nothing changes", async () => {
    const dir = root();
    const setup = await ensureAccessSetUp(dir, { localActor: LOCAL });
    expect(setup.ok).toBe(true);
    const before = readFileSync(join(dir, TOKEN_FILENAME), "utf8");
    const done = await rotateBootstrap(dir, { localActor: "local:someone-else@laptop" });
    expect(!done.ok && done.code).toBe("not-authorized");
    expect(readFileSync(join(dir, TOKEN_FILENAME), "utf8")).toBe(before);
  });

  test("socket-only and TCP together are refused", async () => {
    const done = await rotateBootstrap(root(), { localActor: LOCAL, socketOnly: true, tcp: true });
    expect(!done.ok && done.code).toBe("invalid");
  });
});
