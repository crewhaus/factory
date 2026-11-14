/** The approver projection: written only where someone else may decide, only when it moves. */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { approverProjection } from "@crewhaus/control-contract/schemas";
import { append, createApproverReader } from "@crewhaus/control-records";
import { authorize } from "./authorize";
import { accessLedger, accessPaths } from "./paths";
import { _setProjectionWriteTapForTest, writeApproverProjections } from "./projection";
import {
  HOUR,
  homeFixture,
  ok,
  projectionPath,
  readProjection,
  removeTempDirs,
  rowCount,
} from "./test-helpers";

afterAll(removeTempDirs);
afterEach(() => _setProjectionWriteTapForTest(undefined));

function countWrites(): string[] {
  const writes: string[] = [];
  _setProjectionWriteTapForTest((harness) => writes.push(harness));
  return writes;
}

describe("where a projection is written", () => {
  test("a non-owner grant on a harness writes its projection, which reads back present", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const grant = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    const read = createApproverReader({ now: home.clock.now })(h.dir);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.projection).toEqual({
      v: 1,
      epoch: home.snapshot().epoch,
      generatedAt: new Date(home.clock.now()).toISOString(),
      harness: h.id,
      owner: home.owner,
      governedSince: new Date(home.clock.now()).toISOString(),
      members: [{ principal: grant.principal, decide: "operator" }],
      links: [],
    });
    expect(approverProjection.safeParse(read.projection).success).toBe(true);
    expect(JSON.stringify(read.projection)).not.toContain("local:");
  });

  test("an owner's Slack link governs every harness, and is projected", async () => {
    const home = await homeFixture({ harnesses: [[], ["g"]] });
    ok(await home.access.link(home.actor, { subject: "slack:T0:U0", member: home.owner }));
    for (const h of home.harnesses) {
      expect(readProjection(h)["links"]).toEqual([
        { external: "slack:T0:U0", principal: home.owner },
      ]);
      expect(readProjection(h)["members"]).toEqual([]);
    }
  });

  test("a single owner, a viewer grant on another harness and a GitHub link write nothing", async () => {
    const home = await homeFixture({ harnesses: [[], []] });
    const [h0, h1] = home.harnesses;
    if (h0 === undefined || h1 === undefined) throw new Error("no harness");
    ok(await home.access.sync(home.actor));
    ok(await home.access.link(home.actor, { subject: "github:12345", member: home.owner }));
    const ana = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "viewer",
        scope: `harness:${h1.id}`,
      }),
    );
    ok(await home.access.link(home.actor, { subject: "github:777", member: ana.principal }));
    expect(existsSync(projectionPath(h0))).toBe(false);
    // The viewer's own harness is governed: only the owner decides there.
    expect(readProjection(h1)["members"]).toEqual([]);
    expect(JSON.stringify(readProjection(h1))).not.toContain("github");
  });

  test("viewers are left out; a service holding the decision permission is an operator, never more", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const scope = `harness:${h.id}`;
    ok(await home.access.grant(home.actor, { member: "Vi", create: true, role: "viewer", scope }));
    const mo = ok(
      await home.access.grant(home.actor, {
        member: "Mo",
        create: true,
        role: "maintainer",
        scope,
      }),
    );
    const ci = ok(
      await home.access.mintServiceToken(home.actor, {
        service: "ci",
        permissions: ["h.decision.resolve", "h.control", "h.deploy"],
        harnesses: [h.id],
      }),
    );
    const members = readProjection(h)["members"] as { principal: string; decide: string }[];
    // A service decides through a credential that expires, so its row says when.
    expect(typeof ci.token.expiresAt).toBe("string");
    expect(members).toEqual(
      [
        { principal: mo.principal, decide: "maintainer" },
        { principal: ci.principal, decide: "operator", until: ci.token.expiresAt as string },
      ].sort((a, b) => (a.principal < b.principal ? -1 : 1)),
    );
  });

  test("a service member's until is its latest live deciding credential's expiry, and moving it rewrites the file", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const scope = `harness:${h.id}`;
    const mo = ok(
      await home.access.grant(home.actor, { member: "Mo", create: true, role: "operator", scope }),
    );
    const first = ok(
      await home.access.mintServiceToken(home.actor, {
        service: "ci",
        permissions: ["h.decision.resolve"],
        harnesses: [h.id],
        ttlMs: HOUR,
      }),
    );
    const memberOf = (principal: string) =>
      (readProjection(h)["members"] as { principal: string; until?: string }[]).find(
        (m) => m.principal === principal,
      );
    expect(memberOf(first.principal)?.until).toBe(first.token.expiresAt as string);
    // A grant member's authority does not end on its own: no until.
    expect(memberOf(mo.principal)).toEqual({ principal: mo.principal, decide: "operator" });
    expect(readProjection(h)["owner"]).toBe(home.owner);

    // A second credential that lasts longer moves the end time, and the file is rewritten.
    const writes = countWrites();
    const second = ok(
      await home.access.mintServiceToken(home.actor, {
        service: "ci",
        permissions: ["h.decision.resolve"],
        harnesses: [h.id],
        ttlMs: 3 * HOUR,
      }),
    );
    expect(second.principal).toBe(first.principal);
    expect(writes).toEqual([h.id]);
    expect(memberOf(first.principal)?.until).toBe(second.token.expiresAt as string);
    expect(Date.parse(second.token.expiresAt as string)).toBeGreaterThan(
      Date.parse(first.token.expiresAt as string),
    );

    // A credential that cannot decide here does not count toward the end time.
    ok(
      await home.access.mintServiceToken(home.actor, {
        service: "ci",
        permissions: ["h.control"],
        harnesses: [h.id],
        ttlMs: 5 * HOUR,
      }),
    );
    expect(memberOf(first.principal)?.until).toBe(second.token.expiresAt as string);
    expect(approverProjection.safeParse(readProjection(h)).success).toBe(true);
  });

  test("a service without the decision permission is not projected", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "viewer",
        scope: `harness:${h.id}`,
      }),
    );
    ok(
      await home.access.mintServiceToken(home.actor, {
        service: "ci",
        permissions: ["h.control"],
        harnesses: [h.id],
      }),
    );
    expect(readProjection(h)["members"]).toEqual([]);
  });
});

describe("how a projection is kept", () => {
  test("governedSince survives deleting the file and a sync", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    const since = readProjection(h)["governedSince"];
    home.clock.advance(5 * HOUR);
    rmSync(projectionPath(h));
    const synced = ok(await home.access.sync(home.actor));
    expect(synced.written).toEqual([h.id]);
    expect(readProjection(h)["governedSince"]).toBe(since);
    expect(rowCount(home.root, accessPaths().ledgers.governed)).toBe(1);
  });

  test("a harness stays governed after its last grant is revoked", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const grant = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    ok(await home.access.revoke(home.actor, grant.grant.id));
    expect(readProjection(h)["members"]).toEqual([]);
    rmSync(projectionPath(h));
    ok(await home.access.sync(home.actor));
    expect(existsSync(projectionPath(h))).toBe(true);
  });

  test("a file ahead of the revision is replaced by the next change, whose revision moves above it", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const ana = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    const planted = { ...readProjection(h), epoch: 999, members: [] };
    writeFileSync(projectionPath(h), JSON.stringify(planted));
    const writes = countWrites();
    const done = await home.access.grant(home.actor, {
      member: "Bo",
      create: true,
      role: "operator",
      scope: `harness:${h.id}`,
    });
    if (!done.ok) throw new Error(done.reason);
    expect(done.epoch).toBe(1000);
    expect(done.projections.failed).toEqual([]);
    expect(writes).toEqual([h.id]);
    expect(home.snapshot().epoch).toBe(1000);
    const after = readProjection(h);
    expect(after["epoch"]).toBe(1000);
    expect((after["members"] as { principal: string }[]).map((m) => m.principal).sort()).toEqual(
      [ana.principal, done.result.principal].sort(),
    );
  });

  test("after revision.json is lost, a revoke still takes the member off the list", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const ana = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    const listed = readProjection(h)["epoch"] as number;
    rmSync(join(home.root, accessPaths().revision));
    expect(home.snapshot().epoch).toBe(0);
    const done = await home.access.revoke(home.actor, ana.grant.id);
    if (!done.ok) throw new Error(done.reason);
    expect(done.projections).toEqual({ written: [h.id], unchanged: [], failed: [] });
    expect(done.epoch).toBe(listed + 1);
    expect(readProjection(h)["members"]).toEqual([]);
    expect(readProjection(h)["epoch"]).toBe(listed + 1);
  });

  test("sync moves the revision above a file ahead of it and replaces it", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    const good = readProjection(h);
    writeFileSync(projectionPath(h), JSON.stringify({ ...good, epoch: 999, members: [] }));
    const synced = await home.access.sync(home.actor);
    if (!synced.ok) throw new Error(synced.reason);
    expect(synced.result.written).toEqual([h.id]);
    expect(synced.epoch).toBe(1000);
    expect(home.snapshot().epoch).toBe(1000);
    expect(readProjection(h)["members"]).toEqual(good["members"]);
    expect(readProjection(h)["epoch"]).toBe(1000);
  });

  test("the writer reports a file still ahead of its epoch as not updated, never as current", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    const snapshot = home.snapshot();
    writeFileSync(
      projectionPath(h),
      JSON.stringify({ ...readProjection(h), epoch: snapshot.epoch + 5, members: [] }),
    );
    const report = writeApproverProjections({
      root: home.root,
      snapshot,
      harnesses: home.harnesses,
      epoch: snapshot.epoch,
      now: home.clock.now(),
      by: home.owner,
    });
    expect(report.written).toEqual([]);
    expect(report.unchanged).toEqual([]);
    expect(report.failed).toEqual([
      { harness: h.id, reason: "its list names a later revision than the access records" },
    ]);
  });

  test("a current file is rewritten neither by sync nor by a change to another harness", async () => {
    const home = await homeFixture({ harnesses: [[], []] });
    const [h0, h1] = home.harnesses;
    if (h0 === undefined || h1 === undefined) throw new Error("no harness");
    ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h0.id}`,
      }),
    );
    const before = readProjection(h0);
    const writes = countWrites();
    home.clock.advance(HOUR);
    ok(await home.access.sync(home.actor));
    ok(
      await home.access.grant(home.actor, {
        member: "Bo",
        create: true,
        role: "operator",
        scope: `harness:${h1.id}`,
      }),
    );
    expect(writes).toEqual([h1.id]);
    expect(readProjection(h0)).toEqual(before);
    expect(readProjection(h0)["epoch"] as number).toBeLessThan(home.snapshot().epoch);
  });

  test("a registry group edit followed by sync rewrites the harness whose coverage moved", async () => {
    const home = await homeFixture({ harnesses: [["team"], []] });
    const [h0, h1] = home.harnesses;
    if (h0 === undefined || h1 === undefined) throw new Error("no harness");
    const ana = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: "group:team",
      }),
    );
    expect(readProjection(h0)["members"]).toEqual([
      { principal: ana.principal, decide: "operator" },
    ]);
    expect(existsSync(projectionPath(h1))).toBe(false);
    // The registry moves h0 out of the group and h1 into it.
    (h0.groups as string[]).splice(0);
    (h1.groups as string[]).push("team");
    const writes = countWrites();
    const synced = ok(await home.access.sync(home.actor));
    expect(new Set(writes)).toEqual(new Set([h0.id, h1.id]));
    expect(synced.written.length).toBe(2);
    expect(readProjection(h0)["members"]).toEqual([]);
    expect(readProjection(h1)["members"]).toEqual([
      { principal: ana.principal, decide: "operator" },
    ]);
  });

  test("a missing or unwritable directory leaves the record and reports the harness", async () => {
    const home = await homeFixture();
    const gone = home.addHarness("gone", [], false);
    const answer = await home.access.grant(home.actor, {
      member: "Ana",
      create: true,
      role: "operator",
      scope: `harness:${gone.id}`,
    });
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.projections.failed).toEqual([
      { harness: gone.id, reason: "the harness directory is missing" },
    ]);
    expect(home.snapshot().grants.some((row) => row.id === answer.result.grant.id)).toBe(true);
    if (process.platform === "win32") return; // Mode bits do not make a directory read-only on Windows.
    const locked = home.addHarness("locked");
    chmodSync(locked.dir, 0o500);
    try {
      const second = await home.access.grant(home.actor, {
        member: "Bo",
        create: true,
        role: "operator",
        scope: `harness:${locked.id}`,
      });
      if (!second.ok) throw new Error(second.reason);
      expect(second.projections.failed.map((failure) => failure.harness)).toContain(locked.id);
      expect(home.snapshot().grants.some((row) => row.id === second.result.grant.id)).toBe(true);
    } finally {
      chmodSync(locked.dir, 0o700);
    }
  });

  test("an unreadable file is rewritten", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    writeFileSync(projectionPath(h), "not json");
    const synced = ok(await home.access.sync(home.actor));
    expect(synced.written).toEqual([h.id]);
    expect(readProjection(h)["v"]).toBe(1);
  });

  test("the file and its directory are owner-only", async () => {
    if (process.platform === "win32") return; // No POSIX mode bits on Windows.
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    expect(statSync(projectionPath(h)).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.dir, ".crewhaus", "run", "control")).mode & 0o777).toBe(0o700);
  });
});

describe("a grant with an end time", () => {
  test("only a viewer grant can be given one; a role that may approve is refused and nothing is written", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const expiresAt = new Date(home.clock.now() + HOUR).toISOString();
    const before = rowCount(home.root, accessPaths().ledgers.grants);
    for (const role of ["operator", "maintainer", "owner"]) {
      const answer = await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role,
        scope: `harness:${h.id}`,
        expiresAt,
      });
      expect(answer).toEqual(expect.objectContaining({ ok: false, code: "invalid" }));
      if (!answer.ok) expect(answer.reason).toContain("Only the viewer role");
    }
    expect(rowCount(home.root, accessPaths().ledgers.grants)).toBe(before);
    expect(existsSync(projectionPath(h))).toBe(false);
    const viewer = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "viewer",
        scope: `harness:${h.id}`,
        expiresAt,
      }),
    );
    expect(viewer.grant.expiresAt).toBe(expiresAt);
  });

  test("an expiring decider's grant is honoured by authorize until it ends, and never copied into the list", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    const ana = ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "viewer",
        scope: `harness:${h.id}`,
      }),
    );
    // A decider's grant with an end time, written straight to the ledger: the verb refuses one.
    const at = new Date(home.clock.now()).toISOString();
    const expiring = {
      id: mintId("grt"),
      principal: ana.principal,
      role: "operator",
      scope: `harness:${h.id}`,
      grantedBy: home.owner,
      expiresAt: new Date(home.clock.now() + HOUR).toISOString(),
      state: "active",
      at,
      by: home.owner,
    };
    expect(append(accessLedger(home.root, "grants"), expiring).ok).toBe(true);
    const target = { scope: "harness" as const, harness: h.id, groups: [] };
    const decides = (): boolean =>
      authorize(home.snapshot(), { principal: ana.principal }, "h.decision.resolve", target, {
        now: home.clock.now(),
      }).allow;
    expect(decides()).toBe(true);
    ok(await home.access.sync(home.actor));
    expect(readProjection(h)["members"]).toEqual([]);
    home.clock.advance(2 * HOUR);
    expect(decides()).toBe(false);
    ok(await home.access.sync(home.actor));
    expect(readProjection(h)["members"]).toEqual([]);
  });
});

describe("the Home address on the projection", () => {
  const setBaseUrl = (root: string, baseUrl: unknown): void => {
    writeFileSync(join(root, "settings.json"), `${JSON.stringify({ links: { baseUrl } })}\n`);
  };

  test("the owner's links.baseUrl is carried as homeUrl, and a changed one rewrites the file", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    setBaseUrl(home.root, "https://home.example.test/ignored/path");
    ok(await home.access.link(home.actor, { subject: "slack:T0:U0", member: home.owner }));
    expect(readProjection(h)["homeUrl"]).toBe("https://home.example.test");
    const read = createApproverReader({ now: home.clock.now })(h.dir);
    expect(read.state === "present" && approverProjection.safeParse(read.projection).success).toBe(
      true,
    );
    // Nothing else moved: a sync leaves the file as it is.
    const writes = countWrites();
    home.clock.advance(HOUR);
    ok(await home.access.sync(home.actor));
    expect(writes).toEqual([]);
    // The address moved: the next sync rewrites it.
    setBaseUrl(home.root, "https://other.example.test");
    home.clock.advance(HOUR);
    ok(await home.access.sync(home.actor));
    expect(writes).toEqual([h.id]);
    expect(readProjection(h)["homeUrl"]).toBe("https://other.example.test");
  });

  test("with no links.baseUrl, or one that cannot be used, there is no homeUrl key", async () => {
    const home = await homeFixture({ harnesses: [[]] });
    const [h] = home.harnesses;
    if (h === undefined) throw new Error("no harness");
    ok(await home.access.link(home.actor, { subject: "slack:T0:U0", member: home.owner }));
    expect("homeUrl" in readProjection(h)).toBe(false);
    setBaseUrl(home.root, "http://home.example.test");
    home.clock.advance(HOUR);
    ok(await home.access.sync(home.actor));
    expect("homeUrl" in readProjection(h)).toBe(false);
    // Owner settings that cannot be read never fail the projection write.
    writeFileSync(join(home.root, "settings.json"), "{ not json");
    home.clock.advance(HOUR);
    ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "operator",
        scope: `harness:${h.id}`,
      }),
    );
    expect("homeUrl" in readProjection(h)).toBe(false);
    expect(readProjection(h)["members"]).toHaveLength(1);
  });
});
