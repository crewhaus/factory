/**
 * Scoped tokens: minted only from a live service token, only for run refs and read acts the
 * service may delegate, for at most 15 minutes; checked by MAC, clock, the minter's
 * credential and the service's scoped-token epoch every time. Each refusal is asserted by
 * its reason.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { append } from "@crewhaus/control-records";
import { authenticate } from "./authenticate";
import { accessLedger, accessPaths } from "./paths";
import {
  SCOPED_TOKEN_TTL_MS,
  type ScopedMintAnswer,
  ensureScopedKey,
  mintScopedToken,
  verifyScopedToken,
} from "./scoped";
import { openSignIn } from "./sign-in";
import { isLiveCredential, loadAccessSnapshot } from "./snapshot";
import { LOCAL, filesUnder, homeFixture, ok, removeTempDirs } from "./test-helpers";

afterAll(removeTempDirs);

const MINUTE = 60_000;

async function serviceHome(options: { contentRead?: boolean } = {}) {
  const home = await homeFixture();
  const a = home.addHarness("a");
  const b = home.addHarness("b");
  const minted = ok(
    await home.access.mintServiceToken(home.actor, {
      service: "portal",
      permissions: [],
      harnesses: [a.id],
      ...(options.contentRead === true ? { contentRead: true } : {}),
    }),
  );
  return { home, a, b, minted, credential: minted.token.id };
}

const runRef = (harness: string, run = "run_0badcafe"): string => `${harness}/run/${run}`;

function tokenOf(answer: ScopedMintAnswer): string {
  if (!answer.ok) throw new Error(`expected a token, got ${answer.reason}: ${answer.message}`);
  return answer.token;
}

describe("mintScopedToken and verifyScopedToken", () => {
  test("a minted token verifies as its service, with exactly its refs and acts", async () => {
    const { home, a, minted, credential } = await serviceHome({ contentRead: true });
    const answer = await mintScopedToken(
      home.root,
      { credential, refs: [runRef(a.id)], acts: ["run.events.read", "run.result.read"] },
      { now: home.clock.now },
    );
    const token = tokenOf(answer);
    expect(token.startsWith("chx_")).toBe(true);
    expect(answer.ok && answer.expiresAt).toBe(
      new Date(home.clock.now() + SCOPED_TOKEN_TTL_MS.default).toISOString(),
    );
    const key = await ensureScopedKey(home.root);
    const verified = await verifyScopedToken(token, home.snapshot(), key, home.clock.now());
    expect(verified).toEqual({
      ok: true,
      principal: minted.principal,
      credential,
      refs: [runRef(a.id)],
      acts: ["run.events.read", "run.result.read"],
      exp: home.clock.now() + 15 * MINUTE,
      ep: 0,
    });
    // The sign-in handle reads the same key, and never makes one.
    const signIn = openSignIn(home.root, { now: home.clock.now, localActor: LOCAL });
    expect(await signIn.scopedKey()).toBeDefined();
  });

  test("each mint refusal names its reason", async () => {
    const { home, a, b, credential } = await serviceHome();
    const mint = (input: Partial<Parameters<typeof mintScopedToken>[1]>) =>
      mintScopedToken(
        home.root,
        { credential, refs: [runRef(a.id)], acts: ["run.result.read"], ...input },
        { now: home.clock.now },
      );
    const reasonOf = async (input: Partial<Parameters<typeof mintScopedToken>[1]>) => {
      const answer = await mint(input);
      return answer.ok ? "ok" : answer.reason;
    };
    expect(await reasonOf({})).toBe("ok");
    expect(await reasonOf({ ttlMs: 15 * MINUTE + 1 })).toBe("ttl");
    expect(await reasonOf({ ttlMs: 0 })).toBe("ttl");
    expect(await reasonOf({ refs: [] })).toBe("no-refs");
    expect(await reasonOf({ refs: [`${a.id}/deployment/dep_01h0000000000000000000000a`] })).toBe(
      "ref",
    );
    expect(await reasonOf({ refs: ["not a ref"] })).toBe("ref");
    // A supervisor execution id is an exec ref, not a run ref.
    expect(await reasonOf({ refs: [runRef(a.id, "run_00000000000000a1")] })).toBe("ref");
    expect(await reasonOf({ acts: ["run.events.write"] })).toBe("act");
    expect(await reasonOf({ acts: [] })).toBe("act");
    // The service reads results on A but not content: it cannot delegate the event stream.
    expect(await reasonOf({ acts: ["run.events.read"] })).toBe("not-held");
    // …and holds nothing on B.
    expect(await reasonOf({ refs: [runRef(a.id), runRef(b.id)] })).toBe("not-held");
    expect(await reasonOf({ credential: "crd_01h00000000000000000000000" })).toBe("credential");
    expect(await reasonOf({ credential: "nope" })).toBe("credential");
  });

  test("a token is refused for a bad shape, one flipped MAC character, its clock and its minter", async () => {
    const { home, a, credential } = await serviceHome();
    const token = tokenOf(
      await mintScopedToken(
        home.root,
        { credential, refs: [runRef(a.id)], acts: ["run.result.read"], ttlMs: 5 * MINUTE },
        { now: home.clock.now },
      ),
    );
    const key = await ensureScopedKey(home.root);
    const verify = async (secret: string, at = home.clock.now()) => {
      const answer = await verifyScopedToken(secret, home.snapshot(), key, at);
      return answer.ok ? "ok" : answer.reason;
    };
    expect(await verify(token)).toBe("ok");
    expect(await verify("chx_nodot")).toBe("token_invalid");
    expect(await verify(`${token}x`)).toBe("token_invalid");
    const last = token.at(-2) === "A" ? "B" : "A";
    expect(await verify(`${token.slice(0, -2)}${last}${token.slice(-1)}`)).toBe("token_invalid");
    // A payload rewritten to widen the token fails its MAC.
    const [payload, mac] = token.slice(4).split(".") as [string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const widened = Buffer.from(
      JSON.stringify({ ...claims, acts: ["run.events.read", "run.result.read"] }),
    ).toString("base64url");
    expect(await verify(`chx_${widened}.${mac}`)).toBe("token_invalid");
    expect(await verify(token, home.clock.now() + 5 * MINUTE)).toBe("token_expired");
    expect(await verifyScopedToken(token, home.snapshot(), undefined, home.clock.now())).toEqual({
      ok: false,
      reason: "token_invalid",
    });
    ok(await home.access.revoke(home.actor, credential));
    expect(await verify(token)).toBe("credential_unknown");
  });

  test("the key file is 0600 inside access/, and no token is kept on disk", async () => {
    const { home, a, credential } = await serviceHome();
    const token = tokenOf(
      await mintScopedToken(
        home.root,
        { credential, refs: [runRef(a.id)], acts: ["run.result.read"] },
        { now: home.clock.now },
      ),
    );
    const keyPath = join(home.root, accessPaths().scopedKey);
    if (process.platform !== "win32") expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(
      accessPaths().scopedKey.startsWith(`access${process.platform === "win32" ? "\\" : "/"}`),
    ).toBe(true);
    const [, mac] = token.slice(4).split(".") as [string, string];
    const files = filesUnder(home.root);
    expect(files.length).toBeGreaterThan(3);
    for (const rel of files) {
      const text = readFileSync(join(home.root, rel), "utf8");
      expect(`${rel}:${text.includes(token) || text.includes(mac)}`).toBe(`${rel}:false`);
    }
  });
});

describe("supervisor executions", () => {
  test("a <hrn>/exec/run_<16 hex> ref mints, and verifies with that ref", async () => {
    const { home, a, credential } = await serviceHome({ contentRead: true });
    const ref = `${a.id}/exec/run_0123456789abcdef`;
    const token = tokenOf(
      await mintScopedToken(
        home.root,
        { credential, refs: [ref], acts: ["run.result.read"] },
        { now: home.clock.now },
      ),
    );
    const verified = await verifyScopedToken(
      token,
      home.snapshot(),
      await ensureScopedKey(home.root),
      home.clock.now(),
    );
    expect(verified.ok && verified.refs).toEqual([ref]);
  });

  test("an eval run's ref is refused as not a run", async () => {
    const { home, a, credential } = await serviceHome();
    const answer = await mintScopedToken(
      home.root,
      { credential, refs: [`${a.id}/evalrun/run_0123456789abcdef`], acts: ["run.result.read"] },
      { now: home.clock.now },
    );
    expect(answer.ok === false && answer.reason).toBe("ref");
  });
});

/** The claims a token carries, decoded. */
function claimsIn(token: string): Record<string, unknown> {
  const [payload] = token.slice(4).split(".") as [string, string];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/** A token over these claims, signed with the real key: its MAC checks. */
async function signed(root: string, claims: Record<string, unknown>): Promise<string> {
  const key = await ensureScopedKey(root);
  if (key === undefined) throw new Error("no key");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `chx_${payload}.${Buffer.from(mac).toString("base64url")}`;
}

describe("a service's scoped epoch", () => {
  const mintFor = async (
    home: Awaited<ReturnType<typeof serviceHome>>["home"],
    credential: string,
    harness: string,
  ): Promise<string> =>
    tokenOf(
      await mintScopedToken(
        home.root,
        { credential, refs: [runRef(harness)], acts: ["run.result.read"] },
        { now: home.clock.now },
      ),
    );

  test("a bump ends the scoped tokens minted before it, and the service's own token stays live", async () => {
    const { home, a, minted, credential } = await serviceHome();
    const key = await ensureScopedKey(home.root);
    const verify = async (token: string) => {
      const answer = await verifyScopedToken(token, home.snapshot(), key, home.clock.now());
      return answer.ok ? "ok" : answer.reason;
    };
    const before = await mintFor(home, credential, a.id);
    expect(claimsIn(before)["ep"]).toBe(0);
    expect(await verify(before)).toBe("ok");

    const bumped = ok(await home.access.bumpScopedEpoch(home.actor, minted.principal));
    expect(bumped).toEqual({ principal: minted.principal, scopedEpoch: 1 });
    expect(await verify(before)).toBe("token_revoked");

    // The minting service token is still live, and still signs its service in.
    const snapshot = home.snapshot();
    const row = snapshot.tokens.find((t) => t.id === credential);
    if (row === undefined) throw new Error("no credential row");
    expect(isLiveCredential(snapshot, row, home.clock.now())).toBe(true);
    const signIn = openSignIn(home.root, { now: home.clock.now, localActor: LOCAL });
    const answer = await authenticate(
      new Request("http://127.0.0.1:4200/api/harnesses", {
        headers: { authorization: `Bearer ${minted.secret}` },
      }),
      { address: "192.168.1.20", listener: "tcp" },
      {},
      { signIn, bootToken: undefined, now: home.clock.now },
    );
    expect(answer).toMatchObject({
      kind: "principal",
      principal: minted.principal,
      via: "service",
      credential,
    });

    const after = await mintFor(home, credential, a.id);
    expect(claimsIn(after)["ep"]).toBe(1);
    expect(await verify(after)).toBe("ok");
  });

  test("one service's bump leaves another service's scoped tokens alone", async () => {
    const { home, a, minted } = await serviceHome();
    const other = ok(
      await home.access.mintServiceToken(home.actor, {
        service: "kiosk",
        permissions: [],
        harnesses: [a.id],
      }),
    );
    const token = await mintFor(home, other.token.id, a.id);
    ok(await home.access.bumpScopedEpoch(home.actor, minted.principal));
    const verified = await verifyScopedToken(
      token,
      home.snapshot(),
      await ensureScopedKey(home.root),
      home.clock.now(),
    );
    expect(verified.ok && verified.principal).toBe(other.principal);
  });

  test("a payload whose epoch is missing, negative or fractional is refused, even with a good MAC", async () => {
    const { home, a, credential } = await serviceHome();
    const claims = claimsIn(await mintFor(home, credential, a.id));
    const key = await ensureScopedKey(home.root);
    const verify = async (token: string) => {
      const answer = await verifyScopedToken(token, home.snapshot(), key, home.clock.now());
      return answer.ok ? "ok" : answer.reason;
    };
    // The re-signed original verifies, so the MAC is not what refuses the others.
    expect(await verify(await signed(home.root, claims))).toBe("ok");
    const { ep: _ep, ...withoutEpoch } = claims;
    expect(await verify(await signed(home.root, withoutEpoch))).toBe("token_invalid");
    expect(await verify(await signed(home.root, { ...claims, ep: -1 }))).toBe("token_invalid");
    expect(await verify(await signed(home.root, { ...claims, ep: 1.5 }))).toBe("token_invalid");
    expect(await verify(await signed(home.root, { ...claims, ep: "0" }))).toBe("token_invalid");
  });

  test("each bump refusal names its code, and a bump writes one principals row and nothing else", async () => {
    const { home, minted } = await serviceHome();
    const viewer = ok(
      await home.access.grant(home.actor, {
        member: "Sam",
        create: true,
        role: "viewer",
        scope: "home",
      }),
    ).principal;
    const codeOf = async (actor: { principal: string }, service: string) => {
      const answer = await home.access.bumpScopedEpoch(actor, service);
      return answer.ok ? "ok" : answer.code;
    };
    expect(await codeOf(home.actor, "portal")).toBe("invalid");
    expect(await codeOf(home.actor, "prn_01h00000000000000000000000")).toBe("not-found");
    expect(await codeOf(home.actor, viewer)).toBe("invalid");
    expect(await codeOf({ principal: viewer }, minted.principal)).toBe("not-authorized");

    const principals = join(home.root, accessPaths().ledgers.principals);
    const credentials = join(home.root, accessPaths().ledgers.credentials);
    const linesOf = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);
    const principalLines = linesOf(principals).length;
    const credentialBytes = readFileSync(credentials);
    expect(await codeOf(home.actor, minted.principal)).toBe("ok");
    const lines = linesOf(principals);
    expect(lines).toHaveLength(principalLines + 1);
    expect(JSON.parse(lines.at(-1) as string)).toMatchObject({
      id: minted.principal,
      kind: "service",
      state: "active",
      scopedEpoch: 1,
      by: home.owner,
    });
    expect(readFileSync(credentials).equals(credentialBytes)).toBe(true);
    expect(await codeOf(home.actor, minted.principal)).toBe("ok");
    expect(home.snapshot().principals.find((p) => p.id === minted.principal)?.scopedEpoch).toBe(2);

    // The epoch survives the service's removal, and a removed service is not bumped.
    ok(await home.access.removeMember(home.actor, minted.principal));
    expect(home.snapshot().principals.find((p) => p.id === minted.principal)).toMatchObject({
      state: "removed",
      scopedEpoch: 2,
    });
    expect(await codeOf(home.actor, minted.principal)).toBe("ended");
  });

  test("a principals row whose epoch is on a member, 0 or fractional makes the records unreadable", async () => {
    const cases = [
      { on: "member", scopedEpoch: 1 },
      { on: "service", scopedEpoch: 0 },
      { on: "service", scopedEpoch: 1.5 },
    ] as const;
    for (const { on, scopedEpoch } of cases) {
      const { home, minted } = await serviceHome();
      const id = on === "member" ? home.owner : minted.principal;
      const target = home.snapshot().principals.find((p) => p.id === id);
      if (target === undefined) throw new Error("no principal");
      expect(target.kind).toBe(on);
      expect(append(accessLedger(home.root, "principals"), { ...target, scopedEpoch }).ok).toBe(
        true,
      );
      expect(`${on} ${scopedEpoch} ${loadAccessSnapshot(home.root).state}`).toBe(
        `${on} ${scopedEpoch} unreadable`,
      );
    }
  });
});
