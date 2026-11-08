/** Invites: one use, a bounded lifetime, settled by a claim. */
import { afterAll, describe, expect, test } from "bun:test";
import { ISSUED_SECRET_RES } from "@crewhaus/control-contract";
import { publishClaim } from "@crewhaus/control-records";
import { INVITE_TTL_MS, redeemInvite } from "./access";
import { accessLedger, accessPaths, inviteEndClaim } from "./paths";
import { DAY, HOUR, homeFixture, ok, removeTempDirs, rowCount } from "./test-helpers";

afterAll(removeTempDirs);

async function inviteIn(home: Awaited<ReturnType<typeof homeFixture>>, ttlMs?: number) {
  return ok(
    await home.access.createInvite(home.actor, {
      role: "operator",
      scope: "home",
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    }),
  );
}

describe("createInvite", () => {
  test("a chi_ code, shown once, stored as its sha256 for 24 hours by default", async () => {
    const home = await homeFixture();
    const { invite, code } = await inviteIn(home);
    expect(ISSUED_SECRET_RES.invite.test(code)).toBe(true);
    expect(Date.parse(invite.expiresAt) - home.clock.now()).toBe(INVITE_TTL_MS.default);
    expect(INVITE_TTL_MS.default).toBe(DAY);
    const row = home.snapshot().invites[0];
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(home.snapshot())).not.toContain(code.slice(4));
  });

  test("a lifetime above 7 days is refused before anything is written", async () => {
    const home = await homeFixture();
    const answer = await home.access.createInvite(home.actor, {
      role: "viewer",
      scope: "home",
      ttlMs: 7 * DAY + 1,
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toContain("7 days");
    expect(rowCount(home.root, accessPaths().ledgers.invites)).toBe(0);
    expect(
      ok(
        await home.access.createInvite(home.actor, {
          role: "viewer",
          scope: "home",
          ttlMs: 7 * DAY,
        }),
      ).invite.state,
    ).toBe("open");
  });

  test("only the owner invites", async () => {
    const home = await homeFixture();
    const ana = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "maintainer",
        scope: "home",
      }),
    );
    const answer = await home.access.createInvite(
      { principal: ana.principal },
      { role: "viewer", scope: "home" },
    );
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe("not-authorized");
  });
});

describe("redeemInvite", () => {
  test("once wins; again is consumed; the epoch rises once, for the winner only", async () => {
    const home = await homeFixture();
    const { code, invite } = await inviteIn(home);
    const epoch = home.snapshot().epoch;
    const first = await redeemInvite(home.root, code, { now: home.clock.now });
    expect(first).toEqual(expect.objectContaining({ ok: true }));
    if (!first.ok) return;
    expect(first.invite.id).toBe(invite.id);
    expect(first.invite.state).toBe("consumed");
    expect(home.snapshot().epoch).toBe(epoch + 1);
    const second = await redeemInvite(home.root, code, { now: home.clock.now });
    expect(second).toEqual(expect.objectContaining({ ok: false, code: "consumed" }));
    expect(home.snapshot().epoch).toBe(epoch + 1);
    expect(home.snapshot().invites[0]).toEqual(
      expect.objectContaining({ state: "consumed", consumedAt: expect.any(String) }),
    );
  });

  test("two concurrent redemptions: exactly one wins, and the epoch rises once", async () => {
    const home = await homeFixture();
    const { code } = await inviteIn(home);
    const epoch = home.snapshot().epoch;
    const answers = await Promise.all([
      redeemInvite(home.root, code, { now: home.clock.now }),
      redeemInvite(home.root, code, { now: home.clock.now }),
      redeemInvite(home.root, code, { now: home.clock.now }),
    ]);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    for (const answer of answers.filter((a) => !a.ok)) {
      expect(answer).toEqual(expect.objectContaining({ code: "consumed" }));
    }
    expect(home.snapshot().epoch).toBe(epoch + 1);
  });

  test("at its expiry it is expired; a moment before, it works", async () => {
    const home = await homeFixture();
    const { code } = await inviteIn(home, 2 * HOUR);
    home.clock.advance(2 * HOUR);
    expect(await redeemInvite(home.root, code, { now: home.clock.now })).toEqual(
      expect.objectContaining({ ok: false, code: "expired" }),
    );
    home.clock.advance(-1);
    expect((await redeemInvite(home.root, code, { now: home.clock.now })).ok).toBe(true);
  });

  test("a revoked invite is refused as revoked, and a used one cannot be revoked", async () => {
    const home = await homeFixture();
    const withdrawn = await inviteIn(home);
    ok(await home.access.revoke(home.actor, withdrawn.invite.id));
    expect(await redeemInvite(home.root, withdrawn.code, { now: home.clock.now })).toEqual(
      expect.objectContaining({ ok: false, code: "revoked" }),
    );
    const used = await inviteIn(home);
    expect((await redeemInvite(home.root, used.code, { now: home.clock.now })).ok).toBe(true);
    const revoke = await home.access.revoke(home.actor, used.invite.id);
    expect(revoke).toEqual(expect.objectContaining({ ok: false, code: "ended" }));
  });

  test("the claim decides: a redemption that claimed but never appended still beats a revocation", async () => {
    const home = await homeFixture();
    const { code, invite } = await inviteIn(home);
    // A redeemer that died between its claim and its append: the ledger still reads open.
    const row = home.snapshot().invites[0];
    const claimed = publishClaim(accessLedger(home.root, "invites"), inviteEndClaim(invite.id), {
      ...row,
      state: "consumed",
      consumedAt: new Date(home.clock.now()).toISOString(),
      by: "sys:executor",
    });
    expect(claimed.ok).toBe(true);
    expect(home.snapshot().invites[0]?.state).toBe("open");
    const revoke = await home.access.revoke(home.actor, invite.id);
    expect(revoke).toEqual(expect.objectContaining({ ok: false, code: "ended" }));
    // The next redemption repairs the winner's row and loses.
    expect(await redeemInvite(home.root, code, { now: home.clock.now })).toEqual(
      expect.objectContaining({ ok: false, code: "consumed" }),
    );
    expect(home.snapshot().invites[0]?.state).toBe("consumed");
  });

  test("an unknown code, a malformed one and a Home with no records are unknown", async () => {
    const home = await homeFixture();
    await inviteIn(home);
    const other = ["chi_", "A".repeat(43)].join("");
    for (const code of [other, "chi_short", "", `chs_${"A".repeat(43)}`]) {
      expect(await redeemInvite(home.root, code, { now: home.clock.now })).toEqual(
        expect.objectContaining({ ok: false, code: "unknown" }),
      );
    }
    expect(await redeemInvite(`${home.root}-missing`, other)).toEqual(
      expect.objectContaining({ ok: false, code: "unknown" }),
    );
  });

  test("a principal the caller names is recorded as who redeemed it", async () => {
    const home = await homeFixture();
    const { code } = await inviteIn(home);
    const answer = await redeemInvite(home.root, code, {
      now: home.clock.now,
      principal: home.owner,
    });
    expect(answer.ok).toBe(true);
    expect(home.snapshot().invites[0]).toEqual(
      expect.objectContaining({ principal: home.owner, by: home.owner }),
    );
  });
});
