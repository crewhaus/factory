/** What can never be revoked here, concurrent changes, and the row-size bound. */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_KINDS, accessPaths } from "./paths";
import { HOUR, homeFixture, ok, readProjection, removeTempDirs, rowCount } from "./test-helpers";

afterAll(removeTempDirs);

function counts(root: string): Record<string, number> {
  return Object.fromEntries(
    LEDGER_KINDS.map((kind) => [kind, rowCount(root, accessPaths().ledgers[kind])]),
  );
}

function subjectsText(root: string): string {
  return readFileSync(join(root, accessPaths().subjects), "utf8");
}

describe("lockout", () => {
  test("the last home owner grant cannot be revoked", async () => {
    const home = await homeFixture();
    const own = home.snapshot().grants[0];
    const before = counts(home.root);
    const answer = await home.access.revoke(home.actor, own?.id as string);
    expect(answer).toEqual(expect.objectContaining({ ok: false, code: "lockout" }));
    if (!answer.ok) expect(answer.reason).toContain("last owner");
    expect(counts(home.root)).toEqual(before);
  });

  test("with a second owner, the home owner's grant still stays, and the other owner's can go", async () => {
    const home = await homeFixture();
    const bo = ok(
      await home.access.grant(home.actor, {
        member: "Bo",
        create: true,
        role: "owner",
        scope: "home",
      }),
    );
    const own = home.snapshot().grants.find((row) => row.principal === home.owner);
    const before = counts(home.root);
    const refused = await home.access.revoke(home.actor, own?.id as string);
    expect(refused).toEqual(expect.objectContaining({ ok: false, code: "home-owner" }));
    expect(counts(home.root)).toEqual(before);
    ok(await home.access.revoke(home.actor, bo.grant.id));
  });

  test("only the grant that makes the home owner is kept: any other grant they gave themselves can go", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const ownerGrant = home.snapshot().ownerGrant;
    expect(ownerGrant).toMatch(/^grt_/);
    const viewer = ok(
      await home.access.grant(home.actor, {
        member: home.owner,
        role: "viewer",
        scope: `harness:${h.id}`,
      }),
    );
    const timed = ok(
      await home.access.grant(home.actor, {
        member: home.owner,
        role: "viewer",
        scope: "home",
        expiresAt: new Date(home.clock.now() + HOUR).toISOString(),
      }),
    );
    const second = ok(
      await home.access.grant(home.actor, { member: home.owner, role: "owner", scope: "home" }),
    );
    for (const id of [viewer.grant.id, timed.grant.id, second.grant.id]) {
      const revoked = ok(await home.access.revoke(home.actor, id));
      expect(revoked.kind === "grant" && revoked.grant.state).toBe("revoked");
    }
    expect(home.snapshot().ownerGrant).toBe(ownerGrant);
    const refused = await home.access.revoke(home.actor, ownerGrant as string);
    expect(refused).toEqual(expect.objectContaining({ ok: false }));
    if (!refused.ok) expect(["lockout", "home-owner"]).toContain(refused.code);
  });

  test("the home owner cannot be removed, and the reason says why", async () => {
    const home = await homeFixture();
    const before = counts(home.root);
    for (const ref of [home.owner, "max"]) {
      const answer = await home.access.removeMember(home.actor, ref);
      expect(answer).toEqual(expect.objectContaining({ ok: false, code: "home-owner" }));
      if (!answer.ok) expect(answer.reason).toContain("Home's owner");
    }
    expect(counts(home.root)).toEqual(before);
  });

  test("the bootstrap credential cannot be revoked", async () => {
    const home = await homeFixture();
    const bootstrap = home.snapshot().tokens.find((row) => row.kind === "bootstrap");
    const before = counts(home.root);
    const answer = await home.access.revoke(home.actor, bootstrap?.id as string);
    expect(answer).toEqual({
      ok: false,
      code: "home-owner",
      reason: "Home's own sign-in token cannot be revoked here.",
    });
    expect(counts(home.root)).toEqual(before);
  });

  test("a member without home.access.manage changes nothing", async () => {
    const home = await homeFixture();
    const ana = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "maintainer",
        scope: "home",
      }),
    );
    const before = counts(home.root);
    for (const attempt of [
      home.access.grant(
        { principal: ana.principal },
        { member: "Bo", create: true, role: "viewer", scope: "home" },
      ),
      home.access.removeMember({ principal: ana.principal }, home.owner),
      home.access.revoke({ principal: ana.principal }, ana.grant.id),
      home.access.sync({ principal: ana.principal }),
      home.access.grant(
        { principal: "sys:executor" },
        { member: "Bo", create: true, role: "viewer", scope: "home" },
      ),
    ]) {
      expect(await attempt).toEqual(expect.objectContaining({ ok: false, code: "not-authorized" }));
    }
    expect(counts(home.root)).toEqual(before);
  });
});

describe("concurrency", () => {
  test("two concurrent grants both land, the epoch rises by two, and the projection carries the last", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const epoch = home.snapshot().epoch;
    const [a, b] = await Promise.all([
      home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
      home.access.grant(home.actor, {
        member: "Bo",
        create: true,
        role: "maintainer",
        scope: `harness:${h.id}`,
      }),
    ]);
    if (!a?.ok || !b?.ok) throw new Error("a grant failed");
    const snapshot = home.snapshot();
    expect(snapshot.epoch).toBe(epoch + 2);
    expect(snapshot.grants.filter((row) => row.scope === `harness:${h.id}`)).toHaveLength(2);
    const projection = readProjection(h);
    expect(projection["epoch"]).toBe(epoch + 2);
    expect((projection["members"] as unknown[]).length).toBe(2);
  });
});

describe("the row-size bound", () => {
  test("a change whose row would reach 4096 bytes appends to no ledger and leaves the names", async () => {
    const home = await homeFixture();
    const harnesses = Array.from(
      { length: 200 },
      (_, i) => `hrn_${i.toString(16).padStart(16, "0")}`,
    );
    const before = counts(home.root);
    const names = subjectsText(home.root);
    const epoch = home.snapshot().epoch;
    const answer = await home.access.mintServiceToken(home.actor, {
      service: "big",
      permissions: ["h.control"],
      harnesses,
    });
    expect(answer).toEqual(expect.objectContaining({ ok: false, code: "too-large" }));
    if (!answer.ok) expect(answer.reason).toContain("4096");
    expect(counts(home.root)).toEqual(before);
    expect(subjectsText(home.root)).toBe(names);
    expect(home.snapshot().epoch).toBe(epoch);
    // The same token over few harnesses is fine.
    ok(
      await home.access.mintServiceToken(home.actor, {
        service: "big",
        permissions: ["h.control"],
        harnesses: harnesses.slice(0, 3),
      }),
    );
  });
});
