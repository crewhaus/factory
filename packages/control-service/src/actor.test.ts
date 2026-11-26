/**
 * The stored actor a receipt names: a linked principal only when the access records it is
 * read from are under the Hangar root the harness's approver projection names, and the
 * keyed local digest otherwise.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureAccessSetUp, localActorOf } from "@crewhaus/access-control";
import { controlPaths, ensureDigestKey } from "@crewhaus/control-records";
import { readStoredActor, storedActorFor } from "./actor";
import { type DecisionActor, createDecisions } from "./decisions";
import {
  linkLocalMember,
  plantProjection,
  removeTempDirs,
  setUpOwner,
  tempDir,
} from "./test-helpers";

afterAll(removeTempDirs);

const OWNER_USER = { username: "olive", hostname: "laptop" } as const;
const STRANGER = { username: "mallory", hostname: "elsewhere" } as const;
const DIGEST = /^local:#[0-9a-f]{64}$/;

/**
 * Home A, whose owner is OWNER_USER; Home B, another root, whose records link STRANGER
 * to A's owner principal; and harness h with its digest key.
 */
async function homes() {
  const a = tempDir("actor-home-a-");
  const owner = await setUpOwner(a, OWNER_USER);
  const b = tempDir("actor-home-b-");
  const done = await ensureAccessSetUp(b, {
    localActor: localActorOf({ username: "bob", hostname: "b" }),
  });
  if (!done.ok) throw new Error(done.reason);
  linkLocalMember(b, STRANGER, done.result.owner, owner);
  const h = tempDir("actor-harness-");
  const key = await ensureDigestKey(h);
  if (key.state !== "present") throw new Error(key.state);
  return { a, b, h, owner, key: key.hmac };
}

describe("storedActorFor", () => {
  test("on a harness whose projection names Home A, B's link names nobody and A's owner is named", async () => {
    const { a, b, h, owner, key } = await homes();
    plantProjection(h, owner, [], { accessRoot: realpathSync(a) });
    expect(await storedActorFor(b, h, STRANGER, key)).toMatch(DIGEST);
    expect(await storedActorFor(a, h, OWNER_USER, key)).toBe(owner);
  });

  test("a Home root given through a link counts as the root it lands on", async () => {
    const { a, h, owner, key } = await homes();
    plantProjection(h, owner, [], { accessRoot: realpathSync(a) });
    const via = join(tempDir("actor-link-"), "home");
    symlinkSync(a, via);
    expect(await storedActorFor(via, h, OWNER_USER, key)).toBe(owner);
  });

  test("a projection that names no root, or cannot be read, gives the digest", async () => {
    const { a, h, owner, key } = await homes();
    plantProjection(h, owner, [], { accessRoot: null });
    expect(await storedActorFor(a, h, OWNER_USER, key)).toMatch(DIGEST);
    const control = join(h, ".crewhaus", "run", "control");
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, "approvers.json"), "{");
    expect(await storedActorFor(a, h, OWNER_USER, key)).toMatch(DIGEST);
  });

  test("with no projection, or no harness, the link the records hold names its principal", async () => {
    const { b, h, owner, key } = await homes();
    expect(await storedActorFor(b, h, STRANGER, key)).toBe(owner);
    expect(await storedActorFor(b, undefined, STRANGER, key)).toBe(owner);
  });

  test("a Home root that does not exist gives the digest", async () => {
    const { h, key } = await homes();
    expect(await storedActorFor(join(h, "no-such-home"), h, OWNER_USER, key)).toMatch(DIGEST);
  });

  test("the digest is the same one key gives the same user, whichever root refused the link", async () => {
    const { a, b, h, owner, key } = await homes();
    plantProjection(h, owner, [], { accessRoot: realpathSync(a) });
    const first = await storedActorFor(b, h, STRANGER, key);
    const second = await storedActorFor(join(h, "no-such-home"), h, STRANGER, key);
    expect(first).toBe(second);
  });
});

describe("the stored actor, as a reader finds it", () => {
  test("is the one a writer stores: the linked member, else the digest under the harness's own key", async () => {
    const { a, b, h, owner, key } = await homes();
    plantProjection(h, owner, [], { accessRoot: realpathSync(a) });
    for (const [root, who] of [
      [a, OWNER_USER],
      [a, STRANGER],
      [b, STRANGER],
      [join(h, "no-such-home"), OWNER_USER],
    ] as const) {
      expect(await readStoredActor(root, h, who)).toBe(await storedActorFor(root, h, who, key));
    }
    expect(await readStoredActor(a, h, OWNER_USER)).toBe(owner);
    expect(await readStoredActor(a, h, STRANGER)).toMatch(DIGEST);
  });

  test("with no key yet a linked member is still named, anyone else is not, and no key is made", async () => {
    const { a, h, owner } = await homes();
    const keyFile = join(h, controlPaths(h).digestKeyFile);
    unlinkSync(keyFile);
    expect(await readStoredActor(a, h, OWNER_USER)).toBe(owner);
    expect(await readStoredActor(a, h, STRANGER)).toBeUndefined();
    expect(existsSync(keyFile)).toBe(false);
  });

  test("the decision service reads the actor it stores, and makes no key to do it", async () => {
    const { a, h, owner } = await homes();
    const decisions = createDecisions({ hangarRoot: a, identity: STRANGER, now: () => 0 });
    const member: DecisionActor = { kind: "principal", principal: owner };
    // What Home calls its one user before anyone signed in names no member.
    const label: DecisionActor = { kind: "principal", principal: "operator" };
    const local: DecisionActor = { kind: "local", identity: STRANGER };
    for (const actor of [member, label, local]) {
      const read = await decisions.readActorOf(h, actor);
      expect(read).toBe(await decisions.storedActorOf(h, actor));
    }
    expect(await decisions.readActorOf(h, member)).toBe(owner);
    expect(await decisions.readActorOf(h, label)).toMatch(DIGEST);
    const keyFile = join(h, controlPaths(h).digestKeyFile);
    unlinkSync(keyFile);
    expect(await decisions.readActorOf(h, label)).toBeUndefined();
    expect(existsSync(keyFile)).toBe(false);
  });

  test("under another Home's list of members, a member of this one is nobody there", async () => {
    const { a, b, h, owner } = await homes();
    plantProjection(h, owner, [], { accessRoot: realpathSync(b) });
    const decisions = createDecisions({ hangarRoot: a, identity: STRANGER, now: () => 0 });
    const member: DecisionActor = { kind: "principal", principal: owner };
    expect(await decisions.readActorOf(h, member)).toMatch(DIGEST);
    expect(await decisions.readActorOf(h, member)).toBe(await decisions.storedActorOf(h, member));
  });
});
