/** A personal token's one access change: revoking itself, and nothing that is not its own. */
import { afterAll, describe, expect, test } from "bun:test";
import { openDeviceRequests } from "./device-requests";
import { revokeOwnToken } from "./personal";
import { homeFixture, ok, removeTempDirs } from "./test-helpers";

afterAll(removeTempDirs);

async function setup() {
  const home = await homeFixture();
  const member = ok(
    await home.access.grant(home.actor, {
      member: "Sam",
      create: true,
      role: "viewer",
      scope: "home",
    }),
  ).principal;
  const devices = openDeviceRequests(home.root, { now: home.clock.now });
  const start = await devices.start({});
  if (!start.ok) throw new Error(start.reason);
  await devices.decide({ caller: member, code: start.userCode, choice: "allow" });
  const polled = await devices.poll(start.pollRef);
  if (!polled.ok || polled.state !== "allowed") throw new Error("no token");
  const ctx = { root: home.root, now: home.clock.now, harnesses: () => [], domains: new Map() };
  return { home, member, credential: polled.token.id, ctx };
}

describe("revokeOwnToken", () => {
  test("a member revokes its own personal token, though it cannot manage access", async () => {
    const s = await setup();
    const done = await revokeOwnToken(s.ctx, s.member, s.credential);
    expect(done.ok && done.result.token.state).toBe("revoked");
    expect(s.home.snapshot().tokens.find((t) => t.id === s.credential)?.state).toBe("revoked");
    const again = await revokeOwnToken(s.ctx, s.member, s.credential);
    expect(again.ok === false && again.code).toBe("ended");
  });

  test("another's token, or a service token, is refused", async () => {
    const s = await setup();
    const other = ok(
      await s.home.access.grant(s.home.actor, {
        member: "Ana",
        create: true,
        role: "viewer",
        scope: "home",
      }),
    ).principal;
    const notMine = await revokeOwnToken(s.ctx, other, s.credential);
    expect(notMine.ok === false && notMine.code).toBe("not-found");
    const svc = ok(
      await s.home.access.mintServiceToken(s.home.actor, {
        service: "bot",
        permissions: [],
        harnesses: [],
      }),
    );
    const service = await revokeOwnToken(s.ctx, svc.principal, svc.token.id);
    expect(service.ok === false && service.code).toBe("not-authorized");
  });
});
