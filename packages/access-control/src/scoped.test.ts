/**
 * Scoped tokens: minted only from a live service token, only for run refs and read acts the
 * service may delegate, for at most 15 minutes; checked by MAC, clock and the minter's
 * credential every time. Each refusal is asserted by its reason.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { accessPaths } from "./paths";
import {
  SCOPED_TOKEN_TTL_MS,
  type ScopedMintAnswer,
  ensureScopedKey,
  mintScopedToken,
  verifyScopedToken,
} from "./scoped";
import { openSignIn } from "./sign-in";
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
