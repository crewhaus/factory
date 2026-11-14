/**
 * Approver lists follow coverage within a tick: a registry group move with no access
 * write, and a deciding credential's end, both reach a harness's `approvers.json` on
 * Home's next reconcile tick, and an idle tick writes nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type Dirent, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { signInFromBootLink } from "./__test__/browser";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

const T0 = Date.parse("2026-11-13T00:00:00.000Z");
const TICK = 10_000;

function treeBytes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(path, readFileSync(path, "latin1"));
    }
  };
  walk(dir);
  return out;
}

const approvers = (
  dir: string,
): { members: Array<{ principal: string; until?: string }> } | undefined => {
  const path = join(dir, ".crewhaus", "run", "control", "approvers.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
};

async function fleet() {
  let clock = T0;
  const t = bootTestServer({ now: () => clock });
  servers.push(t);
  await t.server.ready;
  await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
  const add = async (name: string): Promise<{ id: string; dir: string }> => {
    const dir = makeFixtureHarness(join(t.harnessesRoot, name), { specName: name });
    const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
    return { id: (res.body["entry"] as { id: string }).id, dir };
  };
  const governed = await add("governed");
  const fresh = await add("fresh");
  const registry = openHangarRegistry({
    root: t.registryRoot,
    env: { CREWHAUS_WATCHME_ROOT: join(t.workspace, "watchme") },
    now: () => clock,
    onWarn: () => undefined,
  });
  const read = loadAccessSnapshot(t.hangarRoot);
  if (read.state !== "present") throw new Error("no access records");
  const owner = { principal: read.snapshot.owner as string };
  const access = openAccess(t.hangarRoot, {
    now: () => clock,
    harnesses: () => registry.list().map((e) => ({ id: e.id, dir: e.dir, groups: e.groups })),
  });
  const tick = async () => {
    clock += TICK;
    return await t.server.scheduler.tick();
  };
  return {
    t,
    governed,
    fresh,
    registry,
    access,
    owner,
    tick,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("approver lists follow coverage", () => {
  test("a group move through the registry alone puts a member on the list, and moving out takes them off", async () => {
    const f = await fleet();
    // The harness is governed by a grant of its own; Ana operates the `ops` group.
    const bo = await f.access.grant(f.owner, {
      member: "Bo",
      create: true,
      role: "operator",
      scope: `harness:${f.governed.id}`,
    });
    const ana = await f.access.grant(f.owner, {
      member: "Ana",
      create: true,
      role: "operator",
      scope: "group:ops",
    });
    if (!bo.ok || !ana.ok) throw new Error("grant refused");
    const members = () => (approvers(f.governed.dir)?.members ?? []).map((m) => m.principal);
    expect(members()).toEqual([bo.result.principal]);
    f.registry.setGroups(f.governed.id, ["ops"]);
    await f.tick();
    expect(members().sort()).toEqual([ana.result.principal, bo.result.principal].sort());
    f.registry.setGroups(f.governed.id, []);
    await f.tick();
    expect(members()).toEqual([bo.result.principal]);
  });

  test("a harness first covered by a group move is governed by the reconcile tick", async () => {
    const f = await fleet();
    const ana = await f.access.grant(f.owner, {
      member: "Ana",
      create: true,
      role: "operator",
      scope: "group:ops",
    });
    if (!ana.ok) throw new Error("grant refused");
    expect(approvers(f.fresh.dir)).toBeUndefined();
    f.registry.setGroups(f.fresh.id, ["ops"]);
    await f.tick();
    expect(approvers(f.fresh.dir)?.members.map((m) => m.principal)).toEqual([ana.result.principal]);
    const rows = readFileSync(join(f.t.hangarRoot, "access", "governed.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.find((row) => row["id"] === f.fresh.id)?.["by"]).toBe("sys:reconcile");
  });

  test("a service whose only deciding token ends at T is listed until T, and gone after the first tick past it", async () => {
    const f = await fleet();
    // Governed by a member's grant; the service decides there through its token alone.
    const bo = await f.access.grant(f.owner, {
      member: "Bo",
      create: true,
      role: "operator",
      scope: `harness:${f.governed.id}`,
    });
    if (!bo.ok) throw new Error(bo.reason);
    const ttlMs = 60 * 60 * 1000;
    const minted = await f.access.mintServiceToken(f.owner, {
      service: "ci",
      permissions: ["h.decision.resolve"],
      harnesses: [f.governed.id],
      ttlMs,
    });
    if (!minted.ok) throw new Error(minted.reason);
    const until = minted.result.token.expiresAt as string;
    const service = () =>
      approvers(f.governed.dir)?.members.find((m) => m.principal === minted.result.principal);
    expect(service()).toEqual({
      principal: minted.result.principal,
      decide: "operator",
      until,
    } as never);
    // Before T a tick leaves it; the first tick past T rewrites the file without it.
    await f.tick();
    expect(service()?.until).toBe(until);
    f.advance(Date.parse(until) - f.now());
    await f.tick();
    expect(service()).toBeUndefined();
    expect(approvers(f.governed.dir)?.members.map((m) => m.principal)).toEqual([
      bo.result.principal,
    ]);
  });

  test("an idle tick leaves the access records and every list byte-identical", async () => {
    const f = await fleet();
    const bo = await f.access.grant(f.owner, {
      member: "Bo",
      create: true,
      role: "operator",
      scope: `harness:${f.governed.id}`,
    });
    if (!bo.ok) throw new Error("grant refused");
    await f.tick();
    const before = {
      access: treeBytes(join(f.t.hangarRoot, "access")),
      list: readFileSync(
        join(f.governed.dir, ".crewhaus", "run", "control", "approvers.json"),
        "utf8",
      ),
    };
    await f.tick();
    expect(treeBytes(join(f.t.hangarRoot, "access"))).toEqual(before.access);
    expect(
      readFileSync(join(f.governed.dir, ".crewhaus", "run", "control", "approvers.json"), "utf8"),
    ).toBe(before.list);
  });
});
